import { responseJson } from "../client-logic";
import type { Project, ProjectSummary, Video } from "./types";

async function request<T>(url: string, init?: RequestInit) {
  return responseJson<T>(await fetch(url, init));
}

const json = (body: unknown): RequestInit => ({
  method: "POST",
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
};
