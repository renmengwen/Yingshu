import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, open, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import { appendAssetCandidateReview } from "./asset-candidate-store.js";
import {
  exportContactSheet,
  resolveVerifiedCandidateFile,
  verifyCurrentContactSheetArtifact,
} from "./contact-sheet.js";
import { openDatabase, type YingshuDatabase } from "./database.js";
import { putVisualSegment } from "./visual-segment-store.js";

const TIMELINE = "a".repeat(64);

async function seed(store: YingshuDatabase, dataRoot: string) {
  const db = store.database;
  db.prepare(
    `INSERT INTO books (id, title, original_file_path, original_file_hash, encoding, import_status)
     VALUES ('book', '书', 'books/book/source.txt', ?, 'UTF-8', 'ready')`,
  ).run("1".repeat(64));
  db.exec(`
    INSERT INTO series_projects (id, book_id, title, created_at, updated_at)
    VALUES ('series', 'book', '系列', 1, 1);
    INSERT INTO episodes (
      id, series_project_id, episode_index, title, story_arc, target_duration_seconds, created_at, updated_at
    ) VALUES ('episode', 'series', 1, '第一集', '故事弧', 180, 1, 1);
  `);
  db.prepare(
    `INSERT INTO script_versions (id, episode_id, kind, version, content_json, content_hash, created_at)
     VALUES ('script', 'episode', 'packaged', 1, '{}', ?, 1)`,
  ).run("2".repeat(64));
  db.exec(`
    INSERT INTO script_approval_events (id, episode_id, revision, action, script_version_id, created_at)
    VALUES ('approval', 'episode', 1, 'approve', 'script', 1);
  `);
  db.prepare(
    `INSERT INTO audio_segments (
       timeline_hash, segment_index, episode_id, script_version_id, text, provider_id, voice, rate,
       input_hash, relative_path, file_hash, bytes, duration_ms, created_at
     ) VALUES (?, 0, 'episode', 'script', '旁白', 'test', 'voice', 0, ?, 'audio/0.wav', ?, 100, 1000, 1)`,
  ).run(TIMELINE, "3".repeat(64), "4".repeat(64));
  db.prepare(
    `INSERT INTO subtitle_cues (
       timeline_hash, cue_index, segment_index, episode_id, script_version_id, start_ms, end_ms, text
     ) VALUES (?, 0, 0, 'episode', 'script', 0, 1000, '旁白')`,
  ).run(TIMELINE);
  db.exec(`
    INSERT INTO assets (
      id, series_project_id, asset_type, asset_role, canonical_name, normalized_name, created_at
    ) VALUES ('asset', 'series', 'scene', 'master', '<桥&夜>', '<桥&夜>', 1);
  `);

  const content = Buffer.from("candidate-image-content", "utf8");
  const fileHash = createHash("sha256").update(content).digest("hex");
  const relativePath = `assets/candidates/${fileHash.slice(0, 2)}/${fileHash}.png`;
  const absolutePath = join(dataRoot, ...relativePath.split("/"));
  await mkdir(dirname(absolutePath), { recursive: true });
  await writeFile(absolutePath, content);
  db.prepare(
    `INSERT INTO asset_candidates (
       id, asset_id, source_kind, source_identity_hash, source_json, file_hash,
       mime, width, height, bytes, relative_path, created_at
     ) VALUES ('candidate', 'asset', 'upload', ?, ?, ?, 'image/png', 32, 48, ?, ?, 1)`,
  ).run("5".repeat(64), '{"kind":"upload","originalName":"<source>.png"}', fileHash, content.length, relativePath);
  appendAssetCandidateReview(db, "candidate", { expectedRevision: 0, action: "approve", now: 1 });
  putVisualSegment(db, "episode", 0, {
    timelineHash: TIMELINE,
    cueStartIndex: 0,
    cueEndIndex: 0,
    motionKind: "none",
    motionAmountPpm: 0,
    fadeMs: 0,
    expectedRevision: 0,
    assets: [{ assetId: "asset", selectedCandidateId: "candidate" }],
  }, 1);
  return { content, fileHash, relativePath, absolutePath };
}

async function fixture(run: (
  store: YingshuDatabase,
  dataRoot: string,
  seeded: Awaited<ReturnType<typeof seed>>,
) => void | Promise<void>) {
  const dataRoot = await mkdtemp(join(tmpdir(), "narralume-contact-sheet-"));
  try {
    const store = openDatabase(dataRoot);
    const seeded = await seed(store, dataRoot);
    try { await run(store, dataRoot, seeded); } finally {
      try { store.close(); } catch { /* 测试可主动关闭数据库后验证重启。 */ }
    }
  } finally {
    await rm(dataRoot, { recursive: true, force: true });
  }
}

test("联系表确定性导出并在重启后保持相同字节", () => fixture(async (store, dataRoot, seeded) => {
  const first = await exportContactSheet(store.database, dataRoot, "episode", TIMELINE);
  const firstJson = await readFile(first.jsonPath);
  const firstHtml = await readFile(first.htmlPath);
  assert.equal(first.jsonHash, createHash("sha256").update(firstJson).digest("hex"));
  assert.equal(first.htmlHash, createHash("sha256").update(firstHtml).digest("hex"));
  assert.match(firstHtml.toString("utf8"), /&lt;桥&amp;夜&gt;/u);
  assert.match(firstHtml.toString("utf8"), /\.\.\/\.\.\/\.\.\/\.\.\/assets\/candidates/u);
  const document = JSON.parse(firstJson.toString("utf8")) as {
    segments: Array<{ assets: Array<{ selectedCandidate: { source: { originalName: string } } }> }>;
  };
  assert.equal(document.segments[0]!.assets[0]!.selectedCandidate.source.originalName, "<source>.png");

  store.close();
  const reopened = openDatabase(dataRoot);
  const second = await exportContactSheet(reopened.database, dataRoot, "episode", TIMELINE);
  assert.deepEqual(await readFile(second.jsonPath), firstJson);
  assert.deepEqual(await readFile(second.htmlPath), firstHtml);
  assert.deepEqual(await resolveVerifiedCandidateFile(reopened.database, dataRoot, "candidate"), {
    candidateId: "candidate",
    absolutePath: seeded.absolutePath,
    relativePath: seeded.relativePath,
    mime: "image/png",
    bytes: seeded.content.length,
    fileHash: seeded.fileHash,
    width: 32,
    height: 48,
    content: seeded.content,
  });
  reopened.close();
}));

test("当前联系表可按确定身份复验且任一文件篡改都会拒绝", () => fixture(async (store, dataRoot) => {
  const exported = await exportContactSheet(store.database, dataRoot, "episode", TIMELINE);
  const first = await verifyCurrentContactSheetArtifact(store.database, dataRoot, "episode", TIMELINE);
  const second = await verifyCurrentContactSheetArtifact(store.database, dataRoot, "episode", TIMELINE);
  assert.deepEqual(second, first);
  assert.deepEqual(first.identity, {
    contract: "contact-sheet-review-v1",
    episodeId: "episode",
    scriptVersionId: "script",
    approvalRevision: 1,
    timelineHash: TIMELINE,
    visualPlanHash: first.identity.visualPlanHash,
    jsonHash: exported.jsonHash,
    htmlHash: exported.htmlHash,
  });
  assert.match(first.identityHash, /^[0-9a-f]{64}$/u);

  await writeFile(exported.jsonPath, "{");
  await assert.rejects(
    verifyCurrentContactSheetArtifact(store.database, dataRoot, "episode", TIMELINE),
    /JSON 无效/u,
  );
  await exportContactSheet(store.database, dataRoot, "episode", TIMELINE);
  await writeFile(exported.htmlPath, "tampered");
  await assert.rejects(
    verifyCurrentContactSheetArtifact(store.database, dataRoot, "episode", TIMELINE),
    /与当前视觉计划不一致/u,
  );
  await rm(exported.htmlPath);
  await assert.rejects(
    verifyCurrentContactSheetArtifact(store.database, dataRoot, "episode", TIMELINE),
    /缺失或已失效/u,
  );
}));

test("视觉段、候选批准、稿件批准或时间轴变化都会使旧联系表失效", async (t) => {
  await t.test("视觉段 revision", () => fixture(async (store, dataRoot) => {
    await exportContactSheet(store.database, dataRoot, "episode", TIMELINE);
    putVisualSegment(store.database, "episode", 0, {
      timelineHash: TIMELINE,
      cueStartIndex: 0,
      cueEndIndex: 0,
      motionKind: "zoom-in",
      motionAmountPpm: 100,
      fadeMs: 0,
      expectedRevision: 1,
      assets: [{ assetId: "asset", selectedCandidateId: "candidate" }],
    }, 2);
    await assert.rejects(
      verifyCurrentContactSheetArtifact(store.database, dataRoot, "episode", TIMELINE),
      /与当前视觉计划不一致/u,
    );
  }));
  await t.test("候选批准 revision", () => fixture(async (store, dataRoot) => {
    await exportContactSheet(store.database, dataRoot, "episode", TIMELINE);
    appendAssetCandidateReview(store.database, "candidate", { expectedRevision: 1, action: "reject", now: 2 });
    appendAssetCandidateReview(store.database, "candidate", { expectedRevision: 2, action: "approve", now: 3 });
    store.database.prepare(
      "UPDATE visual_segment_assets SET candidate_review_revision = 3",
    ).run();
    await assert.rejects(
      verifyCurrentContactSheetArtifact(store.database, dataRoot, "episode", TIMELINE),
      /与当前视觉计划不一致/u,
    );
  }));
  await t.test("稿件批准 revision", () => fixture(async (store, dataRoot) => {
    await exportContactSheet(store.database, dataRoot, "episode", TIMELINE);
    store.database.exec(`
      INSERT INTO script_approval_events (id, episode_id, revision, action, script_version_id, created_at)
      VALUES ('reapproval', 'episode', 2, 'approve', 'script', 2);
      UPDATE visual_segments SET approval_revision = 2;
    `);
    await assert.rejects(
      verifyCurrentContactSheetArtifact(store.database, dataRoot, "episode", TIMELINE),
      /与当前视觉计划不一致/u,
    );
  }));
  await t.test("时间轴", () => fixture(async (store, dataRoot) => {
    await exportContactSheet(store.database, dataRoot, "episode", TIMELINE);
    store.database.prepare(
      "UPDATE subtitle_cues SET end_ms = 999 WHERE episode_id = 'episode' AND timeline_hash = ?",
    ).run(TIMELINE);
    await assert.rejects(
      verifyCurrentContactSheetArtifact(store.database, dataRoot, "episode", TIMELINE),
      /已失效/u,
    );
  }));
});

test("候选图校验与发送复用同一份已验证字节", () => fixture(async (store, dataRoot, seeded) => {
  const verified = await resolveVerifiedCandidateFile(store.database, dataRoot, "candidate");
  await writeFile(seeded.absolutePath, "replacement-after-verification");
  assert.deepEqual(verified.content, seeded.content);
  assert.notDeepEqual(verified.content, await readFile(seeded.absolutePath));
}));

test("耐久写入和首次发布失败会清理暂存文件", () => fixture(async (store, dataRoot) => {
  const parent = join(dataRoot, "episodes", "episode", "contact-sheets");
  await assert.rejects(exportContactSheet(store.database, dataRoot, "episode", TIMELINE, {
    openFile: async (path, flags, mode) => {
      const handle = await open(path, flags, mode);
      return {
        writeFile: handle.writeFile.bind(handle),
        sync: async () => { throw new Error("injected sync failure"); },
        close: handle.close.bind(handle),
      };
    },
  }), /injected sync failure/u);
  assert.deepEqual(await readdir(parent), []);

  let failed = false;
  await assert.rejects(exportContactSheet(store.database, dataRoot, "episode", TIMELINE, {
    publishRename: async (from, to) => {
      if (!failed && to === join(parent, TIMELINE)) {
        failed = true;
        throw new Error("injected first publish failure");
      }
      await rename(from, to);
    },
  }), /injected first publish failure/u);
  assert.deepEqual(await readdir(parent), []);
}));

test("覆盖发布第二步失败会恢复旧 JSON 和 HTML 且不泄漏备份", () => fixture(async (store, dataRoot) => {
  const first = await exportContactSheet(store.database, dataRoot, "episode", TIMELINE);
  const oldJson = await readFile(first.jsonPath);
  const oldHtml = await readFile(first.htmlPath);
  store.database.prepare(
    `UPDATE asset_candidates SET source_json = '{"kind":"upload","originalName":"changed.png"}' WHERE id = 'candidate'`,
  ).run();

  let failed = false;
  await assert.rejects(exportContactSheet(store.database, dataRoot, "episode", TIMELINE, {
    publishRename: async (from, to) => {
      if (!failed && to === first.directoryPath && String(from).includes(`.${TIMELINE}.`)) {
        failed = true;
        throw new Error("injected second publish failure");
      }
      await rename(from, to);
    },
  }), /injected second publish failure/u);
  assert.deepEqual(await readFile(first.jsonPath), oldJson);
  assert.deepEqual(await readFile(first.htmlPath), oldHtml);
  assert.deepEqual(await readdir(dirname(first.directoryPath)), [TIMELINE]);
}));

test("候选图路径或内容异常时抛出 409 且不覆盖旧联系表", () => fixture(async (store, dataRoot, seeded) => {
  const exported = await exportContactSheet(store.database, dataRoot, "episode", TIMELINE);
  const oldJson = await readFile(exported.jsonPath);
  const oldHtml = await readFile(exported.htmlPath);

  store.database.prepare("UPDATE asset_candidates SET relative_path = 'assets/candidates/wrong.png' WHERE id = 'candidate'").run();
  await assert.rejects(exportContactSheet(store.database, dataRoot, "episode", TIMELINE),
    (error: unknown) => (error as { statusCode?: number }).statusCode === 409);
  assert.deepEqual(await readFile(exported.jsonPath), oldJson);
  assert.deepEqual(await readFile(exported.htmlPath), oldHtml);

  store.database.prepare("UPDATE asset_candidates SET relative_path = ? WHERE id = 'candidate'").run(seeded.relativePath);
  await writeFile(seeded.absolutePath, "tampered");
  await assert.rejects(exportContactSheet(store.database, dataRoot, "episode", TIMELINE),
    (error: unknown) => (error as { statusCode?: number }).statusCode === 409);
  assert.deepEqual(await readFile(exported.jsonPath), oldJson);
  assert.deepEqual(await readFile(exported.htmlPath), oldHtml);
}));

test("候选图后续拒绝或文件缺失都会阻断导出", () => fixture(async (store, dataRoot, seeded) => {
  appendAssetCandidateReview(store.database, "candidate", { expectedRevision: 1, action: "reject", now: 2 });
  await assert.rejects(exportContactSheet(store.database, dataRoot, "episode", TIMELINE), /已失效/u);
  appendAssetCandidateReview(store.database, "candidate", { expectedRevision: 2, action: "approve", now: 3 });
  putVisualSegment(store.database, "episode", 0, {
    timelineHash: TIMELINE,
    cueStartIndex: 0,
    cueEndIndex: 0,
    motionKind: "none",
    motionAmountPpm: 0,
    fadeMs: 0,
    expectedRevision: 1,
    assets: [{ assetId: "asset", selectedCandidateId: "candidate" }],
  }, 3);
  await rm(seeded.absolutePath);
  await assert.rejects(exportContactSheet(store.database, dataRoot, "episode", TIMELINE),
    (error: unknown) => (error as { statusCode?: number }).statusCode === 409);
}));
