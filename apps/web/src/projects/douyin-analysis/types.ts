export type DouyinUsageRole = "method_only" | "topic_seed" | "content_source";
export type DouyinAnalysisStatus = "queued" | "running" | "need_login" | "need_verify" | "partial" | "succeeded" | "failed" | "cancelled";
export type DouyinAvailabilityDimension = "content" | "narrative" | "pacing" | "visualOverall" | "visualOpening" | "audioSubtitle" | "audience" | "narrationVisualAlignment";
export type DouyinAcceptedMissingDimension = DouyinAvailabilityDimension | "asr";

export interface DouyinAnalysisConfig {
  sourceText: string;
  extractFrames: boolean;
  frameCount: number;
  transcribeAudio: boolean;
  analyzeComments: boolean;
}

export const DEFAULT_DOUYIN_ANALYSIS_CONFIG: DouyinAnalysisConfig = {
  sourceText: "", extractFrames: true, frameCount: 12, transcribeAudio: true, analyzeComments: false,
};

export interface DouyinEvidenceSummary {
  metadataStatus: string;
  videoStatus: string;
  asrStatus: string;
  asrCoveredDurationMs: number;
  asrTextCharacters: number;
  plannedFrames: number;
  succeededFrames: number;
  failedFrames: number;
  commentCount: number;
  completeness: "unavailable" | "partial" | "complete";
}

export interface DouyinSnapshotSummary {
  id: string;
  sourceUrl: string;
  config: DouyinAnalysisConfig;
  status: DouyinAnalysisStatus;
  completeness: "unavailable" | "partial" | "complete";
  evidenceHash: string | null;
  reportHash: string | null;
  availability: Record<DouyinAvailabilityDimension, { status: "available" | "partial" | "unavailable"; reason: string }> | null;
  evidence: DouyinEvidenceSummary | null;
  createdAt: number;
  completedAt: number | null;
  invalidatedAt: number | null;
}

export interface DouyinJobSummary {
  id: string;
  status: "queued" | "running" | "succeeded" | "failed" | "cancelled";
  progress: number;
  attempts: number;
  maxAttempts: number;
  cancelRequested: boolean;
  errorCode: string | null;
  errorMessage: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface DouyinSelection {
  videoId: string;
  snapshotId: string;
  usageRole: DouyinUsageRole;
  creativeAngle: string;
  rightsConfirmed: boolean;
  updatedAt: number;
}

export interface DouyinAnalysisSummary {
  ok: true;
  snapshot: DouyinSnapshotSummary | null;
  job: DouyinJobSummary | null;
  selection: DouyinSelection | null;
  blockReasons: string[];
  allowedActions: { start: boolean; cancel: boolean; selectUsage: boolean };
}

export interface DouyinAnalysisSelectionInput {
  snapshotId: string;
  usageRole: DouyinUsageRole;
  creativeAngle: string;
  rightsConfirmed: boolean;
  acceptedMissingDimensions: DouyinAcceptedMissingDimension[];
}

export interface DouyinReportResponse { ok: true; report: unknown }
export interface DouyinTranscriptResponse { ok: true; transcript: unknown }
export interface DouyinFramesResponse { ok: true; items: unknown[] }
export interface DouyinCommentsPage { ok: true; page: number; pageSize: number; total: number; items: unknown[] }

export type DouyinDetailKind = "report" | "transcript" | "frames" | "comments";
