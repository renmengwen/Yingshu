import assert from "node:assert/strict";
import test from "node:test";

import {
  douyinAnalysisConfigHash, parseDouyinAnalysisConfig, parseDouyinAnalysisReport,
  parseDouyinAnalysisSelection, type DouyinAnalysisReport,
} from "./douyin-analysis-contract.js";

function report(): DouyinAnalysisReport {
  const unavailable = { status: "unavailable" as const, reason: "未请求" };
  return {
    version: "yingshu-douyin-analysis-v1",
    evidence: {
      metadataStatus: "succeeded", videoStatus: "succeeded", asrStatus: "succeeded",
      asrCoveredDurationMs: 20_000, asrTextCharacters: 100, plannedFrames: 12,
      succeededFrames: 12, failedFrames: 0, commentCount: 0, evidenceHash: "a".repeat(64),
      capturedAt: 1, analyzedAt: 2, modelIdentity: "fixture-model", completeness: "complete",
    },
    availability: {
      content: { status: "available", reason: "ASR 可用" },
      narrative: { status: "available", reason: "ASR 可用" },
      pacing: { status: "available", reason: "时间轴可用" },
      visualOverall: { status: "available", reason: "关键帧可用" },
      visualOpening: { status: "available", reason: "开头关键帧可用" },
      audioSubtitle: unavailable, audience: unavailable, narrationVisualAlignment: unavailable,
    },
    content: { observations: [{ dimension: "content", conclusion: "本视频提出一个问题",
      evidenceRefs: ["asr:0"], confidence: "high", nature: "observation" }] },
    narrative: { sections: [{ startMs: 0, endMs: 1_000, role: "开头", summary: "提出问题",
      technique: "问题钩子", evidenceRefs: ["asr:0"] }], observations: [] },
    pacing: { metrics: { charactersPerMinute: 300 }, observations: [] },
    visual: { observations: [] }, audioSubtitle: null, audience: null,
    observations: [], risks: [],
  };
}

test("抖音分析配置严格校验并忽略未请求的帧数量身份", () => {
  const base = { sourceText: "https://www.douyin.com/video/12345", extractFrames: true,
    frameCount: 12, transcribeAudio: true, analyzeComments: false };
  assert.deepEqual(parseDouyinAnalysisConfig(base), base);
  assert.throws(() => parseDouyinAnalysisConfig({ ...base, extra: true }), /字段无效/u);
  assert.throws(() => parseDouyinAnalysisConfig({ ...base, frameCount: 31 }), /6～30/u);
  assert.throws(() => parseDouyinAnalysisConfig({ ...base, extractFrames: false, transcribeAudio: false }), /至少需要/u);
  assert.equal(douyinAnalysisConfigHash({ ...base, extractFrames: false, frameCount: 6 }),
    douyinAnalysisConfigHash({ ...base, extractFrames: false, frameCount: 30 }));
});

test("报告拒绝额外字段、评论事实化和不可回读证据", () => {
  const value = report();
  assert.equal(parseDouyinAnalysisReport(value, new Set(["asr:0"])).version, "yingshu-douyin-analysis-v1");
  assert.throws(() => parseDouyinAnalysisReport({ ...value, score: 99 }), /字段无效/u);
  assert.throws(() => parseDouyinAnalysisReport({ ...value, audience: { interpretationOnly: false, observations: [] } }),
    /interpretationOnly=true/u);
  assert.throws(() => parseDouyinAnalysisReport(value, new Set()), /无法回读/u);
});

test("使用方式严格校验内容改写权利与缺失维度", () => {
  const base = { snapshotId: "das_fixture", usageRole: "method_only", creativeAngle: "换一个表达角度",
    rightsConfirmed: false, acceptedMissingDimensions: ["audience"] };
  assert.equal(parseDouyinAnalysisSelection(base).usageRole, "method_only");
  assert.throws(() => parseDouyinAnalysisSelection({ ...base, acceptedMissingDimensions: ["audience", "audience"] }), /不能重复/u);
  assert.throws(() => parseDouyinAnalysisSelection({ ...base, usageRole: "content_source" }), /必须确认/u);
});
