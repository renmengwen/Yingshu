import type { Chapter } from "../types";
import type { PipelineCreateInput } from "./pipeline-logic";

export interface EpisodeChapterRange {
  episodeIndex: number;
  startChapterId: string;
  endChapterId: string;
  startChapterIndex: number;
  endChapterIndex: number;
  characterCount: number;
}

export type PipelineCreateRequest = PipelineCreateInput & {
  episodeRanges: Array<Pick<EpisodeChapterRange, "episodeIndex" | "startChapterId" | "endChapterId">>;
};

export function adjustEpisodeBoundary(
  ranges: readonly EpisodeChapterRange[],
  rangeIndex: number,
  endChapterId: string,
  chapters: readonly Chapter[],
) {
  if (rangeIndex < 0 || rangeIndex >= ranges.length - 1) throw new Error("最后一集没有可调整的相邻边界");
  const chapterById = new Map(chapters.map((chapter) => [chapter.id, chapter]));
  const end = chapterById.get(endChapterId);
  const current = ranges[rangeIndex]!;
  const next = ranges[rangeIndex + 1]!;
  if (!end || end.chapter_index < current.startChapterIndex || end.chapter_index >= next.endChapterIndex) {
    throw new Error("相邻边界必须保证两集都至少包含一章");
  }
  const nextStart = chapters.find((chapter) => chapter.chapter_index === end.chapter_index + 1);
  if (!nextStart) throw new Error("相邻边界后的章节不存在");
  const characterCount = (start: number, finish: number) => chapters
    .filter((chapter) => chapter.chapter_index >= start && chapter.chapter_index <= finish)
    .reduce((sum, chapter) => sum + chapter.char_count, 0);
  return ranges.map((range, index) => index === rangeIndex ? {
    ...range,
    endChapterId: end.id,
    endChapterIndex: end.chapter_index,
    characterCount: characterCount(range.startChapterIndex, end.chapter_index),
  } : index === rangeIndex + 1 ? {
    ...range,
    startChapterId: nextStart.id,
    startChapterIndex: nextStart.chapter_index,
    characterCount: characterCount(nextStart.chapter_index, range.endChapterIndex),
  } : range);
}
