import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, open, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, relative, resolve, sep } from "node:path";
import type { DatabaseSync } from "node:sqlite";

import { probeNineSixteenVideo, runVideoProcess, type VideoProbe } from "./ffmpeg-video.js";
import { JobCancelledError, type JobExecutionContext, type JobHandler } from "./job-worker.js";
import { requireApprovedScriptForProduction } from "./script-approval-store.js";
import { probeSystemSpeechWav } from "./tts-timeline-job.js";

export const PLACEHOLDER_VIDEO_JOB_TYPE = "placeholder_video";
const MAX_DURATION_DRIFT_MS = 1_000;

interface AudioProbe {
  bytes: number;
  durationMs: number;
}

interface RenderInput {
  assPath: string;
  concatPath: string;
  outputPath: string;
  signal: AbortSignal;
}

interface PlaceholderVideoDependencies {
  probeAudio: (path: string, signal?: AbortSignal) => Promise<AudioProbe>;
  probeVideo: (path: string, signal?: AbortSignal) => Promise<VideoProbe>;
  render: (input: RenderInput) => Promise<void>;
}

interface SegmentRow {
  segment_index: number;
  script_version_id: string;
  input_hash: string;
  relative_path: string;
  file_hash: string;
  bytes: number;
  duration_ms: number;
}

interface CueRow {
  cue_index: number;
  segment_index: number;
  script_version_id: string;
  start_ms: number;
  end_ms: number;
}

function sha256File(path: string) {
  return new Promise<string>((resolvePromise, reject) => {
    const hash = createHash("sha256");
    createReadStream(path)
      .on("data", (chunk) => hash.update(chunk))
      .once("error", reject)
      .once("end", () => resolvePromise(hash.digest("hex")));
  });
}

function artifactPath(dataRoot: string, relativePath: string) {
  if (!relativePath || relativePath.includes("\0") || relativePath.includes("\r") || relativePath.includes("\n")) {
    throw new Error("产物相对路径无效");
  }
  const root = resolve(dataRoot);
  const absolute = resolve(root, relativePath);
  if (absolute === root || !absolute.startsWith(`${root}${sep}`)) throw new Error("产物路径越界");
  return absolute;
}

function relativeArtifactPath(dataRoot: string, absolutePath: string) {
  return relative(resolve(dataRoot), absolutePath).split(sep).join("/");
}

function payload(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("占位视频任务参数无效");
  const input = value as { episodeId?: unknown; timelineHash?: unknown };
  if (typeof input.episodeId !== "string" || !/^[A-Za-z0-9_-]+$/.test(input.episodeId)) {
    throw new Error("占位视频任务缺少有效分集 ID");
  }
  if (typeof input.timelineHash !== "string" || !/^[0-9a-f]{64}$/.test(input.timelineHash)) {
    throw new Error("占位视频任务缺少有效时间轴哈希");
  }
  return { episodeId: input.episodeId, timelineHash: input.timelineHash };
}

export const probePlaceholderVideo = probeNineSixteenVideo;

async function renderPlaceholderVideo(input: RenderInput) {
  await runVideoProcess("ffmpeg", [
    "-v", "error", "-y",
    "-f", "lavfi", "-i", "color=c=black:s=1080x1920:r=25",
    "-f", "concat", "-safe", "0", "-i", input.concatPath,
    "-vf", `ass=${basename(input.assPath)}`,
    "-af", "asetpts=N/SR/TB",
    "-map", "0:v:0", "-map", "1:a:0",
    "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-r", "25",
    "-c:a", "aac", "-shortest", "-movflags", "+faststart",
    input.outputPath,
  ], { cwd: dirname(input.assPath), signal: input.signal });
}

function validateRows(segments: SegmentRow[], cues: CueRow[], scriptVersionId: string) {
  if (!segments.length || cues.length !== segments.length) throw new Error("音频时间轴缺少完整分段或字幕 cue");
  let cursor = 0;
  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index];
    const cue = cues[index];
    if (!segment || !cue || segment.segment_index !== index || cue.cue_index !== index ||
        cue.segment_index !== index || segment.script_version_id !== scriptVersionId ||
        cue.script_version_id !== scriptVersionId || cue.start_ms !== cursor ||
        cue.end_ms !== cursor + segment.duration_ms) {
      throw new Error("音频分段或字幕 cue 不连续");
    }
    cursor = cue.end_ms;
  }
  return cursor;
}

export function createPlaceholderVideoJobHandler(
  database: DatabaseSync,
  dataRoot: string,
  dependencies: Partial<PlaceholderVideoDependencies> = {},
): JobHandler {
  const probeAudio = dependencies.probeAudio ?? probeSystemSpeechWav;
  const probeVideo = dependencies.probeVideo ?? probePlaceholderVideo;
  const render = dependencies.render ?? renderPlaceholderVideo;
  return async (context: JobExecutionContext) => {
    const { episodeId, timelineHash } = payload(context.job.payload);
    const permit = requireApprovedScriptForProduction(database, episodeId, "video");
    const segments = database.prepare(
      `SELECT segment_index, script_version_id, input_hash, relative_path, file_hash, bytes, duration_ms
       FROM audio_segments WHERE episode_id = ? AND timeline_hash = ? ORDER BY segment_index`,
    ).all(episodeId, timelineHash) as unknown as SegmentRow[];
    const cues = database.prepare(
      `SELECT cue_index, segment_index, script_version_id, start_ms, end_ms
       FROM subtitle_cues WHERE episode_id = ? AND timeline_hash = ? ORDER BY cue_index`,
    ).all(episodeId, timelineHash) as unknown as CueRow[];
    const durationMs = validateRows(segments, cues, permit.scriptVersionId);
    const segmentPaths: string[] = [];
    for (const segment of segments) {
      context.throwIfCancellationRequested();
      const expectedPath = `episodes/${episodeId}/audio/segments/${segment.input_hash}.wav`;
      if (segment.relative_path !== expectedPath) throw new Error("音频分段未使用规范内容寻址路径");
      const path = artifactPath(dataRoot, segment.relative_path);
      const measured = await probeAudio(path);
      if (measured.bytes !== segment.bytes || measured.durationMs !== segment.duration_ms ||
          await sha256File(path) !== segment.file_hash) throw new Error("音频分段文件与登记信息不一致");
      segmentPaths.push(path);
    }
    const assPath = artifactPath(dataRoot, `episodes/${episodeId}/audio/${timelineHash}.ass`);
    const assInfo = await stat(assPath);
    if (assInfo.size < 1) throw new Error("ASS 字幕文件为空");
    const assContent = await readFile(assPath, "utf8");
    if (!assContent.includes("[Events]") || (assContent.match(/^Dialogue:/gm)?.length ?? 0) !== cues.length) {
      throw new Error("ASS 字幕与时间轴 cue 不一致");
    }
    const assHash = await sha256File(assPath);
    const renderHash = createHash("sha256").update(JSON.stringify({
      contract: "placeholder-video-v1", episodeId, scriptVersionId: permit.scriptVersionId,
      timelineHash, durationMs, assHash,
      segments: segments.map((segment) => ({ fileHash: segment.file_hash, durationMs: segment.duration_ms })),
    })).digest("hex");
    const videoDirectory = resolve(dataRoot, "episodes", episodeId, "video");
    const outputPath = resolve(videoDirectory, `${renderHash}.mp4`);
    await mkdir(videoDirectory, { recursive: true });

    let reused = false;
    try {
      const existing = await probeVideo(outputPath);
      if (Math.abs(existing.durationMs - durationMs) > MAX_DURATION_DRIFT_MS) throw new Error("已存在占位视频时长不匹配");
      reused = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }

    if (!reused) {
      const temporaryPath = resolve(videoDirectory, `${renderHash}.${randomUUID()}.tmp.mp4`);
      const concatPath = resolve(videoDirectory, `${renderHash}.${randomUUID()}.tmp.ffconcat`);
      const controller = new AbortController();
      const poll = setInterval(() => { if (context.isCancellationRequested()) controller.abort(); }, 50);
      try {
        const lines = segmentPaths.flatMap((path, index) => {
          const controlled = relative(videoDirectory, path).split(sep).join("/");
          if (!controlled || controlled.includes("'") || /[\r\n\0]/.test(controlled)) throw new Error("音频分段路径不能写入 ffconcat");
          return [`file '${controlled}'`, `duration ${(segments[index]!.duration_ms / 1_000).toFixed(3)}`];
        });
        await writeFile(concatPath, `ffconcat version 1.0\n${lines.join("\n")}\n`, { encoding: "utf8", flag: "wx" });
        context.throwIfCancellationRequested();
        await render({ assPath, concatPath, outputPath: temporaryPath, signal: controller.signal });
        context.throwIfCancellationRequested();
        const rendered = await probeVideo(temporaryPath);
        if (Math.abs(rendered.durationMs - durationMs) > MAX_DURATION_DRIFT_MS) {
          throw new Error(`占位视频时长与音频时间轴不匹配：${rendered.durationMs}/${durationMs}ms`);
        }
        const file = await open(temporaryPath, "r+");
        try { await file.sync(); } finally { await file.close(); }
        await rename(temporaryPath, outputPath);
      } finally {
        clearInterval(poll);
        await rm(concatPath, { force: true });
        await rm(temporaryPath, { force: true });
      }
    }

    context.throwIfCancellationRequested();
    const finalProbe = await probeVideo(outputPath);
    if (Math.abs(finalProbe.durationMs - durationMs) > MAX_DURATION_DRIFT_MS) throw new Error("占位视频最终时长与音频时间轴不匹配");
    const fileHash = await sha256File(outputPath);
    context.commitCheckpoint("placeholder-video", episodeId, renderHash, () => {
      const current = requireApprovedScriptForProduction(database, episodeId, "video");
      if (current.scriptVersionId !== permit.scriptVersionId || current.approvalRevision !== permit.approvalRevision) {
        throw new Error("占位视频生成期间批准稿已变化，本次结果不登记");
      }
      return undefined;
    });
    context.reportProgress(1);
    return {
      episodeId,
      scriptVersionId: permit.scriptVersionId,
      timelineHash,
      renderHash,
      durationMs: finalProbe.durationMs,
      bytes: finalProbe.bytes,
      fileHash,
      relativePath: relativeArtifactPath(dataRoot, outputPath),
      reused,
    };
  };
}
