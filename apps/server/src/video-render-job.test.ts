import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import Fastify from "fastify";

import { putGlobalPromptSettings, putProjectSettings, putVideoInput } from "./creative-input-store.js";
import { openDatabase } from "./database.js";
import { JobWorker } from "./job-worker.js";
import { createProject, createVideo } from "./project-video-store.js";
import { renderSubtitleFiles } from "./subtitle-timeline.js";
import { approveVideoAudio } from "./video-audio-review.js";
import { approveVideoImageCandidate, uploadVideoImageCandidate } from "./video-image-store.js";
import { VIDEO_PLAN_JOB_TYPE } from "./video-plan-contract.js";
import {
  approveVideoPlan, createVideoPlanJobHandler, enqueueVideoPlanJob, getVideoPlan,
} from "./video-plan-service.js";
import { createVideoRenderJobHandler } from "./video-render-job.js";
import { registerVideoRenderRoutes } from "./video-render-routes.js";
import {
  enqueueVideoRender, getVideoRenderWorkspace, openCurrentFinalVideo, VIDEO_RENDER_JOB_TYPE,
} from "./video-render-store.js";
import { createVideoTtsJob } from "./video-tts-store.js";
import { saveVideoVisualReview } from "./video-visual-review.js";
import { createVideoVisualTimeline, updateVideoVisualSegment } from "./video-visual-timeline.js";

const hash = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");

test("真实 Video 分片可恢复渲染生成严格 MP4、清单并受控读取", { timeout: 120_000 }, async () => {
  const dataRoot = await mkdtemp(join(tmpdir(), "yingshu-video-render-"));
  const connection = openDatabase(dataRoot);
  try {
    const db = connection.database;
    const project = createProject(db, { name: "最终渲染" }, 10);
    const other = createProject(db, { name: "其他项目" }, 11);
    const video = createVideo(db, project.id, { title: "蓝天" }, 20);
    putGlobalPromptSettings(db, { scriptInstructions: "简洁", visualInstructions: "竖屏" }, 30);
    putProjectSettings(db, project.id, { scriptInstructions: "准确", visualInstructions: "插画" }, 40);
    putVideoInput(db, project.id, video.id, { inputMode: "topic", topic: "蓝天", body: "", referenceText: "",
      referenceRole: "style_only", targetDurationSeconds: 60, visualDensity: "standard", webEnabled: false,
      scriptInstructions: "", visualInstructions: "" }, 50);
    const config = { baseUrl: "https://example.invalid", apiKey: "secret-never-in-manifest", model: "fixture", providerId: "fixture" };
    enqueueVideoPlanJob(db, { projectId: project.id, videoId: video.id, idempotencyKey: "render-plan", config, now: 60 });
    const narration = "蓝光更容易被空气分子散射，所以晴朗天空通常呈现蓝色。".repeat(12);
    const planHandler = createVideoPlanJobHandler(db, config, async ({ stage, prompt }) => stage === "script"
      ? { title: "蓝天", summary: "散射", narration, paragraphs: [{ text: narration }], sourceSummary: [], risks: [] }
      : { visuals: ["天空", "分子"].map((name) => ({ paragraphId: prompt.match(/paragraph_[0-9a-f]{20}/u)![0], purpose: "解释",
        description: `${name}中的蓝光散射`, prompt: `blue sky ${name}`, negativePrompt: "text",
        suggestedDurationSeconds: 30, weight: 1 })) });
    await new JobWorker(db, { [VIDEO_PLAN_JOB_TYPE]: planHandler },
      { workerId: "render-plan", leaseMs: 5_000, heartbeatMs: 100 }).runOne();
    let plan = getVideoPlan(db, project.id, video.id)!;
    plan = approveVideoPlan(db, project.id, video.id, { snapshotId: plan.snapshotId,
      scriptRevisionId: plan.script.id, visualRevisionId: plan.visual.id }, 70)!;

    const pngPath = join(dataRoot, "fixture.png");
    const pngResult = spawnSync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "color=c=blue:s=64x64",
      "-frames:v", "1", "-c:v", "png", "-y", pngPath], { windowsHide: true, encoding: "utf8" });
    assert.equal(pngResult.status, 0, pngResult.stderr);
    for (const [index, visual] of plan.visual.visuals.entries()) {
      const candidate = await uploadVideoImageCandidate(db, dataRoot, { projectId: project.id, videoId: video.id,
        visualId: visual.id, originalFileName: "fixture.png", raw: createReadStream(pngPath) });
      approveVideoImageCandidate(db, dataRoot, { projectId: project.id, videoId: video.id, visualId: visual.id,
        candidateId: candidate.id, expectedGateRevision: index, now: 80 + index });
    }

    const tts = createVideoTtsJob(db, project.id, video.id, { providerId: "fixture", providerName: "本地夹具",
      providerKind: "edge-tts", protocol: "openai-response", baseUrl: "", modelId: "fixture-wav", voiceId: "zh-CN",
      rate: 0, language: "zh-CN" }, 90);
    const audioRelative = `videos/${video.id}/tts/fixture.wav`;
    const audioPath = join(dataRoot, audioRelative);
    await mkdir(dirname(audioPath), { recursive: true });
    const wavResult = spawnSync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "sine=frequency=440:duration=1",
      "-ar", "24000", "-ac", "1", "-c:a", "pcm_s16le", "-y", audioPath], { windowsHide: true, encoding: "utf8" });
    assert.equal(wavResult.status, 0, wavResult.stderr);
    const audio = await readFile(audioPath);
    const cue = { index: 0, paragraphId: plan.script.paragraphs[0]!.id, text: narration,
      startMs: 0, endMs: 1_000, hash: hash("render-cue") };
    const subtitles = renderSubtitleFiles([cue]);
    const srtRelative = `videos/${video.id}/tts/fixture.srt`;
    const assRelative = `videos/${video.id}/tts/fixture.ass`;
    await writeFile(join(dataRoot, srtRelative), subtitles.srt);
    await writeFile(join(dataRoot, assRelative), subtitles.ass);
    db.prepare(
      `INSERT INTO video_tts_artifacts (id,project_id,video_id,snapshot_id,snapshot_hash,job_id,provider_request_id,
       audio_relative_path,audio_mime,audio_codec,sample_rate,channels,audio_bytes,duration_ms,audio_hash,cues_hash,
       srt_relative_path,srt_bytes,srt_hash,ass_relative_path,ass_bytes,ass_hash,created_at)
       VALUES ('artifact_render',?,?,?,?,?,NULL,?,'audio/wav','pcm_s16le',24000,1,?,1000,?,?, ?,?,?, ?,?,?,?)`,
    ).run(project.id, video.id, tts.snapshot.id, tts.snapshot.snapshotHash, tts.job!.id, audioRelative,
      audio.length, hash(audio), hash(JSON.stringify([cue])), srtRelative, Buffer.byteLength(subtitles.srt), hash(subtitles.srt),
      assRelative, Buffer.byteLength(subtitles.ass), hash(subtitles.ass), 100);
    db.prepare(
      "INSERT INTO video_tts_cues (artifact_id,video_id,cue_index,paragraph_id,text,start_ms,end_ms,cue_hash) VALUES (?,?,?,?,?,?,?,?)",
    ).run("artifact_render", video.id, cue.index, cue.paragraphId, cue.text, cue.startMs, cue.endMs, cue.hash);
    approveVideoAudio(db, project.id, video.id, { snapshotId: tts.snapshot.id, artifactId: "artifact_render",
      confirmedFullPlayback: true, durationDecision: "accept_actual" }, 110);
    const timeline = createVideoVisualTimeline(db, project.id, video.id, 120);
    saveVideoVisualReview(db, project.id, video.id, { timelineId: timeline.id, timelineRevision: timeline.revision,
      timelineHash: timeline.timelineHash, identityHash: timeline.identityHash, action: "approve", notes: "真实渲染" }, 130);

    const started = enqueueVideoRender(db, project.id, video.id, 140);
    assert.equal(started.render?.status, "queued");
    assert.equal(enqueueVideoRender(db, project.id, video.id, 141).render?.jobId, started.render?.jobId, "同身份必须幂等");
    assert.throws(() => enqueueVideoRender(db, other.id, video.id), /不存在|不属于/u);
    await new JobWorker(db, { [VIDEO_RENDER_JOB_TYPE]: createVideoRenderJobHandler(db, dataRoot) },
      { workerId: "real-render", leaseMs: 30_000, heartbeatMs: 1_000 }).runOne();
    const completed = getVideoRenderWorkspace(db, project.id, video.id).render;
    assert.equal(completed?.status, "succeeded", completed?.errorMessage ?? "渲染失败");
    assert.equal(completed?.chunks.succeeded, 2);
    const oldChunkIdentities = (db.prepare(
      "SELECT identity_hash FROM video_render_chunks WHERE run_id=? ORDER BY chunk_index",
    ).all(completed!.id) as unknown as Array<{ identity_hash: string }>).map((row) => row.identity_hash);
    const edited = updateVideoVisualSegment(db, project.id, video.id, timeline.id, 0,
      { motionKind: "still", motionAmountPpm: 0, fadeInMs: 100, fadeOutMs: 100 }, 150);
    saveVideoVisualReview(db, project.id, video.id, { timelineId: edited.id, timelineRevision: edited.revision,
      timelineHash: edited.timelineHash, identityHash: edited.identityHash, action: "approve", notes: "局部运镜调整" }, 160);
    const changed = enqueueVideoRender(db, project.id, video.id, 170).render!;
    assert.notEqual(changed.id, completed!.id);
    await new JobWorker(db, { [VIDEO_RENDER_JOB_TYPE]: createVideoRenderJobHandler(db, dataRoot) },
      { workerId: "partial-render", leaseMs: 30_000, heartbeatMs: 1_000 }).runOne();
    const partial = getVideoRenderWorkspace(db, project.id, video.id).render!;
    assert.equal(partial.status, "succeeded", partial.errorMessage ?? "局部重渲染失败");
    const newChunkIdentities = (db.prepare(
      "SELECT identity_hash FROM video_render_chunks WHERE run_id=? ORDER BY chunk_index",
    ).all(partial.id) as unknown as Array<{ identity_hash: string }>).map((row) => row.identity_hash);
    assert.equal(newChunkIdentities.filter((identity) => oldChunkIdentities.includes(identity)).length, 1,
      "只应复用未受运镜变化影响的一个分片");
    const final = await openCurrentFinalVideo(db, dataRoot, project.id, video.id);
    assert(final.bytes > 0);
    await final.handle.close();
    const row = db.prepare("SELECT * FROM video_final_videos WHERE run_id=?").get(partial.id) as
      { relative_path: string; manifest_relative_path: string };
    const media = spawnSync("ffprobe", ["-v", "error", "-show_entries", "stream=codec_name,width,height,pix_fmt,r_frame_rate",
      "-of", "json", join(dataRoot, row.relative_path)], { windowsHide: true, encoding: "utf8" });
    assert.equal(media.status, 0, media.stderr);
    assert.match(media.stdout, /"codec_name": "h264"/u);
    assert.match(media.stdout, /"codec_name": "aac"/u);
    assert.match(media.stdout, /"width": 1080/u);
    assert.match(media.stdout, /"height": 1920/u);
    const manifest = await readFile(join(dataRoot, row.manifest_relative_path), "utf8");
    assert.equal(manifest.includes(dataRoot), false);
    assert.equal(manifest.includes("secret-never-in-manifest"), false);
    assert((await stat(join(dataRoot, row.relative_path))).size > 0);

    const app = Fastify({ logger: false });
    await app.register(registerVideoRenderRoutes, { database: db, dataRoot });
    try {
      const base = `/api/projects/${project.id}/videos/${video.id}`;
      const range = await app.inject({ method: "GET", url: `${base}/final-video`, headers: { range: "bytes=0-99" } });
      assert.equal(range.statusCode, 206, range.body);
      assert.equal(range.headers["content-range"], `bytes 0-99/${partial.final!.bytes}`);
      assert.equal(range.rawPayload.length, 100);
      const download = await app.inject({ method: "GET", url: `${base}/final-video/download`, headers: { range: "bytes=-64" } });
      assert.equal(download.statusCode, 206, download.body);
      assert.match(String(download.headers["content-disposition"]), /^attachment;/u);
      const duplicate = await app.inject({ method: "POST", url: `${base}/renders`, payload: {} });
      assert.equal(duplicate.statusCode, 200, duplicate.body);
      assert.equal(duplicate.json().render.id, partial.id);

      const thirdTimeline = updateVideoVisualSegment(db, project.id, video.id, edited.id, 1,
        { motionKind: "still", motionAmountPpm: 0, fadeInMs: 80, fadeOutMs: 80 }, 180);
      saveVideoVisualReview(db, project.id, video.id, { timelineId: thirdTimeline.id, timelineRevision: thirdTimeline.revision,
        timelineHash: thirdTimeline.timelineHash, identityHash: thirdTimeline.identityHash,
        action: "approve", notes: "取消验证" }, 190);
      const queued = await app.inject({ method: "POST", url: `${base}/renders`, payload: {} });
      assert.equal(queued.statusCode, 200, queued.body);
      const cancelled = await app.inject({ method: "POST",
        url: `${base}/renders/${queued.json().render.id}/cancel`, payload: {} });
      assert.equal(cancelled.statusCode, 200, cancelled.body);
      assert.equal(cancelled.json().render.status, "cancelled");
      const crossProject = await app.inject({ method: "GET",
        url: `/api/projects/${other.id}/videos/${video.id}/renders` });
      assert.equal(crossProject.statusCode, 404, crossProject.body);
    } finally { await app.close(); }
  } finally {
    connection.close();
    await rm(dataRoot, { recursive: true, force: true });
  }
});
