import assert from "node:assert/strict";
import test from "node:test";

import {
  buildZhihuAudienceInput, fetchZhihuComments, minimizeZhihuCommentText, type ZhihuComment,
} from "./zhihu-comments.js";
import { normalizeZhihuSource } from "./zhihu-source.js";
import { ZhihuSourceError } from "./zhihu-source.js";

const source = normalizeZhihuSource("https://www.zhihu.com/question/9389089116/answer/1976331888235927140");

function json(value: unknown) { return new Response(JSON.stringify(value)); }

function raw(id: number, overrides: Record<string, unknown> = {}) {
  return { id, content: `评论 ${id}`, vote_count: 2, created_time: 1, author: { id: "same", name: "真实昵称" }, ...overrides };
}

test("根评论按 limit=20、offset 迭代，不信 paging/totals 并在 50 条停止", async () => {
  const requested: URL[] = [];
  const result = await fetchZhihuComments(source, { fetchImpl: async (input) => {
    const url = new URL(String(input));
    requested.push(url);
    const offset = Number(url.searchParams.get("offset"));
    return json({ data: Array.from({ length: 20 }, (_, index) => raw(offset + index + 1)),
      paging: { is_end: true, totals: 20 } });
  } });
  assert.equal(result.comments.length, 50);
  assert.equal(result.pagesFetched, 3);
  assert.equal(result.truncated, true);
  assert.deepEqual(requested.map((url) => url.searchParams.get("offset")), ["0", "20", "40"]);
  assert.ok(requested.every((url) => url.origin === "https://www.zhihu.com"
    && url.pathname === `/api/v4/answers/${source.answerId}/root_comments`
    && url.searchParams.get("limit") === "20"));
});

test("评论清理 PII、稳定匿名并把每条子评论限制为 5 条", async () => {
  const result = await fetchZhihuComments(source, { fetchImpl: async (input) => {
    const url = new URL(String(input));
    if (url.pathname.includes("child_comments")) {
      assert.equal(url.searchParams.get("limit"), "5");
      return json({ data: Array.from({ length: 8 }, (_, index) => raw(100 + index, {
        content: index === 0 ? "联系 13912345678 a@b.com @someone https://example.com" : `回复 ${index}`,
      })) });
    }
    return json({ data: [raw(1, { content: "根评论", child_comment_count: 8 })] });
  } });
  const root = result.comments[0];
  assert.equal(result.status, "succeeded");
  assert.equal(result.interpretationOnly, true);
  assert.equal(root?.replies.length, 5);
  assert.equal(root?.authorId, root?.replies[0]?.authorId);
  assert.equal(root?.replies[0]?.text, "联系 [手机号已隐藏] [邮箱已隐藏] @[账号已隐藏] [链接已隐藏]");
  assert.ok(result.comments.every((comment) => comment.interpretationOnly
    && comment.replies.every((reply) => reply.interpretationOnly)));
  assert.equal(JSON.stringify(result).includes("真实昵称"), false);
});

test("不足 20 条即停止，子评论失败保留根评论并标记 partial", async () => {
  let rootRequests = 0;
  const result = await fetchZhihuComments(source, { fetchImpl: async (input) => {
    const url = new URL(String(input));
    if (url.pathname.includes("child_comments")) throw new Error("blocked");
    rootRequests += 1;
    return json({ data: [raw(1, { child_comment_count: 1 })], paging: { is_end: false, totals: 999 } });
  } });
  assert.equal(result.status, "partial");
  assert.equal(result.comments.length, 1);
  assert.equal(rootRequests, 1);
});

test("根评论成功后子评论 403/429 降级为可判别 partial 并保留根评论", async () => {
  for (const [status, kind] of [[403, "access_denied"], [429, "rate_limited"]] as const) {
    const result = await fetchZhihuComments(source, { fetchImpl: async (input) => {
    const url = new URL(String(input));
    return url.pathname.includes("child_comments")
      ? new Response("", { status })
      : json({ data: [raw(1, { child_comment_count: 1 })] });
    } });
    assert.equal(result.status, "partial");
    assert.equal(result.comments.length, 1);
    assert.equal(result.comments[0]?.interpretationOnly, true);
    assert.deepEqual(result.comments[0]?.replies, []);
    assert.equal(result.failedReplyCount, 1);
    assert.deepEqual(result.replyFailureKinds, [kind]);
  }
});

test("根评论第一页失败仍抛出可判别错误", async () => {
  await assert.rejects(fetchZhihuComments(source, { fetchImpl: async () => new Response("", { status: 403 }) }),
    (error) => error instanceof ZhihuSourceError && error.kind === "access_denied");
});

test("受众输入恒为 interpretationOnly，疑似事实只进入 risks", () => {
  const comment = (id: string, text: string): ZhihuComment => ({
    id, parentId: null, text, likeCount: 1, publishedAt: null, authorId: "anonymous",
    isReply: false, replies: [], interpretationOnly: true,
  });
  const input = buildZhihuAudienceInput([
    comment("need", "希望多讲一些背景"),
    comment("fact", "应该是 42，不是 41"),
    comment("quote", "原话是“另一个版本”"),
  ]);
  assert.equal(input.interpretationOnly, true);
  assert.deepEqual(input.signals.map((item) => item.commentId), ["need"]);
  assert.deepEqual(input.risks.map((item) => item.commentId), ["fact", "quote"]);
  assert.equal(minimizeZhihuCommentText("a\u0000  b"), "a b");
});
