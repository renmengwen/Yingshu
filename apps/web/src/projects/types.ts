export interface Project {
  id: string;
  name: string;
  createdAt: number;
  updatedAt: number;
}

export interface ProjectSummary extends Project {
  videoCount: number;
}

export interface Video {
  id: string;
  projectId: string;
  title: string;
  status: "draft" | "preparing_sources" | "generating_script" | "planning_visuals" | "awaiting_review" | "producing_media" | "awaiting_media_review" | "rendering" | "completed" | "failed" | "cancelled";
  createdAt: number;
  updatedAt: number;
}

export type VideoPlanJobStatus = "queued" | "running" | "succeeded" | "failed" | "cancelled";

export interface VideoPlanJob {
  id: string;
  status: VideoPlanJobStatus;
  errorMessage: string | null;
  updatedAt: number;
}

export interface VideoScriptParagraph {
  id: string;
  text: string;
}

export interface VideoScriptRevision {
  id: string;
  revision: number;
  title: string;
  summary: string;
  narration: string;
  estimatedCharacters: number;
  estimatedDurationSeconds: number;
  paragraphs: VideoScriptParagraph[];
  sourceSummary: string[];
  risks: string[];
  contentHash: string;
  createdAt: number;
}

export interface VideoVisualDraft {
  id: string;
  paragraphId: string;
  purpose: string;
  description: string;
  prompt: string;
  negativePrompt: string;
  suggestedDurationSeconds: number;
  weight: number;
  generationStatus: "not_generated";
  currentCandidate: null;
}

export interface VideoVisualRevision {
  id: string;
  revision: number;
  scriptRevisionId: string;
  scriptContentHash: string;
  contentHash: string;
  createdAt: number;
  visuals: VideoVisualDraft[];
}

export interface VideoPlan {
  snapshotId: string;
  snapshotHash: string;
  webEnabled: boolean;
  createdAt: number;
  stale: boolean;
  script: VideoScriptRevision;
  visual: VideoVisualRevision;
  approval: null | { revision: number; createdAt: number; valid: boolean };
}

export interface VideoPlanSource {
  id: string;
  title: string;
  url: string;
  retrievedAt: number;
  usageSummary: string;
  status: string;
  failureSummary: string | null;
}

export interface ProjectCreativeSettings {
  scriptInstructions: string;
  visualInstructions: string;
  updatedAt: number;
}

export type InputMode = "topic" | "body";
export type ReferenceRole = "style_only" | "content_source";
export type VisualDensity = "relaxed" | "standard" | "compact";

export interface VideoInputDraft {
  inputMode: InputMode;
  topic: string;
  body: string;
  referenceText: string;
  referenceRole: ReferenceRole;
  targetDurationSeconds: number;
  visualDensity: VisualDensity;
  webEnabled: boolean;
  scriptInstructions: string;
  visualInstructions: string;
  updatedAt: number;
}

export interface PageCommonProps {
  navigate: (path: string) => void;
  onOpenSettings: () => void;
  themePreference: "system" | "light" | "dark";
  onThemeChange: (preference: "system" | "light" | "dark") => void;
}
