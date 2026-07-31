import { useCallback, useEffect, useRef, useState } from "react";

import { activeModelLabel, loadModelConfig } from "../settings/model-settings";
import { projectApi } from "./api";
import { canCancelPlanJob, type PlanActionState } from "./plan-logic";
import type { Video, VideoPlan, VideoPlanJob, VideoPlanSource, VideoScriptParagraph, VideoVisualDraft } from "./types";

export function useVideoPlan(projectId: string, videoId: string) {
  const [plan, setPlan] = useState<VideoPlan | null>(null);
  const [sources, setSources] = useState<VideoPlanSource[]>([]);
  const [job, setJob] = useState<VideoPlanJob | null>(null);
  const [videoStatus, setVideoStatus] = useState<Video["status"]>("draft");
  const [webEnabled, setWebEnabled] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [modelLabel, setModelLabel] = useState("正在读取文本模型…");
  const [modelAvailable, setModelAvailable] = useState(false);
  const [actionState, setActionState] = useState<PlanActionState>("loading");
  const [status, setStatus] = useState("正在恢复方案与任务…");
  const busyRef = useRef(false);

  const refresh = useCallback(async (silent = false) => {
    if (!silent) {
      setActionState("loading");
      setStatus("正在恢复方案、来源与任务…");
    }
    try {
      const [planBody, sourceBody, jobBody] = await Promise.all([
        projectApi.getPlan(projectId, videoId),
        projectApi.getPlanSources(projectId, videoId),
        projectApi.getPlanJob(projectId, videoId),
      ]);
      setPlan(planBody.plan);
      setSources(sourceBody.items);
      setWebEnabled(sourceBody.webEnabled);
      setJob(jobBody.job);
      setVideoStatus(jobBody.videoStatus);
      setLoaded(true);
      setActionState(jobBody.job?.status === "cancelled" ? "interrupted" : jobBody.job?.status === "failed" ? "error" : "success");
      setStatus(planBody.plan ? "方案已恢复，可继续审核。" : jobBody.job ? "方案任务状态已更新。" : "尚未生成方案。保存输入后可创建任务。");
    } catch (cause) {
      setLoaded(true);
      setActionState("error");
      setStatus(`方案恢复失败：${(cause as Error).message}。请稍后重试。`);
    }
  }, [projectId, videoId]);

  useEffect(() => { void refresh(); }, [refresh]);

  useEffect(() => {
    let active = true;
    loadModelConfig().then((config) => {
      if (!active) return;
      const label = activeModelLabel(config, "text");
      const [providerId] = (config.active.text || "").split("/");
      const provider = providerId ? config.providers[providerId] : undefined;
      setModelLabel(label);
      setModelAvailable(label !== "未配置" && Boolean(provider?.baseUrl && provider.hasApiKey));
    }).catch(() => {
      if (!active) return;
      setModelLabel("文本模型配置读取失败");
      setModelAvailable(false);
    });
    return () => { active = false; };
  }, []);

  useEffect(() => {
    if (!canCancelPlanJob(job)) return;
    const timer = window.setInterval(() => void refresh(true), 1500);
    return () => window.clearInterval(timer);
  }, [job, refresh]);

  async function perform(message: string, operation: () => Promise<{ message?: string; plan?: VideoPlan; [key: string]: unknown }>) {
    if (busyRef.current) return;
    busyRef.current = true;
    setActionState("loading");
    setStatus(message);
    try {
      const result = await operation();
      if (result.plan) setPlan(result.plan);
      await refresh(true);
      setActionState("success");
      setStatus(result.message || "操作已完成。");
    } catch (cause) {
      const interrupted = cause instanceof DOMException && cause.name === "AbortError";
      setActionState(interrupted ? "interrupted" : "error");
      setStatus(interrupted ? "操作已中断，未保存的编辑仍保留在页面中。" : `${(cause as Error).message}。请修正后重试。`);
    } finally {
      busyRef.current = false;
    }
  }

  const start = () => perform("正在创建方案任务并冻结本次生成输入…", async () => {
    const body = await projectApi.createPlanJob(projectId, videoId, crypto.randomUUID());
    setJob({ ...body.job, errorMessage: null });
    setVideoStatus(body.videoStatus);
    return body;
  });
  const cancel = () => perform("正在中断方案任务…", () => projectApi.cancelPlanJob(projectId, videoId));
  const saveScript = (title: string, summary: string, paragraphs: VideoScriptParagraph[]) => {
    if (!plan) return Promise.resolve();
    return perform("正在保存旁白修订…", () => projectApi.saveScriptRevision(projectId, videoId, {
      snapshotId: plan.snapshotId, baseRevision: plan.script.revision, title, summary, paragraphs,
    }));
  };
  const saveVisuals = (visuals: VideoVisualDraft[]) => {
    if (!plan) return Promise.resolve();
    return perform("正在保存画面方案修订…", () => projectApi.saveVisualRevision(projectId, videoId, {
      snapshotId: plan.snapshotId, baseRevision: plan.visual.revision, scriptRevisionId: plan.script.id, visuals,
    }));
  };
  const approve = () => {
    if (!plan) return Promise.resolve();
    return perform("正在批准当前旁白与画面方案…", () => projectApi.approvePlan(projectId, videoId, {
      snapshotId: plan.snapshotId, scriptRevisionId: plan.script.id, visualRevisionId: plan.visual.id,
    }));
  };

  return {
    plan, sources, job, videoStatus, webEnabled, loaded, modelLabel, modelAvailable,
    actionState, status, busy: busyRef.current || actionState === "loading", refresh, start, cancel,
    saveScript, saveVisuals, approve,
  };
}
