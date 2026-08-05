/**
 * 抖音来源最小接入链，迁移自 MuseDock 的 creativeContext.js 与 scraper/douyin.js。
 * 实质修改：TypeScript/ESM、逐跳域名校验、随机 CDP 端口、受控 dataRoot Cookie，移除搜索和作者批量能力。
 */
import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";

import { chromium, type Browser, type BrowserContext, type Cookie, type Page } from "playwright-core";

const AWEME_ID = /^\d{5,32}$/;
const URL_IN_TEXT = /https?:\/\/[^\s<>"'`()\[\]{}，。；;、（）《》【】「」『』“”‘’]+/giu;
const TRAILING_PUNCTUATION = /[.,;:!?，。；：！？、)\]}）】》」』”’]+$/u;
const DOUYIN_HOST = /(^|\.)(douyin\.com|iesdouyin\.com)$/i;
const REDIRECT_STATUS = new Set([301, 302, 303, 307, 308]);
const DEFAULT_SINGLE_TIMEOUT_MS = 8_000;
const DEFAULT_TOTAL_TIMEOUT_MS = 20_000;
const DEFAULT_MAX_REDIRECTS = 5;
const DOUYIN_SESSION_ENDPOINTS = new Set([
  "/aweme/v1/web/aweme/detail/",
  "/aweme/v1/web/comment/list/",
  "/aweme/v1/web/comment/list/reply/",
]);

export type DouyinSourceFailure =
  | "need_login"
  | "need_verify"
  | "platform_blocked"
  | "timeout"
  | "parse_failed";

export class DouyinSourceError extends Error {
  constructor(public readonly kind: DouyinSourceFailure, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "DouyinSourceError";
  }
}

export interface NormalizedDouyinSource {
  awemeId: string;
  sourceUrl: string;
  canonicalUrl: string;
}

export interface DouyinVideoDetail {
  awemeId: string;
  canonicalUrl: string;
  title: string;
  description: string;
  author: { id: string; secUid: string; nickname: string };
  publishedAt: number | null;
  durationMs: number | null;
  statistics: { likes: number | null; comments: number | null; collects: number | null; shares: number | null };
  coverUrl: string | null;
  videoDownloadUrl: string | null;
  audioDownloadUrl: string | null;
}

type Fetch = typeof fetch;

function ensureDouyinUrl(value: string) {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new DouyinSourceError("parse_failed", "抖音链接无效");
  }
  if ((url.protocol !== "https:" && url.protocol !== "http:") || !DOUYIN_HOST.test(url.hostname)) {
    throw new DouyinSourceError("parse_failed", "只支持 HTTP(S) 抖音链接");
  }
  url.hash = "";
  return url;
}

function extractUrls(sourceText: string) {
  return [...sourceText.matchAll(URL_IN_TEXT)]
    .map((match) => match[0].replace(TRAILING_PUNCTUATION, ""))
    .filter(Boolean);
}

export function extractDouyinAwemeId(sourceText: string) {
  const text = sourceText.trim();
  if (AWEME_ID.test(text)) return text;
  for (const candidate of extractUrls(text)) {
    let url: URL;
    try {
      url = ensureDouyinUrl(candidate);
    } catch {
      continue;
    }
    const pathId = url.pathname.match(/\/video\/(\d{5,32})(?:\/|$)/u)?.[1];
    const queryId = url.searchParams.get("modal_id") ?? url.searchParams.get("aweme_id")
      ?? url.searchParams.get("item_id");
    if (pathId && AWEME_ID.test(pathId)) return pathId;
    if (queryId && AWEME_ID.test(queryId)) return queryId;
  }
  return null;
}

function firstDouyinUrl(sourceText: string) {
  for (const candidate of extractUrls(sourceText)) {
    try {
      return ensureDouyinUrl(candidate);
    } catch {
      // 分享文案可能包含其他链接，只选择抖音域名。
    }
  }
  throw new DouyinSourceError("parse_failed", "分享文案中未找到抖音视频链接");
}

async function fetchManual(fetchImpl: Fetch, url: URL, timeoutMs: number, totalSignal: AbortSignal) {
  const controller = new AbortController();
  const abort = () => controller.abort(totalSignal.reason);
  totalSignal.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(() => controller.abort(new Error("single redirect timeout")), timeoutMs);
  try {
    return await fetchImpl(url, {
      method: "GET",
      redirect: "manual",
      signal: controller.signal,
      headers: { "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124 Safari/537.36" },
    });
  } catch (error) {
    if (controller.signal.aborted) throw new DouyinSourceError("timeout", "解析抖音链接超时", { cause: error });
    throw new DouyinSourceError("platform_blocked", "抖音链接请求被平台阻断", { cause: error });
  } finally {
    clearTimeout(timer);
    totalSignal.removeEventListener("abort", abort);
  }
}

export async function resolveDouyinSource(sourceText: string, options: {
  fetchImpl?: Fetch;
  singleTimeoutMs?: number;
  totalTimeoutMs?: number;
  maxRedirects?: number;
} = {}): Promise<NormalizedDouyinSource> {
  const directId = extractDouyinAwemeId(sourceText);
  if (directId && AWEME_ID.test(sourceText.trim())) {
    const canonicalUrl = `https://www.douyin.com/video/${directId}`;
    return { awemeId: directId, sourceUrl: canonicalUrl, canonicalUrl };
  }
  let current = firstDouyinUrl(sourceText);
  if (directId) {
    return { awemeId: directId, sourceUrl: current.href, canonicalUrl: `https://www.douyin.com/video/${directId}` };
  }
  if (current.hostname.toLowerCase() !== "v.douyin.com") {
    throw new DouyinSourceError("parse_failed", "无法从抖音链接识别视频 ID");
  }

  const total = new AbortController();
  const totalTimer = setTimeout(() => total.abort(new Error("total redirect timeout")),
    options.totalTimeoutMs ?? DEFAULT_TOTAL_TIMEOUT_MS);
  try {
    const maxRedirects = options.maxRedirects ?? DEFAULT_MAX_REDIRECTS;
    for (let hop = 0; hop <= maxRedirects; hop += 1) {
      const response = await fetchManual(options.fetchImpl ?? fetch, current,
        options.singleTimeoutMs ?? DEFAULT_SINGLE_TIMEOUT_MS, total.signal);
      const location = REDIRECT_STATUS.has(response.status) ? response.headers.get("location") : null;
      await response.body?.cancel().catch(() => undefined);
      if (!location) {
        const id = extractDouyinAwemeId(current.href);
        if (id) return { awemeId: id, sourceUrl: current.href, canonicalUrl: `https://www.douyin.com/video/${id}` };
        throw new DouyinSourceError("parse_failed", "抖音短链接未跳转到视频页面");
      }
      if (hop === maxRedirects) throw new DouyinSourceError("platform_blocked", "抖音短链接跳转次数过多");
      current = ensureDouyinUrl(new URL(location, current).href);
      const id = extractDouyinAwemeId(current.href);
      if (id) return { awemeId: id, sourceUrl: current.href, canonicalUrl: `https://www.douyin.com/video/${id}` };
    }
    throw new DouyinSourceError("parse_failed", "无法解析抖音短链接");
  } finally {
    clearTimeout(totalTimer);
  }
}

function stringValue(value: unknown) { return typeof value === "string" ? value : ""; }
function finiteInteger(value: unknown) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? Math.round(number) : null;
}
function firstHttpsUrl(value: unknown) {
  const candidates = Array.isArray(value) ? value : typeof value === "object" && value !== null
    ? (value as { url_list?: unknown }).url_list : [];
  for (const candidate of Array.isArray(candidates) ? candidates : []) {
    if (typeof candidate !== "string") continue;
    try { const url = new URL(candidate); if (url.protocol === "https:") return url.href; } catch { /* ignore */ }
  }
  return null;
}

export function parseDouyinVideoDetail(input: unknown): DouyinVideoDetail {
  const root = input as Record<string, unknown> | null;
  const nested = root?.aweme_detail ?? root?.aweme ?? (root?.data as Record<string, unknown> | undefined)?.aweme_detail;
  const aweme = (nested ?? root) as Record<string, unknown> | null;
  const awemeId = stringValue(aweme?.aweme_id);
  if (!AWEME_ID.test(awemeId)) throw new DouyinSourceError("parse_failed", "抖音详情缺少有效视频 ID");
  const author = (aweme?.author ?? {}) as Record<string, unknown>;
  const statistics = (aweme?.statistics ?? {}) as Record<string, unknown>;
  const video = (aweme?.video ?? {}) as Record<string, unknown>;
  const music = (aweme?.music ?? {}) as Record<string, unknown>;
  const description = stringValue(aweme?.desc);
  return {
    awemeId,
    canonicalUrl: `https://www.douyin.com/video/${awemeId}`,
    title: description || stringValue(aweme?.preview_title) || stringValue((aweme?.share_info as Record<string, unknown>)?.share_title),
    description,
    author: { id: stringValue(author.uid), secUid: stringValue(author.sec_uid), nickname: stringValue(author.nickname) },
    publishedAt: finiteInteger(aweme?.create_time),
    durationMs: finiteInteger(video.duration),
    statistics: {
      likes: finiteInteger(statistics.digg_count), comments: finiteInteger(statistics.comment_count),
      collects: finiteInteger(statistics.collect_count), shares: finiteInteger(statistics.share_count),
    },
    coverUrl: firstHttpsUrl(video.cover) ?? firstHttpsUrl(video.origin_cover),
    videoDownloadUrl: firstHttpsUrl(video.play_addr_h264) ?? firstHttpsUrl(video.play_addr),
    audioDownloadUrl: firstHttpsUrl(music.play_url) ?? firstHttpsUrl(music.play_url_hq),
  };
}

function controlledPath(dataRoot: string, ...parts: string[]) {
  const root = resolve(dataRoot);
  const target = resolve(root, ...parts);
  if (target !== root && !target.startsWith(`${root}${sep}`)) throw new DouyinSourceError("parse_failed", "运行时路径无效");
  return target;
}

export async function loadDouyinCookies(dataRoot: string): Promise<Cookie[]> {
  try {
    const parsed = JSON.parse(await readFile(controlledPath(dataRoot, "douyin", "cookies.json"), "utf8"));
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((cookie): cookie is Cookie => cookie && typeof cookie.name === "string"
      && typeof cookie.value === "string" && typeof cookie.domain === "string" && DOUYIN_HOST.test(cookie.domain.replace(/^\./u, "")));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw new DouyinSourceError("parse_failed", "抖音 Cookie 文件无效", { cause: error });
  }
}

export async function saveDouyinCookies(dataRoot: string, cookies: Cookie[]) {
  const file = controlledPath(dataRoot, "douyin", "cookies.json");
  const safe = cookies.filter((cookie) => DOUYIN_HOST.test(cookie.domain.replace(/^\./u, ""))).map((cookie) => ({
    name: cookie.name, value: cookie.value, domain: cookie.domain, path: cookie.path,
    expires: cookie.expires, httpOnly: cookie.httpOnly, secure: cookie.secure, sameSite: cookie.sameSite,
  }));
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(safe)}\n`, { encoding: "utf8", mode: 0o600 });
}

export function redactDouyinDiagnostic(value: unknown): string {
  return String(value ?? "")
    .replace(/\b(cookie|authorization|set-cookie)\s*[:=]\s*[^\s,;]+/giu, "$1=[已脱敏]")
    .replace(/\b(sessionid|sid_guard|passport_csrf_token)=[^\s,;]+/giu, "$1=[已脱敏]")
    .replace(/[A-Za-z]:\\[^\r\n"']+/gu, "[本地路径已隐藏]");
}

async function freePort() {
  return await new Promise<number>((resolvePort, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close((error) => error ? reject(error) : resolvePort(port));
    });
  });
}

export async function findLocalChrome(explicitPath?: string) {
  const candidates = [explicitPath, process.env.CHROME_PATH,
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
    process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, "Google", "Chrome", "Application", "chrome.exe") : undefined,
  ].filter((item): item is string => Boolean(item));
  for (const candidate of candidates) {
    try { await access(candidate, constants.X_OK); return candidate; } catch { /* try next */ }
  }
  throw new DouyinSourceError("platform_blocked", "未找到本机 Chrome，请先安装 Chrome");
}

export interface DouyinChromeSession {
  browser: Browser;
  context: BrowserContext;
  page: Page;
  close(): Promise<void>;
}

type DouyinApiScalar = string | number | boolean;

function parseSessionParams(params: Record<string, unknown>) {
  const entries = Object.entries(params);
  if (entries.length > 64) throw new DouyinSourceError("parse_failed", "抖音 API 参数过多");
  const parsed: Record<string, DouyinApiScalar> = {};
  for (const [key, value] of entries) {
    if (!/^[a-zA-Z][a-zA-Z0-9_]{0,63}$/u.test(key)
      || /cookie|authorization|token/i.test(key) && key !== "msToken") {
      throw new DouyinSourceError("parse_failed", "抖音 API 参数名称无效");
    }
    if (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") {
      throw new DouyinSourceError("parse_failed", `抖音 API 参数 ${key} 无效`);
    }
    if (String(value).length > 2_048) throw new DouyinSourceError("parse_failed", `抖音 API 参数 ${key} 过长`);
    parsed[key] = value;
  }
  return parsed;
}

/**
 * 在已登录页面中复用真实浏览器环境、Cookie 与页面 a_bogus signer 发起请求。
 * helper 只开放详情和评论三个首版端点，调用方无法借此访问任意平台接口。
 */
export async function fetchDouyinSessionJson(session: Pick<DouyinChromeSession, "context" | "page">, input: {
  uri: string;
  params: Record<string, unknown>;
  referer?: string;
  timeoutMs?: number;
  maxBytes?: number;
  signal?: AbortSignal;
}): Promise<unknown> {
  if (!DOUYIN_SESSION_ENDPOINTS.has(input.uri)) throw new DouyinSourceError("parse_failed", "抖音 API 端点不在白名单中");
  const params = parseSessionParams(input.params);
  const timeoutMs = Math.min(Math.max(input.timeoutMs ?? 15_000, 100), 60_000);
  const maxBytes = Math.min(Math.max(input.maxBytes ?? 2 * 1024 * 1024, 1_024), 8 * 1024 * 1024);
  const referer = input.referer ? ensureDouyinUrl(input.referer).href : "https://www.douyin.com/";
  const cookies = await session.context.cookies("https://www.douyin.com");
  if (!cookies.some((cookie) => cookie.name === "sessionid" || cookie.name === "LOGIN_STATUS")) {
    throw new DouyinSourceError("need_login", "需要先登录抖音");
  }
  if (input.signal?.aborted) throw new DouyinSourceError("timeout", "抖音 API 请求已中断");

  // tsx/esbuild 会给序列化到浏览器的函数注入 __name；浏览器上下文需提供同名辅助函数。
  await session.page.evaluate("globalThis.__name ??= (value) => value");
  const requestId = `yingshu_${Date.now()}_${Math.random().toString(36).slice(2)}`;
  const abort = () => { void session.page.evaluate((id) => {
    const state = globalThis as unknown as { __yingshuDouyinRequests?: Map<string, AbortController> };
    state.__yingshuDouyinRequests?.get(id)?.abort();
  }, requestId).catch(() => undefined); };
  input.signal?.addEventListener("abort", abort, { once: true });
  try {
    const result = await session.page.evaluate(async function douyinRequestInPage(request) {
      const state = globalThis as unknown as {
        bdms?: { init?: { _v?: Array<{ p?: Record<number, unknown> }> } };
        __yingshuDouyinRequests?: Map<string, AbortController>;
      };
      const local: Record<string, string> = {};
      try {
        for (let index = 0; index < localStorage.length; index += 1) {
          const key = localStorage.key(index); if (key) local[key] = localStorage.getItem(key) ?? "";
        }
      } catch { /* 隐私模式下 localStorage 可能不可读。 */ }
      const cookie = (name: string) => document.cookie.split(";").map((item) => item.trim())
        .find((item) => item.startsWith(`${name}=`))?.slice(name.length + 1) ?? "";
      const ua = navigator.userAgent || "";
      const common: Record<string, DouyinApiScalar> = {
        device_platform: "webapp", aid: "6383", channel: "channel_pc_web", pc_client_type: "1",
        cookie_enabled: "true", browser_language: navigator.language || "zh-CN",
        browser_platform: navigator.platform || "Win32", browser_name: "Chrome",
        browser_version: ua.match(/Chrome\/([\d.]+)/u)?.[1] ?? "", browser_online: navigator.onLine ? "true" : "false",
        engine_name: "Blink", os_name: "Windows", os_version: "10",
        cpu_core_num: String(navigator.hardwareConcurrency || 8),
        screen_width: String(screen.width || 1920), screen_height: String(screen.height || 1080),
        webid: cookie("webid") || cookie("ttwid").replace(/\D/gu, "").slice(0, 19),
        msToken: local.xmst || local.msToken || "",
      };
      const merged = { ...common, ...request.params };
      const query = new URLSearchParams(Object.entries(merged).map(([key, value]) => [key, String(value)])).toString();
      const signer = state.bdms?.init?._v?.[2]?.p?.[42];
      if (typeof signer !== "function") return { failure: "signer_unavailable" };
      const signType = request.uri.includes("/reply/") ? 8 : 14;
      const aBogus = (signer as (...args: unknown[]) => unknown)(0, 1, signType, query, "", ua);
      if (typeof aBogus !== "string" || !aBogus) return { failure: "signer_unavailable" };
      const controller = new AbortController();
      state.__yingshuDouyinRequests ??= new Map();
      state.__yingshuDouyinRequests.set(request.requestId, controller);
      const timer = setTimeout(() => controller.abort(), request.timeoutMs);
      try {
        const url = new URL(request.uri, "https://www.douyin.com");
        for (const [key, value] of Object.entries(merged)) url.searchParams.set(key, String(value));
        url.searchParams.set("a_bogus", aBogus);
        const response = await fetch(url, {
          credentials: "include", headers: { Accept: "application/json, text/plain, */*" },
          referrer: request.referer, signal: controller.signal,
        });
        const text = await response.text();
        const bytes = new TextEncoder().encode(text).byteLength;
        return { status: response.status, ok: response.ok, text: bytes <= request.maxBytes ? text : "", tooLarge: bytes > request.maxBytes };
      } catch (error) {
        return { failure: error instanceof DOMException && error.name === "AbortError" ? "timeout" : "network" };
      } finally {
        clearTimeout(timer); state.__yingshuDouyinRequests.delete(request.requestId);
      }
    }, { requestId, uri: input.uri, params, referer, timeoutMs, maxBytes });

    if (result.failure === "signer_unavailable") throw new DouyinSourceError("platform_blocked", "抖音页面签名能力不可用，请刷新可见 Chrome 后重试");
    if (result.failure === "timeout") throw new DouyinSourceError("timeout", "抖音 API 请求超时或已中断");
    if (result.failure === "network") throw new DouyinSourceError("platform_blocked", "抖音 API 网络请求失败");
    if (result.tooLarge) throw new DouyinSourceError("platform_blocked", "抖音 API 响应超过大小限制");
    if (!result.ok) {
      if (result.status === 401 || result.status === 403) throw new DouyinSourceError("need_login", "抖音登录已失效");
      if (result.status === 412 || result.status === 429) throw new DouyinSourceError("need_verify", "抖音需要完成验证后才能继续");
      throw new DouyinSourceError("platform_blocked", `抖音 API HTTP ${result.status}`);
    }
    if (!result.text || result.text === "blocked") throw new DouyinSourceError("need_verify", "抖音 API 返回验证阻断");
    try { return JSON.parse(result.text); }
    catch (error) { throw new DouyinSourceError("parse_failed", "抖音 API 返回了非 JSON 内容", { cause: error }); }
  } finally {
    input.signal?.removeEventListener("abort", abort);
  }
}

export async function openVisibleDouyinChrome(dataRoot: string, options: {
  chromePath?: string;
  connectTimeoutMs?: number;
} = {}): Promise<DouyinChromeSession> {
  const chromePath = await findLocalChrome(options.chromePath);
  const port = await freePort();
  const profile = controlledPath(dataRoot, "douyin", "chrome-profile");
  await mkdir(profile, { recursive: true });
  const processHandle: ChildProcess = spawn(chromePath, [
    `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, "--no-first-run", "--no-default-browser-check",
    "https://www.douyin.com/",
  ], { stdio: "ignore", windowsHide: false });
  const deadline = Date.now() + (options.connectTimeoutMs ?? 15_000);
  let browser: Browser | undefined;
  while (Date.now() < deadline && !browser) {
    try { browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`, { timeout: 1_000 }); }
    catch { await new Promise((resolveDelay) => setTimeout(resolveDelay, 150)); }
  }
  if (!browser) {
    processHandle.kill();
    throw new DouyinSourceError("timeout", "等待本机 Chrome 启动超时");
  }
  const context = browser.contexts()[0] ?? await browser.newContext();
  const cookies = await loadDouyinCookies(dataRoot);
  if (cookies.length) await context.addCookies(cookies);
  const page = context.pages()[0] ?? await context.newPage();
  return { browser, context, page, close: async () => {
    await saveDouyinCookies(dataRoot, await context.cookies("https://www.douyin.com"));
    await browser.close().catch(() => undefined);
    processHandle.kill();
  } };
}

function pageState(title: string, url: string, body: string): DouyinSourceFailure | null {
  const text = `${title}\n${url}\n${body.slice(0, 5_000)}`;
  if (/验证码|安全验证|verify|captcha|访问过于频繁/iu.test(text)) return "need_verify";
  if (/扫码登录|登录后|请登录|passport/iu.test(text)) return "need_login";
  if (/拒绝访问|请求异常|网络错误|服务繁忙|blocked|forbidden/iu.test(text)) return "platform_blocked";
  return null;
}

export function hasDouyinLogin(cookies: Cookie[]) {
  return cookies.some((cookie) => cookie.name === "sessionid" || cookie.name === "LOGIN_STATUS");
}

export async function waitForDouyinLoginInSession(dataRoot: string, session: DouyinChromeSession, options: {
  timeoutMs?: number;
  pollMs?: number;
  signal?: AbortSignal;
  onVerificationRequired?: () => void;
}) {
  const initialState = pageState(await session.page.title(), session.page.url(),
    await session.page.locator("body").innerText().catch(() => ""));
  if (initialState !== "need_verify") {
    await session.page.goto("https://www.douyin.com/", { waitUntil: "domcontentloaded", timeout: 20_000 });
  }
  const deadline = Date.now() + (options.timeoutMs ?? 5 * 60_000);
  let verificationReported = false;
  while (Date.now() < deadline) {
    if (options.signal?.aborted) throw new DouyinSourceError("timeout", "等待抖音登录已中断");
    const state = pageState(await session.page.title(), session.page.url(),
      await session.page.locator("body").innerText().catch(() => ""));
    if (state === "need_verify" && !verificationReported) {
      verificationReported = true;
      options.onVerificationRequired?.();
    }
    if (state === "platform_blocked") throw new DouyinSourceError("platform_blocked", "抖音平台阻止了登录页面");
    const cookies = await session.context.cookies("https://www.douyin.com");
    if (state !== "need_verify" && hasDouyinLogin(cookies)) {
      await saveDouyinCookies(dataRoot, cookies);
      return;
    }
    await session.page.waitForTimeout(options.pollMs ?? 500);
  }
  if (verificationReported) throw new DouyinSourceError("need_verify", "等待抖音安全验证超时");
  throw new DouyinSourceError("timeout", "等待抖音登录超时");
}

export async function waitForVisibleDouyinLogin(dataRoot: string, options: {
  chromePath?: string;
  timeoutMs?: number;
  pollMs?: number;
  signal?: AbortSignal;
  onVerificationRequired?: () => void;
  sessionFactory?: typeof openVisibleDouyinChrome;
} = {}) {
  const session = await (options.sessionFactory ?? openVisibleDouyinChrome)(dataRoot, { chromePath: options.chromePath });
  try {
    await waitForDouyinLoginInSession(dataRoot, session, options);
    return { status: "succeeded" as const };
  } finally {
    await session.close();
  }
}

export async function fetchDouyinVideoDetail(dataRoot: string, awemeId: string, options: {
  chromePath?: string;
  navigationTimeoutMs?: number;
  loginTimeoutMs?: number;
  loginPollMs?: number;
  detailTimeoutMs?: number;
  signal?: AbortSignal;
  onLoginRequired?: () => void;
  onVerificationRequired?: () => void;
  onLoginSucceeded?: () => void;
  sessionFactory?: typeof openVisibleDouyinChrome;
} = {}): Promise<DouyinVideoDetail> {
  if (!AWEME_ID.test(awemeId)) throw new DouyinSourceError("parse_failed", "抖音视频 ID 无效");
  const session = await (options.sessionFactory ?? openVisibleDouyinChrome)(dataRoot, { chromePath: options.chromePath });
  try {
    let captured: unknown;
    session.page.on("response", async (response) => {
      if (captured || !response.url().includes("/aweme/v1/web/aweme/detail/")) return;
      try { captured = await response.json(); } catch { /* 页面状态统一处理 */ }
    });
    for (let attempt = 0; attempt < 2; attempt += 1) {
      if (options.signal?.aborted) throw new DouyinSourceError("timeout", "获取抖音详情已中断");
      captured = undefined;
      try {
        await session.page.goto(`https://www.douyin.com/video/${awemeId}`, {
          waitUntil: "domcontentloaded", timeout: options.navigationTimeoutMs ?? 20_000,
        });
        const deadline = Date.now() + (options.detailTimeoutMs ?? 5_000);
        while (!captured && Date.now() < deadline) {
          if (options.signal?.aborted) throw new DouyinSourceError("timeout", "获取抖音详情已中断");
          await session.page.waitForTimeout(Math.min(250, Math.max(1, deadline - Date.now())));
        }
      } catch (error) {
        if (error instanceof DouyinSourceError) throw error;
        if ((error as Error).name === "TimeoutError") throw new DouyinSourceError("timeout", "获取抖音详情超时", { cause: error });
        throw new DouyinSourceError("platform_blocked", "抖音详情页面无法访问", { cause: error });
      }
      if (captured) return parseDouyinVideoDetail(captured);
      const state = pageState(await session.page.title(), session.page.url(), await session.page.locator("body").innerText().catch(() => ""));
      const loggedIn = hasDouyinLogin(await session.context.cookies("https://www.douyin.com"));
      if (attempt === 0 && (state === "need_login" || state === "need_verify" || !loggedIn)) {
        if (state !== "need_verify") options.onLoginRequired?.();
        await waitForDouyinLoginInSession(dataRoot, session, {
          timeoutMs: options.loginTimeoutMs, pollMs: options.loginPollMs, signal: options.signal,
          onVerificationRequired: options.onVerificationRequired,
        });
        options.onLoginSucceeded?.();
        continue;
      }
      if (state) throw new DouyinSourceError(state, state === "need_login" ? "需要在可见 Chrome 中登录抖音"
        : state === "need_verify" ? "抖音需要完成验证后才能继续" : "抖音平台阻止了详情请求");
      throw new DouyinSourceError("parse_failed", "抖音详情响应无法解析");
    }
    throw new DouyinSourceError("parse_failed", "抖音详情响应无法解析");
  } finally {
    await session.close();
  }
}
