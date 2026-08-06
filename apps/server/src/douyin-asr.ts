import { createHash } from "node:crypto";
import { mkdir, readFile, stat } from "node:fs/promises";
import { basename, join } from "node:path";

import type { AsrProtocol, RuntimeModelConfig } from "./model-config.js";
import { runVideoProcess } from "./ffmpeg-video.js";

const MAX_RESPONSE_BYTES = 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 60_000;

type ProcessRunner = typeof runVideoProcess;

export interface DouyinAsrSegment {
  index: number;
  startMs: number;
  endMs: number;
  fileName: string;
  bytes: number;
  sha256: string;
  status: "prepared";
}

export interface DouyinAsrSegmentResult extends Omit<DouyinAsrSegment, "status"> {
  status: "succeeded" | "failed" | "cancelled";
  text: string;
  transcriptSegments: Array<{ startMs: number; endMs: number; text: string }>;
  error?: string;
}

export interface FrozenAsrModel {
  providerId: string;
  model: string;
  protocol: AsrProtocol;
  baseUrl: string;
  identityHash: string;
}

export interface DouyinAsrResult {
  status: "succeeded" | "partial" | "failed" | "cancelled";
  text: string;
  segments: DouyinAsrSegmentResult[];
  missingRanges: Array<{ startMs: number; endMs: number }>;
  model: FrozenAsrModel;
}

function sha256(value: Buffer) {
  return createHash("sha256").update(value).digest("hex");
}

function abortError() {
  return new DOMException("ASR 已取消", "AbortError");
}

function validateRuntime(runtime: RuntimeModelConfig) {
  if (runtime.type !== "asr" || !runtime.apiKey || !runtime.baseUrl || !runtime.modelId || !runtime.identityHash ||
      !/^[a-f0-9]{64}$/u.test(runtime.identityHash) || !runtime.asrProtocol || !runtime.maxRequestBytes ||
      !runtime.segmentDurationSeconds) {
    throw new Error("ASR 模型未完整配置");
  }
  const url = new URL(runtime.baseUrl);
  if (!/^https?:$/u.test(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error("ASR base URL 无效或包含秘密参数");
  }
  return {
    providerId: runtime.providerId,
    model: runtime.modelId,
    protocol: runtime.asrProtocol,
    baseUrl: runtime.baseUrl.replace(/\/+$/u, ""),
    identityHash: runtime.identityHash,
  } satisfies FrozenAsrModel;
}

export async function prepareDouyinAsrSegments(options: {
  transcribeAudio: boolean;
  videoPath: string;
  outputDirectory: string;
  durationMs: number;
  segmentDurationSeconds: number;
  signal?: AbortSignal;
  run?: ProcessRunner;
}): Promise<DouyinAsrSegment[]> {
  if (!options.transcribeAudio) return [];
  if (!Number.isSafeInteger(options.durationMs) || options.durationMs <= 0 ||
      !Number.isInteger(options.segmentDurationSeconds) || options.segmentDurationSeconds < 30) {
    throw new Error("ASR 音频时长或切片配置无效");
  }
  const run = options.run ?? runVideoProcess;
  const segmentMs = options.segmentDurationSeconds * 1_000;
  const segments: DouyinAsrSegment[] = [];
  await mkdir(options.outputDirectory, { recursive: true });
  for (let startMs = 0, index = 0; startMs < options.durationMs; startMs += segmentMs, index += 1) {
    if (options.signal?.aborted) throw abortError();
    const endMs = Math.min(options.durationMs, startMs + segmentMs);
    const fileName = `asr-${String(index + 1).padStart(4, "0")}.mp3`;
    const path = join(options.outputDirectory, fileName);
    await run("ffmpeg", ["-v", "error", "-y", "-ss", (startMs / 1_000).toFixed(3), "-t",
      ((endMs - startMs) / 1_000).toFixed(3), "-i", options.videoPath, "-vn", "-ac", "1", "-ar", "16000",
      "-b:a", "32k", path], { signal: options.signal });
    const [bytes, info] = await Promise.all([readFile(path), stat(path)]);
    if (!info.isFile() || info.size === 0) throw new Error(`ASR 音频切片为空：${basename(path)}`);
    segments.push({ index, startMs, endMs, fileName, bytes: info.size, sha256: sha256(bytes), status: "prepared" });
  }
  return segments;
}

async function boundedFetch(fetchImpl: typeof fetch, url: string, init: RequestInit, timeoutMs: number, signal?: AbortSignal) {
  if (signal?.aborted) throw abortError();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const abort = () => controller.abort();
  signal?.addEventListener("abort", abort, { once: true });
  try {
    return await fetchImpl(url, { ...init, signal: controller.signal });
  } catch (error) {
    if (signal?.aborted) throw abortError();
    if ((error as Error).name === "AbortError") throw new Error("ASR 请求超时");
    throw error;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", abort);
  }
}

async function responseJson(response: Response) {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) throw new Error("ASR 响应超过 1 MiB 限制");
  const text = await response.text();
  if (Buffer.byteLength(text) > MAX_RESPONSE_BYTES) throw new Error("ASR 响应超过 1 MiB 限制");
  try { return JSON.parse(text) as Record<string, unknown>; } catch { throw new Error("ASR 返回了无效 JSON"); }
}

interface ProviderTranscript {
  text: string;
  segments: Array<{ startMs: number; endMs: number; text: string }>;
}

function providerTranscript(payload: Record<string, unknown>, segment: DouyinAsrSegment): ProviderTranscript {
  if (typeof payload.text !== "string" || !payload.text.trim()) throw new Error("ASR 未返回有效文本");
  const values = Array.isArray(payload.segments) ? payload.segments : [];
  const segments = values.map((value) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const row = value as Record<string, unknown>;
    const start = typeof row.start === "number" && Number.isFinite(row.start) ? row.start : NaN;
    const end = typeof row.end === "number" && Number.isFinite(row.end) ? row.end : NaN;
    const text = typeof row.text === "string" ? row.text.trim() : "";
    if (start < 0 || end <= start || !text || end * 1_000 > segment.endMs - segment.startMs + 1_000) return null;
    return { startMs: segment.startMs + Math.round(start * 1_000), endMs: segment.startMs + Math.round(end * 1_000), text };
  }).filter((value): value is { startMs: number; endMs: number; text: string } => value !== null);
  return { text: payload.text.trim(), segments: segments.length ? segments : [{ startMs: segment.startMs, endMs: segment.endMs, text: payload.text.trim() }] };
}

async function callOpenAi(segment: DouyinAsrSegment, audio: Buffer, runtime: RuntimeModelConfig,
  fetchImpl: typeof fetch, timeoutMs: number, signal?: AbortSignal) {
  // multipart 还有字段与边界开销，预留 4 KiB 确保完整请求不会越过配置上限。
  if (audio.length + 4_096 > runtime.maxRequestBytes!) throw new Error("ASR 音频片段超过请求字节上限");
  const form = new FormData();
  form.append("file", new Blob([new Uint8Array(audio)], { type: "audio/mpeg" }), segment.fileName);
  form.append("model", runtime.modelId);
  form.append("response_format", "verbose_json");
  form.append("timestamp_granularities[]", "segment");
  const response = await boundedFetch(fetchImpl, `${runtime.baseUrl.replace(/\/+$/u, "")}/audio/transcriptions`, {
    method: "POST", headers: { Authorization: `Bearer ${runtime.apiKey}` }, body: form,
  }, timeoutMs, signal);
  const payload = await responseJson(response);
  if (!response.ok) throw new Error(`ASR 请求失败：HTTP ${response.status}`);
  return providerTranscript(payload, segment);
}

async function callMimo(segment: DouyinAsrSegment, audio: Buffer, runtime: RuntimeModelConfig,
  fetchImpl: typeof fetch, timeoutMs: number, signal?: AbortSignal) {
  const body = JSON.stringify({ model: runtime.modelId, messages: [{ role: "user", content: [{ type: "input_audio",
    input_audio: { data: `data:audio/mpeg;base64,${audio.toString("base64")}` } }] }], asr_options: { language: "auto" } });
  if (Buffer.byteLength(body) > runtime.maxRequestBytes!) throw new Error("ASR 请求超过字节上限");
  const response = await boundedFetch(fetchImpl, `${runtime.baseUrl.replace(/\/+$/u, "")}/chat/completions`, {
    method: "POST", headers: { "Content-Type": "application/json", "api-key": runtime.apiKey }, body,
  }, timeoutMs, signal);
  const payload = await responseJson(response);
  if (!response.ok) throw new Error(`ASR 请求失败：HTTP ${response.status}`);
  const choices = Array.isArray(payload.choices) ? payload.choices : [];
  const message = choices[0] && typeof choices[0] === "object" ? (choices[0] as Record<string, unknown>).message : null;
  const text = message && typeof message === "object" ? (message as Record<string, unknown>).content : null;
  if (typeof text !== "string" || !text.trim()) throw new Error("ASR 未返回有效文本");
  return { text: text.trim(), segments: [{ startMs: segment.startMs, endMs: segment.endMs, text: text.trim() }] };
}

export async function transcribeDouyinAsrSegments(options: {
  segments: DouyinAsrSegment[];
  audioDirectory: string;
  runtime: RuntimeModelConfig;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}): Promise<DouyinAsrResult> {
  const model = validateRuntime(options.runtime);
  if (options.segments.length === 0) throw new Error("ASR 没有可转写的音频片段");
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const results: DouyinAsrSegmentResult[] = [];
  const ordered = [...options.segments].sort((left, right) => left.startMs - right.startMs);
  let previousEnd = 0;
  for (const segment of ordered) {
    if (!Number.isInteger(segment.index) || segment.index < 0 || !Number.isSafeInteger(segment.startMs) ||
        !Number.isSafeInteger(segment.endMs) || segment.startMs !== previousEnd || segment.endMs <= segment.startMs ||
        !Number.isSafeInteger(segment.bytes) || segment.bytes <= 0 || !/^[a-f0-9]{64}$/u.test(segment.sha256)) {
      throw new Error("ASR 音频片段清单无效");
    }
    previousEnd = segment.endMs;
    if (options.signal?.aborted) {
      results.push({ ...segment, status: "cancelled", text: "", transcriptSegments: [], error: "ASR 已取消" });
      continue;
    }
    try {
      if (basename(segment.fileName) !== segment.fileName || !/^asr-\d{4}\.mp3$/u.test(segment.fileName)) {
        throw new Error("ASR 音频片段文件名无效");
      }
      const audio = await readFile(join(options.audioDirectory, segment.fileName));
      if (audio.length !== segment.bytes || sha256(audio) !== segment.sha256) throw new Error("ASR 音频片段 Hash 不匹配");
      const transcript = model.protocol === "mimo-audio"
        ? await callMimo(segment, audio, options.runtime, fetchImpl, timeoutMs, options.signal)
        : await callOpenAi(segment, audio, options.runtime, fetchImpl, timeoutMs, options.signal);
      results.push({ ...segment, status: "succeeded", text: transcript.text, transcriptSegments: transcript.segments });
    } catch (error) {
      const cancelled = options.signal?.aborted || (error as Error).name === "AbortError";
      results.push({ ...segment, status: cancelled ? "cancelled" : "failed", text: "",
        transcriptSegments: [],
        error: cancelled ? "ASR 已取消" : error instanceof Error ? error.message : "ASR 转写失败" });
    }
  }
  const succeeded = results.filter((segment) => segment.status === "succeeded");
  const missingRanges = results.filter((segment) => segment.status !== "succeeded")
    .map(({ startMs, endMs }) => ({ startMs, endMs }));
  const cancelled = results.some((segment) => segment.status === "cancelled");
  return {
    status: cancelled ? "cancelled" : missingRanges.length === 0 ? "succeeded" : succeeded.length ? "partial" : "failed",
    text: succeeded.map((segment) => segment.text).join("\n"), segments: results, missingRanges, model,
  };
}
