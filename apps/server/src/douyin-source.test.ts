import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { Browser, BrowserContext, Cookie, Page, Response as PlaywrightResponse } from "playwright-core";

import {
  DouyinSourceError, extractDouyinAwemeId, fetchDouyinVideoDetail, loadDouyinCookies,
  fetchDouyinSessionJson, parseDouyinVideoDetail, redactDouyinDiagnostic, resolveDouyinSource, saveDouyinCookies,
  waitForVisibleDouyinLogin, type DouyinChromeSession,
} from "./douyin-source.js";

const id = "7640385127511641382";

test("分享文案、标准链接和查询链接只提取 5～32 位数字 aweme_id", () => {
  assert.equal(extractDouyinAwemeId(`复制打开抖音 https://www.douyin.com/video/${id}?x=1 好看`), id);
  assert.equal(extractDouyinAwemeId(`https://www.douyin.com/discover?modal_id=${id}`), id);
  assert.equal(extractDouyinAwemeId("https://example.com/video/7640385127511641382"), null);
  assert.equal(extractDouyinAwemeId("https://www.douyin.com/video/1234"), null);
  assert.equal(extractDouyinAwemeId("https://www.douyin.com/video/12345abc"), null);
});

test("短链接逐跳解析且每一跳都限制为抖音域名", async () => {
  const visited: string[] = [];
  const fetchImpl = (async (input: string | URL | globalThis.Request) => {
    const url = String(input);
    visited.push(url);
    if (visited.length === 1) return new Response(null, { status: 302, headers: { location: "/abc/" } });
    return new Response(null, { status: 302, headers: { location: `https://www.douyin.com/video/${id}` } });
  }) as typeof fetch;
  const resolved = await resolveDouyinSource("7.88 复制 https://v.douyin.com/test/ 打开抖音", { fetchImpl });
  assert.deepEqual(resolved, {
    awemeId: id, sourceUrl: `https://www.douyin.com/video/${id}`, canonicalUrl: `https://www.douyin.com/video/${id}`,
  });
  assert.deepEqual(visited, ["https://v.douyin.com/test/", "https://v.douyin.com/abc/"]);
  await assert.rejects(resolveDouyinSource("https://v.douyin.com/test/", {
    fetchImpl: (async () => new Response(null, { status: 302, headers: { location: "https://evil.example/video/12345" } })) as typeof fetch,
  }), (error: unknown) => error instanceof DouyinSourceError && error.kind === "parse_failed");
});

test("短链接限制跳转次数、单次超时和总超时", async () => {
  await assert.rejects(resolveDouyinSource("https://v.douyin.com/loop/", {
    maxRedirects: 1,
    fetchImpl: (async () => new Response(null, { status: 302, headers: { location: "/loop/" } })) as typeof fetch,
  }), (error: unknown) => error instanceof DouyinSourceError && error.kind === "platform_blocked");
  const hangingFetch = ((_input: unknown, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
    init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
  })) as typeof fetch;
  await assert.rejects(resolveDouyinSource("https://v.douyin.com/slow/", {
    fetchImpl: hangingFetch, singleTimeoutMs: 5, totalTimeoutMs: 50,
  }), (error: unknown) => error instanceof DouyinSourceError && error.kind === "timeout");
  await assert.rejects(resolveDouyinSource("https://v.douyin.com/slow/", {
    fetchImpl: hangingFetch, singleTimeoutMs: 50, totalTimeoutMs: 5,
  }), (error: unknown) => error instanceof DouyinSourceError && error.kind === "timeout");
});

test("详情解析只保留分析必需元数据和 HTTPS 媒体地址", () => {
  const detail = parseDouyinVideoDetail({ aweme_detail: {
    aweme_id: id, desc: "测试标题", create_time: 1_700_000_000,
    author: { uid: "author", sec_uid: "sec", nickname: "作者", secret: "不应保留" },
    statistics: { digg_count: 11, comment_count: 12, collect_count: 13, share_count: 14 },
    video: {
      duration: 58_400, cover: { url_list: ["https://cdn.example/cover.jpg"] },
      play_addr: { url_list: ["http://unsafe.example/video", "https://cdn.example/video.mp4"] },
    },
    music: { play_url: { url_list: ["https://cdn.example/audio.mp3"] } }, cookies: "不应保留",
  } });
  assert.equal(detail.videoDownloadUrl, "https://cdn.example/video.mp4");
  assert.equal(detail.durationMs, 58_400);
  assert.deepEqual(detail.statistics, { likes: 11, comments: 12, collects: 13, shares: 14 });
  assert.equal(JSON.stringify(detail).includes("secret"), false);
  assert.equal(JSON.stringify(detail).includes("cookies"), false);
  assert.throws(() => parseDouyinVideoDetail({ aweme_detail: { aweme_id: "bad" } }), /有效视频 ID/u);
});

test("Cookie 仅写入受控 dataRoot 且诊断会脱敏 Cookie 和绝对路径", async () => {
  const dataRoot = await mkdtemp(join(tmpdir(), "yingshu-douyin-source-"));
  const cookies: Cookie[] = [{
    name: "sessionid", value: "secret", domain: ".douyin.com", path: "/", expires: -1,
    httpOnly: true, secure: true, sameSite: "Lax",
  }, {
    name: "foreign", value: "drop", domain: ".example.com", path: "/", expires: -1,
    httpOnly: false, secure: true, sameSite: "Lax",
  }];
  try {
    await saveDouyinCookies(dataRoot, cookies);
    assert.deepEqual((await loadDouyinCookies(dataRoot)).map((cookie) => cookie.name), ["sessionid"]);
    assert.equal((await readFile(join(dataRoot, "douyin", "cookies.json"), "utf8")).includes("foreign"), false);
    const diagnostic = redactDouyinDiagnostic(`Cookie: sessionid=secret C:\\Users\\me\\profile`);
    assert.equal(diagnostic.includes("secret"), false);
    assert.equal(diagnostic.includes("C:\\Users"), false);
  } finally { await rm(dataRoot, { recursive: true, force: true }); }
});

function fakeSession(input: { title: string; url: string; body: string; response?: unknown }): DouyinChromeSession {
  let handler: ((response: PlaywrightResponse) => void) | undefined;
  const page = {
    on: (_event: string, next: (response: PlaywrightResponse) => void) => { handler = next; },
    goto: async () => { if (input.response) handler?.({
      url: () => "https://www.douyin.com/aweme/v1/web/aweme/detail/", json: async () => input.response,
    } as PlaywrightResponse); },
    waitForTimeout: async () => { await new Promise((resolve) => setImmediate(resolve)); },
    title: async () => input.title, url: () => input.url,
    locator: () => ({ innerText: async () => input.body }),
  } as unknown as Page;
  return { browser: {} as Browser, context: { cookies: async () => [{
    name: "sessionid", value: "secret", domain: ".douyin.com", path: "/", expires: -1,
    httpOnly: true, secure: true, sameSite: "Lax",
  }] } as unknown as BrowserContext, page, close: async () => undefined };
}

test("可见 Chrome 详情链明确区分登录、验证、平台阻断与解析失败", async () => {
  const cases = [
    ["扫码登录", "https://www.douyin.com/passport/login", "请登录", "need_login"],
    ["安全验证", "https://www.douyin.com/verify", "完成验证码", "need_verify"],
    ["访问异常", "https://www.douyin.com/video/x", "请求异常", "platform_blocked"],
    ["视频", `https://www.douyin.com/video/${id}`, "正常页面", "parse_failed"],
  ] as const;
  for (const [title, url, body, kind] of cases) {
    await assert.rejects(fetchDouyinVideoDetail("unused", id, {
      detailTimeoutMs: 1, loginTimeoutMs: 1, loginPollMs: 1,
      sessionFactory: async () => fakeSession({ title, url, body }),
    }), (error: unknown) => error instanceof DouyinSourceError && error.kind === kind);
  }
  const detail = await fetchDouyinVideoDetail("unused", id, { sessionFactory: async () => fakeSession({
    title: "视频", url: `https://www.douyin.com/video/${id}`, body: "正常",
    response: { aweme_detail: { aweme_id: id, desc: "fixture" } },
  }) });
  assert.equal(detail.title, "fixture");
});

test("详情链在同一可见 Chrome 等待登录后继续且等待期间不关闭窗口", async () => {
  const dataRoot = await mkdtemp(join(tmpdir(), "yingshu-douyin-detail-login-"));
  let markEntered!: () => void;
  let releaseLogin!: () => void;
  const entered = new Promise<void>((resolve) => { markEntered = resolve; });
  const release = new Promise<void>((resolve) => { releaseLogin = resolve; });
  const gotoUrls: string[] = [];
  let currentUrl = `https://www.douyin.com/video/${id}`;
  let videoVisits = 0;
  let closeCalls = 0;
  let loggedIn = false;
  let handler: ((response: PlaywrightResponse) => void) | undefined;
  const session = {
    browser: {} as Browser,
    context: { cookies: async () => {
      if (currentUrl === "https://www.douyin.com/" && !loggedIn) {
        markEntered(); await release; loggedIn = true;
      }
      return loggedIn ? [{ name: "sessionid", value: "secret", domain: ".douyin.com", path: "/", expires: -1,
        httpOnly: true, secure: true, sameSite: "Lax" }] : [];
    } } as unknown as BrowserContext,
    page: {
      on: (_event: string, next: (response: PlaywrightResponse) => void) => { handler = next; },
      goto: async (url: string) => {
        currentUrl = url; gotoUrls.push(url);
        if (url.includes("/video/") && ++videoVisits === 2) handler?.({
          url: () => "https://www.douyin.com/aweme/v1/web/aweme/detail/",
          json: async () => ({ aweme_detail: { aweme_id: id, desc: "登录后的详情" } }),
        } as PlaywrightResponse);
      },
      waitForTimeout: async () => { await new Promise((resolve) => setImmediate(resolve)); },
      title: async () => loggedIn ? "抖音" : "扫码登录",
      url: () => currentUrl,
      locator: () => ({ innerText: async () => loggedIn ? "首页" : "请登录" }),
    } as unknown as Page,
    close: async () => { closeCalls += 1; },
  } satisfies DouyinChromeSession;
  let loginRequired = 0;
  let loginSucceeded = 0;
  try {
    const pending = fetchDouyinVideoDetail(dataRoot, id, {
      detailTimeoutMs: 1, loginPollMs: 1, sessionFactory: async () => session,
      onLoginRequired: () => { loginRequired += 1; }, onLoginSucceeded: () => { loginSucceeded += 1; },
    });
    await entered;
    assert.equal(closeCalls, 0);
    releaseLogin();
    const detail = await pending;
    assert.equal(detail.title, "登录后的详情");
    assert.deepEqual(gotoUrls, [`https://www.douyin.com/video/${id}`, "https://www.douyin.com/", `https://www.douyin.com/video/${id}`]);
    assert.equal(loginRequired, 1);
    assert.equal(loginSucceeded, 1);
    assert.equal(closeCalls, 1);
  } finally { await rm(dataRoot, { recursive: true, force: true }); }
});

test("可见 Chrome 在登录和验证页面都保持等待 session Cookie", async () => {
  const dataRoot = await mkdtemp(join(tmpdir(), "yingshu-douyin-login-"));
  let cookieChecks = 0;
  const createSession = (title: string, body: string) => {
    const session = fakeSession({ title, url: "https://www.douyin.com/", body });
    session.page.title = async () => cookieChecks >= 2 ? "抖音" : title;
    session.page.locator = () => ({ innerText: async () => cookieChecks >= 2 ? "首页" : body }) as ReturnType<Page["locator"]>;
    session.context = {
      cookies: async () => ++cookieChecks < 2 ? [] : [{
        name: "sessionid", value: "secret", domain: ".douyin.com", path: "/", expires: -1,
        httpOnly: true, secure: true, sameSite: "Lax",
      }],
    } as unknown as BrowserContext;
    return session;
  };
  try {
    assert.deepEqual(await waitForVisibleDouyinLogin(dataRoot, {
      pollMs: 1, sessionFactory: async () => createSession("扫码登录", "请登录"),
    }), { status: "succeeded" });
    cookieChecks = 0;
    let verificationRequired = 0;
    assert.deepEqual(await waitForVisibleDouyinLogin(dataRoot, {
      pollMs: 1, sessionFactory: async () => createSession("安全验证", "完成验证码"),
      onVerificationRequired: () => { verificationRequired += 1; },
    }), { status: "succeeded" });
    assert.equal(verificationRequired, 1);
  } finally { await rm(dataRoot, { recursive: true, force: true }); }
});

test("已登录 session JSON helper 限制端点、补浏览器环境并分型响应", async () => {
  let evaluated: Record<string, unknown> | undefined;
  const session = {
    context: { cookies: async () => [{ name: "sessionid", value: "secret", domain: ".douyin.com" }] },
    page: { evaluate: async (_callback: unknown, input: Record<string, unknown>) => {
      evaluated = input; return { status: 200, ok: true, text: '{"comments":[]}', tooLarge: false };
    } },
  } as unknown as Pick<DouyinChromeSession, "context" | "page">;
  assert.deepEqual(await fetchDouyinSessionJson(session, {
    uri: "/aweme/v1/web/comment/list/", params: { aweme_id: id, count: 20 },
    referer: `https://www.douyin.com/video/${id}`,
  }), { comments: [] });
  assert.equal(evaluated?.uri, "/aweme/v1/web/comment/list/");
  assert.deepEqual(evaluated?.params, { aweme_id: id, count: 20 });
  await assert.rejects(fetchDouyinSessionJson(session, {
    uri: "/aweme/v1/web/user/profile/other/", params: {},
  }), (error: unknown) => error instanceof DouyinSourceError && error.kind === "parse_failed");

  for (const [result, kind] of [
    [{ failure: "signer_unavailable" }, "platform_blocked"],
    [{ failure: "timeout" }, "timeout"],
    [{ status: 412, ok: false, text: "", tooLarge: false }, "need_verify"],
    [{ status: 200, ok: true, text: "blocked", tooLarge: false }, "need_verify"],
    [{ status: 200, ok: true, text: "not-json", tooLarge: false }, "parse_failed"],
  ] as const) {
    const failing = { ...session, page: { evaluate: async () => result } } as unknown as Pick<DouyinChromeSession, "context" | "page">;
    await assert.rejects(fetchDouyinSessionJson(failing, {
      uri: "/aweme/v1/web/comment/list/", params: { aweme_id: id },
    }), (error: unknown) => error instanceof DouyinSourceError && error.kind === kind);
  }
});
