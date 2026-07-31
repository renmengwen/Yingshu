import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { RuntimeModelConfig } from "./model-config.js";
import { probeSystemSpeechWav, TtsProviderError } from "./tts-provider.js";
import {
  createVideoTtsPcmFixture,
  resolveVideoTtsProviderIdentity,
  VIDEO_TTS_PROVIDER_CONTRACT_VERSION,
} from "./video-tts-provider.js";

const runtime: RuntimeModelConfig = {
  enabled: true,
  type: "tts",
  providerId: "edge-tts",
  providerName: "Edge TTS",
  providerKind: "edge-tts",
  protocol: "openai-response",
  baseUrl: "",
  apiKey: "",
  modelId: "node-edge-tts",
  voiceId: "zh-CN-YunjianNeural",
  language: "zh-CN",
  wordBoundary: true,
};
const selection = { voice: "zh-CN-YunjianNeural", rate: 0, language: "zh-CN" };

test("Video TTS 只冻结 active Edge 能力和非秘密身份", () => {
  assert.deepEqual(resolveVideoTtsProviderIdentity(runtime, selection), {
    providerId: "edge-tts",
    providerName: "Edge TTS",
    providerKind: "edge-tts",
    protocol: "openai-response",
    baseUrl: "",
    modelId: "node-edge-tts",
    ...selection,
    contractVersion: VIDEO_TTS_PROVIDER_CONTRACT_VERSION,
  });
  assert.throws(() => resolveVideoTtsProviderIdentity({ ...runtime, providerKind: "minimax" }, selection), /仅支持当前 Edge TTS/);
  assert.throws(() => resolveVideoTtsProviderIdentity(runtime, { ...selection, voice: "other" }), /能力范围/);
  assert.throws(() => resolveVideoTtsProviderIdentity(runtime, { ...selection, rate: 11 }), /-10 到 10/);
});

test("Video TTS fixture 生成可解码 PCM WAV，语速参与真实时长校准", async () => {
  const root = await mkdtemp(join(tmpdir(), "yingshu-video-tts-provider-"));
  try {
    const identity = resolveVideoTtsProviderIdentity(runtime, selection);
    const fixture = createVideoTtsPcmFixture(identity);
    const common = { text: "映述真实音频测试", scriptRevisionId: "script-1", scriptHash: "a".repeat(64), voice: identity.voice, language: identity.language };
    const normalPath = join(root, "normal.wav");
    const fastPath = join(root, "fast.wav");
    const normal = await fixture.synthesize({ ...common, rate: 0, outputPath: normalPath });
    const fast = await fixture.synthesize({ ...common, rate: 5, outputPath: fastPath });
    const normalProbe = await probeSystemSpeechWav(normalPath);
    const fastProbe = await probeSystemSpeechWav(fastPath);
    const bytes = await readFile(normalPath);
    assert.equal(bytes.toString("ascii", 0, 4), "RIFF");
    assert.equal(bytes.toString("ascii", 8, 12), "WAVE");
    assert.equal(normal.bytes, normalProbe.bytes);
    assert.equal(fast.bytes, fastProbe.bytes);
    assert.match(normal.inputHash, /^[0-9a-f]{64}$/);
    assert.notEqual(normal.inputHash, fast.inputHash);
    assert(normalProbe.durationMs > fastProbe.durationMs);
    assert.equal(fixture.getCallCount(), 2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Video TTS fixture 在写文件前响应取消", async () => {
  const identity = resolveVideoTtsProviderIdentity(runtime, selection);
  const fixture = createVideoTtsPcmFixture(identity);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(fixture.synthesize({
    text: "取消", outputPath: "unused.wav", scriptRevisionId: "script-1", scriptHash: "b".repeat(64),
    ...selection, signal: controller.signal,
  }), (error) => error instanceof TtsProviderError && /取消/.test(error.message));
  assert.equal(fixture.getCallCount(), 0);
});
