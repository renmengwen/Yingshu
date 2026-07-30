import assert from "node:assert/strict";
import test from "node:test";

import {
  streamedText,
  TextModelStreamError,
  type TextModelStreamStatistics,
} from "./text-model-stream.js";

const encoder = new TextEncoder();

function response(parts: Array<string | Uint8Array>, cancel?: () => void, headers?: HeadersInit) {
  return new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      for (const part of parts) controller.enqueue(typeof part === "string" ? encoder.encode(part) : part);
      controller.close();
    },
    cancel,
  }), { headers: { "content-type": "text/event-stream", ...headers } });
}

test("Responses SSE 支持任意 UTF-8 分片、三种换行、多行 data、注释和 DONE", async () => {
  const source = [
    "\uFEFF: ping\r",
    "event: response.output_text.delta\r\n",
    "data: {\"type\":\"response.output_text.delta\",\n",
    "data: \"delta\":\"墓道😀\"}\n\n",
    "data: [DONE]\r\r",
    "data: {\"type\":\"response.completed\"}\n\n",
  ].join("");
  const bytes = encoder.encode(source);
  const parts = Array.from(bytes, (_byte, index) => bytes.slice(index, index + 1));
  let activity = 0;
  assert.equal(await streamedText(response(parts), "openai-response", { onActivity: () => { activity += 1; } }), "墓道😀");
  assert.equal(activity, parts.length);
});

test("Anthropic SSE 聚合初始文本和 text_delta，并要求 message_stop", async () => {
  const body = [
    "event: content_block_start\n",
    "data: {\"type\":\"content_block_start\",\"content_block\":{\"type\":\"text\",\"text\":\"{\"}}\n\n",
    "data: {\"type\":\"ping\"}\n\n",
    "data: {\"type\":\"content_block_delta\",\"delta\":{\"type\":\"text_delta\",\"text\":\"}\"}}\n\n",
    "data: {\"type\":\"message_stop\"}\n\n",
  ].join("");
  assert.equal(await streamedText(response([body]), "anthropic-message"), "{}");
});

test("原始 SSE 超过 1MiB 但正文很小时可成功", async () => {
  const ignoredComment = `:${"x".repeat(512 * 1024)}\n`;
  const body = [
    ignoredComment,
    ignoredComment,
    ignoredComment,
    "data: {\"type\":\"response.output_text.delta\",\"delta\":\"{}\"}\n\n",
    "data: {\"type\":\"response.completed\"}\n\n",
  ];
  assert.equal(await streamedText(response(body), "openai-response"), "{}");
});

test("原始 SSE 超过 8MiB 仍失败", async () => {
  const ignoredComment = `:${"x".repeat(512 * 1024)}\n`;
  await assert.rejects(
    () => streamedText(response(Array.from({ length: 17 }, () => ignoredComment)), "openai-response"),
    /原始响应超过大小限制/,
  );
});

test("流式失败终态、截断、无效事件和超限均失败", async (t) => {
  const cases: Array<[string, Response, RegExp]> = [
    ["failed", response(["data: {\"type\":\"response.failed\"}\n\n"]), /失败终态/],
    ["incomplete", response(["data: {\"type\":\"response.incomplete\"}\n\n"]), /失败终态/],
    ["error", response(["data: {\"type\":\"error\"}\n\n"]), /失败终态/],
    ["missing terminal", response(["data: {\"type\":\"response.output_text.delta\",\"delta\":\"x\"}\n\n"]), /没有明确成功终态/],
    ["DONE without terminal", response(["data: [DONE]\n\n"]), /没有明确成功终态/],
    ["anthropic error", response(["data: {\"type\":\"error\"}\n\n"]), /失败终态/],
    ["invalid event", response(["data: {not-json}\n\n"]), /事件不是有效 JSON/],
    ["line buffer limit", response([new Uint8Array(1024 * 1024 + 1)]), /大小限制/],
  ];
  for (const [name, value, expected] of cases) await t.test(name, async () => {
    await assert.rejects(() => streamedText(value, name === "anthropic error" ? "anthropic-message" : "openai-response"), expected);
  });
});

test("成功统计固定事件类型并将未知类型归为一类", async () => {
  const unknownEvents = Array.from(
    { length: 40 },
    (_, index) => `data: {"type":"vendor.dynamic.${index}"}\n\n`,
  ).join("");
  let observed: TextModelStreamStatistics | undefined;
  const value = response([
    unknownEvents,
    "data: {\"type\":\"response.output_text.delta\",\"delta\":\"好\"}\n\n",
    "data: {\"type\":\"response.completed\"}\n\n",
  ], undefined, {
    "content-length": "123",
    "x-request-id": "req-safe",
    "authorization": "Bearer must-not-leak",
  });

  assert.equal(await streamedText(value, "openai-response", {
    onStatistics: (statistics) => { observed = statistics; },
  }), "好");
  assert.ok(observed);
  const statistics = observed as TextModelStreamStatistics;
  assert.equal(statistics.protocol, "openai-response");
  assert.ok(statistics.rawBytes > 0);
  assert.equal(statistics.extractedTextBytes, encoder.encode("好").byteLength);
  assert.equal(statistics.eventCount, 42);
  assert.deepEqual(statistics.eventTypes, {
    unknown: 40,
    "response.output_text.delta": 1,
    "response.completed": 1,
  });
  assert.equal(statistics.lastEventType, "response.completed");
  assert.equal(statistics.terminalReceived, true);
  assert.equal(statistics.contentType, "text/event-stream");
  assert.equal(statistics.declaredContentLength, 123);
  assert.deepEqual(statistics.requestIds, { "x-request-id": "req-safe" });
});

test("原始响应超限错误携带有界统计和已提取正文，不泄漏非白名单响应头", async () => {
  const ignoredComment = `:${"x".repeat(512 * 1024)}\n`;
  const value = response([
    "data: {\"type\":\"response.output_text.delta\",\"delta\":\"partial\"}\n\n",
    ...Array.from({ length: 17 }, () => ignoredComment),
  ], undefined, {
    "x-request-id": `req-${"x".repeat(300)}`,
    "authorization": "Bearer must-not-leak",
  });
  let caught: unknown;
  try {
    await streamedText(value, "openai-response");
  } catch (error) {
    caught = error;
  }

  assert.ok(caught instanceof TextModelStreamError);
  assert.match(caught.message, /原始响应超过大小限制/);
  assert.equal(caught.partialText, "partial");
  assert.equal(caught.partialTextTruncated, false);
  assert.ok(caught.statistics.rawBytes > 8 * 1024 * 1024);
  assert.equal(caught.statistics.extractedTextBytes, 7);
  assert.equal(caught.statistics.eventCount, 1);
  assert.deepEqual(caught.statistics.eventTypes, { "response.output_text.delta": 1 });
  assert.equal(caught.statistics.lastEventType, "response.output_text.delta");
  assert.equal(caught.statistics.terminalReceived, false);
  assert.equal(caught.statistics.requestIds["x-request-id"]?.length, 256);
  assert.equal("authorization" in caught.statistics.requestIds, false);
});

test("类型化错误中的部分正文严格限制为 1MiB UTF-8", async () => {
  const event = `data: ${JSON.stringify({
    type: "response.output_text.delta",
    delta: "界".repeat(220_000),
  })}\n\n`;
  let caught: unknown;
  try {
    await streamedText(response(Array.from({ length: 5 }, () => event)), "openai-response");
  } catch (error) {
    caught = error;
  }

  assert.ok(caught instanceof TextModelStreamError);
  assert.match(caught.message, /文本超过大小限制/);
  assert.ok(encoder.encode(caught.partialText).byteLength <= 1024 * 1024);
  assert.equal(caught.partialText.includes("�"), false);
  assert.equal(caught.partialTextTruncated, true);
  assert.equal(caught.statistics.extractedTextBytes, 5 * 220_000 * 3);
});

test("流式失败原样保留 Responses 与 Messages 的上游错误代码和消息", async () => {
  await assert.rejects(
    () => streamedText(response(['data: {"type":"response.failed","response":{"error":{"code":"context_length_exceeded","message":"input is too long"}}}\n\n']), "openai-response"),
    /response\.failed: context_length_exceeded: input is too long/,
  );
  await assert.rejects(
    () => streamedText(response(['data: {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}\n\n']), "anthropic-message"),
    /error: overloaded_error: Overloaded/,
  );
});

test("底层 reader 错误原样失败并释放锁", async () => {
  const failed = new Response(new ReadableStream<Uint8Array>({
    start(controller) { controller.error(new Error("reader failed")); },
  }));
  await assert.rejects(() => streamedText(failed, "openai-response"), /reader failed/);
  assert.equal(failed.body?.locked, false);
});

test("AbortSignal 中断等待并取消 reader；成功终态也主动取消尾流", async () => {
  let abortCancelled = false;
  const controller = new AbortController();
  const waiting = new Response(new ReadableStream<Uint8Array>({ cancel: () => { abortCancelled = true; } }));
  const pending = streamedText(waiting, "openai-response", { signal: controller.signal });
  controller.abort();
  await assert.rejects(() => pending, (error: Error) => {
    assert.match(error.message, /aborted|AbortError/u);
    assert.ok(error.cause instanceof TextModelStreamError);
    assert.equal(error.cause.statistics.rawBytes, 0);
    return true;
  });
  assert.equal(abortCancelled, true);

  let terminalCancelled = false;
  const terminal = new Response(new ReadableStream<Uint8Array>({
    start(stream) { stream.enqueue(encoder.encode("data: {\"type\":\"response.completed\"}\n\n")); },
    cancel: () => { terminalCancelled = true; },
  }));
  assert.equal(await streamedText(terminal, "openai-response"), "");
  assert.equal(terminalCancelled, true);
});
