import assert from "node:assert/strict";
import test from "node:test";

import { allocateEpisodeChapterRanges, validateConfirmedEpisodeChapterRanges } from "./episode-range-allocation.js";

const chapters = [100, 300, 100, 500, 200].map((characterCount, index) => ({
  chapterId: `chapter_${index + 1}`,
  chapterIndex: index + 1,
  characterCount,
}));

test("确定性分配恰好覆盖连续章节且为每集保留非空范围", () => {
  const ranges = allocateEpisodeChapterRanges(chapters, 3);
  assert.deepEqual(ranges.map(({ episodeIndex, startChapterId, endChapterId, characterCount }) => ({
    episodeIndex, startChapterId, endChapterId, characterCount,
  })), [
    { episodeIndex: 1, startChapterId: "chapter_1", endChapterId: "chapter_2", characterCount: 400 },
    { episodeIndex: 2, startChapterId: "chapter_3", endChapterId: "chapter_4", characterCount: 600 },
    { episodeIndex: 3, startChapterId: "chapter_5", endChapterId: "chapter_5", characterCount: 200 },
  ]);
  assert.deepEqual(allocateEpisodeChapterRanges(chapters, 3), ranges);
});

test("确认范围允许调整相邻边界但拒绝遗漏、重叠与空集", () => {
  const confirmed = validateConfirmedEpisodeChapterRanges(chapters, [
    { episodeIndex: 1, startChapterId: "chapter_1", endChapterId: "chapter_1" },
    { episodeIndex: 2, startChapterId: "chapter_2", endChapterId: "chapter_4" },
    { episodeIndex: 3, startChapterId: "chapter_5", endChapterId: "chapter_5" },
  ]);
  assert.deepEqual(confirmed.map((range) => range.characterCount), [100, 900, 200]);
  assert.throws(() => validateConfirmedEpisodeChapterRanges(chapters, [
    { episodeIndex: 1, startChapterId: "chapter_1", endChapterId: "chapter_2" },
    { episodeIndex: 2, startChapterId: "chapter_4", endChapterId: "chapter_5" },
  ]), /连续/);
  assert.throws(() => allocateEpisodeChapterRanges(chapters, 6), /不能超过/);
});
