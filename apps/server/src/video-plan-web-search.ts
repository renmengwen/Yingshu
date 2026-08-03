import type { ChapterTextModelConfig } from "./chapter-event-analyzer.js";
import { textModelConcurrencyGate } from "./text-model-concurrency.js";

export interface VideoPlanSearchResult {
  title: string;
  url: string;
  summary: string;
}

export type SearchVideoPlanWeb = (input: {
  query: string;
  limit?: number;
  signal?: AbortSignal;
}) => Promise<VideoPlanSearchResult[]>;

const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;

function object(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function text(value: unknown) {
  return typeof value === "string" ? value.replace(/\s+/gu, " ").trim() : "";
}

function source(value: unknown, fallbackSummary = ""): VideoPlanSearchResult | null {
  const row = object(value);
  const urlValue = text(row?.url);
  try {
    const url = new URL(urlValue);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return { title: text(row?.title) || text(row?.document_title) || url.hostname, url: url.href,
      summary: text(row?.snippet) || text(row?.cited_text) || text(fallbackSummary) };
  } catch { return null; }
}

function unique(results: VideoPlanSearchResult[], limit: number) {
  const byUrl = new Map<string, VideoPlanSearchResult>();
  for (const item of results) {
    const previous = byUrl.get(item.url);
    byUrl.set(item.url, previous
      ? { title: previous.title || item.title, url: item.url, summary: previous.summary || item.summary }
      : item);
  }
  return [...byUrl.values()].slice(0, limit);
}

export function parseOpenAiWebSources(value: unknown, limit = 5) {
  const output = object(value)?.output;
  if (!Array.isArray(output)) return [];
  const results: VideoPlanSearchResult[] = [];
  for (const itemValue of output) {
    const item = object(itemValue);
    const actionSources = object(item?.action)?.sources;
    if (Array.isArray(actionSources)) for (const value of actionSources) {
      const parsed = source(value);
      if (parsed) results.push(parsed);
    }
    if (!Array.isArray(item?.content)) continue;
    for (const partValue of item.content) {
      const part = object(partValue);
      const outputText = text(part?.text);
      if (!Array.isArray(part?.annotations)) continue;
      for (const annotationValue of part.annotations) {
        const annotation = object(annotationValue);
        const start = typeof annotation?.start_index === "number" ? annotation.start_index : -1;
        const end = typeof annotation?.end_index === "number" ? annotation.end_index : -1;
        const excerpt = start >= 0 && end > start ? outputText.slice(start, end) : outputText;
        const parsed = source(annotation, excerpt);
        if (parsed) results.push(parsed);
      }
    }
  }
  return unique(results, limit);
}

export function parseAnthropicWebSources(value: unknown, limit = 5) {
  const content = object(value)?.content;
  if (!Array.isArray(content)) return [];
  const results: VideoPlanSearchResult[] = [];
  for (const blockValue of content) {
    const block = object(blockValue);
    if (block?.type === "web_search_tool_result" && Array.isArray(block.content)) {
      for (const result of block.content) {
        const parsed = source(result);
        if (parsed) results.push(parsed);
      }
    }
    if (block?.type === "text" && Array.isArray(block.citations)) {
      for (const citation of block.citations) {
        const parsed = source(citation, text(block.text));
        if (parsed) results.push(parsed);
      }
    }
  }
  return unique(results, limit);
}

async function responseJson(response: Response) {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) throw new Error("联网搜索响应超过大小限制");
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > MAX_RESPONSE_BYTES) throw new Error("联网搜索响应超过大小限制");
  try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown; }
  catch { throw new Error("联网搜索返回了无效 JSON"); }
}

export function createVideoPlanWebSearch(config: ChapterTextModelConfig, fetchImpl: typeof fetch = fetch): SearchVideoPlanWeb {
  return async ({ query, limit = 5, signal }) => {
    const normalized = query.trim();
    if (!normalized) throw new Error("联网搜索主题为空");
    const anthropic = config.protocol === "anthropic-message";
    const endpoint = new URL(anthropic ? "messages" : "responses", `${config.baseUrl.replace(/\/+$/u, "")}/`);
    const body = anthropic
      ? { model: config.model, max_tokens: 2_000, messages: [{ role: "user", content: `搜索并核验这个主题：${normalized}` }],
          tools: [{ type: "web_search_20250305", name: "web_search", max_uses: limit }] }
      : { model: config.model, input: `搜索并核验这个主题：${normalized}`, tools: [{ type: "web_search" }],
          tool_choice: "auto", max_output_tokens: 2_000 };
    const requestSignal = AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(180_000)]);
    return textModelConcurrencyGate.run(requestSignal, async () => {
      const response = await fetchImpl(endpoint, {
        method: "POST",
        redirect: "error",
        headers: anthropic
          ? { "x-api-key": config.apiKey, "anthropic-version": "2023-06-01", "content-type": "application/json" }
          : { authorization: `Bearer ${config.apiKey}`, "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: requestSignal,
      });
      if (!response.ok) { await response.body?.cancel(); throw new Error(`文本模型联网搜索失败（HTTP ${response.status}）`); }
      const value = await responseJson(response);
      const results = anthropic ? parseAnthropicWebSources(value, limit) : parseOpenAiWebSources(value, limit);
      if (!results.length) throw new Error("文本模型完成了联网请求，但没有返回可核验的来源 URL");
      return results;
    });
  };
}
