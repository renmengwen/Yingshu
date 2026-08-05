import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createElement } from "react";
import { renderToString } from "react-dom/server";

import { projectApi } from "../src/projects/api.ts";
import {
  acceptedMissingDimensions, canSaveZhihuSelection, usageRoleLabel, validateZhihuDraft,
  zhihuPlanLaunchBlockReason,
} from "../src/projects/zhihu-analysis/logic.ts";
import { DEFAULT_ZHIHU_ANALYSIS_CONFIG, type ZhihuAnalysisSummary } from "../src/projects/zhihu-analysis/types.ts";
import { VideoInputContent } from "../src/projects/VideoInputStage.tsx";
import type { VideoInputDraft } from "../src/projects/types.ts";

const targetUrl = "https://www.zhihu.com/question/9389089116/answer/1976331888235927140";
const input: VideoInputDraft = { inputMode: "topic", topic: "", body: "", referenceText: "", referenceRole: "style_only", targetDurationSeconds: 180, visualDensity: "standard", webEnabled: true, scriptInstructions: "", visualInstructions: "", updatedAt: 1 };

test("知乎回答链接校验只接受具体 HTTPS 回答并限制评论上限", () => {
  assert.deepEqual(DEFAULT_ZHIHU_ANALYSIS_CONFIG, { sourceUrl: "", analyzeComments: true, maxComments: 50 });
  assert.match(validateZhihuDraft(DEFAULT_ZHIHU_ANALYSIS_CONFIG) ?? "", /粘贴知乎回答链接/u);
  assert.match(validateZhihuDraft({ ...DEFAULT_ZHIHU_ANALYSIS_CONFIG, sourceUrl: "https://www.zhihu.com/question/9389089116" }) ?? "", /暂不支持仅分析问题页/u);
  assert.match(validateZhihuDraft({ ...DEFAULT_ZHIHU_ANALYSIS_CONFIG, sourceUrl: "https://example.com/question/1/answer/2" }) ?? "", /有效的知乎回答链接/u);
  assert.match(validateZhihuDraft({ ...DEFAULT_ZHIHU_ANALYSIS_CONFIG, sourceUrl: targetUrl, maxComments: 51 }) ?? "", /0～50/u);
  assert.equal(validateZhihuDraft({ ...DEFAULT_ZHIHU_ANALYSIS_CONFIG, sourceUrl: `${targetUrl}?utm_source=test#fragment` }), null);
});

test("知乎三种使用方式、部分结果和权利门禁固定", () => {
  assert.equal(usageRoleLabel("method_only"), "只参考表达与论证方法");
  assert.equal(usageRoleLabel("topic_seed"), "沿用选题，重新研究创作");
  assert.equal(usageRoleLabel("content_source"), "改写回答内容");
  assert.deepEqual(acceptedMissingDimensions({
    original: { status: "available" }, method: { status: "partial" }, topic: { status: "available" }, audience: { status: "unavailable" },
  }, { answerStatus: "succeeded", commentsStatus: "partial", commentCount: 5, completeness: "partial" }), ["method", "audience", "comments"]);
  const summary = { snapshot: { id: "snapshot_1", status: "partial" }, allowedActions: { selectUsage: true } } as unknown as ZhihuAnalysisSummary;
  assert.equal(canSaveZhihuSelection({ busy: false, selectionDirty: true, acceptPartial: false, usageRole: "topic_seed", rightsConfirmed: false, summary }), false);
  assert.equal(canSaveZhihuSelection({ busy: false, selectionDirty: true, acceptPartial: true, usageRole: "content_source", rightsConfirmed: false, summary }), false);
  assert.equal(canSaveZhihuSelection({ busy: false, selectionDirty: true, acceptPartial: true, usageRole: "content_source", rightsConfirmed: true, summary }), true);
});

test("知乎入口按快照、选择保存和方法角色阻断生成", () => {
  const state = { loaded: true, busy: false, selectionDirty: false, error: false };
  assert.match(zhihuPlanLaunchBlockReason(input, state) ?? "", /先完成知乎回答分析/u);
  const snapshot = { id: "snapshot_1", status: "succeeded", config: { ...DEFAULT_ZHIHU_ANALYSIS_CONFIG, sourceUrl: targetUrl } };
  const base = { snapshot, job: null, selection: null } as unknown as ZhihuAnalysisSummary;
  assert.match(zhihuPlanLaunchBlockReason(input, { ...state, summary: base }) ?? "", /选择知乎使用方式/u);
  const selected = (usageRole: "method_only" | "topic_seed" | "content_source") => ({ ...base, selection: { videoId: "video_1", snapshotId: snapshot.id, usageRole, creativeAngle: "", rightsConfirmed: usageRole === "content_source", updatedAt: 2 } }) as ZhihuAnalysisSummary;
  assert.match(zhihuPlanLaunchBlockReason(input, { ...state, summary: selected("method_only") }) ?? "", /仍需要基础主题或正文/u);
  assert.equal(zhihuPlanLaunchBlockReason(input, { ...state, summary: selected("topic_seed") }), null);
  assert.equal(zhihuPlanLaunchBlockReason(input, { ...state, summary: selected("content_source") }), null);
});

test("知乎 API 使用视频嵌套路由和严格请求体", async () => {
  const previous = globalThis.fetch;
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    return new Response(JSON.stringify({ ok: true, message: "已保存", selection: {} }), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  try {
    const config = { ...DEFAULT_ZHIHU_ANALYSIS_CONFIG, sourceUrl: targetUrl };
    await projectApi.createZhihuAnalysisJob("项目/一", "视频?二", config);
    await projectApi.saveZhihuAnalysisSelection("项目/一", "视频?二", { snapshotId: "snapshot_1", usageRole: "content_source", creativeAngle: "独立组织", rightsConfirmed: true, acceptedMissingDimensions: ["comments"] });
    assert.match(calls[0]!.url, /projects\/%E9%A1%B9%E7%9B%AE%2F%E4%B8%80\/videos\/%E8%A7%86%E9%A2%91%3F%E4%BA%8C\/zhihu-analysis\/jobs$/u);
    assert.deepEqual(JSON.parse(String(calls[0]!.init?.body)), config);
    assert.equal(calls[1]!.init?.method, "PUT");
    assert.deepEqual(JSON.parse(String(calls[1]!.init?.body)), { snapshotId: "snapshot_1", usageRole: "content_source", creativeAngle: "独立组织", rightsConfirmed: true, acceptedMissingDimensions: ["comments"] });
  } finally { globalThis.fetch = previous; }
});

test("第四入口布局、条件面板和知乎异步可访问性边界固定", () => {
  const html = renderToString(createElement(VideoInputContent, { state: { draft: { ...input, topic: "保留主题" }, setDraft: () => undefined, loaded: true, busy: false, dirty: false, status: "已加载", error: false, save: async () => undefined }, zhihuPanel: createElement("section", { "data-testid": "zhihu-panel" }, "知乎回答分析") }));
  assert.match(html, /根据知乎链接创作/u);
  assert.doesNotMatch(html, /data-testid="zhihu-panel"/u);
  const stage = readFileSync(new URL("../src/projects/VideoInputStage.tsx", import.meta.url), "utf8");
  const panel = readFileSync(new URL("../src/projects/zhihu-analysis/ZhihuAnalysisPanel.tsx", import.meta.url), "utf8");
  const details = readFileSync(new URL("../src/projects/zhihu-analysis/ZhihuAnalysisDetails.tsx", import.meta.url), "utf8");
  const hook = readFileSync(new URL("../src/projects/zhihu-analysis/use-zhihu-analysis.ts", import.meta.url), "utf8");
  assert.match(stage, /grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-4/u);
  assert.match(stage, /next !== "douyin" && next !== "zhihu"/u);
  assert.match(stage, /creativeInputMode === "zhihu"/u);
  assert.match(stage, /zhihuPanel/u);
  assert.match(panel, /hidden md:block/u);
  assert.match(panel, /md:hidden/u);
  assert.match(panel + details, /评论.*仅作受众解读/u);
  assert.match(details, /onCloseAutoFocus/u);
  assert.match(details, /isConnected/u);
  assert.match(hook, /window\.setTimeout\(\(\) => \{\s*void saveSelection\(\);\s*\}, 700\)/u);
  assert.match(hook, /busyRef\.current/u);
  assert.match(hook, /controllerRef\.current\?\.abort/u);
  assert.doesNotMatch(panel + details, /focus-visible:(?:ring|outline-none)/u);
});
