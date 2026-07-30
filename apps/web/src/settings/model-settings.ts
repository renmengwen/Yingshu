import { responseJson } from "../client-logic";

export const MODEL_TYPES = ["text", "image", "tts"] as const;
export type ModelType = typeof MODEL_TYPES[number];

export interface ModelEntry {
  enabled: boolean;
  modelId: string;
  note: string;
  supportsMultimodal?: boolean;
  voiceId?: string;
  voiceLabel?: string;
  language?: string;
  gender?: "male" | "female" | "";
  wordBoundary?: boolean;
  ttsConcurrency?: number;
  ttsQueueIntervalMs?: number;
}

export interface ModelProvider {
  id: string;
  name: string;
  kind: "openai-compatible" | "edge-tts" | "minimax" | "mimo";
  protocol: "openai-response" | "anthropic-message";
  baseUrl: string;
  apiKey: string;
  hasApiKey: boolean;
  apiKeyMasked: string;
  models: Record<ModelType, ModelEntry>;
}

export interface ModelConfig {
  providers: Record<string, ModelProvider>;
  active: Record<ModelType, string>;
}

export const MODEL_TYPE_LABELS: Record<ModelType, string> = {
  text: "分析与改编",
  image: "图片生成",
  tts: "语音合成",
};

export const MODEL_TYPE_INFO: Record<ModelType, { title: string; placeholder: string; help?: string }> = {
  text: { title: "分析与改编", placeholder: "gpt-4o-mini / deepseek-chat", help: "内容分析、资料整理和文案生成读取这里。" },
  image: { title: "图片生成", placeholder: "seedream-4-0 / gpt-image-2", help: "北派真实视觉资产生产读取这里。" },
  tts: { title: "TTS 语音合成", placeholder: "node-edge-tts / speech-2.8-hd", help: "短样校准与完整时间轴读取这里。" },
};

export const MODEL_PROTOCOLS = [
  { id: "openai-response", label: "Response（/v1/response）" },
  { id: "anthropic-message", label: "Message（/v1/message）" },
] as const;

export async function loadModelConfig() {
  const body = await responseJson<{ config: ModelConfig }>(await fetch("/api/config/models"));
  return body.config;
}

export async function saveModelConfig(config: ModelConfig) {
  const body = await responseJson<{ message: string; config: ModelConfig }>(
    await fetch("/api/config/models", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(config),
    }),
  );
  return body;
}

export function providerList(config: ModelConfig) {
  return Object.values(config.providers);
}

export function emptyModelEntry(type: ModelType): ModelEntry {
  const entry: ModelEntry = { enabled: false, modelId: "", note: "" };
  if (type === "text") entry.supportsMultimodal = false;
  if (type === "tts") {
    entry.voiceId = "Chinese_deep_voiced_male_nv1";
    entry.ttsConcurrency = 1;
    entry.ttsQueueIntervalMs = 1800;
  }
  return entry;
}

export function emptyProvider(id = `provider_${Date.now()}`): ModelProvider {
  return {
    id,
    name: "新供应商",
    kind: "openai-compatible",
    protocol: "openai-response",
    baseUrl: "",
    apiKey: "",
    hasApiKey: false,
    apiKeyMasked: "",
    models: {
      text: emptyModelEntry("text"),
      image: emptyModelEntry("image"),
      tts: emptyModelEntry("tts"),
    },
  };
}

export function enabledModelSummary(provider: ModelProvider) {
  const enabled = MODEL_TYPES
    .map((type) => {
      const model = provider.models[type];
      if (!model?.enabled || !model.modelId) return undefined;
      return `${MODEL_TYPE_LABELS[type]}：${model.modelId}`;
    })
    .filter(Boolean);
  return enabled.length ? enabled.join(" · ") : "未启用模型";
}

export function activeModelLabel(config: ModelConfig, type: ModelType) {
  const [providerId, modelType] = (config.active[type] ?? "").split("/");
  if (!providerId) return "未配置";
  const provider = config.providers[providerId];
  const model = provider?.models[modelType as ModelType];
  if (!provider || !model?.modelId) return "未配置";
  if (provider.kind === "edge-tts") return `${provider.name} / ${model.voiceLabel || model.voiceId || model.modelId}`;
  return `${provider.name} / ${model.modelId}`;
}

export function updateProvider(config: ModelConfig, provider: ModelProvider): ModelConfig {
  return { ...config, providers: { ...config.providers, [provider.id]: provider } };
}

export function removeProvider(config: ModelConfig, providerId: string): ModelConfig {
  const providers = { ...config.providers };
  delete providers[providerId];
  const active = { ...config.active };
  for (const type of MODEL_TYPES) {
    if (active[type]?.startsWith(`${providerId}/`)) active[type] = "";
  }
  return { providers, active };
}

export function updateProviderModel(
  config: ModelConfig,
  provider: ModelProvider,
  type: ModelType,
  field: keyof ModelEntry,
  value: string | boolean | number,
): ModelConfig {
  return updateProvider(config, {
    ...provider,
    models: {
      ...provider.models,
      [type]: { ...provider.models[type], [field]: value },
    },
  });
}

export function updateActive(config: ModelConfig, type: ModelType, value: string): ModelConfig {
  const [providerId, modelType] = value.split("/");
  const provider = providerId && modelType === type ? config.providers[providerId] : undefined;
  if (!provider?.models[type]?.modelId) return { ...config, active: { ...config.active, [type]: value } };
  return updateProvider(
    { ...config, active: { ...config.active, [type]: value } },
    {
      ...provider,
      models: {
        ...provider.models,
        [type]: { ...provider.models[type], enabled: true },
      },
    },
  );
}
