import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createElement } from "react";
import { renderToString } from "react-dom/server";

import { projectApi } from "../src/projects/api.ts";
import {
  acceptedMissingDimensions, DOUYIN_STATUS_LABELS, douyinStatusMessage, evidenceRows, unavailableDimensions, usageRoleLabel,
  validateDouyinDraft,
} from "../src/projects/douyin-analysis/logic.ts";
import { DEFAULT_DOUYIN_ANALYSIS_CONFIG, type DouyinAvailabilityDimension } from "../src/projects/douyin-analysis/types.ts";
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

test("输入与来源编排抖音面板时保留原主题正文草稿", () => {
  const draft: VideoInputDraft = { inputMode: "topic", topic: "保留主题", body: "保留正文", referenceText: "", referenceRole: "style_only", targetDurationSeconds: 180, visualDensity: "standard", webEnabled: true, scriptInstructions: "", visualInstructions: "", updatedAt: 1 };
  const html = renderToString(createElement(VideoInputContent, { state: { draft, setDraft: () => undefined, loaded: true, busy: false, dirty: false, status: "已加载", error: false, save: async () => undefined }, douyinPanel: createElement("section", { "data-testid": "douyin-panel" }, "抖音视频分析") }));
  assert.match(html, /保留主题/);
  assert.match(html, /抖音视频分析/);
  assert.match(html, /data-testid="douyin-panel"/);
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
