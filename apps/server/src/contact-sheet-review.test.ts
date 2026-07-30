import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import { appendAssetCandidateReview } from "./asset-candidate-store.js";
import { exportContactSheet } from "./contact-sheet.js";
import {
  CONTACT_SHEET_REVIEW_JOB_TYPE,
  createContactSheetReviewHandler,
  enqueueContactSheetReview,
  getContactSheetReviewWorkspace,
} from "./contact-sheet-review.js";
import { openDatabase } from "./database.js";
import { getJob } from "./job-store.js";
import { JobWorker } from "./job-worker.js";
import { putVisualSegment } from "./visual-segment-store.js";

const TIMELINE = "a".repeat(64);

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "narralume-contact-review-"));
  const connection = openDatabase(root);
  const db = connection.database;
  db.prepare(`INSERT INTO books (id,title,original_file_path,original_file_hash,encoding,import_status)
    VALUES ('book','书','books/book/source.txt',?,'UTF-8','ready')`).run("1".repeat(64));
  db.exec(`
    INSERT INTO series_projects (id,book_id,title,created_at,updated_at) VALUES ('series','book','系列',1,1);
    INSERT INTO episodes (id,series_project_id,episode_index,title,story_arc,target_duration_seconds,created_at,updated_at)
      VALUES ('episode','series',1,'第一集','开端',180,1,1);
  `);
  db.prepare(`INSERT INTO script_versions (id,episode_id,kind,version,content_json,content_hash,created_at)
    VALUES ('script','episode','packaged',1,'{}',?,1)`).run("2".repeat(64));
  db.exec(`INSERT INTO script_approval_events (id,episode_id,revision,action,script_version_id,created_at)
    VALUES ('approval','episode',1,'approve','script',1)`);
  db.prepare(`INSERT INTO audio_segments
    (timeline_hash,segment_index,episode_id,script_version_id,text,provider_id,voice,rate,input_hash,relative_path,file_hash,bytes,duration_ms,created_at)
    VALUES (?,0,'episode','script','旁白','test','voice',1,?,'audio/0.wav',?,100,1000,1)`)
    .run(TIMELINE, "3".repeat(64), "4".repeat(64));
  db.prepare(`INSERT INTO subtitle_cues
    (timeline_hash,cue_index,segment_index,episode_id,script_version_id,start_ms,end_ms,text)
    VALUES (?,0,0,'episode','script',0,1000,'旁白')`).run(TIMELINE);
  db.exec(`INSERT INTO assets
    (id,series_project_id,asset_type,asset_role,canonical_name,normalized_name,created_at)
    VALUES ('asset','series','scene','master','场景','场景',1)`);
  const content = Buffer.from("candidate-image", "utf8");
  const fileHash = createHash("sha256").update(content).digest("hex");
  const relativePath = `assets/candidates/${fileHash.slice(0, 2)}/${fileHash}.png`;
  const absolutePath = join(root, ...relativePath.split("/"));
  await mkdir(dirname(absolutePath), { recursive: true });
  await writeFile(absolutePath, content);
  db.prepare(`INSERT INTO asset_candidates
    (id,asset_id,source_kind,source_identity_hash,source_json,file_hash,mime,width,height,bytes,relative_path,created_at)
    VALUES ('candidate','asset','upload',?,'{"kind":"upload","originalName":"source.png"}',?,'image/png',32,48,?,?,1)`)
    .run("5".repeat(64), fileHash, content.length, relativePath);
  appendAssetCandidateReview(db, "candidate", { expectedRevision: 0, action: "approve", now: 1 });
  putVisualSegment(db, "episode", 0, {
    timelineHash: TIMELINE, cueStartIndex: 0, cueEndIndex: 0, motionKind: "none", motionAmountPpm: 0,
    fadeMs: 0, expectedRevision: 0, assets: [{ assetId: "asset", selectedCandidateId: "candidate" }],
  }, 1);
  await exportContactSheet(db, root, "episode", TIMELINE);
  return { root, connection, absolutePath };
}

function worker(database: ReturnType<typeof openDatabase>["database"], dataRoot: string, id: string) {
  return new JobWorker(database, {
    [CONTACT_SHEET_REVIEW_JOB_TYPE]: createContactSheetReviewHandler(database, dataRoot),
  }, { workerId: id, leaseMs: 5_000, heartbeatMs: 100 });
}

test("联系表 approve/reject 显式落为可恢复凭证且同请求幂等", async () => {
  const { root, connection } = await fixture();
  try {
    const workspace = await getContactSheetReviewWorkspace(connection.database, root, "episode", TIMELINE);
    const input = {
      episodeId: "episode", timelineHash: TIMELINE, action: "approve" as const,
      expectedIdentityHash: workspace.identityHash, notes: "  已逐段检查  ",
    };
    const first = await enqueueContactSheetReview(connection.database, root, input);
    const second = await enqueueContactSheetReview(connection.database, root, input);
    assert.equal(second.id, first.id);
    assert.equal(await worker(connection.database, root, "reviewer").runOne(), true);
    assert.deepEqual((await getContactSheetReviewWorkspace(connection.database, root, "episode", TIMELINE)).latestReview, {
      contract: "contact-sheet-review-v1", identity: workspace.identity, identityHash: workspace.identityHash,
      action: "approve", notes: "已逐段检查", jobId: first.id,
    });

    const reject = await enqueueContactSheetReview(connection.database, root, {
      episodeId: "episode", timelineHash: TIMELINE, action: "reject",
      expectedIdentityHash: workspace.identityHash, notes: "镜头衔接需调整",
    });
    assert.equal(await worker(connection.database, root, "rejecter").runOne(), true);
    assert.equal(getJob(connection.database, reject.id)?.status, "succeeded");
    assert.equal((await getContactSheetReviewWorkspace(connection.database, root, "episode", TIMELINE)).latestReview?.action, "reject");

    connection.close();
    const reopened = openDatabase(root);
    assert.equal((await getContactSheetReviewWorkspace(reopened.database, root, "episode", TIMELINE)).latestReview?.jobId, reject.id);
    reopened.close();
  } finally {
    try { connection.close(); } catch { /* 已在重载验证前关闭。 */ }
    await rm(root, { recursive: true, force: true });
  }
});

test("enqueue 拒绝过期身份，执行时再次拒绝视觉漂移并标记旧审核", async () => {
  const { root, connection } = await fixture();
  try {
    const initial = await getContactSheetReviewWorkspace(connection.database, root, "episode", TIMELINE);
    await assert.rejects(enqueueContactSheetReview(connection.database, root, {
      episodeId: "episode", timelineHash: TIMELINE, action: "approve", expectedIdentityHash: "b".repeat(64),
    }), /身份已变化/u);
    const staleJob = await enqueueContactSheetReview(connection.database, root, {
      episodeId: "episode", timelineHash: TIMELINE, action: "approve", expectedIdentityHash: initial.identityHash,
    });
    putVisualSegment(connection.database, "episode", 0, {
      timelineHash: TIMELINE, cueStartIndex: 0, cueEndIndex: 0, motionKind: "zoom-in", motionAmountPpm: 100,
      fadeMs: 0, expectedRevision: 1, assets: [{ assetId: "asset", selectedCandidateId: "candidate" }],
    }, 2);
    await exportContactSheet(connection.database, root, "episode", TIMELINE);
    assert.equal(await worker(connection.database, root, "drift").runOne(), true);
    assert.equal(getJob(connection.database, staleJob.id)?.status, "failed");

    const current = await getContactSheetReviewWorkspace(connection.database, root, "episode", TIMELINE);
    const currentJob = await enqueueContactSheetReview(connection.database, root, {
      episodeId: "episode", timelineHash: TIMELINE, action: "approve", expectedIdentityHash: current.identityHash,
    });
    assert.equal(await worker(connection.database, root, "current").runOne(), true);
    assert.equal(getJob(connection.database, currentJob.id)?.status, "succeeded");
    assert.equal((await getContactSheetReviewWorkspace(connection.database, root, "episode", TIMELINE)).hasStaleReview, false);

    putVisualSegment(connection.database, "episode", 0, {
      timelineHash: TIMELINE, cueStartIndex: 0, cueEndIndex: 0, motionKind: "pan-left", motionAmountPpm: 100,
      fadeMs: 0, expectedRevision: 2, assets: [{ assetId: "asset", selectedCandidateId: "candidate" }],
    }, 3);
    await exportContactSheet(connection.database, root, "episode", TIMELINE);
    const changed = await getContactSheetReviewWorkspace(connection.database, root, "episode", TIMELINE);
    assert.equal(changed.latestReview, null);
    assert.equal(changed.hasStaleReview, true);
  } finally { connection.close(); await rm(root, { recursive: true, force: true }); }
});

test("联系表文件被篡改时工作区和提交均被阻断", async () => {
  const { root, connection, absolutePath } = await fixture();
  try {
    const workspace = await getContactSheetReviewWorkspace(connection.database, root, "episode", TIMELINE);
    await writeFile(absolutePath, "tampered");
    await assert.rejects(
      getContactSheetReviewWorkspace(connection.database, root, "episode", TIMELINE),
      /篡改|失效|不一致/u,
    );
    await assert.rejects(enqueueContactSheetReview(connection.database, root, {
      episodeId: "episode", timelineHash: TIMELINE, action: "approve", expectedIdentityHash: workspace.identityHash,
    }));
  } finally { connection.close(); await rm(root, { recursive: true, force: true }); }
});
