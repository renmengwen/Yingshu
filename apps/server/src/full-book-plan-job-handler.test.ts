import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import test from "node:test";

import {
  FULL_BOOK_PLAN_IDLE_TIMEOUT_MS,
  FULL_BOOK_PLAN_JOB_TYPE,
  FULL_BOOK_PLAN_MODEL_MAX_ATTEMPTS,
  FULL_BOOK_PLAN_RETRY_DELAY_MS,
  FULL_BOOK_PLAN_TIMEOUT_MS,
  FULL_BOOK_PLAN_TOTAL_TIMEOUT_MS,
  createFullBookPlanJobHandler,
  fullBookPlanJobRequestHash,
  type FullBookPlanJobPayload,
} from "./full-book-plan-job-handler.js";
import {
  FULL_BOOK_PLAN_JOB_CONTRACT_VERSION,
  FULL_BOOK_PLAN_JOB_V1_CONTRACT_VERSION,
  FULL_BOOK_PLAN_JOB_V1_PROMPT_VERSION,
  buildFullBookPlanFinalRequest,
  buildFullBookPlanIntervalRequests,
  parseFullBookPlanIntervalResponse,
  type FullBookPlanBuildLimits,
} from "./full-book-plan-job.js";
import type { JobExecutionContext } from "./job-worker.js";
import { textModelConcurrencyGate } from "./text-model-concurrency.js";

const config = {
  baseUrl: "https://model.invalid/v1", apiKey: "test", model: "model-a", providerId: "provider-a",
  protocol: "openai-response" as const,
};
const limits: FullBookPlanBuildLimits = {
  maxChaptersPerInterval: 1, maxEventsPerInterval: 1, maxInputBytesPerInterval: 1_000,
  maxFinalIntervals: 2, maxFinalInputBytes: 100_000,
};

test("全书规划使用有限首事件、空闲与总时限", () => {
  assert.equal(FULL_BOOK_PLAN_TIMEOUT_MS, 180_000);
  assert.equal(FULL_BOOK_PLAN_IDLE_TIMEOUT_MS, 180_000);
  assert.equal(FULL_BOOK_PLAN_TOTAL_TIMEOUT_MS, 900_000);
  assert.equal(FULL_BOOK_PLAN_MODEL_MAX_ATTEMPTS, 3);
  assert.equal(FULL_BOOK_PLAN_RETRY_DELAY_MS, 1_000);
});

function payload(): FullBookPlanJobPayload {
  const storyBible = { id: "bible_a", contentHash: "b".repeat(64) };
  const intervals = buildFullBookPlanIntervalRequests("book_a", storyBible, [0, 1].map((chapterIndex) => ({
    chapterId: `chapter_${chapterIndex}`, chapterIndex,
    sourceEvents: [{
      id: `event_${chapterIndex}`, contentHash: `${chapterIndex + 1}`.repeat(64), inputBytes: 10,
      eventType: "revelation", payload: { summary: `第 ${chapterIndex} 章事件` },
      chapterId: `chapter_${chapterIndex}`, chapterIndex,
      byteRanges: [{ byteStart: chapterIndex * 10, byteEnd: chapterIndex * 10 + 9 }],
    }],
  })), 2, { providerId: config.providerId, model: config.model }, limits);
  const frozen = { contractVersion: FULL_BOOK_PLAN_JOB_CONTRACT_VERSION, bookId: "book_a", storyBible,
    episodeCount: 2, intervals, limits } as const;
  return { ...frozen, providerId: config.providerId, model: config.model,
    requestHash: fullBookPlanJobRequestHash(frozen) };
}

function v1Payload(): FullBookPlanJobPayload {
  const storyBible = { id: "bible_a", contentHash: "b".repeat(64) };
  const legacyChapters = [0, 1].map((chapterIndex) => ({
    chapterId: `chapter_${chapterIndex}`, chapterIndex,
    sourceEvents: [{
      id: `event_${chapterIndex}`, contentHash: `${chapterIndex + 1}`.repeat(64), inputBytes: 10,
      chapterId: `chapter_${chapterIndex}`, chapterIndex,
      byteRanges: [{ byteStart: chapterIndex * 10, byteEnd: chapterIndex * 10 + 9 }],
    }],
  }));
  const intervals = buildFullBookPlanIntervalRequests("book_a", storyBible,
    legacyChapters as unknown as Parameters<typeof buildFullBookPlanIntervalRequests>[2],
    2, { providerId: config.providerId, model: config.model }, limits,
  FULL_BOOK_PLAN_JOB_V1_CONTRACT_VERSION);
  const frozen = { contractVersion: FULL_BOOK_PLAN_JOB_V1_CONTRACT_VERSION, bookId: "book_a", storyBible,
    episodeCount: 2, intervals, limits } as const;
  return { ...frozen, providerId: config.providerId, model: config.model,
    requestHash: fullBookPlanJobRequestHash(frozen) };
}

function plan(events: string[]) {
  return { episodes: events.map((event, index) => ({
    index: index + 1, title: `第 ${index + 1} 集`, storyArc: "忠实覆盖原文事件",
    sourceEventIds: [event], recap: null, nextHook: null,
  })) };
}

function streamedPlanResponse(value: unknown) {
  const delta = JSON.stringify({ type: "response.output_text.delta", delta: JSON.stringify(value) });
  return new Response(`data: ${delta}\n\ndata: {"type":"response.completed"}\n\n`, {
    status: 200, headers: { "content-type": "text/event-stream; charset=utf-8" },
  });
}

function context(task: FullBookPlanJobPayload, saved = new Map<string, {
  jobId: string; stage: string; scopeKey: string; inputHash: string; completedAt: number; output?: unknown;
}>()) {
  const checkpoints: string[] = [];
  const progress: number[] = [];
  return {
    checkpoints, progress,
    value: {
      job: { id: `job_${task.requestHash}`, type: FULL_BOOK_PLAN_JOB_TYPE, payload: task, attempts: 1 },
      reportProgress: (value: number) => { progress.push(value); },
      isCancellationRequested: () => false,
      throwIfCancellationRequested: () => undefined,
      getCheckpoint: (stage: string, scopeKey: string) => saved.get(`${stage}:${scopeKey}`),
      commitCheckpoint: (stage: string, scopeKey: string, inputHash: string, _writer: unknown, output?: unknown) => {
        checkpoints.push(`${stage}:${scopeKey}`);
        const checkpoint = { jobId: "job", stage, scopeKey, inputHash, completedAt: 1, output };
        saved.set(`${stage}:${scopeKey}`, checkpoint);
        return { checkpoint,
          created: true, replaced: false };
      },
    } as unknown as JobExecutionContext,
  };
}

test("依次执行 interval 并确定性归并恰好 N 集的服务端验证计划", async (t) => {
  let gateRuns = 0;
  t.mock.method(textModelConcurrencyGate, "run", async (_signal: AbortSignal | undefined, task: () => Promise<unknown>) => {
    gateRuns += 1; return task();
  });
  const task = payload();
  const calls: string[] = [];
  const modelInputs: unknown[] = [];
  const streamFlags: unknown[] = [];
  const responses = [plan(["event_0"]), plan(["event_1"])];
  let index = 0;
  const fetchImpl = async (_input: string | URL | Request, init?: RequestInit) => {
    const request = JSON.parse(String(init?.body)) as { input: string };
    streamFlags.push((request as { stream?: unknown }).stream);
    const prompt = request.input.split("\n").at(-1)!;
    const modelInput = JSON.parse(prompt) as { kind: string };
    modelInputs.push(modelInput);
    calls.push(modelInput.kind);
    return new Response(JSON.stringify({ output_text: JSON.stringify(responses[index++]) }), { status: 200 });
  };
  const execution = context(task);
  const result = await createFullBookPlanJobHandler(config, { fetchImpl: fetchImpl as typeof fetch })(execution.value) as {
    plan: { episodes: unknown[] }; validation: { episodeCount: number; intervalQuotas: unknown[] };
  };
  assert.deepEqual(calls, ["interval", "interval"]);
  assert.equal(gateRuns, 2);
  const modelBody = JSON.stringify(modelInputs);
  assert.match(modelBody, /"eventType":"revelation"/u);
  assert.match(modelBody, /"payload":\{"summary":"第 0 章事件"\}/u);
  for (const forbidden of ["contentHash", "inputBytes", "byteRanges", "identityHash", "provenance", "chapterId"]) {
    assert.doesNotMatch(modelBody, new RegExp(forbidden, "u"));
  }
  assert.deepEqual(streamFlags, [true, true]);
  assert.equal(result.plan.episodes.length, 2);
  assert.equal(result.validation.episodeCount, 2);
  assert.equal(result.validation.intervalQuotas.length, 2);
  assert.deepEqual(execution.progress, [1 / 3, 2 / 3, 1]);
  assert.equal(execution.checkpoints.length, 3);
});

test("按当前书籍流水线配置并发 interval，全部完成后才执行 final", async () => {
  const task = payload();
  const execution = context(task);
  let inFlight = 0;
  let peak = 0;
  let intervalStarted = 0;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const database = {
    prepare: () => ({ get: (_jobId: string, stage: string) => {
      assert.equal(stage, "episode_plan");
      return { value: 2 };
    } }),
  } as unknown as DatabaseSync;
  const fetchImpl = async (_input: string | URL | Request, init?: RequestInit) => {
    const request = JSON.parse(String(init?.body)) as { input: string };
    const input = JSON.parse(request.input.split("\n").at(-1)!) as {
      kind: "interval";
      sourceEvents?: Array<{ id: string }>;
    };
    inFlight += 1;
    peak = Math.max(peak, inFlight);
    intervalStarted += 1;
    if (intervalStarted === task.intervals.length) release();
    await gate;
    inFlight -= 1;
    return Response.json({ output_text: JSON.stringify(plan([input.sourceEvents![0]!.id])) });
  };
  await createFullBookPlanJobHandler(config, { database, fetchImpl: fetchImpl as typeof fetch })(execution.value);
  assert.equal(peak, 2);
  assert.deepEqual(execution.progress.slice().sort((left, right) => left - right), [1 / 3, 2 / 3, 1]);
});

test("全书规划只在流式成功终态后解析", async () => {
  const responses = [plan(["event_0"]), plan(["event_1"])];
  let calls = 0;
  const fetchImpl = (async () => streamedPlanResponse(responses[calls++])) as typeof fetch;
  const result = await createFullBookPlanJobHandler(config, { fetchImpl })(context(payload()).value) as {
    plan: { episodes: unknown[] };
  };
  assert.equal(calls, 2);
  assert.equal(result.plan.episodes.length, 2);
});

test("瞬时 HTTP 与上游流失败在单区间内有界重试", async () => {
  const failures = [
    () => new Response("busy", { status: 524 }),
    () => new Response('data: {"type":"response.failed","response":{"error":{"code":"internal_server_error","message":"websocket: close 1006 (abnormal closure): unexpected EOF"}}}\n\n',
      { headers: { "content-type": "text/event-stream" } }),
  ];
  for (const failure of failures) {
    const dataRoot = await mkdtemp(join(tmpdir(), "narralume-plan-retry-"));
    let calls = 0;
    const fetchImpl = (async (_input: string | URL | Request, init?: RequestInit) => {
      calls += 1;
      if (calls < FULL_BOOK_PLAN_MODEL_MAX_ATTEMPTS) return failure();
      const body = JSON.parse(String(init?.body)) as { input: string };
      const input = JSON.parse(body.input.split("\n").at(-1)!) as {
        kind: "interval"; sourceEvents: Array<{ id: string }>;
      };
      const events = [input.sourceEvents[0]!.id];
      return Response.json({ output_text: JSON.stringify(plan(events)) });
    }) as typeof fetch;
    try {
      await createFullBookPlanJobHandler(config, { fetchImpl, retryDelayMs: 0, dataRoot })(context(payload()).value);
      assert.equal(calls, FULL_BOOK_PLAN_MODEL_MAX_ATTEMPTS + 1);
      const directory = join(dataRoot, "diagnostics", "text-model");
      const products = await readdir(directory);
      assert.equal(products.length, FULL_BOOK_PLAN_MODEL_MAX_ATTEMPTS - 1);
      const saved = await Promise.all(products.map(async (name) => JSON.parse(await readFile(join(directory, name), "utf8"))));
      assert.deepEqual(saved.map((item) => item.stage).sort(), [
        `${FULL_BOOK_PLAN_JOB_TYPE}:interval:${payload().intervals[0]!.identityHash}:initial:transport-attempt-1`,
        `${FULL_BOOK_PLAN_JOB_TYPE}:interval:${payload().intervals[0]!.identityHash}:initial:transport-attempt-2`,
      ]);
    } finally {
      await rm(dataRoot, { recursive: true, force: true });
    }
  }
});

test("已验证区间与 final 输出持久后重试不再调用模型", async () => {
  const task = payload();
  const saved = new Map<string, {
    jobId: string; stage: string; scopeKey: string; inputHash: string; completedAt: number; output?: unknown;
  }>();
  const responses = [plan(["event_0"]), plan(["event_1"])];
  let calls = 0;
  const fetchImpl = (async () => {
    calls += 1;
    return Response.json({ output_text: JSON.stringify(responses.shift()) });
  }) as typeof fetch;
  await createFullBookPlanJobHandler(config, { fetchImpl })(context(task, saved).value);
  assert.equal(calls, 2);

  const restored = context(task, saved);
  const result = await createFullBookPlanJobHandler(config, {
    fetchImpl: (async () => { throw new Error("不应再调用模型"); }) as typeof fetch,
  })(restored.value) as { plan: { episodes: unknown[] } };
  assert.equal(result.plan.episodes.length, 2);
  assert.deepEqual(restored.progress, [2 / 3, 1]);
});

test("冻结的 v1 payload 与 checkpoint 按原 identity 恢复且不重新调用模型", async () => {
  const task = v1Payload();
  assert.equal(task.intervals[0]!.identity.promptVersion, FULL_BOOK_PLAN_JOB_V1_PROMPT_VERSION);
  assert.deepEqual(task.intervals.map(({ identityHash }) => identityHash), [
    "256091bf857dca9ea4bcb7994a89ebf061ff147a146a159fe7df9dc5274a1b24",
    "b68479180833475e0177e6bf84bbb0b0d6b2ad5d8462e3819bf33ec2ae6af075",
  ]);
  assert.equal(task.requestHash, "8eb8cd87fc5e85ef15eecbb6a06bf890855e3a79c745a553cf5290e589dc3876");
  const verified = task.intervals.map((request, index) =>
    parseFullBookPlanIntervalResponse(request, plan([`event_${index}`])));
  const finalRequest = buildFullBookPlanFinalRequest(
    task.bookId, task.storyBible, task.episodeCount, verified,
    { providerId: task.providerId, model: task.model }, task.limits,
  );
  assert.equal(finalRequest.identityHash, "5696dfc1fa86f70dd578c2206e923b91247ef339c485bfab880c66c4a17213e3");
  const final = { episodes: verified.flatMap(({ content }) => content.episodes)
    .map((episode, index) => ({ ...episode, index: index + 1 })) };
  const saved = new Map(task.intervals.map((request, index) => [
    `full-book-plan-interval:${request.identityHash}`,
    { jobId: "job_v1", stage: "full-book-plan-interval", scopeKey: request.identityHash,
      inputHash: request.identityHash, completedAt: 1, output: verified[index]!.content },
  ]));
  saved.set(`full-book-plan-final:${finalRequest.identityHash}`,
    { jobId: "job_v1", stage: "full-book-plan-final", scopeKey: finalRequest.identityHash,
      inputHash: finalRequest.identityHash, completedAt: 1, output: final });

  const execution = context(task, saved);
  const result = await createFullBookPlanJobHandler(config, {
    fetchImpl: (async () => { throw new Error("v1 checkpoint 恢复不应重新调用模型"); }) as typeof fetch,
  })(execution.value) as { identityHash: string; plan: { episodes: unknown[] } };
  assert.equal(result.identityHash, finalRequest.identityHash);
  assert.equal(result.plan.episodes.length, 2);
  assert.deepEqual(execution.checkpoints, []);
});

test("并发 permit 覆盖响应正文消费", async (t) => {
  let held = false;
  t.mock.method(textModelConcurrencyGate, "run", async (_signal: AbortSignal | undefined, task: () => Promise<unknown>) => {
    held = true;
    try { return await task(); }
    finally { held = false; }
  });
  const responses = [plan(["event_0"]), plan(["event_1"])];
  const fetchImpl = (async () => new Response(new ReadableStream({
    pull(controller) {
      assert.equal(held, true);
      controller.enqueue(new TextEncoder().encode(JSON.stringify({ output_text: JSON.stringify(responses.shift()) })));
      controller.close();
    },
  }))) as typeof fetch;
  await createFullBookPlanJobHandler(config, { fetchImpl })(context(payload()).value);
  assert.equal(held, false);
});

test("流式响应无成功终态时不纠错", async () => {
  let calls = 0;
  const fetchImpl = (async () => {
    calls += 1;
    return new Response('data: {"type":"response.output_text.delta","delta":"{}"}\n\n', {
      headers: { "content-type": "text/event-stream" },
    });
  }) as typeof fetch;
  await assert.rejects(
    () => createFullBookPlanJobHandler(config, { fetchImpl })(context(payload()).value),
    /没有明确成功终态/,
  );
  assert.equal(calls, 1);
});

test("冻结 identity 被篡改时在模型调用前失败", async () => {
  const task = payload();
  task.intervals[0]!.sourceEvents[0]!.contentHash = "f".repeat(64);
  let called = false;
  const handler = createFullBookPlanJobHandler(config, {
    fetchImpl: (async () => { called = true; return new Response(); }) as typeof fetch,
  });
  await assert.rejects(() => handler(context(task).value), /冻结身份不一致/);
  assert.equal(called, false);
});

test("伪造来源或破坏配额的模型结果在返回 Store 前失败", async () => {
  for (const forged of [plan(["event_forged"]), plan(["event_0", "event_1"])]) {
    const task = payload();
    let calls = 0;
    const fetchImpl = (async () => {
      calls += 1;
      return new Response(JSON.stringify({ output_text: JSON.stringify(forged) }), { status: 200 });
    }) as typeof fetch;
    await assert.rejects(() => createFullBookPlanJobHandler(config, { fetchImpl })(context(task).value));
    assert.equal(calls, 2);
  }
});

test("首答回显包装字段时仅纠错一次，并使用同一任务与精确 schema", async () => {
  const task = payload();
  const prompts: string[] = [];
  const responses = [
    { kind: "interval", identityHash: "x", start: 0, end: 0, episodeCount: 1, ...plan(["event_0"]) },
    plan(["event_0"]),
    plan(["event_1"]),
  ];
  const fetchImpl = (async (_input: string | URL | Request, init?: RequestInit) => {
    const request = JSON.parse(String(init?.body)) as { input: string };
    prompts.push(request.input);
    return new Response(JSON.stringify({ output_text: JSON.stringify(responses.shift()) }), { status: 200 });
  }) as typeof fetch;
  const result = await createFullBookPlanJobHandler(config, { fetchImpl })(context(task).value) as {
    plan: { episodes: unknown[] };
  };
  assert.equal(result.plan.episodes.length, 2);
  assert.equal(prompts.length, 3);
  assert.match(prompts[0]!, /唯一允许的输出 schema.*\{episodes:\[\{index:number,title:string,storyArc:string,sourceEventIds:string\[\],recap:string\|null,nextHook:string\|null\}\]\}/u);
  assert.match(prompts[1]!, /包含未知字段/u);
  assert.equal(prompts[0]!.split("\n").at(-1), prompts[1]!.split("\n").at(-1));
});

test("纠错答仍非法时不发起第三次请求", async () => {
  const task = payload();
  let calls = 0;
  const fetchImpl = (async () => {
    calls += 1;
    return new Response(JSON.stringify({ output_text: JSON.stringify({ kind: "interval", ...plan(["event_0"]) }) }));
  }) as typeof fetch;
  await assert.rejects(() => createFullBookPlanJobHandler(config, { fetchImpl })(context(task).value), /未知字段/u);
  assert.equal(calls, 2);
});

test("非瞬时 HTTP、非 JSON 与 abort 错误不触发合同纠错或重试", async () => {
  const cases: Array<{ fetchImpl: typeof fetch; message: RegExp }> = [
    { fetchImpl: (async () => new Response("bad request", { status: 400 })) as typeof fetch, message: /HTTP 400/u },
    { fetchImpl: (async () => new Response("not json")) as typeof fetch, message: /无效 JSON/u },
    { fetchImpl: (async () => { throw new DOMException("aborted", "AbortError"); }) as typeof fetch, message: /aborted/u },
  ];
  for (const item of cases) {
    let calls = 0;
    const fetchImpl = (async (...args: Parameters<typeof fetch>) => {
      calls += 1;
      return item.fetchImpl(...args);
    }) as typeof fetch;
    await assert.rejects(() => createFullBookPlanJobHandler(config, { fetchImpl })(context(payload()).value), item.message);
    assert.equal(calls, 1);
  }
});
