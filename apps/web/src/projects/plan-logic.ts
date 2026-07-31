import type { VideoPlanJob, VideoScriptParagraph, VideoVisualDraft } from "./types";
import type { Video } from "./types";

export type PlanActionState = "loading" | "success" | "error" | "interrupted";

export function planJobLabel(job: VideoPlanJob | null) {
  if (!job) return "尚未创建方案任务。";
  if (job.status === "queued") return "方案任务已排队，等待开始资料准备。";
  if (job.status === "running") return "方案正在生成。服务端会按资料准备、旁白、画面规划依次执行。";
  if (job.status === "succeeded") return "方案生成完成，等待人工审核。";
  if (job.status === "cancelled") return "方案生成已中断，已完成的步骤仍会保留。";
  return `方案生成失败：${job.errorMessage || "请检查模型配置后重试"}。`;
}

export function canCancelPlanJob(job: VideoPlanJob | null) {
  return job?.status === "queued" || job?.status === "running";
}

export function videoPlanStageLabel(status: Video["status"]) {
  if (status === "preparing_sources") return "正在准备资料";
  if (status === "generating_script") return "正在生成旁白";
  if (status === "planning_visuals") return "正在规划画面";
  if (status === "awaiting_review") return "方案已生成，等待人工审核";
  if (status === "failed") return "方案生成失败";
  if (status === "cancelled") return "方案生成已中断";
  return "尚未开始生成";
}

export function narrationFromParagraphs(paragraphs: VideoScriptParagraph[]) {
  return paragraphs.map((paragraph) => paragraph.text.trim()).filter(Boolean).join("\n\n");
}

export function validateScriptDraft(title: string, summary: string, paragraphs: VideoScriptParagraph[]) {
  if (!title.trim()) throw new Error("请输入标题建议");
  if (!summary.trim()) throw new Error("请输入内容摘要");
  if (!paragraphs.length || paragraphs.some((paragraph) => !paragraph.text.trim())) throw new Error("旁白段落不能为空");
  const ids = new Set(paragraphs.map((paragraph) => paragraph.id));
  if (ids.size !== paragraphs.length) throw new Error("旁白段落 ID 重复，请刷新后重试");
  return paragraphs.map((paragraph) => ({ ...paragraph, text: paragraph.text.trim() }));
}

export function validateVisualDrafts(visuals: VideoVisualDraft[], paragraphIds: string[]) {
  if (!visuals.length) throw new Error("至少保留一个画面");
  const allowed = new Set(paragraphIds);
  const ids = new Set<string>();
  return visuals.map((visual) => {
    if (ids.has(visual.id)) throw new Error("画面 ID 重复，请刷新后重试");
    ids.add(visual.id);
    if (!allowed.has(visual.paragraphId)) throw new Error("画面关联的旁白段落已不存在");
    if (!visual.description.trim() || !visual.prompt.trim()) throw new Error("画面描述和生图 prompt 不能为空");
    return { ...visual, description: visual.description.trim(), prompt: visual.prompt.trim() };
  });
}

export function newVisual(paragraphId: string, ordinal: number): VideoVisualDraft {
  return {
    id: `visual_manual_${Date.now()}_${ordinal}`,
    paragraphId,
    purpose: "补充说明",
    description: "",
    prompt: "",
    negativePrompt: "文字、水印、标志、低清晰度",
    suggestedDurationSeconds: 3,
    weight: 1,
    generationStatus: "not_generated",
    currentCandidate: null,
  };
}
