import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import { canonicalZhihuJson, type ZhihuAnalysisReport } from "./zhihu-analysis-contract.js";
import { createZhihuAnalysisProvider, type ZhihuAnalysisProviderInput } from "./zhihu-analysis-provider.js";
import { textModelConcurrencyGate } from "./text-model-concurrency.js";

const config = { baseUrl: "https://fixture.invalid/v1", apiKey: "secret", model: "gpt-5", providerId: "fixture",
  protocol: "openai-response" as const, supportsMultimodal: true };
const identity = createHash("sha256").update(canonicalZhihuJson({ providerId: config.providerId, model: config.model,
  protocol: config.protocol, baseUrl: config.baseUrl })).digest("hex");

function input(images = true): ZhihuAnalysisProviderInput {
  const image = { evidenceRef: `answer:image:${"b".repeat(64)}`, sha256: "b".repeat(64), mime: "image/jpeg" as const,
    bytes: Uint8Array.from([0xff, 0xd8, 0xff, 0xd9]) };
  return { evidence: { answerStatus: "succeeded", commentsStatus: "not_requested", commentCount: 0,
    evidenceHash: "a".repeat(64), capturedAt: 1, analyzedAt: 2, modelIdentity: identity,
    completeness: images ? "complete" : "partial" },
    answer: { questionId: "1", answerId: "2", canonicalUrl: "https://www.zhihu.com/question/1/answer/2",
      questionTitle: "问题", content: "正文", excerpt: "", imageUrls: ["https://picx.zhimg.com/a.jpg"], authorName: "作者",
      publishedAt: null, updatedAt: null, voteupCount: 1, commentCount: 0 },
    audience: null, images: images ? [image] : [],
    validEvidenceRefs: new Set(["answer:body", ...(images ? [image.evidenceRef] : [])]) };
}

function report(value: ZhihuAnalysisProviderInput): ZhihuAnalysisReport {
  const original = { status: value.images.length ? "available" as const : "partial" as const,
    reason: value.images.length ? "正文和图片可用" : "图片未识别" };
  const unavailable = { status: "unavailable" as const, reason: "无证据" };
  return { version: "yingshu-zhihu-analysis-v1", evidence: value.evidence,
    availability: { original, method: unavailable, topic: unavailable, audience: unavailable },
    original: { sourceEvidenceOnly: true, title: "问题", authorName: "作者", bodyText: "正文", observations: [] },
    method: null, topic: null, audience: null, observations: [], risks: value.images.length ? [] : [
      { code: "image_unread", summary: "图片内容未识别", evidenceRefs: [] } ] };
}

const responseFor = (value: unknown) => new Response(JSON.stringify({ output_text: JSON.stringify(value) }),
  { headers: { "content-type": "application/json" } });

test("OpenAI Responses 多模态请求携带 input_text 与受控 data URL", async (t) => {
  t.mock.method(textModelConcurrencyGate, "run", async (_signal: AbortSignal | undefined, task: () => Promise<unknown>) => task());
  const value = input();
  const analyze = createZhihuAnalysisProvider(config, (async (_url, init) => {
    const body = JSON.parse(String(init?.body)) as { input: Array<{ content: Array<Record<string, unknown>> }> };
    assert.equal(body.input[0]!.content[0]!.type, "input_text");
    assert.match(String(body.input[0]!.content[1]!.image_url), /^data:image\/jpeg;base64,/u);
    assert.doesNotMatch(JSON.stringify(body), /secret/u);
    return responseFor(report(value));
  }) as typeof fetch);
  const result = await analyze(value);
  assert.equal(result.report.availability.original.status, "available");
  assert.equal(result.modelSnapshot.modelIdentityHash, identity);
});

test("未识别图片不得伪装原文完整，Anthropic 不接图片", async (t) => {
  t.mock.method(textModelConcurrencyGate, "run", async (_signal: AbortSignal | undefined, task: () => Promise<unknown>) => task());
  const value = input(false); const forged = report(value); forged.availability.original = { status: "available", reason: "错误" };
  await assert.rejects(() => createZhihuAnalysisProvider(config, (async () => responseFor(forged)) as typeof fetch)(value), /不能标记为完全可用/u);
  await assert.rejects(() => createZhihuAnalysisProvider({ ...config, protocol: "anthropic-message" },
    (async () => responseFor(report(input()))) as typeof fetch)(input()), /不支持知乎图片证据/u);
});
