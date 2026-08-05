import { useCallback, useEffect, useRef, useState } from "react";

import { projectApi } from "../api";
import { acceptedMissingDimensions, canSaveDouyinSelection } from "./logic";
import {
  DEFAULT_DOUYIN_ANALYSIS_CONFIG, type DouyinAnalysisConfig, type DouyinAnalysisSummary,
  type DouyinUsageRole,
} from "./types";

export function useDouyinAnalysis(projectId: string, videoId: string, onSelectionSaved?: () => void, selectionSaveBlocked = false) {
  const [summary, setSummary] = useState<DouyinAnalysisSummary>();
  const [draft, setDraft] = useState<DouyinAnalysisConfig>({ ...DEFAULT_DOUYIN_ANALYSIS_CONFIG });
  const [usageRole, setUsageRole] = useState<DouyinUsageRole>();
  const [creativeAngle, setCreativeAngle] = useState("");
  const [rightsConfirmed, setRightsConfirmed] = useState(false);
  const [acceptPartial, setAcceptPartial] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("正在恢复抖音分析任务与配置…");
  const [error, setError] = useState(false);
  const busyRef = useRef(false);
  const initializedRef = useRef(false);
  const restoredSnapshotIdRef = useRef<string | null | undefined>(undefined);
  const controllerRef = useRef<AbortController | undefined>(undefined);
  const failedSelectionValueRef = useRef<string | undefined>(undefined);
  const onSelectionSavedRef = useRef(onSelectionSaved);
  onSelectionSavedRef.current = onSelectionSaved;
  const selectionDirty = Boolean(summary?.snapshot && usageRole && (!summary.selection || summary.selection.snapshotId !== summary.snapshot.id ||
    summary.selection.usageRole !== usageRole || summary.selection.creativeAngle !== creativeAngle ||
    summary.selection.rightsConfirmed !== (usageRole === "content_source" && rightsConfirmed)));

  const refresh = useCallback(async () => {
    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;
    try {
      const next = await projectApi.getDouyinAnalysis(projectId, videoId, controller.signal);
      setSummary(next);
      const snapshotId = next.snapshot?.id ?? null;
      if (!initializedRef.current || restoredSnapshotIdRef.current !== snapshotId) {
        const restored = next.snapshot?.config ?? { ...DEFAULT_DOUYIN_ANALYSIS_CONFIG };
        setDraft(restored);
        const selection = next.selection?.snapshotId === snapshotId ? next.selection : null;
        setUsageRole(selection?.usageRole);
        setCreativeAngle(selection?.creativeAngle ?? "");
        setRightsConfirmed(selection?.rightsConfirmed ?? false);
        setAcceptPartial(false);
        restoredSnapshotIdRef.current = snapshotId;
        initializedRef.current = true;
      }
      setLoaded(true);
      setError(false);
      setStatus(next.snapshot ? "抖音分析状态已恢复。" : "尚未绑定抖音视频。粘贴链接后可直接开始分析。");
    } catch (cause) {
      if ((cause as Error).name === "AbortError") return;
      setLoaded(true);
      setError(true);
      setStatus(`抖音分析状态恢复失败：${(cause as Error).message}。`);
    }
  }, [projectId, videoId]);

  useEffect(() => {
    initializedRef.current = false;
    void refresh();
    return () => controllerRef.current?.abort();
  }, [refresh]);

  useEffect(() => {
    const active = summary?.job && ["queued", "running"].includes(summary.job.status);
    if (!active) return;
    const timer = window.setInterval(() => { void refresh(); }, 1_500);
    return () => window.clearInterval(timer);
  }, [refresh, summary?.job?.id, summary?.job?.status]);

  useEffect(() => {
    if (!selectionDirty) return;
    const handler = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [selectionDirty]);

  useEffect(() => {
    if (selectionSaveBlocked || !canSaveDouyinSelection({ busy, selectionDirty, acceptPartial, usageRole, rightsConfirmed, summary })) return;
    const value = JSON.stringify({ snapshotId: summary?.snapshot?.id, usageRole, creativeAngle, rightsConfirmed, acceptPartial });
    if (failedSelectionValueRef.current === value) return;
    setStatus("使用方式将在停止修改后自动保存…");
    const timer = window.setTimeout(() => { void saveSelection(); }, 700);
    return () => window.clearTimeout(timer);
  }, [acceptPartial, busy, creativeAngle, rightsConfirmed, selectionDirty, selectionSaveBlocked, summary, usageRole]);

  async function perform<T>(message: string, action: () => Promise<T>, success: string, applyResult?: (result: T) => void) {
    if (busyRef.current) return false;
    busyRef.current = true;
    setBusy(true);
    setError(false);
    setStatus(message);
    try {
      const result = await action();
      if (applyResult) applyResult(result);
      else await refresh();
      setStatus(success);
      return true;
    } catch (cause) {
      const interrupted = (cause as Error).name === "AbortError";
      setError(!interrupted);
      setStatus(interrupted ? "操作已中断，当前草稿和已完成证据仍然保留。" : `${success.replace(/已.*$/u, "")}失败：${(cause as Error).message}。`);
      return false;
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }

  const start = () => perform("正在解析抖音链接…", () => projectApi.createDouyinAnalysisJob(projectId, videoId, draft), "抖音分析任务已创建。 ");
  const cancel = () => summary?.job ? perform("正在中断抖音分析…", () => projectApi.cancelDouyinAnalysisJob(projectId, videoId, summary.job!.id), "分析中断请求已记录。已完成证据仍然保留。") : Promise.resolve(false);
  async function saveSelection() {
    if (!summary?.snapshot || !usageRole || busyRef.current) return false;
    const submittedValue = JSON.stringify({ snapshotId: summary.snapshot.id, usageRole, creativeAngle, rightsConfirmed, acceptPartial });
    const saved = await perform("正在自动保存抖音使用方式…", () => projectApi.saveDouyinAnalysisSelection(projectId, videoId, {
      snapshotId: summary.snapshot!.id, usageRole, creativeAngle, rightsConfirmed: usageRole === "content_source" && rightsConfirmed,
      acceptedMissingDimensions: acceptPartial
        ? acceptedMissingDimensions(summary.snapshot!.availability, summary.snapshot!.evidence)
        : [],
    }), "抖音使用方式已自动保存。当前文案与画面方案已按服务端规则失效。", (response) => {
      setSummary((current) => current ? { ...current, selection: response.selection } : current);
    });
    failedSelectionValueRef.current = saved ? undefined : submittedValue;
    if (saved) onSelectionSavedRef.current?.();
    return saved;
  }

  return {
    summary, draft, setDraft, loaded, busy, status, error, usageRole, setUsageRole,
    creativeAngle, setCreativeAngle, rightsConfirmed, setRightsConfirmed, acceptPartial, setAcceptPartial,
    selectionDirty, start, cancel, saveSelection, refresh,
  };
}
