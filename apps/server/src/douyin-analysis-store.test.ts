import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { openDatabase } from "./database.js";
import { type DouyinAnalysisConfig, type DouyinAnalysisReport } from "./douyin-analysis-contract.js";
import {
  enqueueDouyinAnalysis, getCurrentDouyinAnalysisSnapshot, getDouyinAnalysisSelection,
  saveDouyinAnalysisSelection, updateDouyinAnalysisSnapshot,
} from "./douyin-analysis-store.js";
import { createJob } from "./job-store.js";
import { createProject, createVideo } from "./project-video-store.js";

const config: DouyinAnalysisConfig = {
  sourceText: "https://www.douyin.com/video/12345", extractFrames: true, frameCount: 12,
  transcribeAudio: true, analyzeComments: false,
};

function report(): DouyinAnalysisReport {
  const available = { status: "available" as const, reason: "fixture 证据可用" };
  const unavailable = { status: "unavailable" as const, reason: "未请求评论" };
  return {
    version: "yingshu-douyin-analysis-v1",
    evidence: { metadataStatus: "succeeded", videoStatus: "succeeded", asrStatus: "succeeded",
      asrCoveredDurationMs: 20_000, asrTextCharacters: 100, plannedFrames: 12, succeededFrames: 12,
      failedFrames: 0, commentCount: 0, evidenceHash: "a".repeat(64), capturedAt: 1, analyzedAt: 2,
      modelIdentity: "fixture", completeness: "complete" },
    availability: { content: available, narrative: available, pacing: available, visualOverall: available,
      visualOpening: available, audioSubtitle: available, audience: unavailable, narrationVisualAlignment: available },
    content: { observations: [] }, narrative: { sections: [], observations: [] },
    pacing: { metrics: { totalCharacters: 100 }, observations: [] }, visual: { observations: [] },
    audioSubtitle: { observations: [] }, audience: null, observations: [], risks: [],
  };
}

function seedDownstream(database: ReturnType<typeof openDatabase>["database"], projectId: string, videoId: string) {
  const planHash = "1".repeat(64);
  database.prepare(
    `INSERT INTO video_plan_snapshots
     (id,video_id,idempotency_key,input_json,prompt_json,model_json,system_contract_version,web_capability,
      canonical_json,snapshot_hash,created_at) VALUES ('plan_fixture',?,'fixture','{}','{}','{}','v1','none','{}',?,10)`,
  ).run(videoId, planHash);
  database.prepare(
    `INSERT INTO video_script_revisions
     (id,video_id,snapshot_id,revision,content_json,content_hash,provider_id,model_id,prompt_version,prompt_hash,created_at)
     VALUES ('script_fixture',?,'plan_fixture',1,'{}',?,'provider','model','v1',?,11)`,
  ).run(videoId, "2".repeat(64), "3".repeat(64));
  database.prepare(
    `INSERT INTO video_visual_revisions
     (id,video_id,snapshot_id,script_revision_id,script_content_hash,revision,content_json,content_hash,created_at)
     VALUES ('visual_fixture',?,'plan_fixture','script_fixture',?,1,'{}',?,12)`,
  ).run(videoId, "2".repeat(64), "4".repeat(64));

  const planJob = createJob(database, { id: "job_plan_fixture", type: "video_plan_generate", payload: {} }, 20);
  database.prepare("INSERT INTO video_plan_jobs (job_id,video_id,snapshot_id,created_at) VALUES (?,?,'plan_fixture',20)")
    .run(planJob.id, videoId);
  const imageJob = createJob(database, { id: "job_image_fixture", type: "video_image_generate", payload: {} }, 20);
  database.prepare(
    `INSERT INTO video_image_batches
     (id,project_id,video_id,plan_snapshot_id,plan_snapshot_hash,script_revision_id,script_content_hash,
      visual_revision_id,visual_content_hash,mode,idempotency_key,provider_id,model_id,planned_count,created_at)
     VALUES ('image_batch_fixture',?,?,'plan_fixture',?,'script_fixture',?,'visual_fixture',?,'batch','fixture','provider','model',1,20)`,
  ).run(projectId, videoId, planHash, "2".repeat(64), "4".repeat(64));
  database.prepare(
    `INSERT INTO video_image_batch_items
     (batch_id,video_id,visual_id,job_id,request_identity,status,created_at,updated_at)
     VALUES ('image_batch_fixture',?,'visual_fixture',?,'image-request-fixture','queued',20,20)`,
  ).run(videoId, imageJob.id);

  const ttsSnapshotHash = "5".repeat(64);
  database.prepare(
    `INSERT INTO video_tts_snapshots
     (id,project_id,video_id,plan_snapshot_id,plan_snapshot_hash,script_revision_id,script_content_hash,
      paragraphs_json,provider_id,provider_name,provider_kind,protocol,base_url,model_id,voice_id,rate,language,
      params_json,target_duration_seconds,system_contract_version,canonical_json,snapshot_hash,created_at)
     VALUES ('tts_fixture',?,?,'plan_fixture',?,'script_fixture',?,'[]','provider','provider','openai','openai_tts',
      'https://example.com','model','voice',0,'zh-CN','{}',180,'v1','{}',?,20)`,
  ).run(projectId, videoId, planHash, "2".repeat(64), ttsSnapshotHash);
  const ttsJob = createJob(database, { id: "job_tts_fixture", type: "video_tts_generate", payload: {} }, 20);
  database.prepare("INSERT INTO video_tts_jobs (job_id,video_id,snapshot_id,created_at) VALUES (?,?,'tts_fixture',20)")
    .run(ttsJob.id, videoId);
}

test("分析快照、选择事件、下游失效和重启恢复保持一致", async () => {
  const dataRoot = await mkdtemp(join(tmpdir(), "yingshu-douyin-store-"));
  try {
    let connection = openDatabase(dataRoot);
    const project = createProject(connection.database, { name: "抖音 fixture" }, 1);
    const video = createVideo(connection.database, project.id, { title: "分析视频" }, 2);
    const created = enqueueDouyinAnalysis(connection.database, { projectId: project.id, videoId: video.id,
      awemeId: "12345", sourceUrl: "https://www.douyin.com/video/12345", config, now: 3 });
    assert.equal(created.created, true);
    connection.database.prepare(
      "UPDATE jobs SET status='succeeded',progress=1,finished_at=4,updated_at=4 WHERE id=?",
    ).run(created.job!.id);
    const completed = updateDouyinAnalysisSnapshot(connection.database, { snapshotId: created.snapshot.id,
      status: "succeeded", completeness: "complete", evidenceHash: "a".repeat(64), report: report(), completedAt: 4 });
    assert.ok(completed.reportHash);

    const partialAsrReport = report();
    partialAsrReport.evidence.asrStatus = "partial";
    partialAsrReport.evidence.completeness = "partial";
    updateDouyinAnalysisSnapshot(connection.database, { snapshotId: created.snapshot.id,
      status: "partial", completeness: "partial", evidenceHash: "a".repeat(64), report: partialAsrReport, completedAt: 4 });
    assert.throws(() => saveDouyinAnalysisSelection(connection.database, { projectId: project.id, videoId: video.id, now: 4,
      selection: { snapshotId: completed.id, usageRole: "topic_seed", creativeAngle: "重新研究",
        rightsConfirmed: false, acceptedMissingDimensions: [] } }), /明确接受包含 ASR 的部分结果/u);
    updateDouyinAnalysisSnapshot(connection.database, { snapshotId: created.snapshot.id,
      status: "succeeded", completeness: "complete", evidenceHash: "a".repeat(64), report: report(), completedAt: 4 });

    const reused = enqueueDouyinAnalysis(connection.database, { projectId: project.id, videoId: video.id,
      awemeId: "12345", sourceUrl: "https://www.douyin.com/video/12345", config, now: 5 });
    assert.equal(reused.reusable, true);
    assert.equal(reused.job, null);
    saveDouyinAnalysisSelection(connection.database, { projectId: project.id, videoId: video.id, now: 6,
      selection: { snapshotId: completed.id, usageRole: "method_only", creativeAngle: "先讲问题",
        rightsConfirmed: false, acceptedMissingDimensions: ["audience"] } });
    assert.equal(connection.database.prepare(
      "SELECT COUNT(*) AS count FROM video_douyin_analysis_selection_events WHERE event_type='accept_partial'",
    ).get()?.count, 1);

    seedDownstream(connection.database, project.id, video.id);
    connection.database.exec(
      `CREATE TRIGGER reject_selection_update BEFORE UPDATE ON video_douyin_analysis_selections
       BEGIN SELECT RAISE(ABORT, 'fixture rollback'); END;`,
    );
    assert.throws(() => saveDouyinAnalysisSelection(connection.database, { projectId: project.id, videoId: video.id, now: 30,
      selection: { snapshotId: completed.id, usageRole: "method_only", creativeAngle: "触发回滚",
        rightsConfirmed: false, acceptedMissingDimensions: ["audience"] } }), /fixture rollback/u);
    assert.equal(connection.database.prepare("SELECT invalidated_at FROM video_plan_snapshots WHERE id='plan_fixture'").get()?.invalidated_at, null);
    assert.equal(connection.database.prepare("SELECT status FROM jobs WHERE id='job_plan_fixture'").get()?.status, "queued");
    connection.database.exec("DROP TRIGGER reject_selection_update");

    saveDouyinAnalysisSelection(connection.database, { projectId: project.id, videoId: video.id, now: 31,
      selection: { snapshotId: completed.id, usageRole: "content_source", creativeAngle: "独立重组",
        rightsConfirmed: true, acceptedMissingDimensions: ["audience"] } });
    assert.equal(connection.database.prepare("SELECT invalidated_at FROM video_plan_snapshots WHERE id='plan_fixture'").get()?.invalidated_at, 31);
    assert.equal(connection.database.prepare("SELECT invalidated_at FROM video_tts_snapshots WHERE id='tts_fixture'").get()?.invalidated_at, 31);
    for (const id of ["job_plan_fixture", "job_image_fixture", "job_tts_fixture"]) {
      assert.equal(connection.database.prepare("SELECT status FROM jobs WHERE id=?").get(id)?.status, "cancelled");
    }
    assert.equal(connection.database.prepare("SELECT status FROM video_image_batch_items WHERE job_id='job_image_fixture'").get()?.status, "cancelled");
    assert.equal(connection.database.prepare(
      "SELECT COUNT(*) AS count FROM video_douyin_analysis_selection_events WHERE event_type='confirm_rights'",
    ).get()?.count, 1);
    assert.throws(() => connection.database.prepare("UPDATE video_douyin_analysis_selection_events SET event_type='accept_partial'").run(), /append-only/u);

    connection.close();
    connection = openDatabase(dataRoot);
    assert.equal(getCurrentDouyinAnalysisSnapshot(connection.database, project.id, video.id)?.status, "succeeded");
    assert.deepEqual(getDouyinAnalysisSelection(connection.database, project.id, video.id), {
      videoId: video.id, snapshotId: completed.id, usageRole: "content_source", creativeAngle: "独立重组",
      rightsConfirmed: true, updatedAt: 31,
    });
    assert.equal(connection.database.prepare("PRAGMA foreign_key_check").all().length, 0);
    connection.close();
  } finally {
    await rm(dataRoot, { recursive: true, force: true });
  }
});
