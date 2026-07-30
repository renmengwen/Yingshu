import { createHash } from "node:crypto";

import {
  FULL_BOOK_PLAN_CONTRACT_VERSION,
  canonicalFullBookPlanJson,
  parseFullBookPlan,
  type FullBookPlan,
  type FullBookPlanIntervalQuota,
  type FullBookPlanSourceEvent,
} from "./full-book-plan-contract.js";

export const FULL_BOOK_PLAN_JOB_CONTRACT_VERSION = "full-book-plan-job-v2";
export const FULL_BOOK_PLAN_PROMPT_VERSION = "full-book-plan-prompt-v3";
export const FULL_BOOK_PLAN_PARSER_VERSION = "full-book-plan-parser-v1";
export const FULL_BOOK_PLAN_JOB_V1_CONTRACT_VERSION = "full-book-plan-job-v1";
export const FULL_BOOK_PLAN_JOB_V1_PROMPT_VERSION = "full-book-plan-prompt-v2";

export class FullBookPlanJobContractError extends Error {}

export interface FullBookPlanModelProvenance {
  providerId: string;
  model: string;
}

export interface FullBookPlanJobSourceEvent extends FullBookPlanSourceEvent {
  id: string;
  eventType: string;
  payload: unknown;
  contentHash: string;
  inputBytes: number;
}

export interface FullBookPlanChapterInput {
  chapterId: string;
  chapterIndex: number;
  sourceEvents: readonly FullBookPlanJobSourceEvent[];
}

export interface FullBookPlanBuildLimits {
  maxChaptersPerInterval: number;
  maxEventsPerInterval: number;
  maxInputBytesPerInterval: number;
  maxFinalIntervals: number;
  maxFinalInputBytes: number;
}

interface PlanIdentityVersions {
  contractVersion: string;
  jobContractVersion: string;
  promptVersion: string;
  parserVersion: string;
}

export interface FullBookPlanIntervalRequest {
  kind: "interval";
  identityHash: string;
  identity: PlanIdentityVersions & {
    bookId: string;
    storyBibleId: string;
    storyBibleContentHash: string;
    startChapterIndex: number;
    endChapterIndex: number;
    episodeCount: number;
    sourceEventsHash: string;
  };
  chapterIds: string[];
  sourceEvents: FullBookPlanJobSourceEvent[];
  provenance: FullBookPlanModelProvenance;
}

export interface VerifiedFullBookPlanInterval {
  request: FullBookPlanIntervalRequest;
  content: FullBookPlan;
  contentHash: string;
}

export interface FullBookPlanIntervalModelInput {
  kind: "interval";
  chapterRange: {
    startChapterIndex: number;
    endChapterIndex: number;
  };
  episodeCount: number;
  sourceEvents: Array<{
    id: string;
    chapterIndex: number;
    eventType: string;
    payload: unknown;
  }>;
}

export interface FullBookPlanFinalRequest {
  kind: "final";
  identityHash: string;
  identity: PlanIdentityVersions & {
    bookId: string;
    storyBibleId: string;
    storyBibleContentHash: string;
    startChapterIndex: number;
    endChapterIndex: number;
    episodeCount: number;
    sourceEventsHash: string;
    intervalContentsHash: string;
    intervalQuotasHash: string;
  };
  intervalIdentityHashes: string[];
  intervalQuotas: FullBookPlanIntervalQuota[];
  intervals: Array<{
    identityHash: string;
    contentHash: string;
    content: FullBookPlan;
  }>;
  sourceEvents: FullBookPlanJobSourceEvent[];
  provenance: FullBookPlanModelProvenance;
}

const ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$/u;
const HASH = /^[a-f0-9]{64}$/u;
const VERSIONS: PlanIdentityVersions = {
  contractVersion: FULL_BOOK_PLAN_CONTRACT_VERSION,
  jobContractVersion: FULL_BOOK_PLAN_JOB_CONTRACT_VERSION,
  promptVersion: FULL_BOOK_PLAN_PROMPT_VERSION,
  parserVersion: FULL_BOOK_PLAN_PARSER_VERSION,
};
const V1_VERSIONS: PlanIdentityVersions = {
  contractVersion: FULL_BOOK_PLAN_CONTRACT_VERSION,
  jobContractVersion: FULL_BOOK_PLAN_JOB_V1_CONTRACT_VERSION,
  promptVersion: FULL_BOOK_PLAN_JOB_V1_PROMPT_VERSION,
  parserVersion: FULL_BOOK_PLAN_PARSER_VERSION,
};

function versionsForJobContract(jobContractVersion: string) {
  if (jobContractVersion === FULL_BOOK_PLAN_JOB_CONTRACT_VERSION) return VERSIONS;
  if (jobContractVersion === FULL_BOOK_PLAN_JOB_V1_CONTRACT_VERSION) return V1_VERSIONS;
  throw new FullBookPlanJobContractError("全书规划 Job 合同版本无效");
}

function canonical(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) {
    return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b))
      .map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`).join(",")}}`;
  }
  throw new FullBookPlanJobContractError("全书规划 Job identity 必须是有限 JSON");
}

function sha256(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

function validId(value: string, label: string) {
  if (!ID.test(value)) throw new FullBookPlanJobContractError(`${label} 无效`);
  return value;
}

function validHash(value: string, label: string) {
  if (!HASH.test(value)) throw new FullBookPlanJobContractError(`${label} 无效`);
  return value;
}

function validEventType(value: string) {
  const normalized = value?.trim();
  if (!normalized || normalized.length > 200) throw new FullBookPlanJobContractError("sourceEventType 无效");
  return normalized;
}

function positiveInteger(value: number, label: string) {
  if (!Number.isSafeInteger(value) || value < 1) throw new FullBookPlanJobContractError(`${label} 必须是正整数`);
  return value;
}

function validProvenance(value: FullBookPlanModelProvenance) {
  const providerId = value.providerId?.trim();
  const model = value.model?.trim();
  if (!providerId || !model || providerId.length > 200 || model.length > 200) {
    throw new FullBookPlanJobContractError("全书规划模型溯源无效");
  }
  return { providerId, model };
}

function validateLimits(limits: FullBookPlanBuildLimits) {
  positiveInteger(limits.maxChaptersPerInterval, "maxChaptersPerInterval");
  positiveInteger(limits.maxEventsPerInterval, "maxEventsPerInterval");
  positiveInteger(limits.maxInputBytesPerInterval, "maxInputBytesPerInterval");
  positiveInteger(limits.maxFinalIntervals, "maxFinalIntervals");
  positiveInteger(limits.maxFinalInputBytes, "maxFinalInputBytes");
}

function eventIdentity(event: FullBookPlanJobSourceEvent, versions: PlanIdentityVersions) {
  const frozen = {
    id: event.id,
    contentHash: event.contentHash,
    chapterId: event.chapterId,
    chapterIndex: event.chapterIndex,
    byteRanges: event.byteRanges,
  };
  return versions === V1_VERSIONS ? frozen : {
    ...frozen,
    eventType: event.eventType,
    payload: event.payload,
    inputBytes: event.inputBytes,
  };
}

function allowedEvents(events: readonly FullBookPlanJobSourceEvent[]) {
  return new Map(events.map(({ id, chapterId, chapterIndex, byteRanges }) =>
    [id, { chapterId, chapterIndex, byteRanges }]));
}

function allocateEpisodeCounts(weights: readonly number[], capacities: readonly number[], episodeCount: number) {
  if (weights.length > episodeCount) {
    throw new FullBookPlanJobContractError("有界规划区间数不能超过总集数，否则无法分配正整数配额");
  }
  if (capacities.reduce((sum, capacity) => sum + capacity, 0) < episodeCount) {
    throw new FullBookPlanJobContractError("总集数不能超过可唯一分配的来源事件数");
  }
  const quotas = weights.map(() => 1);
  for (let remaining = episodeCount - weights.length; remaining > 0; remaining -= 1) {
    let selected = -1;
    for (let index = 0; index < weights.length; index += 1) {
      if (quotas[index]! >= capacities[index]!) continue;
      if (selected < 0 || BigInt(weights[index]!) * BigInt(quotas[selected]! + 1) >
          BigInt(weights[selected]!) * BigInt(quotas[index]! + 1)) selected = index;
    }
    if (selected < 0) throw new FullBookPlanJobContractError("全书规划区间配额不足");
    quotas[selected] = quotas[selected]! + 1;
  }
  return quotas;
}

export function buildFullBookPlanIntervalRequests(
  bookId: string,
  storyBible: { id: string; contentHash: string },
  chapters: readonly FullBookPlanChapterInput[],
  episodeCount: number,
  provenance: FullBookPlanModelProvenance,
  limits: FullBookPlanBuildLimits,
  jobContractVersion: typeof FULL_BOOK_PLAN_JOB_CONTRACT_VERSION | typeof FULL_BOOK_PLAN_JOB_V1_CONTRACT_VERSION =
    FULL_BOOK_PLAN_JOB_CONTRACT_VERSION,
): FullBookPlanIntervalRequest[] {
  const versions = versionsForJobContract(jobContractVersion);
  validId(bookId, "bookId");
  validId(storyBible.id, "storyBibleId");
  validHash(storyBible.contentHash, "storyBibleContentHash");
  positiveInteger(episodeCount, "episodeCount");
  validProvenance(provenance);
  validateLimits(limits);
  if (chapters.length === 0) throw new FullBookPlanJobContractError("全书规划至少需要一个章节");

  const seenChapters = new Set<string>();
  const seenEvents = new Set<string>();
  for (let index = 0; index < chapters.length; index += 1) {
    const chapter = chapters[index]!;
    validId(chapter.chapterId, "chapterId");
    if (seenChapters.has(chapter.chapterId)) throw new FullBookPlanJobContractError("章节不能重复");
    seenChapters.add(chapter.chapterId);
    if (!Number.isSafeInteger(chapter.chapterIndex) || chapter.chapterIndex < 0 ||
        (index > 0 && chapter.chapterIndex !== chapters[index - 1]!.chapterIndex + 1)) {
      throw new FullBookPlanJobContractError("章节范围必须按连续序号冻结");
    }
    if (chapter.sourceEvents.length === 0) throw new FullBookPlanJobContractError("章节缺少已冻结事件");
    let chapterBytes = 0;
    for (const event of chapter.sourceEvents) {
      validId(event.id, "sourceEventId");
      if (versions === VERSIONS) {
        validEventType(event.eventType!);
        canonical(event.payload);
      }
      validHash(event.contentHash, "sourceEventContentHash");
      positiveInteger(event.inputBytes, "事件输入字节数");
      if (event.chapterId !== chapter.chapterId || event.chapterIndex !== chapter.chapterIndex) {
        throw new FullBookPlanJobContractError("来源事件必须属于其冻结章节");
      }
      if (seenEvents.has(event.id)) throw new FullBookPlanJobContractError("来源事件不能跨章节重复");
      seenEvents.add(event.id);
      chapterBytes += event.inputBytes;
      if (!Number.isSafeInteger(chapterBytes)) throw new FullBookPlanJobContractError("章节输入字节数超出安全范围");
    }
    if (chapter.sourceEvents.length > limits.maxEventsPerInterval || chapterBytes > limits.maxInputBytesPerInterval) {
      throw new FullBookPlanJobContractError("单章事件超过全书规划有界请求上限");
    }
  }

  const groups: FullBookPlanChapterInput[][] = [];
  let group: FullBookPlanChapterInput[] = [];
  let eventCount = 0;
  let inputBytes = 0;
  for (const chapter of chapters) {
    const chapterBytes = chapter.sourceEvents.reduce((sum, event) => sum + event.inputBytes, 0);
    const overflow = group.length > 0 && (group.length + 1 > limits.maxChaptersPerInterval ||
      eventCount + chapter.sourceEvents.length > limits.maxEventsPerInterval ||
      inputBytes + chapterBytes > limits.maxInputBytesPerInterval);
    if (overflow) {
      groups.push(group);
      group = [];
      eventCount = 0;
      inputBytes = 0;
    }
    group.push(chapter);
    eventCount += chapter.sourceEvents.length;
    inputBytes += chapterBytes;
  }
  groups.push(group);
  if (groups.length > limits.maxFinalIntervals) throw new FullBookPlanJobContractError("全书规划最终聚合区间数超限");

  const quotas = allocateEpisodeCounts(
    groups.map((items) => items.reduce((sum, chapter) =>
      sum + chapter.sourceEvents.reduce((eventSum, event) => eventSum + event.inputBytes, 0), 0)),
    groups.map((items) => items.reduce((sum, chapter) => sum + chapter.sourceEvents.length, 0)),
    episodeCount,
  );
  return groups.map((chaptersInGroup, index) => {
    const sourceEvents = chaptersInGroup.flatMap((chapter) => chapter.sourceEvents).map((event) => versions === V1_VERSIONS
      ? { ...event, byteRanges: event.byteRanges.map((range) => ({ ...range })) }
      : { ...event, eventType: validEventType(event.eventType!),
          payload: JSON.parse(canonical(event.payload)) as unknown,
          byteRanges: event.byteRanges.map((range) => ({ ...range })) });
    const identity = {
      bookId,
      storyBibleId: storyBible.id,
      storyBibleContentHash: storyBible.contentHash,
      startChapterIndex: chaptersInGroup[0]!.chapterIndex,
      endChapterIndex: chaptersInGroup.at(-1)!.chapterIndex,
      episodeCount: quotas[index]!,
      sourceEventsHash: sha256(canonical(sourceEvents.map((event) => eventIdentity(event, versions)))),
      ...versions,
    };
    return {
      kind: "interval" as const,
      identityHash: sha256(canonical(identity)),
      identity,
      chapterIds: chaptersInGroup.map(({ chapterId }) => chapterId),
      sourceEvents,
      provenance: validProvenance(provenance),
    };
  });
}

export function fullBookPlanIntervalModelInput(request: FullBookPlanIntervalRequest): FullBookPlanIntervalModelInput {
  validateIntervalRequest(request);
  if (request.identity.jobContractVersion !== FULL_BOOK_PLAN_JOB_CONTRACT_VERSION) {
    throw new FullBookPlanJobContractError("旧版全书规划请求必须使用冻结的 v1 模型输入");
  }
  return {
    kind: "interval",
    chapterRange: {
      startChapterIndex: request.identity.startChapterIndex,
      endChapterIndex: request.identity.endChapterIndex,
    },
    episodeCount: request.identity.episodeCount,
    sourceEvents: request.sourceEvents.map(({ id, chapterIndex, eventType, payload }) => ({
      id, chapterIndex, eventType: eventType!, payload,
    })),
  };
}

function validateIntervalRequest(request: FullBookPlanIntervalRequest) {
  const versions = versionsForJobContract(request.identity?.jobContractVersion);
  if (request.kind !== "interval" || request.identityHash !== sha256(canonical(request.identity)) ||
      canonical({
        contractVersion: request.identity.contractVersion,
        jobContractVersion: request.identity.jobContractVersion,
        promptVersion: request.identity.promptVersion,
        parserVersion: request.identity.parserVersion,
      }) !== canonical(versions) ||
      request.chapterIds.length !== request.identity.endChapterIndex - request.identity.startChapterIndex + 1 ||
      request.identity.sourceEventsHash !== sha256(canonical(request.sourceEvents.map((event) => eventIdentity(event, versions))))) {
    throw new FullBookPlanJobContractError("全书规划区间请求身份无效");
  }
  validProvenance(request.provenance);
}

export function parseFullBookPlanIntervalResponse(request: FullBookPlanIntervalRequest, value: unknown): VerifiedFullBookPlanInterval {
  return fullBookPlanIntervalResponseParser(request)(value);
}

export function fullBookPlanIntervalResponseParser(request: FullBookPlanIntervalRequest) {
  validateIntervalRequest(request);
  const options = {
    startChapterIndex: request.identity.startChapterIndex,
    endChapterIndex: request.identity.endChapterIndex,
    episodeCount: request.identity.episodeCount,
    allowedSourceEvents: allowedEvents(request.sourceEvents),
  };
  return (value: unknown): VerifiedFullBookPlanInterval => {
    const content = parseFullBookPlan(value, options);
    return { request, content, contentHash: sha256(canonicalFullBookPlanJson(content)) };
  };
}

export function buildFullBookPlanFinalRequest(
  bookId: string,
  storyBible: { id: string; contentHash: string },
  episodeCount: number,
  intervals: readonly VerifiedFullBookPlanInterval[],
  provenance: FullBookPlanModelProvenance,
  limits: FullBookPlanBuildLimits,
): FullBookPlanFinalRequest {
  validId(bookId, "bookId");
  validId(storyBible.id, "storyBibleId");
  validHash(storyBible.contentHash, "storyBibleContentHash");
  positiveInteger(episodeCount, "episodeCount");
  validateLimits(limits);
  if (intervals.length === 0) throw new FullBookPlanJobContractError("全书规划最终聚合至少需要一个已验证区间");
  const versions = versionsForJobContract(intervals[0]!.request.identity.jobContractVersion);
  if (intervals.length > limits.maxFinalIntervals) throw new FullBookPlanJobContractError("全书规划最终聚合区间数超限");
  let previousEnd: number | undefined;
  let totalEpisodes = 0;
  let finalBytes = 0;
  const sourceEvents: FullBookPlanJobSourceEvent[] = [];
  for (const interval of intervals) {
    validateIntervalRequest(interval.request);
    if (interval.request.identity.bookId !== bookId || interval.request.identity.storyBibleId !== storyBible.id ||
        interval.request.identity.storyBibleContentHash !== storyBible.contentHash ||
        interval.request.identity.jobContractVersion !== versions.jobContractVersion ||
        interval.contentHash !== sha256(canonicalFullBookPlanJson(interval.content)) ||
        (previousEnd !== undefined && interval.request.identity.startChapterIndex !== previousEnd + 1)) {
      throw new FullBookPlanJobContractError("最终聚合只能使用同书、同全书世界观、连续且已验证的区间");
    }
    parseFullBookPlan(interval.content, {
      startChapterIndex: interval.request.identity.startChapterIndex,
      endChapterIndex: interval.request.identity.endChapterIndex,
      episodeCount: interval.request.identity.episodeCount,
      allowedSourceEvents: allowedEvents(interval.request.sourceEvents),
    });
    previousEnd = interval.request.identity.endChapterIndex;
    totalEpisodes += interval.request.identity.episodeCount;
    finalBytes += Buffer.byteLength(canonicalFullBookPlanJson(interval.content), "utf8");
    sourceEvents.push(...interval.request.sourceEvents);
  }
  if (totalEpisodes !== episodeCount) throw new FullBookPlanJobContractError("区间配额总和必须恰好等于总集数");
  if (finalBytes > limits.maxFinalInputBytes) throw new FullBookPlanJobContractError("全书规划最终聚合输入字节超限");
  if (new Set(sourceEvents.map(({ id }) => id)).size !== sourceEvents.length) {
    throw new FullBookPlanJobContractError("最终聚合区间来源不能重复");
  }
  const intervalQuotas = intervals.map(({ request }) => ({
    startChapterIndex: request.identity.startChapterIndex,
    endChapterIndex: request.identity.endChapterIndex,
    episodeCount: request.identity.episodeCount,
  }));
  const intervalInputs = intervals.map(({ request, contentHash }) => ({ identityHash: request.identityHash, contentHash }));
  const identity = {
    bookId,
    storyBibleId: storyBible.id,
    storyBibleContentHash: storyBible.contentHash,
    startChapterIndex: intervals[0]!.request.identity.startChapterIndex,
    endChapterIndex: intervals.at(-1)!.request.identity.endChapterIndex,
    episodeCount,
    sourceEventsHash: sha256(canonical(sourceEvents.map((event) => eventIdentity(event, versions)))),
    intervalContentsHash: sha256(canonical(intervalInputs)),
    intervalQuotasHash: sha256(canonical(intervalQuotas)),
    ...versions,
  };
  return {
    kind: "final",
    identityHash: sha256(canonical(identity)),
    identity,
    intervalIdentityHashes: intervals.map(({ request }) => request.identityHash),
    intervalQuotas,
    intervals: intervals.map(({ request, contentHash, content }) => ({
      identityHash: request.identityHash, contentHash, content,
    })),
    sourceEvents,
    provenance: validProvenance(provenance),
  };
}

export function parseFullBookPlanFinalResponse(request: FullBookPlanFinalRequest, value: unknown) {
  return fullBookPlanFinalResponseParser(request)(value);
}

export function fullBookPlanFinalResponseParser(request: FullBookPlanFinalRequest) {
  const versions = versionsForJobContract(request.identity?.jobContractVersion);
  const intervalInputs = request.intervals.map(({ identityHash, contentHash, content }, index) => {
    if (identityHash !== request.intervalIdentityHashes[index] || contentHash !== sha256(canonicalFullBookPlanJson(content))) {
      throw new FullBookPlanJobContractError("全书规划最终聚合区间内容无效");
    }
    return { identityHash, contentHash };
  });
  if (request.kind !== "final" || request.identityHash !== sha256(canonical(request.identity)) ||
      request.intervals.length === 0 || request.intervals.length !== request.intervalIdentityHashes.length ||
      request.identity.intervalContentsHash !== sha256(canonical(intervalInputs)) ||
      request.identity.intervalQuotasHash !== sha256(canonical(request.intervalQuotas)) ||
      request.identity.sourceEventsHash !== sha256(canonical(request.sourceEvents.map((event) => eventIdentity(event, versions)))) ||
      canonical({
        contractVersion: request.identity.contractVersion,
        jobContractVersion: request.identity.jobContractVersion,
        promptVersion: request.identity.promptVersion,
        parserVersion: request.identity.parserVersion,
      }) !== canonical(versions)) {
    throw new FullBookPlanJobContractError("全书规划最终请求身份无效");
  }
  validProvenance(request.provenance);
  const options = {
    startChapterIndex: request.identity.startChapterIndex,
    endChapterIndex: request.identity.endChapterIndex,
    episodeCount: request.identity.episodeCount,
    allowedSourceEvents: allowedEvents(request.sourceEvents),
    intervalQuotas: request.intervalQuotas,
  };
  return (value: unknown) => {
    const content = parseFullBookPlan(value, options);
    return { content, contentHash: sha256(canonicalFullBookPlanJson(content)) };
  };
}
