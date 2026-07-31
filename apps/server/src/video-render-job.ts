import { createHash, randomUUID } from "node:crypto";
import { constants, createReadStream } from "node:fs";
import { copyFile, lstat, open, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { DatabaseSync } from "node:sqlite";

import { probeNineSixteenVideo, runVideoProcess } from "./ffmpeg-video.js";
import { JobCancelledError, type JobExecutionContext, type JobHandler } from "./job-worker.js";
import { renderNineSixteenTemplate, type NineSixteenMotionKind } from "./nine-sixteen-template.js";
import { ensureSafeOutputDirectory } from "./render-chunk-job.js";
import { renderAss } from "./subtitle-timeline.js";
import { canonical } from "./video-plan-contract.js";
import {
  VIDEO_RENDER_PARAMS, videoRenderIdentity, VideoRenderError, videoRenderSha256,
} from "./video-render-store.js";

const MAX_INPUT_BYTES = 256 * 1024 * 1024;
const MAX_DURATION_DRIFT_MS = 1_000;

interface Payload { runId: string; projectId: string; videoId: string; identityHash: string }
interface RunRow { id: string; project_id: string; video_id: string; timeline_id: string; timeline_hash: string;
  visual_review_id: string; identity_hash: string; job_id: string; status: string; params_hash: string; created_at: number }
interface SegmentRow { id: string; project_id: string; timeline_id: string; video_id: string; segment_index: number;
  cue_start_index: number; cue_end_index: number; start_ms: number; end_ms: number; visual_id: string;
  candidate_id: string; candidate_hash: string; candidate_relative_path: string; motion_kind: string;
  motion_amount_ppm: number; fade_in_ms: number; fade_out_ms: number; segment_hash: string }
interface ArtifactRow { audio_relative_path: string; audio_bytes: number; audio_hash: string; ass_relative_path: string;
  ass_bytes: number; ass_hash: string; duration_ms: number }
interface ChunkRow { id: string; chunk_index: number; identity_hash: string; status: string; relative_path: string | null;
  bytes: number | null; file_hash: string | null; media_info_json: string | null }

function payload(value: unknown): Payload {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("最终渲染任务参数无效");
  const input = value as Record<string, unknown>;
  for (const key of ["runId", "projectId", "videoId"] as const) {
    if (typeof input[key] !== "string" || !/^[A-Za-z0-9_-]+$/u.test(input[key])) throw new Error("最终渲染任务身份无效");
  }
  if (typeof input.identityHash !== "string" || !/^[0-9a-f]{64}$/u.test(input.identityHash)) {
    throw new Error("最终渲染输入哈希无效");
  }
  return input as unknown as Payload;
}

function controlled(dataRoot: string, relativePath: string) {
  if (!relativePath || /[\0\r\n]/u.test(relativePath)) throw new Error("媒体相对路径无效");
  const root = resolve(dataRoot);
  const path = resolve(root, ...relativePath.split("/"));
  if (path === root || !path.startsWith(`${root}${sep}`)) throw new Error("媒体路径越界");
  return path;
}

function inside(root: string, path: string) {
  const value = relative(root, path);
  return value !== "" && value !== ".." && !value.startsWith(`..${sep}`) && !isAbsolute(value);
}

async function verifiedContent(dataRoot: string, relativePath: string, expectedBytes: number, expectedHash: string) {
  if (!Number.isSafeInteger(expectedBytes) || expectedBytes < 1 || expectedBytes > MAX_INPUT_BYTES) {
    throw new Error("媒体文件大小超出渲染读取限制");
  }
  const path = controlled(dataRoot, relativePath);
  const root = resolve(dataRoot);
  const [rootReal, fileReal, before] = await Promise.all([realpath(root), realpath(path), lstat(path)]);
  if (!inside(rootReal, fileReal) || !before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size !== expectedBytes) {
    throw new Error("媒体必须是数据目录内登记的普通独占文件");
  }
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const opened = await handle.stat();
    if (opened.dev !== before.dev || opened.ino !== before.ino || opened.size !== expectedBytes) {
      throw new Error("媒体在校验期间发生变化");
    }
    const content = await handle.readFile();
    if (content.length !== expectedBytes || videoRenderSha256(content) !== expectedHash) {
      throw new Error("媒体文件与登记哈希不一致");
    }
    return content;
  } finally { await handle.close(); }
}

async function sha256File(path: string) {
  return new Promise<string>((resolvePromise, reject) => {
    const hash = createHash("sha256");
    createReadStream(path).on("data", (chunk) => hash.update(chunk)).once("error", reject)
      .once("end", () => resolvePromise(hash.digest("hex")));
  });
}

function motion(kind: string): NineSixteenMotionKind {
  const mapped = { still: "none", zoom_in: "zoom-in", zoom_out: "zoom-out", pan_left: "pan-left", pan_right: "pan-right" }[kind];
  if (!mapped) throw new Error("视觉段运镜类型无效");
  return mapped as NineSixteenMotionKind;
}

function currentRun(database: DatabaseSync, input: Payload) {
  const row = database.prepare("SELECT * FROM video_render_runs WHERE id=? AND project_id=? AND video_id=?")
    .get(input.runId, input.projectId, input.videoId) as RunRow | undefined;
  if (!row || row.identity_hash !== input.identityHash) throw new Error("最终渲染任务不属于当前视频身份");
  const current = videoRenderIdentity(database, input.projectId, input.videoId);
  if (current.identityHash !== input.identityHash || current.timeline.id !== row.timeline_id ||
      current.review.id !== row.visual_review_id) throw new Error("最终渲染上游已变化，本次任务已失效");
  return { row, current };
}

function timelineRows(database: DatabaseSync, run: RunRow) {
  const segments = database.prepare(
    "SELECT * FROM video_visual_segments WHERE timeline_id=? AND video_id=? ORDER BY segment_index",
  ).all(run.timeline_id, run.video_id) as unknown as SegmentRow[];
  if (!segments.length || segments[0]!.start_ms !== 0 || segments.some((segment, index) =>
    segment.segment_index !== index || segment.end_ms <= segment.start_ms ||
    (index > 0 && segment.start_ms !== segments[index - 1]!.end_ms))) throw new Error("视觉时间轴不连续");
  return segments;
}

function artifact(database: DatabaseSync, run: RunRow) {
  const row = database.prepare(
    `SELECT artifact.audio_relative_path,artifact.audio_bytes,artifact.audio_hash,artifact.ass_relative_path,
            artifact.ass_bytes,artifact.ass_hash,artifact.duration_ms
     FROM video_visual_timelines timeline JOIN video_tts_artifacts artifact ON artifact.id=timeline.tts_artifact_id
     WHERE timeline.id=? AND timeline.video_id=?`,
  ).get(run.timeline_id, run.video_id) as ArtifactRow | undefined;
  if (!row) throw new Error("当前配音产物不存在");
  return row;
}

function cues(database: DatabaseSync, run: RunRow, segment: SegmentRow) {
  const rows = database.prepare(
    `SELECT cue_index AS 'index',start_ms AS startMs,end_ms AS endMs,text
     FROM video_tts_cues WHERE video_id=? AND artifact_id=(
       SELECT tts_artifact_id FROM video_visual_timelines WHERE id=?
     ) AND cue_index BETWEEN ? AND ? ORDER BY cue_index`,
  ).all(run.video_id, run.timeline_id, segment.cue_start_index, segment.cue_end_index) as unknown as
    Array<{ index: number; startMs: number; endMs: number; text: string }>;
  if (!rows.length || rows[0]!.startMs > segment.start_ms || rows.at(-1)!.endMs < segment.end_ms ||
      rows.some((cue, index) => index > 0 && cue.startMs !== rows[index - 1]!.endMs)) {
    throw new Error("视觉段没有连续对应当前字幕 cue");
  }
  // 多画面可以在同一 cue 内确定性分段；分片字幕只保留与当前视觉段相交的区间。
  return rows.map((cue) => ({ ...cue, startMs: Math.max(cue.startMs, segment.start_ms),
    endMs: Math.min(cue.endMs, segment.end_ms) })).filter((cue) => cue.endMs > cue.startMs);
}

async function verifiedChunk(path: string, row: ChunkRow, expectedDurationMs: number) {
  if (!row.relative_path || !row.bytes || !row.file_hash || row.relative_path.length < 1) return false;
  try {
    const measured = await probeNineSixteenVideo(path);
    return measured.bytes === row.bytes && Math.abs(measured.durationMs - expectedDurationMs) <= MAX_DURATION_DRIFT_MS &&
      await sha256File(path) === row.file_hash;
  } catch { return false; }
}

async function renderChunk(database: DatabaseSync, dataRoot: string, context: JobExecutionContext,
  input: Payload, run: RunRow, segment: SegmentRow, source: ArtifactRow, audio: Buffer) {
  const identityHash = videoRenderSha256(canonical({ videoId: input.videoId,
    stableSegmentHash: segment.segment_hash, audioHash: source.audio_hash, assHash: source.ass_hash,
    params: VIDEO_RENDER_PARAMS }));
  const relativePath = `videos/${input.videoId}/renders/chunks/${identityHash.slice(0, 2)}/${identityHash}.mp4`;
  const outputPath = controlled(dataRoot, relativePath);
  await ensureSafeOutputDirectory(dataRoot, dirname(outputPath));
  let row = database.prepare("SELECT * FROM video_render_chunks WHERE run_id=? AND identity_hash=?")
    .get(run.id, identityHash) as ChunkRow | undefined;
  if (!row) {
    const now = Date.now();
    const reusable = database.prepare(
      "SELECT * FROM video_render_chunks WHERE identity_hash=? AND status='succeeded' ORDER BY checkpoint_at DESC LIMIT 1",
    ).get(identityHash) as unknown as ChunkRow | undefined;
    if (reusable?.relative_path === relativePath && await verifiedChunk(outputPath, reusable, segment.end_ms - segment.start_ms)) {
      context.commitCheckpoint("video-render-chunk", String(segment.segment_index), identityHash, (transaction) => {
        currentRun(database, input);
        transaction.run(
          `INSERT INTO video_render_chunks
           (id,run_id,video_id,timeline_id,chunk_index,segment_id,segment_hash,identity_hash,status,relative_path,
            bytes,file_hash,media_info_json,error_summary,checkpoint_at,created_at,updated_at)
           VALUES (?,?,?,?,?,?,?,?,'succeeded',?,?,?,?,NULL,?,?,?)`,
          `vrc_${randomUUID()}`, run.id, run.video_id, run.timeline_id, segment.segment_index, segment.id,
          segment.segment_hash, identityHash, relativePath, reusable.bytes!, reusable.file_hash!, reusable.media_info_json!,
          now, now, now);
        return undefined;
      });
      row = database.prepare("SELECT * FROM video_render_chunks WHERE run_id=? AND identity_hash=?")
        .get(run.id, identityHash) as unknown as ChunkRow;
      return { row, reused: true };
    }
    database.prepare(
      `INSERT INTO video_render_chunks
       (id,run_id,video_id,timeline_id,chunk_index,segment_id,segment_hash,identity_hash,status,created_at,updated_at)
       VALUES (?,?,?,?,?,?,?,?,'queued',?,?)`,
    ).run(`vrc_${randomUUID()}`, run.id, run.video_id, run.timeline_id, segment.segment_index, segment.id,
      segment.segment_hash, identityHash, now, now);
    row = database.prepare("SELECT * FROM video_render_chunks WHERE run_id=? AND identity_hash=?")
      .get(run.id, identityHash) as unknown as ChunkRow;
  }
  if (row.relative_path && row.relative_path !== relativePath) throw new Error("渲染分片不是规范内容寻址路径");
  if (row.status === "succeeded" && await verifiedChunk(outputPath, row, segment.end_ms - segment.start_ms)) {
    return { row, reused: true };
  }
  await rm(outputPath, { force: true });
  database.prepare("UPDATE video_render_chunks SET status='running',relative_path=NULL,bytes=NULL,file_hash=NULL,media_info_json=NULL,error_summary=NULL,updated_at=? WHERE id=?")
    .run(Date.now(), row.id);
  // libass 在 Windows 深层内容寻址目录下可能触及路径上限；临时输入放在数据根内的短目录，最终产物仍使用 canonical 路径。
  const temporaryDirectory = controlled(dataRoot, `render-tmp/${randomUUID()}`);
  await ensureSafeOutputDirectory(dataRoot, temporaryDirectory);
  const imagePath = join(temporaryDirectory, "image");
  const sourceAudio = join(temporaryDirectory, "source.wav");
  const localAudio = join(temporaryDirectory, "audio.wav");
  const assPath = join(temporaryDirectory, "subtitle.ass");
  const controller = new AbortController();
  const poll = setInterval(() => { if (context.isCancellationRequested()) controller.abort(); }, 50);
  try {
    const candidate = database.prepare(
      "SELECT bytes,file_hash,relative_path FROM video_image_candidates WHERE id=? AND project_id=? AND video_id=?",
    ).get(segment.candidate_id, input.projectId, input.videoId) as
      { bytes: number; file_hash: string; relative_path: string } | undefined;
    if (!candidate || candidate.file_hash !== segment.candidate_hash || candidate.relative_path !== segment.candidate_relative_path) {
      throw new Error("视觉段批准图片身份已变化");
    }
    await writeFile(imagePath, await verifiedContent(dataRoot, candidate.relative_path, candidate.bytes, candidate.file_hash), { flag: "wx" });
    await writeFile(sourceAudio, audio, { flag: "wx" });
    await writeFile(assPath, renderAss(cues(database, run, segment), segment.start_ms), { flag: "wx" });
    await runVideoProcess("ffmpeg", ["-v", "error", "-y", "-ss", (segment.start_ms / 1000).toFixed(3),
      "-t", ((segment.end_ms - segment.start_ms) / 1000).toFixed(3), "-i", sourceAudio, "-c:a", "pcm_s16le", localAudio],
    { signal: controller.signal });
    await renderNineSixteenTemplate({ scenes: [{ imagePath, durationMs: segment.end_ms - segment.start_ms,
      motionKind: motion(segment.motion_kind), motionAmountPpm: segment.motion_amount_ppm,
      fadeMs: segment.fade_in_ms }], audioPath: localAudio, assPath, outputPath, signal: controller.signal });
    context.throwIfCancellationRequested();
    const measured = await probeNineSixteenVideo(outputPath, controller.signal);
    if (Math.abs(measured.durationMs - (segment.end_ms - segment.start_ms)) > MAX_DURATION_DRIFT_MS) {
      throw new Error("渲染分片时长与视觉段不一致");
    }
    const fileHash = await sha256File(outputPath);
    currentRun(database, input);
    context.commitCheckpoint("video-render-chunk", String(segment.segment_index), identityHash, (transaction) => {
      // 与 checkpoint 领域写入共用同一数据库事务，旧任务晚完成不能登记到新身份。
      currentRun(database, input);
      transaction.run(
        `UPDATE video_render_chunks SET status='succeeded',relative_path=?,bytes=?,file_hash=?,media_info_json=?,
         error_summary=NULL,checkpoint_at=?,updated_at=? WHERE id=? AND identity_hash=?`,
        relativePath, measured.bytes, fileHash, canonical({ ...VIDEO_RENDER_PARAMS, durationMs: measured.durationMs }),
        Date.now(), Date.now(), row!.id, identityHash);
      return undefined;
    });
    return { row: { ...row, relative_path: relativePath, bytes: measured.bytes, file_hash: fileHash }, reused: false };
  } catch (error) {
    database.prepare("UPDATE video_render_chunks SET status=?,error_summary=?,updated_at=? WHERE id=?")
      .run(context.isCancellationRequested() ? "cancelled" : "failed", error instanceof Error ? error.message : String(error), Date.now(), row.id);
    throw error;
  } finally {
    clearInterval(poll);
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}

async function composeFinal(database: DatabaseSync, dataRoot: string, context: JobExecutionContext,
  input: Payload, run: RunRow, segments: SegmentRow[]) {
  const finalIdentity = videoRenderSha256(canonical({ renderIdentity: input.identityHash, stage: "final-v1" }));
  const directory = `videos/${input.videoId}/renders/final/${finalIdentity.slice(0, 2)}/${finalIdentity}`;
  const finalRelativePath = `${directory}/video.mp4`;
  const manifestRelativePath = `${directory}/manifest.json`;
  const finalPath = controlled(dataRoot, finalRelativePath);
  await ensureSafeOutputDirectory(dataRoot, dirname(finalPath));
  const staging = join(dirname(finalPath), `.staging-${randomUUID()}`);
  await ensureSafeOutputDirectory(dataRoot, staging);
  const controller = new AbortController();
  const poll = setInterval(() => { if (context.isCancellationRequested()) controller.abort(); }, 50);
  const list = ["ffconcat version 1.0"];
  const chunks = database.prepare(
    "SELECT * FROM video_render_chunks WHERE run_id=? ORDER BY chunk_index",
  ).all(run.id) as unknown as ChunkRow[];
  if (chunks.length !== segments.length || chunks.some((chunk, index) => chunk.chunk_index !== index || chunk.status !== "succeeded")) {
    throw new Error("当前渲染分片尚未全部成功");
  }
  try {
    for (const chunk of chunks) {
      const expectedPath = `videos/${input.videoId}/renders/chunks/${chunk.identity_hash.slice(0, 2)}/${chunk.identity_hash}.mp4`;
      if (chunk.relative_path !== expectedPath) throw new Error("最终合并分片不是规范内容寻址路径");
      const source = controlled(dataRoot, expectedPath);
      const segment = segments[chunk.chunk_index]!;
      if (!await verifiedChunk(source, chunk, segment.end_ms - segment.start_ms)) {
        throw new Error("最终合并前分片媒体校验失败");
      }
      const local = `chunk-${String(chunk.chunk_index).padStart(4, "0")}.mp4`;
      const snapshot = join(staging, local);
      await copyFile(source, snapshot, constants.COPYFILE_EXCL);
      if ((await stat(snapshot)).size !== chunk.bytes || await sha256File(snapshot) !== chunk.file_hash) {
        throw new Error("分片快照与登记哈希不一致");
      }
      list.push(`file '${local}'`);
    }
    await writeFile(join(staging, "chunks.ffconcat"), `${list.join("\n")}\n`, { flag: "wx" });
    const stagedVideo = join(staging, "video.mp4");
    await runVideoProcess("ffmpeg", ["-v", "error", "-y", "-f", "concat", "-safe", "1", "-i", "chunks.ffconcat",
      "-c:v", "libx264", "-r", "25", "-pix_fmt", "yuv420p", "-c:a", "aac",
      "-movflags", "+faststart", basename(stagedVideo)], { cwd: staging, signal: controller.signal });
    context.throwIfCancellationRequested();
    const measured = await probeNineSixteenVideo(stagedVideo, controller.signal);
    const expectedDuration = segments.at(-1)!.end_ms;
    if (Math.abs(measured.durationMs - expectedDuration) > MAX_DURATION_DRIFT_MS) throw new Error("最终视频时长与真实音频不一致");
    // metadata 成功不代表码流可完整读取，最终产物必须实际解码到 null sink。
    await runVideoProcess("ffmpeg", ["-v", "error", "-i", stagedVideo, "-f", "null", "-"], { signal: controller.signal });
    const fileHash = await sha256File(stagedVideo);
    const ffmpegVersion = (await runVideoProcess("ffmpeg", ["-version"], { signal: controller.signal })).split(/\r?\n/u)[0]!.trim();
    const timeline = database.prepare("SELECT * FROM video_visual_timelines WHERE id=?").get(run.timeline_id) as Record<string, unknown>;
    const tts = database.prepare(
      `SELECT provider_id,model_id,voice_id,rate,language,snapshot_hash FROM video_tts_snapshots
       WHERE id=(SELECT tts_snapshot_id FROM video_visual_timelines WHERE id=?)`,
    ).get(run.timeline_id) as Record<string, unknown>;
    const plan = database.prepare("SELECT model_json,prompt_json FROM video_plan_snapshots WHERE id=?")
      .get(timeline.plan_snapshot_id as string) as { model_json: string; prompt_json: string };
    const model = JSON.parse(plan.model_json) as Record<string, unknown>;
    const manifest = {
      version: "yingshu-video-final-v1", projectId: input.projectId, videoId: input.videoId,
      plan: { snapshotId: timeline.plan_snapshot_id, snapshotHash: timeline.plan_snapshot_hash,
        promptHash: videoRenderSha256(plan.prompt_json), providerId: model.providerId ?? null,
        modelId: model.modelId ?? null, identityHash: model.identityHash ?? null },
      script: { revisionId: timeline.script_revision_id, contentHash: timeline.script_content_hash },
      visual: { revisionId: timeline.visual_revision_id, contentHash: timeline.visual_content_hash,
        timelineId: run.timeline_id, timelineHash: run.timeline_hash, reviewId: run.visual_review_id,
        images: segments.map((segment) => ({ visualId: segment.visual_id, candidateId: segment.candidate_id,
          candidateHash: segment.candidate_hash })) },
      audio: { snapshotId: timeline.tts_snapshot_id, snapshotHash: tts.snapshot_hash, artifactId: timeline.tts_artifact_id,
        providerId: tts.provider_id, modelId: tts.model_id, voiceId: tts.voice_id, rate: tts.rate, language: tts.language,
        audioHash: timeline.audio_hash, cuesHash: timeline.cues_hash, srtHash: timeline.srt_hash, assHash: timeline.ass_hash },
      render: { identityHash: input.identityHash, params: VIDEO_RENDER_PARAMS,
        chunks: chunks.map((chunk) => ({ index: chunk.chunk_index, identityHash: chunk.identity_hash,
          fileHash: chunk.file_hash, bytes: chunk.bytes })) },
      final: { identityHash: finalIdentity, relativePath: finalRelativePath, bytes: measured.bytes,
        fileHash, mediaInfo: { ...VIDEO_RENDER_PARAMS, durationMs: measured.durationMs } },
      ffmpegVersion, createdAt: run.created_at,
    };
    const manifestText = `${canonical(manifest)}\n`;
    const manifestHash = videoRenderSha256(manifestText);
    await writeFile(join(staging, "manifest.json"), manifestText, { flag: "wx" });
    currentRun(database, input);
    await rm(finalPath, { force: true });
    await rm(controlled(dataRoot, manifestRelativePath), { force: true });
    await rename(stagedVideo, finalPath);
    await rename(join(staging, "manifest.json"), controlled(dataRoot, manifestRelativePath));
    context.commitCheckpoint("video-render-final", "final", finalIdentity, (transaction) => {
      // 发布文件后仍在写事务内复核，避免并发上游修改被旧 run 标成 completed。
      currentRun(database, input);
      transaction.run("DELETE FROM video_final_videos WHERE run_id=?", run.id);
      transaction.run(
        `INSERT INTO video_final_videos
         (id,run_id,project_id,video_id,identity_hash,relative_path,bytes,file_hash,media_info_json,
          manifest_relative_path,manifest_bytes,manifest_hash,ffmpeg_version,created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        `vfv_${randomUUID()}`, run.id, input.projectId, input.videoId, finalIdentity, finalRelativePath, measured.bytes,
        fileHash, canonical({ ...VIDEO_RENDER_PARAMS, durationMs: measured.durationMs }), manifestRelativePath,
        Buffer.byteLength(manifestText), manifestHash, ffmpegVersion, Date.now());
      transaction.run("UPDATE video_render_runs SET status='succeeded',error_summary=NULL,updated_at=? WHERE id=? AND identity_hash=?",
        Date.now(), run.id, input.identityHash);
      transaction.run("UPDATE videos SET status='completed',updated_at=? WHERE id=? AND project_id=?", Date.now(), input.videoId, input.projectId);
      return undefined;
    });
    return { runId: run.id, finalIdentity, bytes: measured.bytes, fileHash, durationMs: measured.durationMs, manifestHash };
  } finally { clearInterval(poll); await rm(staging, { recursive: true, force: true }); }
}

export function createVideoRenderJobHandler(database: DatabaseSync, dataRoot: string): JobHandler {
  return async (context) => {
    const input = payload(context.job.payload);
    let run: RunRow | undefined;
    try {
      ({ row: run } = currentRun(database, input));
      database.prepare("UPDATE video_render_runs SET status='running',error_summary=NULL,updated_at=? WHERE id=?")
        .run(Date.now(), run.id);
      const segments = timelineRows(database, run);
      const source = artifact(database, run);
      const audio = await verifiedContent(dataRoot, source.audio_relative_path, source.audio_bytes, source.audio_hash);
      await verifiedContent(dataRoot, source.ass_relative_path, source.ass_bytes, source.ass_hash);
      for (const [index, segment] of segments.entries()) {
        context.throwIfCancellationRequested();
        await renderChunk(database, dataRoot, context, input, run, segment, source, audio);
        context.reportProgress((index + 1) / (segments.length + 1));
      }
      const result = await composeFinal(database, dataRoot, context, input, run, segments);
      context.reportProgress(1);
      return result;
    } catch (error) {
      const cancelled = error instanceof JobCancelledError || context.isCancellationRequested();
      if (run) {
        database.prepare("UPDATE video_render_runs SET status=?,error_summary=?,updated_at=? WHERE id=? AND status<>'succeeded'")
          .run(cancelled ? "cancelled" : "failed", error instanceof Error ? error.message : String(error), Date.now(), run.id);
        if (cancelled) database.prepare(
          "UPDATE video_render_chunks SET status='cancelled',updated_at=? WHERE run_id=? AND status IN ('queued','running')",
        ).run(Date.now(), run.id);
      }
      throw error instanceof VideoRenderError ? error : error;
    }
  };
}
