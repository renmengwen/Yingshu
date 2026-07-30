import assert from "node:assert/strict";
import test from "node:test";

import {
  createOpenAiResponsesChapterBatchAnalyzer,
  createOpenAiResponsesChapterAnalyzer,
  limitedJson,
  limitedResponseText,
  MAX_CHAPTER_BATCH_INPUT_BYTES,
  parseChapterBatchAnalysisEvents,
  prepareChapterBatchPrompt,
  parseChapterAnalysisEvents,
  textModelRequest,
  type ChapterEvidenceAtom,
} from "./chapter-event-analyzer.js";
import { TEXT_MODEL_REQUEST_CONCURRENCY } from "./text-model-concurrency.js";
import { TextModelCallError, TextModelStreamError } from "./text-model-stream.js";

test("普通 JSON fallback 失败也保留响应格式、请求 ID 和有界正文", async () => {
  const response = new Response("{bad-json", {
    headers: { "content-type": "application/json", "x-request-id": "fallback-request" },
  });
  await assert.rejects(() => limitedJson(response, { protocol: "openai-response" }), (error: Error) => {
    assert.ok(error instanceof TextModelStreamError);
    assert.equal(error.statistics.responseFormat, "json");
    assert.equal(error.statistics.requestIds["x-request-id"], "fallback-request");
    assert.equal(error.partialText, "{bad-json");
    return true;
  });
});

test("普通 JSON fallback 读取中断或缺少正文时保留已获得的证据", async () => {
  const encoder = new TextEncoder();
  let first = true;
  const interrupted = new Response(new ReadableStream<Uint8Array>({
    pull(controller) {
      if (first) {
        first = false;
        controller.enqueue(encoder.encode('{"output_text":"partial'));
      } else {
        controller.error(new Error("reader failed"));
      }
    },
  }), { headers: { "x-request-id": "reader-request" } });
  await assert.rejects(() => limitedJson(interrupted), (error: Error) => {
    assert.ok(error instanceof TextModelStreamError);
    assert.equal(error.statistics.requestIds["x-request-id"], "reader-request");
    assert.match(error.partialText, /partial/u);
    return true;
  });

  await assert.rejects(() => limitedResponseText(new Response("{}", {
    headers: { "content-type": "application/json", "x-request-id": "envelope-request" },
  })), (error: Error) => {
    assert.ok(error instanceof TextModelStreamError);
    assert.equal(error.statistics.responseFormat, "json");
    assert.equal(error.statistics.requestIds["x-request-id"], "envelope-request");
    assert.equal(error.partialText, "{}");
    return true;
  });
});

test("文本模型请求默认保持非流式，只有显式选择才发送 stream", () => {
  const normal = JSON.parse(textModelRequest({
    baseUrl: "https://model.example/v1", apiKey: "key", model: "model", providerId: "provider",
  }, "input").body) as Record<string, unknown>;
  assert.equal("stream" in normal, false);
});

test("文本模型请求按协议发送任务级输出上限并保持流式", () => {
  const responses = JSON.parse(textModelRequest({
    baseUrl: "https://model.example/v1", apiKey: "key", model: "model", providerId: "provider",
  }, "input", 32768, true).body) as Record<string, unknown>;
  const messages = JSON.parse(textModelRequest({
    baseUrl: "https://model.example/v1", apiKey: "key", model: "model", providerId: "provider",
    protocol: "anthropic-message",
  }, "input", 8192, true).body) as Record<string, unknown>;
  assert.equal(responses.max_output_tokens, 32768);
  assert.equal(responses.stream, true);
  assert.equal("max_tokens" in responses, false);
  assert.equal(messages.max_tokens, 8192);
  assert.equal(messages.stream, true);
  assert.equal("max_output_tokens" in messages, false);
});

test("新章节分析在冻结输入前按固定优先级追加产品要求与本书要求", () => {
  const prepared = prepareChapterBatchPrompt([{
    chapterId: "chapter-1",
    atoms: [{ id: "source", byteStart: 0, byteEnd: 3, text: "原文" }],
  }], "保留本书第一人称叙事距离");
  const product = prepared.prompt.indexOf("你负责把小说章节转换为可追溯的结构化事件");
  const book = prepared.prompt.indexOf("保留本书第一人称叙事距离");
  const input = prepared.prompt.indexOf("章节原文证据");
  assert.ok(product >= 0 && product < book && book < input);
});

const atoms: ChapterEvidenceAtom[] = [
  { id: "evidence_a", byteStart: 100, byteEnd: 112, text: "吴邪进入墓道" },
  { id: "evidence_b", byteStart: 120, byteEnd: 132, text: "血尸突然出现" },
];

test("自动分析只把已冻结 evidenceId 映射为服务端字节范围", () => {
  assert.deepEqual(parseChapterAnalysisEvents(JSON.stringify({
    events: [{
      type: "causality",
      payload: { cause: "吴邪进入墓道", effect: "血尸出现" },
      evidenceIds: ["evidence_a", "evidence_b"],
    }],
  }), atoms), [{
    type: "causality",
    payload: { cause: "吴邪进入墓道", effect: "血尸出现" },
    sources: [{ byteStart: 100, byteEnd: 112 }, { byteStart: 120, byteEnd: 132 }],
  }]);
});

test("自动分析拒绝未知、重复 evidenceId 和模型字节偏移", () => {
  assert.throws(() => parseChapterAnalysisEvents(JSON.stringify({
    events: [{ type: "location", payload: { name: "墓道" }, evidenceIds: ["evidence_missing"] }],
  }), atoms), /未知证据 ID/);
  assert.throws(() => parseChapterAnalysisEvents(JSON.stringify({
    events: [{ type: "location", payload: { name: "墓道" }, evidenceIds: ["evidence_a", "evidence_a"] }],
  }), atoms), /重复引用/);
  assert.throws(() => parseChapterAnalysisEvents(JSON.stringify({
    events: [{ type: "location", payload: { name: "墓道" }, byteStart: 0, byteEnd: 1 }],
  }), atoms), /必须引用/);
});

const config = {
  baseUrl: "https://model.example/v1",
  apiKey: "key",
  model: "model",
  providerId: "provider",
};

function modelResponse(value: unknown) {
  return new Response(JSON.stringify({ output_text: typeof value === "string" ? value : JSON.stringify(value) }));
}

function streamedModelResponse(value: unknown) {
  const delta = JSON.stringify({
    type: "response.output_text.delta",
    delta: typeof value === "string" ? value : JSON.stringify(value),
  });
  return new Response(`data: ${delta}\n\ndata: {"type":"response.completed"}\n\n`, {
    headers: { "content-type": "text/event-stream" },
  });
}

test("证据合同错误直接失败且不复制付费请求", async () => {
  let calls = 0;
  const analyzer = createOpenAiResponsesChapterAnalyzer(config, (async () => {
    calls += 1;
    return modelResponse({ events: [{ type: "location", payload: { name: "墓道" }, evidenceIds: ["e_missing"] }] });
  }) as typeof fetch);

  await assert.rejects(() => analyzer({ chapterId: "chapter", atoms }), /未知证据 ID/);
  assert.equal(calls, 1);
});

test("章节分析合同错误携带调用阶段和有界模型证据", async () => {
  const analyzer = createOpenAiResponsesChapterAnalyzer(config, (async () => streamedModelResponse({
    events: [{ type: "location", payload: { name: "墓道" }, evidenceIds: ["e_missing"] }],
  })) as typeof fetch);
  let caught: unknown;
  try { await analyzer({ chapterId: "chapter-evidence", atoms }); }
  catch (error) { caught = error; }

  assert.ok(caught instanceof TextModelCallError);
  assert.equal(caught.stage, "chapter-analysis:chapter-evidence");
  assert.match(caught.evidence.partialText ?? "", /e_missing/);
  assert.equal(caught.evidence.statistics?.terminalReceived, true);
});

test("HTTP 和非 JSON 错误不触发证据纠错请求", async () => {
  for (const response of [new Response("failed", { status: 500 }), modelResponse("not-json")]) {
    let calls = 0;
    const analyzer = createOpenAiResponsesChapterAnalyzer(config, (async () => {
      calls += 1;
      return response;
    }) as typeof fetch);
    await assert.rejects(() => analyzer({ chapterId: "chapter", atoms }));
    assert.equal(calls, 1);
  }
});

test("Abort 后不触发证据纠错请求", async () => {
  const controller = new AbortController();
  let calls = 0;
  const analyzer = createOpenAiResponsesChapterAnalyzer(config, (async () => {
    calls += 1;
    controller.abort();
    return modelResponse({ events: [{ type: "location", payload: { name: "墓道" }, evidenceIds: ["e_missing"] }] });
  }) as typeof fetch);

  await assert.rejects(() => analyzer({ chapterId: "chapter", atoms, signal: controller.signal }), /未知证据 ID/);
  assert.equal(calls, 1);
});

test("文本模型闸门排队取消后不发送章节分析请求", async () => {
  const releases: Array<() => void> = [];
  let calls = 0;
  const analyzer = createOpenAiResponsesChapterAnalyzer(config, (async () => {
    calls += 1;
    const delta = JSON.stringify({ type: "response.output_text.delta", delta: JSON.stringify({ events: [] }) });
    return new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        releases.push(() => {
          controller.enqueue(new TextEncoder().encode(`data: ${delta}\n\ndata: {"type":"response.completed"}\n\n`));
          controller.close();
        });
      },
    }), { headers: { "content-type": "text/event-stream" } });
  }) as typeof fetch);
  const running = Array.from({ length: TEXT_MODEL_REQUEST_CONCURRENCY }, (_, index) => analyzer({ chapterId: `chapter-${index}`, atoms }));
  while (calls < TEXT_MODEL_REQUEST_CONCURRENCY) await new Promise((resolve) => setImmediate(resolve));

  const queued = analyzer({ chapterId: "chapter-queued", atoms });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls, TEXT_MODEL_REQUEST_CONCURRENCY);

  const controller = new AbortController();
  const cancelled = analyzer({ chapterId: "chapter-cancelled", atoms, signal: controller.signal });
  controller.abort(new Error("cancelled while queued"));
  await assert.rejects(cancelled, /cancelled while queued/);
  assert.equal(calls, TEXT_MODEL_REQUEST_CONCURRENCY);

  releases.shift()!();
  while (calls < TEXT_MODEL_REQUEST_CONCURRENCY + 1) await new Promise((resolve) => setImmediate(resolve));
  releases.splice(0).forEach((release) => release());
  await Promise.all([...running, queued]);
});

test("单章全部证据只请求一次并稳定分配 occurrence", async () => {
  const repeatedAtoms = Array.from({ length: 11 }, (_, index): ChapterEvidenceAtom => ({
    id: `evidence_${index}`,
    byteStart: index === 10 ? 100 : 100 + index * 20,
    byteEnd: index === 10 ? 112 : 112 + index * 20,
    text: `原子-${index}`,
  }));
  const reply = { events: [
    { type: "location", payload: { name: "地点甲" }, evidenceIds: ["e1"] },
    { type: "location", payload: { name: "地点乙" }, evidenceIds: ["e1"] },
    { type: "character", payload: { name: "人物甲" }, evidenceIds: ["e1"] },
    { type: "location", payload: { name: "地点丙" }, evidenceIds: ["e2"] },
    { type: "location", payload: { name: "地点丁" }, evidenceIds: ["e11"] },
  ] };
  const run = async () => {
    let calls = 0;
    let activity = 0;
    const analyzer = createOpenAiResponsesChapterAnalyzer(
      config,
      (async (_input, init) => {
        calls += 1;
        assert.match(String(init?.body), /e11/);
        return streamedModelResponse(reply);
      }) as typeof fetch,
    );
    const events = await analyzer({ chapterId: "chapter", atoms: repeatedAtoms, onActivity: () => { activity += 1; } });
    assert.equal(calls, 1);
    assert.ok(activity > 0);
    return events;
  };

  const first = await run();
  const second = await run();
  assert.deepEqual(first.map((event) => event.occurrence), [0, 1, 0, 0, 2]);
  assert.deepEqual(second, first);
});

test("多章单请求严格校验章节全集并拒绝跨章 evidence", async () => {
  const chapters = [
    { chapterId: "chapter-a", atoms: [{ ...atoms[0]!, id: "c1e1" }] },
    { chapterId: "chapter-b", atoms: [{ ...atoms[1]!, id: "c2e1" }] },
  ];
  assert.throws(() => parseChapterBatchAnalysisEvents(JSON.stringify({ chapters: [
    { chapterId: "chapter-a", events: [] },
    { chapterId: "chapter-a", events: [] },
  ] }), chapters), /重复包含章节/);
  assert.throws(() => parseChapterBatchAnalysisEvents(JSON.stringify({ chapters: [
    { chapterId: "chapter-a", events: [{ type: "location", payload: { name: "越界" }, evidenceIds: ["c2e1"] }] },
    { chapterId: "chapter-b", events: [] },
  ] }), chapters), /未知证据 ID/);

  let calls = 0;
  let requestBody: { stream?: unknown } | undefined;
  const analyzer = createOpenAiResponsesChapterBatchAnalyzer(config, (async (_input, init) => {
    calls += 1;
    requestBody = JSON.parse(String(init?.body)) as { stream?: unknown };
    return streamedModelResponse({ chapters: [
      { chapterId: "chapter-a", events: [{ type: "character", payload: { name: "吴邪" }, evidenceIds: ["c1e1"] }] },
      { chapterId: "chapter-b", events: [{ type: "location", payload: { name: "墓道" }, evidenceIds: ["c2e1"] }] },
    ] });
  }) as typeof fetch);
  const result = await analyzer({ chapters: [
    { chapterId: "chapter-a", atoms: [atoms[0]!] },
    { chapterId: "chapter-b", atoms: [atoms[1]!] },
  ] });
  assert.equal(calls, 1);
  assert.equal(requestBody?.stream, true);
  assert.deepEqual(result.map((item) => item.chapterId), ["chapter-a", "chapter-b"]);
});

test("多章分析合同错误携带批次章节身份和模型证据", async () => {
  const analyzer = createOpenAiResponsesChapterBatchAnalyzer(config, (async () => streamedModelResponse({
    chapters: [{ chapterId: "chapter-a", events: [] }],
  })) as typeof fetch);
  let caught: unknown;
  try {
    await analyzer({ chapters: [
      { chapterId: "chapter-a", atoms: [atoms[0]!] },
      { chapterId: "chapter-b", atoms: [atoms[1]!] },
    ] });
  } catch (error) { caught = error; }

  assert.ok(caught instanceof TextModelCallError);
  assert.equal(caught.stage, "chapter-analysis-batch:chapter-a,chapter-b");
  assert.match(caught.evidence.partialText ?? "", /chapter-a/);
  assert.equal(caught.evidence.statistics?.terminalReceived, true);
});

test("批次预算使用最终 JSON prompt 的真实 UTF-8 字节数并执行 512 KiB 边界", () => {
  const escaped = Array.from({ length: 1_000 }, (_, index): ChapterEvidenceAtom => ({
    id: `raw-${index}`,
    byteStart: index,
    byteEnd: index + 1,
    text: `短句\"\\\u0000-${index}\n`,
  }));
  const escapedPrompt = prepareChapterBatchPrompt([{ chapterId: "chapter-转义", atoms: escaped }]);
  assert.equal(escapedPrompt.bytes, Buffer.byteLength(escapedPrompt.prompt, "utf8"));
  assert.equal(escapedPrompt.prompt.includes('短句\\\"\\\\\\u0000'), true);

  const bytes = (length: number) => prepareChapterBatchPrompt([{
    chapterId: "chapter-boundary",
    atoms: [{ id: "raw", byteStart: 0, byteEnd: length, text: "a".repeat(length) }],
  }]).bytes;
  let low = 0;
  let high = MAX_CHAPTER_BATCH_INPUT_BYTES;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (bytes(middle) <= MAX_CHAPTER_BATCH_INPUT_BYTES) low = middle;
    else high = middle - 1;
  }
  assert.equal(bytes(low) <= MAX_CHAPTER_BATCH_INPUT_BYTES, true);
  assert.equal(bytes(low + 1) > MAX_CHAPTER_BATCH_INPUT_BYTES, true);
});
