import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createElement } from "react";
import { renderToString } from "react-dom/server";

import { projectApi } from "../src/projects/api.ts";
import {
  acceptedMissingDimensions, canSaveDouyinSelection, DOUYIN_STATUS_LABELS, douyinPlanLaunchBlockReason, douyinStatusMessage, evidenceRows, unavailableDimensions, usageRoleLabel,
  validateDouyinDraft,
} from "../src/projects/douyin-analysis/logic.ts";
import { DEFAULT_DOUYIN_ANALYSIS_CONFIG, type DouyinAnalysisSummary, type DouyinAvailabilityDimension } from "../src/projects/douyin-analysis/types.ts";
import { VideoInputContent } from "../src/projects/VideoInputStage.tsx";
import type { VideoInputDraft } from "../src/projects/types.ts";

test("抖音分析默认值、帧范围和至少一种核心证据合同固定", () => {
  assert.deepEqual(DEFAULT_DOUYIN_ANALYSIS_CONFIG, { sourceText: "", extractFrames: true, frameCount: 12, transcribeAudio: true, analyzeComments: false });
  assert.match(validateDouyinDraft(DEFAULT_DOUYIN_ANALYSIS_CONFIG) ?? "", /粘贴抖音/);
  assert.match(validateDouyinDraft({ ...DEFAULT_DOUYIN_ANALYSIS_CONFIG, sourceText: "https://v.douyin.com/a", frameCount: 5 }) ?? "", /6～30/);
  assert.match(validateDouyinDraft({ ...DEFAULT_DOUYIN_ANALYSIS_CONFIG, sourceText: "https://v.douyin.com/a", extractFrames: false, transcribeAudio: false }) ?? "", /至少需要开启/);
  assert.equal(validateDouyinDraft({ ...DEFAULT_DOUYIN_ANALYSIS_CONFIG, sourceText: "https://v.douyin.com/a" }), null);
});

test("完整异步状态均有中文标签和结果说明", () => {
  assert.deepEqual(Object.keys(DOUYIN_STATUS_LABELS), ["queued", "running", "need_login", "need_verify", "partial", "succeeded", "failed", "cancelled"]);
  assert.match(douyinStatusMessage("need_login"), /等待抖音登录/);
  assert.match(douyinStatusMessage("running", { ...DEFAULT_DOUYIN_ANALYSIS_CONFIG, sourceText: "链接" }), /下载视频.*抽取 12 张关键帧.*ASR 转写.*结构化分析报告/);
  assert.match(douyinStatusMessage("need_verify"), /验证.*已完成的步骤仍然保留/);
  assert.match(douyinStatusMessage("partial"), /部分完成.*重试.*明确/);
  assert.match(douyinStatusMessage("cancelled"), /已中断.*仍然保留/);
});

test("证据摘要关闭抽帧时保留数量但明确未开启，评论边界可见", () => {
  const rows = evidenceRows(null, { ...DEFAULT_DOUYIN_ANALYSIS_CONFIG, sourceText: "链接", extractFrames: false });
  assert.equal(rows.find((row) => row.id === "frames")?.evidence, "12 张计划");
  assert.equal(rows.find((row) => row.id === "frames")?.status, "not_requested");
  assert.match(rows.find((row) => row.id === "comments")?.summary ?? "", /不进入本次报告/);
});

test("三种使用方式固定且 partial 只提交真实缺失维度", () => {
  assert.equal(usageRoleLabel("method_only"), "只参考创作方法");
  assert.equal(usageRoleLabel("topic_seed"), "沿用选题，重新研究创作");
  assert.equal(usageRoleLabel("content_source"), "改写源视频内容");
  const availability = Object.fromEntries((["content", "narrative", "pacing", "visualOverall", "visualOpening", "audioSubtitle", "audience", "narrationVisualAlignment"] as DouyinAvailabilityDimension[])
    .map((dimension) => [dimension, { status: dimension === "pacing" ? "partial" : "available" }])) as Record<DouyinAvailabilityDimension, { status: string }>;
  assert.deepEqual(unavailableDimensions(availability), ["pacing"]);
  assert.deepEqual(acceptedMissingDimensions(availability, {
    metadataStatus: "succeeded", videoStatus: "succeeded", asrStatus: "partial", asrCoveredDurationMs: 1,
    asrTextCharacters: 1, plannedFrames: 6, succeededFrames: 6, failedFrames: 0, commentCount: 0,
    completeness: "partial",
  }), ["pacing", "asr"]);
});

test("抖音分析 API 使用视频嵌套路由、严格配置和 selection 请求体", async () => {
  const previous = globalThis.fetch;
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    return new Response(JSON.stringify({ ok: true, message: "已保存" }), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  try {
    const config = { ...DEFAULT_DOUYIN_ANALYSIS_CONFIG, sourceText: "https://v.douyin.com/abc" };
    await projectApi.createDouyinAnalysisJob("项目/一", "视频?二", config);
    await projectApi.saveDouyinAnalysisSelection("项目/一", "视频?二", { snapshotId: "snapshot_1", usageRole: "content_source", creativeAngle: "独立组织", rightsConfirmed: true, acceptedMissingDimensions: ["content"] });
    assert.match(calls[0]!.url, /projects\/%E9%A1%B9%E7%9B%AE%2F%E4%B8%80\/videos\/%E8%A7%86%E9%A2%91%3F%E4%BA%8C\/douyin-analysis\/jobs$/u);
    assert.deepEqual(JSON.parse(String(calls[0]!.init?.body)), config);
    assert.equal(calls[1]!.init?.method, "PUT");
    assert.deepEqual(JSON.parse(String(calls[1]!.init?.body)), { snapshotId: "snapshot_1", usageRole: "content_source", creativeAngle: "独立组织", rightsConfirmed: true, acceptedMissingDimensions: ["content"] });
  } finally { globalThis.fetch = previous; }
});

test("抖音创作保留为独立输入方式且不在默认主题模式下追加面板", () => {
  const draft: VideoInputDraft = { inputMode: "topic", topic: "保留主题", body: "保留正文", referenceText: "", referenceRole: "style_only", targetDurationSeconds: 180, visualDensity: "standard", webEnabled: true, scriptInstructions: "", visualInstructions: "", updatedAt: 1 };
  const html = renderToString(createElement(VideoInputContent, { state: { draft, setDraft: () => undefined, loaded: true, busy: false, dirty: false, status: "已加载", error: false, save: async () => undefined }, douyinPanel: createElement("section", { "data-testid": "douyin-panel" }, "抖音视频分析") }));
  assert.match(html, /保留主题/);
  assert.match(html, /根据主题创作/);
  assert.match(html, /根据正文改编/);
  assert.match(html, /根据抖音视频创作/);
  assert.match(html, /根据知乎链接创作/);
  assert.doesNotMatch(html, /data-testid="douyin-panel"/);

  const source = readFileSync(new URL("../src/projects/VideoInputStage.tsx", import.meta.url), "utf8");
  const panelSource = readFileSync(new URL("../src/projects/douyin-analysis/DouyinAnalysisPanel.tsx", import.meta.url), "utf8");
  const hookSource = readFileSync(new URL("../src/projects/douyin-analysis/use-douyin-analysis.ts", import.meta.url), "utf8");
  assert.match(source, /creativeInputMode === "douyin"/u);
  assert.match(source, /douyinPanel/u);
  assert.match(source, /next !== "douyin" && next !== "zhihu"/u);
  assert.match(source, /selectedCreativeInputMode[\s\S]*\?\? state\.draft\?\.inputMode \?\? "topic"/u);
  assert.match(source, /grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-4/u);
  assert.doesNotMatch(source, /\n\s*\{douyinPanel\}\s*\n/u);
  assert.match(source, /!planState\.plan \|\| planState\.plan\.stale/u);
  assert.doesNotMatch(source + panelSource, /保存制作设置|保存分析配置|保存使用方式/u);
  assert.match(hookSource, /停止修改后自动保存|正在自动保存/u);
  assert.match(hookSource, /useState<DouyinUsageRole>\(\)/u);
  assert.match(hookSource, /failedSelectionValueRef\.current === value/u);
  assert.match(hookSource, /selectionSaveBlocked/u);
  assert.match(hookSource, /selection: response\.selection/u);
  assert.match(source, /useDouyinAnalysis\([\s\S]*state\.dirty \|\| state\.busy/u);
});

test("抖音入口按当前快照、已保存使用方式和角色阻断生成", () => {
  const input: VideoInputDraft = { inputMode: "topic", topic: "", body: "", referenceText: "", referenceRole: "style_only", targetDurationSeconds: 180, visualDensity: "standard", webEnabled: true, scriptInstructions: "", visualInstructions: "", updatedAt: 1 };
  const state = { loaded: true, busy: false, selectionDirty: false, error: false };
  assert.match(douyinPlanLaunchBlockReason(input, state) ?? "", /先完成抖音视频分析/u);

  const snapshot = { id: "snapshot_1", status: "succeeded", config: DEFAULT_DOUYIN_ANALYSIS_CONFIG };
  const summary = { snapshot, job: null, selection: null } as unknown as DouyinAnalysisSummary;
  assert.match(douyinPlanLaunchBlockReason(input, { ...state, summary }) ?? "", /选择抖音使用方式/u);

  const selected = (usageRole: "method_only" | "topic_seed" | "content_source") => ({ ...summary,
    selection: { videoId: "video_1", snapshotId: snapshot.id, usageRole, creativeAngle: "", rightsConfirmed: false, updatedAt: 2 },
  }) as DouyinAnalysisSummary;
  assert.match(douyinPlanLaunchBlockReason(input, { ...state, summary: selected("method_only") }) ?? "", /仍需要基础主题或正文/u);
  assert.equal(douyinPlanLaunchBlockReason(input, { ...state, summary: selected("topic_seed") }), null);
  assert.equal(douyinPlanLaunchBlockReason(input, { ...state, summary: selected("content_source") }), null);
  assert.match(douyinPlanLaunchBlockReason(input, { ...state, selectionDirty: true, summary: selected("topic_seed") }) ?? "", /正在自动保存/u);
});

test("保存抖音使用方式复用服务端 readiness 并保留部分结果与权利门禁", () => {
  const base = { busy: false, selectionDirty: true, acceptPartial: false,
    usageRole: "topic_seed" as const, rightsConfirmed: false };
  const summary = (status: "failed" | "succeeded", selectUsage: boolean) => ({
    snapshot: { id: "snapshot_1", status }, allowedActions: { selectUsage },
  }) as unknown as DouyinAnalysisSummary;
  assert.equal(canSaveDouyinSelection({ ...base, summary: summary("failed", false) }), false);
  assert.equal(canSaveDouyinSelection({ ...base, summary: summary("succeeded", true) }), true);
});

test("Task 8 面板静态边界包含移动列表、桌面表格、返焦和单层焦点复用", () => {
  const panel = readFileSync(new URL("../src/projects/douyin-analysis/DouyinAnalysisPanel.tsx", import.meta.url), "utf8");
  const details = readFileSync(new URL("../src/projects/douyin-analysis/DouyinAnalysisDetails.tsx", import.meta.url), "utf8");
  assert.match(panel, /hidden md:block/u);
  assert.match(panel, /md:hidden/u);
  assert.match(panel, /min-w-0/u);
  assert.match(details, /onCloseAutoFocus/u);
  assert.match(details, /isConnected/u);
  assert.match(details, /\.focus\(\)/u);
  assert.doesNotMatch(panel + details, /focus-visible:(?:ring|outline-none)/u);
});
