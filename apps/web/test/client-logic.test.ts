import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { act, createElement, StrictMode, useEffect, useLayoutEffect } from "react";
import { createRoot } from "react-dom/client";
import { renderToString } from "react-dom/server";

import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "../src/components/ui/accordion.tsx";
import {
  AUDIO_SEGMENTS_PER_PAGE,
  audioPageCount,
  audioSegmentUrl,
  audioSegmentsForPage,
  clampAudioPage,
  completedTtsCalibrationMode,
  ttsTimelinePayload,
} from "../src/production/audio/audio-editor.ts";
import {
  chapterPagePath,
  isSettingsSearch,
  resolveTheme,
  resolveThemePreference,
  responseJson,
  seriesWorkspaceFromSearch,
  seriesWorkspacePath,
  withSettingsSearch,
  withoutSettingsSearch,
} from "../src/client-logic.ts";
import {
  assembleImagePrompt,
  isTerminalJobStatus,
  mergeProductionWorkspaceLocation,
  normalizeJobProgress,
  productionWorkspaceFromSearch,
  productionWorkspacePath,
  resolveProductionStage,
  resolveExportStageIdentity,
  stageDependencyLabel,
  updateWorkspaceStatusLayer,
} from "../src/production-logic.ts";
import { chapterAnalysisJobPayload, chapterEventDraft, chapterEventsJobPayload, remainingChapterEventPageOffsets } from "../src/production/chapter-event-editor.ts";
import { assetGapCounts, assetPromptDraftFromJob, canApplyCandidateRefresh, candidatePromptJobId, candidateUploadRequest, generatedCandidateAssetId, promptFromCandidateJob } from "../src/production/assets/asset-candidate-editor.ts";
import type { AssetRecord, CandidateRecord } from "../src/production/assets/types.ts";
import {
  consumeEpisodeRecommendation, createEpisodeHydrationCoordinator, emptyEpisodeDraft, episodeDraft,
  episodePutPayload, episodeRecommendationJobMatchesIdentity, recommendationChapterSummaries,
  type EpisodeDraft,
} from "../src/production/episode/episode-editor.ts";
import { useCommittedEpisodeIdentity } from "../src/production/episode/use-episode-workspace.ts";
import { EpisodeNavigation } from "../src/production/episode-navigation/EpisodeNavigation.tsx";
import { episodeNavigationTarget } from "../src/production/episode-navigation/episode-navigation-client.ts";
import {
  applyIfCurrentScriptRoute,
  useCommittedScriptWorkspaceRefs,
  useScriptWorkspace,
} from "../src/production/scripts/use-script-workspace.ts";
import type { Episode, EpisodeRecommendation } from "../src/production/types.ts";
import {
  allowedSourceIndexes,
  approvalPutPayload,
  canStartEpisodeScriptGeneration,
  completedEpisodeScriptVersions,
  episodeScriptJobMatchesIdentity,
  episodeScriptCalibration,
  isFinishedNarrationVersion,
  isScriptDraftDirty,
  resolveEpisodeScriptWorkspaceStatus,
  scriptDraft,
  scriptDraftSignature,
  scriptPostPayload,
  scriptWorkspaceContractVersion,
} from "../src/production/scripts/script-editor.ts";
import { visualCandidateState } from "../src/production/visual/visual-editor.ts";
import { AudioStage } from "../src/production/audio/AudioStage.tsx";
import { ProductionExportStage } from "../src/ProductionWorkspace.tsx";

test("保存的主题优先于系统偏好", () => {
  assert.equal(resolveTheme("light", true), "light");
  assert.equal(resolveTheme("dark", false), "dark");
});

test("无有效保存值时遵循系统主题", () => {
  assert.equal(resolveThemePreference(null), "system");
  assert.equal(resolveThemePreference("unexpected"), "system");
  assert.equal(resolveTheme("system", true), "dark");
  assert.equal(resolveTheme("system", false), "light");
});

test("章节分页从已加载数量继续请求", () => {
  assert.equal(chapterPagePath("book_123", 100), "/api/books/book_123/chapters?limit=100&offset=100");
});

test("系列工作台地址可刷新恢复且安全编码", () => {
  const path = seriesWorkspacePath("book/北派", "series?1");
  assert.equal(path, "?book=book%2F%E5%8C%97%E6%B4%BE&series=series%3F1");
  assert.deepEqual(seriesWorkspaceFromSearch(path), { bookId: "book/北派", seriesId: "series?1" });
  assert.equal(seriesWorkspaceFromSearch("?book=book_only"), undefined);
});

test("设置地址可叠加在书库或系列工作台并兼容旧模型设置地址", () => {
  assert.equal(isSettingsSearch("?settings=global"), true);
  assert.equal(isSettingsSearch("?settings=models"), true);
  assert.equal(isSettingsSearch("?settings=other"), false);
  assert.equal(withSettingsSearch(""), "?settings=global");
  assert.equal(withSettingsSearch("?book=book_1&series=series_1"), "?book=book_1&series=series_1&settings=global");
  assert.equal(withoutSettingsSearch("?book=book_1&series=series_1&settings=global"), "?book=book_1&series=series_1");
  assert.equal(withoutSettingsSearch("?settings=global"), "");
});

test("生产工作台恢复阶段、章节和任务且拒绝坏阶段", () => {
  const path = productionWorkspacePath({
    bookId: "book/北派",
    seriesId: "series?1",
    stage: "scripts",
    chapterId: "chapter 2",
    episodeIndex: 1,
    assetId: "asset_1",
    jobId: "job_1",
    pipelineRunId: "pipeline_1",
  });
  assert.deepEqual(productionWorkspaceFromSearch(path), {
    bookId: "book/北派",
    seriesId: "series?1",
    stage: "scripts",
    chapterId: "chapter 2",
    episodeIndex: 1,
    assetId: "asset_1",
    jobId: "job_1",
    pipelineRunId: "pipeline_1",
  });
  assert.equal(resolveProductionStage("unknown"), "events");
});

test("生产工作台地址更新可显式清除旧任务且保留未修改字段", () => {
  const current = { stage: "assets" as const, chapterId: "chapter_1", episodeIndex: 1, assetId: "asset_1", jobId: "job_1", pipelineRunId: "pipeline_1" };
  assert.deepEqual(mergeProductionWorkspaceLocation(current, { jobId: undefined }), {
    stage: "assets",
    chapterId: "chapter_1",
    episodeIndex: 1,
    assetId: "asset_1",
    jobId: undefined,
    pipelineRunId: "pipeline_1",
  });
  assert.deepEqual(mergeProductionWorkspaceLocation(current, { stage: "audio" }), {
    stage: "audio",
    chapterId: "chapter_1",
    episodeIndex: 1,
    assetId: "asset_1",
    jobId: "job_1",
    pipelineRunId: "pipeline_1",
  });
  assert.equal(mergeProductionWorkspaceLocation(current, { pipelineRunId: undefined }).pipelineRunId, undefined);
});

test("分集导航只使用真实列表并在边界禁用上一集或下一集", () => {
  const episode = (index: number, title: string): Episode => ({
    id: `episode_${index}`, seriesProjectId: "series_1", index, title, storyArc: "故事弧",
    targetDurationSeconds: 1200, recap: null, nextHook: null, createdAt: 1, updatedAt: 1, sources: [],
  });
  const episodes = [episode(1, "起点"), episode(2, "转折")];
  assert.equal(episodeNavigationTarget(episodes, 1, -1), undefined);
  assert.equal(episodeNavigationTarget(episodes, 1, 1), 2);
  assert.equal(episodeNavigationTarget(episodes, 2, 1), undefined);
  const html = renderToString(createElement(EpisodeNavigation, { current: 1, episodes, state: "ready", disabled: false, onChange() {} }));
  assert.match(html, /起点/);
  assert.match(html, /第 1 集，共 2 集/);
  assert.match(html, /上一集<\/button>/);
  assert.match(html, /min-h-11/);
});

test("审核与导出绑定真实 Episode、时间轴和普通 Job URL", () => {
  const timeline = "a".repeat(64);
  assert.deepEqual(resolveExportStageIdentity("episode_7", timeline), { episodeId: "episode_7", timelineHash: timeline });
  const path = productionWorkspacePath({ bookId: "book", seriesId: "series", stage: "export", episodeIndex: 7, timelineHash: timeline, jobId: "job_export", pipelineRunId: "pipeline_run" });
  const restored = productionWorkspaceFromSearch(path);
  assert.equal(restored?.jobId, "job_export");
  assert.equal(restored?.pipelineRunId, "pipeline_run");
  const html = renderToString(createElement(ProductionExportStage, { episodeId: "episode_7", timelineHash: timeline, jobId: "job_export", onJobIdChange: () => undefined }));
  assert.match(html, /审核与导出/);
  assert.match(html, /episode_7/);
  assert.match(html, new RegExp(timeline));
  assert.doesNotMatch(html, /该阶段将直接接通/);
});

test("审核与导出缺少 Episode 或时间轴时只有中文阻断且无动作", () => {
  assert.match(resolveExportStageIdentity(undefined, "a".repeat(64)).blocker!, /当前分集/);
  assert.match(resolveExportStageIdentity("episode_1", undefined).blocker!, /时间轴/);
  for (const props of [
    { episodeId: undefined, timelineHash: "a".repeat(64) },
    { episodeId: "episode_1", timelineHash: undefined },
  ]) {
    const html = renderToString(createElement(ProductionExportStage, { ...props, onJobIdChange: () => undefined }));
    assert.match(html, /审核与导出暂不可用/);
    assert.doesNotMatch(html, /<button|<a /);
  }
});

test("阶段导航显示静态依赖而不是虚假等待状态", () => {
  assert.equal(stageDependencyLabel("visual", false), "依赖：资产、音频");
  assert.equal(stageDependencyLabel("events", false), "可开始");
  assert.equal(stageDependencyLabel("audio", true), "当前阶段");
});

test("工作台状态分层保留持久错误且普通进度不覆盖它", () => {
  const failed = updateWorkspaceStatusLayer({ operation: "就绪" }, "语音任务创建失败：网络错误");
  assert.equal(failed.persistentError, "语音任务创建失败：网络错误");
  const queued = updateWorkspaceStatusLayer(failed, "任务已排队");
  assert.equal(queued.operation, "任务已排队");
  assert.equal(queued.persistentError, "语音任务创建失败：网络错误");
  const restored = updateWorkspaceStatusLayer(queued, "已加载 2 个结构化事件");
  assert.equal(restored.persistentError, "语音任务创建失败：网络错误");
  const nextAction = updateWorkspaceStatusLayer(restored, "正在创建语音时间轴任务…");
  assert.equal(nextAction.persistentError, undefined);
});

test("Accordion 组件可导出并用于页面折叠结构", () => {
  const html = renderToString(createElement(Accordion, { type: "single", collapsible: true, defaultValue: "item-1" },
    createElement(AccordionItem, { value: "item-1" },
      createElement(AccordionTrigger, null, "事件摘要"),
      createElement(AccordionContent, null, "编辑字段"),
    ),
  ));
  assert.match(html, /事件摘要/);
  assert.match(html, /编辑字段/);
  assert.match(html, /展开.*收起/s);
});

test("稿件段落默认折叠长引用并使用面向用户的两版稿件名称", () => {
  const source = readFileSync(new URL("../src/production/scripts/ScriptStage.tsx", import.meta.url), "utf8");
  assert.match(source, /<Accordion type="single" collapsible/u);
  assert.match(source, /已选 \{paragraph\.sourceIndexes\.length\} \/ \{visibleSources\.length\}/u);
  assert.match(source, /max-h-80.*overflow-y-auto/u);
  assert.match(source, /原著还原稿/u);
  assert.match(source, /成片旁白稿/u);
  assert.equal(source.includes("忠实稿版本"), false);
  assert.equal(source.includes("包装稿版本"), false);
  assert.match(source, /v6 单稿合同/u);
  assert.match(source, /readOnly=\{finishedNarration\}/u);
});

test("生图提示词按事实、资产、画幅和风格分段组装", () => {
  const prompt = assembleImagePrompt({
    evidence: "主角第一次进入墓道，墙面潮湿。",
    sceneIntent: "建立未知危险",
    assetName: "主角",
    assetState: "下墓装束",
    subjectAction: "举着手电缓慢前行",
    environment: "狭窄砖砌墓道",
    lightingComposition: "单侧冷光，中近景",
    styleConstraints: "写实悬疑，不出现现代品牌",
  });
  assert.match(prompt, /原文与批准稿事实/);
  assert.match(prompt, /主角（下墓装束）/);
  assert.match(prompt, /9:16 竖幅短视频构图/);
  assert.doesNotMatch(prompt, /undefined|null/);
});

test("VisualStage 候选选择状态提供非颜色文案", () => {
  assert.deepEqual(visualCandidateState("candidate_1", "candidate_1"), { selected: true, label: "已选画面" });
  assert.deepEqual(visualCandidateState("candidate_1", "candidate_2"), { selected: false, label: "选择画面" });
});

test("系列资产生产缺口只按候选与批准状态分类", () => {
  const assets = ["asset_empty", "asset_pending", "asset_approved"].map((id) => ({ id })) as AssetRecord[];
  const candidate = (assetId: string, reviewStatus: CandidateRecord["reviewStatus"]) => ({ assetId, reviewStatus }) as CandidateRecord;
  assert.deepEqual(assetGapCounts(assets, {
    asset_pending: [candidate("asset_pending", "pending"), candidate("asset_pending", "rejected")],
    asset_approved: [candidate("asset_approved", "approved")],
  }), { noCandidates: 1, awaitingApproval: 1, approved: 1 });
});

test("原图上传使用二进制正文与安全编码文件名", () => {
  const file = new File(["png"], "北派 原图.png", { type: "image/png" });
  const request = candidateUploadRequest(file);
  assert.equal(request.method, "POST");
  assert.equal((request.headers as Record<string, string>)["content-type"], "application/octet-stream");
  assert.equal((request.headers as Record<string, string>)["x-file-name"], encodeURIComponent(file.name));
  assert.equal(request.body, file);
  assert.throws(() => candidateUploadRequest(new File(["gif"], "bad.gif", { type: "image/gif" })), /PNG、JPEG 或 WebP/);
});

test("生图成功只定向刷新结果所属资产", () => {
  const job = {
    id: "job_1", type: "image_candidate_generate", status: "succeeded" as const, progress: 1,
    attempts: 1, maxAttempts: 3, cancelRequested: false, errorMessage: null,
    result: { candidate: { id: "candidate_1", assetId: "asset_a" } },
  };
  assert.equal(generatedCandidateAssetId(job), "asset_a");
  assert.equal(generatedCandidateAssetId({ ...job, status: "running" }), undefined);
  assert.equal(generatedCandidateAssetId({ ...job, type: "other" }), undefined);
});

test("候选刷新拒绝旧请求与跨资产响应", () => {
  const candidate = { assetId: "asset_a" } as CandidateRecord;
  assert.equal(canApplyCandidateRefresh("asset_a", 2, 1, [candidate]), false);
  assert.equal(canApplyCandidateRefresh("asset_a", 2, 2, [{ assetId: "asset_b" } as CandidateRecord]), false);
  assert.equal(canApplyCandidateRefresh("asset_a", 2, 2, [candidate]), true);
});

test("生成候选从冻结任务无损恢复完整 prompt，上传候选不冒充版本", () => {
  const candidate = { id: "candidate_1", assetId: "asset_a", source: {
    kind: "generation", requestHash: "a".repeat(64), revisedPrompt: "模型修订词",
  } } as CandidateRecord;
  const prompt = "旧格式：保留全部文本\n包括未知字段";
  const job = {
    id: `job_image_${"a".repeat(64)}`, type: "image_candidate_generate", status: "succeeded" as const,
    progress: 1, attempts: 1, maxAttempts: 3, cancelRequested: false, errorMessage: null,
    payload: { assetId: "asset_a", requestHash: "a".repeat(64), prompt },
  };
  assert.equal(candidatePromptJobId(candidate), job.id);
  assert.equal(promptFromCandidateJob(candidate, job), prompt);
  assert.equal(promptFromCandidateJob(candidate, { ...job, payload: { ...job.payload, assetId: "asset_b" } }), undefined);
  assert.equal(candidatePromptJobId({ ...candidate, source: { kind: "upload", originalName: "原图.png" } }), undefined);
});

test("人工章节事件沿用现有持久任务合同并限制证据范围", () => {
  const chapter = { id: "chapter_1", title: "第一章", chapter_index: 0, char_count: 20, byte_start: 100, byte_end: 200 };
  const events = [
    { type: "character" as const, primary: "吴邪", secondary: "第一次下墓", payload: { name: "吴邪", detail: "第一次下墓" } },
    { type: "location" as const, primary: "血尸墓", secondary: "主墓室", payload: { name: "血尸墓", detail: "主墓室" } },
    { type: "prop" as const, primary: "帛书", secondary: "藏有地图", payload: { name: "帛书", detail: "藏有地图" } },
    { type: "causality" as const, primary: "发现血土", secondary: "决定下墓", payload: { cause: "发现血土", effect: "决定下墓" } },
    { type: "revelation" as const, primary: "墓主人身份曝光", secondary: "", payload: { fact: "墓主人身份曝光" } },
    { type: "suspense" as const, primary: "血尸是什么？", secondary: "", payload: { question: "血尸是什么？" } },
  ];
  const payload = chapterEventsJobPayload("book_1", chapter, events.map((event, index) => ({
    key: `draft_${index}`,
    type: event.type,
    primary: event.primary,
    secondary: event.secondary,
    sources: [{ byteStart: 110 + index, byteEnd: 150 + index }],
  })));
  assert.deepEqual(payload, { bookId: "book_1", chapters: [{ chapterId: "chapter_1", events: events.map((event, index) => ({
    type: event.type,
    occurrence: 0,
    payload: event.payload,
    sources: [{ byteStart: 110 + index, byteEnd: 150 + index }],
  })) }] });
  assert.deepEqual(chapterEventsJobPayload("book_1", chapter, []), {
    bookId: "book_1", chapters: [{ chapterId: "chapter_1", events: [] }],
  });
  assert.deepEqual(chapterEventDraft({
    id: "event_1", type: "causality", occurrence: 0,
    payload: { cause: "发现血土", effect: "决定下墓" },
    sources: [{ byteStart: 110, byteEnd: 150, sourceText: "血土" }],
  }), {
    key: "event_1", type: "causality", primary: "发现血土", secondary: "决定下墓",
    sources: [{ byteStart: 110, byteEnd: 150 }],
  });
  assert.throws(() => chapterEventsJobPayload("book_1", chapter, [{
    key: "draft_2", type: "suspense", primary: "血尸是什么？", secondary: "", sources: [{ byteStart: 90, byteEnd: 120 }],
  }]), /证据范围/);
  assert.deepEqual(remainingChapterEventPageOffsets(200, 100), [100]);
  assert.deepEqual(remainingChapterEventPageOffsets(100, 100), []);
});

test("自动章节分析只提交书籍和章节身份", () => {
  const chapter = { id: " chapter_1 ", title: "第一章", chapter_index: 0, char_count: 20, byte_start: 100, byte_end: 200 };
  assert.deepEqual(chapterAnalysisJobPayload(" book_1 ", chapter), { bookId: "book_1", chapterId: "chapter_1" });
  assert.throws(() => chapterAnalysisJobPayload(" ", chapter), /缺少有效/);
});

test("任务进度按服务端小数钳制且终态稳定", () => {
  assert.equal(normalizeJobProgress("running", 0.555), 56);
  assert.equal(normalizeJobProgress("running", 4), 100);
  assert.equal(normalizeJobProgress("succeeded", 0), 100);
  assert.equal(isTerminalJobStatus("cancelled"), true);
  assert.equal(isTerminalJobStatus("queued"), false);
});

test("分集编辑恢复时按事件 ID 去重，保存时裁剪并保留空可选字段", () => {
  const draft = episodeDraft({
    id: "episode_1", seriesProjectId: "series_1", index: 1, title: " 第一集 ", storyArc: " 起承转合 ",
    targetDurationSeconds: 240, recap: null, nextHook: null, createdAt: 1, updatedAt: 1,
    sources: [
      { sourceIndex: 0, chapterId: "chapter_1", sourceEventId: "event_1", byteStart: 0, byteEnd: 3, sourceHash: "hash_1", sourceText: "甲" },
      { sourceIndex: 1, chapterId: "chapter_1", sourceEventId: "event_1", byteStart: 3, byteEnd: 6, sourceHash: "hash_2", sourceText: "乙" },
    ],
  });
  assert.deepEqual(draft.sourceEventIds, ["event_1"]);
  assert.deepEqual(episodePutPayload({ ...draft, sourceEventIds: [" event_1 ", "event_1"], recap: "  ", nextHook: " 钩子 " }), {
    title: "第一集", storyArc: "起承转合", targetDurationSeconds: 240, recap: null, nextHook: "钩子", sourceEventIds: ["event_1"],
  });
});

test("分集编辑使用可读技术策略并拒绝越界时长和空证据", () => {
  const valid = { title: "第一集", storyArc: "故事弧", targetDurationSeconds: 240, recap: "", nextHook: "", sourceEventIds: ["event_1"] };
  assert.throws(() => episodePutPayload({ ...valid, title: " " }), /标题不能为空/);
  assert.throws(() => episodePutPayload({ ...valid, storyArc: " " }), /故事弧不能为空/);
  assert.equal(emptyEpisodeDraft().targetDurationSeconds, 1200);
  assert.equal(episodePutPayload({ ...valid, targetDurationSeconds: 1200 }).targetDurationSeconds, 1200);
  assert.throws(() => episodePutPayload({ ...valid, targetDurationSeconds: 59 }), /60 至 3600/);
  assert.throws(() => episodePutPayload({ ...valid, targetDurationSeconds: 3601 }), /60 至 3600/);
  assert.throws(() => episodePutPayload({ ...valid, sourceEventIds: [] }), /至少选择一个/);
});

test("跨章推荐可按章节汇总入口状态", () => {
  assert.deepEqual(recommendationChapterSummaries({
    status: "recommended",
    startChapterId: "chapter_1",
    endChapterId: "chapter_2",
    chapterIds: ["chapter_1", "chapter_2"],
    eventIds: ["event_1", "event_2", "event_3"],
    missingChapters: [],
    events: [
      { id: "event_1", chapterId: "chapter_1", type: "character", payload: { name: "吴邪", detail: "初入古墓" } },
      { id: "event_2", chapterId: "chapter_1", type: "suspense", payload: { question: "血尸是谁" } },
      { id: "event_3", chapterId: "chapter_2", type: "revelation", payload: { fact: "机关开启" } },
    ],
  }), [
    { chapterId: "chapter_1", eventCount: 2, summary: "吴邪 / 初入古墓" },
    { chapterId: "chapter_2", eventCount: 1, summary: "机关开启" },
  ]);
});

test("分集基础恢复与推荐任务无论返回顺序都保留推荐结果", async (t) => {
  const baseDraft: EpisodeDraft = {
    title: "已恢复分集", storyArc: "故事弧", targetDurationSeconds: 1200,
    recap: "", nextHook: "", sourceEventIds: ["episode_event"],
  };
  const recommendation: EpisodeRecommendation = {
    status: "recommended", startChapterId: "chapter_1", endChapterId: "chapter_2",
    chapterIds: ["chapter_1", "chapter_2"], eventIds: ["recommended_1", "recommended_2"], missingChapters: [],
  };
  for (const order of ["job-first", "base-first"] as const) await t.test(order, async () => {
    const identity = ["series_1", "1", "chapter_1"].join("\0");
    const coordinator = createEpisodeHydrationCoordinator(identity);
    let state = coordinator.resolve(identity, emptyEpisodeDraft(), "正在恢复")!;
    const base = Promise.withResolvers<EpisodeDraft>();
    const job = Promise.withResolvers<EpisodeRecommendation>();
    const baseApplied = base.promise.then((restored) => {
      state = coordinator.resolve(identity, restored, "分集已恢复")!;
    });
    const jobApplied = job.promise.then((result) => {
      assert.ok(coordinator.acceptRecommendation(identity, result));
      state = coordinator.resolve(identity, state.draft, state.status)!;
    });
    if (order === "job-first") {
      job.resolve(recommendation); await jobApplied;
      base.resolve(baseDraft); await baseApplied;
    } else {
      base.resolve(baseDraft); await baseApplied;
      job.resolve(recommendation); await jobApplied;
    }
    assert.deepEqual(state.draft.sourceEventIds, recommendation.eventIds);
    assert.equal(state.recommendation, recommendation);
    assert.equal(state.status, "推荐完成：2 章、2 个事件，等待明确确认");
  });
});

test("缺分析推荐状态不会被稍后完成的基础恢复覆盖", () => {
  const result: EpisodeRecommendation = {
    status: "needs_analysis", startChapterId: "chapter_1",
    missingChapters: [{ id: "chapter_1", title: "第一章" }],
  };
  const identity = ["series_1", "1", "chapter_1"].join("\0");
  const coordinator = createEpisodeHydrationCoordinator(identity);
  assert.ok(coordinator.acceptRecommendation(identity, result));
  const resolved = coordinator.resolve(identity, emptyEpisodeDraft(), "分集已恢复")!;
  assert.deepEqual(resolved.draft.sourceEventIds, []);
  assert.equal(resolved.recommendation, result);
  assert.equal(resolved.status, "起始章节缺少结构化分析，请先补齐后重新推荐");
});

test("分集恢复协调器切换 identity 后拒绝旧 Job 与基础响应", async () => {
  const oldIdentity = ["series_1", "1", "chapter_1"].join("\0");
  const newIdentity = ["series_1", "1", "chapter_2"].join("\0");
  const coordinator = createEpisodeHydrationCoordinator(oldIdentity);
  const base = Promise.withResolvers<EpisodeDraft>();
  const job = Promise.withResolvers<EpisodeRecommendation>();
  const oldBase = base.promise.then((draft) => coordinator.resolve(oldIdentity, draft, "旧分集已恢复"));
  const oldJob = job.promise.then((result) => coordinator.acceptRecommendation(oldIdentity, result));
  assert.equal(coordinator.transitionIdentity(newIdentity), true);
  job.resolve({ status: "recommended", startChapterId: "chapter_1", eventIds: ["old_event"], missingChapters: [] });
  base.resolve({ ...emptyEpisodeDraft(), sourceEventIds: ["old_episode_event"] });
  assert.equal(await oldJob, undefined);
  assert.equal(await oldBase, undefined);
  const current = coordinator.resolve(newIdentity, emptyEpisodeDraft(), "新分集待恢复")!;
  assert.equal(current.recommendation, undefined);
  assert.deepEqual(current.draft.sourceEventIds, []);
  assert.equal(current.status, "新分集待恢复");
});

test("隐式起点 Job 只归属原始空起点 identity，显式解析后章节仍保持隔离", () => {
  const implicit = { seriesId: "series_1", episodeIndex: 1, requestedStartChapterId: null };
  assert.equal(episodeRecommendationJobMatchesIdentity(implicit, "series_1", 1), true);
  assert.equal(episodeRecommendationJobMatchesIdentity(implicit, "series_1", 1, "chapter_1"), false);
  const explicit = { ...implicit, requestedStartChapterId: "chapter_1" };
  assert.equal(episodeRecommendationJobMatchesIdentity(explicit, "series_1", 1, "chapter_1"), true);
  assert.equal(episodeRecommendationJobMatchesIdentity(explicit, "series_1", 1), false);
});

test("保存调整后的推荐会消费协调器状态并清除 URL Job", () => {
  const identity = ["series_1", "1", ""].join("\0");
  const coordinator = createEpisodeHydrationCoordinator(identity);
  coordinator.acceptRecommendation(identity, {
    status: "recommended", startChapterId: "chapter_1", endChapterId: "chapter_2",
    chapterIds: ["chapter_1", "chapter_2"], eventIds: ["event_1", "event_2"], missingChapters: [],
  });
  const cleared: Array<string | undefined> = [];
  assert.equal(consumeEpisodeRecommendation(coordinator, identity, (id) => cleared.push(id)), true);
  assert.deepEqual(cleared, [undefined]);
  const persisted = { ...emptyEpisodeDraft(), sourceEventIds: ["event_1"] };
  const restored = coordinator.resolve(identity, persisted, "已保存")!;
  assert.equal(restored.recommendation, undefined);
  assert.deepEqual(restored.draft.sourceEventIds, ["event_1"]);
});

test("StrictMode 中未提交的 render 不得提前切换 hydration identity", () => {
  const coordinator = createEpisodeHydrationCoordinator("committed");
  function Probe() {
    useCommittedEpisodeIdentity(coordinator, "aborted");
    return createElement("span", null, "probe");
  }
  renderToString(createElement(StrictMode, null, createElement(Probe)));
  assert.equal(coordinator.isCurrent("committed"), true);
  assert.equal(coordinator.isCurrent("aborted"), false);
});

test("忠实稿裁剪正文、来源去重并拒绝空段落或空来源", () => {
  const paragraphs = [{ key: "p1", text: "  吴邪走进墓道。  ", sourceIndexes: [0, 0, 1] }];
  assert.deepEqual(scriptPostPayload("faithful", paragraphs), {
    kind: "faithful", paragraphs: [{ text: "吴邪走进墓道。", sourceIndexes: [0, 1] }],
  });
  assert.throws(() => scriptPostPayload("faithful", [{ ...paragraphs[0], text: " " }]), /填写正文/);
  assert.throws(() => scriptPostPayload("faithful", [{ ...paragraphs[0], sourceIndexes: [] }]), /至少选择一个来源/);
});

test("包装稿只允许忠实父稿冻结的来源", () => {
  const parent = {
    id: "faithful_1", episodeId: "episode_1", kind: "faithful" as const, versionNumber: 1,
    contractVersion: 5 as const, parentVersionId: null, contentHash: "hash", paragraphs: [{ text: "忠实稿", sources: [
      { episodeSourceIndex: 2, chapterId: "chapter_1", sourceEventId: "event_2", byteStart: 1, byteEnd: 2, sourceHash: "hash_2" },
      { episodeSourceIndex: 2, chapterId: "chapter_1", sourceEventId: "event_2", byteStart: 1, byteEnd: 2, sourceHash: "hash_2" },
    ] }],
  };
  assert.deepEqual(allowedSourceIndexes("packaged", [0, 1, 2], parent), [2]);
  assert.deepEqual(scriptPostPayload("packaged", [{ key: "p", text: "包装稿", sourceIndexes: [2] }], parent), {
    kind: "packaged", parentVersionId: "faithful_1", paragraphs: [{ text: "包装稿", sourceIndexes: [2] }],
  });
  assert.throws(() => scriptPostPayload("packaged", [{ key: "p", text: "越界", sourceIndexes: [1] }], parent), /冻结的来源/);
  assert.throws(() => scriptPostPayload("packaged", [{ key: "p", text: "无父稿", sourceIndexes: [1] }]), /必须选择/);
});

test("服务端稿件版本恢复草稿时按来源序号去重", () => {
  const version = {
    id: "script_1", episodeId: "episode_1", kind: "faithful" as const, versionNumber: 1,
    contractVersion: 5 as const, parentVersionId: null, contentHash: "hash", paragraphs: [{ text: "正文", sources: [
      { episodeSourceIndex: 0, chapterId: "chapter_1", sourceEventId: "event_1", byteStart: 0, byteEnd: 3, sourceHash: "hash_1" },
      { episodeSourceIndex: 0, chapterId: "chapter_1", sourceEventId: "event_1", byteStart: 0, byteEnd: 3, sourceHash: "hash_1" },
    ] }],
  };
  assert.deepEqual(scriptDraft(version).map(({ text, sourceIndexes }) => ({ text, sourceIndexes })), [{ text: "正文", sourceIndexes: [0] }]);
});

test("稿件 dirty 判断覆盖取消或确认载入版本前的草稿保护", () => {
  const draft = [{ key: "p1", text: "原稿", sourceIndexes: [2, 1] }];
  const signature = scriptDraftSignature("faithful", "", draft);
  assert.equal(isScriptDraftDirty(signature, "faithful", "", [{ key: "new", text: "原稿", sourceIndexes: [1, 2] }]), false);
  assert.equal(isScriptDraftDirty(signature, "faithful", "", [{ key: "p1", text: "已修改", sourceIndexes: [1, 2] }]), true);
  assert.equal(isScriptDraftDirty(signature, "packaged", "faithful_1", draft), true);
});

test("资产 Prompt 草稿只从匹配资产的成功任务回填可编辑字段", () => {
  const result = {
    evidence: "原文事实", sceneIntent: "场景意图", subjectAction: "主体动作",
    environment: "环境", lightingComposition: "光线构图", styleConstraints: "风格约束", prompt: "完整草稿",
  };
  const job = {
    id: "job_asset_prompt_1", type: "asset_prompt_draft_generate", status: "succeeded" as const,
    progress: 1, attempts: 1, maxAttempts: 3, cancelRequested: false, errorMessage: null,
    payload: { assetId: "asset_a" }, result,
  };
  assert.deepEqual(assetPromptDraftFromJob(job, "asset_a"), {
    parts: { evidence: "原文事实", sceneIntent: "场景意图", subjectAction: "主体动作", environment: "环境", lightingComposition: "光线构图", styleConstraints: "风格约束" },
    prompt: "完整草稿",
  });
  assert.equal(assetPromptDraftFromJob(job, "asset_b"), undefined);
  assert.equal(assetPromptDraftFromJob({ ...job, status: "running" }, "asset_a"), undefined);
});

test("v6 单稿必须同时满足合同版本与无父稿身份，不能只靠 parent null 推断", () => {
  const standalone = {
    id: "packaged_v6", episodeId: "episode_1", kind: "packaged" as const, contractVersion: 6 as const,
    versionNumber: 1, parentVersionId: null, contentHash: "hash", paragraphs: [],
  };
  assert.equal(isFinishedNarrationVersion(standalone), true);
  assert.equal(scriptWorkspaceContractVersion([standalone]), 6);
  assert.equal(isFinishedNarrationVersion({ ...standalone, contractVersion: 5 }), false);
  assert.equal(isFinishedNarrationVersion({ ...standalone, parentVersionId: "faithful_1" }), false);
  assert.equal(scriptWorkspaceContractVersion([{ ...standalone, contractVersion: 5 }]), 5);
});

test("批准与撤回 payload 始终携带当前 revision", () => {
  const approval = { episodeId: "episode_1", status: "unapproved" as const, revision: 3, scriptVersionId: null, changedAt: null };
  assert.deepEqual(approvalPutPayload("approve", approval, "packaged_1"), { action: "approve", expectedRevision: 3, scriptVersionId: "packaged_1" });
  assert.deepEqual(approvalPutPayload("withdraw", { ...approval, status: "approved", scriptVersionId: "packaged_1" }), { action: "withdraw", expectedRevision: 3 });
  assert.throws(() => approvalPutPayload("approve", approval), /请选择/);
});

test("长稿 Job 只归属冻结的系列、分集和 Episode identity", () => {
  const job = {
    id: "job_scripts_1",
    type: "episode_scripts_generate",
    status: "running" as const,
    progress: 0.4,
    attempts: 1,
    maxAttempts: 3,
    cancelRequested: false,
    errorMessage: null,
    payload: { seriesId: "series_1", episodeIndex: 2, episodeId: "episode_2" },
  };
  assert.equal(episodeScriptJobMatchesIdentity(job, "series_1", 2, "episode_2"), true);
  assert.equal(episodeScriptJobMatchesIdentity(job, "series_1", 1, "episode_2"), false);
  assert.equal(episodeScriptJobMatchesIdentity(job, "series_2", 2, "episode_2"), false);
  assert.equal(episodeScriptJobMatchesIdentity(job, "series_1", 2, "episode_old"), false);
  assert.equal(episodeScriptJobMatchesIdentity({ ...job, type: "tts_timeline" }, "series_1", 2), false);
});

test("长稿终态恢复只消费同 identity 的成功版本结果", () => {
  const job = {
    id: "job_scripts_1",
    type: "episode_scripts_generate",
    status: "succeeded" as const,
    progress: 1,
    attempts: 1,
    maxAttempts: 3,
    cancelRequested: false,
    errorMessage: null,
    payload: { seriesId: "series_1", episodeIndex: 2, episodeId: "episode_2" },
    result: { faithfulVersionId: "faithful_1", packagedVersionId: "packaged_1" },
  };
  assert.deepEqual(completedEpisodeScriptVersions(job, "series_1", 2, "episode_2"), {
    contractVersion: 5,
    faithfulVersionId: "faithful_1",
    packagedVersionId: "packaged_1",
  });
  assert.deepEqual(completedEpisodeScriptVersions({ ...job, result: {
    contractVersion: 6, packagedVersionId: "packaged_v6", finishedNarrationVersionId: "packaged_v6",
  } }, "series_1", 2, "episode_2"), { contractVersion: 6, packagedVersionId: "packaged_v6" });
  assert.equal(completedEpisodeScriptVersions({ ...job, result: {
    contractVersion: 6, packagedVersionId: "packaged_v6", finishedNarrationVersionId: "other",
  } }, "series_1", 2, "episode_2"), undefined);
  assert.equal(completedEpisodeScriptVersions({ ...job, status: "failed" }, "series_1", 2, "episode_2"), undefined);
  assert.equal(completedEpisodeScriptVersions(job, "series_1", 3, "episode_2"), undefined);
  assert.equal(completedEpisodeScriptVersions({ ...job, result: {} }, "series_1", 2, "episode_2"), undefined);
});

test("长稿生成入口在忙碌、活跃 Job 或缺少 Episode 时防止重复提交", () => {
  assert.equal(canStartEpisodeScriptGeneration(false, false, "episode_1"), true);
  assert.equal(canStartEpisodeScriptGeneration(true, false, "episode_1"), false);
  assert.equal(canStartEpisodeScriptGeneration(false, true, "episode_1"), false);
  assert.equal(canStartEpisodeScriptGeneration(false, false), false);
});

test("已选实测短样同时驱动长稿预算与完整 TTS 默认配置", () => {
  const selection = {
    mode: "select" as const,
    episodeId: "episode_1",
    scriptVersionId: "script_1",
    contentHash: "a".repeat(64),
    approvalRevision: 3,
    generateJobId: "job_generate",
    sampleId: "tts_sample_1",
    voice: "说书音色",
    rate: 2,
    charactersPerSecond: 5.125,
  };
  assert.deepEqual(episodeScriptCalibration(selection), {
    voice: "说书音色", rate: 2, charactersPerSecond: 5.125,
    calibration: { identity: "measured", sampleId: "tts_sample_1" },
  });
  assert.deepEqual(episodeScriptCalibration(), { calibration: { identity: "provisional" } });
  assert.deepEqual(ttsTimelinePayload("episode_1", "临时音色", 0, selection), {
    episodeId: "episode_1", voice: "说书音色", rate: 2,
  });
  assert.deepEqual(ttsTimelinePayload("episode_1", " 临时音色 ", 0), {
    episodeId: "episode_1", voice: "临时音色", rate: 0,
  });
});

test("AudioStage 分页按固定大小切分真实规模分段", () => {
  const segments = Array.from({ length: 262 }, (_, index) => ({ index }));
  assert.equal(AUDIO_SEGMENTS_PER_PAGE, 24);
  assert.equal(audioPageCount(segments.length), 11);
  assert.equal(clampAudioPage(999, segments.length), 10);
  assert.deepEqual(audioSegmentsForPage(segments, 10).map((segment) => segment.index), Array.from({ length: 22 }, (_, offset) => 240 + offset));
  assert.equal(audioSegmentUrl({ episodeId: "episode/1", timelineHash: "a".repeat(64) }, 60), `/api/episodes/episode%2F1/tts-timelines/${"a".repeat(64)}/audio/60`);
});

test("AudioStage 服务端首屏只渲染一个共享 audio 元素", () => {
  const html = renderToString(createElement(AudioStage, {
    seriesId: "series_1",
    episodeIndex: 1,
    busy: false,
    jobActive: false,
    setBusy: () => undefined,
    setStatus: () => undefined,
    onEpisodeChange: () => undefined,
    onTimelineChange: () => undefined,
    onJobCreated: () => undefined,
  }));
  assert.equal((html.match(/<audio/g) ?? []).length, 1);
});

test("短样终态只归属当前 Episode，旧分集结果不得触发恢复", () => {
  const job = {
    id: "job_cal", type: "tts_calibration", status: "succeeded" as const, progress: 1,
    attempts: 1, maxAttempts: 1, cancelRequested: false, errorMessage: null,
    result: { mode: "generate", episodeId: "episode_1" },
  };
  assert.equal(completedTtsCalibrationMode(job, "episode_1"), "generate");
  assert.equal(completedTtsCalibrationMode(job, "episode_2"), undefined);
  assert.equal(completedTtsCalibrationMode({ ...job, status: "failed" }, "episode_1"), undefined);
});

test("长稿 cancelled/failed 终态无论基础 hydrate 返回顺序都不会被覆盖", () => {
  const terminalJobs = [
    {
      status: "cancelled" as const,
      errorMessage: null,
      expected: "跨章骨架与长稿任务已取消",
    },
    {
      status: "failed" as const,
      errorMessage: "模型请求失败",
      expected: "跨章骨架与长稿任务失败：模型请求失败",
    },
  ];
  for (const terminal of terminalJobs) {
    const job = {
      id: `job_${terminal.status}`,
      type: "episode_scripts_generate",
      status: terminal.status,
      progress: 0.2,
      attempts: 1,
      maxAttempts: 3,
      cancelRequested: terminal.status === "cancelled",
      errorMessage: terminal.errorMessage,
      payload: { seriesId: "series_1", episodeIndex: 1, episodeId: "episode_1" },
    };
    for (const order of ["base-first", "job-first"] as const) {
      let status = "";
      if (order === "base-first") {
        status = resolveEpisodeScriptWorkspaceStatus("基础状态", undefined, "series_1", 1, "episode_1");
        status = resolveEpisodeScriptWorkspaceStatus(status, job, "series_1", 1, "episode_1");
      } else {
        status = resolveEpisodeScriptWorkspaceStatus(status, job, "series_1", 1, "episode_1");
        status = resolveEpisodeScriptWorkspaceStatus("基础状态", job, "series_1", 1, "episode_1");
      }
      assert.equal(status, terminal.expected);
    }
    assert.equal(
      resolveEpisodeScriptWorkspaceStatus("当前分集基础状态", job, "series_1", 2, "episode_2"),
      "当前分集基础状态",
    );
    assert.equal(
      resolveEpisodeScriptWorkspaceStatus("分集尚未创建", job, "series_1", 1),
      "分集尚未创建",
    );
  }
});

test("StrictMode 未提交的稿件 render 不会提前改写 route 或 Job ref", () => {
  const routeRef = { current: "series_1:1" };
  const committedJob = { id: "job_committed" } as never;
  const jobRef = { current: committedJob };
  function Probe() {
    useCommittedScriptWorkspaceRefs(routeRef, jobRef, "series_2:2", { id: "job_aborted" } as never);
    return createElement("span", null, "probe");
  }
  renderToString(createElement(StrictMode, null, createElement(Probe)));
  assert.equal(routeRef.current, "series_1:1");
  assert.equal(jobRef.current, committedJob);
});

test("延迟 POST 在切换系列或分集后不能写入新 URL、状态或 busy", async () => {
  const routeRef = { current: "series_1:1" };
  const expectedRoute = routeRef.current;
  const response = Promise.withResolvers<void>();
  const applied: string[] = [];
  const completion = response.promise.then(() => {
    applyIfCurrentScriptRoute(true, routeRef, expectedRoute, () => applied.push("job"));
    applyIfCurrentScriptRoute(true, routeRef, expectedRoute, () => applied.push("status"));
    applyIfCurrentScriptRoute(true, routeRef, expectedRoute, () => applied.push("busy"));
  });
  routeRef.current = "series_2:2";
  response.resolve();
  await completion;
  assert.deepEqual(applied, []);
  assert.equal(applyIfCurrentScriptRoute(false, { current: expectedRoute }, expectedRoute, () => applied.push("unmounted")), false);
});

test("真实卸载 commit 会在 passive cleanup 前阻止长稿 POST 旧写回", async () => {
  const originalFetch = globalThis.fetch;
  const postResponse = Promise.withResolvers<Response>();
  const callbacks: string[] = [];
  let passiveCleanupRan = false;
  let postStarted = false;
  let generateScripts: (() => Promise<void>) | undefined;
  const browserGlobals = globalThis as typeof globalThis & {
    window?: unknown;
    document?: unknown;
    IS_REACT_ACT_ENVIRONMENT?: boolean;
  };
  const originalWindow = browserGlobals.window;
  const originalDocument = browserGlobals.document;
  const originalActEnvironment = browserGlobals.IS_REACT_ACT_ENVIRONMENT;

  const documentLike = {
    nodeType: 9,
    addEventListener() {},
    removeEventListener() {},
    defaultView: undefined as unknown,
    documentElement: { namespaceURI: "http://www.w3.org/1999/xhtml" },
  };
  const container = {
    nodeType: 1,
    tagName: "DIV",
    namespaceURI: "http://www.w3.org/1999/xhtml",
    ownerDocument: documentLike,
    addEventListener() {},
    removeEventListener() {},
  };
  documentLike.defaultView = {
    document: documentLike,
    HTMLElement: class HTMLElement {},
    HTMLIFrameElement: class HTMLIFrameElement {},
  };
  browserGlobals.window = documentLike.defaultView;
  browserGlobals.document = documentLike;
  browserGlobals.IS_REACT_ACT_ENVIRONMENT = true;

  globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (url === "/api/jobs" && init?.method === "POST") {
      postStarted = true;
      return postResponse.promise;
    }
    if (url.endsWith("/scripts")) return Response.json({ items: [] });
    if (url.endsWith("/approval")) return Response.json({
      approval: { episodeId: "episode_1", status: "unapproved", revision: 0, scriptVersionId: null, changedAt: null },
    });
    return Response.json({ episode: {
      id: "episode_1", seriesProjectId: "series_1", index: 1, title: "第一集", storyArc: "故事弧",
      targetDurationSeconds: 240, recap: null, nextHook: null, createdAt: 1, updatedAt: 1,
      sources: [{ sourceIndex: 0, chapterId: "chapter_1", sourceEventId: "event_1", byteStart: 0, byteEnd: 3,
        sourceHash: "hash_1", sourceText: "原文" }],
    } });
  };

  function Probe() {
    const workspace = useScriptWorkspace({
      seriesId: "series_1",
      episodeIndex: 1,
      jobActive: false,
      setBusy: (busy) => callbacks.push(`busy:${busy}`),
      setStatus: (status) => callbacks.push(`status:${status}`),
      onJobCreated: (id) => callbacks.push(`job:${id}`),
    });
    generateScripts = workspace.generateScripts;
    useLayoutEffect(() => () => {
      assert.equal(passiveCleanupRan, false);
      postResponse.resolve(Response.json({ message: "任务已创建", job: { id: "job_old" } }));
    }, []);
    useEffect(() => () => { passiveCleanupRan = true; }, []);
    return null;
  }

  const root = createRoot(container as never);
  try {
    await act(async () => {
      root.render(createElement(Probe));
    });
    assert.ok(generateScripts);
    await act(async () => {
      void generateScripts!();
      await Promise.resolve();
    });
    assert.equal(postStarted, true);
    callbacks.length = 0;

    await act(async () => {
      root.unmount();
      await postResponse.promise;
      await Promise.resolve();
      await Promise.resolve();
    });

    assert.deepEqual(callbacks, []);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalWindow === undefined) delete browserGlobals.window;
    else browserGlobals.window = originalWindow;
    if (originalDocument === undefined) delete browserGlobals.document;
    else browserGlobals.document = originalDocument;
    if (originalActEnvironment === undefined) delete browserGlobals.IS_REACT_ACT_ENVIRONMENT;
    else browserGlobals.IS_REACT_ACT_ENVIRONMENT = originalActEnvironment;
  }
});

test("非 2xx JSON 响应保留服务端中文错误", async () => {
  const response = Response.json({ message: "书籍不存在" }, { status: 404 });
  await assert.rejects(responseJson(response), /书籍不存在/);
});

test("非 JSON 错误提供稳定的中文 HTTP 状态", async () => {
  const response = new Response("Bad Gateway", { status: 502 });
  await assert.rejects(responseJson(response), /请求失败（HTTP 502）/);
});

test("成功响应必须是 JSON", async () => {
  const response = new Response("ok", { status: 200 });
  await assert.rejects(responseJson(response), /服务端未返回 JSON 数据/);
});
