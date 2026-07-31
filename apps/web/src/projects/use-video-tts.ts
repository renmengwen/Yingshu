import { useCallback, useEffect, useRef, useState } from "react";

import { isActiveVideoTtsJob, type VideoTtsActionState, type VideoTtsDurationDecision, type VideoTtsWorkspace } from "./video-tts-logic";

interface WorkspaceResponse { ok: true; message?: string; workspace: VideoTtsWorkspace }

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, { ...init, headers: { "content-type": "application/json", ...init?.headers } });
  const body = await response.json().catch(() => null) as ({ message?: string } & T) | null;
  if (!response.ok || !body) throw new Error(body?.message || `请求失败（HTTP ${response.status}）`);
  return body;
}

export function useVideoTts(projectId: string, videoId: string) {
  const base = `/api/projects/${encodeURIComponent(projectId)}/videos/${encodeURIComponent(videoId)}`;
  const [workspace, setWorkspace] = useState<VideoTtsWorkspace | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [actionState, setActionState] = useState<VideoTtsActionState>("loading");
  const [status, setStatus] = useState("正在恢复配音与字幕状态…");
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const busyRef = useRef(false);
  const identityRef = useRef(`${projectId}:${videoId}`);
  identityRef.current = `${projectId}:${videoId}`;

  const refresh = useCallback(async (silent = false) => {
    const identity = `${projectId}:${videoId}`;
    if (!silent) { setActionState("loading"); setStatus("正在恢复配音与字幕状态…"); }
    try {
      const body = await request<WorkspaceResponse>(`${base}/tts`);
      if (identityRef.current !== identity) return;
      setWorkspace(body.workspace);
      setLoaded(true);
      if (!silent) { setActionState("success"); setStatus(body.message || "配音与字幕状态已恢复。"); }
    } catch (cause) {
      if (identityRef.current !== identity) return;
      setLoaded(true); setActionState("error"); setStatus(`配音工作区恢复失败：${(cause as Error).message}。`);
    }
  }, [base, projectId, videoId]);

  useEffect(() => { busyRef.current = false; setBusyAction(null); }, [projectId, videoId]);
  useEffect(() => { void refresh(); }, [refresh]);
  useEffect(() => {
    if (!isActiveVideoTtsJob(workspace?.job ?? null)) return;
    const timer = window.setInterval(() => void refresh(true), 1500);
    return () => window.clearInterval(timer);
  }, [refresh, workspace?.job]);

  async function perform(key: string, loading: string, operation: () => Promise<WorkspaceResponse>) {
    if (busyRef.current) return;
    const identity = `${projectId}:${videoId}`;
    busyRef.current = true; setBusyAction(key); setActionState("loading"); setStatus(loading);
    try {
      const body = await operation();
      if (identityRef.current !== identity) return;
      setWorkspace(body.workspace); setActionState("success"); setStatus(body.message || "操作已完成。");
    } catch (cause) {
      if (identityRef.current !== identity) return;
      const interrupted = cause instanceof DOMException && cause.name === "AbortError";
      setActionState(interrupted ? "interrupted" : "error");
      setStatus(interrupted ? "操作已中断，已完成的安全产物仍会保留。" : `${(cause as Error).message}。请修正后重试。`);
    } finally {
      if (identityRef.current === identity) { busyRef.current = false; setBusyAction(null); }
    }
  }

  const post = (path: string, body: unknown) => request<WorkspaceResponse>(`${base}${path}`, { method: "POST", body: JSON.stringify(body) });
  return {
    workspace, loaded, actionState, status, busyAction, refresh,
    start: (voiceId: string, rate: number, language: string) => perform("start", "正在创建配音与字幕任务…", () => post("/tts-jobs", { voiceId, rate, language })),
    cancel: () => workspace?.job ? perform("cancel", "正在中断配音任务…", () => post(`/tts-jobs/${encodeURIComponent(workspace.job!.id)}/cancel`, {})) : Promise.resolve(),
    requestRegeneration: (snapshotId: string, artifactId: string, notes: string) => perform("review", "正在记录需要重新生成…", () => post("/audio-review", { snapshotId, artifactId, action: "needs_regeneration", notes, durationDecision: "reprocess" })),
    approve: (snapshotId: string, artifactId: string, notes: string, durationDecision: Exclude<VideoTtsDurationDecision, "reprocess" | null>) => perform("approve", "正在批准当前配音与字幕…", () => post("/audio-approval", { snapshotId, artifactId, confirmedFullPlayback: true, notes, durationDecision })),
  };
}
