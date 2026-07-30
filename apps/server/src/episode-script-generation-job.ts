import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

import type { ChapterTextModelConfig } from "./chapter-event-analyzer.js";
import { getEpisode } from "./episode-store.js";
import { createJob, getJob, type CreateJobInput, type JobRecord } from "./job-store.js";
import { JobCancelledError, type JobHandler } from "./job-worker.js";
import { mappedPipelineJobConcurrency, runConcurrent } from "./pipeline-job-concurrency.js";
import { createScriptVersionPair, createStandalonePackagedScriptVersion } from "./script-version-store.js";
import { requireMeasuredTtsCalibration } from "./tts-calibration-job.js";
import { PRODUCT_PROMPT_VERSIONS } from "./product-prompts.js";
import { textModelCallError, textModelResultError } from "./text-model-stream.js";

export const EPISODE_SCRIPT_GENERATION_JOB_TYPE = "episode_scripts_generate";
export const EPISODE_SCRIPT_GENERATION_LEGACY_CONTRACT_VERSION = 5;
export const EPISODE_SCRIPT_GENERATION_CONTRACT_VERSION = EPISODE_SCRIPT_GENERATION_LEGACY_CONTRACT_VERSION;
export const EPISODE_SCRIPT_GENERATION_V6_CONTRACT_VERSION = 6;
export const EPISODE_SCRIPT_MINIMUM_CHARACTER_RATIO = 0.9;
export const EPISODE_SCRIPT_MAXIMUM_CHARACTER_RATIO = 1.1;
export const EPISODE_SCRIPT_GENERATION_TIMEOUT_MS = 180_000;
export const EPISODE_SCRIPT_GENERATION_IDLE_TIMEOUT_MS = 180_000;
export const EPISODE_SCRIPT_GENERATION_TOTAL_TIMEOUT_MS = 900_000;

export interface EpisodeScriptGenerationRequest {
  seriesId: string;
  episodeIndex: number;
  voice: string;
  rate: number;
  charactersPerSecond: number;
  narrationOccupancy: number;
  calibration: { identity: "provisional" | "measured"; sampleId?: string };
  previousScriptHandoff?: ScriptHandoff | null;
}

export interface ScriptHandoff {
  summary: string;
  continuityNotes: string[];
}

interface FrozenSource {
  sourceIndex: number;
  chapterId: string;
  sourceEventId: string;
  byteStart: number;
  byteEnd: number;
  sourceHash: string;
  eventType: string;
  eventPayloadJson: string;
}

interface ScriptPromptSnapshot {
  skeletonProductVersion: typeof PRODUCT_PROMPT_VERSIONS.episodeSkeleton;
  beatProductVersion: typeof PRODUCT_PROMPT_VERSIONS.finishedNarrationBeat;
  profileRevision: number;
  profileHash: string;
  instructions: string;
}

interface FrozenPayload extends EpisodeScriptGenerationRequest {
  contractVersion: 5 | 6;
  episodeId: string;
  targetDurationSeconds: number;
  storyArc: string;
  recap: string | null;
  nextHook: string | null;
  sources: FrozenSource[];
  providerId: string;
  model: string;
  requestHash: string;
  prompt?: ScriptPromptSnapshot;
}

export interface ScriptBeat {
  intent: string;
  sourceIndexes: number[];
  targetDurationSeconds?: number;
}

interface SkeletonInput {
  stage: "skeleton";
  diagnosticStage?: string;
  episode: {
    id: string;
    storyArc: string;
    recap: string | null;
    nextHook: string | null;
    targetDurationSeconds: number;
  };
  characterBudget: number;
  calibration: FrozenPayload["calibration"];
  previousScriptHandoff?: ScriptHandoff | null;
  prompt?: ScriptPromptSnapshot;
  sources: Array<{
    sourceIndex: number;
    chapterId: string;
    sourceEventId: string;
    eventType: string;
    event: Record<string, string>;
  }>;
  correctionError?: string;
  onActivity?: () => void;
  signal: AbortSignal;
}

interface FaithfulInput {
  stage: "faithful";
  diagnosticStage?: string;
  beat: ScriptBeat;
  characterBudget: number;
  minimumCharacterCount: number;
  maximumCharacterCount: number;
  sources: Array<{ sourceIndex: number; sourceText: string }>;
  onActivity?: () => void;
  signal: AbortSignal;
}

interface FinishedInput extends Omit<FaithfulInput, "stage"> {
  stage: "finished";
  paragraphs: Array<{ text: string; sourceIndexes: number[] }>;
  correctionError?: string;
  previousParagraphs?: Array<{ text: string; sourceIndexes: number[] }>;
  prompt: ScriptPromptSnapshot;
}

interface PackagedInput {
  stage: "packaged";
  diagnosticStage?: string;
  targetDurationSeconds: number;
  characterBudget: number;
  minimumCharacterCount: number;
  maximumCharacterCount: number;
  paragraphs: Array<{ text: string; sourceIndexes: number[] }>;
  correctionError?: string;
  previousParagraphs?: Array<{ text: string; sourceIndexes: number[] }>;
  onActivity?: () => void;
  signal: AbortSignal;
}

export type GenerateEpisodeScript = (
  input: SkeletonInput | FaithfulInput | FinishedInput | PackagedInput,
) => Promise<{ beats: ScriptBeat[] } | { text: string } | { paragraphs: Array<{ text: string; sourceIndexes: number[] }> }>;

export interface EpisodeScriptGenerationContractOptions {
  version: 5 | 6;
  prompt?: ScriptPromptSnapshot;
}

function sha256(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

function text(value: unknown, label: string, max = 255) {
  if (typeof value !== "string" || !value.trim() || value.trim().length > max) throw new Error(`${label}无效`);
  return value.trim();
}

function validateRequest(input: EpisodeScriptGenerationRequest) {
  const seriesId = text(input.seriesId, "系列 ID");
  const voice = text(input.voice, "音色", 500);
  if (!Number.isSafeInteger(input.episodeIndex) || input.episodeIndex < 1) throw new Error("分集序号必须从 1 开始");
  if (!Number.isFinite(input.rate) || input.rate < -10 || input.rate > 10) throw new Error("语速必须在 -10 至 10 之间");
  if (!Number.isFinite(input.charactersPerSecond) || input.charactersPerSecond <= 0 || input.charactersPerSecond > 20) {
    throw new Error("每秒字数必须大于 0 且不超过 20");
  }
  if (!Number.isFinite(input.narrationOccupancy) || input.narrationOccupancy <= 0 || input.narrationOccupancy > 1) {
    throw new Error("旁白占用率必须大于 0 且不超过 1");
  }
  if (!input.calibration || (input.calibration.identity !== "provisional" && input.calibration.identity !== "measured")) {
    throw new Error("语速校准身份无效");
  }
  if (input.calibration.identity === "measured" && !input.calibration.sampleId?.trim()) {
    throw new Error("实测语速校准必须引用短样");
  }
  return {
    seriesId,
    episodeIndex: input.episodeIndex,
    voice,
    rate: input.rate,
    charactersPerSecond: input.charactersPerSecond,
    narrationOccupancy: input.narrationOccupancy,
    calibration: {
      identity: input.calibration.identity,
      ...(input.calibration.sampleId?.trim() ? { sampleId: input.calibration.sampleId.trim() } : {}),
    },
    previousScriptHandoff: input.previousScriptHandoff == null
      ? null
      : validateScriptHandoff(input.previousScriptHandoff),
  };
}

function validateScriptHandoff(value: unknown): ScriptHandoff {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("上一集交接信息无效");
  const handoff = value as Partial<ScriptHandoff>;
  if (!Array.isArray(handoff.continuityNotes) || handoff.continuityNotes.length > 12) {
    throw new Error("上一集连续性信息无效");
  }
  return {
    summary: text(handoff.summary, "上一集摘要", 800),
    continuityNotes: handoff.continuityNotes.map((note) => text(note, "上一集连续性信息", 240)),
  };
}

function clipped(value: string | null, maximum: number) {
  if (!value) return undefined;
  const normalized = value.replace(/\s+/gu, " ").trim();
  return normalized.length <= maximum ? normalized : `${normalized.slice(0, maximum - 1)}…`;
}

function createScriptHandoff(task: FrozenPayload, beats: ScriptBeat[]): ScriptHandoff {
  return {
    summary: clipped(task.storyArc, 800)!,
    continuityNotes: [
      clipped(task.nextHook, 240),
      ...beats.slice(-8).map((beat) => clipped(beat.intent, 240)),
    ].filter((note): note is string => Boolean(note)),
  };
}

function assertCalibration(database: DatabaseSync, episodeId: string, request: EpisodeScriptGenerationRequest) {
  if (request.calibration.identity === "measured") {
    requireMeasuredTtsCalibration(database, episodeId, {
      sampleId: request.calibration.sampleId,
      voice: request.voice,
      rate: request.rate,
      charactersPerSecond: request.charactersPerSecond,
    });
  }
}

function sourceIdentity(source: {
  sourceIndex: number; chapterId: string; sourceEventId: string;
  byteStart: number; byteEnd: number; sourceHash: string;
  eventType: string; eventPayloadJson: string;
}): FrozenSource {
  if (!Number.isSafeInteger(source.sourceIndex) || source.sourceIndex < 0 ||
      !Number.isSafeInteger(source.byteStart) || !Number.isSafeInteger(source.byteEnd) ||
      source.byteStart < 0 || source.byteEnd <= source.byteStart || !/^[0-9a-f]{64}$/u.test(source.sourceHash)) {
    throw new Error("长稿生成任务冻结来源无效");
  }
  const eventPayloadJson = text(source.eventPayloadJson, "结构化事件摘要", 1_000_000);
  if (canonicalJson(JSON.parse(eventPayloadJson) as unknown) !== eventPayloadJson) {
    throw new Error("结构化事件摘要必须使用 canonical JSON");
  }
  return {
    sourceIndex: source.sourceIndex,
    chapterId: text(source.chapterId, "来源章节 ID"),
    sourceEventId: text(source.sourceEventId, "来源事件 ID"),
    byteStart: source.byteStart,
    byteEnd: source.byteEnd,
    sourceHash: source.sourceHash,
    eventType: text(source.eventType, "事件类型"),
    eventPayloadJson,
  };
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`).join(",")}}`;
  }
  throw new Error("结构化事件摘要必须是可序列化 JSON");
}

function sourcesWithEvents(database: DatabaseSync, sources: Array<{
  sourceIndex: number; chapterId: string; sourceEventId: string;
  byteStart: number; byteEnd: number; sourceHash: string;
}>) {
  const rows = database.prepare(
    `SELECT id, event_type, payload_json FROM chapter_events
     WHERE id IN (${sources.map(() => "?").join(",")})`,
  ).all(...sources.map((source) => source.sourceEventId)) as unknown as Array<{
    id: string; event_type: string; payload_json: string;
  }>;
  const events = new Map(rows.map((row) => [row.id, row]));
  return sources.map((source) => {
    const event = events.get(source.sourceEventId);
    if (!event) throw new Error("分集来源对应的结构化事件已不存在");
    return sourceIdentity({
      ...source,
      eventType: event.event_type,
      eventPayloadJson: canonicalJson(JSON.parse(event.payload_json) as unknown),
    });
  });
}

function frozenIdentity(database: DatabaseSync, episode: Awaited<ReturnType<typeof getEpisode>>) {
  return {
    episodeId: episode.id,
    targetDurationSeconds: episode.targetDurationSeconds,
    storyArc: episode.storyArc,
    recap: episode.recap,
    nextHook: episode.nextHook,
    sources: sourcesWithEvents(database, episode.sources),
  };
}

function requestHash(input: Omit<FrozenPayload, "requestHash">) {
  return sha256(JSON.stringify(input));
}

function parseFrozenPayload(value: unknown): FrozenPayload {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("长稿生成任务冻结参数无效");
  const input = value as FrozenPayload;
  if (input.contractVersion !== EPISODE_SCRIPT_GENERATION_LEGACY_CONTRACT_VERSION &&
      input.contractVersion !== EPISODE_SCRIPT_GENERATION_V6_CONTRACT_VERSION) {
    throw new Error("长稿生成任务合同版本已过期");
  }
  const request = validateRequest(input);
  const episodeId = text(input.episodeId, "分集 ID");
  const providerId = text(input.providerId, "模型提供方", 100);
  const model = text(input.model, "模型", 150);
  const hash = text(input.requestHash, "请求哈希", 64).toLowerCase();
  if (!/^[0-9a-f]{64}$/u.test(hash) || !Array.isArray(input.sources) || input.sources.length === 0) {
    throw new Error("长稿生成任务冻结参数无效");
  }
  const payload: FrozenPayload = {
    ...request,
    contractVersion: input.contractVersion,
    episodeId,
    targetDurationSeconds: input.targetDurationSeconds,
    storyArc: text(input.storyArc, "故事弧", 100_000),
    recap: input.recap === null ? null : text(input.recap, "前情回顾", 100_000),
    nextHook: input.nextHook === null ? null : text(input.nextHook, "下集钩子", 100_000),
    sources: input.sources.map(sourceIdentity),
    providerId,
    model,
    requestHash: hash,
    ...(input.prompt ? { prompt: input.prompt } : {}),
  };
  if (payload.contractVersion === 6 && (!payload.prompt ||
      payload.prompt.skeletonProductVersion !== PRODUCT_PROMPT_VERSIONS.episodeSkeleton ||
      payload.prompt.beatProductVersion !== PRODUCT_PROMPT_VERSIONS.finishedNarrationBeat ||
      !Number.isSafeInteger(payload.prompt.profileRevision) || payload.prompt.profileRevision < 1 ||
      !/^[0-9a-f]{64}$/u.test(payload.prompt.profileHash) || typeof payload.prompt.instructions !== "string" ||
      payload.prompt.instructions.length > 40_000)) {
    throw new Error("成片旁白 v6 提示词快照无效");
  }
  if (payload.contractVersion === 5 && payload.prompt) throw new Error("历史稿件任务不能携带 v6 提示词快照");
  const { requestHash: _ignored, ...identity } = payload;
  if (requestHash(identity) !== hash) {
    throw new Error("长稿生成任务冻结身份不一致");
  }
  return payload;
}

async function requireCurrentEpisode(
  database: DatabaseSync,
  dataRoot: string,
  task: FrozenPayload,
) {
  const current = await getEpisode(database, dataRoot, task.seriesId, task.episodeIndex);
  if (JSON.stringify(frozenIdentity(database, current)) !== JSON.stringify({
    episodeId: task.episodeId,
    targetDurationSeconds: task.targetDurationSeconds,
    storyArc: task.storyArc,
    recap: task.recap,
    nextHook: task.nextHook,
    sources: task.sources,
  })) throw new Error("分集、目标时长或来源在任务排队后已变化，请重新生成");
  return current;
}

function assertCurrentDatabaseIdentity(database: DatabaseSync, task: FrozenPayload) {
  const row = database.prepare(
    `SELECT id, story_arc, target_duration_seconds, recap, next_hook
     FROM episodes WHERE series_project_id = ? AND episode_index = ?`,
  ).get(task.seriesId, task.episodeIndex) as {
    id: string; story_arc: string; target_duration_seconds: number;
    recap: string | null; next_hook: string | null;
  } | undefined;
  if (!row) throw new Error("分集在任务排队后已不存在");
  const sources = database.prepare(
    `SELECT source_index, chapter_id, source_event_id, source_byte_start, source_byte_end, source_hash
     FROM episode_sources WHERE episode_id = ? ORDER BY source_index`,
  ).all(row.id) as unknown as Array<{
    source_index: number; chapter_id: string; source_event_id: string;
    source_byte_start: number; source_byte_end: number; source_hash: string;
  }>;
  const current = {
    episodeId: row.id,
    targetDurationSeconds: row.target_duration_seconds,
    storyArc: row.story_arc,
    recap: row.recap,
    nextHook: row.next_hook,
    sources: sourcesWithEvents(database, sources.map((source) => ({
      sourceIndex: source.source_index,
      chapterId: source.chapter_id,
      sourceEventId: source.source_event_id,
      byteStart: source.source_byte_start,
      byteEnd: source.source_byte_end,
      sourceHash: source.source_hash,
    }))),
  };
  if (JSON.stringify(current) !== JSON.stringify({
    episodeId: task.episodeId,
    targetDurationSeconds: task.targetDurationSeconds,
    storyArc: task.storyArc,
    recap: task.recap,
    nextHook: task.nextHook,
    sources: task.sources,
  })) throw new Error("分集、目标时长、来源或事件摘要在任务排队后已变化，请重新生成");
}

class EpisodeScriptSkeletonContractError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EpisodeScriptSkeletonContractError";
  }
}

function validateBeats(value: unknown, sources: readonly FrozenSource[], targetDurationSeconds: number): ScriptBeat[] {
  try {
    return validateBeatsContract(value, sources, targetDurationSeconds);
  } catch (error) {
    if (error instanceof EpisodeScriptSkeletonContractError) throw error;
    throw new EpisodeScriptSkeletonContractError(error instanceof Error ? error.message : "故事骨架无效");
  }
}

function validateBeatsContract(value: unknown, sources: readonly FrozenSource[], targetDurationSeconds: number): ScriptBeat[] {
  if (!Array.isArray(value) || value.length === 0) throw new Error("骨架必须包含至少一个故事 beat");
  const available = new Set(sources.map((source) => source.sourceIndex));
  const used = new Set<number>();
  let previous = -1;
  let allocatedDuration = 0;
  const beats = value.map((candidate) => {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) throw new Error("故事 beat 无效");
    const beat = candidate as ScriptBeat;
    const intent = text(beat.intent, "故事 beat 意图", 10_000);
    if (!Array.isArray(beat.sourceIndexes) || beat.sourceIndexes.length === 0 ||
        new Set(beat.sourceIndexes).size !== beat.sourceIndexes.length) {
      throw new Error("故事 beat 必须引用非空且不重复的来源序号");
    }
    for (const index of beat.sourceIndexes) {
      if (!Number.isSafeInteger(index) || !available.has(index) || used.has(index)) {
        throw new Error("故事 beat 返回了伪造、越界或重复的来源序号");
      }
      if (index <= previous) throw new Error("故事 beat 来源顺序无效");
      previous = index;
      used.add(index);
    }
    if (beat.targetDurationSeconds !== undefined) {
      if (!Number.isFinite(beat.targetDurationSeconds) || beat.targetDurationSeconds <= 0 ||
          beat.targetDurationSeconds > targetDurationSeconds) throw new Error("故事 beat 时长预算无效");
      allocatedDuration += beat.targetDurationSeconds;
      if (allocatedDuration > targetDurationSeconds) throw new Error("故事 beat 总时长超过分集目标时长");
    }
    return {
      intent,
      sourceIndexes: [...beat.sourceIndexes],
      ...(beat.targetDurationSeconds === undefined ? {} : { targetDurationSeconds: beat.targetDurationSeconds }),
    };
  });
  if (used.size !== sources.length) throw new Error("故事骨架必须明确覆盖全部冻结来源");
  return beats;
}

function validateTextResult(value: unknown, label: string) {
  const textValue = (value as { text?: unknown })?.text;
  return text(textValue, label, 1_000_000);
}

function validatePackagedResult(value: unknown, allowed: ReadonlySet<number>) {
  const paragraphs = (value as { paragraphs?: unknown })?.paragraphs;
  if (!Array.isArray(paragraphs) || paragraphs.length === 0) throw new Error("成片旁白稿必须包含至少一个段落");
  return paragraphs.map((candidate) => {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) throw new Error("成片旁白稿段落无效");
    const paragraph = candidate as { text?: unknown; sourceIndexes?: unknown };
    if (!Array.isArray(paragraph.sourceIndexes) || paragraph.sourceIndexes.length === 0 ||
        new Set(paragraph.sourceIndexes).size !== paragraph.sourceIndexes.length ||
        paragraph.sourceIndexes.some((index) => !Number.isSafeInteger(index) || !allowed.has(index))) {
      throw new Error("成片旁白稿引用了对应原著还原稿之外的来源");
    }
    return { text: text(paragraph.text, "成片旁白稿正文", 1_000_000), sourceIndexes: paragraph.sourceIndexes as number[] };
  });
}

function validateFinishedBeatResult(value: unknown, beat: ScriptBeat) {
  const paragraphs = validatePackagedResult(value, new Set(beat.sourceIndexes));
  const covered = new Set(paragraphs.flatMap((paragraph) => paragraph.sourceIndexes));
  if (covered.size !== beat.sourceIndexes.length || beat.sourceIndexes.some((index) => !covered.has(index))) {
    throw new Error("成片旁白 beat 必须覆盖当前 beat 的全部冻结来源");
  }
  return paragraphs;
}

function finishedBeatOutputHash(paragraphs: Array<{ text: string; sourceIndexes: number[] }>) {
  return sha256(canonicalJson({ paragraphs }));
}

function scriptCharacterLimits(characterBudget: number) {
  const minimumCharacterCount = Math.max(1, Math.floor(characterBudget * EPISODE_SCRIPT_MINIMUM_CHARACTER_RATIO));
  const maximumCharacterCount = Math.max(minimumCharacterCount,
    Math.ceil(characterBudget * EPISODE_SCRIPT_MAXIMUM_CHARACTER_RATIO));
  return { minimumCharacterCount, maximumCharacterCount };
}

class CorrectableScriptError extends Error {}

function validateScriptLength(
  label: string,
  paragraphs: ReadonlyArray<{ text: string }>,
  limits: ReturnType<typeof scriptCharacterLimits>,
) {
  const actualCharacterCount = paragraphs.reduce((sum, paragraph) => sum + [...paragraph.text].length, 0);
  if (actualCharacterCount < limits.minimumCharacterCount) {
    throw new CorrectableScriptError(`${label}字数不足：实际 ${actualCharacterCount} 字，至少需要 ${limits.minimumCharacterCount} 字`);
  }
  if (actualCharacterCount > limits.maximumCharacterCount) {
    throw new CorrectableScriptError(`${label}字数过多：实际 ${actualCharacterCount} 字，最多允许 ${limits.maximumCharacterCount} 字`);
  }
  return actualCharacterCount;
}

function trimTrailingPunctuationToLimit<T extends { text: string }>(paragraphs: T[], maximumCharacterCount: number) {
  let overflow = paragraphs.reduce((sum, paragraph) => sum + [...paragraph.text].length, 0) - maximumCharacterCount;
  if (overflow <= 0) return paragraphs;
  const trimmed = paragraphs.map((paragraph) => ({ ...paragraph }));
  for (let index = trimmed.length - 1; index >= 0 && overflow > 0; index -= 1) {
    const characters = [...trimmed[index]!.text];
    // ponytail: only discard trailing non-spoken punctuation; add another model correction only if real prose overflows recur.
    while (overflow > 0 && characters.length > 1 && /[\p{P}\p{Z}]/u.test(characters.at(-1)!)) {
      characters.pop();
      overflow -= 1;
    }
    trimmed[index]!.text = characters.join("");
  }
  return overflow === 0 ? trimmed : paragraphs;
}

function validatePackagedDifference(
  faithfulParagraphs: ReadonlyArray<{ text: string }>,
  packagedParagraphs: ReadonlyArray<{ text: string }>,
) {
  if (faithfulParagraphs.length === packagedParagraphs.length &&
      faithfulParagraphs.every((paragraph, index) => paragraph.text === packagedParagraphs[index]?.text)) {
    throw new CorrectableScriptError("成片旁白稿与原著还原稿正文完全相同，必须进行面向成片配音的实际改写");
  }
}

async function callWithCancellation<T>(
  context: Parameters<JobHandler>[0],
  call: (signal: AbortSignal, onActivity: () => void) => Promise<T>,
  groupSignal?: AbortSignal,
) {
  context.throwIfCancellationRequested();
  const controller = new AbortController();
  const idleController = new AbortController();
  const totalController = new AbortController();
  const poll = setInterval(() => { if (context.isCancellationRequested()) controller.abort(); }, 50);
  let idle = setTimeout(() => idleController.abort(new DOMException("idle timeout", "TimeoutError")),
    EPISODE_SCRIPT_GENERATION_TIMEOUT_MS);
  const total = setTimeout(() => totalController.abort(new DOMException("total timeout", "TimeoutError")),
    EPISODE_SCRIPT_GENERATION_TOTAL_TIMEOUT_MS);
  const onActivity = () => {
    clearTimeout(idle);
    idle = setTimeout(() => idleController.abort(new DOMException("idle timeout", "TimeoutError")),
      EPISODE_SCRIPT_GENERATION_IDLE_TIMEOUT_MS);
  };
  try {
    return await call(AbortSignal.any([
      controller.signal,
      idleController.signal,
      totalController.signal,
      ...(groupSignal ? [groupSignal] : []),
    ]), onActivity);
  } catch (error) {
    if (controller.signal.aborted || context.isCancellationRequested()) throw new JobCancelledError();
    if (groupSignal?.aborted) throw groupSignal.reason ?? error;
    if (error instanceof Error && error.name === "TimeoutError") {
      throw new Error("长稿生成模型请求超时", { cause: error });
    }
    throw error;
  } finally {
    clearInterval(poll);
    clearTimeout(idle);
    clearTimeout(total);
  }
}

async function callTextModel<T>(
  context: Parameters<JobHandler>[0],
  stage: string,
  call: (signal: AbortSignal, onActivity: () => void) => Promise<T>,
  groupSignal?: AbortSignal,
) {
  try {
    return await callWithCancellation(context, call, groupSignal);
  } catch (error) {
    if (error instanceof JobCancelledError) throw error;
    throw textModelCallError(error, stage);
  }
}

export async function enqueueEpisodeScriptGenerationJob(
  database: DatabaseSync,
  dataRoot: string,
  config: ChapterTextModelConfig,
  input: Omit<CreateJobInput, "id" | "type">,
  isStillAllowed: () => boolean = () => true,
  contract: EpisodeScriptGenerationContractOptions = {
    version: EPISODE_SCRIPT_GENERATION_LEGACY_CONTRACT_VERSION,
  },
): Promise<{ job: JobRecord; created: boolean }> {
  const request = validateRequest(input.payload as EpisodeScriptGenerationRequest);
  const episode = await getEpisode(database, dataRoot, request.seriesId, request.episodeIndex);
  if (episode.sources.length === 0) throw new Error("分集没有可用于生成长稿的冻结来源");
  assertCalibration(database, episode.id, request);
  const payloadWithoutHash: Omit<FrozenPayload, "requestHash"> = {
    ...request,
    contractVersion: contract.version,
    ...frozenIdentity(database, episode),
    providerId: text(config.providerId, "模型提供方", 100),
    model: text(config.model, "模型", 150),
    ...(contract.prompt ? { prompt: contract.prompt } : {}),
  };
  const hash = requestHash(payloadWithoutHash);
  const payload: FrozenPayload = { ...payloadWithoutHash, requestHash: hash };
  const id = `job_episode_scripts_${hash}`;
  if (!isStillAllowed()) throw new Error("全本流水线已暂停或结束，未派发稿件任务");
  const existing = getJob(database, id);
  if (existing) {
    if (existing.type !== EPISODE_SCRIPT_GENERATION_JOB_TYPE || JSON.stringify(existing.payload) !== JSON.stringify(payload)) {
      throw new Error("长稿生成任务身份冲突");
    }
    return { job: existing, created: false };
  }
  try {
    return {
      job: createJob(database, { ...input, id, type: EPISODE_SCRIPT_GENERATION_JOB_TYPE, payload }),
      created: true,
    };
  } catch (error) {
    const raced = getJob(database, id);
    if (!raced || raced.type !== EPISODE_SCRIPT_GENERATION_JOB_TYPE ||
        JSON.stringify(raced.payload) !== JSON.stringify(payload)) throw error;
    return { job: raced, created: false };
  }
}

export function createEpisodeScriptGenerationJobHandler(
  database: DatabaseSync,
  dataRoot: string,
  config: ChapterTextModelConfig,
  generate: GenerateEpisodeScript,
): JobHandler {
  return async (context) => {
    const task = parseFrozenPayload(context.job.payload);
    if (context.job.id !== `job_episode_scripts_${task.requestHash}` ||
        task.providerId !== config.providerId.trim() || task.model !== config.model.trim()) {
      throw new Error("长稿生成任务或模型冻结身份不一致");
    }
    const episode = await requireCurrentEpisode(database, dataRoot, task);
    assertCalibration(database, task.episodeId, task);
    const characterBudget = Math.floor(task.targetDurationSeconds * task.charactersPerSecond * task.narrationOccupancy);
    const characterLimits = scriptCharacterLimits(characterBudget);
    const skeletonInput: Omit<SkeletonInput, "signal" | "onActivity" | "correctionError"> = {
      stage: "skeleton",
      episode: {
        id: task.episodeId,
        storyArc: task.storyArc,
        recap: task.recap,
        nextHook: task.nextHook,
        targetDurationSeconds: task.targetDurationSeconds,
      },
      characterBudget,
      calibration: task.calibration,
      previousScriptHandoff: task.previousScriptHandoff ?? null,
      ...(task.prompt ? { prompt: task.prompt } : {}),
      sources: task.sources.map((source) => ({
        sourceIndex: source.sourceIndex,
        chapterId: source.chapterId,
        sourceEventId: source.sourceEventId,
        eventType: source.eventType,
        event: JSON.parse(source.eventPayloadJson) as Record<string, string>,
      })),
    };
    const generateSkeleton = (correctionError?: string) => {
      const stage = `episode-script.skeleton.${correctionError ? "correction-1" : "initial"}`;
      return callTextModel(context, stage, (signal, onActivity) => generate({
        ...skeletonInput,
        ...(correctionError ? { correctionError } : {}),
        diagnosticStage: stage,
        signal,
        onActivity,
      }));
    };
    const skeletonResult = await generateSkeleton();
    let beats: ScriptBeat[];
    try {
      beats = validateBeats((skeletonResult as { beats?: unknown }).beats, task.sources, task.targetDurationSeconds);
    } catch (error) {
      if (!(error instanceof EpisodeScriptSkeletonContractError)) {
        throw textModelResultError(error, "episode-script.skeleton.initial", skeletonResult as object);
      }
      const corrected = await generateSkeleton(error.message);
      try {
        beats = validateBeats((corrected as { beats?: unknown }).beats, task.sources, task.targetDurationSeconds);
      } catch (correctionError) {
        throw textModelResultError(
          correctionError,
          "episode-script.skeleton.correction-1",
          corrected as object,
        );
      }
    }
    context.reportProgress(0.2);

    if (task.contractVersion === EPISODE_SCRIPT_GENERATION_V6_CONTRACT_VERSION) {
      const sourceMap = new Map(episode.sources.map((source) => [source.sourceIndex, source]));
      const paragraphsByBeat = new Array<Array<{ text: string; sourceIndexes: number[] }>>(beats.length);
      const groupController = new AbortController();
      let completed = 0;
      await runConcurrent(
        beats.map((_, index) => index),
        mappedPipelineJobConcurrency(database, context.job.id, "script_generation"),
        async (index) => {
          const beat = beats[index]!;
          const beatCharacterBudget = Math.max(1, Math.floor(characterBudget * ((beat.targetDurationSeconds ??
            task.targetDurationSeconds / beats.length) / task.targetDurationSeconds)));
          const limits = scriptCharacterLimits(beatCharacterBudget);
          const inputHash = sha256(canonicalJson({
            contractVersion: task.contractVersion,
            prompt: task.prompt,
            episodeRequestHash: task.requestHash,
            beatIndex: index,
            beat,
            sources: beat.sourceIndexes.map((sourceIndex) => {
              const source = task.sources.find((candidate) => candidate.sourceIndex === sourceIndex)!;
              return { sourceIndex, sourceHash: source.sourceHash, byteStart: source.byteStart, byteEnd: source.byteEnd };
            }),
            characterBudget: beatCharacterBudget,
            limits,
            providerId: task.providerId,
            model: task.model,
          }));
          const scopeKey = `${task.episodeId}:${index}`;
          const checkpoint = context.getCheckpoint("episode-script-finished-beat", scopeKey);
          if (checkpoint?.inputHash === inputHash && checkpoint.output !== undefined) {
            const output = checkpoint.output as { paragraphs?: unknown; outputHash?: unknown };
            const restored = validateFinishedBeatResult({ paragraphs: output.paragraphs }, beat);
            if (output.outputHash !== finishedBeatOutputHash(restored)) {
              throw new Error(`第 ${index + 1} 个成片旁白 beat checkpoint 输出 hash 不一致`);
            }
            validateScriptLength(`第 ${index + 1} 个成片旁白 beat`, restored, limits);
            paragraphsByBeat[index] = restored;
            completed += 1;
            context.reportProgress(0.2 + (completed / beats.length) * 0.7);
            return;
          }
          const base: Omit<FinishedInput, "signal" | "onActivity" | "correctionError" | "previousParagraphs"> = {
            stage: "finished",
            paragraphs: [],
            beat,
            characterBudget: beatCharacterBudget,
            ...limits,
            sources: beat.sourceIndexes.map((sourceIndex) => ({
              sourceIndex,
              sourceText: sourceMap.get(sourceIndex)!.sourceText,
            })),
            prompt: task.prompt!,
          };
          const generateBeat = (correctionError?: string,
            previousParagraphs?: Array<{ text: string; sourceIndexes: number[] }>) => {
            const stage = `episode-script.finished.beat-${index + 1}.${correctionError ? "correction-1" : "initial"}`;
            return callTextModel(context, stage, (signal, onActivity) => generate({
              ...base,
              ...(correctionError ? { correctionError } : {}),
              ...(previousParagraphs ? { previousParagraphs } : {}),
              diagnosticStage: stage,
              signal,
              onActivity,
            }), groupController.signal);
          };
          try {
            let result = await generateBeat();
            let restored: Array<{ text: string; sourceIndexes: number[] }>;
            try {
              restored = validateFinishedBeatResult(result, beat);
              validateScriptLength(`第 ${index + 1} 个成片旁白 beat`, restored, limits);
            } catch (error) {
              const previous = (() => {
                try { return validateFinishedBeatResult(result, beat); } catch { return undefined; }
              })();
              result = await generateBeat(error instanceof Error ? error.message : "输出合同无效", previous);
              try {
                restored = validateFinishedBeatResult(result, beat);
                restored = trimTrailingPunctuationToLimit(restored, limits.maximumCharacterCount);
                validateScriptLength(`第 ${index + 1} 个成片旁白 beat`, restored, limits);
              } catch (correctionError) {
                throw textModelResultError(
                  correctionError,
                  `episode-script.finished.beat-${index + 1}.correction-1`,
                  result as object,
                );
              }
            }
            paragraphsByBeat[index] = restored;
            context.throwIfCancellationRequested();
            context.commitCheckpoint("episode-script-finished-beat", scopeKey, inputHash, () => undefined, {
              paragraphs: restored,
              outputHash: finishedBeatOutputHash(restored),
            });
            completed += 1;
            context.reportProgress(0.2 + (completed / beats.length) * 0.7);
          } catch (error) {
            groupController.abort(error);
            throw error;
          }
        },
      );
      const finishedParagraphs = paragraphsByBeat.flatMap((paragraphs) => paragraphs);
      let actualCharacterCount: number;
      try {
        actualCharacterCount = validateScriptLength("成片旁白稿", finishedParagraphs, characterLimits);
      } catch (error) {
        throw textModelCallError(error, "episode-script.finished.aggregate");
      }
      await requireCurrentEpisode(database, dataRoot, task);
      context.throwIfCancellationRequested();
      const packaged = createStandalonePackagedScriptVersion(database, task.episodeId, finishedParagraphs, () => {
        context.throwIfCancellationRequested();
        assertCurrentDatabaseIdentity(database, task);
        assertCalibration(database, task.episodeId, task);
      });
      context.reportProgress(1);
      return {
        contractVersion: task.contractVersion,
        episodeId: task.episodeId,
        beats,
        characterBudget,
        ...characterLimits,
        calibration: task.calibration,
        packagedVersionId: packaged.id,
        finishedNarrationVersionId: packaged.id,
        actualCharacterCount,
        compressionSuggested: actualCharacterCount > characterBudget,
        scriptHandoff: createScriptHandoff(task, beats),
      };
    }

    const sourceMap = new Map(episode.sources.map((source) => [source.sourceIndex, source]));
    const faithfulParagraphs = new Array<{ text: string; sourceIndexes: number[] }>(beats.length);
    const groupController = new AbortController();
    let faithfulCompleted = 0;
    await runConcurrent(
      beats.map((_, index) => index),
      mappedPipelineJobConcurrency(database, context.job.id, "script_generation"),
      async (index) => {
        const beat = beats[index]!;
        const beatCharacterBudget = Math.max(1, Math.floor(characterBudget * ((beat.targetDurationSeconds ??
          task.targetDurationSeconds / beats.length) / task.targetDurationSeconds)));
        try {
          const stage = `episode-script.faithful.beat-${index + 1}.initial`;
          const result = await callTextModel(context, stage, (signal, onActivity) => generate({
            stage: "faithful",
            diagnosticStage: stage,
            beat,
            characterBudget: beatCharacterBudget,
            ...scriptCharacterLimits(beatCharacterBudget),
            sources: beat.sourceIndexes.map((sourceIndex) => ({
              sourceIndex,
              sourceText: sourceMap.get(sourceIndex)!.sourceText,
            })),
            signal,
            onActivity,
          }), groupController.signal);
          try {
            faithfulParagraphs[index] = {
              text: validateTextResult(result, "原著还原稿正文"),
              sourceIndexes: beat.sourceIndexes,
            };
          } catch (error) {
            throw textModelResultError(error, stage, result as object);
          }
          faithfulCompleted += 1;
          context.reportProgress(0.2 + (faithfulCompleted / beats.length) * 0.4);
        } catch (error) {
          groupController.abort(error);
          throw error;
        }
      },
    );
    let faithfulCharacterCount: number;
    try {
      faithfulCharacterCount = validateScriptLength("原著还原稿", faithfulParagraphs, characterLimits);
    } catch (error) {
      throw textModelCallError(error, "episode-script.faithful.aggregate");
    }

    const faithfulSources = new Set(faithfulParagraphs.flatMap((paragraph) => paragraph.sourceIndexes));
    const packagedInput: Omit<PackagedInput, "signal" | "onActivity" | "correctionError" | "previousParagraphs"> = {
      stage: "packaged",
      targetDurationSeconds: task.targetDurationSeconds,
      characterBudget,
      ...characterLimits,
      paragraphs: faithfulParagraphs,
    };
    const generatePackaged = (
      correctionError?: string,
      previousParagraphs?: Array<{ text: string; sourceIndexes: number[] }>,
      correctionAttempt = 0,
    ) => {
      const stage = `episode-script.packaged.${correctionAttempt === 0 ? "initial" : `correction-${correctionAttempt}`}`;
      return callTextModel(context, stage, (signal, onActivity) => generate({
        ...packagedInput,
        ...(correctionError ? { correctionError } : {}),
        ...(previousParagraphs ? { previousParagraphs } : {}),
        diagnosticStage: stage,
        signal,
        onActivity,
      }));
    };
    let packagedResult = await generatePackaged();
    let packagedParagraphs: Array<{ text: string; sourceIndexes: number[] }>;
    try {
      packagedParagraphs = validatePackagedResult(packagedResult, faithfulSources);
    } catch (error) {
      throw textModelResultError(error, "episode-script.packaged.initial", packagedResult as object);
    }
    let actualCharacterCount: number;
    for (let correctionAttempt = 0; ; correctionAttempt += 1) {
      try {
        validatePackagedDifference(faithfulParagraphs, packagedParagraphs);
        actualCharacterCount = validateScriptLength("成片旁白稿", packagedParagraphs, characterLimits);
        break;
      } catch (error) {
        const stage = `episode-script.packaged.${correctionAttempt === 0 ? "initial" : `correction-${correctionAttempt}`}`;
        if (!(error instanceof CorrectableScriptError) || correctionAttempt >= 2) {
          throw textModelResultError(error, stage, packagedResult as object);
        }
        const nextAttempt = correctionAttempt + 1;
        packagedResult = await generatePackaged(error.message, packagedParagraphs, nextAttempt);
        try {
          packagedParagraphs = validatePackagedResult(packagedResult, faithfulSources);
        } catch (correctionError) {
          throw textModelResultError(
            correctionError,
            `episode-script.packaged.correction-${nextAttempt}`,
            packagedResult as object,
          );
        }
      }
    }
    context.reportProgress(0.9);

    await requireCurrentEpisode(database, dataRoot, task);
    context.throwIfCancellationRequested();
    const versions = createScriptVersionPair(database, task.episodeId, {
      faithfulParagraphs,
      packagedParagraphs,
    }, () => {
      context.throwIfCancellationRequested();
      assertCurrentDatabaseIdentity(database, task);
      assertCalibration(database, task.episodeId, task);
    });
    context.reportProgress(1);
    return {
      episodeId: task.episodeId,
      beats,
      characterBudget,
      ...characterLimits,
      calibration: task.calibration,
      faithfulVersionId: versions.faithful.id,
      packagedVersionId: versions.packaged.id,
      faithfulCharacterCount,
      actualCharacterCount,
      compressionSuggested: actualCharacterCount > characterBudget,
      scriptHandoff: createScriptHandoff(task, beats),
    };
  };
}
