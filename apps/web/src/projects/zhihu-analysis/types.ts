export type ZhihuUsageRole = "method_only" | "topic_seed" | "content_source";
export type ZhihuAnalysisStatus =
  "queued" | "running" | "partial" | "succeeded" | "failed" | "cancelled";
export type ZhihuAvailabilityDimension =
  "original" | "method" | "topic" | "audience";
export type ZhihuAcceptedMissingDimension =
  ZhihuAvailabilityDimension | "comments";

export interface ZhihuAnalysisConfig {
  sourceUrl: string;
  analyzeComments: boolean;
  maxComments: number;
}

export const DEFAULT_ZHIHU_ANALYSIS_CONFIG: ZhihuAnalysisConfig = {
  sourceUrl: "",
  analyzeComments: true,
  maxComments: 50,
};

export interface ZhihuEvidenceSummary {
  answerStatus: string;
  commentsStatus: string;
  commentCount: number;
  completeness: "unavailable" | "partial" | "complete";
}

export interface ZhihuSnapshotSummary {
  id: string;
  sourceUrl: string;
  config: ZhihuAnalysisConfig;
  status: ZhihuAnalysisStatus;
  completeness: "unavailable" | "partial" | "complete";
  evidenceHash: string | null;
  reportHash: string | null;
  availability: Record<
    ZhihuAvailabilityDimension,
    { status: "available" | "partial" | "unavailable"; reason: string }
  > | null;
  evidence: ZhihuEvidenceSummary | null;
  createdAt: number;
  completedAt: number | null;
  invalidatedAt: number | null;
}

export interface ZhihuJobSummary {
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

export interface ZhihuSelection {
  videoId: string;
  snapshotId: string;
  usageRole: ZhihuUsageRole;
  creativeAngle: string;
  rightsConfirmed: boolean;
  updatedAt: number;
}

export interface ZhihuAnalysisSummary {
  ok: true;
  snapshot: ZhihuSnapshotSummary | null;
  job: ZhihuJobSummary | null;
  selection: ZhihuSelection | null;
  blockReasons: string[];
  allowedActions: { start: boolean; cancel: boolean; selectUsage: boolean };
}

export interface ZhihuAnalysisSelectionInput {
  snapshotId: string;
  usageRole: ZhihuUsageRole;
  creativeAngle: string;
  rightsConfirmed: boolean;
  acceptedMissingDimensions: ZhihuAcceptedMissingDimension[];
}

export interface ZhihuAnalysisSelectionResponse {
  ok: true;
  message: string;
  selection: ZhihuSelection;
}
export interface ZhihuReportResponse {
  ok: true;
  report: unknown;
}
export interface ZhihuAnswerResponse {
  ok: true;
  answer: unknown;
}
export interface ZhihuCommentsPage {
  ok: true;
  page: number;
  pageSize: number;
  total: number;
  items: unknown[];
}
export type ZhihuDetailKind = "answer" | "comments" | "report";
