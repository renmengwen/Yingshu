import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

import { responseJson } from "../../client-logic";
import { isTerminalJobStatus } from "../../production-logic";
import type { JobRecord } from "../types";
import {
  exportJobType,
  exportReadinessUrl,
  exportWorkflowState,
  parseExportApiJob,
  parseExportReadiness,
  parseProjectPackageResult,
  projectPackageMatchesFinal,
  projectPackageUrl,
  selectReadinessJob,
  type ExportJob,
  type ExportJobType,
  type ExportReadiness,
  type ProjectPackageResult,
} from "./export-logic";

export interface ExportWorkspaceOptions {
  episodeId: string;
  timelineHash: string;
  initialJobId?: string;
  onJobIdChange?: (jobId: string | undefined) => void;
}

export function useExportWorkspace({ episodeId, timelineHash, initialJobId, onJobIdChange }: ExportWorkspaceOptions) {
  const identity = useMemo(() => ({ episodeId, timelineHash }), [episodeId, timelineHash]);
  const routeKey = `${episodeId}:${timelineHash}`;
  const routeRef = useRef(routeKey);
  const verifiedFinalRef = useRef<{ routeKey: string; episodeId: string; exportHash: string } | undefined>(undefined);
  const mountedRef = useRef(false);
  const onJobIdChangeRef = useRef(onJobIdChange);
  const [readiness, setReadiness] = useState<ExportReadiness>();
  const [job, setJob] = useState<ExportJob>();
  const [jobId, setJobId] = useState(initialJobId);
  const [loading, setLoading] = useState(true);
  const [actionBusy, setActionBusy] = useState(false);
  const [message, setMessage] = useState("正在复核生产就绪状态…");
  const [error, setError] = useState<string>();
  const [projectPackage, setProjectPackage] = useState<ProjectPackageResult>();
  const [packageStatus, setPackageStatus] = useState<"idle" | "loading" | "success" | "failure" | "interrupted">("idle");
  const [packageMessage, setPackageMessage] = useState("最终视频复核通过后可创建受控项目包。");

  useLayoutEffect(() => {
    mountedRef.current = true;
    routeRef.current = routeKey;
    return () => { mountedRef.current = false; };
  }, [routeKey]);

  useLayoutEffect(() => { onJobIdChangeRef.current = onJobIdChange; }, [onJobIdChange]);

  const current = useCallback((expected: string) => mountedRef.current && routeRef.current === expected, []);

  const refresh = useCallback(async (announce = true, terminalJob?: ExportJob, recoverJob = false) => {
    const expected = routeKey;
    if (announce && current(expected)) {
      setLoading(true);
      if (!terminalJob) {
        setMessage("正在复核生产就绪状态…");
        setError(undefined);
      }
    }
    try {
      const body = await responseJson<unknown>(await fetch(exportReadinessUrl(episodeId, timelineHash)));
      const next = parseExportReadiness(body, identity);
      if (!current(expected)) return;
      const nextFinalHash = next.finalExport?.verified ? next.finalExport.exportHash : undefined;
      if (verifiedFinalRef.current?.routeKey !== expected || verifiedFinalRef.current.exportHash !== nextFinalHash) {
        setProjectPackage(undefined);
        setPackageStatus("idle");
        setPackageMessage("最终视频复核通过后可创建受控项目包。");
      }
      verifiedFinalRef.current = nextFinalHash ? { routeKey: expected, episodeId, exportHash: nextFinalHash } : undefined;
      setReadiness(next);
      const recovered = recoverJob ? selectReadinessJob(next) : undefined;
      if (recoverJob) {
        setJob(recovered);
        setJobId(recovered?.id);
        onJobIdChangeRef.current?.(recovered?.id);
      }
      const operationJob = terminalJob ?? (recovered && isTerminalJobStatus(recovered.status) ? recovered : undefined);
      const operation = readinessOperationStatus(next, operationJob);
      setError(operation.error);
      setMessage(recovered && !isTerminalJobStatus(recovered.status)
        ? jobMessage(recovered, exportJobType(recovered, identity)!)
        : operation.message);
    } catch (caught) {
      if (!current(expected)) return;
      verifiedFinalRef.current = undefined;
      setProjectPackage(undefined);
      setPackageStatus("idle");
      setPackageMessage("最终视频复核通过后可创建受控项目包。");
      setReadiness(undefined);
      if (recoverJob) {
        setJob(undefined);
        setJobId(undefined);
        onJobIdChangeRef.current?.(undefined);
      }
      if (terminalJob) {
        setError(terminalJob.status === "failed" ? terminalJob.errorMessage ?? "任务失败" : undefined);
        setMessage(jobMessage(terminalJob, exportJobType(terminalJob, identity)!));
      } else {
        setError((caught as Error).message);
        setMessage(`生产就绪复核失败：${(caught as Error).message}`);
      }
    } finally {
      if (current(expected)) setLoading(false);
    }
  }, [current, episodeId, identity, routeKey, timelineHash]);

  useEffect(() => {
    setReadiness(undefined);
    setJob(undefined);
    setJobId(initialJobId);
    setActionBusy(false);
    setError(undefined);
    setProjectPackage(undefined);
    verifiedFinalRef.current = undefined;
    setPackageStatus("idle");
    setPackageMessage("最终视频复核通过后可创建受控项目包。");
    void refresh(true, undefined, !initialJobId);
  }, [initialJobId, refresh, routeKey]);

  useEffect(() => {
    if (!jobId) return;
    const expected = routeKey;
    let timer: number | undefined;
    let stopped = false;
    async function poll() {
      try {
        const body = await responseJson<unknown>(await fetch(`/api/jobs/${encodeURIComponent(jobId!)}`));
        if (stopped || !current(expected)) return;
        const nextJob = parseExportApiJob(body, identity);
        const kind = exportJobType(nextJob, identity)!;
        setJob(nextJob);
        setError(nextJob.status === "failed" ? nextJob.errorMessage ?? "任务失败" : undefined);
        setMessage(jobMessage(nextJob, kind));
        if (isTerminalJobStatus(nextJob.status)) await refresh(false, nextJob);
        else timer = window.setTimeout(poll, 3000);
      } catch (caught) {
        if (stopped || !current(expected)) return;
        await refresh(false, undefined, true);
      }
    }
    void poll();
    return () => {
      stopped = true;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [current, identity, jobId, refresh, routeKey]);

  async function start(type: ExportJobType) {
    if (actionBusy) return;
    const expected = routeKey;
    setActionBusy(true);
    setError(undefined);
    setMessage(type === "render_chunks" ? "正在创建分片渲染任务…" : "正在创建最终视频任务…");
    try {
      const body = await responseJson<{ job: JobRecord; message?: string }>(await fetch("/api/jobs", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ type, payload: identity }),
      }));
      if (!current(expected)) return;
      setJob(body.job);
      setJobId(body.job.id);
      onJobIdChangeRef.current?.(body.job.id);
      setMessage(body.message ?? "任务已创建");
    } catch (caught) {
      if (!current(expected)) return;
      setError((caught as Error).message);
      setMessage(`任务创建失败：${(caught as Error).message}`);
    } finally {
      if (current(expected)) setActionBusy(false);
    }
  }

  async function cancel() {
    if (actionBusy || !jobId) return;
    const expected = routeKey;
    setActionBusy(true);
    setError(undefined);
    setMessage("正在请求中断任务…");
    try {
      const body = await responseJson<{ job: JobRecord; message?: string }>(await fetch(`/api/jobs/${encodeURIComponent(jobId)}/cancel`, { method: "POST" }));
      if (!current(expected)) return;
      setJob(body.job);
      setMessage(body.message ?? "中断请求已记录");
    } catch (caught) {
      if (!current(expected)) return;
      setError((caught as Error).message);
      setMessage(`中断失败：${(caught as Error).message}`);
    } finally {
      if (current(expected)) setActionBusy(false);
    }
  }

  const workflow = exportWorkflowState(readiness, job, identity, loading || actionBusy);
  async function runPrimary() {
    if (workflow.action === "render") await start("render_chunks");
    else if (workflow.action === "finalize") await start("final_video");
    else if (workflow.action === "cancel") await cancel();
    else if (workflow.action === "retry") await start(exportJobType(job, identity)!);
    else if (workflow.action === "refresh") await refresh(true, terminalJobForRefresh(job, identity));
  }

  async function createServerProjectPackage() {
    const final = readiness?.finalExport;
    if (packageStatus === "loading" || readiness?.episodeId !== episodeId || readiness.timelineHash !== timelineHash || !final?.verified) return;
    const expected = routeKey;
    setPackageStatus("loading");
    setPackageMessage("正在服务端创建受控项目包…");
    try {
      const body = await responseJson<unknown>(await fetch(projectPackageUrl(episodeId, final.exportHash), { method: "POST" }));
      const result = parseProjectPackageResult(body, { episodeId, exportHash: final.exportHash });
      const currentFinal = verifiedFinalRef.current;
      if (!current(expected) || currentFinal?.routeKey !== expected ||
          !projectPackageMatchesFinal(result, currentFinal && { episodeId: currentFinal.episodeId, exportHash: currentFinal.exportHash })) return;
      setProjectPackage(result);
      setPackageStatus("success");
      setPackageMessage("项目包已在服务端受控目录创建。");
    } catch (caught) {
      const currentFinal = verifiedFinalRef.current;
      if (!current(expected) || currentFinal?.routeKey !== expected || currentFinal.exportHash !== final.exportHash) return;
      const interrupted = caught instanceof DOMException && caught.name === "AbortError";
      setPackageStatus(interrupted ? "interrupted" : "failure");
      setPackageMessage(interrupted ? "项目包创建已中断，可重新创建。" : `项目包创建失败：${(caught as Error).message}`);
    }
  }

  return {
    readiness, job, loading, actionBusy, message, error, workflow, refresh, runPrimary,
    projectPackage, packageStatus, packageMessage, createServerProjectPackage,
  };
}

function jobMessage(job: ExportJob, type: ExportJobType) {
  const subject = type === "render_chunks" ? "渲染分片" : "最终视频";
  if (job.status === "queued") return `${subject}任务已排队`;
  if (job.status === "running") return `${subject}正在处理（${Math.round(job.progress * 100)}%）`;
  if (job.status === "succeeded") return `${subject}任务成功，正在服务端复核…`;
  if (job.status === "failed") return `${subject}任务失败：${job.errorMessage ?? "未提供错误详情"}`;
  return `${subject}任务已中断`;
}

export function readinessOperationStatus(readiness: ExportReadiness, terminalJob?: ExportJob) {
  const kind = terminalJob && exportJobType(terminalJob, readiness);
  if (kind && (terminalJob.status === "failed" || terminalJob.status === "cancelled")) {
    return {
      message: jobMessage(terminalJob, kind),
      error: terminalJob.status === "failed" ? terminalJob.errorMessage ?? "任务失败" : undefined,
    };
  }
  return {
    message: readiness.productionReady
      ? readiness.finalExport?.verified ? "最终视频已完成服务端复核" : "生产就绪复核已通过"
      : `生产就绪复核未通过：${readiness.blockers.length} 项待处理`,
    error: undefined,
  };
}

export function terminalJobForRefresh(job: ExportJob | undefined, identity: { episodeId: string; timelineHash: string }) {
  return exportJobType(job, identity) && (job!.status === "failed" || job!.status === "cancelled") ? job : undefined;
}
