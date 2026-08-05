import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import { canonicalDouyinJson, type DouyinAnalysisReport } from "./douyin-analysis-contract.js";
import {
  calculateDouyinDeterministicMetrics,
  createDouyinAnalysisProvider,
  selectDouyinTranscriptSegments,
  type DouyinAnalysisProviderInput,
} from "./douyin-analysis-provider.js";
import { textModelConcurrencyGate } from "./text-model-concurrency.js";
import { TextModelCallError } from "./text-model-stream.js";

const unavailable = { status: "unavailable" as const, reason: "无证据" };
const config = { baseUrl: "https://fixture.invalid/v1", apiKey: "secret-key", model: "fixture-model", providerId: "fixture" };
const modelIdentity = createHash("sha256").update(canonicalDouyinJson({ providerId: config.providerId, model: config.model,
  protocol: "openai-response", baseUrl: config.baseUrl })).digest("hex");
const evidence = {
  metadataStatus: "succeeded" as const, videoStatus: "succeeded" as const, asrStatus: "succeeded" as const,
  asrCoveredDurationMs: 60_000, asrTextCharacters: 8, plannedFrames: 0, succeededFrames: 0, failedFrames: 0,
  commentCount: 0, evidenceHash: "a".repeat(64), capturedAt: 1, analyzedAt: 2,
  modelIdentity, completeness: "partial" as const,
};

function providerInput(): DouyinAnalysisProviderInput {
  return {
    evidence,
    validEvidenceRefs: new Set(["asr:0", "asr:1", "meta:duration"]),
    metadata: { awemeId: "12345", durationMs: 60_000 },
    deterministic: {
      durationMs: 60_000,
      transcriptSegments: [
        { evidenceRef: "asr:0", startMs: 0, endMs: 10_000, text: "开头提出问题。" },
        { evidenceRef: "asr:1", startMs: 50_000, endMs: 60_000, text: "结尾给出回答！" },
      ],
      semanticSections: [{ startMs: 0, endMs: 30_000 }, { startMs: 30_000, endMs: 60_000 }],
      obviousSilenceDurationMs: 2_000,
      media: { width: 1080, height: 1920, frameRate: "30/1", audioTrackCount: 1, audioDurationMs: 60_000 },
    },
    supportsMultimodal: false,
  };
}

function report(metrics: Record<string, number>): DouyinAnalysisReport {
  return {
    version: "yingshu-douyin-analysis-v1",
    evidence,
    availability: { content: { status: "available", reason: "ASR 可用" }, narrative: unavailable,
      pacing: { status: "available", reason: "时间轴可用" }, visualOverall: unavailable, visualOpening: unavailable,
      audioSubtitle: unavailable, audience: unavailable, narrationVisualAlignment: unavailable },
    content: { observations: [{ dimension: "content", conclusion: "本视频开头提出问题",
      evidenceRefs: ["asr:0"], confidence: "high", nature: "observation" }] },
    narrative: null,
    pacing: { metrics, observations: [] }, visual: null, audioSubtitle: null, audience: null,
    observations: [], risks: [],
  };
}

function responseFor(value: unknown) {
  return new Response(JSON.stringify({ output_text: JSON.stringify(value) }), { status: 200,
    headers: { "content-type": "application/json" } });
}

test("确定性节奏和媒体指标由代码计算", () => {
  const metrics = calculateDouyinDeterministicMetrics(providerInput().deterministic);
  assert.equal(metrics.totalCharacters, 12);
  assert.equal(metrics.charactersPerMinute, 12);
  assert.equal(metrics.first15SecondsCharacters, 6);
  assert.equal(metrics.averageSemanticSectionDurationMs, 30_000);
  assert.equal(metrics.videoAspectRatio, 1080 / 1920);
  assert.equal(metrics.audioTrackCount, 1);
});

test("长 ASR 预算保留首尾、转折并均匀覆盖中段", () => {
  const segments = Array.from({ length: 17 }, (_, index) => ({ evidenceRef: `asr:${index}`,
    startMs: index * 1_000, endMs: (index + 1) * 1_000, text: "内容".repeat(30), structuralTransition: index === 5 }));
  const selected = selectDouyinTranscriptSegments(segments, 1_000);
  const refs = selected.segments.map((item) => item.evidenceRef);
  assert.equal(selected.strategy, "uniform_time_coverage");
  assert.equal(refs[0], "asr:0");
  assert.equal(refs.at(-1), "asr:16");
  assert.ok(refs.includes("asr:5"));
  assert.ok(refs.some((ref) => ["asr:7", "asr:8", "asr:9"].includes(ref)));
  assert.ok(selected.omittedRanges.length > 0);
});

test("Provider 只调用一次模型并冻结身份，拒绝模型篡改确定性边界", async (t) => {
  t.mock.method(textModelConcurrencyGate, "run", async (_signal: AbortSignal | undefined, task: () => Promise<unknown>) => task());
  const input = providerInput();
  const metrics = calculateDouyinDeterministicMetrics(input.deterministic);
  let calls = 0;
  const fetchImpl = (async (_url: URL | RequestInfo, init?: RequestInit) => {
    calls += 1;
    const body = JSON.parse(String(init?.body)) as { input: string };
    assert.match(body.input, /comments 为 null/u);
    assert.doesNotMatch(body.input, /爆款分数/u);
    return responseFor(report(metrics));
  }) as typeof fetch;
  const analyze = createDouyinAnalysisProvider(config, fetchImpl);
  const result = await analyze(input);
  assert.equal(calls, 1);
  assert.equal(result.report.pacing?.metrics.totalCharacters, 12);
  assert.match(result.modelSnapshot.inputHash, /^[a-f0-9]{64}$/u);
  assert.equal(result.modelSnapshot.promptVersion, "yingshu-douyin-analysis-prompt-v1");

  const invalid = createDouyinAnalysisProvider(config, (async () => responseFor({ ...report(metrics),
      pacing: { metrics: { ...metrics, totalCharacters: 999 }, observations: [] } })) as typeof fetch);
  await assert.rejects(() => invalid(input), /确定性指标不一致/u);
});

test("严格 JSON、证据引用、单视频措辞与诊断脱敏", async (t) => {
  t.mock.method(textModelConcurrencyGate, "run", async (_signal: AbortSignal | undefined, task: () => Promise<unknown>) => task());
  const input = providerInput();
  const metrics = calculateDouyinDeterministicMetrics(input.deterministic);
  const markdown = createDouyinAnalysisProvider(config, (async () => new Response(JSON.stringify({
    output_text: `\`\`\`json\n${JSON.stringify(report(metrics))}\n\`\`\` secret-key C:\\private\\cookie.json`,
  }), { headers: { "content-type": "application/json" } })) as typeof fetch);
  const error = await markdown(input).then(() => null, (caught: unknown) => caught);
  assert.ok(error instanceof TextModelCallError);
  assert.doesNotMatch(error.evidence.partialText ?? "", /secret-key|C:\\private/u);

  const forged = report(metrics);
  forged.content!.observations[0]!.evidenceRefs = ["asr:missing"];
  await assert.rejects(() => createDouyinAnalysisProvider(config, (async () => responseFor(forged)) as typeof fetch)(input), /无法回读/u);

  const overreach = report(metrics);
  overreach.content!.observations[0]!.conclusion = "该博主长期保持稳定风格";
  await assert.rejects(() => createDouyinAnalysisProvider(config, (async () => responseFor(overreach)) as typeof fetch)(input), /稳定风格/u);
});
