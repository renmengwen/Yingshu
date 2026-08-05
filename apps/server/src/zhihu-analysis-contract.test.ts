import assert from "node:assert/strict";
import test from "node:test";

import { parseZhihuAnalysisConfig, parseZhihuAnalysisReport, parseZhihuAnalysisSelection, zhihuAnalysisConfigHash,
  type ZhihuAnalysisReport } from "./zhihu-analysis-contract.js";

function report(): ZhihuAnalysisReport {
  const available = { status: "available" as const, reason: "证据可用" };
  return {
    version: "yingshu-zhihu-analysis-v1",
    evidence: { answerStatus: "succeeded", commentsStatus: "succeeded", commentCount: 1,
      evidenceHash: "a".repeat(64), capturedAt: 1, analyzedAt: 2, modelIdentity: "fixture", completeness: "complete" },
    availability: { original: available, method: available, topic: available, audience: available },
    original: { sourceEvidenceOnly: true, title: "问题", authorName: "作者", bodyText: "回答正文",
      observations: [{ dimension: "original", conclusion: "作者提出观点", evidenceRefs: ["answer:body"], confidence: "high", nature: "observation" }] },
    method: { observations: [] }, topic: { observations: [] },
    audience: { interpretationOnly: true, observations: [{ dimension: "audience", conclusion: "部分评论认同",
      evidenceRefs: ["comment:1"], confidence: "medium", nature: "inference" }] }, observations: [], risks: [],
  };
}

test("知乎回答链接、配置身份与使用方式严格校验", () => {
  const sourceUrl = "https://www.zhihu.com/question/9389089116/answer/1976331888235927140";
  const config = parseZhihuAnalysisConfig({ sourceUrl, analyzeComments: false, maxComments: 50 });
  assert.equal(config.sourceUrl, sourceUrl);
  assert.equal(zhihuAnalysisConfigHash(config), zhihuAnalysisConfigHash({ ...config, maxComments: 0 }));
  assert.throws(() => parseZhihuAnalysisConfig({ ...config, sourceUrl: "https://example.com/question/1/answer/2" }), /只支持知乎/u);
  assert.throws(() => parseZhihuAnalysisSelection({ snapshotId: "z", usageRole: "content_source", creativeAngle: "",
    rightsConfirmed: false, acceptedMissingDimensions: [] }), /确认有权/u);
});

test("回答正文和评论的证据边界不可省略", () => {
  const valid = report();
  assert.deepEqual(parseZhihuAnalysisReport(valid, new Set(["answer:body", "comment:1"])), valid);
  assert.throws(() => parseZhihuAnalysisReport({ ...valid, original: { ...valid.original!, sourceEvidenceOnly: false } }), /sourceEvidenceOnly/u);
  assert.throws(() => parseZhihuAnalysisReport({ ...valid, audience: { ...valid.audience!, interpretationOnly: false } }), /interpretationOnly/u);
  assert.throws(() => parseZhihuAnalysisReport(valid, new Set(["answer:body"])), /无法回读/u);
});
