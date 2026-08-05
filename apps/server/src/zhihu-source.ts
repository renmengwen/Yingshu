const ZHIHU_QUESTION_ANSWER_PATH = /^\/question\/(\d{1,32})\/answer\/(\d{1,32})\/?$/u;
const IDENTIFIER = /^\d{1,32}$/u;
const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const DEFAULT_MAX_CONTENT_BYTES = 1024 * 1024;

export type ZhihuSourceFailure =
  | "invalid_url"
  | "authentication_required"
  | "access_denied"
  | "rate_limited"
  | "timeout"
  | "aborted"
  | "response_too_large"
  | "content_too_large"
  | "structure_changed"
  | "request_failed";

export class ZhihuSourceError extends Error {
  constructor(public readonly kind: ZhihuSourceFailure, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ZhihuSourceError";
  }
}

export interface NormalizedZhihuSource {
  questionId: string;
  answerId: string;
  sourceUrl: string;
  canonicalUrl: string;
}

export interface ZhihuAnswer {
  questionId: string;
  answerId: string;
  canonicalUrl: string;
  questionTitle: string;
  content: string;
  imageUrls: string[];
  excerpt: string;
  authorName: string;
  publishedAt: number | null;
  updatedAt: number | null;
  voteupCount: number | null;
  commentCount: number | null;
}

type Fetch = typeof fetch;

export interface ZhihuFetchOptions {
  fetchImpl?: Fetch;
  timeoutMs?: number;
  maxResponseBytes?: number;
  signal?: AbortSignal;
}

export type ZhihuApiRequest =
  | { kind: "answer"; answerId: string }
  | { kind: "root_comments"; answerId: string; limit: number; offset: number }
  | { kind: "child_comments"; commentId: string; limit: number; offset: number };

function requireIdentifier(value: string, label: string) {
  if (!IDENTIFIER.test(value)) throw new ZhihuSourceError("structure_changed", `${label}无效`);
}

export function normalizeZhihuSource(value: string): NormalizedZhihuSource {
  const input = value.trim();
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new ZhihuSourceError("invalid_url", "知乎链接无效");
  }
  const hostname = url.hostname.toLowerCase();
  // URL 会把显式默认端口 :443 归一化为空，因此还需检查原始 authority。
  const authority = input.match(/^https:\/\/([^/?#]+)/iu)?.[1]?.toLowerCase();
  if (url.protocol !== "https:" || (hostname !== "zhihu.com" && hostname !== "www.zhihu.com")
    || (authority !== "zhihu.com" && authority !== "www.zhihu.com") || url.username || url.password || url.port) {
    throw new ZhihuSourceError("invalid_url", "只支持不含凭证和端口的 HTTPS 知乎回答链接");
  }
  const match = url.pathname.match(ZHIHU_QUESTION_ANSWER_PATH);
  if (!match) throw new ZhihuSourceError("invalid_url", "只支持知乎问题下的回答链接");
  const [, questionId, answerId] = match;
  if (!questionId || !answerId) throw new ZhihuSourceError("invalid_url", "知乎问题或回答 ID 无效");
  const canonicalUrl = `https://www.zhihu.com/question/${questionId}/answer/${answerId}`;
  return { questionId, answerId, sourceUrl: canonicalUrl, canonicalUrl };
}

function apiUrl(request: ZhihuApiRequest) {
  const url = new URL("https://www.zhihu.com");
  if (request.kind === "answer") {
    requireIdentifier(request.answerId, "知乎回答 ID");
    url.pathname = `/api/v4/answers/${request.answerId}`;
    url.searchParams.set("include", "content,excerpt,author,question,created_time,updated_time,voteup_count,comment_count");
  } else if (request.kind === "root_comments") {
    requireIdentifier(request.answerId, "知乎回答 ID");
    url.pathname = `/api/v4/answers/${request.answerId}/root_comments`;
    url.searchParams.set("order", "normal");
    url.searchParams.set("limit", String(request.limit));
    url.searchParams.set("offset", String(request.offset));
    url.searchParams.set("status", "open");
  } else {
    requireIdentifier(request.commentId, "知乎评论 ID");
    url.pathname = `/api/v4/comments/${request.commentId}/child_comments`;
    url.searchParams.set("limit", String(request.limit));
    url.searchParams.set("offset", String(request.offset));
  }
  return url;
}

async function readBoundedText(response: Response, maxBytes: number) {
  if (Number(response.headers.get("content-length")) > maxBytes) {
    await response.body?.cancel().catch(() => undefined);
    throw new ZhihuSourceError("response_too_large", "知乎 API 响应超过大小限制");
  }
  if (!response.body) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let size = 0;
  let text = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) throw new ZhihuSourceError("response_too_large", "知乎 API 响应超过大小限制");
      text += decoder.decode(value, { stream: true });
    }
    return text + decoder.decode();
  } finally {
    if (size > maxBytes) await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

/** 只接受受控请求种类，调用方不能把用户输入改造成任意 API 地址。 */
export async function fetchZhihuApiJson(request: ZhihuApiRequest, options: ZhihuFetchOptions = {}): Promise<unknown> {
  const timeoutMs = Math.min(Math.max(options.timeoutMs ?? DEFAULT_TIMEOUT_MS, 100), 60_000);
  const maxBytes = Math.min(Math.max(options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES, 1_024), 8 * 1024 * 1024);
  if (options.signal?.aborted) throw new ZhihuSourceError("aborted", "知乎 API 请求已中断");
  const controller = new AbortController();
  let timedOut = false;
  const abort = () => controller.abort(options.signal?.reason);
  options.signal?.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
  try {
    let response: Response;
    try {
      response = await (options.fetchImpl ?? fetch)(apiUrl(request), {
        method: "GET",
        redirect: "error",
        signal: controller.signal,
        headers: {
          accept: "application/json",
          "accept-language": "zh-CN,zh;q=0.9,en;q=0.8",
          "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124 Safari/537.36",
        },
      });
    } catch (error) {
      if (timedOut) throw new ZhihuSourceError("timeout", "知乎 API 请求超时", { cause: error });
      if (controller.signal.aborted) throw new ZhihuSourceError("aborted", "知乎 API 请求已中断", { cause: error });
      throw new ZhihuSourceError("request_failed", "知乎 API 请求失败", { cause: error });
    }
    if (!response.ok) await response.body?.cancel().catch(() => undefined);
    if (response.status === 401) throw new ZhihuSourceError("authentication_required", "知乎要求登录后访问");
    if (response.status === 403) throw new ZhihuSourceError("access_denied", "知乎拒绝访问该内容");
    if (response.status === 429) throw new ZhihuSourceError("rate_limited", "知乎请求过于频繁，请稍后重试");
    if (!response.ok) throw new ZhihuSourceError("request_failed", `知乎 API HTTP ${response.status}`);
    let text: string;
    try {
      text = await readBoundedText(response, maxBytes);
    } catch (error) {
      if (error instanceof ZhihuSourceError) throw error;
      if (timedOut) throw new ZhihuSourceError("timeout", "知乎 API 响应读取超时", { cause: error });
      if (controller.signal.aborted) throw new ZhihuSourceError("aborted", "知乎 API 响应读取已中断", { cause: error });
      throw new ZhihuSourceError("request_failed", "知乎 API 响应读取失败", { cause: error });
    }
    try { return JSON.parse(text); }
    catch (error) { throw new ZhihuSourceError("structure_changed", "知乎 API 返回了非 JSON 内容", { cause: error }); }
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", abort);
  }
}

const ENTITY = /&(#(?:x[0-9a-f]+|\d+)|amp|lt|gt|quot|apos|nbsp);/giu;

function decodeHtmlEntities(value: string) {
  return value.replace(ENTITY, (entity, name: string) => {
    const lower = name.toLowerCase();
    if (lower === "amp") return "&";
    if (lower === "lt") return "<";
    if (lower === "gt") return ">";
    if (lower === "quot") return "\"";
    if (lower === "apos") return "'";
    if (lower === "nbsp") return " ";
    const codePoint = lower.startsWith("#x") ? Number.parseInt(lower.slice(2), 16) : Number.parseInt(lower.slice(1), 10);
    return Number.isSafeInteger(codePoint) && codePoint >= 0 && codePoint <= 0x10ffff
      ? String.fromCodePoint(codePoint) : entity;
  });
}

function imageUrlFromTag(tag: string) {
  for (const attribute of ["data-original", "data-actualsrc", "src"]) {
    const raw = tag.match(new RegExp(`\\s${attribute}\\s*=\\s*(["'])(.*?)\\1`, "iu"))?.[2];
    if (!raw) continue;
    try {
      const url = new URL(decodeHtmlEntities(raw));
      if (url.protocol === "https:" && /(^|\.)zhimg\.com$/iu.test(url.hostname)) return url.href;
    } catch { /* 忽略非 HTTPS 或无效图片地址。 */ }
  }
  return null;
}

export function extractZhihuImageUrls(value: unknown) {
  if (typeof value !== "string") return [];
  const urls: string[] = [];
  for (const match of value.matchAll(/<img\b[^>]*>/giu)) {
    const url = imageUrlFromTag(match[0]);
    if (url && !urls.includes(url)) urls.push(url);
  }
  return urls;
}

/** 删除不可见内容与标签后再解码实体，结果不会把 HTML 当作可执行内容向下游传递。 */
export function zhihuHtmlToText(value: unknown) {
  if (typeof value !== "string") return "";
  const seenImages = new Set<string>();
  return decodeHtmlEntities(value
    .replace(/<(script|style|svg)\b[^>]*>[\s\S]*?<\/\1\s*>/giu, " ")
    .replace(/<img\b[^>]*>/giu, (tag) => {
      const url = imageUrlFromTag(tag);
      if (!url || seenImages.has(url)) return " ";
      seenImages.add(url);
      return `\n![知乎回答图片 ${seenImages.size}](${url})\n`;
    })
    .replace(/<\/?noscript\b[^>]*>/giu, " ")
    .replace(/<br\s*\/?\s*>/giu, "\n")
    .replace(/<\/(?:p|div|h[1-6]|li|blockquote|pre)\s*>/giu, "\n")
    .replace(/<[^>]*>/gu, " "))
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/gu, " ")
    .replace(/[ \t\f\v]+/gu, " ")
    .replace(/ *\n */gu, "\n")
    .replace(/\n{3,}/gu, "\n\n")
    .trim();
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function integer(value: unknown) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? Math.round(number) : null;
}

function id(value: unknown) {
  const text = typeof value === "string" || typeof value === "number" ? String(value) : "";
  return IDENTIFIER.test(text) ? text : "";
}

export async function fetchZhihuAnswer(source: NormalizedZhihuSource, options: ZhihuFetchOptions & {
  maxContentBytes?: number;
} = {}): Promise<ZhihuAnswer> {
  requireIdentifier(source.questionId, "知乎问题 ID");
  requireIdentifier(source.answerId, "知乎回答 ID");
  const raw = record(await fetchZhihuApiJson({ kind: "answer", answerId: source.answerId }, options));
  const question = record(raw?.question);
  if (!raw || id(raw.id) !== source.answerId || id(question?.id) !== source.questionId
    || typeof raw.content !== "string" || typeof question?.title !== "string") {
    throw new ZhihuSourceError("structure_changed", "知乎回答结构或问题/回答 ID 不匹配");
  }
  const maxContentBytes = Math.min(Math.max(options.maxContentBytes ?? DEFAULT_MAX_CONTENT_BYTES, 1_024), 4 * 1024 * 1024);
  if (Buffer.byteLength(raw.content, "utf8") > maxContentBytes) {
    throw new ZhihuSourceError("content_too_large", "知乎回答正文超过大小限制");
  }
  const author = record(raw.author);
  const content = zhihuHtmlToText(raw.content);
  const imageUrls = extractZhihuImageUrls(raw.content);
  if (!content) throw new ZhihuSourceError("structure_changed", "知乎回答正文为空或结构已变化");
  return {
    questionId: source.questionId,
    answerId: source.answerId,
    canonicalUrl: `https://www.zhihu.com/question/${source.questionId}/answer/${source.answerId}`,
    questionTitle: zhihuHtmlToText(question.title),
    content,
    imageUrls,
    excerpt: zhihuHtmlToText(raw.excerpt),
    authorName: zhihuHtmlToText(author?.name),
    publishedAt: integer(raw.created_time),
    updatedAt: integer(raw.updated_time),
    voteupCount: integer(raw.voteup_count),
    commentCount: integer(raw.comment_count),
  };
}
