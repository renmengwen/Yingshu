import type { EpisodeDurationPolicy } from "../episode/episode-editor";
import type { Chapter } from "../types";

export type SeriesPipelineStatus =
  | "configured" | "analyzing_chapters" | "building_story_bible" | "planning_episodes"
  | "validating_plan" | "freezing_plan" | "generating_scripts" | "checking_coverage"
  | "awaiting_review" | "paused" | "failed" | "cancelled" | "completed";

export interface SeriesPipelineRun {
  id: string;
  seriesProjectId: string;
  status: SeriesPipelineStatus;
  resumeStatus: SeriesPipelineStatus | null;
  episodeCount: number;
  targetDurationSeconds: number;
  chapterBatchSize: number;
  chapterConcurrency: number;
  sourceStartChapterId: string;
  sourceEndChapterId: string;
  failureCode: string | null;
  failureMessage: string | null;
  storyBibleId: string | null;
  planningContractVersion?: 1 | 2;
  scriptContractVersion?: 5 | 6;
  episodeRanges?: Array<{ episodeIndex: number; startChapterId: string; endChapterId: string }> | null;
  productPromptVersion?: string | null;
  bookPromptProfileRevision?: number | null;
  bookPromptProfileHash?: string | null;
  progress: {
    chapterAnalysis: { completed: number; total: number; reused: number; queued: number; running: number; failed: number };
    storyBible: { completed: number; total: number; steps: { completed: number; total: number } | null };
    episodePlan: { completed: number; total: number };
    scripts: { completed: number; total: number };
  };
  current: {
    stage: string;
    subjectType: string;
    subjectId: string;
    jobId: string;
    jobStatus?: "queued" | "running" | "succeeded" | "failed" | "cancelled";
    jobProgress?: number;
    jobAttempts?: number;
    jobMaxAttempts?: number;
  } | null;
  failures: Array<{
    stage: string; subjectType: string; subjectId: string; jobId: string;
    code: string | null; message: string;
  }>;
  actions: { canPause: boolean; canResume: boolean; canCancel: boolean; canRetry: boolean };
}

export interface PipelineCreateInput {
  episodeCount: number;
  targetDurationSeconds: number;
  chapterBatchSize: number;
  chapterConcurrency: number;
  sourceStartChapterId: string;
  sourceEndChapterId: string;
}

export function pipelineStatusPresentation(status: SeriesPipelineStatus, planningContractVersion: 1 | 2 = 1): {
  heading: string;
  label: string;
  activeStage?: "storyBible" | "episodePlan" | "scripts";
  stageDetail?: string;
} {
  const labels: Record<SeriesPipelineStatus, string> = {
    configured: "已配置", analyzing_chapters: "分析章节",
    building_story_bible: planningContractVersion === 2 ? "准备冻结来源" : "构建全书世界观",
    planning_episodes: planningContractVersion === 2 ? "冻结分集来源" : "规划分集",
    validating_plan: planningContractVersion === 2 ? "校验分集来源" : "校验计划",
    freezing_plan: planningContractVersion === 2 ? "冻结分集来源" : "冻结计划",
    generating_scripts: "生成稿件", checking_coverage: "检查覆盖", awaiting_review: "等待审核",
    paused: "已暂停", failed: "执行失败", cancelled: "已取消", completed: "已完成",
  };
  if (status === "awaiting_review") {
    return { heading: "自动生产完成，等待逐集审核", label: labels[status], stageDetail: "自动生产已完成，等待逐集审核" };
  }
  const inactiveHeadings: Partial<Record<SeriesPipelineStatus, string>> = {
    paused: "全本改写已暂停",
    failed: "全本改写执行失败",
    cancelled: "全本改写已取消",
    completed: "全本改写已完成",
  };
  if (inactiveHeadings[status]) {
    return { heading: inactiveHeadings[status], label: labels[status] };
  }
  const activeStage = status === "building_story_bible" ? planningContractVersion === 2 ? "episodePlan" : "storyBible"
    : ["planning_episodes", "validating_plan", "freezing_plan"].includes(status) ? "episodePlan"
    : ["generating_scripts", "checking_coverage"].includes(status) ? "scripts"
    : undefined;
  return { heading: "固定流水线正在处理全书", label: labels[status], activeStage };
}

export function pipelineCreateInput(
  input: PipelineCreateInput,
  chapters: Chapter[],
  policy: EpisodeDurationPolicy,
): PipelineCreateInput {
  const startIndex = chapters.findIndex((chapter) => chapter.id === input.sourceStartChapterId);
  const endIndex = chapters.findIndex((chapter) => chapter.id === input.sourceEndChapterId);
  if (startIndex < 0 || endIndex < 0 || startIndex > endIndex) throw new Error("请选择连续且顺序正确的改写章节范围");
  if (!Number.isSafeInteger(input.episodeCount) || input.episodeCount < 1 || input.episodeCount > 1000) {
    throw new Error("总集数必须是 1～1000 之间的整数");
  }
  if (!Number.isSafeInteger(input.targetDurationSeconds) ||
      input.targetDurationSeconds < policy.minimumSeconds || input.targetDurationSeconds > policy.maximumSeconds ||
      (input.targetDurationSeconds - policy.minimumSeconds) % policy.stepSeconds !== 0) {
    throw new Error(`单集时长必须是 ${policy.minimumSeconds}～${policy.maximumSeconds} 秒，并按 ${policy.stepSeconds} 秒递增`);
  }
  if (input.chapterBatchSize !== 1) {
    throw new Error("章节分析固定为每章一个独立任务");
  }
  if (!Number.isSafeInteger(input.chapterConcurrency) || input.chapterConcurrency < 1 || input.chapterConcurrency > 8) {
    throw new Error("章节分析并发数必须是 1～8 之间的整数");
  }
  return input;
}

export function pipelineRangeCount(chapters: Chapter[], startId: string, endId: string) {
  const startIndex = chapters.findIndex((chapter) => chapter.id === startId);
  const endIndex = chapters.findIndex((chapter) => chapter.id === endId);
  return startIndex >= 0 && endIndex >= startIndex ? endIndex - startIndex + 1 : 0;
}

export function formatPipelineDuration(seconds: number) {
  if (!Number.isFinite(seconds) || seconds <= 0) return "待填写";
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (!hours) return `${minutes} 分钟`;
  return minutes ? `${hours} 小时 ${minutes} 分钟` : `${hours} 小时`;
}

export function pipelineStatusText(run: SeriesPipelineRun) {
  if (run.status === "paused") return "任务已暂停。已完成结果已保留。";
  if (run.status === "cancelled") return "任务已取消。已完成章节事件已保留。";
  if (run.status === "completed") return `全本稿件已生成，共 ${run.episodeCount} 集。请逐集审核。`;
  if (run.failureMessage || run.failures.length) return run.failureMessage ?? `有 ${run.failures.length} 个失败章节，可局部重试。`;
  const chapter = run.progress.chapterAnalysis;
  if (run.current?.stage === "chapter_analysis" || run.status === "analyzing_chapters") {
    return chapter.running > 0
      ? `正在并发分析 ${chapter.running} 章；已完成 ${chapter.completed}/${chapter.total} 章。`
      : `章节分析已完成 ${chapter.completed}/${chapter.total} 章，正在等待下一项任务。`;
  }
  if (run.status === "configured") return "全本改写任务已配置，等待开始章节分析。";
  if (run.status === "building_story_bible") return run.planningContractVersion === 2
    ? "章节分析已完成，正在准备冻结分集来源。"
    : "章节分析已完成，正在构建全书世界观。";
  if (run.status === "planning_episodes" || run.status === "validating_plan" || run.status === "freezing_plan") {
    return run.planningContractVersion === 2
      ? "正在按已确认章节范围冻结每集来源事件。"
      : "正在生成并校验全书分集方案。";
  }
  if (run.status === "generating_scripts") return "正在生成全本稿件。";
  if (run.status === "checking_coverage") return "稿件生成完成，正在检查完整性。";
  if (run.status === "awaiting_review") return "自动生产完成，等待逐集审核。";
  return "全本改写任务执行失败，可检查失败项后重试。";
}

export function pipelineChapterEventsReadOnly(run: SeriesPipelineRun | undefined) {
  return Boolean(run && !["paused", "cancelled", "completed"].includes(run.status));
}

export function pipelineIsTerminal(run: SeriesPipelineRun) {
  return run.status === "cancelled" || run.status === "completed";
}
