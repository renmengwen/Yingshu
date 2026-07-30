import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, mkdir, readFile, realpath, stat } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";
import type { DatabaseSync } from "node:sqlite";

import { createJob, getJob, type CreateJobInput } from "./job-store.js";
import { JobCancelledError, type JobExecutionContext, type JobHandler } from "./job-worker.js";
import { readModelConfig, resolveRuntimeModelConfig, type RuntimeModelConfig } from "./model-config.js";
import { requireApprovedScriptForProduction } from "./script-approval-store.js";
import {
  probeSystemSpeechWav,
  synthesizeConfiguredTts,
  synthesizeSystemSpeech,
  ttsInputHash,
  TtsCancelledError,
  type TtsSynthesisInput,
} from "./tts-provider.js";

export const TTS_CALIBRATION_JOB_TYPE = "tts_calibration";
const CONTRACT = "tts-calibration-v1";
const DEFAULT_VOICE = "Microsoft Huihui Desktop";

interface CalibrationIdentity {
  episodeId: string;
  scriptVersionId: string;
  contentHash: string;
  approvalRevision: number;
}

interface GeneratePayload extends CalibrationIdentity {
  mode: "generate";
  exactText: string;
  textHash: string;
  characterCount: number;
  characterCountMethod: "unicode_code_points_nfkc";
  combinations: Array<{ voice: string; rate: number }>;
}

interface SelectPayload extends CalibrationIdentity {
  mode: "select";
  generateJobId: string;
  sampleId: string;
}

export interface TtsCalibrationSample {
  sampleId: string;
  inputHash: string;
  exactText: string;
  textHash: string;
  characterCount: number;
  characterCountMethod: "unicode_code_points_nfkc";
  durationMs: number;
  charactersPerSecond: number;
  voice: string;
  rate: number;
  providerId: string;
  relativePath: string;
  fileHash: string;
  bytes: number;
  episodeId: string;
  scriptVersionId: string;
  contentHash: string;
  approvalRevision: number;
}

interface GenerateResult extends CalibrationIdentity {
  mode: "generate";
  exactText: string;
  textHash: string;
  characterCount: number;
  characterCountMethod: "unicode_code_points_nfkc";
  samples: TtsCalibrationSample[];
}

export interface TtsCalibrationSelection extends CalibrationIdentity {
  mode: "select";
  generateJobId: string;
  sampleId: string;
  voice: string;
  rate: number;
  charactersPerSecond: number;
}

interface Dependencies {
  synthesize: (input: TtsSynthesisInput) => Promise<Awaited<ReturnType<typeof synthesizeSystemSpeech>>>;
  probe: typeof probeSystemSpeechWav;
  runtime: () => Promise<RuntimeModelConfig | null>;
}

function sha256(value: string | Buffer) {
  return createHash("sha256").update(value).digest("hex");
}

function sha256File(path: string) {
  return new Promise<string>((resolvePromise, reject) => {
    const hash = createHash("sha256");
    createReadStream(path).on("data", (chunk) => hash.update(chunk)).once("error", reject)
      .once("end", () => resolvePromise(hash.digest("hex")));
  });
}

function approvalIdentity(database: DatabaseSync, episodeId: string): CalibrationIdentity {
  const permit = requireApprovedScriptForProduction(database, episodeId, "tts");
  return permit;
}

function assertIdentity(database: DatabaseSync, identity: CalibrationIdentity) {
  const current = approvalIdentity(database, identity.episodeId);
  if (current.scriptVersionId !== identity.scriptVersionId || current.contentHash !== identity.contentHash ||
      current.approvalRevision !== identity.approvalRevision) {
    throw new Error("短样校准期间批准稿已变化，请重新生成");
  }
}

function codePointCount(text: string) {
  return [...text.normalize("NFKC")].length;
}

function sampleText(database: DatabaseSync, episodeId: string) {
  const episode = database.prepare("SELECT title, story_arc FROM episodes WHERE id = ?")
    .get(episodeId) as { title: string; story_arc: string } | undefined;
  if (!episode) throw new Error("分集不存在");
  const rows = database.prepare(
    `SELECT event.payload_json FROM episode_sources source
     JOIN chapter_events event ON event.id = source.source_event_id
     WHERE source.episode_id = ? ORDER BY source.source_index`,
  ).all(episodeId) as unknown as Array<{ payload_json: string }>;
  const terms: string[] = [];
  const add = (value: unknown) => {
    if (typeof value !== "string") return;
    const normalized = value.normalize("NFKC").trim().replace(/\s+/gu, " ");
    const length = [...normalized].length;
    if (length >= 2 && length <= 16 && !terms.includes(normalized)) terms.push(normalized);
  };
  add(episode.title);
  for (const row of rows) {
    try { Object.values(JSON.parse(row.payload_json) as Record<string, unknown>).forEach(add); } catch { /* 数据库事件由现有 Store 校验。 */ }
  }
  if (terms.length < 2) add(episode.story_arc.split(/[，。；！？]/u)[0]);
  const properNouns = terms.slice(0, 4).join("、") || "当前故事人物";
  return `夜色压下来，我沿着墓道继续往前。第3盏灯在21点07分熄灭；${properNouns}，都在这一刻出现。`.normalize("NFKC");
}

function generatePayload(database: DatabaseSync, value: unknown): GeneratePayload {
  const input = value && typeof value === "object" && !Array.isArray(value)
    ? value as { episodeId?: unknown; voice?: unknown; rate?: unknown }
    : {};
  if (typeof input.episodeId !== "string" || !/^[A-Za-z0-9_-]+$/u.test(input.episodeId)) {
    throw new Error("短样校准缺少有效分集 ID");
  }
  const voice = input.voice === undefined ? DEFAULT_VOICE : input.voice;
  const rate = input.rate === undefined ? 0 : input.rate;
  if (typeof voice !== "string" || !voice.trim() || !Number.isInteger(rate) || (rate as number) < -10 || (rate as number) > 10) {
    throw new Error("短样校准语音配置无效");
  }
  const identity = approvalIdentity(database, input.episodeId);
  const exactText = sampleText(database, input.episodeId);
  const normalizedRate = rate as number;
  return {
    mode: "generate",
    ...identity,
    exactText,
    textHash: sha256(exactText),
    characterCount: codePointCount(exactText),
    characterCountMethod: "unicode_code_points_nfkc",
    combinations: [
      { voice: voice.trim(), rate: normalizedRate },
      { voice: voice.trim(), rate: normalizedRate < 10 ? normalizedRate + 1 : normalizedRate - 1 },
    ],
  };
}

function succeededResult(database: DatabaseSync, jobId: string) {
  const job = getJob<unknown, GenerateResult | TtsCalibrationSelection>(database, jobId);
  if (!job || job.type !== TTS_CALIBRATION_JOB_TYPE || job.status !== "succeeded" || !job.result) {
    throw new Error("父短样生成任务不存在或尚未成功");
  }
  return job.result;
}

function selectPayload(database: DatabaseSync, value: unknown): SelectPayload {
  const input = value && typeof value === "object" && !Array.isArray(value)
    ? value as { episodeId?: unknown; generateJobId?: unknown; sampleId?: unknown }
    : {};
  if (typeof input.episodeId !== "string" || typeof input.generateJobId !== "string" || typeof input.sampleId !== "string") {
    throw new Error("短样选择参数无效");
  }
  const generated = succeededResult(database, input.generateJobId);
  if (generated.mode !== "generate" || generated.episodeId !== input.episodeId) throw new Error("短样不属于当前分集");
  if (!generated.samples.some((sample) => sample.sampleId === input.sampleId)) throw new Error("短样不属于父生成任务");
  assertIdentity(database, generated);
  return {
    mode: "select",
    episodeId: generated.episodeId,
    scriptVersionId: generated.scriptVersionId,
    contentHash: generated.contentHash,
    approvalRevision: generated.approvalRevision,
    generateJobId: input.generateJobId,
    sampleId: input.sampleId,
  };
}

export function enqueueTtsCalibrationJob(
  database: DatabaseSync,
  value: unknown,
  options: Pick<CreateJobInput, "priority" | "maxAttempts" | "runAfter"> = {},
) {
  const mode = value && typeof value === "object" && !Array.isArray(value) ? (value as { mode?: unknown }).mode : undefined;
  const payload = mode === "generate" ? generatePayload(database, value) : mode === "select" ? selectPayload(database, value) : undefined;
  if (!payload) throw new Error("短样校准操作无效");
  return createJob(database, { ...options, type: TTS_CALIBRATION_JOB_TYPE, payload });
}

function parsePayload(value: unknown): GeneratePayload | SelectPayload {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("短样校准冻结参数无效");
  const input = value as GeneratePayload | SelectPayload;
  if (input.mode !== "generate" && input.mode !== "select") throw new Error("短样校准冻结参数无效");
  return input;
}

function relativePath(dataRoot: string, path: string) {
  return relative(resolve(dataRoot), path).split(sep).join("/");
}

export function createTtsCalibrationJobHandler(
  database: DatabaseSync,
  dataRoot: string,
  dependencies: Partial<Dependencies> = {},
): JobHandler {
  const synthesize = dependencies.synthesize ?? synthesizeConfiguredTts;
  const probe = dependencies.probe ?? probeSystemSpeechWav;
  const runtimeResolver = dependencies.runtime ?? (dependencies.synthesize
    ? async () => null
    : async () => resolveRuntimeModelConfig("tts", await readModelConfig(dataRoot)));
  return async (context: JobExecutionContext) => {
    const payload = parsePayload(context.job.payload);
    assertIdentity(database, payload);
    const runtime = await runtimeResolver();
    if (payload.mode === "select") {
      const generated = succeededResult(database, payload.generateJobId);
      if (generated.mode !== "generate" || generated.episodeId !== payload.episodeId) throw new Error("父短样生成任务身份无效");
      const sample = generated.samples.find((item) => item.sampleId === payload.sampleId);
      if (!sample) throw new Error("短样不属于父生成任务");
      assertIdentity(database, payload);
      return {
        mode: "select" as const,
        episodeId: payload.episodeId,
        scriptVersionId: payload.scriptVersionId,
        contentHash: payload.contentHash,
        approvalRevision: payload.approvalRevision,
        generateJobId: payload.generateJobId,
        sampleId: sample.sampleId,
        voice: sample.voice,
        rate: sample.rate,
        charactersPerSecond: sample.charactersPerSecond,
      };
    }

    const directory = resolve(dataRoot, "episodes", payload.episodeId, "audio", "calibration");
    await mkdir(directory, { recursive: true });
    const samples: TtsCalibrationSample[] = [];
    const providerId = runtime?.providerId ?? "windows-system-speech";
    const providerVoice = runtime?.voiceId;
    const seenCombinations = new Set<string>();
    const combinations = payload.combinations.filter((combination) => {
      const voice = providerVoice || combination.voice;
      const key = `${providerId}:${voice}:${combination.rate}`;
      if (seenCombinations.has(key)) return false;
      seenCombinations.add(key);
      return true;
    });
    for (const [index, combination] of combinations.entries()) {
      context.throwIfCancellationRequested();
      const voice = providerVoice || combination.voice;
      const inputHash = ttsInputHash({
        text: payload.exactText,
        scriptVersionId: payload.scriptVersionId,
        contentHash: payload.contentHash,
        voice,
        rate: combination.rate,
        contractVersion: CONTRACT,
        runtime,
      });
      const outputPath = resolve(directory, `${inputHash}.wav`);
      let exists = true;
      try { await stat(outputPath); } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") exists = false;
        else throw error;
      }
      if (!exists) {
        const controller = new AbortController();
        const poll = setInterval(() => { if (context.isCancellationRequested()) controller.abort(); }, 50);
        try {
          await synthesize({
            text: payload.exactText,
            outputPath,
            scriptVersionId: payload.scriptVersionId,
            contentHash: payload.contentHash,
            voice,
            rate: combination.rate,
            contractVersion: CONTRACT,
            runtime,
            signal: controller.signal,
          });
        } catch (error) {
          if (error instanceof TtsCancelledError) throw new JobCancelledError();
          throw error;
        } finally { clearInterval(poll); }
      }
      const measured = await probe(outputPath);
      const charactersPerSecond = Number((payload.characterCount / (measured.durationMs / 1_000)).toFixed(6));
      samples.push({
        sampleId: `tts_sample_${inputHash}`,
        inputHash,
        exactText: payload.exactText,
        textHash: payload.textHash,
        characterCount: payload.characterCount,
        characterCountMethod: payload.characterCountMethod,
        durationMs: measured.durationMs,
        charactersPerSecond,
        voice,
        rate: combination.rate,
        providerId,
        relativePath: relativePath(dataRoot, outputPath),
        fileHash: await sha256File(outputPath),
        bytes: measured.bytes,
        episodeId: payload.episodeId,
        scriptVersionId: payload.scriptVersionId,
        contentHash: payload.contentHash,
        approvalRevision: payload.approvalRevision,
      });
      context.reportProgress((index + 1) / combinations.length);
    }
    context.throwIfCancellationRequested();
    assertIdentity(database, payload);
    return {
      mode: "generate" as const,
      episodeId: payload.episodeId,
      scriptVersionId: payload.scriptVersionId,
      contentHash: payload.contentHash,
      approvalRevision: payload.approvalRevision,
      exactText: payload.exactText,
      textHash: payload.textHash,
      characterCount: payload.characterCount,
      characterCountMethod: payload.characterCountMethod,
      samples,
    };
  };
}

function succeededCalibrationJobs(database: DatabaseSync) {
  // ponytail: 首版只扫描单一低频 Job 类型；校准历史显著增长后再增加专用 JSON 索引或物化表。
  const rows = database.prepare(
    `SELECT id, result_json FROM jobs
     WHERE type = ? AND status = 'succeeded' AND result_json IS NOT NULL
     ORDER BY finished_at DESC, created_at DESC, id DESC`,
  ).all(TTS_CALIBRATION_JOB_TYPE) as unknown as Array<{ id: string; result_json: string }>;
  return rows.flatMap((row) => {
    try { return [{ id: row.id, result: JSON.parse(row.result_json) as GenerateResult | TtsCalibrationSelection }]; }
    catch { return []; }
  });
}

export function getCurrentTtsCalibration(database: DatabaseSync, episodeId: string) {
  const identity = approvalIdentity(database, episodeId);
  const matches = succeededCalibrationJobs(database).filter(({ result }) =>
    result.episodeId === episodeId && result.scriptVersionId === identity.scriptVersionId &&
    result.contentHash === identity.contentHash && result.approvalRevision === identity.approvalRevision);
  const latest = matches[0];
  const selection = latest?.result.mode === "select" ? latest.result : undefined;
  const generationEntry = latest?.result.mode === "generate"
    ? latest
    : selection
      ? matches.find(({ id, result }) => id === selection.generateJobId && result.mode === "generate")
      : undefined;
  const generation = generationEntry?.result.mode === "generate" ? generationEntry.result : undefined;
  return {
    episodeId,
    generationJobId: generationEntry?.id,
    samples: generation?.samples ?? [],
    selection,
  };
}

export function requireMeasuredTtsCalibration(
  database: DatabaseSync,
  episodeId: string,
  input: { sampleId?: string; voice: string; rate: number; charactersPerSecond: number },
) {
  const current = getCurrentTtsCalibration(database, episodeId);
  const selected = current.selection;
  if (!selected || selected.sampleId !== input.sampleId || selected.voice !== input.voice || selected.rate !== input.rate ||
      selected.charactersPerSecond !== input.charactersPerSecond) {
    throw new Error("实测语速校准与当前已选短样不一致");
  }
  return selected;
}

export async function readVerifiedTtsCalibrationSample(
  database: DatabaseSync,
  dataRoot: string,
  episodeId: string,
  sampleId: string,
) {
  const workspace = getCurrentTtsCalibration(database, episodeId);
  const sample = workspace.samples.find((item) => item.sampleId === sampleId);
  if (!sample) throw new Error("短样不存在或已因批准稿变化而失效");
  const root = resolve(dataRoot);
  const absolute = resolve(root, sample.relativePath);
  const expected = resolve(root, "episodes", episodeId, "audio", "calibration", `${sample.inputHash}.wav`);
  if (absolute !== expected || !absolute.startsWith(`${root}${sep}`)) throw new Error("短样音频路径无效");
  const info = await lstat(absolute);
  if (!info.isFile() || info.size !== sample.bytes || resolve(await realpath(absolute)) !== absolute) {
    throw new Error("短样音频不是规范普通文件或大小已变化");
  }
  const bytes = await readFile(absolute);
  if (sha256(bytes) !== sample.fileHash || bytes.toString("ascii", 0, 4) !== "RIFF" ||
      bytes.toString("ascii", 8, 12) !== "WAVE") throw new Error("短样音频哈希或 WAV 边界无效");
  return bytes;
}
