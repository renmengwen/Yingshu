import type { JobRecord } from "../types";

const HASH = /^[0-9a-f]{64}$/u;

export type ExportJobType = "render_chunks" | "final_video";
export type ExportJob = Pick<JobRecord, "id" | "type" | "status" | "progress" | "errorMessage" | "payload">;

export interface ExportBlocker {
  code: string;
  message: string;
}

export interface ExportReadiness {
  episodeId: string;
  timelineHash: string;
  productionReady: boolean;
  blockers: ExportBlocker[];
  renderChunks: { ready: boolean; completed: number; total: number };
  jobs: { renderChunks: ExportJob | null; finalVideo: ExportJob | null };
  finalExport: null | {
    exportHash: string;
    verified: boolean;
    fileHash: string;
    bytes: number;
    durationMs: number;
  };
}

export interface ProjectPackageResult {
  episodeId: string;
  finalExportHash: string;
  packagePath: string;
  packageHash: string;
  manifest: Record<string, unknown>;
}

export type ExportPrimaryAction = "render" | "finalize" | "cancel" | "retry" | "download" | "refresh" | "none";

export interface ExportWorkflowState {
  action: ExportPrimaryAction;
  label: string;
  tone: "neutral" | "working" | "success" | "danger";
  disabled: boolean;
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("导出复核响应格式无效");
  return value as Record<string, unknown>;
}

function safeCount(value: unknown, label: string) {
  if (!Number.isSafeInteger(value) || Number(value) < 0) throw new Error(`${label}无效`);
  return Number(value);
}

const JOB_ID = /^[A-Za-z0-9_-]+$/u;
const JOB_STATUSES = new Set(["queued", "running", "succeeded", "failed", "cancelled"]);

function parseJobFields(value: unknown, expectedType: ExportJobType) {
  const input = object(value);
  if (typeof input.id !== "string" || !JOB_ID.test(input.id) || input.type !== expectedType ||
      typeof input.status !== "string" || !JOB_STATUSES.has(input.status) ||
      typeof input.progress !== "number" || !Number.isFinite(input.progress) || input.progress < 0 || input.progress > 1 ||
      (input.errorMessage !== null && typeof input.errorMessage !== "string")) {
    throw new Error(`${expectedType} 任务摘要格式无效`);
  }
  return {
    id: input.id,
    type: expectedType,
    status: input.status as JobRecord["status"],
    progress: input.progress,
    errorMessage: input.errorMessage as string | null,
  };
}

function parseReadinessJob(value: unknown, expectedType: ExportJobType, expected: { episodeId: string; timelineHash: string }) {
  if (value === null) return null;
  return { ...parseJobFields(value, expectedType), payload: expected } satisfies ExportJob;
}

export function parseExportApiJob(value: unknown, expected: { episodeId: string; timelineHash: string }): ExportJob {
  const root = object(value);
  const input = object(root.job);
  if (input.type !== "render_chunks" && input.type !== "final_video") throw new Error("导出任务类型无效");
  const fields = parseJobFields(input, input.type);
  const payload = object(input.payload);
  if (payload.episodeId !== expected.episodeId || payload.timelineHash !== expected.timelineHash) {
    throw new Error("任务不属于当前分集或时间轴");
  }
  return { ...fields, payload: expected };
}

export function parseExportReadiness(value: unknown, expected: { episodeId: string; timelineHash: string }): ExportReadiness {
  const input = object(value);
  if (input.episodeId !== expected.episodeId || input.timelineHash !== expected.timelineHash) {
    throw new Error("导出复核结果不属于当前分集或时间轴");
  }
  if (typeof input.productionReady !== "boolean" || !Array.isArray(input.blockers)) {
    throw new Error("导出复核响应缺少门禁状态");
  }
  const blockers = input.blockers.map((item) => {
    const blocker = object(item);
    if (typeof blocker.code !== "string" || !blocker.code || typeof blocker.message !== "string" || !blocker.message.trim()) {
      throw new Error("导出阻断项格式无效");
    }
    return { code: blocker.code, message: blocker.message.trim() };
  });
  const chunks = object(input.renderChunks);
  if (typeof chunks.ready !== "boolean") throw new Error("分片复核状态无效");
  const completed = safeCount(chunks.completed, "已完成分片数");
  const total = safeCount(chunks.total, "分片总数");
  if (completed > total || chunks.ready !== (total > 0 && completed === total)) throw new Error("分片复核计数不一致");
  const jobs = object(input.jobs);
  const renderJob = parseReadinessJob(jobs.renderChunks, "render_chunks", expected);
  const finalJob = parseReadinessJob(jobs.finalVideo, "final_video", expected);

  let finalExport: ExportReadiness["finalExport"] = null;
  if (input.finalExport !== null && input.finalExport !== undefined) {
    const final = object(input.finalExport);
    if (!HASH.test(String(final.exportHash)) || !HASH.test(String(final.fileHash)) || typeof final.verified !== "boolean") {
      throw new Error("最终视频复核身份无效");
    }
    finalExport = {
      exportHash: String(final.exportHash),
      fileHash: String(final.fileHash),
      verified: final.verified,
      bytes: safeCount(final.bytes, "最终视频字节数"),
      durationMs: safeCount(final.durationMs, "最终视频时长"),
    };
  }
  if (input.productionReady !== (blockers.length === 0)) throw new Error("生产就绪状态与阻断清单不一致");
  return {
    episodeId: expected.episodeId,
    timelineHash: expected.timelineHash,
    productionReady: input.productionReady,
    blockers,
    renderChunks: { ready: chunks.ready, completed, total },
    jobs: { renderChunks: renderJob, finalVideo: finalJob },
    finalExport,
  };
}

export function exportJobType(job: ExportJob | undefined, expected: { episodeId: string; timelineHash: string }) {
  if (!job || (job.type !== "render_chunks" && job.type !== "final_video")) return undefined;
  const payload = object(job.payload ?? {});
  return payload.episodeId === expected.episodeId && payload.timelineHash === expected.timelineHash
    ? job.type as ExportJobType
    : undefined;
}

export function selectReadinessJob(readiness: ExportReadiness) {
  const required = readiness.renderChunks.ready ? readiness.jobs.finalVideo : readiness.jobs.renderChunks;
  const other = readiness.renderChunks.ready ? readiness.jobs.renderChunks : readiness.jobs.finalVideo;
  if (required?.status === "queued" || required?.status === "running") return required;
  if (other?.status === "queued" || other?.status === "running") return other;
  return required ?? undefined;
}

export function exportWorkflowState(
  readiness: ExportReadiness | undefined,
  job: ExportJob | undefined,
  expected: { episodeId: string; timelineHash: string },
  busy = false,
): ExportWorkflowState {
  const kind = exportJobType(job, expected);
  if (busy) return { action: "none", label: "正在处理…", tone: "working", disabled: true };
  if (kind && (job!.status === "queued" || job!.status === "running")) {
    return { action: "cancel", label: job!.status === "queued" ? "取消排队任务" : "请求中断当前任务", tone: "working", disabled: false };
  }
  if (!readiness) return { action: "refresh", label: "重新复核", tone: "neutral", disabled: false };
  if (!readiness.productionReady) return { action: "none", label: "先处理阻断项", tone: "danger", disabled: true };
  if (readiness.finalExport?.verified) return { action: "download", label: "下载已复核 MP4", tone: "success", disabled: false };
  const required: ExportJobType = readiness.renderChunks.ready ? "final_video" : "render_chunks";
  if (kind === required && (job!.status === "failed" || job!.status === "cancelled")) {
    return { action: "retry", label: job!.status === "cancelled" ? "重试已中断步骤" : "重试失败步骤", tone: "danger", disabled: false };
  }
  return required === "render_chunks"
    ? { action: "render", label: "生成渲染分片", tone: "neutral", disabled: false }
    : { action: "finalize", label: "合成并复核最终视频", tone: "neutral", disabled: false };
}

export function exportReadinessUrl(episodeId: string, timelineHash: string) {
  return `/api/episodes/${encodeURIComponent(episodeId)}/export-readiness?timelineHash=${encodeURIComponent(timelineHash)}`;
}

export function exportArtifactUrl(episodeId: string, exportHash: string, artifact: "manifest" | "video") {
  return `/api/episodes/${encodeURIComponent(episodeId)}/exports/${encodeURIComponent(exportHash)}/${artifact}`;
}

export function projectPackageUrl(episodeId: string, exportHash: string) {
  return `/api/episodes/${encodeURIComponent(episodeId)}/exports/${encodeURIComponent(exportHash)}/project-package`;
}

export function parseProjectPackageResult(
  value: unknown,
  expected: { episodeId: string; exportHash: string },
): ProjectPackageResult {
  const root = object(value);
  const manifest = object(root.manifest);
  const project = object(manifest.project);
  if (typeof root.packagePath !== "string" || !root.packagePath.trim() || !HASH.test(String(root.packageHash)) ||
      manifest.packageHash !== root.packageHash || project.episodeId !== expected.episodeId ||
      project.finalExportHash !== expected.exportHash) {
    throw new Error("项目包响应身份无效");
  }
  return {
    episodeId: expected.episodeId,
    finalExportHash: expected.exportHash,
    packagePath: root.packagePath,
    packageHash: String(root.packageHash),
    manifest,
  };
}

export function projectPackageMatchesFinal(
  result: ProjectPackageResult | undefined,
  expected: { episodeId: string; exportHash: string } | undefined,
) {
  return Boolean(result && expected && result.episodeId === expected.episodeId && result.finalExportHash === expected.exportHash);
}

export function formatExportBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / 1024 ** 2).toFixed(1)} MiB`;
}

export function formatExportDuration(durationMs: number) {
  const seconds = Math.round(durationMs / 1000);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}
