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
import {
  approveVideoPlan, createVideoPlanJobHandler, enqueueVideoPlanJob, getVideoPlan, saveVideoScriptRevision,
  VIDEO_PLAN_JOB_TYPE,
} from "./video-plan-service.js";
import { approveVideoAudio, getVideoAudioReview, saveVideoAudioReview } from "./video-audio-review.js";
import { createVideoTtsJob } from "./video-tts-store.js";
import { registerVideoTtsRoutes } from "./video-tts-routes.js";

const HASHES = ["1", "2", "3", "4", "5"].map((value) => value.repeat(64));

async function fixture(durationMs: number) {
  const dataRoot = await mkdtemp(join(tmpdir(), "yingshu-audio-review-"));
  const connection = openDatabase(dataRoot);
  const project = createProject(connection.database, { name: "听音测试" }, 10);
  const video = createVideo(connection.database, project.id, { title: "配音" }, 20);
  putGlobalPromptSettings(connection.database, { scriptInstructions: "简洁", visualInstructions: "竖屏" }, 30);
  putProjectSettings(connection.database, project.id, { scriptInstructions: "科普", visualInstructions: "插画" }, 40);
  putVideoInput(connection.database, project.id, video.id, { inputMode: "topic", topic: "蓝天", body: "", referenceText: "平实科普",
    referenceRole: "style_only", targetDurationSeconds: 60, visualDensity: "standard", webEnabled: false,
    scriptInstructions: "", visualInstructions: "" }, 50);
  enqueueVideoPlanJob(connection.database, { projectId: project.id, videoId: video.id, idempotencyKey: "plan",
    config: { baseUrl: "https://example.invalid", apiKey: "secret", model: "fixture", providerId: "fixture" }, now: 60 });
  const narration = "蓝光在空气分子中更容易散射，所以晴朗天空通常呈现蓝色。".repeat(12);
  const handler = createVideoPlanJobHandler(connection.database,
    { baseUrl: "https://example.invalid", apiKey: "secret", model: "fixture", providerId: "fixture" },
    async ({ stage, prompt }) => stage === "script"
      ? { title: "蓝天", summary: "散射", narration, paragraphs: [{ text: narration }], sourceSummary: [], risks: [] }
      : { visuals: [{ paragraphId: prompt.match(/paragraph_[0-9a-f]{20}/u)![0], purpose: "解释",
        description: "蓝光散射", prompt: "blue light", negativePrompt: "text", suggestedDurationSeconds: 60, weight: 1 }] });
  await new JobWorker(connection.database, { [VIDEO_PLAN_JOB_TYPE]: handler },
    { workerId: "plan", leaseMs: 5_000, heartbeatMs: 100 }).runOne();
  let plan = getVideoPlan(connection.database, project.id, video.id)!;
  plan = approveVideoPlan(connection.database, project.id, video.id, { snapshotId: plan.snapshotId,
    scriptRevisionId: plan.script.id, visualRevisionId: plan.visual.id }, 70)!;
  const tts = createVideoTtsJob(connection.database, project.id, video.id, { providerId: "fixture", providerName: "本地夹具",
    providerKind: "edge-tts", protocol: "openai-response", baseUrl: "", modelId: "fixture-wav", voiceId: "zh-CN",
    rate: 0, language: "zh-CN" }, 80);
  const artifactId = "artifact_review";
  const cue = { index: 0, paragraphId: plan.script.paragraphs[0]!.id, text: narration,
    startMs: 0, endMs: durationMs, hash: HASHES[4]! };
  const cuesHash = createHash("sha256").update(JSON.stringify([cue])).digest("hex");
  connection.database.prepare(
    `INSERT INTO video_tts_artifacts (id,project_id,video_id,snapshot_id,snapshot_hash,job_id,provider_request_id,
     audio_relative_path,audio_mime,audio_codec,sample_rate,channels,audio_bytes,duration_ms,audio_hash,cues_hash,
     srt_relative_path,srt_bytes,srt_hash,ass_relative_path,ass_bytes,ass_hash,created_at)
     VALUES (?,?,?,?,?,?,NULL,?,'audio/wav','pcm_s16le',24000,1,1024,?,?,?,?,100,?,?,100,?,?)`,
  ).run(artifactId, project.id, video.id, tts.snapshot.id, tts.snapshot.snapshotHash, tts.job!.id,
    "tts/audio.wav", durationMs, HASHES[0]!, cuesHash, "tts/subtitles.srt", HASHES[2]!, "tts/subtitles.ass", HASHES[3]!, 90);
  connection.database.prepare(
    "INSERT INTO video_tts_cues (artifact_id,video_id,cue_index,paragraph_id,text,start_ms,end_ms,cue_hash) VALUES (?,?,?,?,?,?,?,?)",
  ).run(artifactId, video.id, cue.index, cue.paragraphId, cue.text, cue.startMs, cue.endMs, cue.hash);
  return { dataRoot, connection, project, video, plan, snapshotId: tts.snapshot.id, artifactId };
}

test("听音批准绑定完整音频身份，且 stale 后 audio gate 立即失效", async () => {
  const value = await fixture(61_000);
  try {
    const body = { snapshotId: value.snapshotId, artifactId: value.artifactId, confirmedFullPlayback: true,
      durationDecision: "within_target" };
    assert.throws(() => approveVideoAudio(value.connection.database, value.project.id, value.video.id,
      { ...body, confirmedFullPlayback: false }), /完整试听/u);
    assert.throws(() => approveVideoAudio(value.connection.database, value.project.id, value.video.id,
      { ...body, durationDecision: "accept_actual" }), /正常时长决策/u);
    const approved = approveVideoAudio(value.connection.database, value.project.id, value.video.id, body, 100);
    assert.equal(approved.audioGate.complete, true);
    assert.equal(approved.latestReview?.revision, 1);
    saveVideoAudioReview(value.connection.database, value.project.id, value.video.id, {
      snapshotId: value.snapshotId, artifactId: value.artifactId, action: "needs_regeneration",
      durationDecision: "reprocess", notes: "专名读音需要调整",
    }, 110);
    assert.equal(getVideoAudioReview(value.connection.database, value.project.id, value.video.id).audioGate.complete, false);
    approveVideoAudio(value.connection.database, value.project.id, value.video.id, body, 120);
    saveVideoScriptRevision(value.connection.database, value.project.id, value.video.id, {
      snapshotId: value.plan.snapshotId, baseRevision: value.plan.script.revision, title: value.plan.script.title,
      summary: value.plan.script.summary, paragraphs: value.plan.script.paragraphs.map((item) => ({ ...item, text: `${item.text}补充。` })),
    }, 130);
    assert.equal(getVideoAudioReview(value.connection.database, value.project.id, value.video.id).stale, true);
    assert.equal(getVideoAudioReview(value.connection.database, value.project.id, value.video.id).audioGate.complete, false);
    assert.throws(() => approveVideoAudio(value.connection.database, value.project.id, value.video.id, body), /失效/u);
    assert.throws(() => value.connection.database.prepare("UPDATE video_audio_review_events SET notes='改写' WHERE video_id=?")
      .run(value.video.id), /append-only/u);
  } finally { value.connection.close(); await rm(value.dataRoot, { recursive: true, force: true }); }
});

test("真实时长偏差超过 10% 时必须显式接受实际时长", async () => {
  const value = await fixture(45_000);
  try {
    const input = { snapshotId: value.snapshotId, artifactId: value.artifactId, confirmedFullPlayback: true };
    assert.throws(() => approveVideoAudio(value.connection.database, value.project.id, value.video.id,
      { ...input, durationDecision: "within_target" }), /超过 10%/u);
    const approved = approveVideoAudio(value.connection.database, value.project.id, value.video.id,
      { ...input, durationDecision: "accept_actual", notes: "接受 45 秒实际时长" }, 100);
    assert.equal(approved.audioGate.complete, true);
    assert.equal(approved.latestReview?.durationDecision, "accept_actual");
    assert.equal(approved.deviationRatio, 0.25);
  } finally { value.connection.close(); await rm(value.dataRoot, { recursive: true, force: true }); }
});

test("TTS 路由严格校验项目、视频与 Job 归属后才允许取消", async () => {
  const value = await fixture(60_000);
  const app = Fastify();
  const provider = {
    providerId: "fixture", providerName: "fixture", providerKind: "edge-tts", protocol: "openai-response",
    baseUrl: "", modelId: "fixture", voiceId: "zh-CN", rate: 0, language: "zh-CN",
  } as const;
  await registerVideoTtsRoutes(app, { database: value.connection.database, dataRoot: value.dataRoot,
    resolveDefaultProvider: async () => provider, resolveProvider: async () => provider });
  try {
    const state = getVideoAudioReview(value.connection.database, value.project.id, value.video.id);
    const ok = await app.inject({ method: "GET", url: `/api/projects/${value.project.id}/videos/${value.video.id}/audio-review` });
    assert.equal(ok.statusCode, 200);
    assert.equal(ok.json().review.artifact.id, state.artifact!.id);
    const other = createProject(value.connection.database, { name: "其他项目" }, 200);
    const crossed = await app.inject({ method: "GET", url: `/api/projects/${other.id}/videos/${value.video.id}/audio-review` });
    assert.equal(crossed.statusCode, 404);
    const wrong = await app.inject({ method: "POST",
      url: `/api/projects/${value.project.id}/videos/${value.video.id}/tts-jobs/not_the_job/cancel` });
    assert.equal(wrong.statusCode, 404);
    const jobId = value.connection.database.prepare("SELECT job_id FROM video_tts_jobs WHERE snapshot_id=?")
      .get(value.snapshotId)!.job_id as string;
    const cancelled = await app.inject({ method: "POST",
      url: `/api/projects/${value.project.id}/videos/${value.video.id}/tts-jobs/${jobId}/cancel` });
    assert.equal(cancelled.statusCode, 200);
    assert.equal(cancelled.json().job.status, "cancelled");
  } finally { await app.close(); value.connection.close(); await rm(value.dataRoot, { recursive: true, force: true }); }
});
