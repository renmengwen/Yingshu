import { randomUUID } from "node:crypto";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import type { RuntimeModelConfig } from "./model-config.js";
import {
  probeSystemSpeechWav,
  synthesizeConfiguredTts,
  ttsInputHash,
  TtsCancelledError,
  TtsProviderError,
  type TtsSynthesisResult,
} from "./tts-provider.js";

export const VIDEO_TTS_PROVIDER_CONTRACT_VERSION = "video-edge-tts-v1";
const PCM_SAMPLE_RATE = 22_050;

export interface VideoTtsSelection {
  voice: string;
  rate: number;
  language: string;
}

/** 可写入不可变快照的 provider 身份；刻意不包含 apiKey。 */
export interface VideoTtsProviderIdentity extends VideoTtsSelection {
  providerId: string;
  providerName: string;
  providerKind: "edge-tts";
  protocol: RuntimeModelConfig["protocol"];
  baseUrl: string;
  modelId: string;
  contractVersion: typeof VIDEO_TTS_PROVIDER_CONTRACT_VERSION;
}

export interface VideoTtsSynthesisInput extends VideoTtsSelection {
  text: string;
  outputPath: string;
  scriptRevisionId: string;
  scriptHash: string;
  signal?: AbortSignal;
}

export type SynthesizeVideoTts = (input: VideoTtsSynthesisInput) => Promise<TtsSynthesisResult>;

export function resolveVideoTtsProviderIdentity(
  runtime: RuntimeModelConfig | null | undefined,
  selection: VideoTtsSelection,
): VideoTtsProviderIdentity {
  if (!runtime || runtime.type !== "tts") throw new TtsProviderError("尚未配置可用的 TTS 模型，请先前往模型设置");
  if (runtime.providerKind !== "edge-tts") throw new TtsProviderError("首版配音仅支持当前 Edge TTS 配置");
  if (!runtime.modelId || !runtime.voiceId || !runtime.language || runtime.wordBoundary !== true) {
    throw new TtsProviderError("当前 Edge TTS 模型能力配置不完整");
  }
  if (selection.voice.trim() !== runtime.voiceId || selection.language.trim() !== runtime.language) {
    throw new TtsProviderError("音色或语言不在当前 Edge TTS 能力范围内");
  }
  if (!Number.isInteger(selection.rate) || selection.rate < -10 || selection.rate > 10) {
    throw new TtsProviderError("语速必须是 -10 到 10 之间的整数");
  }
  return {
    providerId: runtime.providerId,
    providerName: runtime.providerName,
    providerKind: "edge-tts",
    protocol: runtime.protocol,
    baseUrl: runtime.baseUrl,
    modelId: runtime.modelId,
    voice: runtime.voiceId,
    rate: selection.rate,
    language: runtime.language,
    contractVersion: VIDEO_TTS_PROVIDER_CONTRACT_VERSION,
  };
}

export function createVideoTtsSynthesizer(runtime: RuntimeModelConfig): SynthesizeVideoTts {
  return async (input) => {
    const identity = resolveVideoTtsProviderIdentity(runtime, input);
    return synthesizeConfiguredTts({
      text: input.text,
      outputPath: input.outputPath,
      scriptVersionId: input.scriptRevisionId,
      contentHash: input.scriptHash,
      voice: identity.voice,
      rate: identity.rate,
      contractVersion: identity.contractVersion,
      runtime,
      signal: input.signal,
    });
  };
}

function pcmWav(durationMs: number) {
  const sampleCount = Math.max(1, Math.round(PCM_SAMPLE_RATE * durationMs / 1_000));
  const dataBytes = sampleCount * 2;
  const wav = Buffer.alloc(44 + dataBytes);
  wav.write("RIFF", 0, "ascii");
  wav.writeUInt32LE(36 + dataBytes, 4);
  wav.write("WAVEfmt ", 8, "ascii");
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(PCM_SAMPLE_RATE, 24);
  wav.writeUInt32LE(PCM_SAMPLE_RATE * 2, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write("data", 36, "ascii");
  wav.writeUInt32LE(dataBytes, 40);
  for (let index = 0; index < sampleCount; index += 1) {
    wav.writeInt16LE(Math.round(Math.sin(2 * Math.PI * 220 * index / PCM_SAMPLE_RATE) * 2_000), 44 + index * 2);
  }
  return wav;
}

/** 隔离验收 fixture：语速会改变实测时长，且输出经过同一 ffprobe 合同校验。 */
export function createVideoTtsPcmFixture(identity: VideoTtsProviderIdentity) {
  let callCount = 0;
  const synthesize: SynthesizeVideoTts = async (input) => {
    const selected = resolveVideoTtsProviderIdentity({
      enabled: true,
      type: "tts",
      providerId: identity.providerId,
      providerName: identity.providerName,
      providerKind: identity.providerKind,
      protocol: identity.protocol,
      baseUrl: identity.baseUrl,
      apiKey: "",
      modelId: identity.modelId,
      voiceId: identity.voice,
      language: identity.language,
      wordBoundary: true,
    }, input);
    const text = input.text.trim();
    if (!text || !input.scriptRevisionId || !/^[0-9a-f]{64}$/.test(input.scriptHash)) {
      throw new TtsProviderError("TTS fixture 输入身份无效");
    }
    if (input.signal?.aborted) throw new TtsCancelledError("语音生成已取消");
    callCount += 1;
    // 语速档位是物理校准旋钮：fixture 仅给稳定基线，不冒充真实 provider 字速。
    const durationMs = Math.max(250, Math.round([...text].length / (4.5 * (1 + selected.rate * 0.06)) * 1_000));
    const outputPath = resolve(input.outputPath);
    const temporaryPath = `${outputPath}.${randomUUID()}.tmp.wav`;
    let published = false;
    try {
      await mkdir(dirname(outputPath), { recursive: true });
      await writeFile(temporaryPath, pcmWav(durationMs), { flag: "wx" });
      if (input.signal?.aborted) throw new TtsCancelledError("语音生成已取消");
      const probe = await probeSystemSpeechWav(temporaryPath, input.signal);
      await rename(temporaryPath, outputPath);
      published = true;
      return {
        providerId: selected.providerId,
        voice: selected.voice,
        rate: selected.rate,
        inputHash: ttsInputHash({
          text,
          scriptVersionId: input.scriptRevisionId,
          contentHash: input.scriptHash,
          voice: selected.voice,
          rate: selected.rate,
          contractVersion: selected.contractVersion,
          runtime: {
            enabled: true, type: "tts", providerId: selected.providerId, providerName: selected.providerName,
            providerKind: selected.providerKind, protocol: selected.protocol, baseUrl: selected.baseUrl, apiKey: "",
            modelId: selected.modelId, voiceId: selected.voice, language: selected.language, wordBoundary: true,
          },
        }),
        outputPath,
        bytes: probe.bytes,
      };
    } finally {
      if (!published) await rm(temporaryPath, { force: true });
    }
  };
  return { synthesize, getCallCount: () => callCount };
}
