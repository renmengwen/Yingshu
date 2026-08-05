import { createHash } from "node:crypto";

export type ZhihuImageMime = "image/jpeg" | "image/png" | "image/webp";

export type ZhihuImageEvidence = Readonly<{
  base64: string;
  sha256: string;
  mime: ZhihuImageMime;
  sourceUrl: string;
}>;

export type FetchZhihuImageEvidenceOptions = Readonly<{
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
  timeoutMs?: number;
  maxRedirects?: number;
  maxResponses?: number;
  maxImages?: number;
  maxImageBytes?: number;
  maxTotalBytes?: number;
}>;

const DEFAULTS = Object.freeze({
  timeoutMs: 10_000,
  maxRedirects: 4,
  maxResponses: 24,
  maxImages: 8,
  maxImageBytes: 8 * 1024 * 1024,
  maxTotalBytes: 24 * 1024 * 1024,
});

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${name} 必须是正整数`);
  }
  return value;
}

export function assertAllowedZhihuImageUrl(value: string | URL): URL {
  const url = new URL(value);
  const hostname = url.hostname.toLowerCase();
  if (
    url.protocol !== "https:" ||
    (url.port !== "" && url.port !== "443") ||
    url.username !== "" ||
    url.password !== "" ||
    (hostname !== "zhimg.com" && !hostname.endsWith(".zhimg.com"))
  ) {
    throw new Error("知乎图片地址必须是受控 zhimg HTTPS 地址");
  }
  url.hash = "";
  return url;
}

function normalizeContentType(value: string | null): ZhihuImageMime | null {
  const mime = value?.split(";", 1)[0]?.trim().toLowerCase();
  return mime === "image/jpeg" || mime === "image/png" || mime === "image/webp" ? mime : null;
}

function detectImageMime(bytes: Uint8Array): ZhihuImageMime | null {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "image/jpeg";
  }
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  ) {
    return "image/png";
  }
  if (
    bytes.length >= 12 &&
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  ) {
    return "image/webp";
  }
  return null;
}

async function readLimitedBody(response: Response, limit: number): Promise<Buffer> {
  const declaredLength = response.headers.get("content-length");
  if (declaredLength !== null) {
    const parsedLength = Number(declaredLength);
    if (!Number.isSafeInteger(parsedLength) || parsedLength < 0 || parsedLength > limit) {
      throw new Error("知乎图片响应体积无效或超过限制");
    }
  }
  if (!response.body) {
    throw new Error("知乎图片响应缺少内容");
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) {
        await reader.cancel();
        throw new Error("知乎图片响应超过体积限制");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength)), size);
}

export async function fetchZhihuImageEvidence(
  sourceUrls: readonly (string | URL)[],
  options: FetchZhihuImageEvidenceOptions = {},
): Promise<readonly ZhihuImageEvidence[]> {
  const timeoutMs = positiveInteger(options.timeoutMs ?? DEFAULTS.timeoutMs, "timeoutMs");
  const maxRedirects = positiveInteger(options.maxRedirects ?? DEFAULTS.maxRedirects, "maxRedirects");
  const maxResponses = positiveInteger(options.maxResponses ?? DEFAULTS.maxResponses, "maxResponses");
  const maxImages = positiveInteger(options.maxImages ?? DEFAULTS.maxImages, "maxImages");
  const maxImageBytes = positiveInteger(options.maxImageBytes ?? DEFAULTS.maxImageBytes, "maxImageBytes");
  const maxTotalBytes = positiveInteger(options.maxTotalBytes ?? DEFAULTS.maxTotalBytes, "maxTotalBytes");
  if (sourceUrls.length > maxImages) throw new Error("知乎图片数量超过限制");

  const controller = new AbortController();
  const abortFromCaller = () => controller.abort(options.signal?.reason);
  options.signal?.addEventListener("abort", abortFromCaller, { once: true });
  if (options.signal?.aborted) abortFromCaller();
  const timer = setTimeout(() => controller.abort(new Error("知乎图片抓取超时")), timeoutMs);

  let responseCount = 0;
  let totalBytes = 0;
  const evidence: ZhihuImageEvidence[] = [];
  try {
    for (const sourceUrl of sourceUrls) {
      let currentUrl = assertAllowedZhihuImageUrl(sourceUrl);
      let response: Response | undefined;
      for (let redirects = 0; ; redirects += 1) {
        if (++responseCount > maxResponses) throw new Error("知乎图片响应数量超过限制");
        response = await (options.fetchImpl ?? fetch)(currentUrl, {
          method: "GET",
          redirect: "manual",
          signal: controller.signal,
          headers: { accept: "image/avif,image/webp,image/png,image/jpeg" },
        });
        if (response.status < 300 || response.status >= 400) break;
        await response.body?.cancel();
        const location = response.headers.get("location");
        if (!location || redirects >= maxRedirects) throw new Error("知乎图片重定向无效或超过限制");
        currentUrl = assertAllowedZhihuImageUrl(new URL(location, currentUrl));
      }

      if (!response.ok) {
        await response.body?.cancel();
        throw new Error(`知乎图片请求失败（HTTP ${response.status}）`);
      }
      const headerMime = normalizeContentType(response.headers.get("content-type"));
      if (!headerMime) {
        await response.body?.cancel();
        throw new Error("知乎图片 Content-Type 不受支持");
      }
      const remainingBytes = maxTotalBytes - totalBytes;
      if (remainingBytes <= 0) throw new Error("知乎图片总量超过限制");
      const bytes = await readLimitedBody(response, Math.min(maxImageBytes, remainingBytes));
      const detectedMime = detectImageMime(bytes);
      if (!detectedMime || detectedMime !== headerMime) {
        throw new Error("知乎图片内容签名与 Content-Type 不一致");
      }
      totalBytes += bytes.byteLength;
      evidence.push(Object.freeze({
        base64: bytes.toString("base64"),
        sha256: createHash("sha256").update(bytes).digest("hex"),
        mime: detectedMime,
        sourceUrl: currentUrl.href,
      }));
    }
    return Object.freeze(evidence);
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", abortFromCaller);
  }
}
