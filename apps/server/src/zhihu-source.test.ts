import assert from "node:assert/strict";
import test from "node:test";

import {
  fetchZhihuAnswer, fetchZhihuApiJson, normalizeZhihuSource, ZhihuSourceError, zhihuHtmlToText,
} from "./zhihu-source.js";

const target = "https://www.zhihu.com/question/9389089116/answer/1976331888235927140";

function json(value: unknown, status = 200, headers?: HeadersInit) {
  return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json", ...headers } });
}

test("严格解析目标链接并清理 query/hash", () => {
  assert.deepEqual(normalizeZhihuSource(`${target}?utm_source=test#fragment`), {
    questionId: "9389089116",
    answerId: "1976331888235927140",
    sourceUrl: target,
    canonicalUrl: target,
  });
  assert.equal(normalizeZhihuSource(target.replace("www.", "")).canonicalUrl, target);
});

test("拒绝非 HTTPS、凭证、端口、近似域名和非目标路径", () => {
  for (const value of [
    target.replace("https:", "http:"),
    target.replace("www.zhihu.com", "user:pass@www.zhihu.com"),
    target.replace("www.zhihu.com", "www.zhihu.com:443"),
    target.replace("www.zhihu.com", "www.zhihu.com.evil.test"),
    "https://zhuanlan.zhihu.com/p/123",
    "https://www.zhihu.com/question/9389089116",
    `${target}/extra`,
  ]) {
    assert.throws(() => normalizeZhihuSource(value), (error) => error instanceof ZhihuSourceError
      && error.kind === "invalid_url", value);
  }
});

test("正文请求固定 API 地址、复核问题回答 ID并安全转纯文本", async () => {
  const source = normalizeZhihuSource(target);
  let requested = "";
  const answer = await fetchZhihuAnswer(source, { fetchImpl: async (input) => {
    requested = String(input);
    return json({
      id: "1976331888235927140",
      question: { id: "9389089116", title: "测试 &amp; 标题" },
      content: "<p>第一段<br>下一行</p><script>alert(1)</script><p>&lt;安全&gt;</p>",
      excerpt: "摘要", author: { name: "作者" }, created_time: 1, updated_time: 2,
      voteup_count: 3, comment_count: 4,
    });
  } });
  const url = new URL(requested);
  assert.equal(url.origin + url.pathname, "https://www.zhihu.com/api/v4/answers/1976331888235927140");
  assert.match(url.searchParams.get("include") ?? "", /content/u);
  assert.equal(answer.questionTitle, "测试 & 标题");
  assert.equal(answer.content, "第一段\n下一行\n<安全>");
  assert.equal(answer.content.includes("alert"), false);
  assert.deepEqual(answer.imageUrls, []);

  await assert.rejects(fetchZhihuAnswer(source, { fetchImpl: async () => json({
    id: "1976331888235927141", question: { id: "9389089116", title: "题" }, content: "正文",
  }) }), (error) => error instanceof ZhihuSourceError && error.kind === "structure_changed");
});

test("响应大小、正文大小、401/403/429、超时与外部中断均明确分型", async () => {
  for (const [status, kind] of [[401, "authentication_required"], [403, "access_denied"], [429, "rate_limited"]] as const) {
    await assert.rejects(fetchZhihuApiJson({ kind: "answer", answerId: "123" }, {
      fetchImpl: async () => new Response("", { status }),
    }), (error) => error instanceof ZhihuSourceError && error.kind === kind);
  }
  await assert.rejects(fetchZhihuApiJson({ kind: "answer", answerId: "123" }, {
    maxResponseBytes: 1_024,
    fetchImpl: async () => new Response("x".repeat(1_025)),
  }), (error) => error instanceof ZhihuSourceError && error.kind === "response_too_large");

  const source = normalizeZhihuSource(target);
  await assert.rejects(fetchZhihuAnswer(source, {
    maxContentBytes: 1_024,
    fetchImpl: async () => json({ id: source.answerId, question: { id: source.questionId, title: "题" }, content: "字".repeat(1_025) }),
  }), (error) => error instanceof ZhihuSourceError && error.kind === "content_too_large");

  const waitForAbort: typeof fetch = async (_input, init) => await new Promise<Response>((_resolve, reject) => {
    init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
  });
  await assert.rejects(fetchZhihuApiJson({ kind: "answer", answerId: "123" }, {
    timeoutMs: 100, fetchImpl: waitForAbort,
  }), (error) => error instanceof ZhihuSourceError && error.kind === "timeout");

  const slowBody: typeof fetch = async (_input, init) => new Response(new ReadableStream({
    start(stream) {
      init?.signal?.addEventListener("abort", () => stream.error(new DOMException("aborted", "AbortError")), { once: true });
    },
  }));
  await assert.rejects(fetchZhihuApiJson({ kind: "answer", answerId: "123" }, {
    timeoutMs: 100, fetchImpl: slowBody,
  }), (error) => error instanceof ZhihuSourceError && error.kind === "timeout");
  const controller = new AbortController();
  const pending = fetchZhihuApiJson({ kind: "answer", answerId: "123" }, {
    timeoutMs: 1_000, signal: controller.signal, fetchImpl: waitForAbort,
  });
  controller.abort();
  await assert.rejects(pending, (error) => error instanceof ZhihuSourceError && error.kind === "aborted");
});

test("HTML 清理删除不可见块、标签与控制字符", () => {
  assert.equal(zhihuHtmlToText("<style>x{}</style><p>A&nbsp;B&#10;C</p><svg><text>secret</text></svg>\u0000"), "A B\nC");
});

test("图片型回答保留去重后的可信图片块，不把属性长度误当正文", async () => {
  const image = "https://pic1.zhimg.com/v2-answer.jpg?source=test&amp;token=1";
  const html = `<p>短引言</p><figure><noscript><img data-original="${image}"></noscript>`
    + `<img src="https://evil.test/tracker" data-actualsrc="${image}"></figure><p>结尾</p>`;
  const answer = await fetchZhihuAnswer(normalizeZhihuSource(target), { fetchImpl: async () => json({
    id: "1976331888235927140", question: { id: "9389089116", title: "题" }, content: html,
  }) });
  assert.equal(answer.imageUrls.length, 1);
  assert.match(answer.content, /短引言\n+!\[知乎回答图片 1\]\(https:\/\/pic1\.zhimg\.com\//u);
  assert.equal(answer.content.match(/知乎回答图片/gu)?.length, 1);
  assert.equal(answer.content.includes("evil.test"), false);
  assert.match(answer.content, /\n结尾$/u);
});
