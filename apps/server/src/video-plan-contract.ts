import { createHash } from "node:crypto";

import type { ChapterTextModelConfig } from "./chapter-event-analyzer.js";
import type { getGlobalPromptSettings, getProjectSettings, getVideoInput } from "./creative-input-store.js";
import type { FrozenDouyinPlanInput } from "./douyin-plan-whitelist.js";
import type { FrozenZhihuPlanInput } from "./zhihu-plan-whitelist.js";

export const VIDEO_PLAN_JOB_TYPE = "video_plan_generate";
export const VIDEO_PLAN_SYSTEM_CONTRACT_VERSION = "video-plan-system-v1";
export const VIDEO_PLAN_PROMPT_VERSION = "video-plan-prompt-v2";
export const VIDEO_PLAN_WEB_CAPABILITY = "model-web-search-v1";

export type VideoPlanStatus = "draft" | "preparing_sources" | "generating_script" | "planning_visuals" |
  "awaiting_review" | "failed" | "cancelled";

export class VideoPlanError extends Error {
  constructor(readonly statusCode: number, message: string) { super(message); }
}

export interface VideoPlanModelSnapshot {
  providerId: string;
  modelId: string;
  protocol: "openai-response" | "anthropic-message";
  baseUrl: string;
  identityHash: string;
}

export interface FrozenVideoPlanSnapshot {
  id: string;
  videoId: string;
  input: ReturnType<typeof getVideoInput> & { douyin?: FrozenDouyinPlanInput | null; zhihu?: FrozenZhihuPlanInput | null };
  prompts: {
    global: ReturnType<typeof getGlobalPromptSettings>;
    project: ReturnType<typeof getProjectSettings>;
    video: { scriptInstructions: string; visualInstructions: string };
  };
  model: VideoPlanModelSnapshot;
  systemContractVersion: typeof VIDEO_PLAN_SYSTEM_CONTRACT_VERSION;
  webCapability: typeof VIDEO_PLAN_WEB_CAPABILITY;
  canonicalJson: string;
  snapshotHash: string;
  createdAt: number;
  invalidatedAt: number | null;
}

export interface VideoPlanParagraph { id: string; text: string }
export interface VideoPlanSourceEvidence {
  id: string;
  sourceIndex: number;
  query: string;
  provider: string;
  tool: string;
  retrievedAt: number;
  url: string;
  title: string;
  usageSummary: string;
}
export interface VideoScriptContent {
  title: string;
  summary: string;
  narration: string;
  estimatedCharacters: number;
  estimatedDurationSeconds: number;
  paragraphs: VideoPlanParagraph[];
  sourceSummary: string[];
  risks: string[];
}

export interface VideoVisualItem {
  id: string;
  paragraphId: string;
  purpose: string;
  description: string;
  prompt: string;
  negativePrompt: string;
  suggestedDurationSeconds: number;
  weight: number;
  generationStatus: "not_generated";
  currentCandidate: null;
}
export interface VideoVisualContent { visuals: VideoVisualItem[] }

export interface VideoScriptRevision extends VideoScriptContent {
  id: string;
  revision: number;
  contentHash: string;
  createdAt: number;
}

export interface VideoVisualRevision extends VideoVisualContent {
  id: string;
  revision: number;
  scriptRevisionId: string;
  scriptContentHash: string;
  contentHash: string;
  createdAt: number;
}

export interface GenerateVideoPlanInput {
  stage: "script" | "visual";
  prompt: string;
  signal: AbortSignal;
  onActivity: () => void;
}
export type GenerateVideoPlan = (input: GenerateVideoPlanInput) => Promise<unknown>;

export const VIDEO_PLAN_ID = /^[A-Za-z0-9_-]+$/u;
export const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");

export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
  }
  const serialized = JSON.stringify(value);
  if (serialized === undefined) throw new VideoPlanError(400, "方案数据必须可以序列化");
  return serialized;
}

export function planObject(value: unknown, label: string) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new VideoPlanError(422, `${label}无效`);
  return value as Record<string, unknown>;
}

function exactFields(row: Record<string, unknown>, fields: readonly string[], label: string) {
  if (Object.keys(row).some((key) => !fields.includes(key)) || fields.some((key) => !(key in row))) {
    throw new VideoPlanError(422, `${label}字段无效`);
  }
}

export function planText(value: unknown, label: string, maximum = 100_000) {
  if (typeof value !== "string") throw new VideoPlanError(422, `${label}无效`);
  const normalized = value.replace(/\r\n?/gu, "\n").trim();
  if (!normalized || [...normalized].length > maximum) throw new VideoPlanError(422, `${label}无效`);
  return normalized;
}

function optionalStringList(value: unknown, label: string, maximum = 30) {
  if (!Array.isArray(value) || value.length > maximum) throw new VideoPlanError(422, `${label}无效`);
  return value.map((item) => planText(item, label, 2_000));
}

function positiveNumber(value: unknown, label: string, maximum = 10_000) {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0 || value > maximum) {
    throw new VideoPlanError(422, `${label}无效`);
  }
  return value;
}

function stableId(prefix: string, snapshotHash: string, index: number, value: string) {
  return `${prefix}_${sha256(`${snapshotHash}\0${index}\0${value}`).slice(0, 20)}`;
}

export function parseGeneratedScript(value: unknown, snapshot: FrozenVideoPlanSnapshot, sources: readonly VideoPlanSourceEvidence[] = []): VideoScriptContent {
  const row = planObject(value, "旁白方案输出");
  const requiredFields = ["title", "summary", "paragraphs", "sourceSummary", "risks"];
  const allowedFields = [...requiredFields, "narration"];
  if (Object.keys(row).some((key) => !allowedFields.includes(key)) || requiredFields.some((key) => !(key in row))) {
    throw new VideoPlanError(422, "旁白方案输出字段无效");
  }
  if (!Array.isArray(row.paragraphs) || row.paragraphs.length < 1 || row.paragraphs.length > 200) {
    throw new VideoPlanError(422, "旁白段落列表无效");
  }
  const paragraphs = row.paragraphs.map((item, index) => {
    const paragraph = planObject(item, "旁白段落");
    exactFields(paragraph, ["text"], "旁白段落");
    const paragraphText = planText(paragraph.text, "旁白段落正文", 20_000);
    return { id: stableId("paragraph", snapshot.snapshotHash, index, paragraphText), text: paragraphText };
  });
  // 段落正文是模型唯一的旁白来源；完整旁白由服务端派生，避免模型分别改写两份正文。
  const narration = paragraphs.map((item) => item.text).join("\n\n");
  const estimatedCharacters = [...narration.replace(/\s+/gu, "")].length;
  const maximumCharacters = Math.ceil(snapshot.input.targetDurationSeconds * 5.5);
  // 中文可朗读稿只做预算估算；过短内容会直接破坏“目标时长量级”的产品合同。
  if (estimatedCharacters < snapshot.input.targetDurationSeconds * 1.5) {
    throw new VideoPlanError(422, "旁白明显短于目标时长，请重试生成完整内容");
  }
  if (estimatedCharacters > maximumCharacters) {
    throw new VideoPlanError(422, `旁白明显长于目标时长，最多允许 ${maximumCharacters} 字`);
  }
  const generatedSourceSummary = optionalStringList(row.sourceSummary, "来源摘要");
  if (!snapshot.input.webEnabled && generatedSourceSummary.length > 0) {
    throw new VideoPlanError(422, "本次未联网核验，旁白方案不得包含来源摘要");
  }
  if (snapshot.input.webEnabled && sources.length < 1) throw new VideoPlanError(422, "联网方案缺少冻结来源");
  // 来源摘要由已冻结搜索结果确定，不能采用模型自行生成、无法核验的引用。
  const sourceSummary = snapshot.input.webEnabled
    ? sources.map((source) => `${source.title}：${source.usageSummary || source.url}`)
    : [];
  return {
    title: planText(row.title, "标题建议", 100), summary: planText(row.summary, "内容摘要", 2_000), narration,
    estimatedCharacters, estimatedDurationSeconds: Math.round(estimatedCharacters / 3.5), paragraphs,
    sourceSummary, risks: optionalStringList(row.risks, "风险或待核对项"),
  };
}

export function parseEditedParagraphs(value: unknown, current: VideoScriptContent) {
  if (!Array.isArray(value) || value.length < 1 || value.length > 200) throw new VideoPlanError(400, "旁白段落列表无效");
  const known = new Set(current.paragraphs.map((item) => item.id));
  const seen = new Set<string>();
  return value.map((item) => {
    const row = planObject(item, "旁白段落");
    exactFields(row, ["id", "text"], "旁白段落");
    const id = planText(row.id, "段落 ID", 100);
    if (!known.has(id) || seen.has(id)) throw new VideoPlanError(409, "旁白段落身份已变化，请刷新后重试");
    seen.add(id);
    return { id, text: planText(row.text, "旁白段落正文", 20_000) };
  });
}

export function parseGeneratedVisual(value: unknown, snapshot: FrozenVideoPlanSnapshot, script: VideoScriptContent): VideoVisualContent {
  const row = planObject(value, "画面方案输出");
  exactFields(row, ["visuals"], "画面方案输出");
  return parseVisualItems(row.visuals, snapshot, script, false);
}

export function parseVisualItems(value: unknown, snapshot: FrozenVideoPlanSnapshot, script: VideoScriptContent, editing: boolean): VideoVisualContent {
  if (!Array.isArray(value) || value.length < 1 || value.length > 300) throw new VideoPlanError(422, "画面列表无效");
  const paragraphIds = new Set(script.paragraphs.map((item) => item.id));
  const seen = new Set<string>();
  const visuals = value.map((item, index) => {
    const row = planObject(item, "画面项");
    exactFields(row, editing
      ? ["id", "paragraphId", "purpose", "description", "prompt", "negativePrompt", "suggestedDurationSeconds", "weight", "generationStatus", "currentCandidate"]
      : ["paragraphId", "purpose", "description", "prompt", "negativePrompt", "suggestedDurationSeconds", "weight"], "画面项");
    if (editing && (row.generationStatus !== "not_generated" || row.currentCandidate !== null)) {
      throw new VideoPlanError(422, "本阶段画面必须保持未生成状态");
    }
    const paragraphId = planText(row.paragraphId, "关联段落 ID", 100);
    if (!paragraphIds.has(paragraphId)) throw new VideoPlanError(422, "画面引用了未知旁白段落");
    const description = planText(row.description, "中文画面描述", 4_000);
    const id = editing && typeof row.id === "string" && VIDEO_PLAN_ID.test(row.id)
      ? row.id : stableId("visual", snapshot.snapshotHash, index, `${paragraphId}\0${description}`);
    if (seen.has(id)) throw new VideoPlanError(422, "画面 ID 重复");
    seen.add(id);
    return {
      id, paragraphId, purpose: planText(row.purpose, "画面用途", 500), description,
      prompt: planText(row.prompt, "生图 Prompt", 8_000), negativePrompt: planText(row.negativePrompt, "负面 Prompt", 4_000),
      suggestedDurationSeconds: positiveNumber(row.suggestedDurationSeconds, "建议时长", 600),
      weight: positiveNumber(row.weight, "画面权重", 100), generationStatus: "not_generated" as const, currentCandidate: null,
    };
  });
  return { visuals };
}

export function createVideoPlanModelSnapshot(config: ChapterTextModelConfig): VideoPlanModelSnapshot {
  const providerId = planText(config.providerId, "文本模型 provider", 100);
  const modelId = planText(config.model, "文本模型", 200);
  const protocol = config.protocol ?? "openai-response";
  const baseUrl = planText(config.baseUrl, "文本模型地址", 2_000).replace(/\/+$/u, "");
  return { providerId, modelId, protocol, baseUrl, identityHash: sha256(canonical({ providerId, modelId, protocol, baseUrl })) };
}

export function scriptPrompt(snapshot: FrozenVideoPlanSnapshot, sources: readonly VideoPlanSourceEvidence[] = []) {
  const { douyin = null, zhihu = null, ...creativeInput } = snapshot.input;
  const external = douyin ?? zhihu;
  const currentOperation = external?.usageRole === "topic_seed" || external?.usageRole === "content_source"
    ? { input: { targetDurationSeconds: creativeInput.targetDurationSeconds, visualDensity: creativeInput.visualDensity },
      douyin, zhihu, webEnabled: creativeInput.webEnabled,
      sourcePolicy: creativeInput.webEnabled ? "只允许使用以下冻结搜索来源，不得补写其他事实或 URL" : "本次未联网核验",
      sources: sources.map(({ title, url, usageSummary, retrievedAt }) => ({ title, url, summary: usageSummary, retrievedAt })) }
    : { input: creativeInput, douyin, zhihu, webEnabled: creativeInput.webEnabled,
      sourcePolicy: creativeInput.webEnabled ? "只允许使用以下冻结搜索来源，不得补写其他事实或 URL" : "本次未联网核验",
      sources: sources.map(({ title, url, usageSummary, retrievedAt }) => ({ title, url, summary: usageSummary, retrievedAt })) };
  return [
    "【固定系统合同】", "生成中文旁白方案。参考文本只有 referenceRole=content_source 时才可作为事实资料；style_only 仅参考表达方式。",
    "不得伪造人物、数字、引文、URL 或来源。短主题应扩写成目标时长量级的完整讲解，不重复观点凑字数。",
    "抖音方法画像只用于组织叙事，不得复制参考视频的原句或专有细节。评论洞察仅作受众解读，不得作为事实。来源边界、未核验说明和分析过程只写入 risks，不得写入 narration 或 paragraphs。",
    `系统合同版本：${snapshot.systemContractVersion}；输出版本：${VIDEO_PLAN_PROMPT_VERSION}。`,
    "严格输出 JSON：{\"title\":\"\",\"summary\":\"\",\"paragraphs\":[{\"text\":\"\"}],\"sourceSummary\":[],\"risks\":[]}。paragraphs 是唯一旁白正文来源；每个 text 必须是完整旁白的连续分段，不得写摘要、提纲或画面说明。服务端会按段落顺序拼接完整旁白，因此不要输出 narration 字段。sourceSummary 保持空数组，由系统根据冻结来源补齐；不得增加字段或 Markdown。",
    "【全局补充】", snapshot.prompts.global.scriptInstructions || "（无）", "【项目补充】", snapshot.prompts.project.scriptInstructions || "（无）",
    "【视频补充】", snapshot.prompts.video.scriptInstructions || "（无）",
    "【当前操作】", JSON.stringify(currentOperation),
  ].join("\n\n");
}

export function visualPrompt(snapshot: FrozenVideoPlanSnapshot, script: VideoScriptRevision) {
  return [
    "【固定系统合同】", "为已生成旁白规划 9:16、1080×1920 的语义画面草案，不调用图片模型。图片内可读中文默认交给渲染层。",
    "每个画面必须关联真实 paragraphId。generationStatus/currentCandidate 由系统补齐，不要输出。",
    "严格输出 JSON：{\"visuals\":[{\"paragraphId\":\"\",\"purpose\":\"\",\"description\":\"\",\"prompt\":\"\",\"negativePrompt\":\"\",\"suggestedDurationSeconds\":1,\"weight\":1}]}。不得增加字段或 Markdown。",
    "【全局补充】", snapshot.prompts.global.visualInstructions || "（无）", "【项目补充】", snapshot.prompts.project.visualInstructions || "（无）",
    "【视频补充】", snapshot.prompts.video.visualInstructions || "（无）",
    "【当前操作】", JSON.stringify({ visualDensity: snapshot.input.visualDensity, targetDurationSeconds: snapshot.input.targetDurationSeconds,
      douyinMethod: snapshot.input.douyin && "methodProfile" in snapshot.input.douyin.payload
        ? { methodProfile: snapshot.input.douyin.payload.methodProfile } : null,
      zhihuMethod: snapshot.input.zhihu && "methodPatterns" in snapshot.input.zhihu.payload
        ? { methodPatterns: snapshot.input.zhihu.payload.methodPatterns } : null,
      script: { title: script.title, summary: script.summary, paragraphs: script.paragraphs } }),
  ].join("\n\n");
}
