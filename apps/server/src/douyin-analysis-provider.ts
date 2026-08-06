import { createHash } from "node:crypto";

import {
  limitedResponseText,
  textModelRequest,
  type ChapterTextModelConfig,
} from "./chapter-event-analyzer.js";
import {
  DOUYIN_ANALYSIS_REPORT_VERSION,
  canonicalDouyinJson,
  parseDouyinAnalysisReport,
  type DouyinAnalysisReport,
} from "./douyin-analysis-contract.js";
import { textModelConcurrencyGate } from "./text-model-concurrency.js";
import {
  completedTextModelEvidence,
  streamedText,
  textModelCallError,
  TextModelStreamError,
  type TextModelCallEvidence,
  type TextModelStreamStatistics,
} from "./text-model-stream.js";
import { withTextModelTimeout } from "./text-model-timeout.js";

export const DOUYIN_ANALYSIS_PROMPT_VERSION = "yingshu-douyin-analysis-prompt-v1";
export const DOUYIN_ANALYSIS_SYSTEM_VERSION = "yingshu-douyin-analysis-system-v1";
const MAX_PROMPT_BYTES = 512 * 1024;
const MAX_TRANSCRIPT_SEGMENTS = 5_000;
const MAX_COMMENT_SAMPLES = 300;
const OUTPUT_SCHEMA = "{version:'yingshu-douyin-analysis-v1',evidence:frozenEvidenceSummary," +
  "availability:{content|narrative|pacing|visualOverall|visualOpening|audioSubtitle|audience|narrationVisualAlignment:" +
  "{status:'available'|'partial'|'unavailable',reason:string}}," +
  "content|visual|audioSubtitle:null|{observations:Observation[]}," +
  "narrative:null|{sections:[{startMs:number,endMs:number,role:string,summary:string,technique:string,evidenceRefs:string[]}],observations:Observation[]}," +
  "pacing:null|{metrics:deterministicMetrics,observations:Observation[]}," +
  "audience:null|{interpretationOnly:true,observations:Observation[]},observations:Observation[]," +
  "risks:[{code:string,summary:string,evidenceRefs:string[]}]}；" +
  "Observation={dimension:string,conclusion:string,evidenceRefs:string[],confidence:'high'|'medium'|'low'," +
  "nature:'observation'|'inference'|'unknown'}";

export interface DouyinTranscriptSegment {
  evidenceRef: string;
  startMs: number;
  endMs: number;
  text: string;
  structuralTransition?: boolean;
}

export interface DouyinDeterministicInput {
  durationMs: number;
  transcriptSegments: readonly DouyinTranscriptSegment[];
  semanticSections?: readonly { startMs: number; endMs: number }[];
  topicFirstMs?: number;
  firstValueDeliveryMs?: number;
  firstTurnMs?: number;
  ctaDurationMs?: number;
  obviousSilenceDurationMs?: number;
  media?: {
    width: number;
    height: number;
    frameRate: string | null;
    audioTrackCount: number;
    audioDurationMs: number | null;
  };
  audio?: {
    averageLoudnessDb: number | null;
    peakDb: number | null;
    clippingDurationMs: number | null;
  };
}

export interface DouyinAnalysisProviderInput {
  evidence: DouyinAnalysisReport["evidence"];
  validEvidenceRefs: ReadonlySet<string>;
  metadata: Readonly<Record<string, unknown>>;
  deterministic: DouyinDeterministicInput;
  frameObservations?: readonly { evidenceRef: string; timestampMs: number; observation: string }[];
  comments?: { interpretationOnly: true; samples: readonly { evidenceRef: string; text: string; likes: number }[] };
  supportsMultimodal: boolean;
  signal?: AbortSignal;
  onActivity?: () => void;
}

export interface DouyinAnalysisModelSnapshot {
  providerId: string;
  model: string;
  protocol: "openai-response" | "anthropic-message";
  baseUrl: string;
  modelIdentityHash: string;
  promptVersion: typeof DOUYIN_ANALYSIS_PROMPT_VERSION;
  systemVersion: typeof DOUYIN_ANALYSIS_SYSTEM_VERSION;
  inputHash: string;
  transcriptStrategy: "complete" | "uniform_time_coverage";
  omittedTranscriptRanges: Array<{ startMs: number; endMs: number }>;
}

export interface DouyinAnalysisProviderResult {
  report: DouyinAnalysisReport;
  modelSnapshot: DouyinAnalysisModelSnapshot;
}

function finite(value: number | null | undefined, label: string, minimum = 0) {
  if (value == null) return null;
  if (!Number.isFinite(value) || value < minimum) throw new Error(`${label}无效`);
  return value;
}

function countCharacters(value: string) {
  return value.match(/[\p{L}\p{N}]/gu)?.length ?? 0;
}

export function calculateDouyinDeterministicMetrics(input: DouyinDeterministicInput) {
  if (!Number.isSafeInteger(input.durationMs) || input.durationMs <= 0) throw new Error("视频时长无效");
  if (input.transcriptSegments.length > MAX_TRANSCRIPT_SEGMENTS) throw new Error("ASR 分段数量超过安全上限");
  const segments = input.transcriptSegments.map((segment) => {
    if (!segment.evidenceRef || !Number.isSafeInteger(segment.startMs) || !Number.isSafeInteger(segment.endMs) ||
        segment.startMs < 0 || segment.endMs <= segment.startMs || segment.endMs > input.durationMs) {
      throw new Error("ASR 分段时间或证据引用无效");
    }
    return { ...segment, characters: countCharacters(segment.text) };
  });
  const totalCharacters = segments.reduce((sum, segment) => sum + segment.characters, 0);
  const first15SecondsCharacters = segments.reduce((sum, segment) => {
    const covered = Math.max(0, Math.min(segment.endMs, 15_000) - segment.startMs);
    return sum + segment.characters * covered / (segment.endMs - segment.startMs);
  }, 0);
  const sentences = segments.flatMap((segment) => segment.text.split(/[。！？!?]+/u))
    .map(countCharacters).filter((length) => length > 0);
  const sections = input.semanticSections ?? [];
  for (const section of sections) {
    if (!Number.isSafeInteger(section.startMs) || !Number.isSafeInteger(section.endMs) ||
        section.startMs < 0 || section.endMs <= section.startMs || section.endMs > input.durationMs) {
      throw new Error("语义段时间无效");
    }
  }
  const metrics: Record<string, number> = {
    totalCharacters,
    charactersPerMinute: totalCharacters * 60_000 / input.durationMs,
    first15SecondsCharacters: Math.round(first15SecondsCharacters),
    averageSentenceCharacters: sentences.length ? sentences.reduce((sum, length) => sum + length, 0) / sentences.length : 0,
    averageSemanticSectionDurationMs: sections.length
      ? sections.reduce((sum, section) => sum + section.endMs - section.startMs, 0) / sections.length
      : 0,
    obviousSilenceDurationMs: finite(input.obviousSilenceDurationMs, "明显静默时长") ?? 0,
  };
  for (const [name, value] of [
    ["topicFirstMs", input.topicFirstMs],
    ["firstValueDeliveryMs", input.firstValueDeliveryMs],
    ["firstTurnMs", input.firstTurnMs],
  ] as const) {
    const checked = finite(value, name);
    if (checked !== null) metrics[name] = checked;
  }
  const ctaDurationMs = finite(input.ctaDurationMs, "CTA 时长");
  if (ctaDurationMs !== null) metrics.ctaDurationRatio = Math.min(ctaDurationMs, input.durationMs) / input.durationMs;
  if (input.media) {
    if (!Number.isSafeInteger(input.media.width) || input.media.width < 1 ||
        !Number.isSafeInteger(input.media.height) || input.media.height < 1 ||
        !Number.isSafeInteger(input.media.audioTrackCount) || input.media.audioTrackCount < 0) {
      throw new Error("媒体指标无效");
    }
    metrics.videoDurationMs = input.durationMs;
    metrics.videoWidth = input.media.width;
    metrics.videoHeight = input.media.height;
    metrics.videoAspectRatio = input.media.width / input.media.height;
    metrics.audioTrackCount = input.media.audioTrackCount;
    const audioDurationMs = finite(input.media.audioDurationMs, "音频时长");
    if (audioDurationMs !== null) metrics.audioDurationMs = audioDurationMs;
  }
  if (input.audio) {
    for (const [name, value] of [
      ["averageLoudnessDb", input.audio.averageLoudnessDb],
      ["peakDb", input.audio.peakDb],
      ["clippingDurationMs", input.audio.clippingDurationMs],
    ] as const) {
      const checked = finite(value, name, name === "clippingDurationMs" ? 0 : -200);
      if (checked !== null) metrics[name] = checked;
    }
  }
  return metrics;
}

function transcriptItem(segment: DouyinTranscriptSegment) {
  return { evidenceRef: segment.evidenceRef, startMs: segment.startMs, endMs: segment.endMs, text: segment.text };
}

function byteLength(value: unknown) {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

/** 二分层级依次加入中点、四分点、八分点，预算不足时仍均匀覆盖整条时间轴。 */
export function selectDouyinTranscriptSegments(segments: readonly DouyinTranscriptSegment[], maxBytes: number) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new Error("ASR 输入预算无效");
  if (segments.length > MAX_TRANSCRIPT_SEGMENTS) throw new Error("ASR 分段数量超过安全上限");
  const ordered = [...segments].sort((left, right) => left.startMs - right.startMs || left.endMs - right.endMs);
  const fullBytes = byteLength(ordered.map(transcriptItem));
  if (fullBytes <= maxBytes) return { segments: ordered, strategy: "complete" as const, omittedRanges: [] };
  const selected = new Set<number>();
  let used = 2;
  const add = (index: number) => {
    if (index < 0 || index >= ordered.length || selected.has(index)) return;
    const bytes = byteLength(transcriptItem(ordered[index]!)) + 1;
    if (used + bytes <= maxBytes) { selected.add(index); used += bytes; }
  };
  add(0);
  add(ordered.length - 1);
  const transitions = ordered.map((segment, index) => segment.structuralTransition ? index : -1).filter((index) => index >= 0);
  for (const index of transitions.length <= 32 ? transitions : transitions.filter((_, index) => index % Math.ceil(transitions.length / 32) === 0)) add(index);
  for (let denominator = 2; denominator < ordered.length * 2; denominator *= 2) {
    for (let numerator = 1; numerator < denominator; numerator += 2) {
      add(Math.round((ordered.length - 1) * numerator / denominator));
    }
  }
  const picked = [...selected].sort((left, right) => left - right).map((index) => ordered[index]!);
  if (!picked.length) throw new Error("ASR 输入预算不足以容纳任一分段");
  const omittedRanges: Array<{ startMs: number; endMs: number }> = [];
  let rangeStart: number | undefined;
  let rangeEnd = 0;
  for (let index = 0; index < ordered.length; index += 1) {
    if (selected.has(index)) {
      if (rangeStart !== undefined) omittedRanges.push({ startMs: rangeStart, endMs: rangeEnd });
      rangeStart = undefined;
    } else {
      rangeStart ??= ordered[index]!.startMs;
      rangeEnd = ordered[index]!.endMs;
    }
  }
  if (rangeStart !== undefined) omittedRanges.push({ startMs: rangeStart, endMs: rangeEnd });
  return { segments: picked, strategy: "uniform_time_coverage" as const, omittedRanges };
}

function modelIdentity(config: ChapterTextModelConfig) {
  return createHash("sha256").update(canonicalDouyinJson({ providerId: config.providerId, model: config.model,
    protocol: config.protocol ?? "openai-response", baseUrl: config.baseUrl.replace(/\/+$/u, "") })).digest("hex");
}

function reportObservations(report: DouyinAnalysisReport) {
  return [report.content, report.narrative, report.pacing, report.visual, report.audioSubtitle, report.audience]
    .flatMap((profile) => profile?.observations ?? []).concat(report.observations);
}

function deriveNarrativeMetrics(report: DouyinAnalysisReport, durationMs: number) {
  const sections = report.narrative?.sections ?? [];
  const metrics: Record<string, number> = {};
  if (!sections.length) return metrics;
  const firstMatching = (pattern: RegExp) => sections.find((section) => pattern.test(`${section.role} ${section.summary} ${section.technique}`));
  const topic = firstMatching(/钩子|问题|主题|开场/u) ?? sections[0];
  const value = firstMatching(/价值|方法|结论|兑现|答案|干货/u);
  const turn = firstMatching(/冲突|反转|转折|升级|危机/u);
  if (topic) metrics.topicFirstMs = topic.startMs;
  if (value) metrics.firstValueDeliveryMs = value.startMs;
  if (turn) metrics.firstTurnMs = turn.startMs;
  const ctaSections = sections.filter((section) => /行动|CTA|关注|评论|点赞|结尾|回扣/u.test(`${section.role} ${section.summary}`));
  if (ctaSections.length) metrics.ctaDurationMs = ctaSections.reduce((sum, section) => sum + section.endMs - section.startMs, 0);
  sections.forEach((section, index) => {
    const duration = section.endMs - section.startMs;
    metrics[`narrativeSection${index + 1}DurationMs`] = duration;
    metrics[`narrativeSection${index + 1}Ratio`] = duration / durationMs;
  });
  return metrics;
}

function validateNarrativeSections(report: DouyinAnalysisReport, input: DouyinAnalysisProviderInput) {
  const sections = report.narrative?.sections ?? [];
  let previousEnd = 0;
  for (const section of sections) {
    if (section.startMs < previousEnd || section.endMs > input.deterministic.durationMs) {
      throw new Error("叙事段时间线必须按顺序且位于视频时长内");
    }
    if (section.evidenceRefs.some((ref) => !input.validEvidenceRefs.has(ref))) {
      throw new Error("叙事段包含无法回读的证据引用");
    }
    previousEnd = section.endMs;
  }
}

function validateModelBoundary(report: DouyinAnalysisReport, input: DouyinAnalysisProviderInput, metrics: Record<string, number>) {
  if (canonicalDouyinJson(report.evidence) !== canonicalDouyinJson(input.evidence)) throw new Error("模型返回的冻结证据摘要不一致");
  if (!report.pacing || canonicalDouyinJson(report.pacing.metrics) !== canonicalDouyinJson(metrics)) {
    throw new Error("模型返回的确定性指标不一致");
  }
  if ((!input.supportsMultimodal || !input.frameObservations?.length) &&
      (report.visual !== null || report.availability.visualOverall.status !== "unavailable" ||
      report.availability.visualOpening.status !== "unavailable" || report.availability.narrationVisualAlignment.status !== "unavailable")) {
    throw new Error("没有可供模型读取的视觉证据，视觉维度必须不可用");
  }
  if (!input.comments && (report.audience !== null || report.availability.audience.status !== "unavailable")) {
    throw new Error("没有评论证据时受众维度必须不可用");
  }
  for (const observation of reportObservations(report)) {
    if (observation.nature === "inference" && observation.evidenceRefs.length < 2 &&
        !/(?:单一|仅有|有限|无法|不足).{0,20}(?:证据|样本|限制)/u.test(observation.conclusion)) {
      throw new Error("单一证据推断必须在结论中明确说明限制");
    }
  }
  const text = canonicalDouyinJson(report);
  if (/(?:博主|作者|账号).{0,12}(?:一贯|长期|稳定风格|固定风格)/u.test(text)) throw new Error("单条视频不得推断博主稳定风格");
  if (/(?:爆款|原创度|抄袭度|账号|综合)(?:概率)?分(?:数)?/u.test(text)) throw new Error("报告不得生成不可验证综合评分");
}

function redactDiagnosticText(value: string, secrets: readonly string[]) {
  let result = value;
  for (const secret of secrets) if (secret.length >= 6) result = result.split(secret).join("[REDACTED]");
  return result
    .replace(/(authorization|api[-_ ]?key|cookie)\s*[:=]\s*["']?[^\s,"'}]+/giu, "$1=[REDACTED]")
    .replace(/[A-Za-z]:\\[^\r\n"']+/gu, "[REDACTED_PATH]");
}

function promptPayload(input: DouyinAnalysisProviderInput, transcript: ReturnType<typeof selectDouyinTranscriptSegments>, metrics: Record<string, number>) {
  const frameObservations = input.supportsMultimodal ? (input.frameObservations ?? []).slice(0, 30) : [];
  const comments = input.comments ? { interpretationOnly: true as const, samples: input.comments.samples.slice(0, MAX_COMMENT_SAMPLES) } : null;
  return {
    reportVersion: DOUYIN_ANALYSIS_REPORT_VERSION,
    frozenEvidenceSummary: input.evidence,
    metadata: input.metadata,
    transcript: { strategy: transcript.strategy, omittedRanges: transcript.omittedRanges, segments: transcript.segments.map(transcriptItem) },
    frameObservations,
    comments,
    deterministicMetrics: metrics,
    validEvidenceRefs: [...input.validEvidenceRefs].sort(),
  };
}

function validateProviderInput(input: DouyinAnalysisProviderInput) {
  const evidenceRefs = [
    ...input.deterministic.transcriptSegments.map((item) => item.evidenceRef),
    ...(input.frameObservations ?? []).map((item) => item.evidenceRef),
    ...(input.comments?.samples ?? []).map((item) => item.evidenceRef),
  ];
  if (evidenceRefs.some((ref) => !input.validEvidenceRefs.has(ref))) throw new Error("分析输入包含无法回读的证据引用");
  if ((input.frameObservations?.length ?? 0) > 30) throw new Error("关键帧观察超过安全上限");
  if (input.comments && input.comments.interpretationOnly !== true) throw new Error("评论输入必须标记 interpretationOnly=true");
  if ((input.comments?.samples.length ?? 0) > MAX_COMMENT_SAMPLES) throw new Error("评论样本超过安全上限");
  for (const item of input.frameObservations ?? []) {
    if (!Number.isSafeInteger(item.timestampMs) || item.timestampMs < 0 || [...item.observation].length > 2_000) {
      throw new Error("关键帧观察无效");
    }
  }
  for (const item of input.comments?.samples ?? []) {
    if (!Number.isSafeInteger(item.likes) || item.likes < 0 || [...item.text].length > 1_000) throw new Error("评论样本无效");
  }
}

function buildPrompt(payload: ReturnType<typeof promptPayload>, correction?: string) {
  return [
    "你是映述的单条抖音视频证据分析器。只输出严格 JSON 对象，不要 Markdown、代码围栏或解释。",
    `系统合同版本：${DOUYIN_ANALYSIS_SYSTEM_VERSION}；Prompt 版本：${DOUYIN_ANALYSIS_PROMPT_VERSION}。`,
    "顶层字段必须且只能是 version,evidence,availability,content,narrative,pacing,visual,audioSubtitle,audience,observations,risks。",
    `唯一允许的输出 schema（竖线表示同类字段，不是实际字段名；所有对象不得增加 schema 外字段）：${OUTPUT_SCHEMA}`,
    "version 必须是固定字符串 yingshu-douyin-analysis-v1，不得输出版本对象；availability 每项必须是 {status,reason}；confidence 必须是枚举字符串而不是数值。",
    "完整遵守 yingshu-douyin-analysis-v1：每条非纯数值结论必须有 evidenceRefs、confidence、nature，且引用只能来自 validEvidenceRefs。",
    "只描述本视频观察到的特征，不推断博主、作者或账号的长期稳定风格；不得生成爆款、原创度、抄袭度、账号或综合评分。",
    "inference 至少引用两条证据；若只能引用一条，conclusion 必须明确说明单一证据限制。unknown 不得引用证据。",
    "pacing.metrics 必须逐字复用 deterministicMetrics；evidence 必须逐字复用 frozenEvidenceSummary，不得估算或改写。",
    "narrative.sections 必须按视频时间顺序输出真实叙事节点；每段 startMs/endMs 必须来自带时间戳转写证据，不能使用 180 秒切片边界代替。标注钩子、人物建立、价值兑现、冲突、反转、升级、高潮、回扣、结尾等能从证据确认的节点；无法确认时减少节点，不要编造。",
    "comments 为 null 时 audience=null 且 audience availability=unavailable；评论存在时 interpretationOnly 必须为 true，评论纠正只进入待核验风险。",
    "frameObservations 为空时 visual=null，visualOverall/visualOpening/narrationVisualAlignment 均为 unavailable；有限静态帧不得写成逐帧运动事实。",
    ...(correction ? [`上一次完整 JSON 未通过严格合同：${correction}`, "只纠正输出结构和合同字段，不改变下方冻结证据与确定性指标；重新输出完整 JSON。"] : []),
    "所有数组保持有界、文本简洁。输出 JSON：",
    JSON.stringify(payload),
  ].join("\n");
}

export function createDouyinAnalysisProvider(config: ChapterTextModelConfig, fetchImpl: typeof fetch = fetch) {
  let endpoint: URL;
  try { endpoint = textModelRequest(config, "").endpoint; } catch { throw new Error("抖音分析模型配置无效"); }
  if (!config.apiKey.trim() || !config.model.trim() || !config.providerId.trim() ||
      (endpoint.protocol !== "http:" && endpoint.protocol !== "https:")) throw new Error("抖音分析模型配置无效");
  const identity = modelIdentity(config);
  return async (input: DouyinAnalysisProviderInput): Promise<DouyinAnalysisProviderResult> => {
    validateProviderInput(input);
    // 模型身份由实际运行配置冻结，不能信任调用方或模型回填的字符串。
    const effectiveInput = { ...input, evidence: { ...input.evidence, modelIdentity: identity } };
    const metrics = calculateDouyinDeterministicMetrics(effectiveInput.deterministic);
    const transcriptBudget = Math.max(1, Math.floor(MAX_PROMPT_BYTES * 0.55));
    const transcript = selectDouyinTranscriptSegments(effectiveInput.deterministic.transcriptSegments, transcriptBudget);
    const payload = promptPayload(effectiveInput, transcript, metrics);
    const prompt = buildPrompt(payload);
    if (Buffer.byteLength(prompt, "utf8") > MAX_PROMPT_BYTES) throw new Error("抖音分析模型输入超过服务端安全上限");
    const inputHash = createHash("sha256").update(prompt).digest("hex");
    const snapshot: DouyinAnalysisModelSnapshot = {
      providerId: config.providerId,
      model: config.model,
      protocol: config.protocol ?? "openai-response",
      baseUrl: config.baseUrl.replace(/\/+$/u, ""),
      modelIdentityHash: identity,
      promptVersion: DOUYIN_ANALYSIS_PROMPT_VERSION,
      systemVersion: DOUYIN_ANALYSIS_SYSTEM_VERSION,
      inputHash,
      transcriptStrategy: transcript.strategy,
      omittedTranscriptRanges: transcript.omittedRanges,
    };
    const callModel = async (modelPrompt: string, stage: string) => {
      if (Buffer.byteLength(modelPrompt, "utf8") > MAX_PROMPT_BYTES) {
        throw textModelCallError(new Error("抖音分析模型输入超过服务端安全上限"), stage);
      }
      const request = textModelRequest(config, modelPrompt, 16_384, true);
      let statistics: TextModelStreamStatistics | undefined;
      let raw: string | undefined;
      try {
        raw = await withTextModelTimeout(async (signal, activity) => textModelConcurrencyGate.run(signal, async () => {
        const response = await fetchImpl(request.endpoint, { method: "POST", redirect: "error", signal,
          headers: request.headers, body: request.body });
        if (!response.ok) { await response.body?.cancel(); throw new Error(`抖音分析模型请求失败（HTTP ${response.status}）`); }
        const onActivity = () => { activity(); input.onActivity?.(); };
        return response.headers.get("content-type")?.toLowerCase().includes("text/event-stream")
          ? streamedText(response, config.protocol ?? "openai-response", { signal, onActivity,
              onStatistics: (value) => { statistics = value; } })
          : limitedResponseText(response, { protocol: config.protocol ?? "openai-response", signal, onActivity,
              onStatistics: (value) => { statistics = value; } });
        }), { firstActivityMs: 180_000, idleMs: 180_000, totalMs: 900_000, signal: input.signal });
        const parsed = JSON.parse(raw) as unknown;
        return { parsed, evidence: { ...completedTextModelEvidence(raw, statistics),
          partialText: redactDiagnosticText(raw, [config.apiKey]) } satisfies TextModelCallEvidence };
      } catch (error) {
        const evidence: TextModelCallEvidence = error instanceof TextModelStreamError
          ? { statistics: error.statistics, partialText: redactDiagnosticText(error.partialText, [config.apiKey]),
              partialTextTruncated: error.partialTextTruncated }
          : raw === undefined ? {} : { ...completedTextModelEvidence(raw, statistics),
              partialText: redactDiagnosticText(raw, [config.apiKey]) };
        throw textModelCallError(error instanceof SyntaxError ? new Error("抖音分析模型返回了无效严格 JSON", { cause: error }) : error,
          stage, evidence);
      }
    };
    const parse = (value: unknown) => {
      const report = parseDouyinAnalysisReport(value, input.validEvidenceRefs);
      validateNarrativeSections(report, effectiveInput);
      const derivedMetrics = deriveNarrativeMetrics(report, effectiveInput.deterministic.durationMs);
      if (report.narrative?.sections.length && report.pacing) {
        report.pacing = { ...report.pacing!, metrics: {
          ...report.pacing!.metrics,
          ...derivedMetrics,
        } };
      }
      validateModelBoundary(report, effectiveInput, { ...metrics, ...derivedMetrics });
      return report;
    };
    const initial = await callModel(prompt, "douyin-analysis:report:initial");
    try {
      return { report: parse(initial.parsed), modelSnapshot: snapshot };
    } catch (error) {
      const correction = await callModel(buildPrompt(payload, error instanceof Error ? error.message : "输出合同无效"),
        "douyin-analysis:report:correction-1");
      try {
        return { report: parse(correction.parsed), modelSnapshot: snapshot };
      } catch (correctedError) {
        throw textModelCallError(correctedError, "douyin-analysis:report:correction-1", correction.evidence);
      }
    }
  };
}
