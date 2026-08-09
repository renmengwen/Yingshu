import { useCallback, useEffect, useRef, useState } from "react";

import { responseJson } from "../client-logic";
import {
  mergeVideoVisualReview, parseVideoRenderWorkspace, parseVideoVisualTimeline,
  type AsyncState, type VideoMotionKind, type VideoRenderWorkspace, type VideoVisualTimelineWorkspace,
} from "./video-final-production-logic";

function baseUrl(projectId: string, videoId: string) {
  return `/api/projects/${encodeURIComponent(projectId)}/videos/${encodeURIComponent(videoId)}`;
}

async function jsonRequest(url: string, init?: RequestInit) {
  return responseJson<unknown>(await fetch(url, init));
}

const json = (body: unknown, method = "POST"): RequestInit => ({
  method, headers: { "content-type": "application/json" }, body: JSON.stringify(body),
});

export function useVideoVisualTimeline(projectId: string, videoId: string) {
  const identity = `${projectId}:${videoId}`;
  const identityRef = useRef(identity);
  identityRef.current = identity;
  const writing = useRef(false);
  const readingIdentity = useRef<string | null>(null);
  const [workspace, setWorkspace] = useState<VideoVisualTimelineWorkspace | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [state, setState] = useState<AsyncState>("loading");
  const [message, setMessage] = useState("正在恢复画面时间轴与整片审核状态…");
  const [busyAction, setBusyAction] = useState<string | null>(null);

  const refresh = useCallback(async (silent = false) => {
    const expected = `${projectId}:${videoId}`;
    if (readingIdentity.current === expected) return;
    readingIdentity.current = expected;
    if (!silent) { setState("loading"); setMessage("正在恢复画面时间轴与整片审核状态…"); }
    try {
      const base = baseUrl(projectId, videoId);
      const timeline = parseVideoVisualTimeline(await jsonRequest(`${base}/visual-timelines`), { projectId, videoId });
      let merged = timeline;
      if (timeline.timeline) {
        const reviewResponse = await fetch(`${base}/visual-review`);
        if (reviewResponse.ok) merged = mergeVideoVisualReview(timeline, await responseJson<unknown>(reviewResponse));
        else if (reviewResponse.status !== 404 && reviewResponse.status !== 409) await responseJson(reviewResponse);
      }
      if (identityRef.current !== expected) return;
      setWorkspace(merged); setLoaded(true);
      if (!silent) { setState("success"); setMessage(merged.timeline ? "画面时间轴与整片审核状态已恢复。" : "门禁状态已恢复，可以创建正式画面时间轴。"); }
    } catch (cause) {
      if (identityRef.current !== expected) return;
      setLoaded(true); setState("error"); setMessage(`画面时间轴恢复失败：${(cause as Error).message}。`);
    } finally {
      if (readingIdentity.current === expected) readingIdentity.current = null;
    }
  }, [projectId, videoId]);

  useEffect(() => { writing.current = false; setBusyAction(null); void refresh(); }, [refresh]);

  async function perform(key: string, loading: string, operation: () => Promise<unknown>, success: string) {
    if (writing.current) return;
    const expected = `${projectId}:${videoId}`;
    writing.current = true; setBusyAction(key); setState("loading"); setMessage(loading);
    try {
      await operation();
      if (identityRef.current !== expected) return;
      await refresh(true);
      if (identityRef.current !== expected) return;
      setState("success"); setMessage(success);
    } catch (cause) {
      if (identityRef.current !== expected) return;
      const interrupted = cause instanceof DOMException && cause.name === "AbortError";
      setState(interrupted ? "interrupted" : "error");
      setMessage(interrupted ? "操作已中断，已保存的时间轴数据仍会保留。" : `${(cause as Error).message}。请修正后重试。`);
    } finally {
      if (identityRef.current === expected) { writing.current = false; setBusyAction(null); }
    }
  }

  const base = baseUrl(projectId, videoId);
  return {
    workspace, loaded, state, message, busyAction, refresh,
    createTimeline: (rebuild = false) => perform("timeline", rebuild ? "正在按当前上游身份重建正式画面时间轴…" : "正在创建正式画面时间轴…", () => jsonRequest(`${base}/visual-timelines`, json({})), rebuild ? "正式画面时间轴已按当前上游身份恢复，旧整片审核状态已重新核对。" : "正式画面时间轴已创建。"),
    updateSegment: (segmentId: string, patch: { motionKind: VideoMotionKind; motionAmountPpm: number; fadeInMs: number; fadeOutMs: number }) => {
      if (!workspace?.timeline) return Promise.resolve();
      return perform(`segment:${segmentId}`, "正在保存运镜与淡入淡出…", () => jsonRequest(`${base}/visual-timelines/${encodeURIComponent(workspace.timeline!.id)}/segments/${encodeURIComponent(segmentId)}`, json({ ...patch, expectedTimelineHash: workspace.timeline!.hash }, "PATCH")), "画面段已保存，整片审核状态已重新核对。");
    },
    reviewTimeline: (action: "approve" | "needs_changes", notes: string) => {
      if (!workspace?.timeline) return Promise.resolve();
      const timeline = workspace.timeline;
      return perform("review", action === "approve" ? "正在提交整片视觉审核…" : "正在记录整片返修意见…", () => jsonRequest(`${base}/visual-review`, json({ timelineId: timeline.id, timelineRevision: timeline.revision, timelineHash: timeline.hash, identityHash: timeline.identityHash, action, notes: notes.trim() || undefined })), action === "approve" ? "当前画面时间轴已通过人工审核，不会自动开始渲染。" : "返修意见已记录，不会开始渲染。" );
    },
  };
}

export function useVideoRenderExport(projectId: string, videoId: string) {
  const identity = `${projectId}:${videoId}`;
  const identityRef = useRef(identity);
  identityRef.current = identity;
  const writing = useRef(false);
  const readingIdentity = useRef<string | null>(null);
  const [workspace, setWorkspace] = useState<VideoRenderWorkspace | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [state, setState] = useState<AsyncState>("loading");
  const [message, setMessage] = useState("正在恢复最终渲染状态…");
  const [busyAction, setBusyAction] = useState<string | null>(null);

  const refresh = useCallback(async (silent = false) => {
    const expected = `${projectId}:${videoId}`;
    if (readingIdentity.current === expected) return;
    readingIdentity.current = expected;
    if (!silent) { setState("loading"); setMessage("正在恢复最终渲染状态…"); }
    try {
      const restored = parseVideoRenderWorkspace(await jsonRequest(`${baseUrl(projectId, videoId)}/renders`), { projectId, videoId });
      if (identityRef.current !== expected) return;
      setWorkspace(restored); setLoaded(true);
      if (restored.final) { setState("success"); setMessage("最终 MP4 已通过服务端校验，可以播放和下载。"); }
      else if (restored.render?.status === "failed") { setState("error"); setMessage(`最终渲染失败：${restored.render.errorMessage ?? "未提供错误详情"}。已成功分片会保留。`); }
      else if (restored.render?.status === "cancelled") { setState("interrupted"); setMessage("最终渲染已中断，已成功分片会保留。"); }
      else if (restored.render?.status === "queued" || restored.render?.status === "running") {
        setState("loading"); setMessage(`正在处理渲染分片：成功 ${restored.render.chunks.succeeded}/${restored.render.chunks.total}，运行中 ${restored.render.chunks.running}。`);
      } else if (!silent) { setState("success"); setMessage(restored.readiness.ready ? "最终渲染门禁已通过，等待明确启动。" : "渲染门禁尚未通过。请先处理阻断项。"); }
    } catch (cause) {
      if (identityRef.current !== expected) return;
      setLoaded(true); setState("error"); setMessage(`最终渲染状态恢复失败：${(cause as Error).message}。`);
    } finally {
      if (readingIdentity.current === expected) readingIdentity.current = null;
    }
  }, [projectId, videoId]);

  useEffect(() => { writing.current = false; setBusyAction(null); void refresh(); }, [refresh]);
  useEffect(() => {
    if (workspace?.render?.status !== "queued" && workspace?.render?.status !== "running") return;
    const timer = window.setInterval(() => void refresh(true), 1500);
    return () => window.clearInterval(timer);
  }, [refresh, workspace?.render?.status]);

  async function perform(key: string, loading: string, operation: () => Promise<unknown>, success: string) {
    if (writing.current) return;
    const expected = `${projectId}:${videoId}`;
    writing.current = true; setBusyAction(key); setState("loading"); setMessage(loading);
    try {
      const response = await operation();
      if (identityRef.current !== expected) return;
      const next = parseVideoRenderWorkspace(response, { projectId, videoId });
      setWorkspace(next); setState("success"); setMessage(success);
    } catch (cause) {
      if (identityRef.current !== expected) return;
      const interrupted = cause instanceof DOMException && cause.name === "AbortError";
      setState(interrupted ? "interrupted" : "error"); setMessage(interrupted ? "操作已中断，已完成的分片仍会保留。" : `${(cause as Error).message}。请修正后重试。`);
    } finally {
      if (identityRef.current === expected) { writing.current = false; setBusyAction(null); }
    }
  }

  const base = baseUrl(projectId, videoId);
  return {
    workspace, loaded, state, message, busyAction, refresh,
    startRender: () => perform("render", "正在创建最终渲染任务…", () => jsonRequest(`${base}/renders`, json({})), "最终渲染任务已创建。页面会持续恢复真实分片状态。"),
    cancelRender: () => workspace?.render ? perform("cancel", "正在请求中断最终渲染…", () => jsonRequest(`${base}/renders/${encodeURIComponent(workspace.render!.id)}/cancel`, json({})), "渲染中断请求已记录，已成功分片会保留。") : Promise.resolve(),
    streamUrl: `${base}/final-video`, downloadUrl: `${base}/final-video/download`,
    previousStreamUrl: workspace?.previousFinal ? `${base}/previous-final-video?runId=${encodeURIComponent(workspace.previousFinal.runId)}` : undefined,
    previousDownloadUrl: workspace?.previousFinal ? `${base}/previous-final-video/download?runId=${encodeURIComponent(workspace.previousFinal.runId)}` : undefined,
  };
}
