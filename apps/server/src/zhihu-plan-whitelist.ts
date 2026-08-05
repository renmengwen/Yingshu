import type { ZhihuAcceptedMissingDimension, ZhihuUsageRole } from "./zhihu-analysis-contract.js";
import type { ZhihuAnalysisSelection, ZhihuAnalysisSnapshot } from "./zhihu-analysis-store.js";
import { VideoPlanError } from "./video-plan-contract.js";

export interface FrozenZhihuPlanInput {
  snapshotId: string; usageRole: ZhihuUsageRole; creativeAngle: string;
  evidenceHash: string; reportHash: string; payload: Record<string, unknown>;
}

export function buildFrozenZhihuPlanInput(input: {
  snapshot: ZhihuAnalysisSnapshot; selection: ZhihuAnalysisSelection;
  acceptedMissingDimensions: ReadonlySet<ZhihuAcceptedMissingDimension>; rightsEventConfirmed: boolean;
}): FrozenZhihuPlanInput {
  const { snapshot, selection } = input;
  if (snapshot.id !== selection.snapshotId || snapshot.invalidatedAt !== null || !snapshot.report ||
      !snapshot.evidenceHash || !snapshot.reportHash || !["succeeded", "partial"].includes(snapshot.status)) {
    throw new VideoPlanError(409, "当前知乎分析快照不可用于方案生成");
  }
  const required = selection.usageRole === "method_only" ? "method" : selection.usageRole === "topic_seed" ? "topic" : "original";
  if (snapshot.report.availability[required].status !== "available" && !input.acceptedMissingDimensions.has(required)) {
    throw new VideoPlanError(409, `知乎${required}维度不完整且未确认接受`);
  }
  if (snapshot.report.evidence.commentsStatus === "partial" && !input.acceptedMissingDimensions.has("comments")) {
    throw new VideoPlanError(409, "知乎评论证据不完整且未确认接受");
  }
  if (selection.usageRole === "content_source" && (!selection.rightsConfirmed || !input.rightsEventConfirmed)) {
    throw new VideoPlanError(409, "将知乎回答作为改写来源前必须确认有权处理该内容");
  }

  const audience = snapshot.report.audience?.observations.map(({ conclusion, confidence }) => ({ conclusion, confidence })) ?? [];
  let payload: Record<string, unknown>;
  if (selection.usageRole === "method_only") {
    // 方法参考只传抽象维度标签，避免把回答中的人物、事件或原句藏进“方法”字段。
    payload = { methodPatterns: [...new Set(snapshot.report.method?.observations.map((item) => item.dimension) ?? [])],
      audienceNeeds: audience };
  } else if (selection.usageRole === "topic_seed") {
    payload = { topicInsights: snapshot.report.topic?.observations.map(({ conclusion, confidence }) => ({ conclusion, confidence })) ?? [],
      audienceNeeds: audience, risks: snapshot.report.risks.map(({ code, summary }) => ({ code, summary })) };
  } else {
    if (!snapshot.report.original) throw new VideoPlanError(409, "知乎报告缺少可冻结的回答正文");
    payload = { source: { title: snapshot.report.original.title, authorName: snapshot.report.original.authorName,
      bodyText: snapshot.report.original.bodyText, sourceEvidenceOnly: true },
      sourceObservations: snapshot.report.original.observations.map(({ conclusion, confidence, nature }) => ({ conclusion, confidence, nature })),
      audienceNeeds: audience, risks: snapshot.report.risks.map(({ code, summary }) => ({ code, summary })) };
  }
  return { snapshotId: snapshot.id, usageRole: selection.usageRole, creativeAngle: selection.creativeAngle,
    evidenceHash: snapshot.evidenceHash, reportHash: snapshot.reportHash, payload };
}
