import { createHash } from "node:crypto";

import {
  fetchZhihuApiJson, ZhihuSourceError, zhihuHtmlToText,
  type NormalizedZhihuSource, type ZhihuFetchOptions, type ZhihuSourceFailure,
} from "./zhihu-source.js";

const PAGE_LIMIT = 20;
const MAX_ROOT_COMMENTS = 50;
const MAX_CHILD_COMMENTS = 5;
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/gu;
const EMAIL = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/giu;
const PHONE = /(?<!\d)(?:\+?86[- ]?)?1[3-9]\d{9}(?!\d)/gu;
const ACCOUNT = /@[\p{L}\p{N}_-]{2,32}/gu;
const WEB_URL = /https?:\/\/\S+/giu;
const ID_NUMBER = /(?<!\d)\d{17}[\dXx](?!\d)/gu;
const FACT_LIKE = /\d|“|”|「|」|『|』|纠正|不对|错误|有误|应该是|不是.{0,20}而是/iu;

export interface ZhihuComment {
  id: string;
  parentId: string | null;
  text: string;
  likeCount: number;
  publishedAt: number | null;
  authorId: string;
  isReply: boolean;
  replies: ZhihuComment[];
  interpretationOnly: true;
}

export interface ZhihuCommentsResult {
  status: "succeeded" | "empty" | "partial";
  comments: ZhihuComment[];
  pagesFetched: number;
  truncated: boolean;
  interpretationOnly: true;
  /** 向后兼容旧 mock；真实抓取结果始终提供这两个无敏感信息的聚合字段。 */
  failedReplyCount?: number;
  replyFailureKinds?: ZhihuSourceFailure[];
}

export interface ZhihuAudienceInput {
  interpretationOnly: true;
  sampleTruncated: boolean;
  signals: Array<{ commentId: string; text: string; likeCount: number; isReply: boolean }>;
  risks: Array<{ commentId: string; reason: string }>;
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function rows(value: unknown) {
  const data = record(value)?.data;
  if (!Array.isArray(data)) throw new ZhihuSourceError("structure_changed", "知乎评论列表结构已变化");
  return data;
}

function integer(value: unknown) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? Math.round(number) : null;
}

function boundedString(value: unknown, max: number) {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

export function minimizeZhihuCommentText(value: unknown, maxLength = 500) {
  return zhihuHtmlToText(value)
    .slice(0, maxLength * 2)
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

function commentId(value: unknown) {
  const text = typeof value === "string" || typeof value === "number" ? String(value) : "";
  return /^\d{1,32}$/u.test(text) ? text : "";
}

function stableAuthorId(answerId: string, raw: Record<string, unknown>) {
  const author = record(raw.author);
  const member = record(author?.member);
  const identity = boundedString(member?.id, 128) || boundedString(member?.url_token, 128)
    || boundedString(member?.member_hash, 128) || boundedString(author?.id, 128)
    || boundedString(author?.url_token, 128) || boundedString(author?.member_hash, 128)
    || boundedString(author?.name, 128) || "anonymous";
  return createHash("sha256").update(`${answerId}\0${identity}`).digest("hex").slice(0, 20);
}

function parseComment(answerId: string, value: unknown, parentId: string | null): ZhihuComment | null {
  const raw = record(value);
  if (!raw) return null;
  const id = commentId(raw.id);
  const text = minimizeZhihuCommentText(raw.content);
  if (!id || !text) return null;
  return {
    id,
    parentId,
    text,
    likeCount: integer(raw.vote_count ?? raw.like_count) ?? 0,
    publishedAt: integer(raw.created_time),
    authorId: stableAuthorId(answerId, raw),
    isReply: parentId !== null,
    replies: [],
    interpretationOnly: true,
  };
}

function embeddedChildren(raw: Record<string, unknown>) {
  return Array.isArray(raw.child_comments) ? raw.child_comments : [];
}

export async function fetchZhihuComments(source: NormalizedZhihuSource,
  options: ZhihuFetchOptions = {}): Promise<ZhihuCommentsResult> {
  const comments: ZhihuComment[] = [];
  let pagesFetched = 0;
  let offset = 0;
  let partial = false;
  let failedReplyCount = 0;
  const replyFailureKinds = new Set<ZhihuSourceFailure>();
  let lastPageFull = false;
  while (comments.length < MAX_ROOT_COMMENTS) {
    const rootRows = rows(await fetchZhihuApiJson({
      kind: "root_comments", answerId: source.answerId, limit: PAGE_LIMIT, offset,
    }, options));
    pagesFetched += 1;
    lastPageFull = rootRows.length >= PAGE_LIMIT;
    let validRows = 0;
    for (const value of rootRows) {
      const raw = record(value);
      const comment = parseComment(source.answerId, value, null);
      if (!raw || !comment) continue;
      validRows += 1;
      const expectedChildren = Math.min(integer(raw.child_comment_count) ?? embeddedChildren(raw).length, MAX_CHILD_COMMENTS);
      let childRows = embeddedChildren(raw);
      if (childRows.length < expectedChildren) {
        try {
          childRows = rows(await fetchZhihuApiJson({
            kind: "child_comments", commentId: comment.id, limit: MAX_CHILD_COMMENTS, offset: 0,
          }, options));
        } catch (error) {
          // 子评论是可选解释维度，失败不能清空已经取得的根评论；用户主动中断除外。
          if (error instanceof ZhihuSourceError && error.kind === "aborted") throw error;
          partial = true;
          failedReplyCount += 1;
          replyFailureKinds.add(error instanceof ZhihuSourceError ? error.kind : "request_failed");
        }
      }
      comment.replies = childRows.slice(0, MAX_CHILD_COMMENTS)
        .map((child) => parseComment(source.answerId, child, comment.id))
        .filter((child): child is ZhihuComment => Boolean(child));
      comments.push(comment);
      if (comments.length === MAX_ROOT_COMMENTS) break;
    }
    if (rootRows.length && !validRows) throw new ZhihuSourceError("structure_changed", "知乎评论字段结构已变化");
    // 旧接口的 paging 与 totals 可能漂移，首版只信本页实际返回条数。
    if (rootRows.length < PAGE_LIMIT) break;
    offset += PAGE_LIMIT;
  }
  return {
    status: partial ? "partial" : comments.length ? "succeeded" : "empty",
    comments,
    pagesFetched,
    truncated: comments.length === MAX_ROOT_COMMENTS && lastPageFull,
    interpretationOnly: true,
    failedReplyCount,
    replyFailureKinds: [...replyFailureKinds],
  };
}

export function buildZhihuAudienceInput(comments: readonly ZhihuComment[]): ZhihuAudienceInput {
  const allSamples = comments.slice(0, MAX_ROOT_COMMENTS)
    .flatMap((comment) => [comment, ...comment.replies.slice(0, MAX_CHILD_COMMENTS)]);
  const flattened = allSamples.slice(0, 80);
  const signals: ZhihuAudienceInput["signals"] = [];
  const risks: ZhihuAudienceInput["risks"] = [];
  for (const comment of flattened) {
    const text = minimizeZhihuCommentText(comment.text, 240);
    if (!text) continue;
    if (FACT_LIKE.test(text)) {
      if (risks.length < 20) risks.push({ commentId: comment.id, reason: `评论内容仅作待核验风险：${text}` });
    } else if (signals.length < 60) {
      signals.push({ commentId: comment.id, text, likeCount: comment.likeCount, isReply: comment.isReply });
    }
  }
  return { interpretationOnly: true, sampleTruncated: allSamples.length > flattened.length, signals, risks };
}
