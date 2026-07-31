import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
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
import { approveVideoImageCandidate, uploadVideoImageCandidate } from "./video-image-store.js";
import { VIDEO_PLAN_JOB_TYPE } from "./video-plan-contract.js";
import {
  approveVideoPlan, createVideoPlanJobHandler, enqueueVideoPlanJob, getVideoPlan, saveVideoVisualRevision,
} from "./video-plan-service.js";
import { createVideoTtsJob } from "./video-tts-store.js";
import { registerVideoVisualTimelineRoutes } from "./video-visual-timeline-routes.js";
import {
  assertCurrentVideoVisualTimelineReady, createVideoVisualTimeline, getCurrentVideoVisualTimeline,
  updateVideoVisualSegment,
} from "./video-visual-timeline.js";

async function fixture() {
  const dataRoot = await mkdtemp(join(tmpdir(), "yingshu-visual-timeline-"));
  const connection = openDatabase(dataRoot);
  const project = createProject(connection.database, { name: "时间轴测试" }, 10);
  const video = createVideo(connection.database, project.id, { title: "蓝天" }, 20);
  putGlobalPromptSettings(connection.database, { scriptInstructions: "简洁", visualInstructions: "竖屏" }, 30);
  putProjectSettings(connection.database, project.id, { scriptInstructions: "科普", visualInstructions: "插画" }, 40);
  putVideoInput(connection.database, project.id, video.id, { inputMode: "topic", topic: "蓝天", body: "", referenceText: "",
    referenceRole: "style_only", targetDurationSeconds: 60, visualDensity: "standard", webEnabled: false,
    scriptInstructions: "", visualInstructions: "" }, 50);
  enqueueVideoPlanJob(connection.database, { projectId: project.id, videoId: video.id, idempotencyKey: "timeline-plan",
    config: { baseUrl: "https://example.invalid", apiKey: "secret", model: "fixture", providerId: "fixture" }, now: 60 });
  const narration = "蓝光在空气分子中更容易散射，所以晴朗天空通常呈现蓝色。".repeat(12);
  const handler = createVideoPlanJobHandler(connection.database,
    { baseUrl: "https://example.invalid", apiKey: "secret", model: "fixture", providerId: "fixture" },
    async ({ stage, prompt }) => stage === "script"
      ? { title: "蓝天", summary: "散射", narration, paragraphs: [{ text: narration }], sourceSummary: [], risks: [] }
      : { visuals: [{ paragraphId: prompt.match(/paragraph_[0-9a-f]{20}/u)![0], purpose: "解释",
        description: "蓝光散射", prompt: "blue sky", negativePrompt: "text", suggestedDurationSeconds: 60, weight: 1 }] });
  await new JobWorker(connection.database, { [VIDEO_PLAN_JOB_TYPE]: handler },
    { workerId: "timeline-plan", leaseMs: 5_000, heartbeatMs: 100 }).runOne();
  let plan = getVideoPlan(connection.database, project.id, video.id)!;
  plan = approveVideoPlan(connection.database, project.id, video.id, { snapshotId: plan.snapshotId,
    scriptRevisionId: plan.script.id, visualRevisionId: plan.visual.id }, 70)!;
  const visualId = plan.visual.visuals[0]!.id;
  const pngPath = join(dataRoot, "blue.png");
  const png = spawnSync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "color=c=blue:s=32x24",
    "-frames:v", "1", "-c:v", "png", "-y", pngPath], { windowsHide: true, encoding: "utf8" });
  assert.equal(png.status, 0, png.stderr);
  const candidate = await uploadVideoImageCandidate(connection.database, dataRoot, {
    projectId: project.id, videoId: video.id, visualId, originalFileName: "blue.png",
    raw: createReadStream(pngPath),
  });
  approveVideoImageCandidate(connection.database, dataRoot, { projectId: project.id, videoId: video.id,
    visualId, candidateId: candidate.id, expectedGateRevision: 0, now: 80 });
  const tts = createVideoTtsJob(connection.database, project.id, video.id, { providerId: "fixture", providerName: "本地夹具",
    providerKind: "edge-tts", protocol: "openai-response", baseUrl: "", modelId: "fixture-wav", voiceId: "zh-CN",
    rate: 0, language: "zh-CN" }, 90);
  const cue = { index: 0, paragraphId: plan.script.paragraphs[0]!.id, text: narration,
    startMs: 0, endMs: 60_000, hash: "5".repeat(64) };
  const cuesHash = createHash("sha256").update(JSON.stringify([cue])).digest("hex");
  connection.database.prepare(
    `INSERT INTO video_tts_artifacts (id,project_id,video_id,snapshot_id,snapshot_hash,job_id,provider_request_id,
     audio_relative_path,audio_mime,audio_codec,sample_rate,channels,audio_bytes,duration_ms,audio_hash,cues_hash,
     srt_relative_path,srt_bytes,srt_hash,ass_relative_path,ass_bytes,ass_hash,created_at)
     VALUES ('artifact_timeline',?,?,?,?,?,NULL,'tts/audio.wav','audio/wav','pcm_s16le',24000,1,1024,60000,?,?,
       'tts/subtitles.srt',100,?,'tts/subtitles.ass',100,?,?)`,
  ).run(project.id, video.id, tts.snapshot.id, tts.snapshot.snapshotHash, tts.job!.id,
    "1".repeat(64), cuesHash, "2".repeat(64), "3".repeat(64), 100);
  connection.database.prepare(
    "INSERT INTO video_tts_cues (artifact_id,video_id,cue_index,paragraph_id,text,start_ms,end_ms,cue_hash) VALUES (?,?,?,?,?,?,?,?)",
  ).run("artifact_timeline", video.id, cue.index, cue.paragraphId, cue.text, cue.startMs, cue.endMs, cue.hash);
  approveVideoAudio(connection.database, project.id, video.id, { snapshotId: tts.snapshot.id,
    artifactId: "artifact_timeline", confirmedFullPlayback: true, durationDecision: "within_target" }, 110);
  return { dataRoot, connection, project, video, plan };
}

test("正式视觉时间轴连续、幂等，运镜编辑形成新 revision 并随上游变化失效", async () => {
  const value = await fixture();
  try {
    const first = createVideoVisualTimeline(value.connection.database, value.project.id, value.video.id, 120);
    assert.equal(first.segments[0]?.startMs, 0);
    assert.equal(first.segments.at(-1)?.endMs, 60_000);
    assert.equal(first.segments.every((segment, index) => index === 0 ||
      segment.startMs === first.segments[index - 1]!.endMs), true);
    const app = Fastify({ logger: false });
    await app.register(registerVideoVisualTimelineRoutes, { database: value.connection.database });
    const response = await app.inject({ method: "GET",
      url: `/api/projects/${value.project.id}/videos/${value.video.id}/visual-timelines` });
    await app.close();
    assert.deepEqual(response.json().workspace.gates.map((gate: { key: string; valid: boolean }) =>
      [gate.key, gate.valid]), [["script", true], ["image", true], ["audio", true]]);
    assert.equal(createVideoVisualTimeline(value.connection.database, value.project.id, value.video.id, 130).id, first.id);
    const edited = updateVideoVisualSegment(value.connection.database, value.project.id, value.video.id,
      first.id, 0, { motionKind: "still", motionAmountPpm: 0, fadeInMs: 300, fadeOutMs: 300 }, 140);
    assert.equal(edited.revision, first.revision + 1);
    assert.equal(edited.segments[0]?.stableSegmentId, first.segments[0]?.stableSegmentId);
    assert.equal(assertCurrentVideoVisualTimelineReady(value.connection.database, value.project.id, value.video.id).id, edited.id);
    saveVideoVisualRevision(value.connection.database, value.project.id, value.video.id, {
      snapshotId: value.plan.snapshotId, baseRevision: value.plan.visual.revision,
      scriptRevisionId: value.plan.script.id, visuals: value.plan.visual.visuals.map((visual) => ({
        ...visual, description: `${visual.description}（新版）`,
      })),
    }, 150);
    assert.equal(getCurrentVideoVisualTimeline(value.connection.database, value.project.id, value.video.id)?.stale, true);
    assert.throws(() => assertCurrentVideoVisualTimelineReady(value.connection.database, value.project.id, value.video.id), /失效/u);
  } finally { value.connection.close(); await rm(value.dataRoot, { recursive: true, force: true }); }
});

test("缺少图片或听音门禁时拒绝创建，跨项目视频归属也拒绝", async () => {
  const dataRoot = await mkdtemp(join(tmpdir(), "yingshu-visual-timeline-gates-"));
  const connection = openDatabase(dataRoot);
  try {
    const owner = createProject(connection.database, { name: "所属项目" }, 1);
    const other = createProject(connection.database, { name: "其他项目" }, 2);
    const video = createVideo(connection.database, owner.id, { title: "未准备" }, 3);
    assert.throws(() => createVideoVisualTimeline(connection.database, owner.id, video.id), /批准当前旁白/u);
    assert.throws(() => createVideoVisualTimeline(connection.database, other.id, video.id), /不存在/u);
  } finally { connection.close(); await rm(dataRoot, { recursive: true, force: true }); }
});
