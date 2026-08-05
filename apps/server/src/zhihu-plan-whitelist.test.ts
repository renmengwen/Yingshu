import assert from "node:assert/strict";
import test from "node:test";

import type { ZhihuAnalysisReport } from "./zhihu-analysis-contract.js";
import type { ZhihuAnalysisSelection, ZhihuAnalysisSnapshot } from "./zhihu-analysis-store.js";
import { buildFrozenZhihuPlanInput } from "./zhihu-plan-whitelist.js";

const HASH = "a".repeat(64);
const observation = (dimension: string, conclusion: string) => ({ dimension, conclusion,
  evidenceRefs: ["answer:body"], confidence: "high" as const, nature: "observation" as const });

function report(): ZhihuAnalysisReport {
  const available = { status: "available" as const, reason: "" };
  return { version: "yingshu-zhihu-analysis-v1",
    evidence: { answerStatus: "succeeded", commentsStatus: "partial", commentCount: 1, evidenceHash: HASH,
      capturedAt: 1, analyzedAt: 2, modelIdentity: "fixture", completeness: "partial" },
    availability: { original: available, method: available, topic: available, audience: { status: "partial", reason: "评论不完整" } },
    original: { sourceEvidenceOnly: true, title: "SECRET_TITLE", authorName: "SECRET_AUTHOR", bodyText: "SECRET_BODY",
      observations: [observation("claim", "SECRET_CLAIM")] },
    method: { observations: [observation("问题开场", "SECRET_METHOD_DETAIL")] },
    topic: { observations: [observation("topic", "TOPIC_SEED")] },
    audience: { interpretationOnly: true, observations: [observation("audience", "AUDIENCE_NEED")] },
    observations: [], risks: [{ code: "uncertain", summary: "RISK_SUMMARY", evidenceRefs: ["answer:body"] }] };
}

function build(role: ZhihuAnalysisSelection["usageRole"], accepted = new Set(["comments"] as const), rights = role === "content_source") {
  const snapshot = { id: "snapshot", videoId: "video", questionId: "1", answerId: "2", sourceUrl: "https://www.zhihu.com/question/1/answer/2",
    config: { sourceUrl: "https://www.zhihu.com/question/1/answer/2", analyzeComments: true, maxComments: 10 }, configHash: HASH,
    evidenceHash: HASH, report: report(), reportHash: HASH, status: "partial", completeness: "partial", artifactManifest: {},
    modelSnapshot: {}, promptVersion: "v1", createdAt: 1, completedAt: 2, invalidatedAt: null } satisfies ZhihuAnalysisSnapshot;
  const selection = { videoId: "video", snapshotId: "snapshot", usageRole: role, creativeAngle: "角度",
    rightsConfirmed: rights, updatedAt: 3 } satisfies ZhihuAnalysisSelection;
  return buildFrozenZhihuPlanInput({ snapshot, selection,
    acceptedMissingDimensions: accepted as ReadonlySet<"comments">, rightsEventConfirmed: rights });
}

test("知乎三种使用方式只冻结各自必要字段", () => {
  const method = JSON.stringify(build("method_only"));
  assert.match(method, /问题开场/u); assert.doesNotMatch(method, /SECRET_BODY|SECRET_METHOD_DETAIL|TOPIC_SEED/u);
  const topic = JSON.stringify(build("topic_seed"));
  assert.match(topic, /TOPIC_SEED|AUDIENCE_NEED/u); assert.doesNotMatch(topic, /SECRET_BODY|SECRET_CLAIM/u);
  const content = JSON.stringify(build("content_source"));
  assert.match(content, /SECRET_BODY|SECRET_CLAIM|sourceEvidenceOnly/u);
});

test("知乎部分评论和正文权利必须由同一报告事件复核", () => {
  assert.throws(() => build("topic_seed", new Set()), /评论证据不完整/u);
  assert.throws(() => build("content_source", new Set(["comments"]), false), /有权处理/u);
});
