export const CREATIVE_INPUT_LIMITS = {
  topicCodePoints: 200,
  bodyBytes: 128 * 1024,
  referenceTextBytes: 64 * 1024,
  instructionCodePoints: 20_000,
} as const;

export const INPUT_MODES = ["topic", "body"] as const;
export const REFERENCE_ROLES = ["style_only", "content_source"] as const;
export const VISUAL_DENSITIES = ["relaxed", "standard", "compact"] as const;

export type InputMode = typeof INPUT_MODES[number];
export type ReferenceRole = typeof REFERENCE_ROLES[number];
export type VisualDensity = typeof VISUAL_DENSITIES[number];

export interface CreativeInstructions {
  scriptInstructions: string;
  visualInstructions: string;
}

export interface VideoInputDraft extends CreativeInstructions {
  inputMode: InputMode;
  topic: string;
  body: string;
  referenceText: string;
  referenceRole: ReferenceRole;
  targetDurationSeconds: number;
  visualDensity: VisualDensity;
  webEnabled: boolean;
}

export class CreativeInputError extends Error {
  constructor(readonly statusCode: number, message: string) { super(message); }
}

function exactObject(value: unknown, fields: readonly string[], message: string) {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      Object.keys(value).sort().join(",") !== [...fields].sort().join(",")) {
    throw new CreativeInputError(400, message);
  }
  return value as Record<string, unknown>;
}

function codePoints(value: string) {
  return [...value].length;
}

function multiline(value: unknown, label: string, maximum: number, unit: "bytes" | "codePoints") {
  if (typeof value !== "string") throw new CreativeInputError(400, `${label}必须是文本`);
  const normalized = value.replace(/\r\n?/gu, "\n").trim();
  const length = unit === "bytes" ? Buffer.byteLength(normalized, "utf8") : codePoints(normalized);
  if (length > maximum) {
    throw new CreativeInputError(400, unit === "bytes"
      ? `${label}不能超过 ${maximum} 个 UTF-8 字节，请缩短后重试`
      : `${label}不能超过 ${maximum} 个字符，请缩短后重试`);
  }
  return normalized;
}

function topic(value: unknown) {
  if (typeof value !== "string") throw new CreativeInputError(400, "主题必须是文本");
  const normalized = value.normalize("NFKC").trim().replace(/\s+/gu, " ");
  if (codePoints(normalized) > CREATIVE_INPUT_LIMITS.topicCodePoints) {
    throw new CreativeInputError(400, `主题不能超过 ${CREATIVE_INPUT_LIMITS.topicCodePoints} 个字符，请缩短后重试`);
  }
  return normalized;
}

function enumeration<T extends string>(value: unknown, values: readonly T[], label: string) {
  if (typeof value !== "string" || !values.includes(value as T)) {
    throw new CreativeInputError(400, `${label}无效`);
  }
  return value as T;
}

const INSTRUCTION_FIELDS = ["scriptInstructions", "visualInstructions"] as const;
const VIDEO_INPUT_FIELDS = [
  "inputMode", "topic", "body", "referenceText", "referenceRole", "targetDurationSeconds",
  "visualDensity", "webEnabled", ...INSTRUCTION_FIELDS,
] as const;

export function parseCreativeInstructions(value: unknown, label = "创作设置"): CreativeInstructions {
  const input = exactObject(value, INSTRUCTION_FIELDS, `${label}必须完整提交文案补充和画面补充，且不能包含其他字段`);
  return {
    scriptInstructions: multiline(input.scriptInstructions, "文案补充",
      CREATIVE_INPUT_LIMITS.instructionCodePoints, "codePoints"),
    visualInstructions: multiline(input.visualInstructions, "画面补充",
      CREATIVE_INPUT_LIMITS.instructionCodePoints, "codePoints"),
  };
}

export function parseVideoInputDraft(value: unknown, options: { allowEmptyPrimary?: boolean } = {}): VideoInputDraft {
  const input = exactObject(value, VIDEO_INPUT_FIELDS, "视频输入草稿字段不完整或包含未支持字段");
  const inputMode = enumeration(input.inputMode, INPUT_MODES, "输入模式");
  const normalizedTopic = topic(input.topic);
  const body = multiline(input.body, "正文", CREATIVE_INPUT_LIMITS.bodyBytes, "bytes");
  if (!options.allowEmptyPrimary && inputMode === "topic" && !normalizedTopic) {
    throw new CreativeInputError(400, "请输入主题后再生成方案");
  }
  if (!options.allowEmptyPrimary && inputMode === "body" && !body) {
    throw new CreativeInputError(400, "请粘贴正文后再生成方案");
  }
  if (typeof input.targetDurationSeconds !== "number" ||
      !Number.isInteger(input.targetDurationSeconds) ||
      input.targetDurationSeconds < 60 || input.targetDurationSeconds > 600) {
    throw new CreativeInputError(400, "目标时长必须是 60～600 秒的整数");
  }
  if (typeof input.webEnabled !== "boolean") {
    throw new CreativeInputError(400, "本次联网开关必须是布尔值");
  }
  return {
    inputMode,
    topic: normalizedTopic,
    body,
    referenceText: multiline(input.referenceText, "参考文本",
      CREATIVE_INPUT_LIMITS.referenceTextBytes, "bytes"),
    referenceRole: enumeration(input.referenceRole, REFERENCE_ROLES, "参考文本角色"),
    targetDurationSeconds: input.targetDurationSeconds,
    visualDensity: enumeration(input.visualDensity, VISUAL_DENSITIES, "画面密度"),
    webEnabled: input.webEnabled,
    ...parseCreativeInstructions({
      scriptInstructions: input.scriptInstructions,
      visualInstructions: input.visualInstructions,
    }, "视频创作补充"),
  };
}

export function layeredCreativePrompt(input: {
  fixedSystemContract: string;
  globalInstructions: string;
  projectInstructions: string;
  videoInstructions: string;
  localRewriteInstructions: string;
}) {
  return [input.fixedSystemContract, input.globalInstructions, input.projectInstructions,
    input.videoInstructions, input.localRewriteInstructions].filter(Boolean).join("\n\n");
}
