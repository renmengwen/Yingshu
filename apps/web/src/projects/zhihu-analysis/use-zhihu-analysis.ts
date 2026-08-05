import { useCallback, useEffect, useRef, useState } from "react";

import { projectApi } from "../api";
import { acceptedMissingDimensions, canSaveZhihuSelection } from "./logic";
import {
  DEFAULT_ZHIHU_ANALYSIS_CONFIG,
  type ZhihuAnalysisConfig,
  type ZhihuAnalysisSummary,
  type ZhihuUsageRole,
} from "./types";

export function useZhihuAnalysis(
  projectId: string,
  videoId: string,
  onSelectionSaved?: () => void,
  selectionSaveBlocked = false,
) {
  const [summary, setSummary] = useState<ZhihuAnalysisSummary>();
  const [draft, setDraft] = useState<ZhihuAnalysisConfig>({
    ...DEFAULT_ZHIHU_ANALYSIS_CONFIG,
  });
  const [usageRole, setUsageRole] = useState<ZhihuUsageRole>();
  const [creativeAngle, setCreativeAngle] = useState("");
  const [rightsConfirmed, setRightsConfirmed] = useState(false);
  const [acceptPartial, setAcceptPartial] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("正在恢复知乎分析任务与配置…");
  const [error, setError] = useState(false);
  const busyRef = useRef(false);
  const initializedRef = useRef(false);
  const restoredSnapshotIdRef = useRef<string | null | undefined>(undefined);
  const controllerRef = useRef<AbortController | undefined>(undefined);
  const failedSelectionValueRef = useRef<string | undefined>(undefined);
  const onSelectionSavedRef = useRef(onSelectionSaved);
  onSelectionSavedRef.current = onSelectionSaved;
  const selectionDirty = Boolean(
    summary?.snapshot &&
    usageRole &&
    (!summary.selection ||
      summary.selection.snapshotId !== summary.snapshot.id ||
      summary.selection.usageRole !== usageRole ||
      summary.selection.creativeAngle !== creativeAngle ||
      summary.selection.rightsConfirmed !==
        (usageRole === "content_source" && rightsConfirmed)),
  );

  const refresh = useCallback(async () => {
    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;
    try {
      const next = await projectApi.getZhihuAnalysis(
        projectId,
        videoId,
        controller.signal,
      );
      setSummary(next);
      const snapshotId = next.snapshot?.id ?? null;
      if (
        !initializedRef.current ||
        restoredSnapshotIdRef.current !== snapshotId
      ) {
        setDraft(next.snapshot?.config ?? { ...DEFAULT_ZHIHU_ANALYSIS_CONFIG });
        const selection =
          next.selection?.snapshotId === snapshotId ? next.selection : null;
        setUsageRole(selection?.usageRole);
        setCreativeAngle(selection?.creativeAngle ?? "");
        setRightsConfirmed(selection?.rightsConfirmed ?? false);
        setAcceptPartial(false);
        restoredSnapshotIdRef.current = snapshotId;
        initializedRef.current = true;
      }
      setLoaded(true);
      setError(false);
      setStatus(
        next.snapshot
          ? "知乎分析状态已恢复。"
          : "尚未绑定知乎回答。粘贴链接后可直接开始分析。",
      );
    } catch (cause) {
      if ((cause as Error).name === "AbortError") return;
      setLoaded(true);
      setError(true);
      setStatus(`知乎分析状态恢复失败：${(cause as Error).message}。`);
    }
  }, [projectId, videoId]);

  useEffect(() => {
    initializedRef.current = false;
    void refresh();
    return () => controllerRef.current?.abort();
  }, [refresh]);

  useEffect(() => {
    if (!summary?.job || !["queued", "running"].includes(summary.job.status))
      return;
    const timer = window.setInterval(() => {
      void refresh();
    }, 1_500);
    return () => window.clearInterval(timer);
  }, [refresh, summary?.job?.id, summary?.job?.status]);

  useEffect(() => {
    if (!selectionDirty) return;
    const handler = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [selectionDirty]);

  useEffect(() => {
    if (
      selectionSaveBlocked ||
      !canSaveZhihuSelection({
        busy,
        selectionDirty,
        acceptPartial,
        usageRole,
        rightsConfirmed,
        summary,
      })
    )
      return;
    const value = JSON.stringify({
      snapshotId: summary?.snapshot?.id,
      usageRole,
      creativeAngle,
      rightsConfirmed,
      acceptPartial,
    });
    if (failedSelectionValueRef.current === value) return;
    setStatus("使用方式将在停止修改后自动保存…");
    const timer = window.setTimeout(() => {
      void saveSelection();
    }, 700);
    return () => window.clearTimeout(timer);
  }, [
    acceptPartial,
    busy,
    creativeAngle,
    rightsConfirmed,
    selectionDirty,
    selectionSaveBlocked,
    summary,
    usageRole,
  ]);

  async function perform<T>(
    message: string,
    action: () => Promise<T>,
    success: string,
    applyResult?: (result: T) => void,
  ) {
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
      setStatus(
        interrupted
          ? "操作已中断，当前草稿和已完成证据仍然保留。"
          : `${success.replace(/已.*$/u, "")}失败：${(cause as Error).message}。`,
      );
      return false;
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }

  const start = () =>
    perform(
      "正在解析知乎链接…",
      () => projectApi.createZhihuAnalysisJob(projectId, videoId, draft),
      "知乎分析任务已创建，正在等待执行。",
    );
  const cancel = () =>
    summary?.job
      ? perform(
          "正在中断知乎分析…",
          () =>
            projectApi.cancelZhihuAnalysisJob(
              projectId,
              videoId,
              summary.job!.id,
            ),
          "分析中断请求已记录。已完成证据仍然保留。",
        )
      : Promise.resolve(false);
  async function saveSelection() {
    if (!summary?.snapshot || !usageRole || busyRef.current) return false;
    const submittedValue = JSON.stringify({
      snapshotId: summary.snapshot.id,
      usageRole,
      creativeAngle,
      rightsConfirmed,
      acceptPartial,
    });
    const saved = await perform(
      "正在自动保存知乎使用方式…",
      () =>
        projectApi.saveZhihuAnalysisSelection(projectId, videoId, {
          snapshotId: summary.snapshot!.id,
          usageRole,
          creativeAngle,
          rightsConfirmed: usageRole === "content_source" && rightsConfirmed,
          acceptedMissingDimensions: acceptPartial
            ? acceptedMissingDimensions(
                summary.snapshot!.availability,
                summary.snapshot!.evidence,
              )
            : [],
        }),
      "知乎使用方式已自动保存。当前文案与画面方案已按服务端规则失效。",
      (response) => {
        setSummary((current) =>
          current ? { ...current, selection: response.selection } : current,
        );
      },
    );
    failedSelectionValueRef.current = saved ? undefined : submittedValue;
    if (saved) onSelectionSavedRef.current?.();
    return saved;
  }

  return {
    summary,
    draft,
    setDraft,
    loaded,
    busy,
    status,
    error,
    usageRole,
    setUsageRole,
    creativeAngle,
    setCreativeAngle,
    rightsConfirmed,
    setRightsConfirmed,
    acceptPartial,
    setAcceptPartial,
    selectionDirty,
    start,
    cancel,
    saveSelection,
    refresh,
  };
}
