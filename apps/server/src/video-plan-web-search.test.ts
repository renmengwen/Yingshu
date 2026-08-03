import assert from "node:assert/strict";
import test from "node:test";

import { createVideoPlanWebSearch, parseAnthropicWebSources, parseOpenAiWebSources } from "./video-plan-web-search.js";

test("OpenAI Responses 联网结果归一化 action source 与 URL citation", () => {
  assert.deepEqual(parseOpenAiWebSources({ output: [
    { type: "web_search_call", action: { sources: [{ title: "来源 A", url: "https://example.com/a" }] } },
    { type: "message", content: [{ type: "output_text", text: "来源 B 说明", annotations: [
      { type: "url_citation", title: "来源 B", url: "https://example.com/b", start_index: 0, end_index: 5 },
      { type: "url_citation", title: "重复", url: "https://example.com/a", cited_text: "来源 A 说明" },
    ] }] },
  ] }), [
    { title: "来源 A", url: "https://example.com/a", summary: "来源 A 说明" },
    { title: "来源 B", url: "https://example.com/b", summary: "来源 B" },
  ]);
});

test("Anthropic Messages 联网结果归一化工具结果并拒绝非 HTTP URL", () => {
  assert.deepEqual(parseAnthropicWebSources({ content: [{ type: "web_search_tool_result", content: [
    { type: "web_search_result", title: "来源 A", url: "https://example.com/a" },
    { type: "web_search_result", title: "危险", url: "javascript:alert(1)" },
  ] }] }), [{ title: "来源 A", url: "https://example.com/a", summary: "" }]);
});

test("原生搜索按协议发送工具合同且必须收到可核验来源", async () => {
  let requestBody: Record<string, unknown> = {};
  const search = createVideoPlanWebSearch({
    baseUrl: "https://example.invalid/v1", apiKey: "secret", model: "model", providerId: "provider",
  }, (async (_url, init) => {
    requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return Response.json({ output: [{ type: "web_search_call", action: { sources: [
      { title: "来源", url: "https://example.com/source" },
    ] } }] });
  }) as typeof fetch);
  assert.deepEqual(await search({ query: "天空为什么是蓝色", limit: 3 }), [
    { title: "来源", url: "https://example.com/source", summary: "" },
  ]);
  assert.deepEqual(requestBody.tools, [{ type: "web_search" }]);
});
