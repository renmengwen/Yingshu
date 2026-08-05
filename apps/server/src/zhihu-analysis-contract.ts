import { createHash } from "node:crypto";

export const ZHIHU_ANALYSIS_JOB_TYPE = "zhihu_answer_analysis";
export const ZHIHU_ANALYSIS_REPORT_VERSION = "yingshu-zhihu-analysis-v1" as const;

export type ZhihuUsageRole = "method_only" | "topic_seed" | "content_source";
export type ZhihuAnalysisStatus = "queued" | "running" | "partial" | "succeeded" | "failed" | "cancelled";
export type ZhihuCompleteness = "unavailable" | "partial" | "complete";
export type ZhihuEvidenceStatus = "not_requested" | "pending" | "running" | "partial" | "succeeded" | "failed" | "cancelled";
export const ZHIHU_AVAILABILITY_DIMENSIONS = ["original", "method", "topic", "audience"] as const;
export type ZhihuAvailabilityDimension = typeof ZHIHU_AVAILABILITY_DIMENSIONS[number];
export type ZhihuAcceptedMissingDimension = ZhihuAvailabilityDimension | "comments";

export interface ZhihuAnalysisConfig {
  sourceUrl: string;
  analyzeComments: boolean;
  maxComments: number;
}

export interface ZhihuObservation {
  dimension: string;
  conclusion: string;
  evidenceRefs: string[];
  confidence: "high" | "medium" | "low";
  nature: "observation" | "inference" | "unknown";
}

export interface ZhihuAnalysisReport {
  version: typeof ZHIHU_ANALYSIS_REPORT_VERSION;
  evidence: {
    answerStatus: ZhihuEvidenceStatus;
    commentsStatus: ZhihuEvidenceStatus;
    commentCount: number;
    evidenceHash: string;
    capturedAt: number;
    analyzedAt: number;
    modelIdentity: string;
    completeness: ZhihuCompleteness;
  };
  availability: Record<ZhihuAvailabilityDimension, { status: "available" | "partial" | "unavailable"; reason: string }>;
  /** 回答正文仅是可追溯的来源证据，不自动提升为客观事实。 */
  original: { sourceEvidenceOnly: true; title: string; authorName: string; bodyText: string; observations: ZhihuObservation[] } | null;
  method: { observations: ZhihuObservation[] } | null;
  topic: { observations: ZhihuObservation[] } | null;
  audience: { interpretationOnly: true; observations: ZhihuObservation[] } | null;
  observations: ZhihuObservation[];
  risks: Array<{ code: string; summary: string; evidenceRefs: string[] }>;
}

export interface ZhihuAnalysisSelectionInput {
  snapshotId: string;
  usageRole: ZhihuUsageRole;
  creativeAngle: string;
  rightsConfirmed: boolean;
  acceptedMissingDimensions: ZhihuAcceptedMissingDimension[];
}

export class ZhihuAnalysisContractError extends Error {
  constructor(readonly statusCode: number, message: string) { super(message); }
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ZhihuAnalysisContractError(400, `${label}必须是对象`);
  return value as Record<string, unknown>;
}

function exact(value: Record<string, unknown>, fields: readonly string[], label: string) {
  const keys = Object.keys(value);
  if (keys.length !== fields.length || keys.some((key) => !fields.includes(key))) throw new ZhihuAnalysisContractError(400, `${label}字段无效`);
}

function text(value: unknown, label: string, max: number, allowEmpty = false) {
  if (typeof value !== "string") throw new ZhihuAnalysisContractError(400, `${label}必须是文本`);
  const normalized = value.normalize("NFC").trim();
  if (!allowEmpty && !normalized) throw new ZhihuAnalysisContractError(400, `${label}不能为空`);
  if ([...normalized].length > max) throw new ZhihuAnalysisContractError(400, `${label}不能超过 ${max} 个字符`);
  return normalized;
}

function integer(value: unknown, label: string, min = 0, max = Number.MAX_SAFE_INTEGER) {
  if (!Number.isSafeInteger(value) || (value as number) < min || (value as number) > max) {
    throw new ZhihuAnalysisContractError(400, `${label}必须是 ${min}～${max} 的整数`);
  }
  return value as number;
}

function enumeration<T extends string>(value: unknown, values: readonly T[], label: string): T {
  if (typeof value !== "string" || !values.includes(value as T)) throw new ZhihuAnalysisContractError(400, `${label}无效`);
  return value as T;
}

function list<T>(value: unknown, label: string, max: number, parse: (item: unknown, index: number) => T): T[] {
  if (!Array.isArray(value) || value.length > max) throw new ZhihuAnalysisContractError(400, `${label}必须是最多 ${max} 项的数组`);
  return value.map(parse);
}

function hash(value: unknown, label: string) {
  const result = text(value, label, 64);
  if (!/^[0-9a-f]{64}$/.test(result)) throw new ZhihuAnalysisContractError(400, `${label}无效`);
  return result;
}

export function canonicalZhihuJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalZhihuJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalZhihuJson(record[key])}`).join(",")}}`;
}

export function zhihuSha256(value: string) { return createHash("sha256").update(value).digest("hex"); }

export function parseZhihuAnswerUrl(raw: unknown) {
  const sourceUrl = text(raw, "知乎回答链接", 2_000);
  let url: URL;
  try { url = new URL(sourceUrl); } catch { throw new ZhihuAnalysisContractError(400, "知乎回答链接无效"); }
  const match = url.pathname.match(/^\/question\/(\d+)\/answer\/(\d+)\/?$/u);
  if (url.protocol !== "https:" || !/(^|\.)zhihu\.com$/u.test(url.hostname) || !match) {
    throw new ZhihuAnalysisContractError(400, "只支持知乎问题下的标准回答链接");
  }
  url.hash = "";
  url.search = "";
  return { sourceUrl: url.toString(), questionId: match[1]!, answerId: match[2]! };
}

export function parseZhihuAnalysisConfig(raw: unknown): ZhihuAnalysisConfig {
  const value = object(raw, "知乎分析配置");
  exact(value, ["sourceUrl", "analyzeComments", "maxComments"], "知乎分析配置");
  const parsedUrl = parseZhihuAnswerUrl(value.sourceUrl);
  if (typeof value.analyzeComments !== "boolean") throw new ZhihuAnalysisContractError(400, "评论分析必须是布尔值");
  const maxComments = integer(value.maxComments, "评论数量", 0, 50);
  return { sourceUrl: parsedUrl.sourceUrl, analyzeComments: value.analyzeComments, maxComments };
}

/** 未请求评论时，草稿数量不应改变执行身份。 */
export function zhihuAnalysisConfigHash(config: ZhihuAnalysisConfig) {
  return zhihuSha256(canonicalZhihuJson({ ...config, maxComments: config.analyzeComments ? config.maxComments : null }));
}

export function parseZhihuAnalysisSelection(raw: unknown): ZhihuAnalysisSelectionInput {
  const value = object(raw, "知乎使用方式");
  exact(value, ["snapshotId", "usageRole", "creativeAngle", "rightsConfirmed", "acceptedMissingDimensions"], "知乎使用方式");
  const accepted = [...ZHIHU_AVAILABILITY_DIMENSIONS, "comments"] as const;
  const dimensions = list(value.acceptedMissingDimensions, "接受的缺失项", accepted.length,
    (item) => enumeration(item, accepted, "缺失维度"));
  if (new Set(dimensions).size !== dimensions.length) throw new ZhihuAnalysisContractError(400, "接受的缺失项不能重复");
  if (typeof value.rightsConfirmed !== "boolean") throw new ZhihuAnalysisContractError(400, "权利确认必须是布尔值");
  const result: ZhihuAnalysisSelectionInput = {
    snapshotId: text(value.snapshotId, "分析快照 ID", 100),
    usageRole: enumeration(value.usageRole, ["method_only", "topic_seed", "content_source"] as const, "使用方式"),
    creativeAngle: text(value.creativeAngle, "创作角度", 2_000, true),
    rightsConfirmed: value.rightsConfirmed,
    acceptedMissingDimensions: dimensions,
  };
  if (result.usageRole === "content_source" && !result.rightsConfirmed) {
    throw new ZhihuAnalysisContractError(409, "将回答正文作为改写来源前必须确认有权处理该内容");
  }
  return result;
}

function refs(value: unknown, label: string) { return list(value, label, 30, (item) => text(item, `${label}引用`, 200)); }

function observation(raw: unknown, label: string): ZhihuObservation {
  const value = object(raw, label);
  exact(value, ["dimension", "conclusion", "evidenceRefs", "confidence", "nature"], label);
  const result: ZhihuObservation = {
    dimension: text(value.dimension, `${label}维度`, 100), conclusion: text(value.conclusion, `${label}结论`, 2_000),
    evidenceRefs: refs(value.evidenceRefs, `${label}证据`),
    confidence: enumeration(value.confidence, ["high", "medium", "low"] as const, `${label}置信度`),
    nature: enumeration(value.nature, ["observation", "inference", "unknown"] as const, `${label}性质`),
  };
  if (result.nature !== "unknown" && result.evidenceRefs.length === 0) throw new ZhihuAnalysisContractError(400, `${label}至少需要一条证据`);
  if (result.nature === "unknown" && result.evidenceRefs.length) throw new ZhihuAnalysisContractError(400, `${label}的未知结论不得伪造证据`);
  return result;
}

function profile(raw: unknown, label: string) {
  if (raw === null) return null;
  const value = object(raw, label);
  exact(value, ["observations"], label);
  return { observations: list(value.observations, `${label}结论`, 100, (item, index) => observation(item, `${label}结论 ${index + 1}`)) };
}

export function parseZhihuAnalysisReport(raw: unknown, validEvidenceRefs?: ReadonlySet<string>): ZhihuAnalysisReport {
  const value = object(raw, "知乎分析报告");
  exact(value, ["version", "evidence", "availability", "original", "method", "topic", "audience", "observations", "risks"], "知乎分析报告");
  if (value.version !== ZHIHU_ANALYSIS_REPORT_VERSION) throw new ZhihuAnalysisContractError(400, "知乎分析报告版本无效");
  const evidence = object(value.evidence, "证据摘要");
  exact(evidence, ["answerStatus", "commentsStatus", "commentCount", "evidenceHash", "capturedAt", "analyzedAt", "modelIdentity", "completeness"], "证据摘要");
  const statuses = ["not_requested", "pending", "running", "partial", "succeeded", "failed", "cancelled"] as const;
  const availabilityValue = object(value.availability, "维度可用性");
  exact(availabilityValue, ZHIHU_AVAILABILITY_DIMENSIONS, "维度可用性");
  const availability = Object.fromEntries(ZHIHU_AVAILABILITY_DIMENSIONS.map((dimension) => {
    const item = object(availabilityValue[dimension], `${dimension} 可用性`);
    exact(item, ["status", "reason"], `${dimension} 可用性`);
    return [dimension, { status: enumeration(item.status, ["available", "partial", "unavailable"] as const, `${dimension} 状态`),
      reason: text(item.reason, `${dimension} 原因`, 500, true) }];
  })) as ZhihuAnalysisReport["availability"];
  const originalValue = value.original === null ? null : object(value.original, "回答原文");
  if (originalValue) exact(originalValue, ["sourceEvidenceOnly", "title", "authorName", "bodyText", "observations"], "回答原文");
  if (originalValue && originalValue.sourceEvidenceOnly !== true) throw new ZhihuAnalysisContractError(400, "回答正文必须标记 sourceEvidenceOnly=true");
  const audienceValue = value.audience === null ? null : object(value.audience, "评论受众分析");
  if (audienceValue) exact(audienceValue, ["interpretationOnly", "observations"], "评论受众分析");
  if (audienceValue && audienceValue.interpretationOnly !== true) throw new ZhihuAnalysisContractError(400, "评论分析必须标记 interpretationOnly=true");
  const report: ZhihuAnalysisReport = {
    version: ZHIHU_ANALYSIS_REPORT_VERSION,
    evidence: {
      answerStatus: enumeration(evidence.answerStatus, statuses, "回答证据状态"),
      commentsStatus: enumeration(evidence.commentsStatus, statuses, "评论证据状态"),
      commentCount: integer(evidence.commentCount, "评论数量", 0, 200), evidenceHash: hash(evidence.evidenceHash, "证据 Hash"),
      capturedAt: integer(evidence.capturedAt, "证据抓取时间"), analyzedAt: integer(evidence.analyzedAt, "报告分析时间"),
      modelIdentity: text(evidence.modelIdentity, "模型身份", 500),
      completeness: enumeration(evidence.completeness, ["unavailable", "partial", "complete"] as const, "报告完整性"),
    }, availability,
    original: originalValue ? { sourceEvidenceOnly: true, title: text(originalValue.title, "回答标题", 1_000, true),
      authorName: text(originalValue.authorName, "回答作者", 200, true), bodyText: text(originalValue.bodyText, "回答正文", 200_000),
      observations: list(originalValue.observations, "原文结论", 100, (item, index) => observation(item, `原文结论 ${index + 1}`)) } : null,
    method: profile(value.method, "方法分析"), topic: profile(value.topic, "选题分析"),
    audience: audienceValue ? { interpretationOnly: true,
      observations: list(audienceValue.observations, "受众结论", 100, (item, index) => observation(item, `受众结论 ${index + 1}`)) } : null,
    observations: list(value.observations, "综合结论", 200, (item, index) => observation(item, `综合结论 ${index + 1}`)),
    risks: list(value.risks, "风险", 100, (item, index) => {
      const risk = object(item, `风险 ${index + 1}`); exact(risk, ["code", "summary", "evidenceRefs"], `风险 ${index + 1}`);
      return { code: text(risk.code, "风险代码", 100), summary: text(risk.summary, "风险摘要", 1_000), evidenceRefs: refs(risk.evidenceRefs, "风险证据") };
    }),
  };
  if (validEvidenceRefs) {
    const used = [report.original, report.method, report.topic, report.audience].flatMap((item) => item?.observations ?? [])
      .concat(report.observations).flatMap((item) => item.evidenceRefs).concat(report.risks.flatMap((item) => item.evidenceRefs));
    if (used.some((ref) => !validEvidenceRefs.has(ref))) throw new ZhihuAnalysisContractError(400, "报告包含无法回读的证据引用");
  }
  return report;
}
