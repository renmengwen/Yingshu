/**
 * 抖音评论最小接入，迁移自 MuseDock scraper/douyin.js 的评论分页边界。
 * 实质修改：复用映述可见 Chrome 会话、JSON 有界缓存、评论匿名化与 interpretationOnly 输入。
 */
import { createHash } from "node:crypto";
import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  DouyinSourceError, fetchDouyinSessionJson, hasDouyinLogin, openVisibleDouyinChrome, redactDouyinDiagnostic,
  waitForDouyinLoginInSession,
  type DouyinChromeSession,
} from "./douyin-source.js";

const AWEME_ID = /^\d{5,32}$/;
const MAX_TOP_LEVEL = 50;
const MAX_REPLIES = 5;
const MAX_CACHE_BYTES = 1_000_000;
const DEFAULT_CACHE_MAX_AGE_MS = 6 * 60 * 60_000;
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/gu;
const EMAIL = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/giu;
const PHONE = /(?<!\d)(?:\+?86[- ]?)?1[3-9]\d{9}(?!\d)/gu;
const ACCOUNT = /@[\p{L}\p{N}_-]{2,32}/gu;
const WEB_URL = /https?:\/\/\S+/giu;
const ID_NUMBER = /(?<!\d)\d{17}[\dXx](?!\d)/gu;
const FACT_LIKE = /\d|“|”|「|」|『|』|纠正|不对|错误|有误|应该是|不是.{0,20}而是/iu;

export type DouyinCommentsStatus = "succeeded" | "empty" | "partial" | "need_login" | "need_verify" | "failed";

export interface DouyinComment {
  id: string;
  parentId: string | null;
  text: string;
  likeCount: number;
  publishedAt: number | null;
  authorId: string;
  isReply: boolean;
  replies: DouyinComment[];
}

export interface DouyinCommentsResult {
  status: DouyinCommentsStatus;
  comments: DouyinComment[];
  fetchedAt: number;
  pagesFetched: number;
  truncated: boolean;
  interpretationOnly: true;
  failureKind?: "platform_blocked" | "timeout" | "parse_failed";
  diagnostic: {
    cache: "hit" | "miss" | "stale" | "invalid";
    cacheWriteError?: string;
    sessionCloseError?: string;
  };
}

export interface DouyinAudienceInput {
  interpretationOnly: true;
  sampleTruncated: boolean;
  signals: Array<{ commentId: string; text: string; likeCount: number; isReply: boolean }>;
  risks: Array<{ commentId: string; reason: string }>;
}

type RequestJson = (session: Pick<DouyinChromeSession, "context" | "page">,
  path: string, params: Record<string, string>) => Promise<unknown>;

function boundedString(value: unknown, max: number) {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

function integer(value: unknown) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.round(parsed) : null;
}

export function minimizeDouyinCommentText(value: unknown, maxLength = 500) {
  return boundedString(value, maxLength * 2)
    .replace(CONTROL, " ")
    .replace(EMAIL, "[邮箱已隐藏]")
    .replace(PHONE, "[手机号已隐藏]")
    .replace(ID_NUMBER, "[证件号已隐藏]")
    .replace(WEB_URL, "[链接已隐藏]")
    .replace(ACCOUNT, "@[账号已隐藏]")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, maxLength);
}

function stableAuthorId(awemeId: string, raw: Record<string, unknown>) {
  const user = (raw.user ?? {}) as Record<string, unknown>;
  const identity = boundedString(user.sec_uid, 128) || boundedString(user.uid, 128)
    || boundedString(user.unique_id, 128) || boundedString(user.nickname, 128) || "anonymous";
  return createHash("sha256").update(`${awemeId}\0${identity}`).digest("hex").slice(0, 20);
}

function parseComment(awemeId: string, value: unknown, parentId: string | null): DouyinComment | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const id = boundedString(raw.cid ?? raw.comment_id, 128);
  const text = minimizeDouyinCommentText(raw.text ?? raw.content);
  if (!id || !text) return null;
  return {
    id,
    parentId,
    text,
    likeCount: integer(raw.digg_count ?? raw.like_count) ?? 0,
    publishedAt: integer(raw.create_time),
    authorId: stableAuthorId(awemeId, raw),
    isReply: parentId !== null,
    replies: [],
  };
}

function responseRows(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  const rows = (value as Record<string, unknown>).comments;
  return Array.isArray(rows) ? rows : [];
}

function responseHasMore(value: unknown) {
  if (!value || typeof value !== "object") return false;
  return Boolean((value as Record<string, unknown>).has_more);
}

function responseCursor(value: unknown, fallback: number) {
  return integer(value && typeof value === "object" ? (value as Record<string, unknown>).cursor : null) ?? fallback;
}

function responseFailure(value: unknown): DouyinCommentsStatus | null {
  const text = JSON.stringify(value ?? "").slice(0, 4_000);
  if (/验证码|安全验证|verify|captcha|访问过于频繁/iu.test(text)) return "need_verify";
  if (/扫码登录|请登录|未登录|login required|passport/iu.test(text)) return "need_login";
  const statusCode = value && typeof value === "object" ? integer((value as Record<string, unknown>).status_code) : null;
  return statusCode && statusCode !== 0 ? "failed" : null;
}

function cacheFile(dataRoot: string, awemeId: string) {
  if (!AWEME_ID.test(awemeId)) throw new DouyinSourceError("parse_failed", "抖音视频 ID 无效");
  return join(dataRoot, "douyin", "cache", awemeId, "comments.json");
}

async function loadCache(dataRoot: string, awemeId: string, now: number, maxAgeMs: number) {
  const file = cacheFile(dataRoot, awemeId);
  try {
    if ((await stat(file)).size > MAX_CACHE_BYTES) return { state: "invalid" as const };
    const parsed = JSON.parse(await readFile(file, "utf8")) as DouyinCommentsResult;
    if (!parsed || parsed.interpretationOnly !== true || !Array.isArray(parsed.comments)
      || !Number.isFinite(parsed.fetchedAt)) return { state: "invalid" as const };
    if (now - parsed.fetchedAt > maxAgeMs) return { state: "stale" as const };
    return { state: "hit" as const, result: { ...parsed, diagnostic: { cache: "hit" as const } } };
  } catch (error) {
    return { state: (error as NodeJS.ErrnoException).code === "ENOENT" ? "miss" as const : "invalid" as const };
  }
}

async function saveCache(dataRoot: string, awemeId: string, result: DouyinCommentsResult) {
  const file = cacheFile(dataRoot, awemeId);
  const temporary = `${file}.${process.pid}.tmp`;
  await mkdir(dirname(file), { recursive: true });
  await writeFile(temporary, `${JSON.stringify(result)}\n`, "utf8");
  await rename(temporary, file);
}

function pageFailure(title: string, url: string, body: string): DouyinCommentsStatus | null {
  const text = `${title}\n${url}\n${body.slice(0, 5_000)}`;
  if (/验证码|安全验证|verify|captcha|访问过于频繁/iu.test(text)) return "need_verify";
  if (/扫码登录|登录后|请登录|passport/iu.test(text)) return "need_login";
  return null;
}

export async function fetchDouyinComments(dataRoot: string, awemeId: string, options: {
  cacheMaxAgeMs?: number;
  now?: () => number;
  sessionFactory?: typeof openVisibleDouyinChrome;
  requestJson?: RequestJson;
  loginTimeoutMs?: number;
  loginPollMs?: number;
  signal?: AbortSignal;
  onLoginRequired?: () => void;
  onVerificationRequired?: () => void;
  onLoginSucceeded?: () => void;
} = {}): Promise<DouyinCommentsResult> {
  if (!AWEME_ID.test(awemeId)) throw new DouyinSourceError("parse_failed", "抖音视频 ID 无效");
  const now = options.now?.() ?? Date.now();
  const cached = await loadCache(dataRoot, awemeId, now, options.cacheMaxAgeMs ?? DEFAULT_CACHE_MAX_AGE_MS);
  if (cached.result) return cached.result;

  const diagnostic: DouyinCommentsResult["diagnostic"] = { cache: cached.state };
  let session: Awaited<ReturnType<typeof openVisibleDouyinChrome>> | undefined;
  let result: DouyinCommentsResult | undefined;
  try {
    session = await (options.sessionFactory ?? openVisibleDouyinChrome)(dataRoot);
    if (!hasDouyinLogin(await session.context.cookies("https://www.douyin.com"))) {
      options.onLoginRequired?.();
      await waitForDouyinLoginInSession(dataRoot, session, {
        timeoutMs: options.loginTimeoutMs, pollMs: options.loginPollMs, signal: options.signal,
        onVerificationRequired: options.onVerificationRequired,
      });
      options.onLoginSucceeded?.();
    }
    for (let attempt = 0; attempt < 2; attempt += 1) {
      await session.page.goto(`https://www.douyin.com/video/${awemeId}`, { waitUntil: "domcontentloaded", timeout: 20_000 });
      // 抖音可能在 DOM 就绪后才异步切换到验证码中间页，需等待页面状态稳定后再判断。
      await session.page.waitForTimeout(1_000);
      const visibleState = pageFailure(await session.page.title(), session.page.url(),
        await session.page.locator("body").innerText().catch(() => ""));
      if (!visibleState) break;
      if (attempt === 0) {
        if (visibleState === "need_login") options.onLoginRequired?.();
        await waitForDouyinLoginInSession(dataRoot, session, {
          timeoutMs: options.loginTimeoutMs, pollMs: options.loginPollMs, signal: options.signal,
          onVerificationRequired: options.onVerificationRequired,
        });
        options.onLoginSucceeded?.();
        continue;
      }
      result = { status: visibleState, comments: [], fetchedAt: now, pagesFetched: 0,
        truncated: false, interpretationOnly: true, diagnostic };
      return result;
    }

    const requestJson = options.requestJson ?? ((activeSession, path, params) => fetchDouyinSessionJson(activeSession, {
      uri: path, params, referer: `https://www.douyin.com/video/${awemeId}`, signal: options.signal,
    }));
    const comments: DouyinComment[] = [];
    let cursor = 0;
    let pagesFetched = 0;
    let partial = false;
    let hasMore = true;
    while (comments.length < MAX_TOP_LEVEL && hasMore) {
      let response: unknown;
      try {
        response = await requestJson(session, "/aweme/v1/web/comment/list/", {
          aweme_id: awemeId, cursor: String(cursor), count: String(Math.min(20, MAX_TOP_LEVEL - comments.length)), item_type: "0",
        });
      } catch (error) {
        if (!comments.length) throw error;
        partial = true;
        break;
      }
      const failure = responseFailure(response);
      if (failure) {
        if (!comments.length) {
          result = { status: failure, comments: [], fetchedAt: now, pagesFetched,
            truncated: false, interpretationOnly: true, diagnostic };
          return result;
        }
        partial = true;
        break;
      }
      const rows = responseRows(response);
      pagesFetched += 1;
      for (const row of rows) {
        const comment = parseComment(awemeId, row, null);
        if (!comment) continue;
        const raw = row as Record<string, unknown>;
        const replyCount = Math.min(integer(raw.reply_comment_total ?? raw.sub_comment_count) ?? 0, MAX_REPLIES);
        if (replyCount > 0) {
          try {
            const replyResponse = await requestJson(session, "/aweme/v1/web/comment/list/reply/", {
              item_id: awemeId, comment_id: comment.id, cursor: "0", count: String(replyCount), item_type: "0",
            });
            const replyFailure = responseFailure(replyResponse);
            if (replyFailure) partial = true;
            else comment.replies = responseRows(replyResponse).slice(0, MAX_REPLIES)
              .map((reply) => parseComment(awemeId, reply, comment.id)).filter((reply): reply is DouyinComment => Boolean(reply));
          } catch { partial = true; }
        }
        comments.push(comment);
        if (comments.length === MAX_TOP_LEVEL) break;
      }
      hasMore = responseHasMore(response) && rows.length > 0;
      cursor = responseCursor(response, cursor + rows.length);
    }

    result = {
      status: partial ? "partial" : comments.length ? "succeeded" : "empty",
      comments,
      fetchedAt: now,
      pagesFetched,
      truncated: comments.length === MAX_TOP_LEVEL && hasMore,
      interpretationOnly: true,
      diagnostic,
    };
    try { await saveCache(dataRoot, awemeId, result); }
    catch (error) { diagnostic.cacheWriteError = redactDouyinDiagnostic((error as Error).message); }
    return result;
  } catch (error) {
    if (error instanceof DouyinSourceError && (error.kind === "need_login" || error.kind === "need_verify")) {
      result = { status: error.kind, comments: [], fetchedAt: now, pagesFetched: 0,
        truncated: false, interpretationOnly: true, diagnostic };
      return result;
    }
    const message = `${(error as Error).name}: ${(error as Error).message}`;
    const kind = error instanceof DouyinSourceError && error.kind === "parse_failed" ? "parse_failed"
      : /timeout/iu.test(message) ? "timeout" : "platform_blocked";
    result = { status: "failed", failureKind: kind, comments: [], fetchedAt: now, pagesFetched: 0,
      truncated: false, interpretationOnly: true, diagnostic };
    return result;
  } finally {
    if (session) await session.close().catch((error) => {
      diagnostic.sessionCloseError = redactDouyinDiagnostic((error as Error).message);
    });
  }
}

export function buildDouyinAudienceInput(comments: readonly DouyinComment[]): DouyinAudienceInput {
  const allSamples = comments.slice(0, MAX_TOP_LEVEL)
    .flatMap((comment) => [comment, ...comment.replies.slice(0, MAX_REPLIES)]);
  const flattened = allSamples.slice(0, 80);
  const signals: DouyinAudienceInput["signals"] = [];
  const risks: DouyinAudienceInput["risks"] = [];
  for (const comment of flattened) {
    const text = minimizeDouyinCommentText(comment.text, 240);
    if (!text) continue;
    if (FACT_LIKE.test(text)) {
      if (risks.length < 20) risks.push({ commentId: comment.id, reason: `评论内容仅作待核验风险：${text}` });
    } else if (signals.length < 60) {
      signals.push({ commentId: comment.id, text, likeCount: comment.likeCount, isReply: comment.isReply });
    }
  }
  return { interpretationOnly: true, sampleTruncated: allSamples.length > flattened.length, signals, risks };
}
