import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import Fastify from "fastify";

import { putGlobalPromptSettings, putProjectSettings, putVideoInput } from "./creative-input-store.js";
import { openDatabase } from "./database.js";
import { JobWorker } from "./job-worker.js";
import { createProject, createVideo } from "./project-video-store.js";
import { approveVideoAudio } from "./video-audio-review.js";
import { requireVideoImagePermit } from "./video-image-store.js";
import { createVideoTtsJob } from "./video-tts-store.js";
import { createVideoVisualTimeline, updateVideoVisualSegment } from "./video-visual-timeline.js";
import { getVideoVisualReview, saveVideoVisualReview } from "./video-visual-review.js";
import { registerVideoVisualReviewRoutes } from "./video-visual-review-routes.js";
import {
  approveVideoPlan, createVideoPlanJobHandler, enqueueVideoPlanJob, getVideoPlan, VIDEO_PLAN_JOB_TYPE,
} from "./video-plan-service.js";

const H = ["1", "2", "3", "4", "5"].map((value) => value.repeat(64));

async function fixture() {
  const dataRoot = await mkdtemp(join(tmpdir(), "yingshu-visual-review-"));
  const connection = openDatabase(dataRoot);
  const project = createProject(connection.database, { name: "整片审核" }, 1);
  const video = createVideo(connection.database, project.id, { title: "蓝天" }, 2);
  putGlobalPromptSettings(connection.database, { scriptInstructions: "简洁", visualInstructions: "竖屏" }, 3);
  putProjectSettings(connection.database, project.id, { scriptInstructions: "科普", visualInstructions: "插画" }, 4);
  putVideoInput(connection.database, project.id, video.id, { inputMode: "topic", topic: "蓝天", body: "",
    referenceText: "", referenceRole: "style_only", targetDurationSeconds: 60, visualDensity: "standard",
    webEnabled: false, scriptInstructions: "", visualInstructions: "" }, 5);
  enqueueVideoPlanJob(connection.database, { projectId: project.id, videoId: video.id, idempotencyKey: "plan",
    config: { baseUrl: "https://example.invalid", apiKey: "secret", model: "fixture", providerId: "fixture" }, now: 6 });
  const narration = "蓝光在空气中散射，因此晴朗天空通常呈现蓝色。".repeat(12);
  const handler = createVideoPlanJobHandler(connection.database,
    { baseUrl: "https://example.invalid", apiKey: "secret", model: "fixture", providerId: "fixture" },
    async ({ stage, prompt }) => stage === "script"
      ? { title: "蓝天", summary: "散射", narration, paragraphs: [{ text: narration }], sourceSummary: [], risks: [] }
      : { visuals: [{ paragraphId: prompt.match(/paragraph_[0-9a-f]{20}/u)![0], purpose: "解释",
        description: "蓝光散射", prompt: "blue sky", negativePrompt: "text", suggestedDurationSeconds: 60, weight: 1 }] });
  await new JobWorker(connection.database, { [VIDEO_PLAN_JOB_TYPE]: handler },
    { workerId: "review-plan", leaseMs: 5_000, heartbeatMs: 100 }).runOne();
  let plan = getVideoPlan(connection.database, project.id, video.id)!;
  plan = approveVideoPlan(connection.database, project.id, video.id, { snapshotId: plan.snapshotId,
    scriptRevisionId: plan.script.id, visualRevisionId: plan.visual.id }, 7)!;

  const visual = plan.visual.visuals[0]!;
  const permit = requireVideoImagePermit(connection.database, project.id, video.id, visual.id)[0]!;
  const promptHash = permit.promptHash;
  connection.database.prepare(
    `INSERT INTO video_image_candidates
     (id,project_id,video_id,plan_snapshot_id,plan_snapshot_hash,script_revision_id,script_content_hash,
      visual_revision_id,visual_content_hash,visual_id,prompt,negative_prompt,style_snapshot_json,prompt_hash,
      provider_id,model_id,params_json,request_identity,job_id,attempt,checkpoint_scope,provider_request_id,status,
      error_category,error_summary,origin,original_file_name,relative_path,mime,bytes,width,height,file_hash,created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run("candidate", project.id, video.id, plan.snapshotId, plan.snapshotHash, plan.script.id, plan.script.contentHash,
    plan.visual.id, plan.visual.contentHash, visual.id, visual.prompt, visual.negativePrompt,
    JSON.stringify(permit.styleSnapshot), promptHash,
    null, null, "{}", "upload-review", null, 1, "upload", null, "succeeded", null, null, "upload", "sky.png",
    "asset-candidates/sky.png", "image/png", 100, 1080, 1920, H[0]!, 8);
  connection.database.prepare(
    `INSERT INTO video_image_approval_events
     (id,project_id,video_id,gate_revision,visual_id,candidate_id,plan_snapshot_id,plan_snapshot_hash,
      script_revision_id,script_content_hash,visual_revision_id,visual_content_hash,prompt_hash,candidate_hash,created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run("approval", project.id, video.id, 1, visual.id, "candidate", plan.snapshotId, plan.snapshotHash,
    plan.script.id, plan.script.contentHash, plan.visual.id, plan.visual.contentHash, promptHash, H[0]!, 9);

  const tts = createVideoTtsJob(connection.database, project.id, video.id, { providerId: "fixture",
    providerName: "本地夹具", providerKind: "edge-tts", protocol: "openai-response", baseUrl: "", modelId: "wav",
    voiceId: "zh-CN", rate: 0, language: "zh-CN" }, 10);
  const cue = { index: 0, paragraphId: plan.script.paragraphs[0]!.id, text: narration, startMs: 0, endMs: 60_000, hash: H[1]! };
  const cuesHash = createHash("sha256").update(JSON.stringify([cue])).digest("hex");
  connection.database.prepare(
    `INSERT INTO video_tts_artifacts
     (id,project_id,video_id,snapshot_id,snapshot_hash,job_id,provider_request_id,audio_relative_path,audio_mime,
      audio_codec,sample_rate,channels,audio_bytes,duration_ms,audio_hash,cues_hash,srt_relative_path,srt_bytes,srt_hash,
      ass_relative_path,ass_bytes,ass_hash,created_at)
     VALUES (?,?,?,?,?,?,NULL,?,'audio/wav','pcm_s16le',24000,1,100,60000,?,?,?,100,?,?,100,?,?)`,
  ).run("artifact", project.id, video.id, tts.snapshot.id, tts.snapshot.snapshotHash, tts.job!.id,
    "tts/audio.wav", H[2]!, cuesHash, "tts/subtitles.srt", H[3]!, "tts/subtitles.ass", H[4]!, 11);
  connection.database.prepare(
    "INSERT INTO video_tts_cues (artifact_id,video_id,cue_index,paragraph_id,text,start_ms,end_ms,cue_hash) VALUES (?,?,?,?,?,?,?,?)",
  ).run("artifact", video.id, 0, cue.paragraphId, narration, 0, 60_000, cue.hash);
  approveVideoAudio(connection.database, project.id, video.id, { snapshotId: tts.snapshot.id, artifactId: "artifact",
    confirmedFullPlayback: true, durationDecision: "within_target" }, 12);
  const timeline = createVideoVisualTimeline(connection.database, project.id, video.id, 13);
  return { dataRoot, connection, project, video, timeline };
}

test("整片顺序预览绑定真实候选 URL，审核追加写且时间轴变化后旧批准失效", async () => {
  const value = await fixture();
  try {
    const expected = { timelineId: value.timeline.id, timelineRevision: value.timeline.revision,
      timelineHash: value.timeline.timelineHash, identityHash: value.timeline.identityHash };
    const before = getVideoVisualReview(value.connection.database, value.project.id, value.video.id);
    assert.equal(before.preview[0]?.previewUrl.includes("/image-candidates/candidate/preview"), true);
    assert.match(before.preview[0]?.narrationSummary ?? "", /蓝光/u);
    assert.deepEqual(before.validationIssues, []);
    assert.throws(() => saveVideoVisualReview(value.connection.database, value.project.id, value.video.id,
      { ...expected, action: "needs_changes" }), /说明需要修改/u);
    const approved = saveVideoVisualReview(value.connection.database, value.project.id, value.video.id,
      { ...expected, action: "approve" }, 14);
    assert.equal(approved.reviewGate.complete, true);
    saveVideoVisualReview(value.connection.database, value.project.id, value.video.id,
      { ...expected, action: "approve" }, 15);
    assert.equal(value.connection.database.prepare("SELECT COUNT(*) AS count FROM video_visual_review_events")
      .get()!.count, 1);
    const changed = updateVideoVisualSegment(value.connection.database, value.project.id, value.video.id,
      value.timeline.id, 0, { motionKind: "still", motionAmountPpm: 0, fadeInMs: 0, fadeOutMs: 0 }, 16);
    const stale = getVideoVisualReview(value.connection.database, value.project.id, value.video.id);
    assert.equal(stale.timeline?.id, changed.id);
    assert.equal(stale.reviewGate.complete, false);
    assert.equal(stale.hasStaleReview, true);
    assert.throws(() => saveVideoVisualReview(value.connection.database, value.project.id, value.video.id,
      { ...expected, action: "approve" }), /已变化/u);
    assert.throws(() => value.connection.database.prepare("DELETE FROM video_visual_review_events").run(), /append-only/u);
  } finally { value.connection.close(); await rm(value.dataRoot, { recursive: true, force: true }); }
});

test("视觉审核路由拒绝跨项目读取", async () => {
  const value = await fixture();
  const other = createProject(value.connection.database, { name: "其他项目" }, 20);
  const app = Fastify();
  await registerVideoVisualReviewRoutes(app, { database: value.connection.database });
  try {
    const response = await app.inject({ method: "GET",
      url: `/api/projects/${other.id}/videos/${value.video.id}/visual-review` });
    assert.equal(response.statusCode, 404);
  } finally { await app.close(); value.connection.close(); await rm(value.dataRoot, { recursive: true, force: true }); }
});
