import { lookup } from "node:dns/promises";
import { request as httpRequest, type IncomingHttpHeaders } from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";

import { getImageOutputProfile, type AspectRatio } from "./video-output-profile.js";

export const IMAGE_GENERATION_SIZE = getImageOutputProfile("9:16").size;
export const MAX_IMAGE_BYTES = 30 * 1024 * 1024;
export const MAX_GENERATION_RESPONSE_BYTES = Math.ceil(MAX_IMAGE_BYTES / 3) * 4 + 1024 * 1024;

export interface OpenAiImageConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  providerId: string;
}

export interface GeneratedImage {
  bytes: Uint8Array;
  revisedPrompt?: string;
  providerRequestId?: string;
}

export interface BoundHttpResponse {
  statusCode: number;
  headers: IncomingHttpHeaders;
  body: AsyncIterable<Uint8Array>;
  cancel(): void;
}

export type BoundHttpRequest = (
  url: URL,
  address: string,
  signal?: AbortSignal,
) => Promise<BoundHttpResponse>;

export interface GenerateImageInput {
  prompt: string;
  negativePrompt?: string;
  config: OpenAiImageConfig;
  aspectRatio?: AspectRatio;
  size?: string;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
  lookupImpl?: typeof lookup;
  requestImpl?: BoundHttpRequest;
}

function blockedIpv4(address: string) {
  const octets = address.split(".").map(Number);
  const a = octets[0] ?? 0;
  const b = octets[1] ?? 0;
  return a === 0 || a === 10 || a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 0) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||
    a >= 224;
}

function blockedAddress(address: string) {
  const normalized = address.toLowerCase().split("%", 1)[0] ?? "";
  if (isIP(normalized) === 4) return blockedIpv4(normalized);
  if (isIP(normalized) !== 6) return true;
  const mapped = normalized.match(/::ffff:(\d+\.\d+\.\d+\.\d+)$/)?.[1];
  if (mapped) return blockedIpv4(mapped);
  return normalized === "::" || normalized === "::1" ||
    normalized.startsWith("fc") || normalized.startsWith("fd") ||
    /^fe[89ab]/.test(normalized) || normalized.startsWith("ff") ||
    normalized.startsWith("2001:db8:") || !/^[23]/.test(normalized);
}

async function resolvePublicAddress(url: URL, lookupImpl: typeof lookup) {
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("图片地址协议不安全");
  const hostname = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (hostname === "localhost" || hostname.endsWith(".localhost")) {
    throw new Error("图片地址指向本机或私有网络");
  }
  const literal = isIP(hostname);
  const addresses = literal ? [{ address: hostname }] : await lookupImpl(hostname, { all: true, verbatim: true });
  if (addresses.length === 0 || addresses.some(({ address }) => blockedAddress(address))) {
    throw new Error("图片地址指向本机或私有网络");
  }
  return addresses[0]!.address;
}

async function limitedFetchBody(response: Response, limit: number, label: string) {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > limit) {
    await response.body?.cancel();
    throw new Error(`${label}响应超过大小限制`);
  }
  if (!response.body) throw new Error(`${label}响应没有内容`);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > limit) {
        await reader.cancel();
        throw new Error(`${label}响应超过大小限制`);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  if (total === 0) throw new Error(`${label}响应没有内容`);
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return bytes;
}

function boundRequest(url: URL, address: string, signal?: AbortSignal): Promise<BoundHttpResponse> {
  return new Promise((resolve, reject) => {
    const request = (url.protocol === "https:" ? httpsRequest : httpRequest)({
      protocol: url.protocol,
      hostname: address,
      family: isIP(address),
      port: url.port || undefined,
      path: `${url.pathname}${url.search}`,
      method: "GET",
      headers: { host: url.host },
      ...(url.protocol === "https:" ? { servername: url.hostname.replace(/^\[|\]$/g, "") } : {}),
      signal,
    }, (response) => resolve({
      statusCode: response.statusCode ?? 0,
      headers: response.headers,
      body: response,
      cancel: () => response.destroy(),
    }));
    request.once("error", reject);
    request.end();
  });
}

async function limitedHttpBody(response: BoundHttpResponse) {
  const declared = Number(response.headers["content-length"]);
  if (Number.isFinite(declared) && declared > MAX_IMAGE_BYTES) {
    response.cancel();
    throw new Error("图片超过 30 MiB 限制");
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  for await (const chunk of response.body) {
    total += chunk.byteLength;
    if (total > MAX_IMAGE_BYTES) {
      response.cancel();
      throw new Error("图片超过 30 MiB 限制");
    }
    chunks.push(chunk);
  }
  if (total === 0) throw new Error("图片响应没有内容");
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return bytes;
}

async function downloadImage(
  initialUrl: string,
  signal: AbortSignal | undefined,
  lookupImpl: typeof lookup,
  requestImpl: BoundHttpRequest,
) {
  let url: URL;
  try { url = new URL(initialUrl); } catch { throw new Error("图片地址无效"); }
  for (let redirects = 0; ; redirects += 1) {
    const address = await resolvePublicAddress(url, lookupImpl);
    const response = await requestImpl(url, address, signal);
    if (response.statusCode >= 300 && response.statusCode < 400) {
      response.cancel();
      if (redirects >= 5) throw new Error("图片重定向次数超过 5 次");
      const location = Array.isArray(response.headers.location) ? response.headers.location[0] : response.headers.location;
      if (!location) throw new Error("图片重定向缺少目标地址");
      try { url = new URL(location, url); } catch { throw new Error("图片重定向地址无效"); }
      continue;
    }
    if (response.statusCode < 200 || response.statusCode >= 300) {
      response.cancel();
      throw new Error(`图片下载失败（HTTP ${response.statusCode}）`);
    }
    return limitedHttpBody(response);
  }
}

function decodeBase64(value: string) {
  const compact = value.replace(/\s/g, "");
  if (!compact || !/^[A-Za-z0-9+/]*={0,2}$/.test(compact) || compact.length % 4 !== 0) {
    throw new Error("模型返回了无效的 base64 图片");
  }
  if ((compact.length / 4) * 3 > MAX_IMAGE_BYTES + 2) throw new Error("图片超过 30 MiB 限制");
  const bytes = Buffer.from(compact, "base64");
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_IMAGE_BYTES) throw new Error("图片超过 30 MiB 限制");
  return bytes;
}

export async function generateOpenAiImage(input: GenerateImageInput): Promise<GeneratedImage> {
  const negativePrompt = input.negativePrompt?.trim();
  const prompt = `${input.prompt.trim()}${negativePrompt ? `\n\n【严格禁止】画面中不得出现以下内容：${negativePrompt}` : ""}`;
  const { baseUrl, apiKey, model } = input.config;
  if (!prompt || !baseUrl.trim() || !apiKey.trim() || !model.trim()) throw new Error("图片模型配置或提示词不完整");
  const fetchImpl = input.fetchImpl ?? fetch;
  const lookupImpl = input.lookupImpl ?? lookup;
  const requestImpl = input.requestImpl ?? boundRequest;
  const size = input.size?.trim() || IMAGE_GENERATION_SIZE;
  let endpoint: URL;
  try { endpoint = new URL("images/generations", `${baseUrl.replace(/\/+$/, "")}/`); }
  catch { throw new Error("图片模型地址无效"); }
  if (endpoint.protocol !== "http:" && endpoint.protocol !== "https:") throw new Error("图片模型地址协议无效");

  let response: Response;
  try {
    response = await fetchImpl(endpoint, {
      method: "POST",
      headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({ model, prompt, size, watermark: false, response_format: "url" }),
      signal: input.signal,
      redirect: "error",
    });
  } catch (error) {
    if (input.signal?.aborted) throw error;
    throw new Error("图片模型请求失败");
  }
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`图片模型请求失败（HTTP ${response.status}）`);
  }
  let body: unknown;
  try {
    const bytes = await limitedFetchBody(response, MAX_GENERATION_RESPONSE_BYTES, "图片模型");
    body = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch (error) {
    if (error instanceof Error && error.message.includes("超过大小限制")) throw error;
    throw new Error("图片模型返回了无效 JSON");
  }
  const result = body as { id?: unknown; request_id?: unknown; data?: Array<{ url?: unknown; b64_json?: unknown; revised_prompt?: unknown }> };
  const item = result?.data?.[0];
  if (!item) throw new Error("图片模型没有返回图片");
  let bytes: Uint8Array;
  if (typeof item.b64_json === "string") bytes = decodeBase64(item.b64_json);
  else if (typeof item.url === "string") {
    try {
      bytes = await downloadImage(item.url, input.signal, lookupImpl, requestImpl);
    } catch (error) {
      if (input.signal?.aborted) throw error;
      if (error instanceof Error && /^图片(?:地址|响应|超过|下载失败|重定向)/.test(error.message)) throw error;
      throw new Error("图片下载失败");
    }
  } else throw new Error("图片模型返回格式不受支持");
  const requestId = [result.id, result.request_id, response.headers.get("x-request-id"), response.headers.get("request-id")]
    .find((value) => typeof value === "string" && value.trim().length > 0 && value.trim().length <= 255);
  return {
    bytes,
    ...(typeof item.revised_prompt === "string" ? { revisedPrompt: item.revised_prompt } : {}),
    ...(typeof requestId === "string" ? { providerRequestId: requestId.trim() } : {}),
  };
}
