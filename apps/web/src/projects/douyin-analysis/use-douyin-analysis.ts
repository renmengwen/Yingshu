import { useCallback, useEffect, useRef, useState } from "react";

import { projectApi } from "../api";
import { acceptedMissingDimensions, validateDouyinDraft } from "./logic";
import {
  DEFAULT_DOUYIN_ANALYSIS_CONFIG, type DouyinAnalysisConfig, type DouyinAnalysisSummary,
  type DouyinUsageRole,
} from "./types";

const editable = (config: DouyinAnalysisConfig) => JSON.stringify(config);

export function useDouyinAnalysis(projectId: string, videoId: string) {
  const [summary, setSummary] = useState<DouyinAnalysisSummary>();
  const [draft, setDraft] = useState<DouyinAnalysisConfig>({ ...DEFAULT_DOUYIN_ANALYSIS_CONFIG });
  const [savedDraft, setSavedDraft] = useState<DouyinAnalysisConfig>({ ...DEFAULT_DOUYIN_ANALYSIS_CONFIG });
  const [usageRole, setUsageRole] = useState<DouyinUsageRole>("method_only");
  const [creativeAngle, setCreativeAngle] = useState("");
  const [rightsConfirmed, setRightsConfirmed] = useState(false);
  const [acceptPartial, setAcceptPartial] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("正在恢复抖音分析任务与配置…");
  const [error, setError] = useState(false);
  const busyRef = useRef(false);
  const initializedRef = useRef(false);
  const controllerRef = useRef<AbortController | undefined>(undefined);
  const dirty = editable(draft) !== editable(savedDraft);
  const selectionDirty = Boolean(summary?.snapshot && (!summary.selection || summary.selection.snapshotId !== summary.snapshot.id ||
    summary.selection.usageRole !== usageRole || summary.selection.creativeAngle !== creativeAngle ||
    summary.selection.rightsConfirmed !== (usageRole === "content_source" && rightsConfirmed)));

  const refresh = useCallback(async () => {
    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;
    try {
      const next = await projectApi.getDouyinAnalysis(projectId, videoId, controller.signal);
      setSummary(next);
      if (!initializedRef.current) {
        const restored = next.snapshot?.config ?? { ...DEFAULT_DOUYIN_ANALYSIS_CONFIG };
        setDraft(restored);
        setSavedDraft(restored);
        setUsageRole(next.selection?.usageRole ?? "method_only");
        setCreativeAngle(next.selection?.creativeAngle ?? "");
        setRightsConfirmed(next.selection?.rightsConfirmed ?? false);
        initializedRef.current = true;
      }
      setLoaded(true);
      setError(false);
      setStatus(next.snapshot ? "抖音分析状态已恢复。" : "尚未绑定抖音视频。请先保存分析配置。 ");
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
    if (!dirty && !selectionDirty) return;
    const handler = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [dirty, selectionDirty]);

  function saveDraft() {
    const invalid = validateDouyinDraft(draft);
    if (invalid) { setError(true); setStatus(`抖音分析配置保存失败：${invalid}`); return; }
    setSavedDraft({ ...draft });
    setError(false);
    setStatus("抖音分析配置草稿已保存。可以开始分析。 ");
  }

  async function perform(message: string, action: () => Promise<unknown>, success: string) {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setError(false);
    setStatus(message);
    try {
      await action();
      await refresh();
      setStatus(success);
    } catch (cause) {
      const interrupted = (cause as Error).name === "AbortError";
      setError(!interrupted);
      setStatus(interrupted ? "操作已中断，当前草稿和已完成证据仍然保留。" : `${success.replace(/已.*$/u, "")}失败：${(cause as Error).message}。`);
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }

  const start = () => perform("正在解析抖音链接…", () => projectApi.createDouyinAnalysisJob(projectId, videoId, savedDraft), "抖音分析任务已创建。 ");
  const cancel = () => summary?.job ? perform("正在中断抖音分析…", () => projectApi.cancelDouyinAnalysisJob(projectId, videoId, summary.job!.id), "分析中断请求已记录。已完成证据仍然保留。") : Promise.resolve();
  const saveSelection = () => summary?.snapshot ? perform("正在保存抖音使用方式…", () => projectApi.saveDouyinAnalysisSelection(projectId, videoId, {
    snapshotId: summary.snapshot!.id, usageRole, creativeAngle, rightsConfirmed: usageRole === "content_source" && rightsConfirmed,
    acceptedMissingDimensions: acceptPartial
      ? acceptedMissingDimensions(summary.snapshot!.availability, summary.snapshot!.evidence)
      : [],
  }), "抖音使用方式已保存。当前文案与画面方案已按服务端规则失效。") : Promise.resolve();

  return {
    summary, draft, setDraft, savedDraft, loaded, busy, dirty, status, error, usageRole, setUsageRole,
    creativeAngle, setCreativeAngle, rightsConfirmed, setRightsConfirmed, acceptPartial, setAcceptPartial,
    selectionDirty, saveDraft, start, cancel, saveSelection, refresh,
  };
}
