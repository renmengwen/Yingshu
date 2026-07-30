const MAX_STREAM_TEXT_BYTES = 1024 * 1024;
const MAX_STREAM_EVENT_BYTES = 1024 * 1024;
const MAX_STREAM_LINE_BUFFER_BYTES = 1024 * 1024;
const MAX_STREAM_TRANSPORT_BYTES = 8 * 1024 * 1024;
const MAX_PARTIAL_TEXT_BYTES = 1024 * 1024;

const KNOWN_EVENT_TYPES = new Set<string>([
  "response.created",
  "response.in_progress",
  "response.output_item.added",
  "response.output_item.done",
  "response.content_part.added",
  "response.content_part.done",
  "response.output_text.delta",
  "response.output_text.done",
  "response.refusal.delta",
  "response.refusal.done",
  "response.reasoning_summary_part.added",
  "response.reasoning_summary_part.done",
  "response.reasoning_summary_text.delta",
  "response.reasoning_summary_text.done",
  "response.reasoning_text.delta",
  "response.reasoning_text.done",
  "response.completed",
  "response.failed",
  "response.incomplete",
  "message_start",
  "content_block_start",
  "content_block_delta",
  "content_block_stop",
  "message_delta",
  "message_stop",
  "ping",
  "error",
  "[DONE]",
] as const);

const REQUEST_ID_HEADERS = [
  "anthropic-request-id",
  "cf-ray",
  "openai-request-id",
  "request-id",
  "traceparent",
  "x-amz-request-id",
  "x-amzn-requestid",
  "x-anthropic-request-id",
  "x-openai-request-id",
  "x-request-id",
] as const;

type TextModelProtocol = "openai-response" | "anthropic-message";

export interface TextModelStreamStatistics {
  protocol: TextModelProtocol;
  responseFormat: "sse" | "json";
  rawBytes: number;
  extractedTextBytes: number;
  eventCount: number;
  eventTypes: Readonly<Record<string, number>>;
  lastEventType: string | null;
  terminalReceived: boolean;
  contentType: string | null;
  declaredContentLength: number | null;
  requestIds: Readonly<Record<string, string>>;
}

interface StreamTextOptions {
  signal?: AbortSignal;
  onActivity?: () => void;
  onStatistics?: (statistics: TextModelStreamStatistics) => void;
}

export interface TextModelCallEvidence {
  statistics?: TextModelStreamStatistics;
  partialText?: string;
  partialTextTruncated?: boolean;
}

export class TextModelCallError extends Error {
  readonly stage: string;
  readonly evidence: TextModelCallEvidence;

  constructor(message: string, stage: string, evidence: TextModelCallEvidence = {}, options?: ErrorOptions) {
    super(message, options);
    this.name = "TextModelCallError";
    this.stage = stage;
    this.evidence = evidence;
  }
}

const resultEvidence = new WeakMap<object, TextModelCallEvidence>();

export function completedTextModelEvidence(text: string, statistics?: TextModelStreamStatistics): TextModelCallEvidence {
  const captured = partialText(text);
  return {
    statistics,
    partialText: captured,
    partialTextTruncated: new TextEncoder().encode(captured).byteLength < new TextEncoder().encode(text).byteLength,
  };
}

export function rememberTextModelEvidence<T>(value: T, evidence: TextModelCallEvidence): T {
  if ((typeof value !== "object" || value === null) && typeof value !== "function") {
    throw new TypeError("文本模型 JSON 顶层必须是对象");
  }
  resultEvidence.set(value as object, evidence);
  return value;
}

export function textModelCallError(
  error: unknown,
  stage: string,
  evidence: TextModelCallEvidence = {},
) {
  if (error instanceof TextModelCallError) return error;
  if (!evidence.statistics) {
    const seen = new Set<unknown>();
    let current = error;
    for (let depth = 0; depth < 8 && current && !seen.has(current); depth += 1) {
      if (current instanceof TextModelStreamError) {
        evidence = {
          statistics: current.statistics,
          partialText: current.partialText,
          partialTextTruncated: current.partialTextTruncated,
        };
        break;
      }
      seen.add(current);
      current = current instanceof Error ? current.cause : undefined;
    }
  }
  return new TextModelCallError(
    error instanceof Error ? error.message : String(error),
    stage,
    evidence,
    { cause: error },
  );
}

export function textModelResultError(error: unknown, stage: string, result: object) {
  return textModelCallError(error, stage, resultEvidence.get(result));
}

export class TextModelStreamError extends Error {
  readonly statistics: TextModelStreamStatistics;
  readonly partialText: string;
  readonly partialTextTruncated: boolean;

  constructor(message: string, statistics: TextModelStreamStatistics, partialText: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "TextModelStreamError";
    this.statistics = statistics;
    this.partialText = partialText;
    this.partialTextTruncated = new TextEncoder().encode(partialText).byteLength <
      (statistics.responseFormat === "json" ? statistics.rawBytes : statistics.extractedTextBytes);
  }
}

function partialText(value: string) {
  const bytes = new TextEncoder().encode(value);
  if (bytes.byteLength <= MAX_PARTIAL_TEXT_BYTES) return value;
  const decoder = new TextDecoder("utf-8", { fatal: true });
  for (let end = MAX_PARTIAL_TEXT_BYTES; end > MAX_PARTIAL_TEXT_BYTES - 4; end -= 1) {
    try { return decoder.decode(bytes.slice(0, end)); } catch { /* stop on a complete UTF-8 code point */ }
  }
  return "";
}

function declaredContentLength(headers: Headers) {
  const value = headers.get("content-length");
  if (value === null || !/^\d+$/u.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function safeRequestIds(headers: Headers) {
  return Object.fromEntries(REQUEST_ID_HEADERS.flatMap((name) => {
    const value = headers.get(name)?.trim();
    return value ? [[name, value.slice(0, 256)]] : [];
  }));
}

export function textModelJsonStatistics(
  response: Response,
  protocol: TextModelProtocol,
  rawBytes: number,
  extractedTextBytes: number,
  terminalReceived = true,
): TextModelStreamStatistics {
  return {
    protocol,
    responseFormat: "json",
    rawBytes,
    extractedTextBytes,
    eventCount: 0,
    eventTypes: {},
    lastEventType: null,
    terminalReceived,
    contentType: response.headers.get("content-type"),
    declaredContentLength: declaredContentLength(response.headers),
    requestIds: safeRequestIds(response.headers),
  };
}

function failureDetail(value: Record<string, unknown>, type: string) {
  const response = value.response && typeof value.response === "object" && !Array.isArray(value.response)
    ? value.response as Record<string, unknown> : undefined;
  const nested = response?.error ?? value.error;
  const error = nested && typeof nested === "object" && !Array.isArray(nested)
    ? nested as Record<string, unknown> : undefined;
  const code = [error?.code, error?.type, value.code].find((item) => typeof item === "string");
  const message = [error?.message, value.message].find((item) => typeof item === "string");
  const detail = [code, message].filter(Boolean).join(": ");
  return detail ? `${type}: ${detail}` : `收到失败终态 ${type}`;
}

async function readWithSignal(reader: ReadableStreamDefaultReader<Uint8Array>, signal?: AbortSignal) {
  if (!signal) return reader.read();
  signal.throwIfAborted();
  return new Promise<ReadableStreamReadResult<Uint8Array>>((resolve, reject) => {
    const abort = () => reject(signal.reason ?? new DOMException("aborted", "AbortError"));
    signal.addEventListener("abort", abort, { once: true });
    reader.read().then(
      (value) => { signal.removeEventListener("abort", abort); resolve(value); },
      (error) => { signal.removeEventListener("abort", abort); reject(error); },
    );
  });
}

export async function streamedText(
  response: Response,
  protocol: TextModelProtocol,
  options: StreamTextOptions = {},
) {
  const declared = declaredContentLength(response.headers);
  const contentType = response.headers.get("content-type");
  const requestIds = safeRequestIds(response.headers);
  const eventTypes: Record<string, number> = {};
  let rawBytes = 0;
  let extractedTextBytes = 0;
  let eventCount = 0;
  let lastEventType: string | null = null;
  let terminal = false;
  let text = "";

  const statistics = (): TextModelStreamStatistics => ({
    protocol,
    responseFormat: "sse",
    rawBytes,
    extractedTextBytes,
    eventCount,
    eventTypes: { ...eventTypes },
    lastEventType,
    terminalReceived: terminal,
    contentType,
    declaredContentLength: declared,
    requestIds: { ...requestIds },
  });
  const fail = (message: string, cause?: unknown) => new TextModelStreamError(
    `模型流式响应无效：${message}`,
    statistics(),
    partialText(text),
    cause === undefined ? undefined : { cause },
  );
  const markEvent = (value: string) => {
    const type = KNOWN_EVENT_TYPES.has(value) ? value : "unknown";
    eventCount += 1;
    eventTypes[type] = (eventTypes[type] ?? 0) + 1;
    lastEventType = type;
  };

  if (declared !== null && declared > MAX_STREAM_TRANSPORT_BYTES) {
    await response.body?.cancel();
    throw fail("原始响应超过大小限制");
  }
  if (!response.body) throw fail("没有返回内容");
  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let buffer = "";
  let eventName = "";
  let dataLines: string[] = [];

  const append = (value: string) => {
    text += value;
    extractedTextBytes += new TextEncoder().encode(value).byteLength;
    if (text.length > MAX_STREAM_TEXT_BYTES) throw fail("文本超过大小限制");
  };
  const dispatch = () => {
    if (dataLines.length === 0) {
      eventName = "";
      return;
    }
    const data = dataLines.join("\n");
    dataLines = [];
    const named = eventName;
    eventName = "";
    if (data === "[DONE]") {
      markEvent("[DONE]");
      return;
    }
    let value: Record<string, unknown>;
    try { value = JSON.parse(data) as Record<string, unknown>; }
    catch {
      markEvent(named);
      throw fail("事件不是有效 JSON");
    }
    const type = typeof value.type === "string" ? value.type : named;
    markEvent(type);
    if (protocol === "openai-response") {
      if (type === "response.output_text.delta") {
        if (typeof value.delta !== "string") throw fail("文本增量缺失");
        append(value.delta);
      } else if (type === "response.completed") terminal = true;
      else if (["response.failed", "response.incomplete", "error"].includes(type)) {
        throw fail(failureDetail(value, type));
      }
      return;
    }
    if (type === "content_block_start") {
      const block = value.content_block as { type?: unknown; text?: unknown } | undefined;
      if (block?.type === "text" && typeof block.text === "string") append(block.text);
    } else if (type === "content_block_delta") {
      const delta = value.delta as { type?: unknown; text?: unknown } | undefined;
      if (delta?.type === "text_delta") {
        if (typeof delta.text !== "string") throw fail("文本增量缺失");
        append(delta.text);
      }
    } else if (type === "message_stop") terminal = true;
    else if (type === "error") throw fail(failureDetail(value, type));
  };
  const line = (value: string) => {
    if (value === "") return dispatch();
    if (value.startsWith(":")) return;
    const separator = value.indexOf(":");
    const field = separator < 0 ? value : value.slice(0, separator);
    let fieldValue = separator < 0 ? "" : value.slice(separator + 1);
    if (fieldValue.startsWith(" ")) fieldValue = fieldValue.slice(1);
    if (field === "event") eventName = fieldValue;
    else if (field === "data") {
      dataLines.push(fieldValue);
      if (dataLines.join("\n").length > MAX_STREAM_EVENT_BYTES) throw fail("事件超过大小限制");
    }
  };
  const consumeLines = (eof = false) => {
    let start = 0;
    for (let cursor = 0; cursor < buffer.length; cursor += 1) {
      const character = buffer[cursor];
      if (character !== "\r" && character !== "\n") continue;
      if (character === "\r" && cursor === buffer.length - 1 && !eof) break;
      line(buffer.slice(start, cursor));
      if (character === "\r" && buffer[cursor + 1] === "\n") cursor += 1;
      start = cursor + 1;
    }
    buffer = buffer.slice(start);
    if (buffer.length > MAX_STREAM_LINE_BUFFER_BYTES) throw fail("行缓冲超过大小限制");
    if (eof && buffer) {
      line(buffer);
      buffer = "";
    }
    if (eof) dispatch();
  };

  let result = "";
  try {
    while (!terminal) {
      const { done, value } = await readWithSignal(reader, options.signal);
      if (done) {
        try { buffer += decoder.decode(); }
        catch { throw fail("UTF-8 编码无效"); }
        consumeLines(true);
        break;
      }
      rawBytes += value.byteLength;
      if (rawBytes > MAX_STREAM_TRANSPORT_BYTES) throw fail("原始响应超过大小限制");
      if (value.byteLength > 0) options.onActivity?.();
      try { buffer += decoder.decode(value, { stream: true }); }
      catch { throw fail("UTF-8 编码无效"); }
      consumeLines();
    }
    if (!terminal) throw fail("连接结束前没有明确成功终态");
    result = text;
  } catch (error) {
    if (error instanceof TextModelStreamError) throw error;
    if (options.signal?.aborted) {
      const reason = error instanceof Error ? error : new Error(String(error));
      const aborted = new DOMException(reason.message, reason.name);
      Object.defineProperty(aborted, "cause", { value: fail(reason.message, reason), configurable: true });
      throw aborted;
    }
    const message = error instanceof Error ? error.message : String(error);
    throw new TextModelStreamError(message, statistics(), partialText(text), { cause: error });
  } finally {
    try { await reader.cancel(); } catch { /* fetch abort may already have errored the stream */ }
    reader.releaseLock();
  }
  options.onStatistics?.(statistics());
  return result;
}
