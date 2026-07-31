import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, open, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import type { DatabaseSync } from "node:sqlite";

import { withDataFileMutationLock } from "./data-file-mutation-lock.js";
import { JobCancelledError, type JobExecutionContext, type JobHandler } from "./job-worker.js";
import { type RuntimeModelConfig } from "./model-config.js";
import { renderSubtitleFiles, splitNarration } from "./subtitle-timeline.js";
import { probeSystemSpeechWav, synthesizeConfiguredTts } from "./tts-provider.js";
import {
  getVideoTtsSnapshotForJob,
  isVideoTtsSnapshotCurrent,
  VIDEO_TTS_JOB_TYPE,
  type VideoTtsCue,
  type VideoTtsSnapshot,
} from "./video-tts-store.js";

interface SynthesizeInput {
  text: string;
  outputPath: string;
  voiceId: string;
  rate: number;
  language: string;
  signal?: AbortSignal;
  snapshot: VideoTtsSnapshot;
  runtime: RuntimeModelConfig;
}

interface SynthesizeResult { providerRequestId?: string | null }

interface Dependencies {
  resolveRuntime(snapshot: VideoTtsSnapshot): Promise<RuntimeModelConfig | null>;
  synthesize(input: SynthesizeInput): Promise<SynthesizeResult>;
  probe(path: string, signal?: AbortSignal): Promise<{ bytes: number; durationMs: number }>;
}

interface SegmentCheckpoint {
  relativePath: string;
  bytes: number;
  durationMs: number;
  hash: string;
  providerRequestId: string | null;
}

const sha256Buffer = (value: Uint8Array | string) => createHash("sha256").update(value).digest("hex");

async function sha256File(path: string) { return sha256Buffer(await readFile(path)); }

function jobPayload(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("配音任务冻结参数无效");
  const row = value as Record<string, unknown>;
  if (typeof row.projectId !== "string" || typeof row.videoId !== "string" || typeof row.snapshotId !== "string" ||
      typeof row.snapshotHash !== "string" || !/^[0-9a-f]{64}$/u.test(row.snapshotHash)) throw new Error("配音任务冻结参数无效");
  return row as { projectId: string; videoId: string; snapshotId: string; snapshotHash: string };
}

function relativePath(dataRoot: string, absolute: string) {
  const value = relative(resolve(dataRoot), absolute).split(sep).join("/");
  if (!value || value.startsWith("../") || value === "..") throw new Error("配音产物路径越界");
  return value;
}

async function controlledFile(dataRoot: string, storedRelativePath: string, expected?: { bytes: number; hash: string }) {
  if (!storedRelativePath || storedRelativePath.startsWith("/") || storedRelativePath.includes("\\") ||
      storedRelativePath.split("/").some((part) => !part || part === "." || part === "..")) throw new Error("配音产物相对路径无效");
  const [root, path] = await Promise.all([realpath(resolve(dataRoot)), realpath(resolve(dataRoot, ...storedRelativePath.split("/")))]);
  if (!path.startsWith(`${root}${sep}`)) throw new Error("配音产物路径越界");
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error("配音产物不是普通文件");
  if (expected && (info.size !== expected.bytes || await sha256File(path) !== expected.hash)) throw new Error("配音产物身份校验失败");
  return path;
}

async function durableWrite(path: string, content: Uint8Array | string) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  await mkdir(dirname(path), { recursive: true });
  try {
    await writeFile(temporary, content);
    const handle = await open(temporary, "r+");
    try { await handle.sync(); } finally { await handle.close(); }
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}

function pcmPayload(wav: Buffer) {
  if (wav.length < 44 || wav.toString("ascii", 0, 4) !== "RIFF" || wav.toString("ascii", 8, 12) !== "WAVE") {
    throw new Error("分段 WAV 头无效");
  }
  let offset = 12;
  let validFormat = false;
  let data: Buffer | undefined;
  while (offset + 8 <= wav.length) {
    const type = wav.toString("ascii", offset, offset + 4);
    const size = wav.readUInt32LE(offset + 4);
    const start = offset + 8;
    const end = start + size;
    if (end > wav.length) throw new Error("分段 WAV chunk 越界");
    if (type === "fmt " && size >= 16) validFormat = wav.readUInt16LE(start) === 1 && wav.readUInt16LE(start + 2) === 1 &&
      wav.readUInt32LE(start + 4) === 22_050 && wav.readUInt16LE(start + 14) === 16;
    if (type === "data") data = wav.subarray(start, end);
    offset = end + (size % 2);
  }
  if (!validFormat || !data?.length || data.length % 2 !== 0) throw new Error("分段 WAV 编码无效");
  return data;
}

function concatPcmWav(files: Buffer[]) {
  const payloads = files.map(pcmPayload);
  const length = payloads.reduce((total, value) => total + value.length, 0);
  if (length > 0xfffffff0) throw new Error("配音 WAV 超过 RIFF 大小上限");
  const header = Buffer.alloc(44);
  header.write("RIFF", 0, "ascii"); header.writeUInt32LE(36 + length, 4); header.write("WAVEfmt ", 8, "ascii");
  header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22); header.writeUInt32LE(22_050, 24);
  header.writeUInt32LE(44_100, 28); header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34);
  header.write("data", 36, "ascii"); header.writeUInt32LE(length, 40);
  return Buffer.concat([header, ...payloads], 44 + length);
}

function segmentOutput(value: unknown): SegmentCheckpoint | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Partial<SegmentCheckpoint>;
  return typeof row.relativePath === "string" && Number.isSafeInteger(row.bytes) && (row.bytes ?? 0) > 44 &&
    Number.isSafeInteger(row.durationMs) && (row.durationMs ?? 0) > 0 && typeof row.hash === "string" &&
    /^[0-9a-f]{64}$/u.test(row.hash) && (row.providerRequestId === null || typeof row.providerRequestId === "string")
    ? row as SegmentCheckpoint : null;
}

function audioOutput(value: unknown): { relativePath: string; bytes: number; durationMs: number; hash: string } | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as { relativePath?: unknown; bytes?: unknown; durationMs?: unknown; hash?: unknown };
  return typeof row.relativePath === "string" && Number.isSafeInteger(row.bytes) && Number(row.bytes) > 44 &&
    Number.isSafeInteger(row.durationMs) && Number(row.durationMs) > 0 && typeof row.hash === "string" && /^[0-9a-f]{64}$/u.test(row.hash)
    ? row as { relativePath: string; bytes: number; durationMs: number; hash: string } : null;
}

function cueIdentity(cue: Omit<VideoTtsCue, "hash">) {
  return sha256Buffer(JSON.stringify({ paragraphId: cue.paragraphId, text: cue.text, startMs: cue.startMs, endMs: cue.endMs }));
}

function defaultSynthesize(input: SynthesizeInput) {
  return synthesizeConfiguredTts({
    text: input.text, outputPath: input.outputPath, scriptVersionId: input.snapshot.scriptRevisionId,
    contentHash: input.snapshot.scriptContentHash, voice: input.voiceId, rate: input.rate,
    contractVersion: input.snapshot.systemContractVersion, runtime: input.runtime, signal: input.signal,
  }).then(() => ({}));
}

async function cancellationSignal(context: JobExecutionContext) {
  const controller = new AbortController();
  const timer = setInterval(() => { if (context.isCancellationRequested()) controller.abort(); }, 50);
  return { signal: controller.signal, close: () => clearInterval(timer) };
}

export function createVideoTtsJobHandler(
  database: DatabaseSync,
  dataRoot: string,
  resolveRuntime: Dependencies["resolveRuntime"],
  dependencies: Partial<Omit<Dependencies, "resolveRuntime">> = {},
): JobHandler {
  const synthesize = dependencies.synthesize ?? defaultSynthesize;
  const probe = dependencies.probe ?? probeSystemSpeechWav;
  return async (context) => {
    const task = jobPayload(context.job.payload);
    if (context.job.type !== VIDEO_TTS_JOB_TYPE) throw new Error("配音任务类型无效");
    const snapshot = getVideoTtsSnapshotForJob(database, context.job.id);
    if (snapshot.id !== task.snapshotId || snapshot.snapshotHash !== task.snapshotHash || snapshot.projectId !== task.projectId ||
        snapshot.videoId !== task.videoId) throw new Error("配音任务身份不一致");
    if (!isVideoTtsSnapshotCurrent(database, snapshot)) throw new JobCancelledError();
    const existing = database.prepare("SELECT id FROM video_tts_artifacts WHERE snapshot_id = ?").get(snapshot.id) as { id: string } | undefined;
    if (existing) return { artifactId: existing.id, snapshotId: snapshot.id, reused: true };
    const runtime = await resolveRuntime(snapshot);
    if (!runtime || runtime.type !== "tts" || runtime.providerId !== snapshot.providerId || runtime.providerKind !== snapshot.providerKind ||
        runtime.protocol !== snapshot.protocol || runtime.baseUrl.replace(/\/+$/u, "") !== snapshot.baseUrl ||
        runtime.modelId !== snapshot.modelId || (runtime.voiceId || snapshot.voiceId) !== snapshot.voiceId ||
        (runtime.language || snapshot.language) !== snapshot.language) throw new Error("TTS 配置已变化或能力不匹配，请重新创建配音任务");

    await mkdir(resolve(dataRoot), { recursive: true });
    const directory = resolve(dataRoot, "video-tts", snapshot.videoId, snapshot.snapshotHash);
    await mkdir(directory, { recursive: true });
    const units = snapshot.paragraphs.flatMap((paragraph) => splitNarration(paragraph.text)
      .map((unit) => ({ paragraphId: paragraph.id, ...unit })));
    if (!units.length) throw new Error("批准旁白没有可朗读内容");
    const segments: SegmentCheckpoint[] = [];
    const createdBeforeCheckpoint: string[] = [];
    try {
      for (let index = 0; index < units.length; index += 1) {
        context.throwIfCancellationRequested();
        if (!isVideoTtsSnapshotCurrent(database, snapshot)) throw new JobCancelledError();
        const unit = units[index]!;
        const inputHash = sha256Buffer(JSON.stringify({ snapshotHash: snapshot.snapshotHash, index,
          paragraphId: unit.paragraphId, text: unit.speechText }));
        const checkpoint = context.getCheckpoint("video-tts-provider", `segment-${index}`);
        let segment = checkpoint?.inputHash === inputHash ? segmentOutput(checkpoint.output) : null;
        if (checkpoint && !segment) throw new Error("已完成的 TTS provider 检查点损坏，禁止自动重复计费");
        if (segment) {
          const path = await controlledFile(dataRoot, segment.relativePath, segment);
          const measured = await probe(path);
          if (measured.bytes !== segment.bytes || measured.durationMs !== segment.durationMs) throw new Error("已完成的 TTS 分段媒体信息变化");
        } else {
          const path = join(directory, `segment-${String(index).padStart(4, "0")}-${inputHash}.wav`);
          await rm(path, { force: true });
          const cancellation = await cancellationSignal(context);
          let result: SynthesizeResult;
          try {
            result = await synthesize({ text: unit.speechText, outputPath: path, voiceId: snapshot.voiceId, rate: snapshot.rate,
              language: snapshot.language, signal: cancellation.signal, snapshot, runtime });
          } catch (error) {
            if (cancellation.signal.aborted || context.isCancellationRequested()) throw new JobCancelledError();
            throw error;
          } finally { cancellation.close(); }
          createdBeforeCheckpoint.push(path);
          const measured = await probe(path);
          segment = { relativePath: relativePath(dataRoot, path), bytes: measured.bytes, durationMs: measured.durationMs,
            hash: await sha256File(path), providerRequestId: result.providerRequestId?.trim() || null };
          await controlledFile(dataRoot, segment.relativePath, segment);
          context.commitCheckpoint("video-tts-provider", `segment-${index}`, inputHash, () => undefined, segment);
          createdBeforeCheckpoint.splice(createdBeforeCheckpoint.indexOf(path), 1);
        }
        segments.push(segment);
        context.reportProgress((index + 1) / (units.length + 3));
      }

      context.throwIfCancellationRequested();
      const audioPath = join(directory, `${snapshot.snapshotHash}.wav`);
      const segmentPaths = await Promise.all(segments.map((segment) => controlledFile(dataRoot, segment.relativePath, segment)));
      const normalizeHash = sha256Buffer(JSON.stringify(segments.map(({ hash, durationMs }) => ({ hash, durationMs }))));
      const normalizeCheckpoint = context.getCheckpoint("video-tts-normalize", snapshot.id);
      let audio: { relativePath: string; bytes: number; durationMs: number; hash: string } | null =
        normalizeCheckpoint?.inputHash === normalizeHash ? audioOutput(normalizeCheckpoint.output) : null;
      if (normalizeCheckpoint && !audio) throw new Error("已完成的音频规范化检查点损坏");
      if (!audio) {
        await withDataFileMutationLock(dataRoot, async () => durableWrite(audioPath, concatPcmWav(await Promise.all(segmentPaths.map((path) => readFile(path))))));
        const measured = await probe(audioPath);
        audio = { relativePath: relativePath(dataRoot, audioPath), bytes: measured.bytes, durationMs: measured.durationMs,
          hash: await sha256File(audioPath) };
        context.commitCheckpoint("video-tts-normalize", snapshot.id, normalizeHash, () => undefined, audio);
      } else {
        await controlledFile(dataRoot, audio.relativePath, audio);
      }
      context.reportProgress((units.length + 1) / (units.length + 3));

      let cursor = 0;
      const cues = units.map((unit, index): VideoTtsCue => {
        const cue = { index, paragraphId: unit.paragraphId, text: unit.subtitleText,
          startMs: cursor, endMs: cursor + segments[index]!.durationMs };
        cursor = cue.endMs;
        return { ...cue, hash: cueIdentity(cue) };
      });
      // ffprobe 对每段分别取整会产生毫秒级累计误差，最后一条只收口到整轨真实时长。
      const last = cues[cues.length - 1]!;
      last.endMs = audio.durationMs;
      last.hash = cueIdentity(last);
      if (cues.some((cue, index) => cue.startMs < 0 || cue.endMs <= cue.startMs || cue.endMs > audio.durationMs ||
          (index > 0 && cue.startMs !== cues[index - 1]!.endMs))) throw new Error("字幕 cue 与真实音频时长不一致");
      const cuesHash = sha256Buffer(JSON.stringify(cues));
      const rendered = renderSubtitleFiles(cues);
      const srtPath = join(directory, `${snapshot.snapshotHash}.srt`);
      const assPath = join(directory, `${snapshot.snapshotHash}.ass`);
      const subtitleHash = sha256Buffer(JSON.stringify({ cuesHash, srt: rendered.srt, ass: rendered.ass }));
      const subtitleCheckpoint = context.getCheckpoint("video-tts-subtitles", snapshot.id);
      let subtitles = subtitleCheckpoint?.inputHash === subtitleHash && subtitleCheckpoint.output &&
        typeof subtitleCheckpoint.output === "object" ? subtitleCheckpoint.output as {
          srt: { relativePath: string; bytes: number; hash: string }; ass: { relativePath: string; bytes: number; hash: string };
        } : null;
      if (subtitleCheckpoint && !subtitles) throw new Error("已完成的字幕检查点损坏");
      if (!subtitles) {
        await withDataFileMutationLock(dataRoot, async () => {
          await durableWrite(srtPath, rendered.srt);
          await durableWrite(assPath, rendered.ass);
        });
        const [srtInfo, assInfo] = await Promise.all([stat(srtPath), stat(assPath)]);
        subtitles = { srt: { relativePath: relativePath(dataRoot, srtPath), bytes: srtInfo.size, hash: await sha256File(srtPath) },
          ass: { relativePath: relativePath(dataRoot, assPath), bytes: assInfo.size, hash: await sha256File(assPath) } };
        context.commitCheckpoint("video-tts-subtitles", snapshot.id, subtitleHash, () => undefined, subtitles);
      }
      await Promise.all([controlledFile(dataRoot, subtitles.srt.relativePath, subtitles.srt),
        controlledFile(dataRoot, subtitles.ass.relativePath, subtitles.ass)]);
      context.reportProgress((units.length + 2) / (units.length + 3));

      context.throwIfCancellationRequested();
      if (!isVideoTtsSnapshotCurrent(database, snapshot)) throw new JobCancelledError();
      const artifactId = `vtta_${randomUUID()}`;
      const providerRequestId = [...new Set(segments.map((item) => item.providerRequestId).filter(Boolean))].join(",") || null;
      context.commitCheckpoint("video-tts-artifact", snapshot.id, sha256Buffer(JSON.stringify({
        snapshotHash: snapshot.snapshotHash, audioHash: audio.hash, cuesHash,
        srtHash: subtitles.srt.hash, assHash: subtitles.ass.hash,
      })), (transaction) => {
        // 旧任务只能保存自己的历史文件，不能在身份变化后登记为当前产物。
        if (!isVideoTtsSnapshotCurrent(database, snapshot)) throw new JobCancelledError();
        transaction.run(
          `INSERT INTO video_tts_artifacts (id,project_id,video_id,snapshot_id,snapshot_hash,job_id,provider_request_id,
           audio_relative_path,audio_mime,audio_codec,sample_rate,channels,audio_bytes,duration_ms,audio_hash,cues_hash,
           srt_relative_path,srt_bytes,srt_hash,ass_relative_path,ass_bytes,ass_hash,created_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
          artifactId, snapshot.projectId, snapshot.videoId, snapshot.id, snapshot.snapshotHash, context.job.id, providerRequestId,
          audio.relativePath, "audio/wav", "pcm_s16le", 22_050, 1, audio.bytes, audio.durationMs, audio.hash, cuesHash,
          subtitles.srt.relativePath, subtitles.srt.bytes, subtitles.srt.hash, subtitles.ass.relativePath, subtitles.ass.bytes,
          subtitles.ass.hash, Date.now());
        cues.forEach((cue) => transaction.run(
          `INSERT INTO video_tts_cues (artifact_id,video_id,cue_index,paragraph_id,text,start_ms,end_ms,cue_hash)
           VALUES (?,?,?,?,?,?,?,?)`, artifactId, snapshot.videoId, cue.index, cue.paragraphId, cue.text, cue.startMs, cue.endMs, cue.hash));
        return undefined;
      }, { artifactId });
      context.reportProgress(1);
      return { artifactId, snapshotId: snapshot.id, durationMs: audio.durationMs, cueCount: cues.length, reused: false };
    } finally {
      await Promise.all(createdBeforeCheckpoint.map((path) => rm(path, { force: true })));
    }
  };
}

export const videoTtsJobTestHelpers = { concatPcmWav, pcmPayload };
