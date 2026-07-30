export const FULL_BOOK_PLAN_CONTRACT_VERSION = "full-book-plan-v1";

const MAX_EPISODES = 1_000;
const MAX_SOURCES_PER_EPISODE = 100_000;
const MAX_ID_LENGTH = 200;
const MAX_TITLE_LENGTH = 200;
const MAX_TEXT_LENGTH = 4_000;
const MAX_CANONICAL_BYTES = 8 * 1024 * 1024;

export interface FullBookPlanByteRange {
  byteStart: number;
  byteEnd: number;
}

export interface FullBookPlanSourceEvent {
  chapterId: string;
  chapterIndex: number;
  byteRanges: readonly FullBookPlanByteRange[];
}

export interface FullBookPlanIntervalQuota {
  startChapterIndex: number;
  endChapterIndex: number;
  episodeCount: number;
}

export interface FullBookPlanOptions {
  startChapterIndex: number;
  endChapterIndex: number;
  episodeCount: number;
  allowedSourceEvents: ReadonlyMap<string, FullBookPlanSourceEvent>;
  intervalQuotas?: readonly FullBookPlanIntervalQuota[];
}

export interface FullBookPlanEpisode {
  index: number;
  title: string;
  storyArc: string;
  sourceEventIds: string[];
  recap: string | null;
  nextHook: string | null;
}

export interface FullBookPlan {
  episodes: FullBookPlanEpisode[];
}

export class FullBookPlanContractError extends Error {}

interface ResolvedSourceEvent extends FullBookPlanSourceEvent {
  sourceEventId: string;
  byteStart: number;
  byteEnd: number;
}

function ordinaryObject(value: unknown, label: string, keys: readonly string[]) {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new FullBookPlanContractError(`${label}必须是普通对象`);
  }
  const record = value as Record<string, unknown>;
  const unknown = Object.keys(record).filter((key) => !keys.includes(key));
  if (unknown.length) throw new FullBookPlanContractError(`${label}包含未知字段：${unknown.sort().join("、")}`);
  return record;
}

function integer(value: unknown, label: string, minimum: number, maximum = Number.MAX_SAFE_INTEGER) {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw new FullBookPlanContractError(`${label}必须是 ${minimum}～${maximum} 的整数`);
  }
  return value as number;
}

function text(value: unknown, label: string, maximum: number) {
  if (typeof value !== "string") throw new FullBookPlanContractError(`${label}必须是字符串`);
  const normalized = value.replace(/\r\n?/gu, "\n").trim();
  if (!normalized || normalized.length > maximum) {
    throw new FullBookPlanContractError(`${label}长度必须在 1～${maximum} 个字符之间`);
  }
  return normalized;
}

function nullableText(value: unknown, label: string) {
  return value === null ? null : text(value, label, MAX_TEXT_LENGTH);
}

function validateOptions(options: FullBookPlanOptions) {
  const start = integer(options.startChapterIndex, "起始章节序号", 0);
  const end = integer(options.endChapterIndex, "结束章节序号", start);
  const episodeCount = integer(options.episodeCount, "总集数", 1, MAX_EPISODES);
  if (!(options.allowedSourceEvents instanceof Map) || options.allowedSourceEvents.size === 0) {
    throw new FullBookPlanContractError("来源事件白名单无效");
  }
  const events = new Map<string, ResolvedSourceEvent>();
  for (const [sourceEventIdValue, source] of options.allowedSourceEvents) {
    const sourceEventId = text(sourceEventIdValue, "来源事件 ID", MAX_ID_LENGTH);
    if (events.has(sourceEventId)) throw new FullBookPlanContractError(`来源事件白名单包含重复 ID：${sourceEventId}`);
    const row = ordinaryObject(source, `来源事件 ${sourceEventId}`, ["chapterId", "chapterIndex", "byteRanges"]);
    const chapterId = text(row.chapterId, `来源事件 ${sourceEventId}.chapterId`, MAX_ID_LENGTH);
    const chapterIndex = integer(row.chapterIndex, `来源事件 ${sourceEventId}.chapterIndex`, start, end);
    if (!Array.isArray(row.byteRanges) || row.byteRanges.length === 0 || row.byteRanges.length > MAX_SOURCES_PER_EPISODE) {
      throw new FullBookPlanContractError(`来源事件 ${sourceEventId}.byteRanges 必须包含 1～${MAX_SOURCES_PER_EPISODE} 项`);
    }
    const byteRanges = row.byteRanges.map((value, index) => {
      const range = ordinaryObject(value, `来源事件 ${sourceEventId}.byteRanges[${index}]`, ["byteStart", "byteEnd"]);
      const byteStart = integer(range.byteStart, `来源事件 ${sourceEventId}.byteRanges[${index}].byteStart`, 0);
      const byteEnd = integer(range.byteEnd, `来源事件 ${sourceEventId}.byteRanges[${index}].byteEnd`, byteStart + 1);
      return { byteStart, byteEnd };
    }).sort((left, right) => left.byteStart - right.byteStart || left.byteEnd - right.byteEnd);
    if (byteRanges.some((range, index) => index > 0 && range.byteStart < byteRanges[index - 1]!.byteEnd)) {
      throw new FullBookPlanContractError(`来源事件 ${sourceEventId} 的字节范围不能交叉`);
    }
    events.set(sourceEventId, {
      sourceEventId, chapterId, chapterIndex, byteRanges,
      byteStart: byteRanges[0]!.byteStart,
      byteEnd: byteRanges[byteRanges.length - 1]!.byteEnd,
    });
  }
  return { start, end, episodeCount, events };
}

function validateIntervalQuotas(
  quotas: readonly FullBookPlanIntervalQuota[] | undefined,
  start: number,
  end: number,
  episodeCount: number,
) {
  if (quotas === undefined) return undefined;
  if (!Array.isArray(quotas) || quotas.length === 0 || quotas.length > end - start + 1) {
    throw new FullBookPlanContractError("区间配额必须是非空且不超过章节数的数组");
  }
  let expectedStart = start;
  let total = 0;
  const normalized = quotas.map((value, index) => {
    const row = ordinaryObject(value, `区间配额[${index}]`, ["startChapterIndex", "endChapterIndex", "episodeCount"]);
    const intervalStart = integer(row.startChapterIndex, `区间配额[${index}].startChapterIndex`, expectedStart, expectedStart);
    const intervalEnd = integer(row.endChapterIndex, `区间配额[${index}].endChapterIndex`, intervalStart, end);
    const count = integer(row.episodeCount, `区间配额[${index}].episodeCount`, 1, episodeCount);
    expectedStart = intervalEnd + 1;
    total += count;
    return { startChapterIndex: intervalStart, endChapterIndex: intervalEnd, episodeCount: count };
  });
  if (expectedStart !== end + 1) throw new FullBookPlanContractError("区间配额必须连续覆盖选定章节范围");
  if (total !== episodeCount) throw new FullBookPlanContractError(`区间配额总和必须等于 ${episodeCount}`);
  return normalized;
}

function sourceOrder(left: ResolvedSourceEvent, right: ResolvedSourceEvent) {
  if (left.chapterIndex > right.chapterIndex ||
      (left.chapterIndex === right.chapterIndex && left.byteStart > right.byteStart)) {
    throw new FullBookPlanContractError("来源事件必须按原文顺序排列");
  }
}

export function parseFullBookPlan(value: unknown, options: FullBookPlanOptions): FullBookPlan {
  const { start, end, episodeCount, events } = validateOptions(options);
  const quotas = validateIntervalQuotas(options.intervalQuotas, start, end, episodeCount);
  const body = ordinaryObject(value, "全书分集计划", ["episodes"]);
  if (!Array.isArray(body.episodes) || body.episodes.length !== episodeCount) {
    throw new FullBookPlanContractError(`全书分集计划必须恰好包含 ${episodeCount} 集`);
  }
  const usedSourceEventIds = new Set<string>();
  const coveredChapters = new Set<number>();
  const resolvedEpisodes: Array<{ episode: FullBookPlanEpisode; sources: ResolvedSourceEvent[] }> = [];
  for (let offset = 0; offset < body.episodes.length; offset += 1) {
    const label = `episodes[${offset}]`;
    const row = ordinaryObject(body.episodes[offset], label, ["index", "title", "storyArc", "sourceEventIds", "recap", "nextHook"]);
    const index = integer(row.index, `${label}.index`, offset + 1, offset + 1);
    if (!Array.isArray(row.sourceEventIds) || row.sourceEventIds.length === 0 ||
        row.sourceEventIds.length > MAX_SOURCES_PER_EPISODE) {
      throw new FullBookPlanContractError(`${label}.sourceEventIds 必须包含 1～${MAX_SOURCES_PER_EPISODE} 项`);
    }
    const sourceEventIds = row.sourceEventIds.map((item, sourceIndex) =>
      text(item, `${label}.sourceEventIds[${sourceIndex}]`, MAX_ID_LENGTH));
    const sources = sourceEventIds.map((sourceEventId) => {
      const source = events.get(sourceEventId);
      if (!source) throw new FullBookPlanContractError(`${label}引用了未获准事件：${sourceEventId}`);
      if (usedSourceEventIds.has(sourceEventId)) {
        throw new FullBookPlanContractError(`来源事件不能跨集或在同集重复分配：${sourceEventId}`);
      }
      usedSourceEventIds.add(sourceEventId);
      coveredChapters.add(source.chapterIndex);
      return source;
    });
    sources.forEach((source, sourceIndex) => {
      if (sourceIndex > 0) sourceOrder(sources[sourceIndex - 1]!, source);
    });
    const chapterIndexes = [...new Set(sources.map((source) => source.chapterIndex))];
    if (chapterIndexes.some((chapter, chapterOffset) => chapterOffset > 0 && chapter !== chapterIndexes[chapterOffset - 1]! + 1)) {
      throw new FullBookPlanContractError(`${label}的来源章节必须连续`);
    }
    resolvedEpisodes.push({
      episode: {
        index,
        title: text(row.title, `${label}.title`, MAX_TITLE_LENGTH),
        storyArc: text(row.storyArc, `${label}.storyArc`, MAX_TEXT_LENGTH),
        sourceEventIds,
        recap: nullableText(row.recap, `${label}.recap`),
        nextHook: nullableText(row.nextHook, `${label}.nextHook`),
      },
      sources,
    });
  }
  resolvedEpisodes.forEach((current, index) => {
    if (index > 0) sourceOrder(resolvedEpisodes[index - 1]!.sources.at(-1)!, current.sources[0]!);
  });
  for (let chapterIndex = start; chapterIndex <= end; chapterIndex += 1) {
    if (!coveredChapters.has(chapterIndex)) throw new FullBookPlanContractError(`全书分集计划未覆盖章节 ${chapterIndex}`);
  }
  if (coveredChapters.size !== end - start + 1) throw new FullBookPlanContractError("全书分集计划来源超出选定章节范围");
  if (quotas) {
    for (const [index, quota] of quotas.entries()) {
      const details = resolvedEpisodes.filter(({ sources }) =>
        sources[0]!.chapterIndex >= quota.startChapterIndex && sources.at(-1)!.chapterIndex <= quota.endChapterIndex);
      if (details.length !== quota.episodeCount) {
        throw new FullBookPlanContractError(`区间配额[${index}]要求 ${quota.episodeCount} 集，实际明细为 ${details.length} 集`);
      }
    }
    if (resolvedEpisodes.some(({ sources }) => !quotas.some((quota) =>
      sources[0]!.chapterIndex >= quota.startChapterIndex && sources.at(-1)!.chapterIndex <= quota.endChapterIndex))) {
      throw new FullBookPlanContractError("分集明细不能跨越区间配额边界");
    }
  }
  const plan = { episodes: resolvedEpisodes.map(({ episode }) => episode) };
  if (Buffer.byteLength(canonicalFullBookPlanJson(plan), "utf8") > MAX_CANONICAL_BYTES) {
    throw new FullBookPlanContractError(`全书分集计划规范化内容不能超过 ${MAX_CANONICAL_BYTES} 字节`);
  }
  return plan;
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
  throw new FullBookPlanContractError("全书分集计划必须是可序列化 JSON");
}

export function canonicalFullBookPlanJson(plan: FullBookPlan) {
  return canonicalJson(plan);
}
