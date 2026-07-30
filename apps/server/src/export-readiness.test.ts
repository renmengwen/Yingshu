import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import { exportContactSheet } from "./contact-sheet.js";
import {
  CONTACT_SHEET_REVIEW_JOB_TYPE, createContactSheetReviewHandler, enqueueContactSheetReview,
  getContactSheetReviewWorkspace,
} from "./contact-sheet-review.js";
import { openDatabase } from "./database.js";
import { deriveExportReadiness, ExportReadinessError } from "./export-readiness.js";
import { exportFinalVideo } from "./final-video.js";
import { JobWorker } from "./job-worker.js";
import { loadRenderPlanSnapshot } from "./render-chunk-job.js";
import { getTtsListeningReviewWorkspace } from "./tts-listening-review.js";

const TIMELINE = "a".repeat(64);
const hash = (content: string | Buffer) => createHash("sha256").update(content).digest("hex");

async function fixture() {
  const dataRoot = await mkdtemp(join(tmpdir(), "narralume-export-readiness-"));
  const connection = openDatabase(dataRoot);
  const db = connection.database;
  db.prepare("INSERT INTO books (id,title,original_file_path,original_file_hash,encoding,import_status) VALUES ('book','书','books/source.txt',?,'UTF-8','ready')").run("1".repeat(64));
  db.prepare(`INSERT INTO chapters (id,book_id,chapter_index,title,byte_start,byte_end,char_count,content_hash)
    VALUES ('chapter','book',0,'章',0,1,1,?)`).run("0".repeat(64));
  db.prepare("INSERT INTO series_projects (id,book_id,title,created_at,updated_at) VALUES ('series','book','系列',1,1)").run();
  db.prepare("INSERT INTO episodes (id,series_project_id,episode_index,title,story_arc,target_duration_seconds,created_at,updated_at) VALUES ('episode','series',1,'集','弧',180,1,1)").run();
  return { dataRoot, connection };
}

async function seedReady(db: ReturnType<typeof openDatabase>["database"], dataRoot: string) {
  db.prepare("INSERT INTO script_versions (id,episode_id,kind,version,content_json,content_hash,created_at) VALUES ('script','episode','packaged',1,'{}',?,1)").run("2".repeat(64));
  db.prepare("INSERT INTO script_approval_events (id,episode_id,revision,action,script_version_id,created_at) VALUES ('approval','episode',1,'approve','script',1)").run();
  db.prepare("INSERT INTO assets (id,series_project_id,asset_type,asset_role,canonical_name,normalized_name,created_at) VALUES ('asset','series','scene','master','场景','场景',1)").run();
  const candidate = Buffer.from("candidate-image");
  const candidateHash = hash(candidate);
  const candidatePath = `assets/candidates/${candidateHash.slice(0, 2)}/${candidateHash}.png`;
  await mkdir(dirname(join(dataRoot, candidatePath)), { recursive: true });
  await writeFile(join(dataRoot, candidatePath), candidate);
  db.prepare(`INSERT INTO asset_candidates (id,asset_id,source_kind,source_identity_hash,source_json,file_hash,mime,width,height,bytes,relative_path,created_at)
    VALUES ('candidate','asset','upload',?,'{}',?,'image/png',1080,1920,?,?,1)`).run(
    "3".repeat(64), candidateHash, candidate.length, candidatePath,
  );
  db.prepare("INSERT INTO asset_candidate_review_events (candidate_id,revision,action,created_at) VALUES ('candidate',1,'approve',1)").run();
  db.prepare(`INSERT INTO audio_segments (timeline_hash,segment_index,episode_id,script_version_id,text,provider_id,voice,rate,input_hash,relative_path,file_hash,bytes,duration_ms,created_at)
    VALUES (?,0,'episode','script','旁白','test','voice',0,?,'episodes/episode/audio/segments/audio.wav',?,1,60000,1)`).run(TIMELINE, "5".repeat(64), "6".repeat(64));
  db.prepare("INSERT INTO subtitle_cues (timeline_hash,cue_index,segment_index,episode_id,script_version_id,start_ms,end_ms,text) VALUES (?,0,0,'episode','script',0,60000,'旁白')").run(TIMELINE);
  db.prepare(`INSERT INTO visual_segments (id,episode_id,segment_index,script_version_id,approval_revision,timeline_hash,cue_start_index,cue_end_index,start_ms,end_ms,motion_kind,motion_amount_ppm,fade_ms,revision,created_at,updated_at)
    VALUES ('visual','episode',0,'script',1,?,0,0,0,60000,'none',0,0,1,1,1)`).run(TIMELINE);
  db.prepare("INSERT INTO visual_segment_assets (visual_segment_id,asset_index,asset_id,selected_candidate_id,candidate_review_revision) VALUES ('visual',0,'asset','candidate',1)").run();
  const bibleJson = JSON.stringify({ properNouns: [] });
  db.prepare(`INSERT INTO book_story_bibles
    (id,book_id,scope,source_start_chapter_id,source_end_chapter_id,source_event_ids_json,source_events_hash,
     parent_bible_ids_json,input_hash,contract_version,revision,provider_id,model,content_json,content_hash,created_at)
    VALUES ('bible','book','final','chapter','chapter','["event"]',?,'[]',?,'book-story-bible-v1',1,'provider','model',?,?,1)`)
    .run("7".repeat(64), "8".repeat(64), bibleJson, hash(bibleJson));
  db.prepare(`INSERT INTO series_pipeline_runs
    (id,series_project_id,status,episode_count,target_duration_seconds,source_start_chapter_id,source_end_chapter_id,
     config_hash,story_bible_id,created_at,updated_at)
    VALUES ('run','series','completed',1,180,'chapter','chapter',?,'bible',1,1)`).run("9".repeat(64));
}

async function seedContactSheetReview(
  db: ReturnType<typeof openDatabase>["database"], dataRoot: string, action: "approve" | "reject",
) {
  await exportContactSheet(db, dataRoot, "episode", TIMELINE);
  const workspace = await getContactSheetReviewWorkspace(db, dataRoot, "episode", TIMELINE);
  const job = await enqueueContactSheetReview(db, dataRoot, {
    episodeId: "episode", timelineHash: TIMELINE, action,
    expectedIdentityHash: workspace.identityHash,
  });
  const worker = new JobWorker(db, {
    [CONTACT_SHEET_REVIEW_JOB_TYPE]: createContactSheetReviewHandler(db, dataRoot),
  }, { workerId: `contact-sheet-${action}`, leaseMs: 5_000, heartbeatMs: 100 });
  assert.equal(await worker.runOne(), true);
  return job;
}

function seedListeningReview(
  db: ReturnType<typeof openDatabase>["database"], action: "approve" | "reject", id = `review-${action}`,
) {
  const workspace = getTtsListeningReviewWorkspace(db, "episode", TIMELINE);
  const payload = {
    contract: "tts-listening-review-v1", identity: workspace.identity, action,
    checkedSegmentIndexes: action === "approve" ? workspace.requiredSegmentIndexes : [],
    checkedProperNouns: action === "approve" ? workspace.requiredProperNouns.map((item) => item.term) : [], notes: null,
  };
  db.prepare(`INSERT INTO jobs
    (id,type,payload_json,status,priority,progress,attempts,max_attempts,run_after,cancel_requested,result_json,created_at,updated_at,finished_at)
    VALUES (?,'tts_listening_review',?,'succeeded',0,1,1,1,0,0,?,2,2,2)`)
    .run(id, JSON.stringify(payload), JSON.stringify({ ...payload, jobId: id }));
}

test("只读复核从当前生产身份派生门禁、分片、任务和已验证最终视频", async () => {
  const current = await fixture();
  try {
    const missing = await deriveExportReadiness({ database: current.connection.database, dataRoot: current.dataRoot,
      episodeId: "episode", timelineHash: TIMELINE });
    assert.equal(missing.productionReady, false);
    assert.match(missing.blockers[0]!.message, /未人工批准/u);

    const db = current.connection.database;
    await seedReady(db, current.dataRoot);
    seedListeningReview(db, "approve");
    await seedContactSheetReview(db, current.dataRoot, "approve");
    const snapshot = loadRenderPlanSnapshot(db, "episode", TIMELINE);
    db.prepare(`INSERT INTO jobs (id,type,payload_json,status,priority,progress,attempts,max_attempts,run_after,cancel_requested,result_json,created_at,updated_at,finished_at)
      VALUES ('old-render','render_chunks',?,'succeeded',0,1,1,1,0,0,?,1,1,1)`).run(
      JSON.stringify({ episodeId: "episode", timelineHash: TIMELINE }),
      JSON.stringify({ episodeId: "episode", timelineHash: TIMELINE, scriptVersionId: "old-script", approvalRevision: 1, chunks: [] }),
    );
    db.prepare(`INSERT INTO jobs (id,type,payload_json,status,priority,progress,attempts,max_attempts,run_after,cancel_requested,created_at,updated_at)
      VALUES ('current-render','render_chunks',?,'queued',0,0,0,1,0,0,2,2)`).run(JSON.stringify({ episodeId: "episode", timelineHash: TIMELINE }));
    db.prepare(`INSERT INTO jobs (id,type,payload_json,status,priority,progress,attempts,max_attempts,run_after,cancel_requested,created_at,updated_at)
      VALUES ('stale-active','render_chunks',?,'queued',0,0,0,1,0,0,0,4)`).run(JSON.stringify({ episodeId: "episode", timelineHash: TIMELINE }));
    const before = await deriveExportReadiness({ database: db, dataRoot: current.dataRoot, episodeId: "episode", timelineHash: TIMELINE });
    assert.equal(before.productionReady, true);
    assert.equal(before.identity?.contactSheetReady, true);
    assert.deepEqual(before.renderChunks, { ready: false, completed: 0, total: 1 });
    assert.equal(before.jobs.renderChunks?.id, "current-render", "旧终态 Job 不能冒充当前身份");

    const expected = snapshot.chunks[0]!;
    const chunk = Buffer.from("registered-chunk");
    const relativePath = `episodes/episode/renders/chunks/${expected.renderHash.slice(0, 2)}/${expected.renderHash}.mp4`;
    await mkdir(dirname(join(current.dataRoot, relativePath)), { recursive: true });
    await writeFile(join(current.dataRoot, relativePath), chunk);
    db.prepare(`INSERT INTO render_chunks (render_hash,episode_id,timeline_hash,chunk_index,script_version_id,approval_revision,start_ms,end_ms,relative_path,file_hash,bytes,duration_ms,created_at)
      VALUES (?,'episode',?,0,'script',1,0,60000,?,?,?,60000,1)`).run(expected.renderHash, TIMELINE, relativePath, hash(chunk), chunk.length);
    const exported = await exportFinalVideo(db, current.dataRoot, { episodeId: "episode", timelineHash: TIMELINE }, {
      probe: async (path) => ({ bytes: (await stat(path)).size, durationMs: 60_000 }),
      run: async (_command, _args, options) => { await writeFile(join(options!.cwd!, "final.tmp.mp4"), "final-video"); return ""; },
    });
    const result = { episodeId: "episode", timelineHash: TIMELINE, scriptVersionId: "script", approvalRevision: 1,
      finalHash: exported.manifest.exportHash, video: exported.manifest.finalVideo };
    db.prepare(`INSERT INTO jobs (id,type,payload_json,status,priority,progress,attempts,max_attempts,run_after,cancel_requested,result_json,created_at,updated_at,finished_at)
      VALUES ('final','final_video',?,'succeeded',0,1,1,1,0,0,?,3,3,3)`).run(
      JSON.stringify({ episodeId: "episode", timelineHash: TIMELINE }), JSON.stringify(result),
    );
    const ready = await deriveExportReadiness({ database: db, dataRoot: current.dataRoot, episodeId: "episode", timelineHash: TIMELINE });
    assert.deepEqual(ready.renderChunks, { ready: true, completed: 1, total: 1 });
    assert.equal(ready.jobs.finalVideo?.id, "final");
    assert.equal(ready.finalExport?.verified, true);
    assert.equal(ready.finalExport?.exportHash, exported.manifest.exportHash);

    await writeFile(exported.finalPath, "tampered");
    assert.equal((await deriveExportReadiness({ database: db, dataRoot: current.dataRoot,
      episodeId: "episode", timelineHash: TIMELINE })).finalExport?.verified, false);
  } finally {
    current.connection.close();
    await rm(current.dataRoot, { recursive: true, force: true });
  }
});

test("生产就绪只接受当前精确身份的人工听审批准", async () => {
  const current = await fixture();
  try {
    const db = current.connection.database;
    await seedReady(db, current.dataRoot);
    await exportContactSheet(db, current.dataRoot, "episode", TIMELINE);
    const missing = await deriveExportReadiness({ database: db, dataRoot: current.dataRoot,
      episodeId: "episode", timelineHash: TIMELINE });
    assert.equal(missing.productionReady, false);
    assert.deepEqual(missing.blockers.map((blocker) => blocker.code), [
      "tts_listening_review_missing", "contact_sheet_review_missing",
    ], "两个独立人工门应同时报告，不得短路");
    assert.equal(missing.identity?.contactSheetReady, false);

    seedListeningReview(db, "reject");
    const rejected = await deriveExportReadiness({ database: db, dataRoot: current.dataRoot,
      episodeId: "episode", timelineHash: TIMELINE });
    assert.equal(rejected.productionReady, false);
    assert.equal(rejected.blockers[0]?.code, "tts_listening_review_rejected");

    seedListeningReview(db, "approve", "review-approve-latest");
    db.prepare("UPDATE jobs SET created_at=3, updated_at=3, finished_at=3 WHERE id='review-approve-latest'").run();
    const contactMissing = await deriveExportReadiness({ database: db, dataRoot: current.dataRoot,
      episodeId: "episode", timelineHash: TIMELINE });
    assert.equal(contactMissing.productionReady, false);
    assert.deepEqual(contactMissing.blockers.map((blocker) => blocker.code), ["contact_sheet_review_missing"]);

    await seedContactSheetReview(db, current.dataRoot, "reject");
    const contactRejected = await deriveExportReadiness({ database: db, dataRoot: current.dataRoot,
      episodeId: "episode", timelineHash: TIMELINE });
    assert.equal(contactRejected.productionReady, false);
    assert.deepEqual(contactRejected.blockers.map((blocker) => blocker.code), ["contact_sheet_review_rejected"]);

    await seedContactSheetReview(db, current.dataRoot, "approve");
    const changesBefore = (db.prepare("SELECT total_changes() AS value").get() as { value: number }).value;
    const approved = await deriveExportReadiness({ database: db, dataRoot: current.dataRoot,
      episodeId: "episode", timelineHash: TIMELINE });
    assert.equal((db.prepare("SELECT total_changes() AS value").get() as { value: number }).value, changesBefore,
      "生产就绪投影必须保持只读");
    assert.equal(approved.productionReady, true);
    assert.equal(approved.identity?.contactSheetReady, true);
    assert.deepEqual(approved.blockers, []);

    db.prepare("UPDATE visual_segments SET fade_ms = 1, revision = revision + 1 WHERE episode_id = 'episode'").run();
    await exportContactSheet(db, current.dataRoot, "episode", TIMELINE);
    const contactStale = await deriveExportReadiness({ database: db, dataRoot: current.dataRoot,
      episodeId: "episode", timelineHash: TIMELINE });
    assert.equal(contactStale.productionReady, false);
    assert.deepEqual(contactStale.blockers.map((blocker) => blocker.code), ["contact_sheet_review_stale"]);

    await seedContactSheetReview(db, current.dataRoot, "approve");
    const htmlPath = (await getContactSheetReviewWorkspace(db, current.dataRoot, "episode", TIMELINE)).contactSheet.htmlPath;
    await writeFile(htmlPath, "tampered-contact-sheet");
    const unavailable = await deriveExportReadiness({ database: db, dataRoot: current.dataRoot,
      episodeId: "episode", timelineHash: TIMELINE });
    assert.equal(unavailable.productionReady, false);
    assert.deepEqual(unavailable.blockers.map((blocker) => blocker.code), ["contact_sheet_unavailable"]);

    db.prepare("UPDATE audio_segments SET voice = 'new-voice' WHERE episode_id = 'episode'").run();
    const stale = await deriveExportReadiness({ database: db, dataRoot: current.dataRoot,
      episodeId: "episode", timelineHash: TIMELINE });
    assert.equal(stale.productionReady, false);
    assert.equal(stale.blockers[0]?.code, "tts_listening_review_stale");
  } finally {
    current.connection.close();
    await rm(current.dataRoot, { recursive: true, force: true });
  }
});

test("拒绝非法标识并区分不存在分集", async () => {
  const current = await fixture();
  try {
    await assert.rejects(deriveExportReadiness({ database: current.connection.database, dataRoot: current.dataRoot,
      episodeId: "../episode", timelineHash: TIMELINE }), (error) => error instanceof ExportReadinessError && error.statusCode === 400);
    await assert.rejects(deriveExportReadiness({ database: current.connection.database, dataRoot: current.dataRoot,
      episodeId: "missing", timelineHash: TIMELINE }), (error) => error instanceof ExportReadinessError && error.statusCode === 404);
  } finally {
    current.connection.close();
    await rm(current.dataRoot, { recursive: true, force: true });
  }
});
