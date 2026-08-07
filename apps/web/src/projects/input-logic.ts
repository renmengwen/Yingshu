import {
  getVideoOutputProfile,
  isAspectRatio,
  normalizeAspectRatio,
  type ProjectCreativeSettings,
  type VideoInputDraft,
} from "./types";

export const INPUT_LIMITS = {
  topicCodePoints: 200,
  bodyBytes: 128 * 1024,
  referenceBytes: 64 * 1024,
  instructionsCodePoints: 20_000,
} as const;

const byteLength = (value: string) => new TextEncoder().encode(value).byteLength;
const codePointLength = (value: string) => [...value].length;

function normalizeOptional(value: string) {
  return value.replace(/\r\n?/gu, "\n").trim();
}

function validateInstructions(value: string, label: string) {
  const normalized = normalizeOptional(value);
  if (codePointLength(normalized) > INPUT_LIMITS.instructionsCodePoints) {
    throw new Error(`${label}不能超过${INPUT_LIMITS.instructionsCodePoints}个字符`);
  }
  return normalized;
}

export function validateProjectSettings(input: Pick<ProjectCreativeSettings, "scriptInstructions" | "visualInstructions">) {
  return {
    scriptInstructions: validateInstructions(input.scriptInstructions, "项目文案补充"),
    visualInstructions: validateInstructions(input.visualInstructions, "项目画面补充"),
  };
}

export function validateVideoInput(input: VideoInputDraft, options: { allowEmptyPrimary?: boolean } = {}): Omit<VideoInputDraft, "updatedAt"> {
  if (input.inputMode !== "topic" && input.inputMode !== "body") throw new Error("输入模式无效，请重新选择");
  if (input.referenceRole !== "style_only" && input.referenceRole !== "content_source") throw new Error("参考文本角色无效，请重新选择");
  if (!(["relaxed", "standard", "compact"] as const).includes(input.visualDensity)) throw new Error("画面密度无效，请重新选择");
  if (typeof input.webEnabled !== "boolean") throw new Error("联网设置无效，请重新选择");
  if (!isAspectRatio(input.aspectRatio)) throw new Error("输出画幅无效，请重新选择");
  const aspectRatio = normalizeAspectRatio(input.aspectRatio);
  const profile = getVideoOutputProfile(aspectRatio);
  if (!Number.isSafeInteger(input.targetDurationSeconds) || input.targetDurationSeconds < 60 || input.targetDurationSeconds > 600) {
    throw new Error("目标时长必须是60～600秒的整数");
  }

  const topic = input.topic.normalize("NFKC").trim().replace(/\s+/gu, " ");
  const body = normalizeOptional(input.body);
  const referenceText = normalizeOptional(input.referenceText);
  if (!options.allowEmptyPrimary && input.inputMode === "topic" && !topic) throw new Error("请输入视频主题");
  if (!options.allowEmptyPrimary && input.inputMode === "body" && !body) throw new Error("请粘贴视频正文");
  if (codePointLength(topic) > INPUT_LIMITS.topicCodePoints) throw new Error(`视频主题不能超过${INPUT_LIMITS.topicCodePoints}个字符`);
  if (byteLength(body) > INPUT_LIMITS.bodyBytes) throw new Error("视频正文不能超过128KiB（按UTF-8计算）");
  if (byteLength(referenceText) > INPUT_LIMITS.referenceBytes) throw new Error("参考文本不能超过64KiB（按UTF-8计算）");

  return {
    inputMode: input.inputMode,
    topic,
    body,
    referenceText,
    referenceRole: input.referenceRole,
    targetDurationSeconds: input.targetDurationSeconds,
    visualDensity: input.visualDensity,
    aspectRatio: profile.aspectRatio,
    webEnabled: input.webEnabled,
    scriptInstructions: validateInstructions(input.scriptInstructions, "当前视频文案补充"),
    visualInstructions: validateInstructions(input.visualInstructions, "当前视频画面补充"),
  };
}

export function promptLayerOrder(fixedSystemContract: string, globalPrompt: string, projectPrompt: string, videoPrompt: string, localRewrite: string) {
  // 固定系统合同由服务端持有且始终位于首层，用户不能通过后续配置覆盖其身份。
  return [fixedSystemContract, globalPrompt, projectPrompt, videoPrompt, localRewrite];
}
