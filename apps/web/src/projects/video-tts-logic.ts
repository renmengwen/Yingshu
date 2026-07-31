export type VideoTtsActionState = "idle" | "loading" | "success" | "error" | "interrupted";
export type VideoTtsJobStatus = "queued" | "running" | "processing_subtitles" | "succeeded" | "failed" | "cancelled";
export type VideoTtsDurationDecision = "within_target" | "accept_actual" | "reprocess" | null;

export interface VideoTtsCue {
  id: string;
  paragraphId: string;
  text: string;
  startSeconds: number;
  endSeconds: number;
}

export interface VideoTtsArtifact {
  id: string;
  stale: boolean;
  durationSeconds: number;
}

export interface VideoTtsApprovalCandidate extends VideoTtsArtifact {
  targetDurationSeconds: number;
  durationDecision: VideoTtsDurationDecision;
  approved: boolean;
}

export interface VideoTtsJob {
  id: string;
  status: VideoTtsJobStatus;
  errorSummary?: string | null;
}

export interface VideoTtsWorkspace {
  available: boolean;
  blockedReason: string | null;
  provider: { id: string; name?: string; modelId: string; voiceId: string; rate: number; language: string; costKnown: false } | null;
  targetDurationSeconds: number;
  snapshot: { id: string; providerId: string; modelId: string; voiceId: string; rate: number; language: string; stale: boolean } | null;
  job: VideoTtsJob | null;
  artifact: VideoTtsArtifact | null;
  cues: VideoTtsCue[];
  review: { notes: string; durationDecision: VideoTtsDurationDecision } | null;
  audioGate: { valid: boolean } | null;
  history: Array<VideoTtsArtifact & { providerId: string; modelId: string; voiceId: string; rate: number; language: string; createdAt: number }>;
}

export function isActiveVideoTtsJob(job: VideoTtsJob | null) {
  return job?.status === "queued" || job?.status === "running" || job?.status === "processing_subtitles";
}

export function videoTtsJobLabel(job: VideoTtsJob | null) {
  if (!job) return "未生成";
  return ({ queued: "排队中", running: "生成中", processing_subtitles: "处理字幕", succeeded: "等待听音", failed: "失败", cancelled: "已取消" } as const)[job.status];
}

export function formatTtsDuration(seconds: number) {
  if (!Number.isFinite(seconds) || seconds < 0) return "--:--";
  const rounded = Math.round(seconds);
  return `${Math.floor(rounded / 60).toString().padStart(2, "0")}:${(rounded % 60).toString().padStart(2, "0")}`;
}

export function formatTtsRate(rate: number) {
  return `${rate > 0 ? "+" : ""}${rate} 档`;
}

export function videoTtsDeviation(actual: number, target: number) {
  if (!Number.isFinite(actual) || !Number.isFinite(target) || actual < 0 || target <= 0) return null;
  return Math.abs(actual - target) / target;
}

export function requiresDurationDecision(artifact: Pick<VideoTtsApprovalCandidate, "durationSeconds" | "targetDurationSeconds">) {
  const deviation = videoTtsDeviation(artifact.durationSeconds, artifact.targetDurationSeconds);
  return deviation !== null && deviation > 0.1;
}

export function canApproveVideoTts(artifact: VideoTtsApprovalCandidate | null) {
  if (!artifact || artifact.stale || artifact.approved) return false;
  return requiresDurationDecision(artifact) ? artifact.durationDecision === "accept_actual" : artifact.durationDecision === "within_target";
}

export function videoTtsDeviationLabel(actual: number, target: number) {
  const deviation = videoTtsDeviation(actual, target);
  if (deviation === null) return "无法计算";
  return `${(deviation * 100).toFixed(1)}%`;
}
