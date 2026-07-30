export interface ChapterRangeInput {
  chapterId: string;
  chapterIndex: number;
  characterCount: number;
}

export interface EpisodeChapterRange {
  episodeIndex: number;
  startChapterId: string;
  endChapterId: string;
  startChapterIndex: number;
  endChapterIndex: number;
  characterCount: number;
}

export function allocateEpisodeChapterRanges(
  chapters: readonly ChapterRangeInput[],
  episodeCount: number,
): EpisodeChapterRange[] {
  if (!Number.isSafeInteger(episodeCount) || episodeCount < 1 || episodeCount > chapters.length) {
    throw new Error("总集数必须为正整数且不能超过所选章节数");
  }
  if (chapters.some((chapter, index) => !chapter.chapterId || !Number.isSafeInteger(chapter.chapterIndex) ||
      chapter.characterCount < 0 || !Number.isSafeInteger(chapter.characterCount) ||
      (index > 0 && chapter.chapterIndex !== chapters[index - 1]!.chapterIndex + 1))) {
    throw new Error("章节范围必须连续且包含有效字符数");
  }

  const total = chapters.reduce((sum, chapter) => sum + chapter.characterCount, 0);
  const ranges: EpisodeChapterRange[] = [];
  let start = 0;
  let consumed = 0;
  for (let episodeIndex = 1; episodeIndex <= episodeCount; episodeIndex += 1) {
    const remainingEpisodes = episodeCount - episodeIndex;
    const latestEnd = chapters.length - remainingEpisodes - 1;
    let end = start;
    if (remainingEpisodes > 0) {
      const target = total * episodeIndex / episodeCount;
      let cumulative = consumed + chapters[start]!.characterCount;
      while (end < latestEnd) {
        const next = cumulative + chapters[end + 1]!.characterCount;
        if (Math.abs(target - cumulative) <= Math.abs(target - next)) break;
        end += 1;
        cumulative = next;
      }
    } else {
      end = latestEnd;
    }
    const selected = chapters.slice(start, end + 1);
    const characterCount = selected.reduce((sum, chapter) => sum + chapter.characterCount, 0);
    ranges.push({
      episodeIndex,
      startChapterId: selected[0]!.chapterId,
      endChapterId: selected.at(-1)!.chapterId,
      startChapterIndex: selected[0]!.chapterIndex,
      endChapterIndex: selected.at(-1)!.chapterIndex,
      characterCount,
    });
    consumed += characterCount;
    start = end + 1;
  }
  return ranges;
}

export function validateConfirmedEpisodeChapterRanges(
  chapters: readonly ChapterRangeInput[],
  ranges: readonly Pick<EpisodeChapterRange, "episodeIndex" | "startChapterId" | "endChapterId">[],
): EpisodeChapterRange[] {
  if (ranges.length < 1 || ranges.length > chapters.length) throw new Error("确认的分集范围数量无效");
  const byId = new Map(chapters.map((chapter, index) => [chapter.chapterId, { chapter, index }]));
  let expectedStart = 0;
  return ranges.map((range, index) => {
    const start = byId.get(range.startChapterId);
    const end = byId.get(range.endChapterId);
    if (range.episodeIndex !== index + 1 || !start || !end || start.index !== expectedStart || end.index < start.index ||
        chapters.length - end.index - 1 < ranges.length - index - 1) {
      throw new Error("确认的分集范围必须连续、非空、无重叠且覆盖全部所选章节");
    }
    expectedStart = end.index + 1;
    const selected = chapters.slice(start.index, end.index + 1);
    if (index === ranges.length - 1 && expectedStart !== chapters.length) {
      throw new Error("确认的分集范围必须覆盖全部所选章节");
    }
    return {
      episodeIndex: index + 1,
      startChapterId: start.chapter.chapterId,
      endChapterId: end.chapter.chapterId,
      startChapterIndex: start.chapter.chapterIndex,
      endChapterIndex: end.chapter.chapterIndex,
      characterCount: selected.reduce((sum, chapter) => sum + chapter.characterCount, 0),
    };
  });
}
