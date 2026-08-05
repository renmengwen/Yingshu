import type {
  DouyinAcceptedMissingDimension, DouyinAnalysisConfig, DouyinAnalysisStatus, DouyinAvailabilityDimension,
  DouyinEvidenceSummary, DouyinUsageRole,
} from "./types";

export function validateDouyinDraft(config: DouyinAnalysisConfig) {
  if (!config.sourceText.trim()) return "请粘贴抖音分享文案、短链接或完整视频链接。";
  if (!Number.isSafeInteger(config.frameCount) || config.frameCount < 6 || config.frameCount > 30) return "关键帧数量必须是 6～30 的整数。";
  if (!config.extractFrames && !config.transcribeAudio) return "至少需要开启关键帧或 ASR 音频转写。";
  return null;
}

export const DOUYIN_STATUS_LABELS: Record<DouyinAnalysisStatus, string> = {
  queued: "等待执行", running: "正在分析", need_login: "需要登录", need_verify: "需要验证",
  partial: "部分完成", succeeded: "分析完成", failed: "分析失败", cancelled: "分析已中断",
};

export function douyinStatusMessage(status: DouyinAnalysisStatus, config: DouyinAnalysisConfig = { sourceText: "", extractFrames: true, frameCount: 12, transcribeAudio: true, analyzeComments: false }) {
  switch (status) {
    case "queued": return "正在解析抖音链接…";
    case "running": return ["正在下载视频…", config.extractFrames ? `正在抽取 ${config.frameCount} 张关键帧…` : null,
      config.transcribeAudio ? "正在执行 ASR 转写…" : null, config.analyzeComments ? "正在获取评论和回复…" : null,
      "正在生成结构化分析报告…"].filter(Boolean).join(" ");
    case "need_login": return "正在等待抖音登录…";
    case "need_verify": return "抖音需要完成验证后才能继续。已完成的步骤仍然保留。";
    case "partial": return "分析已部分完成。可重试失败项，或明确使用现有结果继续。";
    case "succeeded": return "抖音视频分析已完成。请选择这条视频如何参与创作。";
    case "failed": return "抖音视频分析失败。已完成的证据仍然保留，可重试。";
    case "cancelled": return "分析已中断。已完成的视频、转写和关键帧仍然保留。";
  }
}

export function usageRoleLabel(role: DouyinUsageRole) {
  return role === "method_only" ? "只参考创作方法" : role === "topic_seed" ? "沿用选题，重新研究创作" : "改写源视频内容";
}

export function unavailableDimensions(availability: Record<DouyinAvailabilityDimension, { status: string }> | null) {
  if (!availability) return [];
  return (Object.entries(availability) as Array<[DouyinAvailabilityDimension, { status: string }]>)
    .filter(([, item]) => item.status !== "available").map(([dimension]) => dimension);
}

export function acceptedMissingDimensions(
  availability: Record<DouyinAvailabilityDimension, { status: string }> | null,
  evidence: DouyinEvidenceSummary | null,
): DouyinAcceptedMissingDimension[] {
  const dimensions: DouyinAcceptedMissingDimension[] = unavailableDimensions(availability);
  if (evidence?.asrStatus === "partial") dimensions.push("asr");
  return dimensions;
}

export function evidenceRows(evidence: DouyinEvidenceSummary | null, config: DouyinAnalysisConfig) {
  return [
    { id: "metadata", name: "视频资料", evidence: "元数据", status: evidence?.metadataStatus ?? "pending", summary: evidence ? "已冻结视频身份与抓取时刻数据" : "等待获取视频资料", detail: "report" as const },
    { id: "asr", name: "ASR", evidence: "音频与转写", status: config.transcribeAudio ? evidence?.asrStatus ?? "pending" : "not_requested", summary: config.transcribeAudio ? (evidence ? `${evidence.asrTextCharacters.toLocaleString("zh-CN")} 字，覆盖 ${(evidence.asrCoveredDurationMs / 1000).toFixed(1)} 秒` : "等待执行音频转写") : "本次未开启 ASR", detail: "transcript" as const },
    { id: "frames", name: "关键帧", evidence: `${config.frameCount} 张计划`, status: config.extractFrames ? (evidence && evidence.failedFrames ? "partial" : evidence?.videoStatus ?? "pending") : "not_requested", summary: config.extractFrames ? (evidence ? `成功 ${evidence.succeededFrames} 张，失败 ${evidence.failedFrames} 张` : "等待抽取关键帧") : "本次未开启抽帧", detail: "frames" as const },
    { id: "comments", name: "评论", evidence: "受众信号", status: config.analyzeComments ? (evidence ? "succeeded" : "pending") : "not_requested", summary: config.analyzeComments ? (evidence ? `已获取 ${evidence.commentCount} 条；仅作受众解读` : "等待获取评论和回复") : "评论分析未开启，不进入本次报告", detail: "comments" as const },
    { id: "report", name: "结构化分析", evidence: "综合证据", status: evidence?.completeness === "complete" ? "succeeded" : evidence?.completeness ?? "pending", summary: evidence ? `报告完整性：${evidence.completeness === "complete" ? "完整" : evidence.completeness === "partial" ? "部分" : "不可用"}` : "等待证据准备完成", detail: "report" as const },
  ];
}

export function evidenceStatusLabel(status: string) {
  return ({ not_requested: "未开启", pending: "待执行", running: "执行中", partial: "部分完成", succeeded: "已完成", failed: "失败", cancelled: "已中断", unavailable: "不可用", complete: "已完成" } as Record<string, string>)[status] ?? status;
}
