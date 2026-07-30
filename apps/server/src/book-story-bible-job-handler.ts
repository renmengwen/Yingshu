import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

import {
  BookStoryBibleContractError,
  parseBookStoryBibleContent,
  type BookStoryBibleContent,
} from "./book-story-bible-contract.js";
import {
  limitedResponseText,
  textModelRequest,
  type ChapterTextModelConfig,
} from "./chapter-event-analyzer.js";
import {
  BOOK_STORY_BIBLE_JOB_CONTRACT_VERSION,
  buildStoryBibleFinalRequest,
  parseStoryBibleFinalResponse,
  parseStoryBibleIntervalResponse,
  type StoryBibleBuildLimits,
  type StoryBibleIntervalRequest,
} from "./book-story-bible-job.js";
import {
  STORY_BIBLE_REDUCTION_FAN_IN,
  storyBibleReductionGroups,
  storyBibleReductionKey,
  storyBibleStepTotal,
} from "./book-story-bible-reduction.js";
import { createBookStoryBible, findBookStoryBibleForJob } from "./book-story-bible-store.js";
import { JobCancelledError, type JobHandler } from "./job-worker.js";
import { mappedPipelineJobConcurrency, runConcurrent } from "./pipeline-job-concurrency.js";
import {
  completedTextModelEvidence,
  rememberTextModelEvidence,
  streamedText,
  textModelCallError,
  textModelResultError,
  type TextModelStreamStatistics,
} from "./text-model-stream.js";
import { withTextModelTimeout } from "./text-model-timeout.js";
import { textModelConcurrencyGate } from "./text-model-concurrency.js";
import { layeredPrompt, PRODUCT_PROMPTS, PRODUCT_PROMPT_VERSIONS } from "./product-prompts.js";

export const BOOK_STORY_BIBLE_JOB_TYPE = "book_story_bible_build";
export const BOOK_STORY_BIBLE_TIMEOUT_MS = 180_000;
export const BOOK_STORY_BIBLE_IDLE_TIMEOUT_MS = 180_000;
export const BOOK_STORY_BIBLE_TOTAL_TIMEOUT_MS = 900_000;

export interface BookStoryBibleJobPayload {
  contractVersion: typeof BOOK_STORY_BIBLE_JOB_CONTRACT_VERSION;
  bookId: string;
  intervals: StoryBibleIntervalRequest[];
  limits: StoryBibleBuildLimits;
  forceRebuild: boolean;
  providerId: string;
  model: string;
  requestHash: string;
  prompt?: StoryBiblePromptSnapshot;
}

export interface StoryBiblePromptSnapshot {
  intervalProductVersion: typeof PRODUCT_PROMPT_VERSIONS.storyBibleInterval;
  finalProductVersion: typeof PRODUCT_PROMPT_VERSIONS.storyBibleFinal;
  profileRevision: number;
  profileHash: string;
  instructions: string;
}

interface StoredBible {
  id: string;
  contentHash: string;
}

interface StoryBibleNode {
  bible: StoredBible;
  content: BookStoryBibleContent;
  chapterIds: string[];
  sourceEventIds: string[];
}

interface HandlerOptions {
  fetchImpl?: typeof fetch;
  createBible?: typeof createBookStoryBible;
  findBible?: typeof findBookStoryBibleForJob;
}

const HASH = /^[0-9a-f]{64}$/u;
const OUTPUT_SCHEMA = `输出必须是一个普通 JSON 对象，且顶层必须恰好包含以下 12 个数组（不得缺少或增加字段）：
characters: [{canonicalName:string, aliases:string[], identities:[{text:string, sourceEventIds:string[]}], motivations:[{text:string, sourceEventIds:string[]}], stateChanges:[{state:string, chapterIds:string[], sourceEventIds:string[]}], sourceEventIds:string[]}]
relationships: [{subject:string, object:string, relation:string, chapterIds:string[], sourceEventIds:string[]}]
locations: [{name:string, aliases:string[], detail:string, sourceEventIds:string[]}]
organizations: [{name:string, aliases:string[], detail:string, sourceEventIds:string[]}]
items: [{name:string, aliases:string[], detail:string, sourceEventIds:string[]}]
concepts: [{name:string, aliases:string[], detail:string, sourceEventIds:string[]}]
timeline: [{summary:string, chapterIds:string[], sourceEventIds:string[]}]
flashbacks: [{summary:string, startChapterId:string, endChapterId:string, sourceEventIds:string[]}]
plotThreads: [{kind:"foreshadowing"|"suspense"|"revelation", setup:string, revealCondition:string|null, resolution:string|null, chapterIds:string[], sourceEventIds:string[]}]
confusingFacts: [{statement:string, clarification:string, sourceEventIds:string[]}]
spoilerRestrictions: [{information:string, forbiddenUntil:string, sourceEventIds:string[]}]
properNouns: [{term:string, pronunciation:string, aliases:string[], sourceEventIds:string[]}]
所有 string 必须是非空字符串；aliases、identities、motivations、stateChanges 和各顶层数组可为空，chapterIds 与每条事实的 sourceEventIds 不得为空；chapterIds 只能使用允许的 chapterIds；全部对象只允许列出的字段；全书至少输出一条事实。`;

function parseModelContent(
  value: unknown,
  allowedSourceEventIds: readonly string[],
  allowedChapterIds: readonly string[],
) {
  const content = parseBookStoryBibleContent(value, new Set(allowedSourceEventIds));
  const allowed = new Set(allowedChapterIds);
  const referenced = [
    ...content.characters.flatMap((character) => character.stateChanges.flatMap((change) => change.chapterIds)),
    ...content.relationships.flatMap((relationship) => relationship.chapterIds),
    ...content.timeline.flatMap((event) => event.chapterIds),
    ...content.flashbacks.flatMap((flashback) => [flashback.startChapterId, flashback.endChapterId]),
    ...content.plotThreads.flatMap((thread) => thread.chapterIds),
  ];
  const unknown = referenced.find((chapterId) => !allowed.has(chapterId));
  if (unknown) throw new BookStoryBibleContractError(`全书世界观引用了未获准章节：${unknown}`);
  return content;
}

function sha256(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

function canonical(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) {
    return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b))
      .map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`).join(",")}}`;
  }
  throw new Error("全书世界观任务参数必须是有限 JSON");
}

export function storyBibleJobRequestHash(payload: Omit<BookStoryBibleJobPayload, "providerId" | "model" | "requestHash">) {
  return sha256(canonical({
    contractVersion: payload.contractVersion,
    bookId: payload.bookId,
    intervalIdentityHashes: payload.intervals.map((interval) => interval.identityHash),
    limits: payload.limits,
    forceRebuild: payload.forceRebuild,
    prompt: payload.prompt ?? null,
  }));
}

function parsePromptSnapshot(value: unknown): StoryBiblePromptSnapshot {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("全书世界观任务提示词身份无效");
  const input = value as Record<string, unknown>;
  if (Object.keys(input).sort().join(",") !== ["finalProductVersion", "instructions", "intervalProductVersion",
    "profileHash", "profileRevision"].sort().join(",") ||
      input.intervalProductVersion !== PRODUCT_PROMPT_VERSIONS.storyBibleInterval ||
      input.finalProductVersion !== PRODUCT_PROMPT_VERSIONS.storyBibleFinal ||
      !Number.isSafeInteger(input.profileRevision) || (input.profileRevision as number) < 1 ||
      typeof input.profileHash !== "string" || !HASH.test(input.profileHash) ||
      typeof input.instructions !== "string" || input.instructions.length > 40_000) {
    throw new Error("全书世界观任务提示词身份无效");
  }
  return input as unknown as StoryBiblePromptSnapshot;
}

function parsePayload(value: unknown, config: ChapterTextModelConfig): BookStoryBibleJobPayload {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new Error("全书世界观任务冻结参数无效");
  }
  const row = value as Record<string, unknown>;
  const expected = ["bookId", "contractVersion", "forceRebuild", "intervals", "limits", "model", "providerId", "requestHash"];
  const keys = Object.keys(row).filter((key) => key !== "prompt");
  if (keys.sort().join(",") !== expected.sort().join(",") ||
      row.contractVersion !== BOOK_STORY_BIBLE_JOB_CONTRACT_VERSION || typeof row.bookId !== "string" ||
      !row.bookId.trim() || !Array.isArray(row.intervals) || row.intervals.length === 0 ||
      typeof row.forceRebuild !== "boolean" || typeof row.providerId !== "string" || typeof row.model !== "string" ||
      typeof row.requestHash !== "string" || !HASH.test(row.requestHash) ||
      !row.limits || typeof row.limits !== "object" || Array.isArray(row.limits)) {
    throw new Error("全书世界观任务冻结参数无效");
  }
  const payload = row as unknown as BookStoryBibleJobPayload;
  if (row.prompt !== undefined) payload.prompt = parsePromptSnapshot(row.prompt);
  const limitKeys = ["maxChaptersPerInterval", "maxEventsPerInterval", "maxFinalInputBytes",
    "maxFinalIntervals", "maxInputBytesPerInterval"];
  if (Object.keys(payload.limits).sort().join(",") !== limitKeys.sort().join(",") ||
      Object.values(payload.limits).some((limit) => !Number.isSafeInteger(limit) || limit < 1) ||
      payload.intervals.length > payload.limits.maxFinalIntervals || canonical(payload).length > 10_000_000) {
    throw new Error("全书世界观任务冻结参数无效");
  }
  if (payload.bookId !== payload.bookId.trim() || payload.providerId !== config.providerId.trim() ||
      payload.model !== config.model.trim() || payload.intervals.some((request) =>
        request?.kind !== "interval" || request.identity?.bookId !== payload.bookId ||
        request.provenance?.providerId !== payload.providerId || request.provenance?.model !== payload.model) ||
      storyBibleJobRequestHash(payload) !== payload.requestHash) {
    throw new Error("全书世界观任务冻结身份不一致");
  }
  return payload;
}

function sourceEvents(database: DatabaseSync, request: StoryBibleIntervalRequest) {
  const rows = database.prepare(
    `SELECT id, chapter_id, event_type, payload_json
     FROM chapter_events WHERE id IN (${request.sourceEventIds.map(() => "?").join(",")})`,
  ).all(...request.sourceEventIds) as unknown as Array<{
    id: string; chapter_id: string; event_type: string; payload_json: string;
  }>;
  const byId = new Map(rows.map((row) => [row.id, row]));
  return request.sourceEventIds.map((id) => {
    const event = byId.get(id);
    if (!event || !request.chapterIds.includes(event.chapter_id)) {
      throw new Error("全书世界观任务来源事件不存在或已越出冻结章节范围");
    }
    let payload: unknown;
    try { payload = JSON.parse(event.payload_json); }
    catch { throw new Error("全书世界观任务来源事件不是有效 JSON"); }
    return { id, chapterId: event.chapter_id, eventType: event.event_type, payload };
  });
}

async function callModel(
  config: ChapterTextModelConfig,
  fetchImpl: typeof fetch,
  input: unknown,
  signal: AbortSignal,
  onActivity: () => void,
  promptSnapshot?: StoryBiblePromptSnapshot,
  promptStage: "interval" | "final" = "interval",
  correctionError?: string,
  diagnosticStage = `story-bible:${promptStage}:${correctionError ? "correction-1" : "initial"}`,
) {
  const frozenInput = correctionError
    ? `你是书籍全书世界观汇总器。上一次输出被严格合同拒绝，请只纠正一次并重新输出完整 JSON。\n错误：${correctionError}\n精确输出 schema：\n${OUTPUT_SCHEMA}\ninterval 的 sourceEvents[].id 与 chapterIds 分别是唯一允许的 sourceEventIds 与 chapterIds；final 的 chapterIds 是唯一允许的 chapterIds，且只能使用 intervals[].content 中已有的 sourceEventIds。\n原任务：${canonical(input)}`
    : `你是书籍全书世界观汇总器。interval 与 final 使用完全相同的输出 schema，只输出 JSON。interval 的 sourceEvents[].id 与 chapterIds 分别是唯一允许的 sourceEventIds 与 chapterIds；final 的 chapterIds 是唯一允许的 chapterIds，且只能使用 intervals[].content 中已有的 sourceEventIds。\n精确输出 schema：\n${OUTPUT_SCHEMA}\n原任务：${canonical(input)}`;
  const prompt = promptSnapshot
    ? layeredPrompt(promptStage === "interval" ? PRODUCT_PROMPTS.storyBibleInterval : PRODUCT_PROMPTS.storyBibleFinal,
      promptSnapshot.instructions, frozenInput)
    : frozenInput;
  const request = textModelRequest(config, prompt, 8192, true);
  let statistics: TextModelStreamStatistics | undefined;
  let text: string | undefined;
  try {
    text = await textModelConcurrencyGate.run(signal, async () => {
      const response = await fetchImpl(request.endpoint, {
        method: "POST", headers: request.headers, body: request.body, signal, redirect: "error",
      });
      if (!response.ok) {
        await response.body?.cancel();
        throw new Error(`全书世界观模型请求失败（HTTP ${response.status}）`);
      }
      return response.headers.get("content-type")?.toLowerCase().includes("text/event-stream")
        ? streamedText(response, config.protocol ?? "openai-response", {
          signal, onActivity, onStatistics: (value) => { statistics = value; },
        })
        : limitedResponseText(response, {
          protocol: config.protocol ?? "openai-response", signal, onActivity,
          onStatistics: (value) => { statistics = value; },
        });
    });
    const parsed = JSON.parse(text) as unknown;
    return rememberTextModelEvidence(parsed, completedTextModelEvidence(text, statistics));
  } catch (error) {
    if (text === undefined) throw textModelCallError(error, diagnosticStage);
    throw textModelCallError(new Error("全书世界观模型返回了无效 JSON", { cause: error }), diagnosticStage,
      completedTextModelEvidence(text, statistics));
  }
}

async function callModelAndParse<T>(
  context: Parameters<JobHandler>[0],
  config: ChapterTextModelConfig,
  fetchImpl: typeof fetch,
  input: unknown,
  allowedSourceEventIds: readonly string[],
  allowedChapterIds: readonly string[],
  parse: (value: unknown) => T,
  groupSignal?: AbortSignal,
  promptSnapshot?: StoryBiblePromptSnapshot,
  promptStage: "interval" | "final" = "interval",
  diagnosticStage = `story-bible:${promptStage}`,
) {
  const raw = await withCancellation(context,
    (signal, onActivity) => callModel(config, fetchImpl, input, signal, onActivity,
      promptSnapshot, promptStage, undefined, `${diagnosticStage}:initial`), groupSignal);
  try {
    parseModelContent(raw, allowedSourceEventIds, allowedChapterIds);
  } catch (error) {
    if (!(error instanceof BookStoryBibleContractError)) {
      throw typeof raw === "object" && raw !== null ? textModelResultError(error, `${diagnosticStage}:initial`, raw) : error;
    }
    const corrected = await withCancellation(context,
      (signal, onActivity) => callModel(config, fetchImpl, input, signal, onActivity,
        promptSnapshot, promptStage, error.message, `${diagnosticStage}:correction-1`), groupSignal);
    try {
      parseModelContent(corrected, allowedSourceEventIds, allowedChapterIds);
      return parse(corrected);
    } catch (correctedError) {
      throw typeof corrected === "object" && corrected !== null
        ? textModelResultError(correctedError, `${diagnosticStage}:correction-1`, corrected)
        : correctedError;
    }
  }
  try { return parse(raw); }
  catch (error) {
    throw typeof raw === "object" && raw !== null ? textModelResultError(error, `${diagnosticStage}:initial`, raw) : error;
  }
}

async function withCancellation<T>(
  context: Parameters<JobHandler>[0],
  call: (signal: AbortSignal, onActivity: () => void) => Promise<T>,
  groupSignal?: AbortSignal,
) {
  context.throwIfCancellationRequested();
  try {
    return await withTextModelTimeout(call, {
      firstActivityMs: BOOK_STORY_BIBLE_TIMEOUT_MS,
      idleMs: BOOK_STORY_BIBLE_IDLE_TIMEOUT_MS,
      totalMs: BOOK_STORY_BIBLE_TOTAL_TIMEOUT_MS,
      signal: groupSignal,
      isCancellationRequested: context.isCancellationRequested,
    });
  } catch (error) {
    if (context.isCancellationRequested()) throw new JobCancelledError();
    if (groupSignal?.aborted) throw groupSignal.reason ?? error;
    if (error instanceof Error && error.name === "TimeoutError") {
      throw new Error("全书世界观模型请求超时", { cause: error });
    }
    throw error;
  }
}

export function createBookStoryBibleJobHandler(
  database: DatabaseSync,
  config: ChapterTextModelConfig,
  options: HandlerOptions = {},
): JobHandler {
  const fetchImpl = options.fetchImpl ?? fetch;
  const createBible = options.createBible ?? createBookStoryBible;
  const findBible = options.findBible ?? findBookStoryBibleForJob;
  return async (context) => {
    if (context.job.type !== BOOK_STORY_BIBLE_JOB_TYPE) throw new Error("全书世界观任务类型无效");
    const task = parsePayload(context.job.payload, config);
    const verified = new Array<ReturnType<typeof parseStoryBibleIntervalResponse>>(task.intervals.length);
    const intervalBibles = new Array<StoredBible>(task.intervals.length);
    const groupController = new AbortController();
    const pending: number[] = [];
    const totalSteps = storyBibleStepTotal(task.intervals.length);
    let completed = 0;
    for (const [index, request] of task.intervals.entries()) {
      const checkpoint = context.getCheckpoint("book-story-bible-interval", request.identityHash);
      if (!checkpoint || checkpoint.inputHash !== request.identityHash) {
        pending.push(index);
        continue;
      }
      const bible = findBible(database, {
        jobId: context.job.id, bookId: task.bookId, scope: "interval",
        sourceStartChapterId: request.chapterIds[0]!, sourceEndChapterId: request.chapterIds.at(-1)!,
        sourceEventIds: request.sourceEventIds,
      });
      if (!bible) throw new Error(`全书世界观区间检查点缺少持久结果：${request.identityHash}`);
      const parsed = parseStoryBibleIntervalResponse(request, bible.content);
      if (parsed.contentHash !== bible.contentHash) throw new Error("全书世界观区间检查点内容哈希不一致");
      verified[index] = parsed;
      intervalBibles[index] = bible;
      completed += 1;
    }
    if (completed) context.reportProgress(completed / totalSteps);
    await runConcurrent(pending, mappedPipelineJobConcurrency(database, context.job.id, "story_bible"), async (index) => {
        context.throwIfCancellationRequested();
        const request = task.intervals[index]!;
        try {
          const input = {
            kind: "interval", chapterIds: request.chapterIds, sourceEvents: sourceEvents(database, request),
          };
          const parsed = await callModelAndParse(context, config, fetchImpl, input, request.sourceEventIds,
            request.chapterIds, (raw) => parseStoryBibleIntervalResponse(request, raw), groupController.signal,
            task.prompt, "interval", `story-bible:interval:${request.identityHash}`);
          context.throwIfCancellationRequested();
          const bible = createBible(database, {
            bookId: task.bookId, scope: "interval", sourceStartChapterId: request.chapterIds[0]!,
            sourceEndChapterId: request.chapterIds.at(-1)!, sourceEventIds: request.sourceEventIds,
            providerId: task.providerId, model: task.model, jobId: context.job.id, content: parsed.content,
          }, { forceRebuild: task.forceRebuild });
          verified[index] = parsed;
          intervalBibles[index] = bible;
          context.commitCheckpoint("book-story-bible-interval", request.identityHash, request.identityHash, () => undefined);
          context.reportProgress(++completed / totalSteps);
        } catch (error) {
          groupController.abort(error);
          throw error;
        }
    });
    const finalRequest = buildStoryBibleFinalRequest(task.bookId, verified, {
      providerId: task.providerId, model: task.model,
    }, task.limits);
    const chapterIds = task.intervals.flatMap((interval) => interval.chapterIds);
    let nodes: StoryBibleNode[] = verified.map((item, index) => ({
      bible: intervalBibles[index]!, content: item.content,
      chapterIds: [...task.intervals[index]!.chapterIds],
      sourceEventIds: [...task.intervals[index]!.sourceEventIds],
    }));
    while (nodes.length > STORY_BIBLE_REDUCTION_FAN_IN) {
      const groups = storyBibleReductionGroups(nodes);
      const reduced = new Array<StoryBibleNode>(groups.length);
      await runConcurrent(groups.map((group, index) => ({ group, index })),
        mappedPipelineJobConcurrency(database, context.job.id, "story_bible"), async ({ group, index }) => {
          if (group.length === 1) {
            reduced[index] = group[0]!;
            return;
          }
          context.throwIfCancellationRequested();
          const reductionKey = storyBibleReductionKey(group.map((node) => node.bible));
          const reductionChapterIds = group.flatMap((node) => node.chapterIds);
          const reductionSourceEventIds = group.flatMap((node) => node.sourceEventIds);
          const parentBibleIds = group.map((node) => node.bible.id);
          const checkpoint = context.getCheckpoint("book-story-bible-reduction", reductionKey);
          if (checkpoint?.inputHash === reductionKey) {
            const bible = findBible(database, {
              jobId: context.job.id, bookId: task.bookId, scope: "interval",
              sourceStartChapterId: reductionChapterIds[0]!, sourceEndChapterId: reductionChapterIds.at(-1)!,
              sourceEventIds: reductionSourceEventIds, parentBibleIds,
            });
            if (!bible) throw new Error(`全书世界观归并检查点缺少持久结果：${reductionKey}`);
            const content = parseModelContent(bible.content, reductionSourceEventIds, reductionChapterIds);
            reduced[index] = { bible, content, chapterIds: reductionChapterIds, sourceEventIds: reductionSourceEventIds };
            completed += 1;
            return;
          }
          try {
            const content = await callModelAndParse(context, config, fetchImpl, {
              kind: "final", chapterIds: reductionChapterIds,
              intervals: group.map((node) => ({ content: node.content })),
            }, reductionSourceEventIds, reductionChapterIds,
            (raw) => parseBookStoryBibleContent(raw, new Set(reductionSourceEventIds)), groupController.signal,
            task.prompt, "final", `story-bible:reduction:${reductionKey}`);
            context.throwIfCancellationRequested();
            const bible = createBible(database, {
              bookId: task.bookId, scope: "interval", sourceStartChapterId: reductionChapterIds[0]!,
              sourceEndChapterId: reductionChapterIds.at(-1)!, sourceEventIds: reductionSourceEventIds,
              parentBibleIds, providerId: task.providerId, model: task.model,
              jobId: context.job.id, content,
            }, { forceRebuild: task.forceRebuild });
            reduced[index] = { bible, content, chapterIds: reductionChapterIds, sourceEventIds: reductionSourceEventIds };
            context.commitCheckpoint("book-story-bible-reduction", reductionKey, reductionKey, () => undefined);
            context.reportProgress(++completed / totalSteps);
          } catch (error) {
            groupController.abort(error);
            throw error;
          }
        });
      nodes = reduced;
      context.reportProgress(completed / totalSteps);
    }
    const finalCheckpoint = context.getCheckpoint("book-story-bible-final", finalRequest.identityHash);
    const finalParentBibleIds = nodes.map((node) => node.bible.id);
    if (finalCheckpoint?.inputHash === finalRequest.identityHash) {
      const bible = findBible(database, {
        jobId: context.job.id, bookId: task.bookId, scope: "final",
        sourceStartChapterId: chapterIds[0]!, sourceEndChapterId: chapterIds.at(-1)!,
        sourceEventIds: finalRequest.sourceEventIds, parentBibleIds: finalParentBibleIds,
      });
      if (!bible) throw new Error(`全书世界观最终检查点缺少持久结果：${finalRequest.identityHash}`);
      const parsed = parseStoryBibleFinalResponse(finalRequest, bible.content);
      if (parsed.contentHash !== bible.contentHash) throw new Error("全书世界观最终检查点内容哈希不一致");
      context.reportProgress(1);
      return { storyBibleId: bible.id, contentHash: bible.contentHash,
        intervalBibleIds: intervalBibles.map((item) => item.id) };
    }
    const input = {
      kind: "final", chapterIds, intervals: nodes.map(({ content }) => ({ content })),
    };
    const final = await callModelAndParse(context, config, fetchImpl, input, finalRequest.sourceEventIds,
      chapterIds,
      (raw) => parseStoryBibleFinalResponse(finalRequest, raw), undefined, task.prompt, "final",
      `story-bible:final:${finalRequest.identityHash}`);
    context.throwIfCancellationRequested();
    const bible = createBible(database, {
      bookId: task.bookId, scope: "final", sourceStartChapterId: task.intervals[0]!.chapterIds[0]!,
      sourceEndChapterId: task.intervals.at(-1)!.chapterIds.at(-1)!, sourceEventIds: finalRequest.sourceEventIds,
      parentBibleIds: finalParentBibleIds, providerId: task.providerId, model: task.model,
      jobId: context.job.id, content: final.content,
    }, { forceRebuild: task.forceRebuild });
    context.commitCheckpoint("book-story-bible-final", finalRequest.identityHash, finalRequest.identityHash, () => undefined);
    context.reportProgress(1);
    return { storyBibleId: bible.id, contentHash: bible.contentHash, intervalBibleIds: intervalBibles.map((item) => item.id) };
  };
}
