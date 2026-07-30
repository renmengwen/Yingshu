import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import { canonicalBookStoryBibleJson, type BookStoryBibleContent } from "./book-story-bible-contract.js";
import {
  BOOK_STORY_BIBLE_JOB_TYPE,
  BOOK_STORY_BIBLE_IDLE_TIMEOUT_MS,
  BOOK_STORY_BIBLE_TIMEOUT_MS,
  BOOK_STORY_BIBLE_TOTAL_TIMEOUT_MS,
  createBookStoryBibleJobHandler,
  storyBibleJobRequestHash,
  type BookStoryBibleJobPayload,
} from "./book-story-bible-job-handler.js";
import {
  BOOK_STORY_BIBLE_JOB_CONTRACT_VERSION,
  buildStoryBibleIntervalRequests,
  parseStoryBibleIntervalResponse,
  type StoryBibleBuildLimits,
} from "./book-story-bible-job.js";
import { JobCancelledError, type JobExecutionContext } from "./job-worker.js";
import { PRODUCT_PROMPT_VERSIONS } from "./product-prompts.js";
import { textModelConcurrencyGate } from "./text-model-concurrency.js";

const limits: StoryBibleBuildLimits = {
  maxChaptersPerInterval: 1, maxEventsPerInterval: 1, maxInputBytesPerInterval: 1_000,
  maxFinalIntervals: 2, maxFinalInputBytes: 100_000,
};
const config = {
  baseUrl: "https://model.invalid/v1", apiKey: "test", model: "model-a", providerId: "provider-a",
  protocol: "openai-response" as const,
};

test("故事圣经使用有限首事件、空闲与总时限", () => {
  assert.equal(BOOK_STORY_BIBLE_TIMEOUT_MS, 180_000);
  assert.equal(BOOK_STORY_BIBLE_IDLE_TIMEOUT_MS, 180_000);
  assert.equal(BOOK_STORY_BIBLE_TOTAL_TIMEOUT_MS, 900_000);
});

function content(sourceEventId: string, chapterId: string) {
  return {
    characters: [], relationships: [], locations: [], organizations: [], items: [], concepts: [],
    timeline: [{ summary: "已验证事件", chapterIds: [chapterId], sourceEventIds: [sourceEventId] }],
    flashbacks: [], plotThreads: [], confusingFacts: [], spoilerRestrictions: [], properNouns: [],
  };
}

function contentWithChapterReference(
  kind: "stateChanges" | "relationships" | "timeline" | "flashbacks" | "plotThreads",
  chapterId: string,
) {
  return {
    characters: kind === "stateChanges" ? [{
      canonicalName: "人物", aliases: [], identities: [], motivations: [],
      stateChanges: [{ state: "状态", chapterIds: [chapterId], sourceEventIds: ["event_0"] }],
      sourceEventIds: ["event_0"],
    }] : [],
    relationships: kind === "relationships" ? [{
      subject: "甲", object: "乙", relation: "认识", chapterIds: [chapterId], sourceEventIds: ["event_0"],
    }] : [],
    locations: [], organizations: [], items: [], concepts: [],
    timeline: [{
      summary: "已验证事件", chapterIds: [kind === "timeline" ? chapterId : "chapter_0"], sourceEventIds: ["event_0"],
    }],
    flashbacks: kind === "flashbacks" ? [{
      summary: "回忆", startChapterId: chapterId, endChapterId: chapterId, sourceEventIds: ["event_0"],
    }] : [],
    plotThreads: kind === "plotThreads" ? [{
      kind: "suspense", setup: "线索", revealCondition: null, resolution: null,
      chapterIds: [chapterId], sourceEventIds: ["event_0"],
    }] : [],
    confusingFacts: [], spoilerRestrictions: [], properNouns: [],
  };
}

function payload(chapterCount = 1): BookStoryBibleJobPayload {
  const intervals = buildStoryBibleIntervalRequests("book_a", Array.from({ length: chapterCount }, (_, chapterIndex) => ({
    chapterId: `chapter_${chapterIndex}`, chapterIndex,
    sourceEvents: [{ id: `event_${chapterIndex}`,
      contentHash: createHash("sha256").update(String(chapterIndex)).digest("hex"), inputBytes: 10 }],
  })), { providerId: config.providerId, model: config.model }, limits);
  const base = { contractVersion: BOOK_STORY_BIBLE_JOB_CONTRACT_VERSION, bookId: "book_a", intervals, limits,
    forceRebuild: false } as const;
  return { ...base, providerId: config.providerId, model: config.model, requestHash: storyBibleJobRequestHash(base) };
}

function database(concurrency = 1) {
  return { prepare: (sql: string) => ({
    all: (...ids: string[]) => ids.map((id) => ({
      id, chapter_id: id.replace("event", "chapter"), event_index: 0, occurrence: 1,
      event_type: "plot", payload_json: JSON.stringify({ summary: "事件摘要" }),
    })),
    get: () => sql.includes("MIN(run.chapter_concurrency)") ? { value: concurrency } : undefined,
  }) } as never;
}

function modelResponse(value: unknown) {
  return new Response(JSON.stringify({ output_text: JSON.stringify(value) }), {
    status: 200, headers: { "content-type": "application/json" },
  });
}

function streamedModelResponse(value: unknown) {
  const delta = JSON.stringify({ type: "response.output_text.delta", delta: JSON.stringify(value) });
  return new Response(`data: ${delta}\n\ndata: {"type":"response.completed"}\n\n`, {
    status: 200, headers: { "content-type": "text/event-stream; charset=utf-8" },
  });
}

function prompt(init?: RequestInit) {
  return (JSON.parse(String(init?.body)) as { input: string }).input;
}

function assertSlimPrompt(value: string, kind: "interval" | "final") {
  for (const forbidden of ["\"request\"", "identityHash", "contentHash", "providerId", "model", "eventIndex", "occurrence"]) {
    assert.equal(value.includes(forbidden), false, `模型输入不应包含 ${forbidden}`);
  }
  assert.match(value, /"chapterIds":\["chapter_0"\]/);
  assert.equal(value.match(/event_0/gu)?.length, 1);
  if (kind === "interval") {
    assert.match(value, /"sourceEvents":\[\{"chapterId":"chapter_0","eventType":"plot","id":"event_0","payload":\{"summary":"事件摘要"\}\}\]/);
  } else {
    assert.match(value, /"intervals":\[\{"content":\{/);
  }
}

function context(task: BookStoryBibleJobPayload, isCancelled: () => boolean = () => false) {
  const checkpoints: string[] = [];
  const progress: number[] = [];
  const value = {
    job: { id: `job_bible_${task.requestHash}`, type: BOOK_STORY_BIBLE_JOB_TYPE, payload: task },
    reportProgress: (item: number) => { progress.push(item); },
    isCancellationRequested: isCancelled,
    throwIfCancellationRequested: () => { if (isCancelled()) throw new JobCancelledError(); },
    getCheckpoint: () => undefined,
    commitCheckpoint: (stage: string, scopeKey: string) => {
      checkpoints.push(`${stage}:${scopeKey}`);
      return { checkpoint: { jobId: "job", stage, scopeKey, inputHash: scopeKey, completedAt: 1 }, created: true, replaced: false };
    },
  } as unknown as JobExecutionContext;
  return { value, checkpoints, progress };
}

test("严格执行 interval 后独立 final，并将模型身份仅保存为溯源", async (t) => {
  let gateRuns = 0;
  t.mock.method(textModelConcurrencyGate, "run", async (_signal: AbortSignal | undefined, task: () => Promise<unknown>) => {
    gateRuns += 1; return task();
  });
  const task = payload();
  const calls: string[] = [];
  const streamFlags: unknown[] = [];
  const stored: Array<Record<string, unknown>> = [];
  let responseIndex = 0;
  const responses = [content("event_0", "chapter_0"), content("event_0", "chapter_0")];
  const fetchImpl = async (_input: string | URL | Request, init?: RequestInit) => {
    calls.push(prompt(init));
    streamFlags.push((JSON.parse(String(init?.body)) as { stream?: unknown }).stream);
    return modelResponse(responses[responseIndex++]);
  };
  const createBible = ((_database: never, input: Record<string, unknown>) => {
    stored.push(input);
    return { id: `bible_${stored.length}`, contentHash: `${stored.length}`.repeat(64) };
  }) as never;
  const execution = context(task);
  const result = await createBookStoryBibleJobHandler(database(), config, { fetchImpl: fetchImpl as typeof fetch, createBible })(execution.value);
  assert.equal(calls.length, 2);
  assert.equal(gateRuns, 2);
  assert.deepEqual(streamFlags, [true, true]);
  assert.match(calls[0]!, /顶层必须恰好包含以下 12 个数组/);
  for (const key of ["characters", "relationships", "locations", "organizations", "items", "concepts", "timeline",
    "flashbacks", "plotThreads", "confusingFacts", "spoilerRestrictions", "properNouns"]) assert.match(calls[0]!, new RegExp(`${key}:`));
  assert.match(calls[0]!, /revealCondition:string\|null/);
  assert.match(calls[0]!, /"foreshadowing"\|"suspense"\|"revelation"/);
  assert.match(calls[0]!, /sourceEvents\[\]\.id 与 chapterIds 分别是唯一允许的 sourceEventIds 与 chapterIds/);
  assert.match(calls[1]!, /interval 与 final 使用完全相同的输出 schema/);
  assert.match(calls[1]!, /只能使用 intervals\[\]\.content 中已有的 sourceEventIds/);
  assertSlimPrompt(calls[0]!, "interval");
  assertSlimPrompt(calls[1]!, "final");
  assert.equal(stored.length, 2);
  assert.deepEqual(stored.at(-1)?.parentBibleIds, ["bible_1"]);
  assert.equal(stored[0]?.providerId, config.providerId);
  assert.deepEqual(execution.progress, [1 / 2, 1]);
  assert.equal(execution.checkpoints.length, 2);
  assert.deepEqual(result, { storyBibleId: "bible_2", contentHash: "2".repeat(64), intervalBibleIds: ["bible_1"] });
});

test("新全书世界观任务冻结产品版本与本书要求并按 interval/final 分层追加", async () => {
  const task = payload();
  task.prompt = {
    intervalProductVersion: PRODUCT_PROMPT_VERSIONS.storyBibleInterval,
    finalProductVersion: PRODUCT_PROMPT_VERSIONS.storyBibleFinal,
    profileRevision: 3,
    profileHash: "a".repeat(64),
    instructions: "保留本书的专有名词发音",
  };
  task.requestHash = storyBibleJobRequestHash(task);
  const calls: string[] = [];
  const fetchImpl = async (_input: string | URL | Request, init?: RequestInit) => {
    calls.push(prompt(init));
    return modelResponse(content("event_0", "chapter_0"));
  };
  let stored = 0;
  const createBible = (() => ({ id: `bible_${++stored}`, contentHash: String(stored).repeat(64) })) as never;
  await createBookStoryBibleJobHandler(database(), config, { fetchImpl: fetchImpl as typeof fetch, createBible })(context(task).value);

  assert.match(calls[0]!, /整理当前区间已经出现且有来源的稳定事实/u);
  assert.match(calls[1]!, /全书级归一、去重和冲突整理/u);
  assert.match(calls[0]!, /保留本书的专有名词发音/u);
  assert.match(calls[1]!, /保留本书的专有名词发音/u);
});

test("Story Bible 只在明确流终态后解析并持久化", async () => {
  let calls = 0;
  let writes = 0;
  const handler = createBookStoryBibleJobHandler(database(), config, {
    fetchImpl: (async () => { calls += 1; return streamedModelResponse(content("event_0", "chapter_0")); }) as typeof fetch,
    createBible: (() => { writes += 1; return { id: `bible_${writes}`, contentHash: "1".repeat(64) }; }) as never,
  });
  await handler(context(payload()).value);
  assert.equal(calls, 2);
  assert.equal(writes, 2);
});

test("故事圣经区间使用当前 run 配置的并发批次数并在全部完成后最终聚合", async () => {
  const task = payload(2);
  let active = 0;
  let peak = 0;
  let release!: () => void;
  const barrier = new Promise<void>((resolve) => { release = resolve; });
  let finalStarted = false;
  const handler = createBookStoryBibleJobHandler(database(2), config, {
    fetchImpl: (async (_input, init) => {
      const input = prompt(init);
      if (input.includes('"kind":"interval"')) {
        active += 1;
        peak = Math.max(peak, active);
        if (active === 2) release();
        await barrier;
        const index = input.includes("event_0") ? 0 : 1;
        active -= 1;
        return streamedModelResponse(content(`event_${index}`, `chapter_${index}`));
      }
      finalStarted = true;
      assert.equal(active, 0);
      return streamedModelResponse(content("event_0", "chapter_0"));
    }) as typeof fetch,
    createBible: ((_database: never, input: Record<string, unknown>) => ({
      id: `${String(input.scope)}_${String(input.sourceStartChapterId)}`,
      contentHash: "1".repeat(64),
    })) as never,
  });

  await handler(context(task).value);
  assert.equal(peak, 2);
  assert.equal(finalStarted, true);
});

test("故事圣经重试复用已完成区间并从 checkpoint 进度继续", async () => {
  const task = payload(2);
  const execution = context(task);
  execution.value.getCheckpoint = (stage: string, scopeKey: string) => stage === "book-story-bible-interval"
    ? { jobId: execution.value.job.id, stage, scopeKey, inputHash: scopeKey, completedAt: 1 } : undefined;
  let calls = 0;
  const handler = createBookStoryBibleJobHandler(database(2), config, {
    fetchImpl: (async () => {
      calls += 1;
      return streamedModelResponse(content("event_0", "chapter_0"));
    }) as typeof fetch,
    findBible: ((_database: never, input: { sourceStartChapterId: string }) => {
      const index = input.sourceStartChapterId.endsWith("_0") ? 0 : 1;
      const value = content(`event_${index}`, `chapter_${index}`);
      return {
        id: `interval_${index}`, content: value,
        contentHash: parseStoryBibleIntervalResponse(task.intervals[index]!, value).contentHash,
      };
    }) as never,
    createBible: ((_database: never, input: Record<string, unknown>) => ({
      id: String(input.scope), contentHash: "1".repeat(64),
    })) as never,
  });

  await handler(execution.value);
  assert.equal(calls, 1);
  assert.equal(execution.progress[0], 2 / 3);
  assert.deepEqual(execution.progress.at(-1), 1);
});

test("故事圣经按十路分层归并并整轮复用 checkpoint", async () => {
  const task = payload(11);
  task.limits = { ...task.limits, maxFinalIntervals: 11 };
  task.requestHash = storyBibleJobRequestHash(task);
  const calls: string[] = [];
  const stored: Array<Record<string, unknown> & {
    id: string; content: BookStoryBibleContent; contentHash: string;
  }> = [];
  const fetchImpl = (async (_input, init) => {
    const input = prompt(init);
    calls.push(input);
    const eventId = input.match(/event_\d+/u)?.[0] ?? "event_0";
    const chapterId = input.match(/chapter_\d+/u)?.[0] ?? "chapter_0";
    return streamedModelResponse(content(eventId, chapterId));
  }) as typeof fetch;
  const createBible = ((_database: never, input: Record<string, unknown>) => {
    const bibleContent = input.content as BookStoryBibleContent;
    const row = {
      ...input,
      id: `bible_${stored.length + 1}`,
      content: bibleContent,
      contentHash: createHash("sha256").update(canonicalBookStoryBibleJson(bibleContent)).digest("hex"),
    };
    stored.push(row);
    return row;
  }) as never;
  const findBible = ((_database: never, input: Record<string, unknown>) => stored.find((row) =>
    row.jobId === input.jobId && row.bookId === input.bookId && row.scope === input.scope &&
    row.sourceStartChapterId === input.sourceStartChapterId && row.sourceEndChapterId === input.sourceEndChapterId &&
    JSON.stringify(row.sourceEventIds) === JSON.stringify(input.sourceEventIds) &&
    JSON.stringify(row.parentBibleIds ?? []) === JSON.stringify(input.parentBibleIds ?? []))) as never;
  const handler = createBookStoryBibleJobHandler(database(), config, { fetchImpl, createBible, findBible });

  const first = context(task);
  const firstResult = await handler(first.value);
  assert.equal(calls.length, 13);
  assert.equal(stored.length, 13);
  assert.deepEqual(stored[11]?.parentBibleIds, Array.from({ length: 10 }, (_, index) => `bible_${index + 1}`));
  assert.deepEqual(stored[12]?.parentBibleIds, ["bible_12", "bible_11"]);
  assert.equal((JSON.parse(calls[12]!.match(/原任务：(.+)$/su)![1]!) as {
    intervals: unknown[];
  }).intervals.length, 2);

  const second = context(task);
  second.value.getCheckpoint = (stage: string, scopeKey: string) =>
    first.checkpoints.includes(`${stage}:${scopeKey}`)
      ? { jobId: second.value.job.id, stage, scopeKey, inputHash: scopeKey, completedAt: 1 }
      : undefined;
  const secondResult = await handler(second.value);
  assert.deepEqual(secondResult, firstResult);
  assert.equal(calls.length, 13);
  assert.equal(stored.length, 13);
});

test("Story Bible 在 Anthropic Messages 也显式请求流式输出", async () => {
  let body: Record<string, unknown> | undefined;
  const handler = createBookStoryBibleJobHandler(database(), { ...config, protocol: "anthropic-message" }, {
    fetchImpl: (async (_input, init) => {
      body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response("failed", { status: 503 });
    }) as typeof fetch,
  });
  await assert.rejects(() => handler(context(payload()).value), /HTTP 503/);
  assert.equal(body?.stream, true);
});

test("流式响应无成功终态时不纠错且不持久化 partial", async () => {
  let calls = 0;
  let writes = 0;
  const handler = createBookStoryBibleJobHandler(database(), config, {
    fetchImpl: (async () => {
      calls += 1;
      return new Response('data: {"type":"response.output_text.delta","delta":"{}"}\n\n', {
        headers: { "content-type": "text/event-stream" },
      });
    }) as typeof fetch,
    createBible: (() => { writes += 1; return { id: "x", contentHash: "1".repeat(64) }; }) as never,
  });
  await assert.rejects(() => handler(context(payload()).value), /没有明确成功终态/);
  assert.equal(calls, 1);
  assert.equal(writes, 0);
});

test("流式 reader 等待期间响应持久取消且不触发纠错", async () => {
  let cancelled = false;
  let calls = 0;
  const handler = createBookStoryBibleJobHandler(database(), config, {
    fetchImpl: (async () => {
      calls += 1;
      cancelled = true;
      return new Response(new ReadableStream<Uint8Array>(), {
        headers: { "content-type": "text/event-stream" },
      });
    }) as typeof fetch,
  });
  await assert.rejects(() => handler(context(payload(), () => cancelled).value), JobCancelledError);
  assert.equal(calls, 1);
});

test("未知字段仅受控纠错一次并保留最小原任务、精确 schema 与来源白名单", async () => {
  const task = payload();
  const calls: string[] = [];
  const invalid = { ...content("event_0", "chapter_0"), unexpected: [] };
  const responses = [invalid, content("event_0", "chapter_0"), content("event_0", "chapter_0")];
  let responseIndex = 0;
  const handler = createBookStoryBibleJobHandler(database(), config, {
    fetchImpl: (async (_input, init) => {
      calls.push(prompt(init));
      return streamedModelResponse(responses[responseIndex++]);
    }) as typeof fetch,
    createBible: ((_database: never, input: Record<string, unknown>) => ({
      id: String(input.scope), contentHash: "1".repeat(64),
    })) as never,
  });
  await handler(context(task).value);
  assert.equal(calls.length, 3);
  assert.match(calls[1]!, /上一次输出被严格合同拒绝/);
  assert.match(calls[1]!, /错误：全书世界观包含未知字段：unexpected/);
  assert.match(calls[1]!, /顶层必须恰好包含以下 12 个数组/);
  assert.match(calls[1]!, /原任务：\{"chapterIds":\["chapter_0"\],"kind":"interval"/);
  assertSlimPrompt(calls[1]!, "interval");
});

test("第二答仍含未知字段时原样失败且不会第三次请求或持久化", async () => {
  const task = payload();
  let calls = 0;
  let writes = 0;
  const invalid = { ...content("event_0", "chapter_0"), unexpected: [] };
  const handler = createBookStoryBibleJobHandler(database(), config, {
    fetchImpl: (async () => { calls += 1; return modelResponse(invalid); }) as typeof fetch,
    createBible: (() => { writes += 1; return { id: "x", contentHash: "1".repeat(64) }; }) as never,
  });
  await assert.rejects(() => handler(context(task).value), /未知字段：unexpected/);
  assert.equal(calls, 2);
  assert.equal(writes, 0);
});

test("interval 五类章节引用越界时均可纠错为当前章节", async (t) => {
  for (const kind of ["stateChanges", "relationships", "timeline", "flashbacks", "plotThreads"] as const) {
    await t.test(kind, async () => {
      const task = payload();
      let calls = 0;
      const responses = [
        contentWithChapterReference(kind, "chapter_outside"),
        content("event_0", "chapter_0"),
        content("event_0", "chapter_0"),
      ];
      const handler = createBookStoryBibleJobHandler(database(), config, {
        fetchImpl: (async () => modelResponse(responses[calls++])) as typeof fetch,
        createBible: ((_database: never, input: Record<string, unknown>) => ({
          id: String(input.scope), contentHash: "1".repeat(64),
        })) as never,
      });
      await handler(context(task).value);
      assert.equal(calls, 3);
    });
  }
});

test("final 纠错答仍引用越界章节时直接失败且不会第三次纠错", async () => {
  const task = payload();
  let calls = 0;
  let writes = 0;
  const responses = [
    content("event_0", "chapter_0"),
    content("event_0", "chapter_outside"),
    content("event_0", "chapter_outside"),
  ];
  const handler = createBookStoryBibleJobHandler(database(), config, {
    fetchImpl: (async () => modelResponse(responses[calls++])) as typeof fetch,
    createBible: (() => { writes += 1; return { id: "interval", contentHash: "1".repeat(64) }; }) as never,
  });
  await assert.rejects(() => handler(context(task).value), /未获准章节：chapter_outside/);
  assert.equal(calls, 3);
  assert.equal(writes, 1);
});

test("首答非法后若任务已取消，不会发出纠错请求", async () => {
  const task = payload();
  let calls = 0;
  let cancelled = false;
  const invalid = { ...content("event_0", "chapter_0"), unexpected: [] };
  const handler = createBookStoryBibleJobHandler(database(), config, {
    fetchImpl: (async () => { calls += 1; cancelled = true; return modelResponse(invalid); }) as typeof fetch,
  });
  await assert.rejects(() => handler(context(task, () => cancelled).value), JobCancelledError);
  assert.equal(calls, 1);
});

test("拒绝被篡改的冻结身份且不会调用模型", async () => {
  const task = payload();
  task.providerId = "switched-provider";
  let called = false;
  const handler = createBookStoryBibleJobHandler({} as never, config, {
    fetchImpl: (async () => { called = true; return new Response(); }) as typeof fetch,
  });
  await assert.rejects(() => handler(context(task).value), /身份不一致/);
  assert.equal(called, false);
});

test("模型输出合法时，冻结请求自检错误不会触发纠错", async () => {
  const task = payload();
  task.intervals[0]!.identity.promptVersion = "book-story-bible-prompt-v1";
  task.requestHash = storyBibleJobRequestHash(task);
  let calls = 0;
  const handler = createBookStoryBibleJobHandler(database(), config, {
    fetchImpl: (async () => { calls += 1; return modelResponse(content("event_0", "chapter_0")); }) as typeof fetch,
  });
  await assert.rejects(() => handler(context(task).value), /区间请求身份无效/);
  assert.equal(calls, 1);
});

test("模型伪造来源时在持久化前失败", async () => {
  const task = payload();
  let calls = 0;
  let writes = 0;
  const fetchImpl = (async () => { calls += 1; return modelResponse(content("event_forged", "chapter_0")); }) as typeof fetch;
  const handler = createBookStoryBibleJobHandler(database(), config, {
    fetchImpl, createBible: (() => { writes += 1; return { id: "x", contentHash: "1".repeat(64) }; }) as never,
  });
  await assert.rejects(() => handler(context(task).value), /未获准事件/);
  assert.equal(calls, 2);
  assert.equal(writes, 0);
});

test("HTTP、非 JSON 与 abort 错误均不触发纠错", async (t) => {
  const cases: Array<[string, () => Promise<Response>, RegExp]> = [
    ["HTTP", async () => new Response("failed", { status: 503 }), /HTTP 503/],
    ["非 JSON", async () => new Response(JSON.stringify({ output_text: "not-json" }), { status: 200 }), /无效 JSON/],
    ["abort", async () => { throw new DOMException("aborted", "AbortError"); }, /aborted/],
  ];
  for (const [name, response, expected] of cases) await t.test(name, async () => {
    let calls = 0;
    const handler = createBookStoryBibleJobHandler(database(), config, {
      fetchImpl: (async () => { calls += 1; return response(); }) as typeof fetch,
    });
    await assert.rejects(() => handler(context(payload()).value), expected);
    assert.equal(calls, 1);
  });
});

test("存储错误不触发模型纠错", async () => {
  let calls = 0;
  const handler = createBookStoryBibleJobHandler(database(), config, {
    fetchImpl: (async () => { calls += 1; return modelResponse(content("event_0", "chapter_0")); }) as typeof fetch,
    createBible: (() => { throw new Error("store failed"); }) as never,
  });
  await assert.rejects(() => handler(context(payload()).value), /store failed/);
  assert.equal(calls, 1);
});
