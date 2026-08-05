import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createElement } from "react";
import { renderToString } from "react-dom/server";

import {
  ASR_PROTOCOLS,
  activeModelLabel,
  emptyProvider,
  MODEL_TYPES,
  removeProvider,
  updateActive,
  updateProvider,
  updateProviderModel,
  type ModelConfig,
} from "../src/settings/model-settings.ts";
import {
  normalizeProductPromptInstructions,
  ProductPromptSettings,
  validateProductPromptInstructions,
} from "../src/settings/ProductPromptSettings.tsx";

function config(): ModelConfig {
  return {
    providers: {
      "edge-tts": {
        id: "edge-tts",
        name: "Edge TTS",
        kind: "edge-tts",
        protocol: "openai-response",
        baseUrl: "",
        apiKey: "",
        hasApiKey: false,
        apiKeyMasked: "",
        models: {
          text: { enabled: false, modelId: "", note: "" },
          image: { enabled: false, modelId: "", note: "" },
          tts: {
            enabled: true,
            modelId: "node-edge-tts",
            note: "",
            voiceId: "zh-CN-YunjianNeural",
            voiceLabel: "Chinese - China - Yunjian",
            language: "zh-CN",
            gender: "male",
            wordBoundary: true,
          },
          asr: { enabled: false, modelId: "", note: "", asrProtocol: "openai-transcription", maxRequestBytes: 10485760, segmentDurationSeconds: 180 },
        },
      },
      minimax: {
        id: "minimax",
        name: "MiniMax",
        kind: "minimax",
        protocol: "openai-response",
        baseUrl: "https://api.minimaxi.com/v1",
        apiKey: "",
        hasApiKey: false,
        apiKeyMasked: "",
        models: {
          text: { enabled: false, modelId: "", note: "" },
          image: { enabled: false, modelId: "", note: "" },
          tts: { enabled: false, modelId: "speech-2.8-hd", note: "", voiceId: "voice-a" },
          asr: { enabled: false, modelId: "mimo-v2.5-asr", note: "", asrProtocol: "mimo-audio", maxRequestBytes: 10485760, segmentDurationSeconds: 180 },
        },
      },
    },
    active: { text: "", image: "", tts: "edge-tts/tts", asr: "" },
  };
}

test("模型设置纯函数展示 Edge TTS 默认标签并更新 active", () => {
  const first = config();
  assert.equal(activeModelLabel(first, "tts"), "Edge TTS / Chinese - China - Yunjian");
  assert.equal(activeModelLabel(first, "text"), "未配置");

  const second = updateActive(first, "tts", "");
  assert.equal(activeModelLabel(second, "tts"), "未配置");

  const provider = { ...first.providers["edge-tts"], name: "Edge TTS 默认" };
  const third = updateProvider(first, provider);
  assert.equal(third.providers["edge-tts"].name, "Edge TTS 默认");
  assert.equal(first.providers["edge-tts"].name, "Edge TTS");

  const fourth = updateActive(first, "tts", "minimax/tts");
  assert.equal(fourth.active.tts, "minimax/tts");
  assert.equal(fourth.providers.minimax.models.tts.enabled, true);
  assert.equal(first.providers.minimax.models.tts.enabled, false);
});

test("模型设置复用 MuseDock 的供应商草稿和按模式配置逻辑", () => {
  const first = config();
  const custom = { ...emptyProvider("provider_1"), name: "自定义供应商" };
  const second = updateProvider(first, custom);
  const third = updateProviderModel(second, second.providers.provider_1, "image", "enabled", true);
  const fourth = updateProviderModel(third, third.providers.provider_1, "image", "modelId", "gpt-image-2");
  const fifth = updateActive(fourth, "image", "provider_1/image");
  const sixth = removeProvider(fifth, "provider_1");

  assert.equal(fifth.providers.provider_1.models.image.enabled, true);
  assert.equal(fifth.providers.provider_1.models.image.modelId, "gpt-image-2");
  assert.equal(fifth.active.image, "provider_1/image");
  assert.equal(sixth.providers.provider_1, undefined);
  assert.equal(sixth.active.image, "");
});

test("全局创作补充展示可编辑字段且不暴露旧书籍提示词", () => {
  const html = renderToString(createElement(ProductPromptSettings));

  assert.match(html, /全局创作补充/);
  assert.match(html, /全局文案补充/);
  assert.match(html, /全局画面补充/);
  assert.match(html, /固定系统合同和安全边界/);
  assert.doesNotMatch(html, /章节分析|全书世界观|逐集局部规划|本书专属/);
});

test("模型设置将 ASR 作为同一供应商下的第四种模式", () => {
  const first = config();
  const custom = emptyProvider("provider_asr");
  const enabled = updateProviderModel(first, custom, "asr", "enabled", true);
  const modeled = updateProviderModel(enabled, enabled.providers.provider_asr, "asr", "modelId", "whisper-1");
  const active = updateActive(modeled, "asr", "provider_asr/asr");

  assert.deepEqual(MODEL_TYPES, ["text", "image", "tts", "asr"]);
  assert.deepEqual(ASR_PROTOCOLS.map((item) => item.id), ["openai-transcription", "mimo-audio"]);
  assert.equal(custom.models.asr.maxRequestBytes, 10 * 1024 * 1024);
  assert.equal(custom.models.asr.segmentDurationSeconds, 180);
  assert.equal(activeModelLabel(active, "asr"), "新供应商 / whisper-1");
});

test("模型设置的长名称不会撑破供应商列表或默认模型网格", () => {
  const page = readFileSync(new URL("../src/settings/ModelSettingsPage.tsx", import.meta.url), "utf8");

  assert.match(page, /min-h-16 w-full min-w-0 overflow-hidden/u);
  assert.match(page, /<strong className="block truncate">/u);
  assert.match(page, /className="grid min-w-0 gap-2/u);
  assert.match(page, /<NativeSelect wrapperClassName="w-full min-w-0"/u);
});

test("全局创作补充按 Unicode code point 校验并统一换行", () => {
  assert.equal(normalizeProductPromptInstructions("  第一行\r\n第二行\r  "), "第一行\n第二行");
  assert.equal(validateProductPromptInstructions("😀".repeat(20_000), "全局文案补充"), undefined);
  assert.match(validateProductPromptInstructions("文".repeat(20_001), "全局文案补充") ?? "", /不能超过 20,000 个字符/);
});
