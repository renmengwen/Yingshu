import { responseJson } from "../client-logic";
import type { Project, ProjectCreativeSettings, ProjectSummary, Video, VideoInputDraft, VideoPlan, VideoPlanJob, VideoPlanSource, VideoScriptParagraph, VideoVisualDraft } from "./types";
import type { VideoImageWorkspace } from "./image-logic";

async function request<T>(url: string, init?: RequestInit) {
  return responseJson<T>(await fetch(url, init));
}

const json = (body: unknown, method = "POST"): RequestInit => ({
  method,
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

export const projectApi = {
  list: (signal?: AbortSignal) => request<{ ok: true; items: ProjectSummary[] }>("/api/projects", { signal }),
  create: (name: string) => request<{ ok: true; project: Project }>("/api/projects", json({ name })),
  get: (projectId: string, signal?: AbortSignal) => request<{ ok: true; project: Project }>(`/api/projects/${encodeURIComponent(projectId)}`, { signal }),
  delete: (projectId: string) => request<{ ok: true; message: string }>(`/api/projects/${encodeURIComponent(projectId)}`, { method: "DELETE" }),
  listVideos: (projectId: string, signal?: AbortSignal) => request<{ ok: true; items: Video[] }>(`/api/projects/${encodeURIComponent(projectId)}/videos`, { signal }),
  createVideo: (projectId: string, title: string) => request<{ ok: true; video: Video }>(`/api/projects/${encodeURIComponent(projectId)}/videos`, json({ title })),
  getVideo: (projectId: string, videoId: string, signal?: AbortSignal) => request<{ ok: true; video: Video }>(`/api/projects/${encodeURIComponent(projectId)}/videos/${encodeURIComponent(videoId)}`, { signal }),
  getSettings: (projectId: string, signal?: AbortSignal) => request<{ ok: true; settings: ProjectCreativeSettings }>(`/api/projects/${encodeURIComponent(projectId)}/settings`, { signal }),
  saveSettings: (projectId: string, settings: Pick<ProjectCreativeSettings, "scriptInstructions" | "visualInstructions">) => request<{ ok: true; settings: ProjectCreativeSettings }>(`/api/projects/${encodeURIComponent(projectId)}/settings`, json(settings, "PUT")),
  getVideoInput: (projectId: string, videoId: string, signal?: AbortSignal) => request<{ ok: true; input: VideoInputDraft }>(`/api/projects/${encodeURIComponent(projectId)}/videos/${encodeURIComponent(videoId)}/input`, { signal }),
  saveVideoInput: (projectId: string, videoId: string, input: Omit<VideoInputDraft, "updatedAt">) => request<{ ok: true; input: VideoInputDraft }>(`/api/projects/${encodeURIComponent(projectId)}/videos/${encodeURIComponent(videoId)}/input`, json(input, "PUT")),
  createPlanJob: (projectId: string, videoId: string, idempotencyKey: string) => request<{ ok: true; message: string; job: Pick<VideoPlanJob, "id" | "status" | "updatedAt">; videoStatus: Video["status"] }>(`${videoUrl(projectId, videoId)}/plan-jobs`, json({ idempotencyKey })),
  getPlan: (projectId: string, videoId: string, signal?: AbortSignal) => request<{ ok: true; plan: VideoPlan | null }>(`${videoUrl(projectId, videoId)}/plan`, { signal }),
  getPlanSources: (projectId: string, videoId: string, signal?: AbortSignal) => request<{ ok: true; webEnabled: boolean; items: VideoPlanSource[] }>(`${videoUrl(projectId, videoId)}/sources`, { signal }),
  getPlanJob: (projectId: string, videoId: string, signal?: AbortSignal) => request<{ ok: true; job: VideoPlanJob | null; videoStatus: Video["status"] }>(`${videoUrl(projectId, videoId)}/plan-job`, { signal }),
  cancelPlanJob: (projectId: string, videoId: string) => request<{ ok: true; job: VideoPlanJob | null; videoStatus: Video["status"] }>(`${videoUrl(projectId, videoId)}/plan-job/cancel`, { method: "POST" }),
  saveScriptRevision: (projectId: string, videoId: string, body: { snapshotId: string; baseRevision: number; paragraphs: VideoScriptParagraph[]; title: string; summary: string }) => request<{ ok: true; message: string; plan: VideoPlan }>(`${videoUrl(projectId, videoId)}/script-revisions`, json(body)),
  saveVisualRevision: (projectId: string, videoId: string, body: { snapshotId: string; baseRevision: number; scriptRevisionId: string; visuals: VideoVisualDraft[] }) => request<{ ok: true; message: string; plan: VideoPlan }>(`${videoUrl(projectId, videoId)}/visual-revisions`, json(body)),
  approvePlan: (projectId: string, videoId: string, body: { snapshotId: string; scriptRevisionId: string; visualRevisionId: string }) => request<{ ok: true; message: string; plan: VideoPlan }>(`${videoUrl(projectId, videoId)}/approve`, json(body)),
  getVideoImageWorkspace: (projectId: string, videoId: string, signal?: AbortSignal) => request<{ ok: true; workspace: VideoImageWorkspace }>(`${videoUrl(projectId, videoId)}/images/workspace`, { signal }),
  startVideoImageBatch: (projectId: string, videoId: string, body: { idempotencyKey: string; mode: "missing" | "retry_failed" }) => request<{ ok: true; message: string }>(`${videoUrl(projectId, videoId)}/image-batches`, json(body)),
  startVideoImageJob: (projectId: string, videoId: string, visualId: string, body: { idempotencyKey: string; regenerate: boolean }) => request<{ ok: true; message: string }>(`${videoUrl(projectId, videoId)}/visuals/${encodeURIComponent(visualId)}/image-jobs`, json(body)),
  uploadVideoImageCandidate: (projectId: string, videoId: string, visualId: string, file: File) => request<{ ok: true; message: string }>(`${videoUrl(projectId, videoId)}/visuals/${encodeURIComponent(visualId)}/image-candidates/upload`, {
    method: "POST",
    headers: { "content-type": "application/octet-stream", "x-file-name": encodeURIComponent(file.name) },
    body: file,
  }),
  approveVideoImageCandidate: (projectId: string, videoId: string, visualId: string, candidateId: string, expectedGateRevision: number) => request<{ ok: true; message: string }>(`${videoUrl(projectId, videoId)}/visuals/${encodeURIComponent(visualId)}/image-approval`, json({ candidateId, expectedGateRevision }, "PUT")),
  cancelVideoImageBatch: (projectId: string, videoId: string, batchId: string) => request<{ ok: true; message: string }>(`${videoUrl(projectId, videoId)}/image-batches/${encodeURIComponent(batchId)}/cancel`, { method: "POST" }),
};

function videoUrl(projectId: string, videoId: string) {
  return `/api/projects/${encodeURIComponent(projectId)}/videos/${encodeURIComponent(videoId)}`;
}
