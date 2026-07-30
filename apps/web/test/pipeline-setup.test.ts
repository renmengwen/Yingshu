import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToString } from "react-dom/server";

import { PipelineSetup } from "../src/production/pipeline/PipelineSetup.tsx";
import { adjustEpisodeBoundary } from "../src/production/pipeline/pipeline-setup-logic.ts";
import type { Chapter } from "../src/production/types.ts";

const chapters: Chapter[] = Array.from({ length: 6 }, (_, index) => ({
  id: `chapter_${index + 1}`,
  title: `章节 ${index + 1}`,
  chapter_index: index,
  char_count: (index + 1) * 100,
  byte_start: index * 100,
  byte_end: (index + 1) * 100,
}));

test("调整相邻分集边界仍保持两集非空且重新计算字符数", () => {
  const ranges = [
    { episodeIndex: 1, startChapterId: "chapter_1", endChapterId: "chapter_2", startChapterIndex: 0, endChapterIndex: 1, characterCount: 300 },
    { episodeIndex: 2, startChapterId: "chapter_3", endChapterId: "chapter_4", startChapterIndex: 2, endChapterIndex: 3, characterCount: 700 },
    { episodeIndex: 3, startChapterId: "chapter_5", endChapterId: "chapter_6", startChapterIndex: 4, endChapterIndex: 5, characterCount: 1100 },
  ];
  const adjusted = adjustEpisodeBoundary(ranges, 0, "chapter_3", chapters);
  assert.deepEqual(adjusted.slice(0, 2), [
    { ...ranges[0], endChapterId: "chapter_3", endChapterIndex: 2, characterCount: 600 },
    { ...ranges[1], startChapterId: "chapter_4", startChapterIndex: 3, characterCount: 400 },
  ]);
  assert.throws(() => adjustEpisodeBoundary(ranges, 0, "chapter_4", chapters), /至少包含一章/);
  assert.throws(() => adjustEpisodeBoundary(ranges, 2, "chapter_6", chapters), /最后一集/);
});

test("全本设置展示付费前范围确认和四类仍被消费的本书提示词", () => {
  const html = renderToString(createElement(PipelineSetup, {
    bookId: "book_1",
    seriesId: "series_1",
    chapters,
    chapterTotal: chapters.length,
    policy: { defaultSeconds: 1200, minimumSeconds: 60, maximumSeconds: 3600, stepSeconds: 30 },
    loading: false,
    submitting: false,
    operation: "设置已就绪。",
    onCreate: () => undefined,
  }));
  for (const label of ["全书共同要求", "章节分析要求", "成片旁白要求", "资产 Prompt 要求"]) {
    assert.match(html, new RegExp(label));
  }
  assert.doesNotMatch(html, /全书世界观要求|单集规划要求|逐集局部规划/);
  assert.match(html, /冻结已确认的分集来源/);
  assert.match(html, /预览分集范围/);
  assert.match(html, /创建后才会开始可能产生费用的模型分析/);
  assert.doesNotMatch(html, /产品级提示词（只读）/);
  assert.doesNotMatch(html, /故事圣经|原著还原稿/);
});
