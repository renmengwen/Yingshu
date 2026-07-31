import { useCallback, useEffect, useRef, useState } from "react";

import { projectApi } from "./api";
import { isActiveImageBatch, type VideoImageActionState, type VideoImageWorkspace } from "./image-logic";

interface ImageApiResponse {
  ok: true;
  message?: string;
  workspace?: VideoImageWorkspace;
}

interface ImageProjectApi {
  getVideoImageWorkspace(projectId: string, videoId: string, signal?: AbortSignal): Promise<{ ok: true; workspace: VideoImageWorkspace }>;
  startVideoImageBatch(projectId: string, videoId: string, body: { idempotencyKey: string; mode: "missing" | "retry_failed" }): Promise<ImageApiResponse>;
  startVideoImageJob(projectId: string, videoId: string, visualId: string, body: { idempotencyKey: string; regenerate: boolean }): Promise<ImageApiResponse>;
  uploadVideoImageCandidate(projectId: string, videoId: string, visualId: string, file: File): Promise<ImageApiResponse>;
  approveVideoImageCandidate(projectId: string, videoId: string, visualId: string, candidateId: string, expectedGateRevision: number): Promise<ImageApiResponse>;
  cancelVideoImageBatch(projectId: string, videoId: string, batchId: string): Promise<ImageApiResponse>;
}

const imageApi = projectApi as typeof projectApi & ImageProjectApi;

export function useVideoImages(projectId: string, videoId: string) {
  const [workspace, setWorkspace] = useState<VideoImageWorkspace | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [actionState, setActionState] = useState<VideoImageActionState>("loading");
  const [status, setStatus] = useState("正在恢复图片候选与审核状态…");
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const busyRef = useRef(false);
  const identityRef = useRef(`${projectId}:${videoId}`);
  identityRef.current = `${projectId}:${videoId}`;

  const refresh = useCallback(async (silent = false) => {
    const identity = `${projectId}:${videoId}`;
    if (!silent) {
      setActionState("loading");
      setStatus("正在恢复图片候选与审核状态…");
    }
    try {
      const body = await imageApi.getVideoImageWorkspace(projectId, videoId);
      if (identityRef.current !== identity) return;
      setWorkspace(body.workspace);
      setLoaded(true);
      if (!silent) {
        setActionState("success");
        setStatus(body.workspace.gate.status === "complete" ? "全部正式画面已批准图片，图片审核已完成。" : "图片候选与审核状态已恢复。");
      }
    } catch (cause) {
      if (identityRef.current !== identity) return;
      setLoaded(true);
      setActionState("error");
      setStatus(`图片工作区恢复失败：${(cause as Error).message}。请稍后重试。`);
    }
  }, [projectId, videoId]);

  useEffect(() => {
    busyRef.current = false;
    setBusyAction(null);
  }, [projectId, videoId]);
  useEffect(() => { void refresh(); }, [refresh]);
  useEffect(() => {
    if (!isActiveImageBatch(workspace?.batch ?? null)) return;
    const timer = window.setInterval(() => void refresh(true), 1500);
    return () => window.clearInterval(timer);
  }, [refresh, workspace?.batch]);

  async function perform(key: string, loading: string, operation: () => Promise<ImageApiResponse>) {
    if (busyRef.current) return;
    const identity = `${projectId}:${videoId}`;
    busyRef.current = true;
    setBusyAction(key);
    setActionState("loading");
    setStatus(loading);
    try {
      const body = await operation();
      if (identityRef.current !== identity) return;
      if (body.workspace) setWorkspace(body.workspace);
      else await refresh(true);
      setActionState("success");
      setStatus(body.message || "操作已完成。审核状态已更新。");
    } catch (cause) {
      if (identityRef.current !== identity) return;
      const interrupted = cause instanceof DOMException && cause.name === "AbortError";
      setActionState(interrupted ? "interrupted" : "error");
      setStatus(interrupted ? "操作已中断，已完成的图片候选仍会保留。" : `${(cause as Error).message}。请修正后重试。`);
    } finally {
      if (identityRef.current !== identity) return;
      busyRef.current = false;
      setBusyAction(null);
    }
  }

  return {
    workspace, loaded, actionState, status, busyAction, refresh,
    startBatch: (mode: "missing" | "retry_failed" = "missing") => perform("batch", mode === "missing" ? "正在创建缺失画面的图片生成批次…" : "正在创建失败项重试批次…", () => imageApi.startVideoImageBatch(projectId, videoId, { idempotencyKey: crypto.randomUUID(), mode })),
    cancelBatch: () => workspace?.batch ? perform("cancel", "正在中断图片批次，已完成的候选会保留…", () => imageApi.cancelVideoImageBatch(projectId, videoId, workspace.batch!.id)) : Promise.resolve(),
    generate: (visualId: string, regenerate = false) => perform(`generate:${visualId}`, regenerate ? "正在创建新的图片候选任务…" : "正在创建单张图片任务…", () => imageApi.startVideoImageJob(projectId, videoId, visualId, { idempotencyKey: crypto.randomUUID(), regenerate })),
    upload: (visualId: string, file: File) => perform(`upload:${visualId}`, `正在验证并上传“${file.name}”…`, () => imageApi.uploadVideoImageCandidate(projectId, videoId, visualId, file)),
    approve: (visualId: string, candidateId: string) => perform(`approve:${visualId}`, "正在批准所选图片候选…", () => imageApi.approveVideoImageCandidate(projectId, videoId, visualId, candidateId, workspace?.gate.revision ?? 0)),
  };
}
