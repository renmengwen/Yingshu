import assert from "node:assert/strict";
import test from "node:test";

import {
  CREATIVE_INPUT_LIMITS,
  CreativeInputError,
  layeredCreativePrompt,
  parseCreativeInstructions,
  parseVideoInputDraft,
} from "./creative-input-contract.js";

function validInput() {
  return {
    inputMode: "topic",
    topic: "  为什么\u3000银票不容易伪造  ",
    body: "保留第一段\r\n\r\n保留第二段",
    referenceText: "  参考\r文字  ",
    referenceRole: "style_only",
    targetDurationSeconds: 180,
    visualDensity: "standard",
    webEnabled: true,
    scriptInstructions: "  文案\r\n补充  ",
    visualInstructions: "画面补充",
  };
}

test("视频输入规范化时保留非当前模式草稿和段落", () => {
  const parsed = parseVideoInputDraft(validInput());
  assert.equal(parsed.topic, "为什么 银票不容易伪造");
  assert.equal(parsed.body, "保留第一段\n\n保留第二段");
  assert.equal(parsed.referenceText, "参考\n文字");
  assert.equal(parsed.scriptInstructions, "文案\n补充");

  const body = parseVideoInputDraft({ ...validInput(), inputMode: "body", topic: "仍保留主题" });
  assert.equal(body.topic, "仍保留主题");
});

test("视频输入严格拒绝字段漂移、错误类型、超限和缺少当前主输入", () => {
  assert.throws(() => parseVideoInputDraft({ ...validInput(), extra: true }), /字段不完整或包含未支持字段/u);
  assert.throws(() => parseVideoInputDraft({ ...validInput(), webEnabled: 1 }), /必须是布尔值/u);
  assert.throws(() => parseVideoInputDraft({ ...validInput(), targetDurationSeconds: 60.5 }), /60～600 秒的整数/u);
  assert.throws(() => parseVideoInputDraft({ ...validInput(), referenceRole: "facts" }), /参考文本角色无效/u);
  assert.throws(() => parseVideoInputDraft({ ...validInput(), topic: "" }), /请输入主题/u);
  assert.throws(() => parseVideoInputDraft({ ...validInput(), inputMode: "body", body: "" }), /请粘贴正文/u);
  assert.throws(() => parseVideoInputDraft({
    ...validInput(), topic: "😀".repeat(CREATIVE_INPUT_LIMITS.topicCodePoints + 1),
  }), /主题不能超过 200 个字符/u);
  assert.throws(() => parseVideoInputDraft({
    ...validInput(), body: "中".repeat(Math.floor(CREATIVE_INPUT_LIMITS.bodyBytes / 3) + 1),
  }), /正文不能超过 131072 个 UTF-8 字节/u);
  assert.throws(() => parseVideoInputDraft({
    ...validInput(), referenceText: "中".repeat(Math.floor(CREATIVE_INPUT_LIMITS.referenceTextBytes / 3) + 1),
  }), /参考文本不能超过 65536 个 UTF-8 字节/u);
  assert.throws(() => parseCreativeInstructions({
    scriptInstructions: "😀".repeat(CREATIVE_INPUT_LIMITS.instructionCodePoints + 1),
    visualInstructions: "",
  }), /文案补充不能超过 20000 个字符/u);
  assert.throws(() => parseCreativeInstructions({ scriptInstructions: "", visualInstructions: "", extra: "" }),
    (error: unknown) => error instanceof CreativeInputError && error.statusCode === 400);
});

test("抖音选题或内容来源可只复用制作设置，方法参考仍由调用方要求主输入", () => {
  const parsed = parseVideoInputDraft({ ...validInput(), topic: "", body: "" }, { allowEmptyPrimary: true });
  assert.equal(parsed.topic, "");
  assert.equal(parsed.body, "");
});

test("提示词层级固定为系统、全局、项目、视频和局部改写", () => {
  assert.equal(layeredCreativePrompt({
    fixedSystemContract: "固定系统合同",
    globalInstructions: "全局配置",
    projectInstructions: "项目补充",
    videoInstructions: "视频补充",
    localRewriteInstructions: "局部改写",
  }), "固定系统合同\n\n全局配置\n\n项目补充\n\n视频补充\n\n局部改写");
});
