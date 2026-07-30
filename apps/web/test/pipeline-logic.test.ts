import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToString } from "react-dom/server";

import { ChapterEventsStage } from "../src/production/ChapterEventsStage.tsx";
import { PipelineSetup } from "../src/production/pipeline/PipelineSetup.tsx";
import { PipelineProgress } from "../src/production/pipeline/PipelineProgress.tsx";
import { mapFullBookWorldview, readFullBookWorldview, type FullBookWorldviewContent } from "../src/production/pipeline/full-book-worldview.ts";
import {
  formatPipelineDuration,
  pipelineChapterEventsReadOnly,
  pipelineCreateInput,
  pipelineRangeCount,
  pipelineStatusPresentation,
  pipelineStatusText,
  type SeriesPipelineRun,
} from "../src/production/pipeline/pipeline-logic.ts";
import { readInitialRun } from "../src/production/pipeline/use-series-pipeline.ts";
import type { Chapter } from "../src/production/types.ts";

const chapters: Chapter[] = Array.from({ length: 3 }, (_, index) => ({
  id: `chapter_${index + 1}`,
  title: `第${index + 1}章`,
  chapter_index: index,
  char_count: 100,
  byte_start: index * 100,
  byte_end: (index + 1) * 100,
}));
const policy = { minimumSeconds: 60, defaultSeconds: 1200, maximumSeconds: 3600, stepSeconds: 30 };

function run(change: Partial<SeriesPipelineRun> = {}): SeriesPipelineRun {
  return {
    id: "pipeline_1",
    seriesProjectId: "series_1",
    status: "analyzing_chapters",
    resumeStatus: null,
    episodeCount: 10,
    targetDurationSeconds: 1200,
    chapterBatchSize: 1,
    chapterConcurrency: 8,
    sourceStartChapterId: "chapter_1",
    sourceEndChapterId: "chapter_3",
    failureCode: null,
    failureMessage: null,
    storyBibleId: null,
    progress: {
      chapterAnalysis: { completed: 1, total: 3, reused: 1, queued: 1, running: 1, failed: 0 },
      storyBible: { completed: 0, total: 1, steps: null },
      episodePlan: { completed: 0, total: 10 },
      scripts: { completed: 0, total: 20 },
    },
    current: { stage: "chapter_analysis", subjectType: "chapter", subjectId: "chapter_2", jobId: "job_2" },
    failures: [],
    actions: { canPause: true, canResume: false, canCancel: true, canRetry: false },
    ...change,
  };
}

test("全本设置只接受连续范围、成片规格和单章滚动并发", () => {
  const input = { episodeCount: 10, targetDurationSeconds: 1200, chapterBatchSize: 1, chapterConcurrency: 8, sourceStartChapterId: "chapter_1", sourceEndChapterId: "chapter_3" };
  assert.deepEqual(pipelineCreateInput(input, chapters, policy), input);
  assert.equal(pipelineRangeCount(chapters, "chapter_1", "chapter_3"), 3);
  assert.throws(() => pipelineCreateInput({ ...input, sourceStartChapterId: "chapter_3", sourceEndChapterId: "chapter_1" }, chapters, policy), /顺序正确/);
  assert.throws(() => pipelineCreateInput({ ...input, episodeCount: 0 }, chapters, policy), /1～1000/);
  assert.throws(() => pipelineCreateInput({ ...input, targetDurationSeconds: 61 }, chapters, policy), /30 秒递增/);
  assert.throws(() => pipelineCreateInput({ ...input, chapterBatchSize: 2 }, chapters, policy), /每章一个独立任务/);
  assert.equal(pipelineCreateInput({ ...input, chapterConcurrency: 8 }, chapters, policy).chapterConcurrency, 8);
  assert.throws(() => pipelineCreateInput({ ...input, chapterConcurrency: 9 }, chapters, policy), /1～8/);
});

test("全本设置隐藏批次并展示默认章级并发", () => {
  const html = renderToString(createElement(PipelineSetup, {
    chapters,
    chapterTotal: chapters.length,
    policy,
    loading: false,
    submitting: false,
    operation: "设置已就绪",
    onCreate: () => undefined,
  }));
  assert.doesNotMatch(html, /每批最多章节数|并发批次数/);
  assert.match(html, /章节分析并发数/);
  assert.match(html, /value="8"/);
  assert.match(html, /max="8"/);
  assert.match(html, /每章独立分析/);
  assert.match(html, /min-h-11/);
});

test("总目标时长只由用户集数和单集秒数计算", () => {
  assert.equal(formatPipelineDuration(10 * 1200), "3 小时 20 分钟");
  assert.equal(formatPipelineDuration(0), "待填写");
});

test("运行中章节事件只读，暂停后恢复人工修复", () => {
  assert.equal(pipelineChapterEventsReadOnly(run()), true);
  assert.equal(pipelineChapterEventsReadOnly(run({ status: "paused" })), false);
  assert.equal(pipelineStatusText(run({ status: "paused", current: null })), "任务已暂停。已完成结果已保留。");
  assert.equal(pipelineStatusText(run({ status: "cancelled", current: null })), "任务已取消。已完成章节事件已保留。");
});

test("URL 中跨系列 runId 不会被采用并回退当前系列 run", async () => {
  const originalFetch = globalThis.fetch;
  const requests: string[] = [];
  globalThis.fetch = async (input) => {
    const url = String(input);
    requests.push(url);
    if (url === "/api/pipeline-runs/pipeline_foreign") {
      return Response.json({ run: run({ id: "pipeline_foreign", seriesProjectId: "series_other" }) });
    }
    if (url === "/api/series/series_1/pipeline-runs/current") {
      return Response.json({ run: run({ id: "pipeline_current", seriesProjectId: "series_1" }) });
    }
    return Response.json({ message: "unexpected" }, { status: 500 });
  };
  try {
    const restored = await readInitialRun("series_1", "pipeline_foreign", new AbortController().signal);
    assert.equal(restored?.id, "pipeline_current");
    assert.equal(restored?.seriesProjectId, "series_1");
    assert.deepEqual(requests, [
      "/api/pipeline-runs/pipeline_foreign",
      "/api/series/series_1/pipeline-runs/current",
    ]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("全本进度渲染真实章数和并发状态，不冒充唯一当前章节", () => {
  const html = renderToString(createElement(PipelineProgress, {
    run: run(), chapters, operation: "已恢复全本改写任务。", onControl: () => undefined, onReset: () => undefined,
  }));
  assert.match(html, /已完成 1\/3 章/);
  assert.match(html, /复用 1/);
  assert.match(html, /正在并发分析 1 章/);
  assert.doesNotMatch(html, /第 2 章|job_2/);
  assert.match(html, /暂停当前任务/);
  assert.doesNotMatch(html, /暂停后续任务/);
  assert.doesNotMatch(html, /<progress|%/);
  assert.match(html, /min-h-11/);
});

test("运行页以章级语义展示新任务并保守标记旧任务并发", () => {
  const html = renderToString(createElement(PipelineProgress, {
    run: run({ chapterBatchSize: 1, chapterConcurrency: 1 }),
    chapters,
    operation: "已恢复全本改写任务。",
    onControl: () => undefined,
    onReset: () => undefined,
  }));
  assert.match(html, /本次全本改写冻结设置/);
  assert.match(html, /章节分析并发/);
  assert.match(html, /最多 1 章/);
  assert.doesNotMatch(html, /每批最多章节|并发批次/);

  const legacy = renderToString(createElement(PipelineProgress, {
    run: run({ chapterBatchSize: 10, chapterConcurrency: 8 }), chapters,
    operation: "已恢复历史任务。", onControl: () => undefined, onReset: () => undefined,
  }));
  assert.match(legacy, /历史分析并发/);
  assert.match(legacy, /最多 8 个任务/);
});

test("失败且没有活动 Job 时隐藏暂停并保留后端允许的重试与取消", () => {
  const html = renderToString(createElement(PipelineProgress, {
    run: run({
      status: "failed",
      current: null,
      failureCode: "handler_failed",
      failureMessage: "章节分析失败，请重试该章节",
      progress: {
        ...run().progress,
        chapterAnalysis: { completed: 1, total: 3, reused: 1, queued: 0, running: 0, failed: 2 },
      },
      actions: { canPause: true, canResume: false, canCancel: true, canRetry: true },
    }),
    chapters,
    operation: "流水线执行失败。",
    onControl: () => undefined,
    onReset: () => undefined,
  }));
  assert.match(html, /全本改写执行失败/);
  assert.match(html, /重试失败任务/);
  assert.match(html, /取消全本改写/);
  assert.doesNotMatch(html, /暂停当前任务|固定流水线正在处理全书/);
});

test("全书世界观构建展示后端返回的真实步骤进度", () => {
  const current = run({
    status: "building_story_bible",
    progress: {
      ...run().progress,
      storyBible: { completed: 0, total: 1, steps: { completed: 1, total: 91 } },
    },
    current: { stage: "story_bible", subjectType: "bible_chunk", subjectId: "chunk_1", jobId: "job_bible" },
  });
  const html = renderToString(createElement(PipelineProgress, {
    run: current, chapters, operation: "正在构建全书世界观。", onControl: () => undefined, onReset: () => undefined,
  }));
  assert.match(html, /1\/91/);
  assert.match(html, /已完成 1\/91 个构建步骤/);
  assert.doesNotMatch(html, /单次模型请求不显示虚构百分比/);
});

test("当前 final 提供只读查看入口，未完成时不伪造空内容", () => {
  const ready = renderToString(createElement(PipelineProgress, {
    run: run({ storyBibleId: "bible_current" }), chapters, operation: "全书世界观已完成。",
    onControl: () => undefined, onReset: () => undefined,
  }));
  assert.match(ready, /查看全书世界观/);
  assert.match(ready, /不会触发重建或审批/);
  const building = renderToString(createElement(PipelineProgress, {
    run: run({ status: "building_story_bible" }), chapters, operation: "正在构建全书世界观。",
    onControl: () => undefined, onReset: () => undefined,
  }));
  assert.match(building, /全书世界观尚不可用/);
  assert.doesNotMatch(building, /查看全书世界观/);
  const failed = renderToString(createElement(PipelineProgress, {
    run: run({ status: "failed", failureMessage: "供应商响应无效" }), chapters, operation: "流水线失败。",
    onControl: () => undefined, onReset: () => undefined,
  }));
  assert.match(failed, /全书世界观构建失败：供应商响应无效/);
  assert.match(failed, /role="alert"/);
});

test("12 类内容映射保留每条事实的章节与来源展开信息", () => {
  const source = { sourceEventIds: ["event_1"] };
  const content: FullBookWorldviewContent = {
    characters: [{ canonicalName: "林舟", aliases: [], identities: [{ text: "调查员", ...source }], motivations: [], stateChanges: [{ state: "进入旧站", chapterIds: ["chapter_1"], ...source }], ...source }],
    relationships: [{ subject: "林舟", object: "沈岚", relation: "同伴", chapterIds: ["chapter_1"], ...source }],
    locations: [{ name: "旧站", aliases: [], detail: "封闭车站", ...source }], organizations: [], items: [], concepts: [],
    timeline: [{ summary: "进入旧站", chapterIds: ["chapter_1"], ...source }],
    flashbacks: [{ summary: "旧站停运", startChapterId: "chapter_1", endChapterId: "chapter_1", ...source }],
    plotThreads: [{ kind: "suspense", setup: "回声", revealCondition: null, resolution: null, chapterIds: ["chapter_1"], ...source }],
    confusingFacts: [{ statement: "时间异常", clarification: "原因未明", ...source }],
    spoilerRestrictions: [{ information: "侧门真相", forbiddenUntil: "chapter_3", ...source }],
    properNouns: [{ term: "回声层", pronunciation: "huí shēng céng", aliases: [], ...source }],
  };
  const sections = mapFullBookWorldview(content);
  assert.deepEqual(sections.map((item) => item.label), ["人物", "关系", "地点", "组织", "器物", "概念", "时间线", "回忆", "情节线", "疑难事实", "剧透限制", "专有名词"]);
  assert.deepEqual(sections[0]!.entries[0]!.details.at(-1), {
    label: "状态变化", text: "进入旧站", chapterIds: ["chapter_1"], sourceEventIds: ["event_1"],
  });
});

test("查看客户端只发送 GET，不提交 mutation", async () => {
  const originalFetch = globalThis.fetch;
  const calls: Array<{ url: string; method: string | undefined }> = [];
  globalThis.fetch = async (input, init) => {
    calls.push({ url: String(input), method: init?.method });
    return Response.json({ worldview: { content: {}, metadata: {} } });
  };
  try {
    await readFullBookWorldview("run/1", new AbortController().signal);
    assert.deepEqual(calls, [{ url: "/api/pipeline-runs/run%2F1/full-book-worldview", method: "GET" }]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("全书规划保留冻结产物计数并展示当前 Job 真实进度", () => {
  const current = run({
    status: "planning_episodes",
    episodeCount: 20,
    chapterConcurrency: 8,
    progress: {
      ...run().progress,
      episodePlan: { completed: 0, total: 20 },
      scripts: { completed: 0, total: 40 },
    },
    current: {
      stage: "episode_plan",
      subjectType: "plan",
      subjectId: "plan_1",
      jobId: "job_plan",
      jobStatus: "running",
      jobProgress: 3 / 21,
      jobAttempts: 1,
      jobMaxAttempts: 3,
    },
  });
  const html = renderToString(createElement(PipelineProgress, {
    run: current, chapters, operation: "已恢复全本改写任务。", onControl: () => undefined, onReset: () => undefined,
  }));
  assert.match(html, /0\/20/);
  assert.match(html, /当前规划任务 14%/);
  assert.match(html, /第 1\/3 次执行/);
  assert.match(html, /并发上限 8/);
  assert.doesNotMatch(html, /单次模型请求不显示虚构百分比/);

  const queuedHtml = renderToString(createElement(PipelineProgress, {
    run: { ...current, current: { ...current.current!, jobStatus: "queued", jobProgress: 0, jobAttempts: 2 } },
    chapters,
    operation: "任务等待执行。",
    onControl: () => undefined,
    onReset: () => undefined,
  }));
  assert.match(queuedHtml, /当前任务等待执行；已尝试 2\/3 次/);
});

test("新合同展示确定性分集来源冻结与单一成片旁白，旧合同保留历史名称", () => {
  const render = (planningContractVersion: 1 | 2, scriptContractVersion: 5 | 6) => renderToString(createElement(PipelineProgress, {
    run: run({ planningContractVersion, scriptContractVersion }), chapters,
    operation: "已恢复全本改写任务。", onControl: () => undefined, onReset: () => undefined,
  }));
  const current = render(2, 6);
  assert.match(current, /分集来源冻结/);
  assert.doesNotMatch(current, /全书世界观|逐集局部规划/);
  assert.match(current, />成片旁白稿</);
  assert.doesNotMatch(current, /原著还原稿与成片旁白稿/);
  const legacy = render(1, 5);
  assert.match(legacy, /全书分集规划/);
  assert.match(legacy, /原著还原稿与成片旁白稿/);
});

test("稿件阶段同时展示已持久双稿数与当前单集 Job 真实进度", () => {
  const current = run({
    status: "generating_scripts",
    episodeCount: 20,
    chapterConcurrency: 4,
    progress: {
      ...run().progress,
      episodePlan: { completed: 20, total: 20 },
      scripts: { completed: 2, total: 40 },
    },
    current: {
      stage: "script_generation",
      subjectType: "episode",
      subjectId: "episode_2",
      jobId: "job_scripts",
      jobStatus: "running",
      jobProgress: 0.5,
      jobAttempts: 1,
      jobMaxAttempts: 3,
    },
  });
  const html = renderToString(createElement(PipelineProgress, {
    run: current, chapters, operation: "正在生成稿件。", onControl: () => undefined, onReset: () => undefined,
  }));
  assert.match(html, /2\/40/);
  assert.match(html, /正在生成第 2\/20 集/);
  assert.match(html, /当前单集任务 50%/);
  assert.match(html, /还原稿分段并发上限 4/);
});

test("覆盖检查保持处理中语义，自动生产完成后明确等待逐集审核", () => {
  const completeProgress = {
    chapterAnalysis: { completed: 3, total: 3, reused: 0, queued: 0, running: 0, failed: 0 },
    storyBible: { completed: 1, total: 1, steps: null },
    episodePlan: { completed: 3, total: 3 },
    scripts: { completed: 6, total: 6 },
  };
  const checking = run({ status: "checking_coverage", current: null, episodeCount: 3, progress: completeProgress });
  assert.equal(pipelineStatusPresentation(checking.status).heading, "固定流水线正在处理全书");
  assert.equal(pipelineStatusText(checking), "稿件生成完成，正在检查完整性。");
  const checkingHtml = renderToString(createElement(PipelineProgress, {
    run: checking, chapters, operation: "正在检查稿件覆盖。", onControl: () => undefined, onReset: () => undefined,
  }));
  assert.match(checkingHtml, /固定流水线正在处理全书/);
  assert.match(checkingHtml, /状态：<!-- -->检查覆盖/);
  assert.match(checkingHtml, /稿件生成完成；正在检查完整性/);

  const awaiting = run({
    status: "awaiting_review", current: null, episodeCount: 3, progress: completeProgress,
    actions: { canPause: false, canResume: false, canCancel: false, canRetry: false },
  });
  assert.equal(pipelineStatusText(awaiting), "自动生产完成，等待逐集审核。");
  const awaitingHtml = renderToString(createElement(PipelineProgress, {
    run: awaiting, chapters, operation: "已恢复全本改写任务。", onControl: () => undefined, onReset: () => undefined,
  }));
  assert.match(awaitingHtml, /自动生产完成，等待逐集审核/);
  assert.match(awaitingHtml, /状态：<!-- -->等待审核/);
  assert.match(awaitingHtml, /自动生产已完成，等待逐集审核/);
  assert.doesNotMatch(awaitingHtml, /固定流水线正在处理全书|暂停当前任务|取消全本改写/);

  assert.equal(pipelineStatusPresentation("paused").heading, "全本改写已暂停");
  assert.equal(pipelineStatusPresentation("failed").heading, "全本改写执行失败");
  assert.equal(pipelineStatusPresentation("cancelled").heading, "全本改写已取消");
  assert.equal(pipelineStatusPresentation("completed").heading, "全本改写已完成");
});

test("流水线只读不会锁死章节浏览，但会禁用事件写操作", () => {
  const html = renderToString(createElement(ChapterEventsStage, {
    chapters,
    total: chapters.length,
    selected: chapters[0],
    text: "原文",
    events: [],
    locked: false,
    readOnly: true,
    onSelect: () => undefined,
    onSave: () => undefined,
    onAnalyze: () => undefined,
  }));
  assert.match(html, /全本流水线运行期间章节事件只读/);
  assert.match(html, /自动分析本章<\/button>/);
  const chapterSection = html.match(/<section[^>]*aria-labelledby="production-chapters-heading"[^]*?<\/section>/)?.[0] ?? "";
  assert.match(chapterSection, /<button/);
  assert.doesNotMatch(chapterSection, /<button[^>]*disabled/);
});
