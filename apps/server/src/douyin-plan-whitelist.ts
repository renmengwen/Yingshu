import type { DouyinAnalysisReport, DouyinUsageRole } from "./douyin-analysis-contract.js";
import type { DouyinAnalysisSelection, DouyinAnalysisSnapshot } from "./douyin-analysis-store.js";
import { VideoPlanError } from "./video-plan-contract.js";

export const DOUYIN_PLAN_EVIDENCE_VERSION = "yingshu-douyin-evidence-v1" as const;

interface TranscriptSegment { startMs: number; endMs: number; text: string }

export interface FrozenDouyinPlanInput {
  snapshotId: string;
  usageRole: DouyinUsageRole;
  creativeAngle: string;
  evidenceHash: string;
  reportHash: string;
  payload: Record<string, unknown>;
}

function record(value: unknown, label: string) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new VideoPlanError(409, `${label}无效`);
  return value as Record<string, unknown>;
}

function exact(value: Record<string, unknown>, fields: readonly string[], label: string) {
  if (Object.keys(value).sort().join("\0") !== [...fields].sort().join("\0")) throw new VideoPlanError(409, `${label}字段无效`);
}

function text(value: unknown, label: string, maximum = 10_000) {
  if (typeof value !== "string") throw new VideoPlanError(409, `${label}无效`);
  const normalized = value.replace(/\r\n?/gu, "\n").trim();
  if (!normalized || [...normalized].length > maximum) throw new VideoPlanError(409, `${label}无效`);
  return normalized;
}

function hash(value: unknown, label: string) {
  const result = text(value, label, 64);
  if (!/^[0-9a-f]{64}$/u.test(result)) throw new VideoPlanError(409, `${label}无效`);
  return result;
}

function parseTranscript(manifestValue: Record<string, unknown>) {
  const transcript = record(manifestValue.transcript, "抖音转写清单");
  exact(transcript, ["status", "textHash", "segments", "missingRanges"], "抖音转写清单");
  if (!["not_requested", "partial", "succeeded", "failed", "cancelled"].includes(String(transcript.status))) {
    throw new VideoPlanError(409, "抖音转写状态无效");
  }
  if (transcript.textHash !== null) hash(transcript.textHash, "抖音转写 Hash");
  if (!Array.isArray(transcript.segments) || transcript.segments.length > 500) throw new VideoPlanError(409, "抖音转写分段无效");
  const segments = transcript.segments.map((item, index) => {
    const segment = record(item, `抖音转写分段 ${index + 1}`);
    exact(segment, ["id", "startMs", "endMs", "text", "status"], `抖音转写分段 ${index + 1}`);
    text(segment.id, "抖音转写分段 ID", 200);
    if (!["succeeded", "failed"].includes(String(segment.status)) || typeof segment.text !== "string") {
      throw new VideoPlanError(409, `抖音转写分段 ${index + 1} 状态无效`);
    }
    if (!Number.isSafeInteger(segment.startMs) || !Number.isSafeInteger(segment.endMs) ||
        (segment.startMs as number) < 0 || (segment.endMs as number) <= (segment.startMs as number)) {
      throw new VideoPlanError(409, `抖音转写分段 ${index + 1} 时间无效`);
    }
    return segment.status === "succeeded" ? { startMs: segment.startMs as number, endMs: segment.endMs as number,
      text: text(segment.text, `抖音转写分段 ${index + 1} 正文`) } : null;
  }).filter((item): item is TranscriptSegment => item !== null);
  if (!Array.isArray(transcript.missingRanges) || transcript.missingRanges.length > 500) {
    throw new VideoPlanError(409, "抖音转写缺失范围无效");
  }
  return { status: transcript.status as string, segments };
}

/** 仅解析冻结清单中的内联转写；artifact 路径、帧和完整评论不会离开此边界。 */
export function parseDouyinPlanManifest(artifactManifest: Record<string, unknown> | null) {
  const manifest = record(artifactManifest, "抖音分析产物清单");
  exact(manifest, ["version", "evidenceHash", "artifacts", "transcript", "frames", "comments"], "抖音分析产物清单");
  if (manifest.version !== DOUYIN_PLAN_EVIDENCE_VERSION) throw new VideoPlanError(409, "抖音分析产物清单版本无效");
  if (!Array.isArray(manifest.artifacts) || !Array.isArray(manifest.frames)) throw new VideoPlanError(409, "抖音分析产物清单无效");
  const comments = record(manifest.comments, "抖音评论清单");
  if (comments.interpretationOnly !== true) throw new VideoPlanError(409, "抖音评论只能作为解释性受众信号");
  return { evidenceHash: hash(manifest.evidenceHash, "抖音证据 Hash"), ...parseTranscript(manifest) };
}

function conclusion(report: DouyinAnalysisReport, dimension: string) {
  return report.content?.observations.find((item) => item.dimension === dimension)?.conclusion ?? "";
}

function methodPayload(report: DouyinAnalysisReport) {
  return {
    methodProfile: {
      narrationPatterns: [...(report.narrative?.sections.map((item) => `${item.role}：${item.technique}`) ?? []),
        ...(report.narrative?.observations.map((item) => item.conclusion) ?? [])],
      pacingMetrics: report.pacing?.metrics ?? {},
      visualPatterns: report.visual?.observations.map((item) => item.conclusion) ?? [],
    },
    audienceNeeds: report.audience?.observations.map((item) => item.conclusion) ?? [],
    audienceRisks: report.risks.map((item) => item.summary),
  };
}

export function buildFrozenDouyinPlanInput(input: {
  snapshot: DouyinAnalysisSnapshot;
  selection: DouyinAnalysisSelection;
  acceptedPartial: boolean;
  rightsEventConfirmed: boolean;
}): FrozenDouyinPlanInput {
  const { snapshot, selection } = input;
  if (snapshot.id !== selection.snapshotId || snapshot.invalidatedAt !== null || !snapshot.report ||
      !snapshot.evidenceHash || !snapshot.reportHash || !["succeeded", "partial"].includes(snapshot.status)) {
    throw new VideoPlanError(409, "当前抖音分析快照不可用于方案生成");
  }
  const manifest = parseDouyinPlanManifest(snapshot.artifactManifest);
  if (manifest.evidenceHash !== snapshot.evidenceHash) throw new VideoPlanError(409, "抖音计划证据与冻结分析身份不一致");
  const asrReady = ["succeeded", "partial"].includes(snapshot.report.evidence.asrStatus) && manifest.segments.length > 0;
  if (selection.usageRole !== "method_only" && (!asrReady ||
      (snapshot.report.evidence.asrStatus === "partial" && !input.acceptedPartial))) {
    throw new VideoPlanError(409, "当前使用方式需要完整 ASR，或明确接受部分转写");
  }
  if (selection.usageRole === "content_source" && (!selection.rightsConfirmed || !input.rightsEventConfirmed)) {
    throw new VideoPlanError(409, "改写源视频内容前必须确认有权处理该素材");
  }

  const method = methodPayload(snapshot.report);
  let payload: Record<string, unknown>;
  if (selection.usageRole === "method_only") {
    payload = method;
  } else if (selection.usageRole === "topic_seed") {
    const topic = conclusion(snapshot.report, "topic");
    const coreQuestion = conclusion(snapshot.report, "coreQuestion");
    const audienceAngle = conclusion(snapshot.report, "audienceAngle");
    if (!topic || !coreQuestion || !audienceAngle) throw new VideoPlanError(409, "抖音报告缺少可冻结的选题、核心问题或受众角度");
    payload = { topic, coreQuestion, audienceAngle, ...method };
  } else {
    payload = { transcriptSegments: manifest.segments,
      contentStructure: snapshot.report.narrative?.sections.map(({ role, summary }) => ({ role, summary })) ?? [],
      sourceClaims: snapshot.report.content?.observations.map((item) => item.conclusion) ?? [],
      uncertainties: snapshot.report.risks.map((item) => item.summary),
      audienceNeeds: method.audienceNeeds, audienceRisks: method.audienceRisks };
  }
  return { snapshotId: snapshot.id, usageRole: selection.usageRole, creativeAngle: selection.creativeAngle,
    evidenceHash: snapshot.evidenceHash, reportHash: snapshot.reportHash, payload };
}
