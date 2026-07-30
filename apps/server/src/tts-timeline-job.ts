import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, open, readFile, rename, rm, stat } from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";
import type { DatabaseSync } from "node:sqlite";

import { JobCancelledError, type JobExecutionContext, type JobHandler } from "./job-worker.js";
import { readModelConfig, resolveRuntimeModelConfig, type RuntimeModelConfig } from "./model-config.js";
import { requireApprovedScriptForProduction } from "./script-approval-store.js";
import { getScriptVersion } from "./script-version-store.js";
import { renderSubtitleFiles, splitNarration, SUBTITLE_TIMELINE_CONTRACT } from "./subtitle-timeline.js";
import {
  probeSystemSpeechWav,
  synthesizeConfiguredTts,
  synthesizeSystemSpeech,
  ttsInputHash,
  TtsCancelledError,
  type SystemSpeechWavProbe,
  type TtsSynthesisInput,
  type TtsSynthesisResult,
} from "./tts-provider.js";
import { getCurrentTtsCalibration } from "./tts-calibration-job.js";

export { probeSystemSpeechWav } from "./tts-provider.js";

export const TTS_TIMELINE_JOB_TYPE = "tts_timeline";
const PROVIDER_ID = "windows-system-speech";
const DEFAULT_VOICE = "Microsoft Huihui Desktop";
interface TimelineDependencies {
  synthesize: (input: TtsSynthesisInput) => Promise<Awaited<ReturnType<typeof synthesizeSystemSpeech>>>;
  probe: (path: string, signal?: AbortSignal) => Promise<SystemSpeechWavProbe>;
  runtime: () => Promise<RuntimeModelConfig | null>;
}

interface SegmentArtifact extends SystemSpeechWavProbe {
  index: number;
  speechText: string;
  subtitleText: string;
  inputHash: string;
  relativePath: string;
  fileHash: string;
  reused: boolean;
  wordBoundaries?: TtsSynthesisResult["wordBoundaries"];
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

function absoluteArtifactPath(dataRoot: string, relativePath: string) {
  const root = resolve(dataRoot);
  const absolute = resolve(root, relativePath);
  if (absolute === root || !absolute.startsWith(`${root}${sep}`)) throw new Error("音频产物路径越界");
  return absolute;
}

function relativeArtifactPath(dataRoot: string, absolutePath: string) {
  return relative(resolve(dataRoot), absolutePath).split(sep).join("/");
}

function existingCues(database: DatabaseSync, timelineHash: string) {
  const rows = database.prepare(
    `SELECT cue_index, segment_index, start_ms, end_ms, text FROM subtitle_cues
     WHERE timeline_hash = ? ORDER BY cue_index ASC`,
  ).all(timelineHash) as Array<{ cue_index: number; segment_index: number; start_ms: number; end_ms: number; text: string }>;
  if (rows.length === 0) return null;
  return rows.map((row) => ({
    index: row.cue_index,
    segmentIndex: row.segment_index,
    startMs: row.start_ms,
    endMs: row.end_ms,
    text: row.text,
  }));
}

function taskPayload(value: unknown, defaults?: { voice: string; rate: number }) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("语音时间轴任务参数无效");
  const payload = value as { episodeId?: unknown; voice?: unknown; rate?: unknown };
  if (typeof payload.episodeId !== "string" || !/^[A-Za-z0-9_-]+$/.test(payload.episodeId)) {
    throw new Error("语音时间轴任务缺少有效分集 ID");
  }
  const voice = payload.voice === undefined ? defaults?.voice ?? DEFAULT_VOICE : payload.voice;
  const rate = payload.rate === undefined ? defaults?.rate ?? 0 : payload.rate;
  if (typeof voice !== "string" || !voice.trim() || !Number.isInteger(rate) || (rate as number) < -10 || (rate as number) > 10) {
    throw new Error("本机语音配置无效");
  }
  return { episodeId: payload.episodeId, voice: voice.trim(), rate: rate as number };
}

async function durableText(path: string, content: string) {
  try {
    if (await readFile(path, "utf8") !== content) throw new Error("已存在的字幕产物与时间轴身份不一致");
    return;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const temporary = `${path}.${randomUUID()}.tmp`;
  await mkdir(dirname(path), { recursive: true });
  try {
    const file = await open(temporary, "wx");
    try { await file.writeFile(content, "utf8"); await file.sync(); } finally { await file.close(); }
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}

export function createTtsTimelineJobHandler(
  database: DatabaseSync,
  dataRoot: string,
  dependencies: Partial<TimelineDependencies> = {},
): JobHandler {
  const synthesize = dependencies.synthesize ?? synthesizeConfiguredTts;
  const probe = dependencies.probe ?? probeSystemSpeechWav;
  const runtimeResolver = dependencies.runtime ?? (dependencies.synthesize
    ? async () => null
    : async () => resolveRuntimeModelConfig("tts", await readModelConfig(dataRoot)));
  return async (context: JobExecutionContext) => {
    const raw = taskPayload(context.job.payload);
    const selected = getCurrentTtsCalibration(database, raw.episodeId).selection;
    const { episodeId, voice, rate } = taskPayload(context.job.payload, selected);
    const runtime = await runtimeResolver();
    const effectiveProviderId = runtime?.providerId ?? PROVIDER_ID;
    const effectiveVoice = runtime?.voiceId || voice;
    const permit = requireApprovedScriptForProduction(database, episodeId, "tts");
    const script = getScriptVersion(database, permit.scriptVersionId);
    if (!script || script.kind !== "packaged") throw new Error("已批准的成片旁白稿不存在");
    const audioDirectory = resolve(dataRoot, "episodes", episodeId, "audio");
    await mkdir(resolve(audioDirectory, "segments"), { recursive: true });
    const segments: SegmentArtifact[] = [];

    const units = script.paragraphs.flatMap((paragraph) => splitNarration(paragraph.text));
    for (const [index, unit] of units.entries()) {
      context.throwIfCancellationRequested();
      const text = unit.speechText;
      const inputHash = ttsInputHash({ text, scriptVersionId: script.id, contentHash: script.contentHash, voice, rate, contractVersion: SUBTITLE_TIMELINE_CONTRACT, runtime });
      const path = resolve(audioDirectory, "segments", `${inputHash}.wav`);
      const relativePath = relativeArtifactPath(dataRoot, path);
      const stored = database.prepare(
        `SELECT relative_path, file_hash, bytes, duration_ms FROM audio_segments
         WHERE script_version_id = ? AND segment_index = ? AND input_hash = ? ORDER BY created_at DESC LIMIT 1`,
      ).get(script.id, index, inputHash) as { relative_path: string; file_hash: string; bytes: number; duration_ms: number } | undefined;
      let reused = false;
      let measured: SystemSpeechWavProbe | undefined;
      let synthesized: TtsSynthesisResult | undefined;
      if (stored) {
        if (stored.relative_path !== relativePath) throw new Error("已登记音频段路径不一致");
        measured = await probe(absoluteArtifactPath(dataRoot, stored.relative_path));
        if (measured.bytes !== stored.bytes || measured.durationMs !== stored.duration_ms ||
            await sha256File(path) !== stored.file_hash) throw new Error("已登记音频段文件已损坏");
        reused = true;
      } else {
        let orphanExists = true;
        try { await stat(path); } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") orphanExists = false;
          else throw error;
        }
        if (orphanExists) {
          try {
            measured = await probe(path);
            reused = true;
          } catch (error) {
            if (error instanceof JobCancelledError) throw error;
            await rm(path, { force: true });
            orphanExists = false;
          }
        }
        if (!orphanExists) {
          const controller = new AbortController();
          const poll = setInterval(() => { if (context.isCancellationRequested()) controller.abort(); }, 50);
          try {
            synthesized = await synthesize({ text, outputPath: path, scriptVersionId: script.id, contentHash: script.contentHash, voice, rate, contractVersion: SUBTITLE_TIMELINE_CONTRACT, runtime, signal: controller.signal });
          } catch (error) {
            if (error instanceof TtsCancelledError) throw new JobCancelledError();
            throw error;
          } finally {
            clearInterval(poll);
          }
          measured = await probe(path);
        }
      }
      if (!measured) throw new Error("音频段未生成有效探测结果");
      segments.push({ index, speechText: text, subtitleText: unit.subtitleText, inputHash, relativePath, fileHash: await sha256File(path), ...measured, reused, wordBoundaries: synthesized?.wordBoundaries });
      context.reportProgress((index + 1) / (units.length + 1));
    }

    context.throwIfCancellationRequested();
    const timelineHash = createHash("sha256").update(JSON.stringify({
      contract: SUBTITLE_TIMELINE_CONTRACT, scriptVersionId: script.id, voice: effectiveVoice, rate,
      provider: runtime ? {
        providerId: runtime.providerId,
        providerKind: runtime.providerKind,
        modelId: runtime.modelId,
        voiceId: runtime.voiceId,
        language: runtime.language,
      } : { providerId: PROVIDER_ID },
      segments: segments.map(({ inputHash, fileHash, durationMs }) => ({ inputHash, fileHash, durationMs })),
    })).digest("hex");
    let cursor = 0;
    const generatedCues = segments.flatMap((segment) => {
      const startMs = cursor;
      cursor += segment.durationMs;
      if (segment.wordBoundaries?.length) {
        const first = segment.wordBoundaries[0]!;
        const last = segment.wordBoundaries[segment.wordBoundaries.length - 1]!;
        return [{
          index: 0,
          segmentIndex: segment.index,
          text: segment.subtitleText,
          startMs: startMs + Math.min(first.startMs, segment.durationMs),
          endMs: startMs + Math.min(Math.max(last.endMs, first.startMs + 1), segment.durationMs),
        }];
      }
      return [{ index: 0, segmentIndex: segment.index, text: segment.subtitleText, startMs, endMs: cursor }];
    });
    const cues = (existingCues(database, timelineHash) ?? generatedCues).map((cue, index) => ({ ...cue, index }));
    const totalDurationMs = cursor;
    const srtPath = resolve(audioDirectory, `${timelineHash}.srt`);
    const assPath = resolve(audioDirectory, `${timelineHash}.ass`);
    const rendered = renderSubtitleFiles(cues);
    await durableText(srtPath, rendered.srt);
    await durableText(assPath, rendered.ass);
    context.throwIfCancellationRequested();
    const createdAt = Date.now();
    context.commitCheckpoint("tts-timeline", episodeId, timelineHash, (transaction) => {
      const current = requireApprovedScriptForProduction(database, episodeId, "tts");
      if (current.scriptVersionId !== permit.scriptVersionId || current.approvalRevision !== permit.approvalRevision) {
        throw new Error("语音生成期间批准稿已变化，本次结果不登记");
      }
      for (const segment of segments) transaction.run(
        `INSERT OR IGNORE INTO audio_segments (
          timeline_hash, segment_index, episode_id, script_version_id, text, provider_id, voice, rate,
          input_hash, relative_path, file_hash, bytes, duration_ms, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        timelineHash, segment.index, episodeId, script.id, segment.speechText, effectiveProviderId, effectiveVoice, rate,
        segment.inputHash, segment.relativePath, segment.fileHash, segment.bytes, segment.durationMs, createdAt);
      for (const cue of cues) transaction.run(
        `INSERT OR IGNORE INTO subtitle_cues (
          timeline_hash, cue_index, segment_index, episode_id, script_version_id, start_ms, end_ms, text
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        timelineHash, cue.index, cue.segmentIndex, episodeId, script.id, cue.startMs, cue.endMs, cue.text);
      return undefined;
    });
    context.reportProgress(1);
    return {
      episodeId, scriptVersionId: script.id, timelineHash, durationMs: totalDurationMs,
      segmentCount: segments.length, cueCount: cues.length,
      srtRelativePath: relativeArtifactPath(dataRoot, srtPath),
      assRelativePath: relativeArtifactPath(dataRoot, assPath),
      reusedSegments: segments.filter((segment) => segment.reused).length,
    };
  };
}
