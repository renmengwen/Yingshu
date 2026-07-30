import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToString } from "react-dom/server";

import {
  activeModelLabel,
  emptyProvider,
  removeProvider,
  updateActive,
  updateProvider,
  updateProviderModel,
  type ModelConfig,
} from "../src/settings/model-settings.ts";
import { ProductPromptList } from "../src/settings/ProductPromptSettings.tsx";

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
        },
      },
    },
    active: { text: "", image: "", tts: "edge-tts/tts" },
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

test("设置页按服务端标题和版本展示只读产品级提示词", () => {
  const html = renderToString(createElement(ProductPromptList, { promptSet: {
    setVersion: "product-prompts-v1",
    titles: { chapterAnalysis: "章节分析" },
    versions: { chapterAnalysis: "chapter-analysis-v1" },
    prompts: { chapterAnalysis: "只提取有来源的结构化事件。" },
  } }));

  assert.match(html, /产品级提示词/);
  assert.match(html, /所有项目与视频任务共用/);
  assert.match(html, /product-prompts-v1/);
  assert.match(html, /章节分析/);
  assert.match(html, /chapter-analysis-v1/);
  assert.match(html, /只提取有来源的结构化事件/);
});
