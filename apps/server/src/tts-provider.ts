import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { EdgeTTS } from "node-edge-tts";

import type { RuntimeModelConfig } from "./model-config.js";

const PROVIDER_VERSION = "windows-system-speech-v1";
const EDGE_PROVIDER_VERSION = "edge-tts-v1";
const HTTP_PROVIDER_VERSION = "http-tts-v1";
const MAX_PROCESS_OUTPUT = 64 * 1024;
const EDGE_OUTPUT_FORMAT = "audio-24khz-48kbitrate-mono-mp3";
const DEFAULT_EDGE_VOICE = "zh-CN-YunjianNeural";
const DEFAULT_EDGE_LANGUAGE = "zh-CN";
const DEFAULT_TTS_TIMEOUT_MS = 60_000;
const DEFAULT_TTS_QUEUE_INTERVAL_MS = 1_800;
const ttsQueues = new Map<string, Promise<void>>();
export const SYSTEM_SPEECH_UTF8_INPUT = "[Console]::InputEncoding = [Text.UTF8Encoding]::new($false)";
const POWERSHELL_SCRIPT = `
$ErrorActionPreference = 'Stop'
${SYSTEM_SPEECH_UTF8_INPUT}
Add-Type -AssemblyName System.Speech
$s = [System.Speech.Synthesis.SpeechSynthesizer]::new()
try {
  $s.SelectVoice($env:YINGSHU_TTS_VOICE)
  $s.Rate = [int]$env:YINGSHU_TTS_RATE
  $s.SetOutputToWaveFile($env:YINGSHU_TTS_OUTPUT)
  $s.Speak([Console]::In.ReadToEnd())
} finally {
  $s.Dispose()
}
`;

export class TtsProviderError extends Error {}
export class TtsCancelledError extends TtsProviderError {}

export interface SystemSpeechInput {
  text: string;
  outputPath: string;
  scriptVersionId: string;
  contentHash: string;
  signal?: AbortSignal;
  voice?: string;
  rate?: number;
  contractVersion?: string;
}

export interface TtsWordBoundary {
  part: string;
  startMs: number;
  endMs: number;
}

export interface TtsSynthesisResult {
  providerId: string;
  voice: string;
  rate: number;
  inputHash: string;
  outputPath: string;
  bytes: number;
  wordBoundaries?: TtsWordBoundary[];
}

export interface TtsSynthesisInput extends SystemSpeechInput {
  runtime?: RuntimeModelConfig | null;
  fetchImpl?: typeof fetch;
  waitImpl?: (ms: number) => Promise<void>;
  requestTimeoutMs?: number;
  queueIntervalMs?: number;
  maxRetries?: number;
  retryDelayMs?: number;
}

export interface SystemSpeechWavProbe {
  bytes: number;
  durationMs: number;
}

export async function probeSystemSpeechWav(path: string, signal?: AbortSignal): Promise<SystemSpeechWavProbe> {
  const info = await stat(path);
  const child = spawn("ffprobe", [
    "-v", "error",
    "-show_entries", "stream=codec_type,codec_name,channels,sample_rate:format=duration,size",
    "-of", "json",
    path,
  ], { windowsHide: true, shell: false, signal });
  let stdout = "";
  let stderr = "";
  let overflow = false;
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    stdout += chunk;
    if (stdout.length > MAX_PROCESS_OUTPUT) { overflow = true; child.kill(); }
  });
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
    if (stderr.length > MAX_PROCESS_OUTPUT) { overflow = true; child.kill(); }
  });
  const code = await new Promise<number | null>((resolvePromise, reject) => {
    child.once("error", reject);
    child.once("close", resolvePromise);
  });
  if (signal?.aborted) throw new TtsCancelledError("语音探测已取消");
  if (overflow) throw new TtsProviderError("ffprobe 输出超过 64 KiB 限制");
  if (code !== 0) throw new TtsProviderError(`ffprobe 校验音频失败${stderr.trim() ? `：${stderr.trim()}` : ""}`);
  let parsed: {
    streams?: Array<{ codec_type?: string; codec_name?: string; channels?: number; sample_rate?: string }>;
    format?: { duration?: string; size?: string };
  };
  try { parsed = JSON.parse(stdout) as typeof parsed; } catch { throw new TtsProviderError("ffprobe 返回了无效 JSON"); }
  const audio = parsed.streams?.filter((stream) => stream.codec_type === "audio") ?? [];
  const audioStream = audio[0];
  const hasVideo = parsed.streams?.some((stream) => stream.codec_type === "video") ?? false;
  const durationMs = Math.floor(Number(parsed.format?.duration) * 1_000);
  const reportedBytes = Number(parsed.format?.size);
  if (audio.length !== 1 || !audioStream || hasVideo || audioStream.codec_name !== "pcm_s16le" ||
      audioStream.channels !== 1 || audioStream.sample_rate !== "22050" ||
      !Number.isSafeInteger(durationMs) || durationMs < 1 || reportedBytes !== info.size) {
    throw new TtsProviderError("本机语音 WAV 编码、声道、采样率、大小或时长无效");
  }
  return { bytes: info.size, durationMs };
}

export function systemSpeechInputHash(input: Pick<SystemSpeechInput,
  "text" | "scriptVersionId" | "contentHash" | "voice" | "rate" | "contractVersion">) {
  const voice = input.voice ?? "Microsoft Huihui Desktop";
  const rate = input.rate ?? 0;
  return createHash("sha256").update(JSON.stringify({
    contract: PROVIDER_VERSION,
    scriptVersionId: input.scriptVersionId,
    contentHash: input.contentHash,
    text: input.text,
    voice,
    rate,
    contractVersion: input.contractVersion,
  })).digest("hex");
}

function configuredTtsIdentity(input: TtsSynthesisInput, runtime: RuntimeModelConfig) {
  const modelVoice = runtime.voiceId || input.voice || DEFAULT_EDGE_VOICE;
  return {
    contract: runtime.providerKind === "edge-tts" ? EDGE_PROVIDER_VERSION : HTTP_PROVIDER_VERSION,
    providerId: runtime.providerId,
    providerKind: runtime.providerKind,
    modelId: runtime.modelId,
    voice: modelVoice,
    language: runtime.language || DEFAULT_EDGE_LANGUAGE,
    gender: runtime.gender || "",
    rate: input.rate ?? 0,
    contractVersion: input.contractVersion,
  };
}

export function ttsInputHash(input: Pick<TtsSynthesisInput,
  "text" | "scriptVersionId" | "contentHash" | "voice" | "rate" | "contractVersion" | "runtime">) {
  if (!input.runtime) return systemSpeechInputHash(input);
  return createHash("sha256").update(JSON.stringify({
    ...configuredTtsIdentity(input as TtsSynthesisInput, input.runtime),
    scriptVersionId: input.scriptVersionId,
    contentHash: input.contentHash,
    text: input.text,
  })).digest("hex");
}

function rateToEdge(value: number | undefined) {
  const rate = value ?? 0;
  if (rate === 0) return "default";
  return `${rate > 0 ? "+" : ""}${Math.max(-100, Math.min(100, rate * 10))}%`;
}

function wait(ms: number) {
  return new Promise<void>((resolvePromise) => setTimeout(resolvePromise, ms));
}

function normalizeError(error: unknown) {
  return error instanceof Error ? error.message : String(error || "未知错误");
}

function shouldRetryStatus(status: number) {
  return status === 429 || status === 502 || status === 503 || status === 504;
}

async function enqueueTtsRequest<T>(queueKey: string, task: () => Promise<T>, intervalMs = DEFAULT_TTS_QUEUE_INTERVAL_MS) {
  const previous = ttsQueues.get(queueKey) ?? Promise.resolve();
  let release!: () => void;
  const tail = new Promise<void>((resolvePromise) => { release = resolvePromise; });
  ttsQueues.set(queueKey, previous.catch(() => undefined).then(() => tail));
  await previous.catch(() => undefined);
  try {
    return await task();
  } finally {
    if (intervalMs > 0) await wait(intervalMs);
    release();
  }
}

async function transcodeToSystemWav(inputPath: string, outputPath: string, signal?: AbortSignal) {
  const temporaryPath = `${outputPath}.${randomUUID()}.tmp.wav`;
  let published = false;
  try {
    const child = spawn("ffmpeg", [
      "-y", "-v", "error", "-i", inputPath,
      "-ac", "1", "-ar", "22050", "-c:a", "pcm_s16le", temporaryPath,
    ], { windowsHide: true, shell: false, signal });
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => { stderr = `${stderr}${chunk}`.slice(-8192); });
    const code = await new Promise<number | null>((resolvePromise, reject) => {
      child.once("error", reject);
      child.once("close", resolvePromise);
    });
    if (signal?.aborted) throw new TtsCancelledError("语音生成已取消");
    if (code !== 0) throw new TtsProviderError(`语音格式转换失败${stderr.trim() ? `：${stderr.trim()}` : ""}`);
    await probeSystemSpeechWav(temporaryPath, signal);
    await rename(temporaryPath, outputPath);
    published = true;
  } finally {
    if (!published) await rm(temporaryPath, { force: true });
  }
}

export function parseEdgeSubtitleJson(value: unknown): TtsWordBoundary[] {
  if (!Array.isArray(value)) throw new TtsProviderError("Edge TTS 字幕不是数组");
  if (value.length > 10_000) throw new TtsProviderError("Edge TTS 字幕数量超过限制");
  let previousEnd = 0;
  return value.map((item) => {
    const raw = item && typeof item === "object" ? item as Record<string, unknown> : {};
    const part = typeof raw.part === "string" ? raw.part : "";
    const startMs = Number(raw.start);
    const endMs = Number(raw.end);
    if (!part || !Number.isFinite(startMs) || !Number.isFinite(endMs) || startMs < 0 || endMs < startMs || startMs < previousEnd) {
      throw new TtsProviderError("Edge TTS 字幕时间边界无效");
    }
    previousEnd = endMs;
    return { part, startMs: Math.round(startMs), endMs: Math.round(endMs) };
  });
}

async function synthesizeEdgeTts(input: TtsSynthesisInput, runtime: RuntimeModelConfig): Promise<TtsSynthesisResult> {
  const text = input.text.trim();
  if (!text) throw new TtsProviderError("语音文本不能为空");
  if (input.signal?.aborted) throw new TtsCancelledError("语音生成已取消");
  const outputPath = resolve(input.outputPath);
  const outputDirectory = dirname(outputPath);
  const temporaryAudio = join(outputDirectory, `.${basename(outputPath)}.${randomUUID()}.tmp.mp3`);
  const subtitlePath = `${temporaryAudio}.json`;
  await mkdir(outputDirectory, { recursive: true });
  let published = false;
  const cleanup = async () => {
    await rm(temporaryAudio, { force: true });
    await rm(subtitlePath, { force: true });
    if (!published) await rm(outputPath, { force: true });
  };
  try {
    const tts = new EdgeTTS({
      voice: runtime.voiceId || DEFAULT_EDGE_VOICE,
      lang: runtime.language || DEFAULT_EDGE_LANGUAGE,
      outputFormat: EDGE_OUTPUT_FORMAT,
      saveSubtitles: true,
      rate: rateToEdge(input.rate),
      pitch: "default",
      volume: "default",
      timeout: input.requestTimeoutMs ?? 10_000,
    });
    const ttsPromise = tts.ttsPromise(text, temporaryAudio);
    let aborted = false;
    const abortPromise = new Promise<never>((_, reject) => {
      const abort = () => {
        aborted = true;
        reject(new TtsCancelledError("语音生成已取消"));
      };
      input.signal?.addEventListener("abort", abort, { once: true });
      ttsPromise.finally(() => input.signal?.removeEventListener("abort", abort));
    });
    void ttsPromise.finally(() => { if (aborted) void cleanup(); });
    await (input.signal ? Promise.race([ttsPromise, abortPromise]) : ttsPromise);
    if (aborted || input.signal?.aborted) throw new TtsCancelledError("语音生成已取消");
    const temporaryInfo = await stat(temporaryAudio);
    if (!temporaryInfo.isFile() || temporaryInfo.size < 1_024) throw new TtsProviderError("Edge TTS 未返回有效音频");
    const wordBoundaries = parseEdgeSubtitleJson(JSON.parse(await readFile(subtitlePath, "utf8")));
    if (wordBoundaries.length === 0 && runtime.wordBoundary) throw new TtsProviderError("Edge TTS 未返回逐词边界");
    await transcodeToSystemWav(temporaryAudio, outputPath, input.signal);
    const info = await stat(outputPath);
    published = true;
    return {
      providerId: runtime.providerId,
      voice: runtime.voiceId || DEFAULT_EDGE_VOICE,
      rate: input.rate ?? 0,
      inputHash: ttsInputHash({ ...input, text, runtime }),
      outputPath,
      bytes: info.size,
      wordBoundaries,
    };
  } catch (error) {
    if (input.signal?.aborted || (error as NodeJS.ErrnoException).name === "AbortError") throw new TtsCancelledError("语音生成已取消");
    if (error instanceof TtsProviderError) throw error;
    throw new TtsProviderError(`Edge TTS 生成失败：${normalizeError(error)}`);
  } finally {
    await cleanup();
  }
}

async function fetchJsonWithTimeout(fetchImpl: typeof fetch, url: string, init: RequestInit, timeoutMs: number, signal?: AbortSignal) {
  if (signal?.aborted) throw new TtsCancelledError("语音生成已取消");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const abort = () => controller.abort();
  signal?.addEventListener("abort", abort, { once: true });
  try {
    return await fetchImpl(url, { ...init, signal: controller.signal });
  } catch (error) {
    if (signal?.aborted || (error as NodeJS.ErrnoException).name === "AbortError") throw new TtsCancelledError("语音生成已取消");
    throw error;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", abort);
  }
}

function extractHttpAudio(payload: unknown, providerKind: RuntimeModelConfig["providerKind"]) {
  const root = payload && typeof payload === "object" ? payload as Record<string, any> : {};
  if (providerKind === "minimax") return root.data?.audio || root.audio || "";
  return root.choices?.[0]?.message?.audio?.data
    || root.choices?.[0]?.message?.audio?.audio
    || root.choices?.[0]?.audio?.data
    || root.choices?.[0]?.audio?.audio
    || root.audio?.data
    || root.audio?.audio
    || root.audio_data
    || root.audioContent
    || root.data
    || "";
}

export async function callHttpTtsModel(input: TtsSynthesisInput, runtime: RuntimeModelConfig): Promise<Buffer> {
  const text = input.text.trim();
  if (!text) throw new TtsProviderError("语音文本不能为空");
  if ((runtime.providerKind !== "minimax" && runtime.providerKind !== "mimo") || !runtime.apiKey || !runtime.baseUrl || !runtime.modelId) {
    throw new TtsProviderError("TTS 模型未配置");
  }
  const isMiniMax = runtime.providerKind === "minimax";
  const timeoutMs = input.requestTimeoutMs ?? DEFAULT_TTS_TIMEOUT_MS;
  const fetchImpl = input.fetchImpl ?? fetch;
  const retryLimit = Math.max(0, input.maxRetries ?? 2);
  const retryDelayMs = Math.max(0, input.retryDelayMs ?? 1_500);
  const url = `${runtime.baseUrl}${isMiniMax ? "/t2a_v2" : "/chat/completions"}`;
  let response: Response | undefined;
  let payload: unknown;
  for (let attempt = 0; attempt <= retryLimit; attempt += 1) {
    response = await enqueueTtsRequest(`${runtime.providerId}:${runtime.baseUrl}:${runtime.modelId}`, async () =>
      fetchJsonWithTimeout(fetchImpl, url, {
        method: "POST",
        headers: isMiniMax ? {
          "Content-Type": "application/json",
          Authorization: `Bearer ${runtime.apiKey}`,
        } : {
          "Content-Type": "application/json",
          "api-key": runtime.apiKey,
        },
        body: JSON.stringify(isMiniMax ? {
          model: runtime.modelId,
          text,
          stream: false,
          output_format: "hex",
          voice_setting: {
            voice_id: runtime.voiceId || "Chinese_deep_voiced_male_nv1",
            speed: 1,
            vol: 1,
            pitch: 0,
          },
          audio_setting: {
            sample_rate: 32000,
            bitrate: 128000,
            format: "wav",
            channel: 1,
          },
          subtitle_enable: false,
        } : {
          model: runtime.modelId,
          messages: [
            { role: "user", content: "请使用自然、清晰、适合说书旁白的语气。" },
            { role: "assistant", content: text },
          ],
          modalities: ["text", "audio"],
          audio: { format: "wav", voice: runtime.voiceId || "mimo_default" },
        }),
      }, timeoutMs, input.signal),
      input.queueIntervalMs ?? DEFAULT_TTS_QUEUE_INTERVAL_MS,
    );
    payload = await response.json().catch(() => null);
    if (!shouldRetryStatus(response.status) || attempt >= retryLimit) break;
    const delay = [502, 503, 504].includes(response.status) ? retryDelayMs * (2 ** attempt) : retryDelayMs * (attempt + 1);
    await (input.waitImpl ?? wait)(delay);
  }
  if (!response?.ok) throw new TtsProviderError(`TTS 模型请求失败：HTTP ${response?.status ?? 0}`);
  if (isMiniMax) {
    const root = payload && typeof payload === "object" ? payload as Record<string, any> : {};
    if (Number(root.base_resp?.status_code || 0) !== 0) throw new TtsProviderError(`MiniMax TTS 失败：${root.base_resp?.status_msg || "接口返回错误"}`);
  }
  const audio = extractHttpAudio(payload, runtime.providerKind);
  if (typeof audio !== "string" || !audio) throw new TtsProviderError("TTS 模型未返回有效音频");
  return Buffer.from(audio, isMiniMax ? "hex" : "base64");
}

async function synthesizeHttpTts(input: TtsSynthesisInput, runtime: RuntimeModelConfig): Promise<TtsSynthesisResult> {
  const outputPath = resolve(input.outputPath);
  const outputDirectory = dirname(outputPath);
  const temporaryAudio = join(outputDirectory, `.${basename(outputPath)}.${randomUUID()}.tmp.wav`);
  let published = false;
  try {
    await mkdir(outputDirectory, { recursive: true });
    await writeFile(temporaryAudio, await callHttpTtsModel(input, runtime));
    await transcodeToSystemWav(temporaryAudio, outputPath, input.signal);
    const info = await stat(outputPath);
    published = true;
    return {
      providerId: runtime.providerId,
      voice: runtime.voiceId || "",
      rate: input.rate ?? 0,
      inputHash: ttsInputHash({ ...input, runtime }),
      outputPath,
      bytes: info.size,
    };
  } finally {
    await rm(temporaryAudio, { force: true });
    if (!published) await rm(outputPath, { force: true });
  }
}

export async function synthesizeConfiguredTts(input: TtsSynthesisInput): Promise<TtsSynthesisResult> {
  if (!input.runtime) return synthesizeSystemSpeech(input);
  if (input.runtime.providerKind === "edge-tts") return synthesizeEdgeTts(input, input.runtime);
  if (input.runtime.providerKind === "minimax" || input.runtime.providerKind === "mimo") return synthesizeHttpTts(input, input.runtime);
  return synthesizeSystemSpeech(input);
}

export async function synthesizeSystemSpeech(input: SystemSpeechInput) {
  const text = input.text.trim();
  const voice = input.voice ?? "Microsoft Huihui Desktop";
  const rate = input.rate ?? 0;
  if (!text) throw new TtsProviderError("语音文本不能为空");
  if (!input.scriptVersionId || !/^[0-9a-f]{64}$/.test(input.contentHash)) {
    throw new TtsProviderError("批准稿身份无效");
  }
  if (!voice.trim() || !Number.isInteger(rate) || rate < -10 || rate > 10) {
    throw new TtsProviderError("本机语音配置无效");
  }
  if (input.signal?.aborted) throw new TtsCancelledError("语音生成已取消");

  const outputPath = resolve(input.outputPath);
  const outputDirectory = dirname(outputPath);
  const temporaryPath = join(outputDirectory, `.${basename(outputPath)}.${randomUUID()}.tmp.wav`);
  await mkdir(outputDirectory, { recursive: true });
  try {
    await stat(outputPath);
    throw new TtsProviderError("语音输出已存在");
  } catch (error) {
    if (error instanceof TtsProviderError) throw error;
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }

  let stderr = "";
  let published = false;
  try {
    const child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", POWERSHELL_SCRIPT], {
      windowsHide: true,
      shell: false,
      signal: input.signal,
      env: {
        ...process.env,
        YINGSHU_TTS_VOICE: voice,
        YINGSHU_TTS_RATE: String(rate),
        YINGSHU_TTS_OUTPUT: temporaryPath,
      },
      stdio: ["pipe", "ignore", "pipe"],
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => { stderr = `${stderr}${chunk}`.slice(-8192); });
    await new Promise<void>((resolvePromise, reject) => {
      let childError: Error | undefined;
      child.once("error", (error) => {
        if (child.pid === undefined) reject(error);
        else childError = error;
      });
      child.stdin.once("error", (error: NodeJS.ErrnoException) => {
        if (!input.signal?.aborted && error.code !== "EPIPE" && error.code !== "EOF") childError = error;
      });
      child.once("close", (code) => {
        if (input.signal?.aborted) reject(new TtsCancelledError("语音生成已取消"));
        else if (childError) reject(childError);
        else if (code === 0) resolvePromise();
        else reject(new TtsProviderError(`本机语音生成失败${stderr.trim() ? `：${stderr.trim()}` : ""}`));
      });
      child.stdin.end(text, "utf8");
    });
    const info = await stat(temporaryPath);
    if (!info.isFile() || info.size <= 44) throw new TtsProviderError("本机语音未生成有效 WAV 文件");
    const header = Buffer.alloc(12);
    const file = await open(temporaryPath, "r");
    try { await file.read(header, 0, header.length, 0); } finally { await file.close(); }
    if (header.toString("ascii", 0, 4) !== "RIFF" || header.toString("ascii", 8, 12) !== "WAVE") {
      throw new TtsProviderError("本机语音输出不是 WAV 文件");
    }
    // ponytail: P4-01 由单任务独占最终路径；出现并行同哈希生产时在 P4-02 加内容寻址复用。
    await rename(temporaryPath, outputPath);
    published = true;
    return {
      providerId: "windows-system-speech",
      voice,
      rate,
      inputHash: systemSpeechInputHash({ ...input, text, voice, rate }),
      outputPath,
      bytes: info.size,
    };
  } catch (error) {
    if (input.signal?.aborted || (error as NodeJS.ErrnoException).name === "AbortError") {
      throw new TtsCancelledError("语音生成已取消");
    }
    if (error instanceof TtsProviderError) throw error;
    throw new TtsProviderError(`本机语音生成失败：${error instanceof Error ? error.message : "未知错误"}`);
  } finally {
    if (!published) await rm(temporaryPath, { force: true });
  }
}
