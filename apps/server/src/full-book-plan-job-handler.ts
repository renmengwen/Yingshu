import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

import {
  limitedResponseText,
  textModelRequest,
  type ChapterTextModelConfig,
} from "./chapter-event-analyzer.js";
import {
  FULL_BOOK_PLAN_JOB_CONTRACT_VERSION,
  FULL_BOOK_PLAN_JOB_V1_CONTRACT_VERSION,
  buildFullBookPlanFinalRequest,
  buildFullBookPlanIntervalRequests,
  fullBookPlanIntervalModelInput,
  fullBookPlanFinalResponseParser,
  fullBookPlanIntervalResponseParser,
  type FullBookPlanBuildLimits,
  type FullBookPlanIntervalRequest,
  type VerifiedFullBookPlanInterval,
} from "./full-book-plan-job.js";
import { FullBookPlanContractError } from "./full-book-plan-contract.js";
import { JobCancelledError, type JobHandler } from "./job-worker.js";
import { writeTextModelDiagnostic } from "./text-model-diagnostics.js";
import { mappedPipelineJobConcurrency, runConcurrent } from "./pipeline-job-concurrency.js";
import {
  completedTextModelEvidence,
  rememberTextModelEvidence,
  streamedText,
  TextModelCallError,
  textModelCallError,
  textModelResultError,
  type TextModelStreamStatistics,
} from "./text-model-stream.js";
import { textModelConcurrencyGate } from "./text-model-concurrency.js";
import { layeredPrompt, PRODUCT_PROMPTS, PRODUCT_PROMPT_VERSIONS } from "./product-prompts.js";

export const FULL_BOOK_PLAN_JOB_TYPE = "full_book_plan_build";
export const EPISODE_PLAN_JOB_TYPE = "episode_plan_build";
export const FULL_BOOK_PLAN_TIMEOUT_MS = 180_000;
export const FULL_BOOK_PLAN_IDLE_TIMEOUT_MS = 180_000;
export const FULL_BOOK_PLAN_TOTAL_TIMEOUT_MS = 900_000;
export const FULL_BOOK_PLAN_MODEL_MAX_ATTEMPTS = 3;
export const FULL_BOOK_PLAN_RETRY_DELAY_MS = 1_000;

export interface FullBookPlanJobPayload {
  contractVersion: typeof FULL_BOOK_PLAN_JOB_CONTRACT_VERSION | typeof FULL_BOOK_PLAN_JOB_V1_CONTRACT_VERSION;
  bookId: string;
  storyBible: { id: string; contentHash: string };
  episodeCount: number;
  intervals: FullBookPlanIntervalRequest[];
  limits: FullBookPlanBuildLimits;
  providerId: string;
  model: string;
  requestHash: string;
  prompt?: {
    productVersion: typeof PRODUCT_PROMPT_VERSIONS.episodePlanning;
    profileRevision: number;
    profileHash: string;
    instructions: string;
  };
}

interface HandlerOptions {
  fetchImpl?: typeof fetch;
  database?: DatabaseSync;
  retryDelayMs?: number;
  jobType?: typeof FULL_BOOK_PLAN_JOB_TYPE | typeof EPISODE_PLAN_JOB_TYPE;
  dataRoot?: string;
}

class TransientFullBookPlanModelError extends Error {}

const TRANSIENT_HTTP_STATUSES = new Set([429, 502, 503, 504, 524]);

const HASH = /^[0-9a-f]{64}$/u;

function canonical(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) {
    return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b))
      .map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`).join(",")}}`;
  }
  throw new Error("全书规划任务参数必须是有限 JSON");
}

function sha256(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

export function fullBookPlanJobRequestHash(
  payload: Omit<FullBookPlanJobPayload, "providerId" | "model" | "requestHash">,
) {
  return sha256(canonical({
    contractVersion: payload.contractVersion,
    bookId: payload.bookId,
    storyBible: payload.storyBible,
    episodeCount: payload.episodeCount,
    intervalIdentityHashes: payload.intervals.map(({ identityHash }) => identityHash),
    limits: payload.limits,
    prompt: payload.prompt ?? null,
  }));
}

function strictKeys(value: object, expected: readonly string[]) {
  return Object.keys(value).sort().join(",") === [...expected].sort().join(",");
}

function validateIntervals(payload: FullBookPlanJobPayload) {
  let previousEnd: number | undefined;
  let episodes = 0;
  for (const request of payload.intervals) {
    if (request?.kind !== "interval" || request.identity?.bookId !== payload.bookId ||
        request.identity.storyBibleId !== payload.storyBible.id ||
        request.identity.storyBibleContentHash !== payload.storyBible.contentHash ||
        request.provenance?.providerId !== payload.providerId || request.provenance?.model !== payload.model) {
      throw new Error("全书规划任务冻结身份不一致");
    }
    const chapters = request.chapterIds.map((chapterId) => ({
      chapterId,
      chapterIndex: request.sourceEvents.find((event) => event.chapterId === chapterId)?.chapterIndex ?? -1,
      sourceEvents: request.sourceEvents.filter((event) => event.chapterId === chapterId),
    }));
    const rebuilt = buildFullBookPlanIntervalRequests(
      payload.bookId,
      payload.storyBible,
      chapters,
      request.identity.episodeCount,
      { providerId: payload.providerId, model: payload.model },
      payload.limits,
      payload.contractVersion,
    );
    if (rebuilt.length !== 1 || canonical(rebuilt[0]) !== canonical(request) ||
        (previousEnd !== undefined && request.identity.startChapterIndex !== previousEnd + 1)) {
      throw new Error("全书规划任务冻结身份不一致");
    }
    previousEnd = request.identity.endChapterIndex;
    episodes += request.identity.episodeCount;
  }
  if (episodes !== payload.episodeCount) throw new Error("全书规划区间配额总和必须恰好等于总集数");
}

function parsePayload(value: unknown, config: ChapterTextModelConfig): FullBookPlanJobPayload {
  const keys = value && typeof value === "object" && !Array.isArray(value) ? Object.keys(value) : [];
  const hasPrompt = keys.includes("prompt");
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype ||
      !strictKeys(value, ["bookId", "contractVersion", "episodeCount", "intervals", "limits", "model",
        "providerId", "requestHash", "storyBible", ...(hasPrompt ? ["prompt"] : [])])) {
    throw new Error("全书规划任务冻结参数无效");
  }
  const payload = value as FullBookPlanJobPayload;
  if (![FULL_BOOK_PLAN_JOB_CONTRACT_VERSION, FULL_BOOK_PLAN_JOB_V1_CONTRACT_VERSION].includes(payload.contractVersion) ||
      typeof payload.bookId !== "string" ||
      payload.bookId !== payload.bookId.trim() || !payload.bookId || !Number.isSafeInteger(payload.episodeCount) ||
      payload.episodeCount < 1 || !Array.isArray(payload.intervals) || payload.intervals.length < 1 ||
      !payload.storyBible || typeof payload.storyBible !== "object" || Array.isArray(payload.storyBible) ||
      !strictKeys(payload.storyBible, ["contentHash", "id"]) || typeof payload.storyBible.id !== "string" ||
      !payload.storyBible.id || typeof payload.storyBible.contentHash !== "string" ||
      !HASH.test(payload.storyBible.contentHash) || typeof payload.providerId !== "string" ||
      typeof payload.model !== "string" || payload.providerId !== config.providerId.trim() ||
      payload.model !== config.model.trim() || typeof payload.requestHash !== "string" || !HASH.test(payload.requestHash) ||
      !payload.limits || typeof payload.limits !== "object" || Array.isArray(payload.limits) ||
      !strictKeys(payload.limits, ["maxChaptersPerInterval", "maxEventsPerInterval", "maxFinalInputBytes",
        "maxFinalIntervals", "maxInputBytesPerInterval"]) ||
      Object.values(payload.limits).some((limit) => !Number.isSafeInteger(limit) || limit < 1) ||
      payload.intervals.length > payload.limits.maxFinalIntervals || Buffer.byteLength(canonical(payload), "utf8") > 10_000_000 ||
      fullBookPlanJobRequestHash(payload) !== payload.requestHash) {
    throw new Error("全书规划任务冻结参数无效");
  }
  if (hasPrompt && (!payload.prompt || !strictKeys(payload.prompt, ["instructions", "productVersion", "profileHash", "profileRevision"]) ||
      payload.prompt.productVersion !== PRODUCT_PROMPT_VERSIONS.episodePlanning ||
      !Number.isSafeInteger(payload.prompt.profileRevision) || payload.prompt.profileRevision < 1 ||
      !HASH.test(payload.prompt.profileHash) || typeof payload.prompt.instructions !== "string" ||
      payload.prompt.instructions.length > 40_000)) {
    throw new Error("逐集局部规划提示词快照无效");
  }
  validateIntervals(payload);
  return payload;
}

const OUTPUT_SCHEMA = "{episodes:[{index:number,title:string,storyArc:string," +
  "sourceEventIds:string[],recap:string|null,nextHook:string|null}]}";

function modelPrompt(input: unknown, correction?: string) {
  const request = input as { kind: "interval"; request: FullBookPlanIntervalRequest; prompt?: FullBookPlanJobPayload["prompt"] };
  const contract = [
    "你是全书分集规划器。只输出一个严格 JSON 对象，不要输出 Markdown、解释或代码围栏。",
    `唯一允许的输出 schema（不得增加包装字段或任何其他字段）：${OUTPUT_SCHEMA}`,
    "index 必须是从 1 开始的连续整数；title 和 storyArc 必须是非空字符串；recap 和 nextHook 必须是字符串或 null。",
    `episodes 必须恰好包含 ${request.request.identity.episodeCount} 集。`,
    "sourceEventIds 每集至少一个，只能引用当前 request 中的事件 ID；所有 ID 在全计划中不得重复。",
    "各集及集内事件必须按原文和章节顺序连续排列，并覆盖当前 request 的全部章节范围。",
    "不得输出或推测字节范围，也不得回显 kind、request、identityHash、章节范围或集数包装字段。",
    ...(correction ? [`上一次完整 JSON 输出未通过合同校验：${correction}`, "请针对同一原任务仅纠正输出合同；不要改变任务输入。"] : []),
  ].join("\n");
  const frozen = canonical(request.request.identity.jobContractVersion === FULL_BOOK_PLAN_JOB_V1_CONTRACT_VERSION
    ? { kind: request.kind, request: request.request }
    : fullBookPlanIntervalModelInput(request.request));
  return request.prompt
    ? [contract, layeredPrompt(PRODUCT_PROMPTS.episodePlanning, request.prompt.instructions, frozen)].join("\n\n")
    : [contract, frozen].join("\n");
}

async function callModel(
  config: ChapterTextModelConfig,
  fetchImpl: typeof fetch,
  input: unknown,
  signal: AbortSignal,
  onActivity: () => void,
  correction?: string,
  diagnosticStage = `full-book-plan:${correction ? "correction-1" : "initial"}`,
) {
  const request = textModelRequest(config, [
    modelPrompt(input, correction),
  ].join("\n"), 8192, true);
  let statistics: TextModelStreamStatistics | undefined;
  let text: string | undefined;
  try {
    text = await textModelConcurrencyGate.run(signal, async () => {
      const response = await fetchImpl(request.endpoint, {
        method: "POST", headers: request.headers, body: request.body, signal, redirect: "error",
      });
      if (!response.ok) {
        await response.body?.cancel();
        const message = `全书规划模型请求失败（HTTP ${response.status}）`;
        if (TRANSIENT_HTTP_STATUSES.has(response.status)) throw new TransientFullBookPlanModelError(message);
        throw new Error(message);
      }
      try {
        return response.headers.get("content-type")?.toLowerCase().includes("text/event-stream")
          ? await streamedText(response, config.protocol ?? "openai-response", {
            signal, onActivity, onStatistics: (value) => { statistics = value; },
          })
          : limitedResponseText(response, {
            protocol: config.protocol ?? "openai-response", signal, onActivity,
            onStatistics: (value) => { statistics = value; },
          });
      } catch (error) {
        if (error instanceof Error && /response\.(?:failed|incomplete): (?:internal_server_error|server_error|overloaded_error)|websocket: close 1006|unexpected EOF|error: overloaded_error/iu.test(error.message)) {
          throw new TransientFullBookPlanModelError(error.message, { cause: error });
        }
        throw error;
      }
    });
    const parsed = JSON.parse(text) as unknown;
    return rememberTextModelEvidence(parsed, completedTextModelEvidence(text, statistics));
  }
  catch (error) {
    if (text === undefined || (error instanceof Error && /大小限制/u.test(error.message))) {
      throw textModelCallError(error, diagnosticStage);
    }
    throw textModelCallError(new Error("全书规划模型返回了无效 JSON", { cause: error }), diagnosticStage,
      completedTextModelEvidence(text, statistics));
  }
}

async function callAndParse<T>(
  context: Parameters<JobHandler>[0],
  call: (signal: AbortSignal, correction: string | undefined, onActivity: () => void,
    diagnosticStage: string) => Promise<unknown>,
  parse: (value: unknown) => T,
  diagnosticStage: string,
  groupSignal?: AbortSignal,
  retryDelayMs = FULL_BOOK_PLAN_RETRY_DELAY_MS,
  onTransientError?: (error: unknown) => Promise<void>,
) {
  const raw = await callWithTransientRetry(context,
    (signal, onActivity, attempt) => call(signal, undefined, onActivity,
      `${diagnosticStage}:initial:transport-attempt-${attempt}`), groupSignal, retryDelayMs, onTransientError);
  try {
    return parse(raw);
  } catch (error) {
    if (!(error instanceof FullBookPlanContractError)) {
      throw typeof raw === "object" && raw !== null ? textModelResultError(error, `${diagnosticStage}:initial`, raw) : error;
    }
    const corrected = await callWithTransientRetry(context,
      (signal, onActivity, attempt) => call(signal, error.message, onActivity,
        `${diagnosticStage}:correction-1:transport-attempt-${attempt}`), groupSignal, retryDelayMs, onTransientError);
    try { return parse(corrected); }
    catch (correctedError) {
      throw typeof corrected === "object" && corrected !== null
        ? textModelResultError(correctedError, `${diagnosticStage}:correction-1`, corrected)
        : correctedError;
    }
  }
}

async function wait(delayMs: number, signal: AbortSignal) {
  if (delayMs <= 0) return;
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(done, delayMs);
    function done() { signal.removeEventListener("abort", abort); resolve(); }
    function abort() { clearTimeout(timer); reject(signal.reason ?? new DOMException("aborted", "AbortError")); }
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
  });
}

async function callWithTransientRetry<T>(
  context: Parameters<JobHandler>[0],
  call: (signal: AbortSignal, onActivity: () => void, attempt: number) => Promise<T>,
  groupSignal: AbortSignal | undefined,
  retryDelayMs: number,
  onTransientError?: (error: unknown) => Promise<void>,
) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await withCancellation(context, (signal, onActivity) => call(signal, onActivity, attempt), groupSignal);
    } catch (error) {
      let current: unknown = error;
      const seen = new Set<unknown>();
      while (current && !seen.has(current) && !(current instanceof TransientFullBookPlanModelError)) {
        seen.add(current);
        current = current instanceof Error ? current.cause : undefined;
      }
      if (!(current instanceof TransientFullBookPlanModelError) || attempt >= FULL_BOOK_PLAN_MODEL_MAX_ATTEMPTS) throw error;
      await onTransientError?.(error);
      await withCancellation(context,
        (signal) => wait(retryDelayMs * attempt, signal), groupSignal);
    }
  }
}

async function withCancellation<T>(
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
    FULL_BOOK_PLAN_TIMEOUT_MS);
  const total = setTimeout(() => totalController.abort(new DOMException("total timeout", "TimeoutError")),
    FULL_BOOK_PLAN_TOTAL_TIMEOUT_MS);
  const onActivity = () => {
    clearTimeout(idle);
    idle = setTimeout(() => idleController.abort(new DOMException("idle timeout", "TimeoutError")),
      FULL_BOOK_PLAN_IDLE_TIMEOUT_MS);
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
      throw new Error("全书规划模型请求超时", { cause: error });
    }
    throw error;
  } finally { clearInterval(poll); clearTimeout(idle); clearTimeout(total); }
}

export function createFullBookPlanJobHandler(
  config: ChapterTextModelConfig,
  options: HandlerOptions = {},
): JobHandler {
  const fetchImpl = options.fetchImpl ?? fetch;
  const jobType = options.jobType ?? FULL_BOOK_PLAN_JOB_TYPE;
  return async (context) => {
    if (context.job.type !== jobType) throw new Error("规划任务类型无效");
    const task = parsePayload(context.job.payload, config);
    const verified = new Array<VerifiedFullBookPlanInterval>(task.intervals.length);
    const groupController = new AbortController();
    const pending: number[] = [];
    let completed = 0;
    const recordTransientError = async (error: unknown) => {
      if (!options.dataRoot || !(error instanceof TextModelCallError)) return;
      const cause = error.cause instanceof Error ? error.cause : error;
      const code = (cause as Error & { code?: unknown }).code;
      await writeTextModelDiagnostic({
        dataRoot: options.dataRoot,
        jobId: context.job.id,
        attempt: context.job.attempts,
        stage: error.stage,
        providerId: config.providerId,
        model: config.model,
        protocol: error.evidence.statistics?.protocol ?? config.protocol ?? "openai-response",
        error: { name: cause.name, message: error.message, code: typeof code === "string" ? code : null },
        statistics: error.evidence.statistics,
        partialText: error.evidence.partialText,
        partialTextTruncated: error.evidence.partialTextTruncated,
      }).catch(() => undefined);
    };
    for (const [index, request] of task.intervals.entries()) {
      const checkpoint = context.getCheckpoint("full-book-plan-interval", request.identityHash);
      if (checkpoint?.inputHash !== request.identityHash || checkpoint.output === undefined) {
        pending.push(index);
        continue;
      }
      verified[index] = fullBookPlanIntervalResponseParser(request)(checkpoint.output);
      completed += 1;
    }
    if (completed) context.reportProgress(completed / (task.intervals.length + 1));
    await runConcurrent(
      pending,
      options.database
        ? mappedPipelineJobConcurrency(options.database, context.job.id, "episode_plan")
        : 1,
      async (index) => {
        const request = task.intervals[index]!;
        try {
          const input = { kind: "interval" as const, request, ...(task.prompt ? { prompt: task.prompt } : {}) };
          const parse = fullBookPlanIntervalResponseParser(request);
          verified[index] = await callAndParse(context,
            (signal, correction, onActivity, diagnosticStage) => callModel(config, fetchImpl, input, signal,
              onActivity, correction, diagnosticStage),
            parse,
            `${context.job.type}:interval:${request.identityHash}`,
            groupController.signal,
            options.retryDelayMs,
            recordTransientError,
          );
          context.throwIfCancellationRequested();
          context.commitCheckpoint("full-book-plan-interval", request.identityHash, request.identityHash,
            () => undefined, verified[index]!.content);
          context.reportProgress(++completed / (task.intervals.length + 1));
        } catch (error) {
          groupController.abort(error);
          throw error;
        }
      },
    );
    const finalRequest = buildFullBookPlanFinalRequest(
      task.bookId, task.storyBible, task.episodeCount, verified,
      { providerId: task.providerId, model: task.model }, task.limits,
    );
    const parseFinal = fullBookPlanFinalResponseParser(finalRequest);
    const finalCheckpoint = context.getCheckpoint("full-book-plan-final", finalRequest.identityHash);
    const final = finalCheckpoint?.inputHash === finalRequest.identityHash && finalCheckpoint.output !== undefined
      ? parseFinal(finalCheckpoint.output)
      : parseFinal({ episodes: verified.flatMap(({ content }) => content.episodes)
        .map((episode, index) => ({ ...episode, index: index + 1 })) });
    context.throwIfCancellationRequested();
    if (finalCheckpoint?.inputHash !== finalRequest.identityHash || finalCheckpoint.output === undefined) {
      context.commitCheckpoint("full-book-plan-final", finalRequest.identityHash, finalRequest.identityHash,
        () => undefined, final.content);
    }
    context.reportProgress(1);
    return {
      identityHash: finalRequest.identityHash,
      plan: final.content,
      planHash: final.contentHash,
      validation: {
        startChapterIndex: finalRequest.identity.startChapterIndex,
        endChapterIndex: finalRequest.identity.endChapterIndex,
        episodeCount: finalRequest.identity.episodeCount,
        sourceEvents: finalRequest.sourceEvents.map(({ id, chapterId, chapterIndex, byteRanges }) =>
          ({ id, chapterId, chapterIndex, byteRanges })),
        intervalQuotas: finalRequest.intervalQuotas,
      },
    };
  };
}
