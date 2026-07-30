import type { Chapter, ChapterEvent, ChapterEventType } from "./types";

export interface ChapterEventDraft {
  key: string;
  type: ChapterEventType;
  primary: string;
  secondary: string;
  sources: { byteStart: number; byteEnd: number }[];
}

export const CHAPTER_EVENT_TYPE_OPTIONS: { value: ChapterEventType; label: string }[] = [
  { value: "character", label: "人物" },
  { value: "location", label: "地点" },
  { value: "prop", label: "道具" },
  { value: "causality", label: "因果" },
  { value: "revelation", label: "揭示" },
  { value: "suspense", label: "悬念" },
];

export function remainingChapterEventPageOffsets(total: number, loaded: number) {
  const offsets: number[] = [];
  for (let offset = loaded; offset < total; offset += 100) offsets.push(offset);
  return offsets;
}

export function chapterAnalysisJobPayload(bookId: string, chapter: Chapter) {
  if (!bookId.trim() || !chapter.id.trim()) throw new Error("章节自动分析缺少有效的书籍或章节 ID");
  return { bookId: bookId.trim(), chapterId: chapter.id.trim() };
}

export function chapterEventDraft(event: ChapterEvent): ChapterEventDraft {
  const named = event.type === "character" || event.type === "location" || event.type === "prop";
  return {
    key: event.id,
    type: event.type,
    primary: named ? event.payload.name ?? "" : event.type === "causality" ? event.payload.cause ?? "" : event.type === "revelation" ? event.payload.fact ?? "" : event.payload.question ?? "",
    secondary: named ? event.payload.detail ?? "" : event.type === "causality" ? event.payload.effect ?? "" : "",
    sources: event.sources.map(({ byteStart, byteEnd }) => ({ byteStart, byteEnd })),
  };
}

export function emptyChapterEventDraft(chapter: Chapter): ChapterEventDraft {
  return {
    key: crypto.randomUUID(),
    type: "character",
    primary: "",
    secondary: "",
    sources: [{ byteStart: chapter.byte_start, byteEnd: chapter.byte_end }],
  };
}

export function chapterEventsJobPayload(bookId: string, chapter: Chapter, drafts: ChapterEventDraft[]) {
  const occurrences = new Map<ChapterEventType, number>();
  const events = drafts.map((draft) => {
    const primary = draft.primary.trim();
    const secondary = draft.secondary.trim();
    if (!primary) throw new Error("事件主要内容不能为空");
    if (draft.type === "causality" && !secondary) throw new Error("因果事件的结果不能为空");
    if (!draft.sources.length) throw new Error("每个事件至少需要一段原文证据");
    const sources = draft.sources.map(({ byteStart, byteEnd }) => {
      if (!Number.isSafeInteger(byteStart) || !Number.isSafeInteger(byteEnd) || byteStart < chapter.byte_start || byteEnd > chapter.byte_end || byteEnd <= byteStart) {
        throw new Error("原文证据范围必须位于当前章节内且不能为空");
      }
      return { byteStart, byteEnd };
    });
    const occurrence = occurrences.get(draft.type) ?? 0;
    occurrences.set(draft.type, occurrence + 1);
    const payload = draft.type === "character" || draft.type === "location" || draft.type === "prop"
      ? { name: primary, ...(secondary ? { detail: secondary } : {}) }
      : draft.type === "causality"
        ? { cause: primary, effect: secondary }
        : draft.type === "revelation"
          ? { fact: primary }
          : { question: primary };
    return { type: draft.type, occurrence, payload, sources };
  });
  return { bookId, chapters: [{ chapterId: chapter.id, events }] };
}
