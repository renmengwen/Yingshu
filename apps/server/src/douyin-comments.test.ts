import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { Browser, BrowserContext, Page } from "playwright-core";

import {
  buildDouyinAudienceInput, fetchDouyinComments, minimizeDouyinCommentText,
  type DouyinComment,
} from "./douyin-comments.js";
import type { DouyinChromeSession } from "./douyin-source.js";

const awemeId = "7640385127511641382";

function fakeSession(body = "正常视频页面", state: { loggedIn?: boolean; onWait?: () => void; onClose?: () => void } = {}): DouyinChromeSession {
  const startedLoggedIn = state.loggedIn ?? true;
  let loggedIn = startedLoggedIn;
  return {
    browser: {} as Browser,
    context: {
      cookies: async () => loggedIn ? [{ name: "sessionid", value: "fixture", domain: ".douyin.com", path: "/",
        expires: -1, httpOnly: true, secure: true, sameSite: "Lax" as const }] : [],
    } as unknown as BrowserContext,
    page: {
      goto: async () => undefined,
      title: async () => "视频",
      url: () => `https://www.douyin.com/video/${awemeId}`,
      locator: () => ({ innerText: async () => !startedLoggedIn && loggedIn ? "正常视频页面" : body }),
      waitForTimeout: async () => { state.onWait?.(); loggedIn = true; },
    } as unknown as Page,
    close: async () => { state.onClose?.(); },
  };
}

test("评论清理个人信息、控制字符并生成稳定匿名作者标识", async () => {
  const root = await mkdtemp(join(tmpdir(), "yingshu-douyin-comments-"));
  try {
    let requests = 0;
    const fetchOnce = () => fetchDouyinComments(root, awemeId, {
      now: () => 1234,
      sessionFactory: async () => fakeSession(),
      requestJson: async (_page, path) => {
        requests += 1;
        if (path.includes("reply")) return { comments: [{ cid: "r1", text: "联系 13912345678\u0000", user: { uid: "same" } }] };
        return { has_more: false, comments: [{ cid: "c1", text: "邮箱 a@b.com @someone", digg_count: 8,
          reply_comment_total: 1, user: { uid: "same", nickname: "真实昵称" } }] };
      },
    });
    const first = await fetchOnce();
    assert.equal(first.status, "succeeded");
    assert.equal(first.interpretationOnly, true);
    assert.equal(first.comments[0]?.text, "邮箱 [邮箱已隐藏] @[账号已隐藏]");
    assert.equal(first.comments[0]?.replies[0]?.text, "联系 [手机号已隐藏]");
    assert.equal(first.comments[0]?.authorId, first.comments[0]?.replies[0]?.authorId);
    assert.equal(JSON.stringify(first).includes("真实昵称"), false);
    const cached = await fetchOnce();
    assert.equal(cached.diagnostic.cache, "hit");
    assert.equal(requests, 2);
    assert.equal(JSON.parse(await readFile(join(root, "douyin", "cache", awemeId, "comments.json"), "utf8")).comments.length, 1);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("评论严格限制 50 条顶层和每条 5 条回复，后页失败保留 partial", async () => {
  const root = await mkdtemp(join(tmpdir(), "yingshu-douyin-comments-limit-"));
  try {
    const limited = await fetchDouyinComments(root, awemeId, {
      sessionFactory: async () => fakeSession(),
      requestJson: async (_page, path, params) => path.includes("reply")
        ? { comments: Array.from({ length: 9 }, (_, index) => ({ cid: `${params.comment_id}-r${index}`, text: "回复" })) }
        : { has_more: true, cursor: 60, comments: Array.from({ length: 60 }, (_, index) => ({
          cid: `limited-${index}`, text: "问题", reply_comment_total: 9,
        })) },
    });
    assert.equal(limited.comments.length, 50);
    assert.equal(limited.truncated, true);
    assert.ok(limited.comments.every((comment) => comment.replies.length === 5));

    const rows = Array.from({ length: 20 }, (_, index) => ({ cid: `c${index}`, text: `问题 ${index}`, reply_comment_total: 8 }));
    const result = await fetchDouyinComments(root, awemeId, {
      cacheMaxAgeMs: -1,
      sessionFactory: async () => fakeSession(),
      requestJson: async (_page, path, params) => {
        if (path.includes("reply")) return { comments: Array.from({ length: 9 }, (_, index) => ({ cid: `${params.comment_id}-r${index}`, text: "回复" })) };
        if (params.cursor === "20") throw new Error("platform blocked");
        return { has_more: true, cursor: 20, comments: rows };
      },
    });
    assert.equal(result.status, "partial");
    assert.equal(result.comments.length, 20);
    assert.ok(result.comments.every((comment) => comment.replies.length === 5));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("登录、验证、空结果和首次失败状态彼此独立", async () => {
  const cases = [["请登录后查看评论", "need_login"], ["请完成验证码", "need_verify"]] as const;
  for (const [body, status] of cases) {
    const root = await mkdtemp(join(tmpdir(), "yingshu-douyin-comments-state-"));
    try {
      const result = await fetchDouyinComments(root, awemeId, {
        loginTimeoutMs: 1, loginPollMs: 1, sessionFactory: async () => fakeSession(body),
      });
      assert.equal(result.status, status);
    } finally { await rm(root, { recursive: true, force: true }); }
  }
  const root = await mkdtemp(join(tmpdir(), "yingshu-douyin-comments-empty-"));
  try {
    const empty = await fetchDouyinComments(root, awemeId, {
      sessionFactory: async () => fakeSession(), requestJson: async () => ({ has_more: false, comments: [] }),
    });
    assert.equal(empty.status, "empty");
    const failed = await fetchDouyinComments(root, awemeId, {
      cacheMaxAgeMs: -1, sessionFactory: async () => fakeSession(), requestJson: async () => { throw new Error("blocked"); },
    });
    assert.equal(failed.status, "failed");
    assert.equal(failed.failureKind, "platform_blocked");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("评论采集保持可见 Chrome 等待验证和登录，登录后继续请求并最后关闭", async () => {
  const root = await mkdtemp(join(tmpdir(), "yingshu-douyin-comments-login-"));
  const events: string[] = [];
  try {
    const result = await fetchDouyinComments(root, awemeId, {
      loginPollMs: 1,
      sessionFactory: async () => fakeSession("完成验证码", {
        loggedIn: false,
        onWait: () => events.push("wait"),
        onClose: () => events.push("close"),
      }),
      onLoginRequired: () => events.push("need_login"),
      onVerificationRequired: () => events.push("need_verify"),
      onLoginSucceeded: () => events.push("running"),
      requestJson: async () => { events.push("request"); return { has_more: false, comments: [] }; },
    });
    assert.equal(result.status, "empty");
    assert.deepEqual(events, ["need_login", "need_verify", "wait", "running", "wait", "request", "close"]);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("缓存写失败只记录诊断，不把成功抓取伪装为失败", async () => {
  const root = await mkdtemp(join(tmpdir(), "yingshu-douyin-comments-cache-"));
  try {
    const blockingFile = join(root, "douyin");
    await import("node:fs/promises").then(({ writeFile }) => writeFile(blockingFile, "not a directory"));
    const result = await fetchDouyinComments(root, awemeId, {
      sessionFactory: async () => fakeSession(),
      requestJson: async () => ({ has_more: false, comments: [{ cid: "c1", text: "想看后续" }] }),
    });
    assert.equal(result.status, "succeeded");
    assert.ok(result.diagnostic.cacheWriteError);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("受众输入始终 interpretationOnly，疑似数字、引文和纠正只进入 risks", () => {
  const base = (id: string, text: string): DouyinComment => ({
    id, parentId: null, text, likeCount: 1, publishedAt: null, authorId: "anonymous", isReply: false, replies: [],
  });
  const input = buildDouyinAudienceInput([
    base("question", "希望讲得更清楚"),
    base("number", "应该是 42，不是 41"),
    base("quote", "原话是“另一个说法”"),
  ]);
  assert.equal(input.interpretationOnly, true);
  assert.deepEqual(input.signals.map((signal) => signal.commentId), ["question"]);
  assert.deepEqual(input.risks.map((risk) => risk.commentId), ["number", "quote"]);
  assert.equal(minimizeDouyinCommentText("a\u0000  b"), "a b");
});
