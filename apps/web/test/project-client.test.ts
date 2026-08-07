import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToString } from "react-dom/server";

import { promptLayerOrder, validateProjectSettings, validateVideoInput } from "../src/projects/input-logic.ts";
import { projectApi } from "../src/projects/api.ts";
import { normalizeName, parseAppRoute, projectPath, videoPath } from "../src/projects/logic.ts";
import { canCancelPlanJob, narrationFromParagraphs, planJobLabel, validateScriptDraft, validateVisualDrafts, videoPlanStageLabel } from "../src/projects/plan-logic.ts";
import type { VideoInputDraft } from "../src/projects/types.ts";
import { VideoInputContent } from "../src/projects/VideoInputStage.tsx";
import {
  VideoPlanLauncher, videoPlanLaunchBlockReason, videoPlanLaunchConfirmation,
} from "../src/projects/VideoPlanLauncher.tsx";
import {
  applyVisualStylePreset, promptInstructionsStatus, selectedVisualStylePreset,
} from "../src/projects/visual-style-presets.ts";
import { instructionLimitMessage } from "../src/projects/VideoProductionSettingsDialog.tsx";
import { VideoStageNavigation } from "../src/projects/VideoStageNavigation.tsx";

test("项目与视频路由可安全编码并从刷新地址恢复", () => {
  assert.equal(projectPath("项目/一"), "/projects/%E9%A1%B9%E7%9B%AE%2F%E4%B8%80");
  const path = videoPath("项目/一", "视频?二");
  assert.deepEqual(parseAppRoute(path), { page: "video", projectId: "项目/一", videoId: "视频?二" });
  assert.deepEqual(parseAppRoute("/projects/%E0%A4%A"), { page: "not-found" });
  assert.deepEqual(parseAppRoute("/unknown"), { page: "not-found" });
});

test("名称与标题统一归一化且不静默截断", () => {
  assert.equal(normalizeName("  Ａ  项目\n名称  ", "项目名称"), "A 项目 名称");
  assert.throws(() => normalizeName("　", "视频标题"), /请输入视频标题/);
  assert.throws(() => normalizeName("映".repeat(101), "项目名称"), /不能超过100个字符/);
});

test("草稿工作区只有输入与来源可进入，其余阶段明确尚未生成", () => {
  const html = renderToString(createElement(VideoStageNavigation, { activeStage: 0, planAvailable: false, imageAvailable: false, audioAvailable: false, onSelect: () => undefined }));
  assert.match(html, /输入与来源/);
  assert.equal((html.match(/尚未生成/g) ?? []).length, 3);
  assert.equal((html.match(/需先批准方案/g) ?? []).length, 2);
  assert.equal((html.match(/disabled=""/g) ?? []).length, 5);
  assert.doesNotMatch(html, /书籍|章节|系列|分集/);
});

test("方案任务出现后只开放审核阶段，仍不开放后续生产", () => {
  const html = renderToString(createElement(VideoStageNavigation, { activeStage: 1, planAvailable: true, imageAvailable: false, audioAvailable: false, onSelect: () => undefined }));
  assert.match(html, /文案与画面方案/);
  assert.equal((html.match(/disabled=""/g) ?? []).length, 4);
  assert.match(html, /aria-current="step"/);
});

const input = (override: Partial<VideoInputDraft> = {}): VideoInputDraft => ({
  inputMode: "topic",
  topic: "  Ａ  主题\n说明  ",
  body: "  正文第一段\n\n正文第二段  ",
  referenceText: "  参考文本  ",
  referenceRole: "style_only",
  targetDurationSeconds: 180,
  visualDensity: "standard",
  aspectRatio: "9:16",
  webEnabled: true,
  scriptInstructions: "  文案补充  ",
  visualInstructions: "  画面补充  ",
  updatedAt: 1,
  ...override,
});

test("创作输入按冻结边界归一化并保留非当前模式草稿", () => {
  const topic = validateVideoInput(input());
  assert.equal(topic.topic, "A 主题 说明");
  assert.equal(topic.body, "正文第一段\n\n正文第二段");
  const body = validateVideoInput(input({ inputMode: "body", topic: "保留主题" }));
  assert.equal(body.topic, "保留主题");
  assert.equal(body.body, "正文第一段\n\n正文第二段");
  assert.equal(body.referenceRole, "style_only");
  assert.equal(validateVideoInput(input({ aspectRatio: "16:9" })).aspectRatio, "16:9");
  assert.equal(body.webEnabled, true);
});

test("创作输入拒绝无效枚举、时长、必填和UTF-8字节超限", () => {
  assert.throws(() => validateVideoInput(input({ inputMode: "topic", topic: "　" })), /请输入视频主题/);
  assert.throws(() => validateVideoInput(input({ inputMode: "body", body: " \n " })), /请粘贴视频正文/);
  assert.throws(() => validateVideoInput(input({ targetDurationSeconds: 60.5 })), /60～600秒的整数/);
  assert.throws(() => validateVideoInput(input({ visualDensity: "dense" as "standard" })), /画面密度无效/);
  assert.throws(() => validateVideoInput(input({ aspectRatio: "1:1" as "9:16" })), /输出画幅无效/);
  assert.throws(() => validateVideoInput(input({ referenceText: "映".repeat(22_000) })), /64KiB/);
  assert.throws(() => validateProjectSettings({ scriptInstructions: "映".repeat(20_001), visualInstructions: "" }), /20000个字符/);
});

test("提示词层级身份固定且输入页呈现创作主次、可见操作与来源状态", () => {
  assert.deepEqual(promptLayerOrder("固定系统合同", "全局", "项目", "视频", "局部改写"), ["固定系统合同", "全局", "项目", "视频", "局部改写"]);
  assert.equal(promptInstructionsStatus("文案要求", "画面要求"), "已设置：文案、画面");
  assert.equal(promptInstructionsStatus("", ""), "未设置");
  const html = renderToString(createElement(VideoInputContent, { state: {
    draft: input(), setDraft: () => undefined, loaded: true, busy: false, dirty: true,
    status: "创作输入草稿已加载。", error: false, save: async () => undefined,
  } }));
  assert.match(html, /根据主题创作/);
  assert.match(html, /根据正文改编/);
  assert.match(html, /只参考表达风格/);
  assert.match(html, /作为内容资料/);
  assert.match(html, /制作设置/);
  assert.match(html, /3.*分钟.*标准节奏.*自定义画风.*竖屏 9:16.*联网查证/);
  assert.match(html, /已设置：文案、画面/);
  assert.match(html, /编辑制作设置/);
  assert.doesNotMatch(html, /10 分钟|生图画风|不使用预设|当前视频提示词补充|编辑提示词/);
  assert.match(html, /尚未生成方案。生成时会检索并冻结可核验来源/);
  assert.doesNotMatch(html, /<details|<summary|provider|费用|书籍|章节|系列|分集/);
});

test("生成入口保持单一主操作并在输入可用时允许打开确认弹框", () => {
  const html = renderToString(createElement(VideoPlanLauncher, {
    input: input({ webEnabled: true }), dirty: false, busy: false,
    modelLabel: "本地 fixture / text-model", modelAvailable: true, onStart: () => undefined,
  }));
  assert.match(html, /生成文案与画面方案/);
  assert.match(html, /aria-haspopup="dialog"/);
  assert.doesNotMatch(html, /disabled=""/);
});

test("生成入口统一阻止无效输入、自动保存中、处理中状态和缺失模型", () => {
  assert.match(videoPlanLaunchBlockReason(input({ topic: "" }), false, false, true) ?? "", /请输入视频主题/);
  assert.match(videoPlanLaunchBlockReason(input({ inputMode: "body", body: "" }), false, false, true) ?? "", /请粘贴视频正文/);
  assert.match(videoPlanLaunchBlockReason(input(), true, false, true) ?? "", /正在自动保存/);
  assert.match(videoPlanLaunchBlockReason(input(), false, true, true) ?? "", /正在处理/);
  assert.match(videoPlanLaunchBlockReason(input(), false, false, false) ?? "", /配置可用的文本模型/);
  assert.equal(videoPlanLaunchBlockReason(input(), false, false, true), null);
});

test("生成确认摘要明确展示冻结配置、执行步骤和下游边界", () => {
  const confirmation = videoPlanLaunchConfirmation(input({ webEnabled: true, aspectRatio: "16:9" }), "本地 fixture / text-model");
  assert.equal(confirmation.modelLabel, "本地 fixture / text-model");
  assert.match(confirmation.web, /已开启/);
  assert.equal(confirmation.spec, "横屏 · 16:9 · 1920 × 1080");
  assert.equal(confirmation.steps, "资料准备 → 旁白 → 画面规划");
  assert.match(confirmation.boundary, /不会自动生成图片、配音、字幕或视频/);
});

test("提示词补充在两万字边界内可应用，超限时给出明确删除字数", () => {
  assert.equal(instructionLimitMessage("字".repeat(20_000)), null);
  assert.match(instructionLimitMessage("字".repeat(20_001)) ?? "", /请删除 1 字/);
});

test("生图画风预设只替换托管首行并保留用户补充", () => {
  const realistic = applyVisualStylePreset("避免文字和水印。", "realistic");
  assert.match(realistic, /^【画风预设：写实摄影】/u);
  assert.match(realistic, /避免文字和水印。/u);
  assert.equal(selectedVisualStylePreset(realistic), "realistic");

  const anime = applyVisualStylePreset(realistic, "anime");
  assert.match(anime, /^【画风预设：日系动漫】/u);
  assert.doesNotMatch(anime, /画风预设：写实摄影/u);
  assert.match(anime, /避免文字和水印。/u);
  assert.equal(promptInstructionsStatus("", anime), "已设置：画面（日系动漫）");
  assert.equal(applyVisualStylePreset(anime, null), "避免文字和水印。");
});

test("方案编辑校验稳定段落关系并只允许运行中任务取消", () => {
  const paragraphs = validateScriptDraft("标题", "摘要", [{ id: "paragraph_1", text: " 第一段 " }]);
  assert.equal(narrationFromParagraphs(paragraphs), "第一段");
  const visual = {
    id: "visual_1", paragraphId: "paragraph_1", purpose: "建立语境", description: " 暖色工作台 ",
    prompt: " editorial workspace ", negativePrompt: "文字", suggestedDurationSeconds: 3, weight: 1,
    generationStatus: "not_generated" as const, currentCandidate: null,
  };
  assert.equal(validateVisualDrafts([visual], ["paragraph_1"])[0]?.description, "暖色工作台");
  assert.throws(() => validateVisualDrafts([{ ...visual, paragraphId: "missing" }], ["paragraph_1"]), /已不存在/);
  const running = { id: "job_1", status: "running" as const, errorMessage: null, updatedAt: 1 };
  assert.equal(canCancelPlanJob(running), true);
  assert.match(planJobLabel({ ...running, status: "cancelled" }), /已中断/);
  assert.equal(videoPlanStageLabel("generating_script"), "正在生成旁白");
});

test("方案 API 使用视频嵌套路由和冻结请求体", async () => {
  const previous = globalThis.fetch;
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    return new Response(JSON.stringify({ ok: true, message: "已创建", job: { id: "job_1", status: "queued", updatedAt: 1 }, videoStatus: "preparing_sources" }), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  try {
    await projectApi.createPlanJob("项目/一", "视频?二", "once-1");
    await projectApi.createPlanJob("项目/一", "视频?二", "once-2", "douyin");
    await projectApi.createPlanJob("项目/一", "视频?二", "once-3", "zhihu");
    assert.equal(calls[0]?.url, "/api/projects/%E9%A1%B9%E7%9B%AE%2F%E4%B8%80/videos/%E8%A7%86%E9%A2%91%3F%E4%BA%8C/plan-jobs");
    assert.deepEqual(JSON.parse(String(calls[0]?.init?.body)), { idempotencyKey: "once-1", entryMode: "primary_input" });
    assert.deepEqual(JSON.parse(String(calls[1]?.init?.body)), { idempotencyKey: "once-2", entryMode: "douyin" });
    assert.deepEqual(JSON.parse(String(calls[2]?.init?.body)), { idempotencyKey: "once-3", entryMode: "zhihu" });
    assert.equal(calls[0]?.init?.method, "POST");
  } finally {
    globalThis.fetch = previous;
  }
});
