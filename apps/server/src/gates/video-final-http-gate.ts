import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { buildApp } from "../app.js";
import { putGlobalPromptSettings, putProjectSettings, putVideoInput } from "../creative-input-store.js";
import { openDatabase } from "../database.js";
import { JobWorker } from "../job-worker.js";
import { createProject, createVideo } from "../project-video-store.js";
import { renderSubtitleFiles } from "../subtitle-timeline.js";
import { approveVideoAudio } from "../video-audio-review.js";
import { approveVideoImageCandidate, uploadVideoImageCandidate } from "../video-image-store.js";
import { VIDEO_PLAN_JOB_TYPE } from "../video-plan-contract.js";
import {
  approveVideoPlan, createVideoPlanJobHandler, enqueueVideoPlanJob, getVideoPlan,
} from "../video-plan-service.js";
import { createVideoTtsJob } from "../video-tts-store.js";

const dataRoot = process.env.YINGSHU_DATA_DIR;
if (!dataRoot) throw new Error("必须通过 YINGSHU_DATA_DIR 指定系统 Temp 验收目录");
const baseUrl = "http://127.0.0.1:3102";
const hash = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");

async function seed() {
  const connection = openDatabase(dataRoot!);
  const db = connection.database;
  const project = createProject(db, { name: "第五阶段真实成片验收" }, 10);
  const video = createVideo(db, project.id, { title: "为什么天空是蓝色的" }, 20);
  putGlobalPromptSettings(db, { scriptInstructions: "事实准确、口语清晰", visualInstructions: "竖屏科普插画" }, 30);
  putProjectSettings(db, project.id, { scriptInstructions: "先结论后解释", visualInstructions: "蓝色简洁背景" }, 40);
  putVideoInput(db, project.id, video.id, { inputMode: "topic", topic: "为什么天空是蓝色的", body: "", referenceText: "",
    referenceRole: "style_only", targetDurationSeconds: 60, visualDensity: "standard", webEnabled: false,
    scriptInstructions: "", visualInstructions: "" }, 50);
  const config = { baseUrl: "https://example.invalid", apiKey: "http-gate-secret", model: "fixture", providerId: "fixture" };
  enqueueVideoPlanJob(db, { projectId: project.id, videoId: video.id, idempotencyKey: "http-final-plan", config, now: 60 });
  const narration = "阳光进入大气后，波长较短的蓝光更容易被空气分子散射，所以晴朗天空通常呈现蓝色。".repeat(8);
  const handler = createVideoPlanJobHandler(db, config, async ({ stage, prompt }) => stage === "script"
    ? { title: video.title, summary: "解释瑞利散射", narration, paragraphs: [{ text: narration }], sourceSummary: [], risks: [] }
    : { visuals: ["天空全景", "空气分子"].map((name) => ({ paragraphId: prompt.match(/paragraph_[0-9a-f]{20}/u)![0],
      purpose: "解释", description: name, prompt: `blue educational ${name}`, negativePrompt: "text",
      suggestedDurationSeconds: 30, weight: 1 })) });
  await new JobWorker(db, { [VIDEO_PLAN_JOB_TYPE]: handler },
    { workerId: "http-final-plan", leaseMs: 5_000, heartbeatMs: 100 }).runOne();
  let plan = getVideoPlan(db, project.id, video.id)!;
  plan = approveVideoPlan(db, project.id, video.id, { snapshotId: plan.snapshotId,
    scriptRevisionId: plan.script.id, visualRevisionId: plan.visual.id }, 70)!;

  const pngPath = join(dataRoot!, "fixture.png");
  const png = spawnSync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "color=c=0x4388cc:s=96x96",
    "-frames:v", "1", "-c:v", "png", "-y", pngPath], { windowsHide: true, encoding: "utf8" });
  assert.equal(png.status, 0, png.stderr);
  for (const [index, visual] of plan.visual.visuals.entries()) {
    const candidate = await uploadVideoImageCandidate(db, dataRoot!, { projectId: project.id, videoId: video.id,
      visualId: visual.id, originalFileName: "fixture.png", raw: createReadStream(pngPath) });
    approveVideoImageCandidate(db, dataRoot!, { projectId: project.id, videoId: video.id, visualId: visual.id,
      candidateId: candidate.id, expectedGateRevision: index, now: 80 + index });
  }

  const tts = createVideoTtsJob(db, project.id, video.id, { providerId: "fixture", providerName: "本地验收夹具",
    providerKind: "edge-tts", protocol: "openai-response", baseUrl: "", modelId: "fixture-wav", voiceId: "zh-CN",
    rate: 0, language: "zh-CN" }, 90);
  const mediaDirectory = join(dataRoot!, "videos", video.id, "tts");
  await mkdir(mediaDirectory, { recursive: true });
  const audioRelative = `videos/${video.id}/tts/final-http.wav`;
  const audioPath = join(dataRoot!, audioRelative);
  const wav = spawnSync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "sine=frequency=440:duration=3",
    "-ar", "24000", "-ac", "1", "-c:a", "pcm_s16le", "-y", audioPath], { windowsHide: true, encoding: "utf8" });
  assert.equal(wav.status, 0, wav.stderr);
  const audio = await readFile(audioPath);
  const cue = { index: 0, paragraphId: plan.script.paragraphs[0]!.id, text: narration,
    startMs: 0, endMs: 3_000, hash: hash("http-final-cue") };
  const subtitles = renderSubtitleFiles([cue]);
  const srtRelative = `videos/${video.id}/tts/final-http.srt`;
  const assRelative = `videos/${video.id}/tts/final-http.ass`;
  await writeFile(join(dataRoot!, srtRelative), subtitles.srt);
  await writeFile(join(dataRoot!, assRelative), subtitles.ass);
  db.prepare(
    `INSERT INTO video_tts_artifacts (id,project_id,video_id,snapshot_id,snapshot_hash,job_id,provider_request_id,
     audio_relative_path,audio_mime,audio_codec,sample_rate,channels,audio_bytes,duration_ms,audio_hash,cues_hash,
     srt_relative_path,srt_bytes,srt_hash,ass_relative_path,ass_bytes,ass_hash,created_at)
     VALUES ('artifact_http_final',?,?,?,?,?,NULL,?,'audio/wav','pcm_s16le',24000,1,?,3000,?,?, ?,?,?, ?,?,?,?)`,
  ).run(project.id, video.id, tts.snapshot.id, tts.snapshot.snapshotHash, tts.job!.id, audioRelative,
    audio.length, hash(audio), hash(JSON.stringify([cue])), srtRelative, Buffer.byteLength(subtitles.srt), hash(subtitles.srt),
    assRelative, Buffer.byteLength(subtitles.ass), hash(subtitles.ass), 100);
  db.prepare(
    "INSERT INTO video_tts_cues (artifact_id,video_id,cue_index,paragraph_id,text,start_ms,end_ms,cue_hash) VALUES (?,?,?,?,?,?,?,?)",
  ).run("artifact_http_final", video.id, cue.index, cue.paragraphId, cue.text, cue.startMs, cue.endMs, cue.hash);
  db.prepare("UPDATE jobs SET status='succeeded',progress=1,result_json='{}',finished_at=105,updated_at=105 WHERE id=?")
    .run(tts.job!.id);
  approveVideoAudio(db, project.id, video.id, { snapshotId: tts.snapshot.id, artifactId: "artifact_http_final",
    confirmedFullPlayback: true, durationDecision: "accept_actual" }, 110);
  connection.close();
  return { projectId: project.id, videoId: video.id };
}

async function json(method: string, path: string, body?: unknown) {
  const response = await fetch(`${baseUrl}${path}`, {
    method, headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const value = await response.json() as any;
  assert.equal(response.ok, true, `${method} ${path}: ${response.status} ${JSON.stringify(value)}`);
  return value;
}

async function waitCompleted(path: string) {
  for (let attempt = 0; attempt < 1_200; attempt += 1) {
    const value = await json("GET", `${path}/renders`);
    if (value.render?.status === "succeeded") return value;
    if (value.render?.status === "failed") throw new Error(value.render.errorMessage ?? "最终渲染失败");
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("等待最终视频渲染超时");
}

const ids = await seed();
const api = `/api/projects/${ids.projectId}/videos/${ids.videoId}`;
// Gate 先固定验证 queued cancel，避免把运行中 ffmpeg 中断与同身份 retry 混成一个不可重复竞态。
let app = buildApp({ dataRoot, logger: false, jobPollMs: 1_000 });
await app.listen({ host: "127.0.0.1", port: 3102 });
try {
  const created = await json("POST", `${api}/visual-timelines`, {});
  const timeline = created.workspace.timeline;
  assert.equal(timeline.segments.length, 2);
  await json("POST", `${api}/visual-review`, { timelineId: timeline.id, timelineRevision: timeline.revision,
    timelineHash: timeline.timelineHash, identityHash: timeline.identityHash, action: "approve", notes: "HTTP 整片审核通过" });

  const first = await json("POST", `${api}/renders`, {});
  const duplicate = await json("POST", `${api}/renders`, {});
  assert.equal(duplicate.render.id, first.render.id);
  const cancelled = await json("POST", `${api}/renders/${first.render.id}/cancel`, {});
  assert.equal(["running", "cancelled"].includes(cancelled.render.status), true);
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const current = await json("GET", `${api}/renders`);
    if (current.render.status === "cancelled") break;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  const retry = await json("POST", `${api}/renders`, {});
  assert.equal(retry.render.id, first.render.id);
  assert.notEqual(retry.render.jobId, first.render.jobId);
  const completed = await waitCompleted(api);
  assert.equal(completed.render.chunks.succeeded, 2);

  const range = await fetch(`${baseUrl}${api}/final-video`, { headers: { range: "bytes=0-127" } });
  assert.equal(range.status, 206);
  assert.equal((await range.arrayBuffer()).byteLength, 128);
  assert.match(range.headers.get("content-range") ?? "", /^bytes 0-127\//u);
  const download = await fetch(`${baseUrl}${api}/final-video/download`, { headers: { range: "bytes=-64" } });
  assert.equal(download.status, 206);
  assert.equal((await download.arrayBuffer()).byteLength, 64);
  assert.match(download.headers.get("content-disposition") ?? "", /^attachment;/u);

  await app.close();
  app = buildApp({ dataRoot, logger: false, jobPollMs: 1_000 });
  await app.listen({ host: "127.0.0.1", port: 3102 });
  const restored = await json("GET", `${api}/renders`);
  assert.equal(restored.render.status, "succeeded");
  const restoredRange = await fetch(`${baseUrl}${api}/final-video`, { headers: { range: "bytes=128-255" } });
  assert.equal(restoredRange.status, 206);
  assert.equal((await restoredRange.arrayBuffer()).byteLength, 128);
  const result = {
    ok: true, dataRoot, baseUrl, ...ids, renderId: restored.render.id, jobId: restored.render.jobId,
    final: restored.render.final, checks: {
      timelineCreate: true, visualReview: true, renderIdempotent: true, cancel: true, retry: true,
      completed: true, range: true, download: true, restart: true,
    },
  };
  await writeFile(join(dataRoot, "acceptance.json"), `${JSON.stringify(result, null, 2)}\n`);
  process.stdout.write(`YINGSHU_HTTP_READY ${JSON.stringify(result)}\n`);
} catch (error) {
  await app.close().catch(() => undefined);
  throw error;
}
