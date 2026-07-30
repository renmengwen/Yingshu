import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { buildApp } from "./app.js";
import {
  defaultModelConfig,
  modelConfigPath,
  readModelConfig,
  resolveRuntimeModelConfig,
  toPublicModelConfig,
  writeModelConfig,
} from "./model-config.js";

test("默认模型配置使用 Edge TTS 中文男声", () => {
  const config = defaultModelConfig();
  const tts = resolveRuntimeModelConfig("tts", config);

  assert.equal(config.active.tts, "edge-tts/tts");
  assert.equal(tts?.providerKind, "edge-tts");
  assert.equal(tts?.modelId, "node-edge-tts");
  assert.equal(tts?.voiceId, "zh-CN-YunjianNeural");
  assert.equal(tts?.voiceLabel, "Chinese - China - Yunjian");
  assert.equal(tts?.language, "zh-CN");
  assert.equal(tts?.gender, "male");
  assert.equal(tts?.wordBoundary, true);
});

test("active 模型保存后自动启用供 runtime 消费", () => {
  const config = defaultModelConfig();
  const minimax = config.providers.minimax!;
  const saved = {
    ...config,
    providers: {
      ...config.providers,
      minimax: {
        ...minimax,
        apiKey: "secret",
        models: {
          ...minimax.models,
          tts: { ...minimax.models.tts, enabled: false },
        },
      },
    },
    active: { ...config.active, tts: "minimax/tts" },
  };

  const runtime = resolveRuntimeModelConfig("tts", saved);

  assert.equal(runtime?.providerKind, "minimax");
  assert.equal(runtime?.modelId, "speech-2.8-hd");
});

test("已排队任务可按冻结 provider/model 解析配置，不受 active 切换影响", () => {
  const config = defaultModelConfig();
  config.providers.first = {
    id: "first", name: "第一供应商", kind: "openai-compatible", protocol: "openai-response",
    baseUrl: "https://first.example/v1", apiKey: "first-key",
    models: {
      text: { enabled: true, modelId: "first-model", note: "" },
      image: { enabled: false, modelId: "", note: "" },
      tts: { enabled: false, modelId: "", note: "" },
    },
  };
  config.providers.second = {
    ...config.providers.first,
    id: "second", name: "第二供应商", baseUrl: "https://second.example/v1", apiKey: "second-key",
    models: { ...config.providers.first.models, text: { enabled: true, modelId: "second-model", note: "" } },
  };
  config.active.text = "second/text";

  const queued = resolveRuntimeModelConfig("text", config, { providerId: "first", modelId: "first-model" });

  assert.equal(resolveRuntimeModelConfig("text", config)?.providerId, "second");
  assert.equal(queued?.providerId, "first");
  assert.equal(queued?.apiKey, "first-key");
  assert.equal(resolveRuntimeModelConfig("text", config, { providerId: "first", modelId: "changed" }), null);
});

test("保存配置不回显完整 key，空 key 保留旧 key", async () => {
  const dataRoot = await mkdtemp(join(tmpdir(), "narralume-model-config-"));
  try {
    await writeModelConfig(dataRoot, {
      providers: {
        minimax: {
          name: "MiniMax",
          kind: "minimax",
          baseUrl: "https://api.minimaxi.com/v1/",
          apiKey: "sk-secret-1234",
          models: { tts: { enabled: true, modelId: "speech-2.8-hd", voiceId: "voice-a" } },
        },
      },
      active: { tts: "minimax/tts" },
    });
    const preserved = await writeModelConfig(dataRoot, {
      providers: {
        minimax: {
          name: "MiniMax",
          kind: "minimax",
          baseUrl: "https://api.minimaxi.com/v1",
          apiKey: "",
          models: { tts: { enabled: true, modelId: "speech-2.8-hd", voiceId: "voice-b" } },
        },
      },
      active: { tts: "minimax/tts" },
    });
    const publicConfig = toPublicModelConfig(preserved);
    const publicMiniMax = publicConfig.providers.minimax;
    const runtime = resolveRuntimeModelConfig("tts", preserved);
    const raw = JSON.parse(await readFile(modelConfigPath(dataRoot), "utf8"));

    assert.ok(publicMiniMax);
    assert.equal(runtime?.apiKey, "sk-secret-1234");
    assert.equal(runtime?.baseUrl, "https://api.minimaxi.com/v1");
    assert.equal(runtime?.voiceId, "voice-b");
    assert.equal(publicMiniMax.apiKey, "");
    assert.equal(publicMiniMax.hasApiKey, true);
    assert.equal(publicMiniMax.apiKeyMasked, "sk-****1234");
    assert.equal(raw.providers.minimax.apiKey, "sk-secret-1234");
  } finally {
    await rm(dataRoot, { recursive: true, force: true });
  }
});

test("模型配置保存 MuseDock 兼容的 protocol 与按模式字段", async () => {
  const dataRoot = await mkdtemp(join(tmpdir(), "narralume-model-config-musedock-"));
  try {
    const saved = await writeModelConfig(dataRoot, {
      providers: {
        provider_1: {
          name: "自定义供应商",
          kind: "openai-compatible",
          protocol: "anthropic-message",
          baseUrl: "https://api.anthropic.com/v1/",
          apiKey: "secret",
          models: {
            text: { enabled: true, modelId: "claude-sonnet", supportsMultimodal: true },
            image: { enabled: true, modelId: "gpt-image-2", note: "北派视觉" },
            tts: { enabled: true, modelId: "speech-2.8-hd", voiceId: "voice-a", ttsConcurrency: 9, ttsQueueIntervalMs: -10 },
          },
        },
      },
      active: { text: "provider_1/text", image: "provider_1/image", tts: "provider_1/tts" },
    });
    const provider = saved.providers.provider_1!;

    assert.equal(provider.protocol, "anthropic-message");
    assert.equal(provider.baseUrl, "https://api.anthropic.com/v1");
    assert.equal(provider.models.text.supportsMultimodal, true);
    assert.equal(provider.models.tts.ttsConcurrency, 5);
    assert.equal(provider.models.tts.ttsQueueIntervalMs, 0);
    assert.equal(resolveRuntimeModelConfig("text", saved)?.protocol, "anthropic-message");
  } finally {
    await rm(dataRoot, { recursive: true, force: true });
  }
});

test("保存配置按页面供应商列表删除非 Edge 默认供应商", async () => {
  const dataRoot = await mkdtemp(join(tmpdir(), "narralume-model-config-remove-provider-"));
  try {
    await writeModelConfig(dataRoot, defaultModelConfig());
    const saved = await writeModelConfig(dataRoot, {
      providers: {
        "edge-tts": defaultModelConfig().providers["edge-tts"],
      },
      active: { text: "", image: "", tts: "edge-tts/tts" },
    });

    assert.ok(saved.providers["edge-tts"]);
    assert.equal(saved.providers.minimax, undefined);
    assert.equal(saved.providers.mimo, undefined);
    assert.equal(saved.providers["openai-compatible"], undefined);
  } finally {
    await rm(dataRoot, { recursive: true, force: true });
  }
});

test("模型配置 HTTP API 支持读取、保存和重启恢复", async () => {
  const dataRoot = await mkdtemp(join(tmpdir(), "narralume-model-config-api-"));
  let app = buildApp({ dataRoot, logger: false });

  try {
    const defaults = await app.inject({ method: "GET", url: "/api/config/models" });
    assert.equal(defaults.statusCode, 200);
    assert.equal(defaults.json().config.active.tts, "edge-tts/tts");
    assert.equal(defaults.json().config.providers["edge-tts"].apiKey, "");

    const saved = await app.inject({
      method: "PUT",
      url: "/api/config/models",
      payload: {
        providers: {
          minimax: {
            name: "MiniMax",
            kind: "minimax",
            baseUrl: "https://api.minimaxi.com/v1",
            apiKey: "secret-9999",
            models: { tts: { enabled: true, modelId: "speech-2.8-hd", voiceId: "voice-c" } },
          },
        },
        active: { tts: "minimax/tts" },
      },
    });
    assert.equal(saved.statusCode, 200);
    assert.equal(saved.json().config.providers.minimax.apiKey, "");
    assert.equal(saved.json().config.providers.minimax.apiKeyMasked, "****9999");

    await app.close();
    app = buildApp({ dataRoot, logger: false });
    const restored = await app.inject({ method: "GET", url: "/api/config/models" });
    const stored = await readModelConfig(dataRoot);
    assert.equal(restored.json().config.active.tts, "minimax/tts");
    assert.equal(resolveRuntimeModelConfig("tts", stored)?.apiKey, "secret-9999");
  } finally {
    await app.close();
    await rm(dataRoot, { recursive: true, force: true });
  }
});
