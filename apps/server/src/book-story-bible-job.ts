import { createHash } from "node:crypto";

import {
  BOOK_STORY_BIBLE_CONTRACT_VERSION,
  canonicalBookStoryBibleJson,
  parseBookStoryBibleContent,
  type BookStoryBibleContent,
} from "./book-story-bible-contract.js";

export const BOOK_STORY_BIBLE_JOB_CONTRACT_VERSION = "book-story-bible-job-v1";
export const BOOK_STORY_BIBLE_PROMPT_VERSION = "book-story-bible-prompt-v2";
export const BOOK_STORY_BIBLE_PARSER_VERSION = "book-story-bible-parser-v1";

export class BookStoryBibleJobContractError extends Error {}

export interface StoryBibleSourceEvent {
  id: string;
  contentHash: string;
  inputBytes: number;
}

export interface StoryBibleChapterInput {
  chapterId: string;
  chapterIndex: number;
  sourceEvents: readonly StoryBibleSourceEvent[];
}

export interface StoryBibleModelProvenance {
  providerId: string;
  model: string;
}

export interface StoryBibleIntervalRequest {
  kind: "interval";
  identityHash: string;
  identity: {
    bookId: string;
    startChapterIndex: number;
    endChapterIndex: number;
    sourceEventIdsHash: string;
    sourceEventsHash: string;
    contractVersion: string;
    promptVersion: string;
    parserVersion: string;
  };
  chapterIds: string[];
  sourceEventIds: string[];
  sourceEvents: Array<{ id: string; contentHash: string }>;
  provenance: StoryBibleModelProvenance;
}

export interface VerifiedStoryBibleInterval {
  request: StoryBibleIntervalRequest;
  content: BookStoryBibleContent;
  contentHash: string;
}

export interface StoryBibleFinalRequest {
  kind: "final";
  identityHash: string;
  identity: {
    bookId: string;
    startChapterIndex: number;
    endChapterIndex: number;
    sourceEventIdsHash: string;
    intervalContentsHash: string;
    contractVersion: string;
    promptVersion: string;
    parserVersion: string;
  };
  intervalIdentityHashes: string[];
  intervals: Array<{
    identityHash: string;
    contentHash: string;
    sourceEventIds: string[];
    content: BookStoryBibleContent;
  }>;
  sourceEventIds: string[];
  provenance: StoryBibleModelProvenance;
}

export interface StoryBibleBuildLimits {
  maxChaptersPerInterval: number;
  maxEventsPerInterval: number;
  maxInputBytesPerInterval: number;
  maxFinalIntervals: number;
  maxFinalInputBytes: number;
}

export interface StoryBibleRebuildPlan {
  intervalIdentityHashes: string[];
  rebuildFinal: boolean;
  forceNewVersion: boolean;
}

const ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$/u;
const HASH = /^[a-f0-9]{64}$/u;

function canonical(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) {
    return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b))
      .map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`).join(",")}}`;
  }
  throw new BookStoryBibleJobContractError("全书世界观 Job identity 必须是有限 JSON");
}

function sha256(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

function validId(value: string, label: string) {
  if (!ID.test(value)) throw new BookStoryBibleJobContractError(`${label} 无效`);
  return value;
}

function validProvenance(value: StoryBibleModelProvenance) {
  const providerId = value.providerId?.trim();
  const model = value.model?.trim();
  if (!providerId || !model || providerId.length > 200 || model.length > 200) {
    throw new BookStoryBibleJobContractError("全书世界观模型溯源无效");
  }
  return { providerId, model };
}

function positiveInteger(value: number, label: string) {
  if (!Number.isSafeInteger(value) || value < 1) throw new BookStoryBibleJobContractError(`${label} 必须是正整数`);
}

function validateLimits(limits: StoryBibleBuildLimits) {
  positiveInteger(limits.maxChaptersPerInterval, "maxChaptersPerInterval");
  positiveInteger(limits.maxEventsPerInterval, "maxEventsPerInterval");
  positiveInteger(limits.maxInputBytesPerInterval, "maxInputBytesPerInterval");
  positiveInteger(limits.maxFinalIntervals, "maxFinalIntervals");
  positiveInteger(limits.maxFinalInputBytes, "maxFinalInputBytes");
}

export function buildStoryBibleIntervalRequests(
  bookId: string,
  chapters: readonly StoryBibleChapterInput[],
  provenance: StoryBibleModelProvenance,
  limits: StoryBibleBuildLimits,
): StoryBibleIntervalRequest[] {
  validId(bookId, "bookId");
  validProvenance(provenance);
  validateLimits(limits);
  if (chapters.length === 0) throw new BookStoryBibleJobContractError("全书世界观至少需要一个章节");
  const seenChapters = new Set<string>();
  const seenEvents = new Set<string>();
  for (let index = 0; index < chapters.length; index += 1) {
    const chapter = chapters[index]!;
    validId(chapter.chapterId, "chapterId");
    if (seenChapters.has(chapter.chapterId)) throw new BookStoryBibleJobContractError("章节不能重复");
    seenChapters.add(chapter.chapterId);
    if (!Number.isSafeInteger(chapter.chapterIndex) || chapter.chapterIndex < 0 ||
        (index > 0 && chapter.chapterIndex !== chapters[index - 1]!.chapterIndex + 1)) {
      throw new BookStoryBibleJobContractError("章节范围必须按连续序号冻结");
    }
    if (chapter.sourceEvents.length === 0) throw new BookStoryBibleJobContractError("章节缺少已冻结事件");
    let chapterBytes = 0;
    for (const event of chapter.sourceEvents) {
      validId(event.id, "sourceEventId");
      if (!HASH.test(event.contentHash)) throw new BookStoryBibleJobContractError("来源事件 hash 无效");
      positiveInteger(event.inputBytes, "事件输入字节数");
      if (seenEvents.has(event.id)) throw new BookStoryBibleJobContractError("来源事件不能跨章节重复");
      seenEvents.add(event.id);
      chapterBytes += event.inputBytes;
    }
    if (chapter.sourceEvents.length > limits.maxEventsPerInterval || chapterBytes > limits.maxInputBytesPerInterval) {
      throw new BookStoryBibleJobContractError("单章事件超过全书世界观有界请求上限");
    }
  }

  const groups: StoryBibleChapterInput[][] = [];
  let group: StoryBibleChapterInput[] = [];
  let eventCount = 0;
  let inputBytes = 0;
  for (const chapter of chapters) {
    const chapterBytes = chapter.sourceEvents.reduce((total, event) => total + event.inputBytes, 0);
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

  return groups.map((chaptersInGroup) => {
    const events = chaptersInGroup.flatMap((chapter) => chapter.sourceEvents);
    const sourceEventIds = events.map((event) => event.id);
    const identity = {
      bookId,
      startChapterIndex: chaptersInGroup[0]!.chapterIndex,
      endChapterIndex: chaptersInGroup.at(-1)!.chapterIndex,
      sourceEventIdsHash: sha256(canonical(sourceEventIds)),
      sourceEventsHash: sha256(canonical(events.map(({ id, contentHash }) => ({ id, contentHash })))),
      contractVersion: BOOK_STORY_BIBLE_CONTRACT_VERSION,
      promptVersion: BOOK_STORY_BIBLE_PROMPT_VERSION,
      parserVersion: BOOK_STORY_BIBLE_PARSER_VERSION,
    };
    return {
      kind: "interval" as const,
      identityHash: sha256(canonical(identity)),
      identity,
      chapterIds: chaptersInGroup.map((chapter) => chapter.chapterId),
      sourceEventIds,
      sourceEvents: events.map(({ id, contentHash }) => ({ id, contentHash })),
      provenance: validProvenance(provenance),
    };
  });
}

export function parseStoryBibleIntervalResponse(request: StoryBibleIntervalRequest, value: unknown): VerifiedStoryBibleInterval {
  if (request.kind !== "interval" || request.identityHash !== sha256(canonical(request.identity)) ||
      request.sourceEventIds.length === 0 ||
      request.identity.sourceEventIdsHash !== sha256(canonical(request.sourceEventIds)) ||
      request.identity.sourceEventsHash !== sha256(canonical(request.sourceEvents)) ||
      request.sourceEvents.length !== request.sourceEventIds.length ||
      request.sourceEvents.some((event, index) => event.id !== request.sourceEventIds[index] || !HASH.test(event.contentHash)) ||
      request.chapterIds.length !== request.identity.endChapterIndex - request.identity.startChapterIndex + 1 ||
      request.identity.contractVersion !== BOOK_STORY_BIBLE_CONTRACT_VERSION ||
      request.identity.promptVersion !== BOOK_STORY_BIBLE_PROMPT_VERSION ||
      request.identity.parserVersion !== BOOK_STORY_BIBLE_PARSER_VERSION) {
    throw new BookStoryBibleJobContractError("全书世界观区间请求身份无效");
  }
  validProvenance(request.provenance);
  const content = parseBookStoryBibleContent(value, new Set(request.sourceEventIds));
  return { request, content, contentHash: sha256(canonicalBookStoryBibleJson(content)) };
}

export function buildStoryBibleFinalRequest(
  bookId: string,
  intervals: readonly VerifiedStoryBibleInterval[],
  provenance: StoryBibleModelProvenance,
  limits: StoryBibleBuildLimits,
): StoryBibleFinalRequest {
  validId(bookId, "bookId");
  validateLimits(limits);
  if (intervals.length < 1) throw new BookStoryBibleJobContractError("全书世界观最终聚合至少需要一个已验证区间");
  if (intervals.length > limits.maxFinalIntervals) throw new BookStoryBibleJobContractError("全书世界观最终聚合区间数超限");
  let previousEnd: number | undefined;
  const allSources: string[] = [];
  let finalBytes = 0;
  for (const interval of intervals) {
    if (interval.request.identity.bookId !== bookId || interval.request.identityHash !== sha256(canonical(interval.request.identity)) ||
        interval.contentHash !== sha256(canonicalBookStoryBibleJson(interval.content)) ||
        (previousEnd !== undefined && interval.request.identity.startChapterIndex !== previousEnd + 1)) {
      throw new BookStoryBibleJobContractError("最终聚合只能使用同书、连续且已验证的区间");
    }
    parseBookStoryBibleContent(interval.content, new Set(interval.request.sourceEventIds));
    previousEnd = interval.request.identity.endChapterIndex;
    allSources.push(...interval.request.sourceEventIds);
    finalBytes += Buffer.byteLength(canonicalBookStoryBibleJson(interval.content), "utf8");
  }
  if (new Set(allSources).size !== allSources.length) throw new BookStoryBibleJobContractError("最终聚合区间来源不能重复");
  if (finalBytes > limits.maxFinalInputBytes) throw new BookStoryBibleJobContractError("全书世界观最终聚合输入字节超限");
  const identity = {
    bookId,
    startChapterIndex: intervals[0]!.request.identity.startChapterIndex,
    endChapterIndex: intervals.at(-1)!.request.identity.endChapterIndex,
    sourceEventIdsHash: sha256(canonical(allSources)),
    intervalContentsHash: sha256(canonical(intervals.map(({ request, contentHash }) => ({
      identityHash: request.identityHash, contentHash,
    })))),
    contractVersion: BOOK_STORY_BIBLE_CONTRACT_VERSION,
    promptVersion: BOOK_STORY_BIBLE_PROMPT_VERSION,
    parserVersion: BOOK_STORY_BIBLE_PARSER_VERSION,
  };
  return {
    kind: "final",
    identityHash: sha256(canonical(identity)),
    identity,
    intervalIdentityHashes: intervals.map(({ request }) => request.identityHash),
    intervals: intervals.map(({ request, content, contentHash }) => ({
      identityHash: request.identityHash,
      contentHash,
      sourceEventIds: [...request.sourceEventIds],
      content,
    })),
    sourceEventIds: allSources,
    provenance: validProvenance(provenance),
  };
}

export function parseStoryBibleFinalResponse(request: StoryBibleFinalRequest, value: unknown) {
  if (request.kind !== "final" || !Array.isArray(request.intervals) || !Array.isArray(request.intervalIdentityHashes) ||
      !Array.isArray(request.sourceEventIds)) {
    throw new BookStoryBibleJobContractError("全书世界观最终请求身份无效");
  }
  const validatedSources: string[] = [];
  const validatedInputs: Array<{ identityHash: string; contentHash: string }> = [];
  for (const [index, interval] of request.intervals.entries()) {
    if (interval.identityHash !== request.intervalIdentityHashes[index] ||
        interval.contentHash !== sha256(canonicalBookStoryBibleJson(interval.content))) {
      throw new BookStoryBibleJobContractError("全书世界观最终聚合区间内容无效");
    }
    parseBookStoryBibleContent(interval.content, new Set(interval.sourceEventIds));
    validatedSources.push(...interval.sourceEventIds);
    validatedInputs.push({ identityHash: interval.identityHash, contentHash: interval.contentHash });
  }
  if (request.kind !== "final" || request.identityHash !== sha256(canonical(request.identity)) || request.sourceEventIds.length === 0 ||
      request.identity.sourceEventIdsHash !== sha256(canonical(request.sourceEventIds)) ||
      request.intervalIdentityHashes.length < 1 ||
      request.intervals.length !== request.intervalIdentityHashes.length ||
      new Set(validatedSources).size !== validatedSources.length ||
      canonical(validatedSources) !== canonical(request.sourceEventIds) ||
      request.identity.intervalContentsHash !== sha256(canonical(validatedInputs)) ||
      request.identity.contractVersion !== BOOK_STORY_BIBLE_CONTRACT_VERSION ||
      request.identity.promptVersion !== BOOK_STORY_BIBLE_PROMPT_VERSION ||
      request.identity.parserVersion !== BOOK_STORY_BIBLE_PARSER_VERSION) {
    throw new BookStoryBibleJobContractError("全书世界观最终请求身份无效");
  }
  validProvenance(request.provenance);
  const content = parseBookStoryBibleContent(value, new Set(request.sourceEventIds));
  return { content, contentHash: sha256(canonicalBookStoryBibleJson(content)) };
}

export function planStoryBibleRebuild(
  intervals: readonly StoryBibleIntervalRequest[],
  changedSourceEventIds: ReadonlySet<string>,
  options: { force?: boolean } = {},
): StoryBibleRebuildPlan {
  const force = options.force === true;
  const intervalIdentityHashes = intervals
    .filter((interval) => force || interval.sourceEventIds.some((id) => changedSourceEventIds.has(id)))
    .map((interval) => interval.identityHash);
  return { intervalIdentityHashes, rebuildFinal: intervalIdentityHashes.length > 0, forceNewVersion: force };
}
