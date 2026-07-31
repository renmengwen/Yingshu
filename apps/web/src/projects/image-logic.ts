export type VideoImageActionState = "idle" | "loading" | "success" | "error" | "interrupted";
export type VideoImageJobStatus = "queued" | "running" | "succeeded" | "failed" | "cancelled" | "partial";

export interface VideoImageCandidate {
  id: string;
  visualId: string;
  origin: "generation" | "upload";
  currentCompatible: boolean;
  approved: boolean;
  previewUrl: string;
  originalName?: string;
  prompt: string;
  negativePrompt: string;
  styleSnapshot: unknown;
  providerId: string | null;
  modelId: string | null;
  params: { size: string; aspectRatio?: string; seed?: number | null };
  width: number;
  height: number;
  bytes: number;
  fileHash: string;
  providerRequestId?: string;
  planSnapshotId: string;
  planSnapshotHash: string;
  scriptRevisionId: string;
  scriptContentHash: string;
  visualRevisionId: string;
  visualContentHash: string;
  promptHash: string;
  requestIdentity: string;
  batchId?: string;
  idempotencyKey?: string;
  jobId: string | null;
  attempt: number;
  checkpointScope: string | null;
  mime: string;
  relativePath: string;
  createdAt: number;
}

export interface VideoImageVisual {
  id: string;
  order: number;
  paragraphId: string;
  narrationSummary: string;
  description: string;
  prompt: string;
  negativePrompt: string;
  generationState: { status: Exclude<VideoImageJobStatus, "partial">; errorSummary: string | null } | null;
  candidates: VideoImageCandidate[];
}

export interface VideoImageBatch {
  id: string;
  status: VideoImageJobStatus;
  counts: { queued: number; running: number; succeeded: number; failed: number; cancelled: number; total: number };
}

export interface VideoImageWorkspace {
  productionAllowed: boolean;
  blockedReason: string | null;
  provider: { id: string; name?: string; model: string } | null;
  feeEstimate: null;
  summary: { visualTotal: number; currentCandidateCount: number; coveredVisualCount: number; missingCount: number; plannedPerVisual: 1 };
  gate: { status: "pending" | "complete"; revision: number; approvedCount: number; total: number };
  batch: VideoImageBatch | null;
  visuals: VideoImageVisual[];
}

export function isActiveImageBatch(batch: VideoImageBatch | null) {
  return batch?.status === "queued" || batch?.status === "running";
}

export function imageWorkspaceCounts(workspace: VideoImageWorkspace) {
  return { total: workspace.summary.visualTotal, candidates: workspace.summary.currentCandidateCount,
    covered: workspace.summary.coveredVisualCount, missing: workspace.summary.missingCount };
}

export function currentImageCandidates(visual: VideoImageVisual) {
  return visual.candidates.filter((candidate) => candidate.currentCompatible);
}

export function historicalImageCandidates(visual: VideoImageVisual) {
  return visual.candidates.filter((candidate) => !candidate.currentCompatible);
}

export function imageBatchSummary(batch: VideoImageBatch | null) {
  if (!batch) return "尚未创建图片批次。";
  const status = ({ queued: "排队中", running: "生成中", succeeded: "已完成", failed: "生成失败", cancelled: "已中断", partial: "部分完成" } as const)[batch.status];
  return `${status}：排队 ${batch.counts.queued}，生成中 ${batch.counts.running}，成功 ${batch.counts.succeeded}，失败 ${batch.counts.failed}，已中断 ${batch.counts.cancelled}。`;
}

export function candidateIdentity(candidate: VideoImageCandidate) {
  if (candidate.origin === "upload") return candidate.originalName ? `本地上传 · ${candidate.originalName}` : "本地上传";
  return [candidate.providerId, candidate.modelId, candidate.params.size, candidate.params.seed == null ? null : `seed ${candidate.params.seed}`].filter(Boolean).join(" · ") || "图片生成";
}

export function styleSnapshotLabel(snapshot: unknown) {
  if (typeof snapshot === "string") return snapshot;
  try { return JSON.stringify(snapshot); } catch { return "已冻结"; }
}

export function formatImageCandidateTime(value: number) {
  return new Intl.DateTimeFormat("zh-CN", { dateStyle: "medium", timeStyle: "short" }).format(value);
}
