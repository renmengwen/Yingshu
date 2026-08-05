import { validateVideoInput } from "../input-logic";
import type { VideoInputDraft } from "../types";
import type {
  ZhihuAcceptedMissingDimension, ZhihuAnalysisConfig, ZhihuAnalysisStatus, ZhihuAvailabilityDimension,
  ZhihuEvidenceSummary, ZhihuUsageRole,
} from "./types";

export function validateZhihuDraft(config: ZhihuAnalysisConfig) {
  const sourceText = config.sourceUrl.trim();
  if (!sourceText) return "请粘贴知乎回答链接。";
  try {
    const url = new URL(sourceText);
    if (url.protocol !== "https:" || (url.hostname !== "zhihu.com" && !url.hostname.endsWith(".zhihu.com"))) {
      return "请输入有效的知乎回答链接。";
    }
    if (/^\/question\/\d+\/?$/u.test(url.pathname)) return "首版需要具体的知乎回答链接，暂不支持仅分析问题页。";
    if (!/^\/question\/\d+\/answer\/\d+\/?$/u.test(url.pathname)) return "请输入有效的知乎回答链接。";
  } catch { return "请输入有效的知乎回答链接。"; }
  if (!Number.isSafeInteger(config.maxComments) || config.maxComments < 0 || config.maxComments > 50) return "评论数量必须是 0～50 的整数。";
  return null;
}

export function zhihuPlanLaunchBlockReason(input: VideoInputDraft, state: {
  loaded: boolean; busy: boolean; selectionDirty: boolean; error: boolean;
  summary?: import("./types").ZhihuAnalysisSummary;
}) {
  if (!state.loaded) return "正在恢复知乎分析与使用方式，请稍候。";
  if (state.busy) return "正在处理知乎分析操作，请稍候。";
  if (state.error) return "知乎分析状态存在错误，请先按页面提示处理。";
  const snapshot = state.summary?.snapshot;
  if (!snapshot) return "请先完成知乎回答分析。";
  if (state.summary?.job && ["queued", "running"].includes(state.summary.job.status)) return "知乎回答正在分析，请等待任务完成。";
  if (snapshot.status !== "succeeded" && snapshot.status !== "partial") return "当前知乎分析尚不可用于创作，请重新分析。";
  const selection = state.summary?.selection;
  if (!selection || selection.snapshotId !== snapshot.id) return "请选择知乎使用方式，系统会自动保存。";
  if (state.selectionDirty) return "知乎使用方式正在自动保存，请稍候。";
  if (selection.usageRole === "method_only") {
    try { validateVideoInput(input); }
    catch { return "只参考表达与论证方法仍需要基础主题或正文，请先填写。"; }
  }
  return null;
}

export function canSaveZhihuSelection(state: {
  busy: boolean; selectionDirty: boolean; acceptPartial: boolean; usageRole?: ZhihuUsageRole;
  rightsConfirmed: boolean; summary?: import("./types").ZhihuAnalysisSummary;
}) {
  const snapshot = state.summary?.snapshot;
  return Boolean(!state.busy && state.selectionDirty && state.usageRole && snapshot && state.summary?.allowedActions.selectUsage &&
    (snapshot.status !== "partial" || state.acceptPartial) &&
    (state.usageRole !== "content_source" || state.rightsConfirmed));
}

export const ZHIHU_STATUS_LABELS: Record<ZhihuAnalysisStatus, string> = {
  queued: "等待执行", running: "正在分析",
  partial: "部分完成", succeeded: "分析完成", failed: "分析失败", cancelled: "分析已中断",
};

export function zhihuStatusMessage(status: ZhihuAnalysisStatus) {
  switch (status) {
    case "queued": return "正在解析知乎链接…";
    case "running": return "正在获取回答原文和评论，并生成结构化分析报告…";
    case "partial": return "分析已部分完成。可重试失败项，或明确使用现有结果继续。";
    case "succeeded": return "知乎回答分析已完成。请选择这条来源如何参与创作。";
    case "failed": return "知乎分析失败。已完成的回答原文和评论仍然保留，可重试。";
    case "cancelled": return "分析已中断。已完成的回答原文和评论仍然保留。";
  }
}

export function usageRoleLabel(role: ZhihuUsageRole) {
  return role === "method_only" ? "只参考表达与论证方法" : role === "topic_seed" ? "沿用选题，重新研究创作" : "改写回答内容";
}

export function acceptedMissingDimensions(availability: Record<ZhihuAvailabilityDimension, { status: string }> | null, evidence: ZhihuEvidenceSummary | null): ZhihuAcceptedMissingDimension[] {
  if (!availability) return [];
  const dimensions = (Object.entries(availability) as Array<[ZhihuAvailabilityDimension, { status: string }]>)
    .filter(([, item]) => item.status !== "available").map(([dimension]) => dimension);
  if (evidence?.commentsStatus === "partial" || evidence?.commentsStatus === "failed") return [...dimensions, "comments"];
  return dimensions;
}

export function evidenceRows(evidence: ZhihuEvidenceSummary | null, config: ZhihuAnalysisConfig) {
  return [
    { id: "answer", name: "回答原文", evidence: "标题与正文", status: evidence?.answerStatus ?? "pending", summary: evidence ? "回答原文已冻结，可查看完整内容" : "等待获取回答原文", detail: "answer" as const },
    { id: "comments", name: "评论", evidence: "评论与回复样本", status: config.analyzeComments ? evidence?.commentsStatus ?? "pending" : "not_requested", summary: config.analyzeComments ? (evidence ? `已获取 ${evidence.commentCount} 条；仅作受众解读` : "等待获取评论和回复") : "评论分析未开启", detail: "comments" as const },
    { id: "report", name: "结构化分析", evidence: "原文与受众信号", status: evidence?.completeness === "complete" ? "succeeded" : evidence?.completeness ?? "pending", summary: evidence ? `报告完整性：${evidence.completeness === "complete" ? "完整" : evidence.completeness === "partial" ? "部分" : "不可用"}` : "等待证据准备完成", detail: "report" as const },
  ];
}

export function evidenceStatusLabel(status: string) {
  return ({ not_requested: "未开启", pending: "待执行", running: "执行中", partial: "部分完成", succeeded: "已完成", failed: "失败", cancelled: "已中断", unavailable: "不可用", complete: "已完成" } as Record<string, string>)[status] ?? status;
}
