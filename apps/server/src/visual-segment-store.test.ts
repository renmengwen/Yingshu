import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { appendAssetCandidateReview } from "./asset-candidate-store.js";
import { openDatabase, type YingshuDatabase } from "./database.js";
import {
  assertVisualPlanReady,
  listVisualSegments,
  putVisualSegment,
  type PutVisualSegmentInput,
} from "./visual-segment-store.js";

const TIMELINE = "a".repeat(64);

function seed(store: YingshuDatabase) {
  const db = store.database;
  db.prepare(
    `INSERT INTO books (id, title, original_file_path, original_file_hash, encoding, import_status)
     VALUES ('book', '书', 'books/book/source.txt', ?, 'UTF-8', 'ready')`,
  ).run("1".repeat(64));
  db.prepare(
    `INSERT INTO series_projects (id, book_id, title, created_at, updated_at)
     VALUES ('series', 'book', '系列', 1, 1), ('other_series', 'book', '其他系列', 1, 1)`,
  ).run();
  db.prepare(
    `INSERT INTO episodes (
       id, series_project_id, episode_index, title, story_arc, target_duration_seconds, created_at, updated_at
     ) VALUES ('episode', 'series', 1, '第一集', '故事弧', 180, 1, 1)`,
  ).run();
  db.prepare(
    `INSERT INTO script_versions (id, episode_id, kind, version, content_json, content_hash, created_at)
     VALUES ('script', 'episode', 'packaged', 1, '{}', ?, 1),
            ('other_script', 'episode', 'packaged', 2, '{}', ?, 2)`,
  ).run("2".repeat(64), "3".repeat(64));
  db.prepare(
    `INSERT INTO script_approval_events (id, episode_id, revision, action, script_version_id, created_at)
     VALUES ('approval', 'episode', 1, 'approve', 'script', 1)`,
  ).run();
  const insertAudio = db.prepare(
    `INSERT INTO audio_segments (
       timeline_hash, segment_index, episode_id, script_version_id, text, provider_id, voice, rate,
       input_hash, relative_path, file_hash, bytes, duration_ms, created_at
     ) VALUES (?, ?, 'episode', 'script', ?, 'test', 'voice', 0, ?, ?, ?, 100, 1000, 1)`,
  );
  const insertCue = db.prepare(
    `INSERT INTO subtitle_cues (
       timeline_hash, cue_index, segment_index, episode_id, script_version_id, start_ms, end_ms, text
     ) VALUES (?, ?, ?, 'episode', 'script', ?, ?, ?)`,
  );
  for (let index = 0; index < 4; index += 1) {
    insertAudio.run(TIMELINE, index, `旁白${index}`, String(index + 4).repeat(64), `audio/${index}.wav`, "8".repeat(64));
    insertCue.run(TIMELINE, index, index, index * 1000, (index + 1) * 1000, `旁白${index}`);
  }
  const insertAsset = db.prepare(
    `INSERT INTO assets (
       id, series_project_id, asset_type, asset_role, canonical_name, normalized_name, created_at
     ) VALUES (?, ?, 'scene', 'master', ?, ?, 1)`,
  );
  insertAsset.run("asset_a", "series", "场景甲", "场景甲");
  insertAsset.run("asset_b", "series", "场景乙", "场景乙");
  insertAsset.run("asset_other", "other_series", "其他", "其他");
  const insertCandidate = db.prepare(
    `INSERT INTO asset_candidates (
       id, asset_id, source_kind, source_identity_hash, source_json, file_hash,
       mime, width, height, bytes, relative_path, created_at
     ) VALUES (?, ?, 'upload', ?, '{"kind":"upload","originalName":"a.png"}', ?,
       'image/png', 32, 32, 100, ?, 1)`,
  );
  insertCandidate.run("candidate_a", "asset_a", "5".repeat(64), "6".repeat(64), "assets/a.png");
  insertCandidate.run("candidate_b", "asset_b", "7".repeat(64), "8".repeat(64), "assets/b.png");
  appendAssetCandidateReview(db, "candidate_a", { expectedRevision: 0, action: "approve", now: 1 });
}

function input(overrides: Partial<PutVisualSegmentInput> = {}): PutVisualSegmentInput {
  return {
    timelineHash: TIMELINE,
    cueStartIndex: 0,
    cueEndIndex: 1,
    motionKind: "zoom-in",
    motionAmountPpm: 50_000,
    fadeMs: 100,
    expectedRevision: 0,
    assets: [
      { assetId: "asset_a", selectedCandidateId: "candidate_a" },
      { assetId: "asset_b" },
    ],
    ...overrides,
  };
}

async function fixture(run: (store: YingshuDatabase, dataRoot: string) => void | Promise<void>) {
  const dataRoot = await mkdtemp(join(tmpdir(), "narralume-visual-segments-"));
  try {
    const store = openDatabase(dataRoot);
    seed(store);
    try { await run(store, dataRoot); } finally {
      try { store.close(); } catch { /* 测试可显式关闭后验证重启。 */ }
    }
  } finally {
    await rm(dataRoot, { recursive: true, force: true });
  }
}

async function openingFixture(run: (store: YingshuDatabase) => void | Promise<void>) {
  await fixture(async (store) => {
    const db = store.database;
    db.prepare("UPDATE audio_segments SET duration_ms = 3000 WHERE timeline_hash = ?").run(TIMELINE);
    db.prepare("UPDATE subtitle_cues SET start_ms = cue_index * 3000, end_ms = (cue_index + 1) * 3000 WHERE timeline_hash = ?")
      .run(TIMELINE);
    db.prepare(
      `INSERT INTO audio_segments (
         timeline_hash, segment_index, episode_id, script_version_id, text, provider_id, voice, rate,
         input_hash, relative_path, file_hash, bytes, duration_ms, created_at
       ) VALUES (?, 4, 'episode', 'script', '旁白4', 'test', 'voice', 0, ?, 'audio/4.wav', ?, 100, 3000, 1)`,
    ).run(TIMELINE, "9".repeat(64), "a".repeat(64));
    db.prepare(
      `INSERT INTO subtitle_cues (
         timeline_hash, cue_index, segment_index, episode_id, script_version_id, start_ms, end_ms, text
       ) VALUES (?, 4, 4, 'episode', 'script', 12000, 15000, '旁白4')`,
    ).run(TIMELINE);
    appendAssetCandidateReview(db, "candidate_b", { expectedRevision: 0, action: "approve", now: 2 });
    for (const suffix of ["c", "d", "e"]) {
      db.prepare(
        `INSERT INTO assets (
           id, series_project_id, asset_type, asset_role, canonical_name, normalized_name, created_at
         ) VALUES (?, 'series', 'scene', 'master', ?, ?, 1)`,
      ).run(`asset_${suffix}`, `场景${suffix}`, `场景${suffix}`);
      db.prepare(
        `INSERT INTO asset_candidates (
           id, asset_id, source_kind, source_identity_hash, source_json, file_hash,
           mime, width, height, bytes, relative_path, created_at
         ) VALUES (?, ?, 'upload', ?, '{"kind":"upload","originalName":"a.png"}', ?,
           'image/png', 32, 32, 100, ?, 1)`,
      ).run(`candidate_${suffix}`, `asset_${suffix}`, suffix.repeat(64), suffix.repeat(64), `assets/${suffix}.png`);
      appendAssetCandidateReview(db, `candidate_${suffix}`, { expectedRevision: 0, action: "approve", now: 2 });
    }
    await run(store);
  });
}

function putOpeningPlan(store: YingshuDatabase, candidateSuffixes: string[]) {
  candidateSuffixes.forEach((suffix, index) => putVisualSegment(store.database, "episode", index, input({
    cueStartIndex: index,
    cueEndIndex: index === candidateSuffixes.length - 1 ? 4 : index,
    assets: [{ assetId: `asset_${suffix}`, selectedCandidateId: `candidate_${suffix}` }],
  })));
}

test("视觉段从字幕闭区间派生时间并幂等完全替换资产关系", () => fixture((store) => {
  const first = putVisualSegment(store.database, "episode", 0, input(), 10);
  assert.equal(first.startMs, 0);
  assert.equal(first.endMs, 2000);
  assert.equal(first.revision, 1);
  assert.equal(first.productionReady, true);
  assert.equal(first.assets.length, 2);
  assert.equal(first.assets[0]!.candidateReviewRevision, 1);

  const repeated = putVisualSegment(store.database, "episode", 0, input(), 20);
  assert.equal(repeated.id, first.id);
  assert.equal(repeated.revision, 1);

  const changed = putVisualSegment(store.database, "episode", 0, input({
    expectedRevision: 1,
    assets: [{ assetId: "asset_a", selectedCandidateId: "candidate_a" }],
  }), 30);
  assert.equal(changed.revision, 2);
  assert.deepEqual(changed.assets.map((asset) => asset.assetId), ["asset_a"]);
  assert.throws(() => putVisualSegment(store.database, "episode", 0, input({ expectedRevision: 1 })), /revision=2/);
}));

test("视觉段允许字幕时间轴首条保留短静音偏移", () => fixture((store) => {
  store.database.prepare(
    "UPDATE subtitle_cues SET start_ms = start_ms + 95, end_ms = end_ms + 95 WHERE timeline_hash = ?",
  ).run(TIMELINE);
  const segment = putVisualSegment(store.database, "episode", 0, input({ cueEndIndex: 3 }), 10);
  assert.equal(segment.startMs, 95);
  assert.equal(segment.endMs, 4095);
  assert.equal(segment.productionReady, true);
  assert.equal(assertVisualPlanReady(store.database, "episode", TIMELINE).length, 1);
}));

test("视觉段允许字幕 cue 间隙但拒绝重叠倒退", () => fixture((store) => {
  store.database.prepare(
    "UPDATE subtitle_cues SET start_ms = start_ms + cue_index * 800, end_ms = end_ms + cue_index * 800 WHERE timeline_hash = ?",
  ).run(TIMELINE);
  const segment = putVisualSegment(store.database, "episode", 0, input({ cueEndIndex: 3 }), 10);
  assert.equal(segment.startMs, 0);
  assert.equal(segment.endMs, 6400);
  assert.equal(segment.productionReady, true);
  assert.equal(assertVisualPlanReady(store.database, "episode", TIMELINE).length, 1);

  store.database.prepare("UPDATE subtitle_cues SET start_ms = 900 WHERE timeline_hash = ? AND cue_index = 1").run(TIMELINE);
  assert.throws(() => putVisualSegment(store.database, "episode", 1, input({
    cueStartIndex: 2,
    cueEndIndex: 3,
  })), /音频时间轴不连续/);
}));

test("视觉段拒绝跨系列、候选错配以及 pending 或 rejected 候选", () => fixture((store) => {
  assert.throws(() => putVisualSegment(store.database, "episode", 0, input({
    assets: [{ assetId: "asset_other", selectedCandidateId: "candidate_a" }],
  })), /同一系列/);
  assert.throws(() => putVisualSegment(store.database, "episode", 0, input({
    assets: [{ assetId: "asset_b", selectedCandidateId: "candidate_a" }],
  })), /不属于关联资产/);
  assert.throws(() => putVisualSegment(store.database, "episode", 0, input({
    assets: [{ assetId: "asset_b", selectedCandidateId: "candidate_b" }],
  })), /当前已批准/);
  appendAssetCandidateReview(store.database, "candidate_b", { expectedRevision: 0, action: "reject", now: 2 });
  assert.throws(() => putVisualSegment(store.database, "episode", 0, input({
    assets: [{ assetId: "asset_b", selectedCandidateId: "candidate_b" }],
  })), /当前已批准/);
}));

test("数据库触发器拒绝直接 INSERT 或 UPDATE 跨系列视觉资产关系", () => fixture((store) => {
  const segment = putVisualSegment(store.database, "episode", 0, input());
  assert.throws(
    () => store.database.prepare(
      `INSERT INTO visual_segment_assets (
         visual_segment_id, asset_index, asset_id, selected_candidate_id, candidate_review_revision
       ) VALUES (?, 2, 'asset_other', NULL, NULL)`,
    ).run(segment.id),
    /visual segment asset must belong to episode series/,
  );
  assert.throws(
    () => store.database.prepare(
      `UPDATE visual_segment_assets SET asset_id = 'asset_other'
       WHERE visual_segment_id = ? AND asset_id = 'asset_b'`,
    ).run(segment.id),
    /visual segment asset must belong to episode series/,
  );
  assert.equal(listVisualSegments(store.database, "episode", TIMELINE)[0]!.productionReady, true);
}));

test("读取与完整门禁不会信任旧库中的跨系列损坏关系", () => fixture((store) => {
  putVisualSegment(store.database, "episode", 0, input({ cueEndIndex: 3 }));
  store.database.exec("BEGIN IMMEDIATE");
  try {
    store.database.exec(
      `DROP TRIGGER visual_segment_assets_same_series;
       DROP TRIGGER visual_segment_assets_same_series_on_update;`,
    );
    store.database.prepare(
      `UPDATE visual_segment_assets SET asset_id = 'asset_other'
       WHERE asset_id = 'asset_b'`,
    ).run();
    assert.equal(listVisualSegments(store.database, "episode", TIMELINE)[0]!.productionReady, false);
    assert.throws(() => assertVisualPlanReady(store.database, "episode", TIMELINE), /已失效/);
  } finally {
    store.database.exec("ROLLBACK");
  }
  assert.equal(assertVisualPlanReady(store.database, "episode", TIMELINE)[0]!.productionReady, true);
}));

test("视觉段拒绝坏 cue、坏时间轴、旧稿时间轴和区间重叠", () => fixture((store) => {
  assert.throws(() => putVisualSegment(store.database, "episode", 0, input({ cueEndIndex: 9 })), /超出时间轴/);
  assert.throws(() => putVisualSegment(store.database, "episode", 0, input({ timelineHash: "bad" })), /哈希无效/);
  putVisualSegment(store.database, "episode", 0, input());
  assert.throws(() => putVisualSegment(store.database, "episode", 1, input({
    cueStartIndex: 1, cueEndIndex: 2,
  })), /区间重叠/);
  store.database.prepare("DELETE FROM subtitle_cues WHERE timeline_hash = ? AND cue_index = 1").run(TIMELINE);
  assert.throws(() => assertVisualPlanReady(store.database, "episode", TIMELINE), /不连续/);
}));

test("完整视觉计划覆盖首尾且候选后续 reject 会保留关系并失效", () => fixture((store) => {
  const first = putVisualSegment(store.database, "episode", 0, input());
  assert.throws(() => assertVisualPlanReady(store.database, "episode", TIMELINE), /末尾/);
  appendAssetCandidateReview(store.database, "candidate_b", { expectedRevision: 0, action: "approve", now: 2 });
  putVisualSegment(store.database, "episode", 1, input({
    cueStartIndex: 2,
    cueEndIndex: 3,
    assets: [{ assetId: "asset_b", selectedCandidateId: "candidate_b" }],
  }));
  assert.equal(assertVisualPlanReady(store.database, "episode", TIMELINE).length, 2);
  appendAssetCandidateReview(store.database, "candidate_a", { expectedRevision: 1, action: "reject", now: 3 });
  const retained = listVisualSegments(store.database, "episode", TIMELINE);
  assert.equal(retained[0]!.id, first.id);
  assert.equal(retained[0]!.assets[0]!.selectedCandidateId, "candidate_a");
  assert.equal(retained[0]!.productionReady, false);
  assert.throws(() => assertVisualPlanReady(store.database, "episode", TIMELINE), /已失效/);
  appendAssetCandidateReview(store.database, "candidate_a", { expectedRevision: 2, action: "approve", now: 4 });
  const refreshed = putVisualSegment(store.database, "episode", 0, input({ expectedRevision: 1 }));
  assert.equal(refreshed.revision, 2);
  assert.equal(refreshed.assets[0]!.candidateReviewRevision, 3);
  assert.equal(refreshed.productionReady, true);
}));

test("生产就绪要求开头段数合规且候选图互不相同，并按短时间轴缩减", async () => {
  await openingFixture((store) => {
    putOpeningPlan(store, ["a", "b"]);
    assert.throws(() => assertVisualPlanReady(store.database, "episode", TIMELINE), /开头画面变化/);
  });
  await openingFixture((store) => {
    putOpeningPlan(store, ["a", "b", "c", "d", "e"]);
    assert.throws(() => assertVisualPlanReady(store.database, "episode", TIMELINE), /开头画面变化/);
  });
  await openingFixture((store) => {
    putOpeningPlan(store, ["a", "a", "a"]);
    assert.throws(() => assertVisualPlanReady(store.database, "episode", TIMELINE), /互不相同/);
  });
  await openingFixture((store) => {
    putOpeningPlan(store, ["a", "b", "c"]);
    assert.equal(assertVisualPlanReady(store.database, "episode", TIMELINE).length, 3);
  });
  await fixture((store) => {
    putVisualSegment(store.database, "episode", 0, input({ cueEndIndex: 3 }));
    assert.equal(assertVisualPlanReady(store.database, "episode", TIMELINE).length, 1);
  });
});

test("视觉计划拒绝分段空洞、批准稿变化并在重启后保持", () => fixture(async (store, dataRoot) => {
  putVisualSegment(store.database, "episode", 0, input({ cueStartIndex: 0, cueEndIndex: 0 }));
  putVisualSegment(store.database, "episode", 2, input({ cueStartIndex: 2, cueEndIndex: 3 }));
  assert.throws(() => assertVisualPlanReady(store.database, "episode", TIMELINE), /空洞/);
  store.close();
  const reopened = openDatabase(dataRoot);
  assert.equal(listVisualSegments(reopened.database, "episode", TIMELINE).length, 2);
  reopened.database.prepare(
    `INSERT INTO script_approval_events (id, episode_id, revision, action, script_version_id, created_at)
     VALUES ('approve_other', 'episode', 2, 'approve', 'other_script', 2)`,
  ).run();
  assert.equal(listVisualSegments(reopened.database, "episode", TIMELINE)[0]!.productionReady, false);
  assert.throws(() => assertVisualPlanReady(reopened.database, "episode", TIMELINE), /时间轴与当前批准稿不一致/);
  reopened.close();
}));
