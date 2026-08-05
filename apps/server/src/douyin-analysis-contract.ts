import { createHash } from "node:crypto";

export const DOUYIN_ANALYSIS_JOB_TYPE = "douyin_video_analysis";
export const DOUYIN_ANALYSIS_REPORT_VERSION = "yingshu-douyin-analysis-v1" as const;

export type DouyinUsageRole = "method_only" | "topic_seed" | "content_source";
export type DouyinAnalysisStatus =
  | "queued" | "running" | "need_login" | "need_verify"
  | "partial" | "succeeded" | "failed" | "cancelled";
export type DouyinCompleteness = "unavailable" | "partial" | "complete";
export type DouyinEvidenceStatus = "not_requested" | "pending" | "running" | "partial" | "succeeded" | "failed" | "cancelled";

export interface DouyinAnalysisConfig {
  sourceText: string;
  extractFrames: boolean;
  frameCount: number;
  transcribeAudio: boolean;
  analyzeComments: boolean;
}

export const DEFAULT_DOUYIN_ANALYSIS_CONFIG: Readonly<DouyinAnalysisConfig> = Object.freeze({
  sourceText: "",
  extractFrames: true,
  frameCount: 12,
  transcribeAudio: true,
  analyzeComments: false,
});

export const DOUYIN_AVAILABILITY_DIMENSIONS = [
  "content", "narrative", "pacing", "visualOverall", "visualOpening",
  "audioSubtitle", "audience", "narrationVisualAlignment",
] as const;
export type DouyinAvailabilityDimension = typeof DOUYIN_AVAILABILITY_DIMENSIONS[number];

export interface DimensionAvailability {
  status: "available" | "partial" | "unavailable";
  reason: string;
}

export interface EvidenceBackedObservation {
  dimension: string;
  conclusion: string;
  evidenceRefs: string[];
  confidence: "high" | "medium" | "low";
  nature: "observation" | "inference" | "unknown";
}

export interface DouyinAnalysisReport {
  version: typeof DOUYIN_ANALYSIS_REPORT_VERSION;
  evidence: {
    metadataStatus: DouyinEvidenceStatus;
    videoStatus: DouyinEvidenceStatus;
    asrStatus: DouyinEvidenceStatus;
    asrCoveredDurationMs: number;
    asrTextCharacters: number;
    plannedFrames: number;
    succeededFrames: number;
    failedFrames: number;
    commentCount: number;
    evidenceHash: string;
    capturedAt: number;
    analyzedAt: number;
    modelIdentity: string;
    completeness: DouyinCompleteness;
  };
  availability: Record<DouyinAvailabilityDimension, DimensionAvailability>;
  content: { observations: EvidenceBackedObservation[] } | null;
  narrative: { sections: Array<{ startMs: number; endMs: number; role: string; summary: string; technique: string; evidenceRefs: string[] }>;
    observations: EvidenceBackedObservation[] } | null;
  pacing: { metrics: Record<string, number>; observations: EvidenceBackedObservation[] } | null;
  visual: { observations: EvidenceBackedObservation[] } | null;
  audioSubtitle: { observations: EvidenceBackedObservation[] } | null;
  audience: { interpretationOnly: true; observations: EvidenceBackedObservation[] } | null;
  observations: EvidenceBackedObservation[];
  risks: Array<{ code: string; summary: string; evidenceRefs: string[] }>;
}

export interface DouyinAnalysisSelectionInput {
  snapshotId: string;
  usageRole: DouyinUsageRole;
  creativeAngle: string;
  rightsConfirmed: boolean;
  acceptedMissingDimensions: DouyinAvailabilityDimension[];
}

export class DouyinAnalysisContractError extends Error {
  constructor(readonly statusCode: number, message: string) { super(message); }
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new DouyinAnalysisContractError(400, `${label}必须是对象`);
  }
  return value as Record<string, unknown>;
}

function exact(value: Record<string, unknown>, fields: readonly string[], label: string) {
  const actual = Object.keys(value);
  if (actual.length !== fields.length || actual.some((key) => !fields.includes(key))) {
    throw new DouyinAnalysisContractError(400, `${label}字段无效`);
  }
}

function text(value: unknown, label: string, max: number, allowEmpty = false) {
  if (typeof value !== "string") throw new DouyinAnalysisContractError(400, `${label}必须是文本`);
  const normalized = value.normalize("NFC").trim();
  if (!allowEmpty && !normalized) throw new DouyinAnalysisContractError(400, `${label}不能为空`);
  if ([...normalized].length > max) throw new DouyinAnalysisContractError(400, `${label}不能超过 ${max} 个字符`);
  return normalized;
}

function boolean(value: unknown, label: string) {
  if (typeof value !== "boolean") throw new DouyinAnalysisContractError(400, `${label}必须是布尔值`);
  return value;
}

function integer(value: unknown, label: string, min = 0, max = Number.MAX_SAFE_INTEGER) {
  if (!Number.isSafeInteger(value) || (value as number) < min || (value as number) > max) {
    throw new DouyinAnalysisContractError(400, `${label}必须是 ${min}～${max} 的整数`);
  }
  return value as number;
}

function enumeration<T extends string>(value: unknown, values: readonly T[], label: string): T {
  if (typeof value !== "string" || !values.includes(value as T)) {
    throw new DouyinAnalysisContractError(400, `${label}无效`);
  }
  return value as T;
}

function list<T>(value: unknown, label: string, max: number, parse: (item: unknown, index: number) => T): T[] {
  if (!Array.isArray(value) || value.length > max) throw new DouyinAnalysisContractError(400, `${label}必须是最多 ${max} 项的数组`);
  return value.map(parse);
}

function hash(value: unknown, label: string) {
  const result = text(value, label, 64);
  if (!/^[0-9a-f]{64}$/.test(result)) throw new DouyinAnalysisContractError(400, `${label}无效`);
  return result;
}

export function canonicalDouyinJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalDouyinJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalDouyinJson(record[key])}`).join(",")}}`;
}

export function douyinSha256(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

export function parseDouyinAnalysisConfig(raw: unknown): DouyinAnalysisConfig {
  const value = object(raw, "抖音分析配置");
  exact(value, ["sourceText", "extractFrames", "frameCount", "transcribeAudio", "analyzeComments"], "抖音分析配置");
  const result: DouyinAnalysisConfig = {
    sourceText: text(value.sourceText, "抖音分享文案或链接", 10_000),
    extractFrames: boolean(value.extractFrames, "抽取关键帧"),
    frameCount: integer(value.frameCount, "关键帧数量", 6, 30),
    transcribeAudio: boolean(value.transcribeAudio, "ASR 音频转写"),
    analyzeComments: boolean(value.analyzeComments, "评论分析"),
  };
  if (!result.extractFrames && !result.transcribeAudio) {
    throw new DouyinAnalysisContractError(400, "至少需要开启关键帧或 ASR 音频转写");
  }
  return result;
}

/** 关闭抽帧时保留草稿数量，但执行身份不应被未请求参数改变。 */
export function effectiveDouyinAnalysisConfig(config: DouyinAnalysisConfig) {
  return { ...config, frameCount: config.extractFrames ? config.frameCount : null };
}

export function douyinAnalysisConfigHash(config: DouyinAnalysisConfig) {
  return douyinSha256(canonicalDouyinJson(effectiveDouyinAnalysisConfig(config)));
}

export function parseDouyinAnalysisSelection(raw: unknown): DouyinAnalysisSelectionInput {
  const value = object(raw, "抖音使用方式");
  exact(value, ["snapshotId", "usageRole", "creativeAngle", "rightsConfirmed", "acceptedMissingDimensions"], "抖音使用方式");
  const dimensions = list(value.acceptedMissingDimensions, "接受的缺失项", DOUYIN_AVAILABILITY_DIMENSIONS.length,
    (item) => enumeration(item, DOUYIN_AVAILABILITY_DIMENSIONS, "缺失维度"));
  if (new Set(dimensions).size !== dimensions.length) throw new DouyinAnalysisContractError(400, "接受的缺失项不能重复");
  const result: DouyinAnalysisSelectionInput = {
    snapshotId: text(value.snapshotId, "分析快照 ID", 100),
    usageRole: enumeration(value.usageRole, ["method_only", "topic_seed", "content_source"] as const, "使用方式"),
    creativeAngle: text(value.creativeAngle, "创作角度", 2_000, true),
    rightsConfirmed: boolean(value.rightsConfirmed, "权利确认"),
    acceptedMissingDimensions: dimensions,
  };
  if (result.usageRole === "content_source" && !result.rightsConfirmed) {
    throw new DouyinAnalysisContractError(409, "改写源视频内容前必须确认有权处理该素材");
  }
  return result;
}

function parseEvidenceRefs(value: unknown, label: string) {
  return list(value, label, 20, (item) => text(item, `${label}引用`, 200));
}

function parseObservation(raw: unknown, label: string): EvidenceBackedObservation {
  const value = object(raw, label);
  exact(value, ["dimension", "conclusion", "evidenceRefs", "confidence", "nature"], label);
  const result: EvidenceBackedObservation = {
    dimension: text(value.dimension, `${label}维度`, 100),
    conclusion: text(value.conclusion, `${label}结论`, 2_000),
    evidenceRefs: parseEvidenceRefs(value.evidenceRefs, `${label}证据`),
    confidence: enumeration(value.confidence, ["high", "medium", "low"] as const, `${label}置信度`),
    nature: enumeration(value.nature, ["observation", "inference", "unknown"] as const, `${label}性质`),
  };
  if (result.nature === "observation" && result.evidenceRefs.length < 1) {
    throw new DouyinAnalysisContractError(400, `${label}的观察结论至少需要一条证据`);
  }
  if (result.nature === "inference" && result.evidenceRefs.length < 1) {
    throw new DouyinAnalysisContractError(400, `${label}的推断至少需要一条证据并说明限制`);
  }
  if (result.nature === "unknown" && result.evidenceRefs.length) {
    throw new DouyinAnalysisContractError(400, `${label}的未知结论不得伪造证据`);
  }
  return result;
}

function parseObservationProfile(raw: unknown, label: string) {
  if (raw === null) return null;
  const value = object(raw, label);
  exact(value, ["observations"], label);
  return { observations: list(value.observations, `${label}结论`, 100, (item, index) => parseObservation(item, `${label}结论 ${index + 1}`)) };
}

export function parseDouyinAnalysisReport(raw: unknown, validEvidenceRefs?: ReadonlySet<string>): DouyinAnalysisReport {
  const value = object(raw, "抖音分析报告");
  exact(value, ["version", "evidence", "availability", "content", "narrative", "pacing", "visual", "audioSubtitle", "audience", "observations", "risks"], "抖音分析报告");
  if (value.version !== DOUYIN_ANALYSIS_REPORT_VERSION) throw new DouyinAnalysisContractError(400, "抖音分析报告版本无效");

  const evidence = object(value.evidence, "证据摘要");
  exact(evidence, ["metadataStatus", "videoStatus", "asrStatus", "asrCoveredDurationMs", "asrTextCharacters", "plannedFrames", "succeededFrames", "failedFrames", "commentCount", "evidenceHash", "capturedAt", "analyzedAt", "modelIdentity", "completeness"], "证据摘要");
  const evidenceStatus = ["not_requested", "pending", "running", "partial", "succeeded", "failed", "cancelled"] as const;
  const parsedEvidence: DouyinAnalysisReport["evidence"] = {
    metadataStatus: enumeration(evidence.metadataStatus, evidenceStatus, "元数据状态"),
    videoStatus: enumeration(evidence.videoStatus, evidenceStatus, "视频状态"),
    asrStatus: enumeration(evidence.asrStatus, evidenceStatus, "ASR 状态"),
    asrCoveredDurationMs: integer(evidence.asrCoveredDurationMs, "ASR 覆盖时长"),
    asrTextCharacters: integer(evidence.asrTextCharacters, "ASR 文本字数"),
    plannedFrames: integer(evidence.plannedFrames, "计划关键帧数", 0, 30),
    succeededFrames: integer(evidence.succeededFrames, "成功关键帧数", 0, 30),
    failedFrames: integer(evidence.failedFrames, "失败关键帧数", 0, 30),
    commentCount: integer(evidence.commentCount, "评论数量", 0, 300),
    evidenceHash: hash(evidence.evidenceHash, "证据 Hash"),
    capturedAt: integer(evidence.capturedAt, "证据抓取时间"),
    analyzedAt: integer(evidence.analyzedAt, "报告分析时间"),
    modelIdentity: text(evidence.modelIdentity, "模型身份", 500),
    completeness: enumeration(evidence.completeness, ["unavailable", "partial", "complete"] as const, "报告完整性"),
  };
  if (parsedEvidence.succeededFrames + parsedEvidence.failedFrames > parsedEvidence.plannedFrames) {
    throw new DouyinAnalysisContractError(400, "关键帧成功数与失败数不能超过计划数");
  }

  const availabilityValue = object(value.availability, "维度可用性");
  exact(availabilityValue, DOUYIN_AVAILABILITY_DIMENSIONS, "维度可用性");
  const availability = Object.fromEntries(DOUYIN_AVAILABILITY_DIMENSIONS.map((dimension) => {
    const item = object(availabilityValue[dimension], `${dimension} 可用性`);
    exact(item, ["status", "reason"], `${dimension} 可用性`);
    return [dimension, { status: enumeration(item.status, ["available", "partial", "unavailable"] as const, `${dimension} 状态`),
      reason: text(item.reason, `${dimension} 原因`, 500, true) }];
  })) as unknown as DouyinAnalysisReport["availability"];

  const narrativeValue = value.narrative === null ? null : object(value.narrative, "叙事分析");
  if (narrativeValue) exact(narrativeValue, ["sections", "observations"], "叙事分析");
  const narrative = narrativeValue ? {
    sections: list(narrativeValue.sections, "叙事段落", 100, (item, index) => {
      const section = object(item, `叙事段落 ${index + 1}`);
      exact(section, ["startMs", "endMs", "role", "summary", "technique", "evidenceRefs"], `叙事段落 ${index + 1}`);
      const startMs = integer(section.startMs, "段落开始时间");
      const endMs = integer(section.endMs, "段落结束时间");
      if (endMs <= startMs) throw new DouyinAnalysisContractError(400, "叙事段落结束时间必须晚于开始时间");
      return { startMs, endMs, role: text(section.role, "段落作用", 100), summary: text(section.summary, "段落摘要", 1_000),
        technique: text(section.technique, "段落技巧", 500), evidenceRefs: parseEvidenceRefs(section.evidenceRefs, "段落证据") };
    }),
    observations: list(narrativeValue.observations, "叙事结论", 100, (item, index) => parseObservation(item, `叙事结论 ${index + 1}`)),
  } : null;

  const pacingValue = value.pacing === null ? null : object(value.pacing, "节奏分析");
  if (pacingValue) exact(pacingValue, ["metrics", "observations"], "节奏分析");
  const pacing = pacingValue ? {
    metrics: (() => {
      const metrics = object(pacingValue.metrics, "节奏指标");
      if (Object.keys(metrics).length > 50) throw new DouyinAnalysisContractError(400, "节奏指标过多");
      return Object.fromEntries(Object.entries(metrics).map(([key, metric]) => [text(key, "节奏指标名", 100),
        typeof metric === "number" && Number.isFinite(metric) ? metric : (() => { throw new DouyinAnalysisContractError(400, "节奏指标必须是有限数值"); })()]));
    })(),
    observations: list(pacingValue.observations, "节奏结论", 100, (item, index) => parseObservation(item, `节奏结论 ${index + 1}`)),
  } : null;

  const audienceValue = value.audience === null ? null : object(value.audience, "受众分析");
  if (audienceValue) exact(audienceValue, ["interpretationOnly", "observations"], "受众分析");
  if (audienceValue && audienceValue.interpretationOnly !== true) {
    throw new DouyinAnalysisContractError(400, "评论分析必须标记 interpretationOnly=true");
  }

  const report: DouyinAnalysisReport = {
    version: DOUYIN_ANALYSIS_REPORT_VERSION,
    evidence: parsedEvidence,
    availability,
    content: parseObservationProfile(value.content, "内容分析"),
    narrative,
    pacing,
    visual: parseObservationProfile(value.visual, "视觉分析"),
    audioSubtitle: parseObservationProfile(value.audioSubtitle, "音频字幕分析"),
    audience: audienceValue ? { interpretationOnly: true,
      observations: list(audienceValue.observations, "受众结论", 100, (item, index) => parseObservation(item, `受众结论 ${index + 1}`)) } : null,
    observations: list(value.observations, "综合结论", 200, (item, index) => parseObservation(item, `综合结论 ${index + 1}`)),
    risks: list(value.risks, "风险", 100, (item, index) => {
      const risk = object(item, `风险 ${index + 1}`);
      exact(risk, ["code", "summary", "evidenceRefs"], `风险 ${index + 1}`);
      return { code: text(risk.code, "风险代码", 100), summary: text(risk.summary, "风险摘要", 1_000),
        evidenceRefs: parseEvidenceRefs(risk.evidenceRefs, "风险证据") };
    }),
  };
  if (validEvidenceRefs) {
    const refs = [report.content, report.narrative, report.pacing, report.visual, report.audioSubtitle, report.audience]
      .flatMap((profile) => profile?.observations ?? []).concat(report.observations)
      .flatMap((observation) => observation.evidenceRefs)
      .concat(report.narrative?.sections.flatMap((section) => section.evidenceRefs) ?? [], report.risks.flatMap((risk) => risk.evidenceRefs));
    if (refs.some((ref) => !validEvidenceRefs.has(ref))) throw new DouyinAnalysisContractError(400, "报告包含无法回读的证据引用");
  }
  return report;
}
