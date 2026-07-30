import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { RuntimeModelConfig } from "./model-config.js";
import {
  callHttpTtsModel,
  parseEdgeSubtitleJson,
  synthesizeSystemSpeech,
  SYSTEM_SPEECH_UTF8_INPUT,
  systemSpeechInputHash,
  ttsInputHash,
  TtsCancelledError,
  TtsProviderError,
} from "./tts-provider.js";

function runtime(overrides: Partial<RuntimeModelConfig>): RuntimeModelConfig {
  return {
    enabled: true,
    type: "tts",
    providerId: "edge-tts",
    providerName: "Edge TTS",
    providerKind: "edge-tts",
    baseUrl: "",
    apiKey: "",
    modelId: "node-edge-tts",
    voiceId: "zh-CN-YunjianNeural",
    voiceLabel: "Chinese - China - Yunjian",
    language: "zh-CN",
    gender: "male",
    wordBoundary: true,
    ...overrides,
    protocol: overrides.protocol ?? "openai-response",
  };
}

test("System.Speech fallback 生成原子 WAV，并清理失败与取消的临时文件", {
  skip: process.platform !== "win32",
}, async () => {
  const root = await mkdtemp(join(tmpdir(), "narralume-tts-provider-"));
  const identity = { scriptVersionId: "script_test", contentHash: "a".repeat(64) };
  try {
    const sample = "中文 Narralume";
    const decoder = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
      `${SYSTEM_SPEECH_UTF8_INPUT}; ([Console]::In.ReadToEnd().ToCharArray() | ForEach-Object {[int]$_}) -join ','`,
    ], { windowsHide: true, stdio: ["pipe", "pipe", "inherit"] });
    decoder.stdout.setEncoding("utf8");
    let decoded = "";
    decoder.stdout.on("data", (chunk: string) => { decoded += chunk; });
    decoder.stdin.end(sample, "utf8");
    const [decoderCode] = await once(decoder, "close");
    assert.equal(decoderCode, 0);
    assert.equal(decoded.trim(), [...sample].map((character) => character.charCodeAt(0)).join(","));

    const outputPath = join(root, "voice.wav");
    const result = await synthesizeSystemSpeech({
      ...identity,
      text: "你好，这是 Narralume 的本机语音测试。",
      outputPath,
    });
    const bytes = await readFile(outputPath);
    assert.equal(bytes.toString("ascii", 0, 4), "RIFF");
    assert.equal(bytes.toString("ascii", 8, 12), "WAVE");
    assert.equal(result.bytes, bytes.length);
    assert.notEqual(
      systemSpeechInputHash({ ...identity, text: "测试", rate: 0 }),
      systemSpeechInputHash({ ...identity, text: "测试", rate: 1 }),
    );

    await assert.rejects(
      synthesizeSystemSpeech({
        ...identity,
        text: "错误语音测试",
        outputPath: join(root, "invalid.wav"),
        voice: "不存在的 Narralume Voice",
      }),
      (error) => error instanceof TtsProviderError && /本机语音生成失败/.test(error.message),
    );

    const controller = new AbortController();
    const cancelled = synthesizeSystemSpeech({
      ...identity,
      text: "这段语音用于验证取消。".repeat(2_000),
      outputPath: join(root, "cancelled.wav"),
      signal: controller.signal,
    });
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if ((await readdir(root)).some((name) => name.endsWith(".tmp.wav"))) break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert((await readdir(root)).some((name) => name.endsWith(".tmp.wav")));
    controller.abort();
    await assert.rejects(cancelled, (error) => error instanceof TtsCancelledError);
    assert.deepEqual((await readdir(root)).sort(), ["voice.wav"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Edge TTS 字幕 JSON 校验为现有 cue 提供单调逐词边界", () => {
  assert.deepEqual(parseEdgeSubtitleJson([
    { part: "吴邪", start: 0, end: 320 },
    { part: "进墓", start: 320.4, end: 900.6 },
  ]), [
    { part: "吴邪", startMs: 0, endMs: 320 },
    { part: "进墓", startMs: 320, endMs: 901 },
  ]);
  assert.throws(() => parseEdgeSubtitleJson([{ part: "坏", start: 9, end: 8 }]), /边界无效/);
  assert.throws(() => parseEdgeSubtitleJson([{ part: "A", start: 10, end: 20 }, { part: "B", start: 19, end: 30 }]), /边界无效/);
});

test("TTS input hash 包含 provider/model/voice/language/rate 身份", () => {
  const base = {
    text: "吴邪继续往前走。",
    scriptVersionId: "script",
    contentHash: "a".repeat(64),
    voice: "fallback",
    rate: 0,
    contractVersion: "test",
  };
  const edge = ttsInputHash({ ...base, runtime: runtime({}) });
  const minimax = ttsInputHash({ ...base, runtime: runtime({ providerId: "minimax", providerKind: "minimax", modelId: "speech-2.8-hd", voiceId: "voice-a", apiKey: "secret", baseUrl: "https://api.minimaxi.com/v1" }) });
  const fastEdge = ttsInputHash({ ...base, rate: 1, runtime: runtime({}) });
  assert.notEqual(edge, minimax);
  assert.notEqual(edge, fastEdge);
});

test("MiniMax TTS 使用 MuseDock 请求合同并解码 hex 音频", async () => {
  let request!: { url: string; init: RequestInit };
  const audio = Buffer.from("minimax-audio");
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    request = { url: String(url), init: init! };
    return new Response(JSON.stringify({ base_resp: { status_code: 0 }, data: { audio: audio.toString("hex") } }), { status: 200 });
  }) as typeof fetch;
  const result = await callHttpTtsModel({
    text: "吴邪进入墓道。",
    outputPath: "unused.wav",
    scriptVersionId: "script",
    contentHash: "b".repeat(64),
    fetchImpl,
    queueIntervalMs: 0,
  }, runtime({
    providerId: "minimax",
    providerKind: "minimax",
    providerName: "MiniMax",
    baseUrl: "https://api.minimaxi.com/v1",
    apiKey: "secret-key",
    modelId: "speech-2.8-hd",
    voiceId: "Chinese_deep_voiced_male_nv1",
  }));
  assert.deepEqual(result, audio);
  assert.equal(request.url, "https://api.minimaxi.com/v1/t2a_v2");
  assert.equal((request.init.headers as Record<string, string>).Authorization, "Bearer secret-key");
  const body = JSON.parse(String(request.init.body));
  assert.equal(body.output_format, "hex");
  assert.equal(body.subtitle_enable, false);
  assert.equal(body.voice_setting.voice_id, "Chinese_deep_voiced_male_nv1");
  assert.equal(body.audio_setting.format, "wav");
});

test("MiniMax/MiMo TTS 已取消时不发请求并返回取消错误", async () => {
  const controller = new AbortController();
  controller.abort();
  let called = false;
  await assert.rejects(
    callHttpTtsModel({
      text: "取消测试",
      outputPath: "unused.wav",
      scriptVersionId: "script",
      contentHash: "d".repeat(64),
      signal: controller.signal,
      fetchImpl: (async () => {
        called = true;
        return new Response("{}", { status: 200 });
      }) as typeof fetch,
      queueIntervalMs: 0,
    }, runtime({
      providerId: "minimax",
      providerKind: "minimax",
      providerName: "MiniMax",
      baseUrl: "https://api.minimaxi.com/v1",
      apiKey: "secret-key",
      modelId: "speech-2.8-hd",
    })),
    (error) => error instanceof TtsCancelledError,
  );
  assert.equal(called, false);
});

test("MiMo TTS 使用 MuseDock chat/completions 合同并解码 base64 音频", async () => {
  let request!: { url: string; init: RequestInit };
  const audio = Buffer.from("mimo-audio");
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    request = { url: String(url), init: init! };
    return new Response(JSON.stringify({ choices: [{ message: { audio: { data: audio.toString("base64") } } }] }), { status: 200 });
  }) as typeof fetch;
  const result = await callHttpTtsModel({
    text: "胖子压低声音。",
    outputPath: "unused.wav",
    scriptVersionId: "script",
    contentHash: "c".repeat(64),
    fetchImpl,
    queueIntervalMs: 0,
  }, runtime({
    providerId: "mimo",
    providerKind: "mimo",
    providerName: "MiMo",
    baseUrl: "https://api.xiaomimimo.com/v1",
    apiKey: "secret-key",
    modelId: "mimo-v2.5-tts",
    voiceId: "mimo_default",
  }));
  assert.deepEqual(result, audio);
  assert.equal(request.url, "https://api.xiaomimimo.com/v1/chat/completions");
  assert.equal((request.init.headers as Record<string, string>)["api-key"], "secret-key");
  const body = JSON.parse(String(request.init.body));
  assert.deepEqual(body.modalities, ["text", "audio"]);
  assert.deepEqual(body.audio, { format: "wav", voice: "mimo_default" });
});
