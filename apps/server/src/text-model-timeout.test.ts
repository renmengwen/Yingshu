import assert from "node:assert/strict";
import test from "node:test";

import { withTextModelTimeout } from "./text-model-timeout.js";

const short = { firstActivityMs: 15, idleMs: 15, totalMs: 60 };

function waitForAbort(signal: AbortSignal) {
  return new Promise<never>((_resolve, reject) => {
    signal.addEventListener("abort", () => reject(signal.reason), { once: true });
  });
}

test("文本模型首活动超时", async () => {
  await assert.rejects(withTextModelTimeout((signal) => waitForAbort(signal), short),
    (error: unknown) => error instanceof Error && error.name === "TimeoutError" && /first activity/.test(error.message));
});

test("文本模型活动跨过首时限后续期成功", async () => {
  const value = await withTextModelTimeout(async (_signal, onActivity) => {
    await new Promise((resolve) => setTimeout(resolve, 8));
    onActivity();
    await new Promise((resolve) => setTimeout(resolve, 10));
    onActivity();
    return "ok";
  }, short);
  assert.equal(value, "ok");
});

test("文本模型活动续期后按空闲超时", async () => {
  const started = Date.now();
  await assert.rejects(withTextModelTimeout(async (signal, onActivity) => {
    await new Promise((resolve) => setTimeout(resolve, 8));
    onActivity();
    await new Promise((resolve) => setTimeout(resolve, 8));
    onActivity();
    return waitForAbort(signal);
  }, short), (error: unknown) => error instanceof Error && error.name === "TimeoutError" && /idle/.test(error.message));
  assert.ok(Date.now() - started >= 25);
});

test("文本模型持续活动仍受总时限约束", async () => {
  await assert.rejects(withTextModelTimeout(async (signal, onActivity) => {
    const activity = setInterval(onActivity, 5);
    try { return await waitForAbort(signal); } finally { clearInterval(activity); }
  }, { ...short, totalMs: 25 }),
  (error: unknown) => error instanceof Error && error.name === "TimeoutError" && /total/.test(error.message));
});

test("文本模型外部取消立即传播", async () => {
  const controller = new AbortController();
  const reason = new Error("stop");
  const running = withTextModelTimeout((signal) => waitForAbort(signal), { ...short, signal: controller.signal });
  controller.abort(reason);
  await assert.rejects(running, (error) => error === reason);
});

test("文本模型持久取消轮询传播", async () => {
  let cancelled = false;
  const running = withTextModelTimeout((signal) => waitForAbort(signal), {
    ...short, isCancellationRequested: () => cancelled, cancellationPollMs: 1,
  });
  cancelled = true;
  await assert.rejects(running, (error: unknown) => error instanceof Error && error.name === "AbortError");
});
