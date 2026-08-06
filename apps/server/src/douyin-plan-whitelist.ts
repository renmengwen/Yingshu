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

const ABSTRACT_METHOD_PATTERNS = [
  ["问题开场", /问题开场|开场.*(?:问题|提问|设问)|(?:问题|提问|设问).*开场/u], ["结果前置", /结果前置|先给结果|结论前置/u],
  ["冲突开场", /冲突开场|开场.*(?:冲突|矛盾)/u], ["利益承诺", /利益承诺|开场.*(?:利益|收益).*承诺/u], ["身份反转", /身份反转/u],
  ["悬念推进", /悬念/u], ["分段解释", /解释|拆解|分段/u], ["举例说明", /举例|案例/u],
  ["转折推进", /转折|反转/u], ["总结收束", /总结|收束|结尾/u], ["行动号召", /行动号召|CTA/u],
  ["第二人称代入", /第二人称|代入/u], ["反差塑造", /反差|并置/u],
  ["逐级升级", /递进|逐级|连续扩大|抬高.*层级/u], ["危机反转", /危机.*出手.*反转|危机.*局势逆转/u],
  ["重复意象", /重复意象|重复出现|标志性细节/u], ["首尾呼应", /首尾呼应|回扣开篇|主题闭环/u],
  ["直接引语", /直接引语|对话/u], ["动作细节", /动作细节|生活细节/u], ["高信息密度", /信息密集|高信息密度/u],
  ["高密度画面", /高密度/u], ["低密度画面", /低密度/u], ["字幕辅助", /字幕/u],
] as const;

function abstractPatterns(values: readonly string[]) {
  return ABSTRACT_METHOD_PATTERNS.filter(([, pattern]) => values.some((value) => pattern.test(value)))
    .map(([label]) => label);
}

function usableConclusions(profile: { observations: DouyinAnalysisReport["observations"] } | null) {
  return profile?.observations.filter((item) => item.nature !== "unknown").map((item) => item.conclusion) ?? [];
}

function methodPayload(report: DouyinAnalysisReport) {
  const narrative = [...(report.narrative?.sections.flatMap((item) => [item.role, item.technique]) ?? []),
    ...usableConclusions(report.narrative), ...usableConclusions(report.pacing),
    ...usableConclusions(report.audioSubtitle),
    ...report.observations.filter((item) => item.nature !== "unknown").map((item) => item.conclusion)];
  const visual = usableConclusions(report.visual);
  const pacingMetrics = report.pacing?.metrics ?? {};
  return {
    methodProfile: {
      // 自由文本只参与服务端分类，实际 Prompt 仅携带固定抽象标签，避免模型把人名、事件或原句藏入“方法”字段。
      narrationPatterns: abstractPatterns(narrative),
      pacingStatus: report.availability.pacing.status,
      // 粗粒度 ASR 会扭曲平均句长等指标；只传递不依赖分句质量的确定性节奏量。
      pacingMetrics: Object.fromEntries(["totalCharacters", "charactersPerMinute", "first15SecondsCharacters", "videoDurationMs"]
        .flatMap((key) => typeof pacingMetrics[key] === "number" ? [[key, pacingMetrics[key]]] : [])),
      visualPatterns: abstractPatterns(visual),
    },
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
    payload = { methodProfile: method.methodProfile, transcriptSegments: manifest.segments,
      contentStructure: snapshot.report.narrative?.sections.map(({ startMs, endMs, role, summary, technique, evidenceRefs }) => ({
        startMs, endMs, role, summary, technique, evidenceRefs,
      })) ?? [],
      sourceClaims: snapshot.report.content?.observations.map((item) => item.conclusion) ?? [],
      uncertainties: snapshot.report.risks.map((item) => item.summary),
      audienceInsights: { interpretationOnly: true,
        observations: snapshot.report.audience?.observations
          .filter((item) => item.nature !== "unknown")
          .map(({ conclusion, confidence, nature }) => ({ conclusion, confidence, nature })) ?? [] } };
  }
  return { snapshotId: snapshot.id, usageRole: selection.usageRole, creativeAngle: selection.creativeAngle,
    evidenceHash: snapshot.evidenceHash, reportHash: snapshot.reportHash, payload };
}
