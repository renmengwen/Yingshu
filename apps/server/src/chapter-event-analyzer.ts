import { createHash } from "node:crypto";
import { open } from "node:fs/promises";
import { resolve, sep } from "node:path";
import type { DatabaseSync } from "node:sqlite";

import {
  CHAPTER_EVENT_TYPES,
  ChapterEventError,
  type ChapterEventInput,
  type ChapterEventType,
} from "./chapter-event-store.js";
import {
  completedTextModelEvidence,
  rememberTextModelEvidence,
  streamedText,
  TextModelStreamError,
  textModelCallError,
  textModelJsonStatistics,
  type TextModelCallEvidence,
  type TextModelStreamStatistics,
} from "./text-model-stream.js";
import { textModelConcurrencyGate } from "./text-model-concurrency.js";
import { layeredPrompt, PRODUCT_PROMPTS } from "./product-prompts.js";

const MAX_CHAPTER_BYTES = 128 * 1024;
const MAX_ATOM_BYTES = 16 * 1024;
const MAX_RESPONSE_BYTES = 1024 * 1024;
export const MAX_CHAPTER_BATCH_INPUT_BYTES = 512 * 1024;
const EVENT_TYPES = new Set<string>(CHAPTER_EVENT_TYPES);

class ChapterEvidenceReferenceError extends Error {}

export interface ChapterEvidenceAtom {
  id: string;
  byteStart: number;
  byteEnd: number;
  text: string;
}

export interface ChapterTextModelConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  providerId: string;
  protocol?: "openai-response" | "anthropic-message";
}

export interface ChapterAnalysisInput {
  chapterId: string;
  atoms: readonly ChapterEvidenceAtom[];
  promptInstructions?: string;
  signal?: AbortSignal;
  onActivity?: () => void;
}

export type AnalyzeChapterEvents = (
  input: ChapterAnalysisInput,
) => Promise<readonly ChapterEventInput[]>;

export interface ChapterBatchAnalysisInput {
  chapters: readonly ChapterAnalysisInput[];
  promptInstructions?: string;
  signal?: AbortSignal;
  onActivity?: () => void;
}

export interface ChapterBatchAnalysisResult {
  chapterId: string;
  events: readonly ChapterEventInput[];
}

export type AnalyzeChapterEventsBatch = (
  input: ChapterBatchAnalysisInput,
) => Promise<readonly ChapterBatchAnalysisResult[]>;

interface ChapterSourceRow {
  byte_start: number;
  byte_end: number;
  content_hash: string;
  encoding: string;
  original_file_path: string;
}

function sha256(value: Uint8Array | string) {
  return createHash("sha256").update(value).digest("hex");
}

async function readRange(path: string, start: number, end: number) {
  const bytes = Buffer.alloc(end - start);
  const file = await open(path, "r").catch(() => {
    throw new ChapterEventError(500, "原文文件无法读取");
  });
  try {
    let read = 0;
    while (read < bytes.length) {
      const result = await file.read(bytes, read, bytes.length - read, start + read);
      if (result.bytesRead === 0) throw new ChapterEventError(500, "原文文件不完整");
      read += result.bytesRead;
    }
    return bytes;
  } finally {
    await file.close();
  }
}

export async function buildChapterEvidenceAtoms(
  database: DatabaseSync,
  dataRoot: string,
  bookId: string,
  chapterId: string,
) {
  const chapter = database.prepare(
    `SELECT chapters.byte_start, chapters.byte_end, chapters.content_hash,
            books.encoding, books.original_file_path
     FROM chapters JOIN books ON books.id = chapters.book_id
     WHERE books.id = ? AND chapters.id = ?`,
  ).get(bookId, chapterId) as ChapterSourceRow | undefined;
  if (!chapter) throw new ChapterEventError(404, "章节不存在");
  const length = chapter.byte_end - chapter.byte_start;
  if (length > MAX_CHAPTER_BYTES) {
    throw new ChapterEventError(422, `章节超过自动分析上限 ${MAX_CHAPTER_BYTES} 字节，请使用人工事件入口`);
  }
  const root = resolve(dataRoot);
  const path = resolve(root, chapter.original_file_path);
  if (!path.startsWith(`${root}${sep}`)) throw new ChapterEventError(500, "原文路径无效");
  const bytes = await readRange(path, chapter.byte_start, chapter.byte_end);
  if (sha256(bytes) !== chapter.content_hash) throw new ChapterEventError(409, "原文内容已变化，请重新索引");

  const atoms: ChapterEvidenceAtom[] = [];
  let start = 0;
  for (let cursor = 0; cursor <= bytes.length; cursor += 1) {
    if (cursor < bytes.length && bytes[cursor] !== 0x0a) continue;
    let end = cursor;
    if (end > start && bytes[end - 1] === 0x0d) end -= 1;
    const raw = bytes.subarray(start, end);
    if (raw.byteLength > MAX_ATOM_BYTES) {
      throw new ChapterEventError(422, `单段原文超过自动分析上限 ${MAX_ATOM_BYTES} 字节，请使用人工事件入口`);
    }
    if (raw.byteLength > 0) {
      let text: string;
      try { text = new TextDecoder(chapter.encoding.toLowerCase(), { fatal: true }).decode(raw); }
      catch { throw new ChapterEventError(500, "原文编码无效"); }
      if (text.trim()) {
        const byteStart = chapter.byte_start + start;
        const byteEnd = chapter.byte_start + end;
        atoms.push({
          id: `evidence_${sha256(`chapter-evidence-v1\0${chapterId}\0${byteStart}\0${byteEnd}\0${sha256(raw)}`)}`,
          byteStart,
          byteEnd,
          text,
        });
      }
    }
    start = cursor + 1;
  }
  if (atoms.length === 0) throw new ChapterEventError(422, "章节没有可供自动分析的非空原文");
  return { atoms, contentHash: chapter.content_hash };
}

function prompt(atoms: readonly ChapterEvidenceAtom[], promptInstructions?: string) {
  const frozenInput = [
    "你是小说章节结构化事件分析器。只输出严格 JSON，不要输出 Markdown 或解释。",
    "只能引用下面提供的 evidenceId；禁止返回字节偏移。没有可靠事件时返回空 events。",
    "事件类型仅限 character、location、prop、causality、revelation、suspense。",
    "character/location/prop 的 payload 为 {name,detail?}；causality 为 {cause,effect}；revelation 为 {fact}；suspense 为 {question}。",
    "输出格式：{\"events\":[{\"type\":\"character\",\"payload\":{\"name\":\"...\"},\"evidenceIds\":[\"e1\"]}]}。",
    "原文证据段：",
    ...atoms.map((atom) => JSON.stringify({ evidenceId: atom.id, text: atom.text })),
  ].join("\n");
  return promptInstructions === undefined
    ? frozenInput
    : layeredPrompt(PRODUCT_PROMPTS.chapterAnalysis, promptInstructions, frozenInput);
}

type LimitedJsonOptions = {
  protocol?: TextModelStreamStatistics["protocol"];
  signal?: AbortSignal;
  onActivity?: () => void;
  onStatistics?: (statistics: TextModelStreamStatistics) => void;
  onRawText?: (text: string) => void;
};

export async function limitedJson(response: Response, options: LimitedJsonOptions = {}) {
  const protocol = options.protocol ?? "openai-response";
  let total = 0;
  let captured = "";
  let bodyComplete = false;
  const fail = (message: string, cause?: unknown) => new TextModelStreamError(
    message,
    textModelJsonStatistics(response, protocol, total, Buffer.byteLength(captured), bodyComplete),
    captured,
    cause === undefined ? undefined : { cause },
  );
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) {
    await response.body?.cancel();
    throw fail("文本模型 JSON 响应超过大小限制");
  }
  if (!response.body) throw fail("文本模型没有返回 JSON 内容");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        captured = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString("utf8");
        throw fail("文本模型 JSON 响应超过大小限制");
      }
      chunks.push(value);
      if (value.byteLength > 0) options.onActivity?.();
    }
    bodyComplete = true;
  } catch (error) {
    if (error instanceof TextModelStreamError) throw error;
    captured = new TextDecoder("utf-8").decode(Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))));
    const diagnostic = fail("文本模型 JSON 响应读取失败", error);
    if (!options.signal?.aborted) throw diagnostic;
    const reason = options.signal.reason instanceof Error
      ? options.signal.reason
      : new DOMException("aborted", "AbortError");
    const aborted = new DOMException(reason.message, reason.name);
    Object.defineProperty(aborted, "cause", { value: diagnostic, configurable: true });
    throw aborted;
  } finally {
    reader.releaseLock();
  }
  const bytes = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)), total);
  try {
    captured = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    options.onRawText?.(captured);
    const statistics = textModelJsonStatistics(response, protocol, total, 0);
    const result = JSON.parse(captured) as unknown;
    options.onStatistics?.(statistics);
    return result;
  } catch (error) { throw fail("文本模型返回了无效 JSON 响应", error); }
}

export async function limitedResponseText(response: Response, options: LimitedJsonOptions = {}) {
  let statistics: TextModelStreamStatistics | undefined;
  let rawText = "";
  const body = await limitedJson(response, {
    ...options,
    onStatistics: (value) => { statistics = value; options.onStatistics?.(value); },
    onRawText: (value) => { rawText = value; options.onRawText?.(value); },
  });
  try {
    const text = responseText(body);
    if (statistics) {
      statistics = { ...statistics, extractedTextBytes: Buffer.byteLength(text) };
      options.onStatistics?.(statistics);
    }
    return text;
  }
  catch (error) {
    throw new TextModelStreamError(
      error instanceof Error ? error.message : String(error),
      statistics ?? textModelJsonStatistics(response, options.protocol ?? "openai-response",
        Buffer.byteLength(rawText), Buffer.byteLength(rawText)),
      rawText,
      { cause: error },
    );
  }
}

export function responseText(body: unknown) {
  const value = body as {
    output_text?: unknown;
    output?: Array<{ content?: Array<{ text?: unknown }> }>;
    content?: Array<{ text?: unknown }>;
  };
  if (typeof value?.output_text === "string") return value.output_text;
  const content = value?.content?.map((item) => item.text)
    .filter((item): item is string => typeof item === "string");
  if (content?.length) return content.join("");
  const parts = value?.output?.flatMap((item) => item.content ?? [])
    .map((item) => item.text).filter((item): item is string => typeof item === "string");
  if (parts?.length) return parts.join("");
  throw new Error("章节分析模型返回结果缺少文本内容");
}

export function textModelRequest(config: ChapterTextModelConfig, input: string, maxTokens = 8192, stream = false) {
  const anthropic = config.protocol === "anthropic-message";
  const endpoint = new URL(anthropic ? "messages" : "responses", `${config.baseUrl.replace(/\/+$/, "")}/`);
  const headers: Record<string, string> = anthropic
    ? { "x-api-key": config.apiKey, "anthropic-version": "2023-06-01", "content-type": "application/json" }
    : { authorization: `Bearer ${config.apiKey}`, "content-type": "application/json" };
  return {
    endpoint,
    headers,
    body: JSON.stringify(anthropic
      ? { model: config.model, max_tokens: maxTokens, messages: [{ role: "user", content: input }], ...(stream ? { stream: true } : {}) }
      : { model: config.model, input, max_output_tokens: maxTokens, ...(stream ? { stream: true } : {}) }),
  };
}

function modelEvents(value: unknown, atoms: readonly ChapterEvidenceAtom[]): ChapterEventInput[] {
  let body: unknown;
  try { body = JSON.parse(typeof value === "string" ? value : ""); }
  catch { throw new Error("章节分析结果不是严格 JSON"); }
  const events = (body as { events?: unknown })?.events;
  if (!Array.isArray(events) || events.length > 200) throw new Error("章节分析结果事件列表无效");
  const evidence = new Map(atoms.map((atom) => [atom.id, atom]));
  return events.map((raw): ChapterEventInput => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("章节分析结果事件无效");
    const item = raw as { type?: unknown; payload?: unknown; evidenceIds?: unknown };
    if (typeof item.type !== "string" || !EVENT_TYPES.has(item.type)) throw new Error("章节分析结果事件类型无效");
    if (!Array.isArray(item.evidenceIds) || item.evidenceIds.length < 1 || item.evidenceIds.length > 20) {
      throw new ChapterEvidenceReferenceError("章节分析结果必须引用 1～20 条证据");
    }
    const ids = item.evidenceIds.map((id) => {
      if (typeof id !== "string" || !evidence.has(id)) throw new ChapterEvidenceReferenceError("章节分析结果引用了未知证据 ID");
      return id;
    });
    if (new Set(ids).size !== ids.length) throw new ChapterEvidenceReferenceError("章节分析结果重复引用相同证据");
    const type = item.type as ChapterEventType;
    return {
      type,
      payload: item.payload as never,
      sources: ids.map((id) => {
        const atom = evidence.get(id)!;
        return { byteStart: atom.byteStart, byteEnd: atom.byteEnd };
      }),
    } as ChapterEventInput;
  });
}

function assignOccurrences(events: readonly ChapterEventInput[]) {
  const next = new Map<string, number>();
  return events.map((event): ChapterEventInput => {
    const ranges = event.sources.map((source) => `${source.byteStart}:${source.byteEnd}`).join("|");
    const key = `${event.type}\0${ranges}`;
    const occurrence = next.get(key) ?? 0;
    next.set(key, occurrence + 1);
    return { ...event, occurrence } as ChapterEventInput;
  });
}

export function prepareChapterBatchPrompt(chapters: readonly ChapterAnalysisInput[], promptInstructions?: string) {
  const requestChapters = chapters.map((chapter, chapterIndex) => ({
    chapterId: chapter.chapterId,
    atoms: chapter.atoms.map((atom, atomIndex) => ({ ...atom, id: `c${chapterIndex + 1}e${atomIndex + 1}` })),
  }));
  const frozenInput = [
    "你是小说多章节结构化事件分析器。只输出严格 JSON，不要输出 Markdown 或解释。",
    "输出必须逐章覆盖全部且仅覆盖给定 chapterId；每章事件只能引用该章 evidenceId，禁止跨章引用或返回字节偏移。",
    "事件类型仅限 character、location、prop、causality、revelation、suspense。",
    "character/location/prop 的 payload 为 {name,detail?}；causality 为 {cause,effect}；revelation 为 {fact}；suspense 为 {question}。",
    "输出格式：{\"chapters\":[{\"chapterId\":\"chapter-1\",\"events\":[{\"type\":\"character\",\"payload\":{\"name\":\"...\"},\"evidenceIds\":[\"c1e1\"]}]}]}。",
    "章节原文证据：",
    ...requestChapters.flatMap((chapter) => [
      JSON.stringify({ chapterId: chapter.chapterId }),
      ...chapter.atoms.map((atom) => JSON.stringify({ evidenceId: atom.id, text: atom.text })),
    ]),
  ].join("\n");
  const prompt = promptInstructions === undefined
    ? frozenInput
    : layeredPrompt(PRODUCT_PROMPTS.chapterAnalysis, promptInstructions, frozenInput);
  return { chapters: requestChapters, prompt, bytes: Buffer.byteLength(prompt, "utf8") };
}

export function parseChapterBatchAnalysisEvents(
  value: unknown,
  chapters: readonly ChapterAnalysisInput[],
): ChapterBatchAnalysisResult[] {
  let body: unknown;
  try { body = JSON.parse(typeof value === "string" ? value : ""); }
  catch { throw new Error("多章分析结果不是严格 JSON"); }
  const groups = (body as { chapters?: unknown })?.chapters;
  if (!Array.isArray(groups) || groups.length !== chapters.length) {
    throw new Error("多章分析结果章节集合不完整");
  }
  const expected = new Map(chapters.map((chapter) => [chapter.chapterId, chapter]));
  const seen = new Set<string>();
  const result = groups.map((raw): ChapterBatchAnalysisResult => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("多章分析结果章节无效");
    const group = raw as { chapterId?: unknown; events?: unknown };
    if (typeof group.chapterId !== "string" || !expected.has(group.chapterId)) {
      throw new Error("多章分析结果包含未知章节");
    }
    if (seen.has(group.chapterId)) throw new Error("多章分析结果重复包含章节");
    seen.add(group.chapterId);
    return {
      chapterId: group.chapterId,
      events: assignOccurrences(modelEvents(JSON.stringify({ events: group.events }), expected.get(group.chapterId)!.atoms)),
    };
  });
  if (seen.size !== expected.size) throw new Error("多章分析结果章节集合不完整");
  return result;
}

export function createOpenAiResponsesChapterBatchAnalyzer(
  config: ChapterTextModelConfig,
  fetchImpl: typeof fetch = fetch,
): AnalyzeChapterEventsBatch {
  let endpoint: URL;
  try { endpoint = textModelRequest(config, "").endpoint; }
  catch { throw new Error("章节分析模型配置无效"); }
  if (!config.apiKey.trim() || !config.model.trim() || !config.providerId.trim() ||
      (endpoint.protocol !== "http:" && endpoint.protocol !== "https:")) {
    throw new Error("章节分析模型配置无效");
  }
  return async ({ chapters, promptInstructions, signal, onActivity }) => {
    const stage = `chapter-analysis-batch:${chapters.map((chapter) => chapter.chapterId).join(",")}`;
    if (!chapters.length || chapters.length > 20 || new Set(chapters.map((chapter) => chapter.chapterId)).size !== chapters.length) {
      throw new Error("多章分析输入章节集合无效");
    }
    const prepared = prepareChapterBatchPrompt(chapters, promptInstructions);
    if (prepared.bytes > MAX_CHAPTER_BATCH_INPUT_BYTES) {
      throw new Error("多章分析输入超过服务端安全上限");
    }
    const request = textModelRequest(config, prepared.prompt, 32768, true);
    let statistics: TextModelStreamStatistics | undefined;
    let text: string | undefined;
    try {
      text = await textModelConcurrencyGate.run(signal, async () => {
      let response: Response;
      try {
        response = await fetchImpl(request.endpoint, {
          method: "POST", headers: request.headers, body: request.body, signal, redirect: "error",
        });
      } catch (error) {
        if (signal?.aborted) throw error;
        throw new Error("章节分析模型请求失败");
      }
      if (!response.ok) {
        await response.body?.cancel();
        throw new Error(`章节分析模型请求失败（HTTP ${response.status}）`);
      }
      return response.headers.get("content-type")?.toLowerCase().includes("text/event-stream")
        ? streamedText(response, config.protocol ?? "openai-response", {
          signal, onActivity, onStatistics: (value) => { statistics = value; },
        })
        : limitedResponseText(response, {
          protocol: config.protocol ?? "openai-response", signal, onActivity,
          onStatistics: (value) => { statistics = value; },
        });
      });
      return rememberTextModelEvidence(
        parseChapterBatchAnalysisEvents(text, prepared.chapters),
        completedTextModelEvidence(text, statistics),
      );
    } catch (error) {
      const evidence: TextModelCallEvidence = error instanceof TextModelStreamError
        ? { statistics: error.statistics, partialText: error.partialText, partialTextTruncated: error.partialTextTruncated }
        : text === undefined ? {} : completedTextModelEvidence(text, statistics);
      throw textModelCallError(error, stage, evidence);
    }
  };
}

export function createOpenAiResponsesChapterAnalyzer(
  config: ChapterTextModelConfig,
  fetchImpl: typeof fetch = fetch,
): AnalyzeChapterEvents {
  let endpoint: URL;
  try { endpoint = textModelRequest(config, "").endpoint; }
  catch { throw new Error("章节分析模型配置无效"); }
  if (!config.apiKey.trim() || !config.model.trim() || !config.providerId.trim() ||
      (endpoint.protocol !== "http:" && endpoint.protocol !== "https:")) {
    throw new Error("章节分析模型配置无效");
  }
  return async ({ chapterId, atoms, promptInstructions, signal, onActivity }) => {
    const stage = `chapter-analysis:${chapterId}`;
    const requestAtoms = atoms.map((atom, index) => ({ ...atom, id: `e${index + 1}` }));
    const request = textModelRequest(config, prompt(requestAtoms, promptInstructions), 8192, true);
    let statistics: TextModelStreamStatistics | undefined;
    let text: string | undefined;
    try {
      text = await textModelConcurrencyGate.run(signal, async () => {
      let response: Response;
      try {
        response = await fetchImpl(request.endpoint, {
          method: "POST", headers: request.headers, body: request.body, signal, redirect: "error",
        });
      } catch (error) {
        if (signal?.aborted) throw error;
        throw new Error("章节分析模型请求失败");
      }
      if (!response.ok) {
        await response.body?.cancel();
        throw new Error(`章节分析模型请求失败（HTTP ${response.status}）`);
      }
      return response.headers.get("content-type")?.toLowerCase().includes("text/event-stream")
        ? streamedText(response, config.protocol ?? "openai-response", {
          signal, onActivity, onStatistics: (value) => { statistics = value; },
        })
        : limitedResponseText(response, {
          protocol: config.protocol ?? "openai-response", signal, onActivity,
          onStatistics: (value) => { statistics = value; },
        });
      });
      return rememberTextModelEvidence(
        assignOccurrences(modelEvents(text, requestAtoms)),
        completedTextModelEvidence(text, statistics),
      );
    } catch (error) {
      const evidence: TextModelCallEvidence = error instanceof TextModelStreamError
        ? { statistics: error.statistics, partialText: error.partialText, partialTextTruncated: error.partialTextTruncated }
        : text === undefined ? {} : completedTextModelEvidence(text, statistics);
      throw textModelCallError(error, stage, evidence);
    }
  };
}

export const parseChapterAnalysisEvents = modelEvents;
