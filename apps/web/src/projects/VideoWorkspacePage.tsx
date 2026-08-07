import { useEffect, useState } from "react";

import { formatUpdatedAt, projectPath } from "./logic";
import { StatusStrip } from "./ProjectShell";
import { useVideo } from "./use-project-data";
import { VideoInputStage } from "./VideoInputStage";
import { VideoStageNavigation } from "./VideoStageNavigation";
import { VideoPlanReviewStage } from "./VideoPlanReviewStage";
import { VideoImageStage } from "./VideoImageStage";
import { VideoAudioStage } from "./VideoAudioStage";
import { VideoExportStage } from "./VideoExportStage";
import { VideoVisualTimelineStage } from "./VideoVisualTimelineStage";
import { useVideoPlan } from "./use-video-plan";

export function VideoWorkspacePage({ projectId, videoId, navigate, onOpenSettings }: {
  projectId: string;
  videoId: string;
  navigate: (path: string) => void;
  onOpenSettings: () => void;
}) {
  const state = useVideo(projectId, videoId);
  const planState = useVideoPlan(projectId, videoId);
  const [activeStage, setActiveStage] = useState<0 | 1 | 2 | 3 | 4 | 5>(0);
  const failed = state.loaded && !state.video;
  const planAvailable = Boolean(planState.plan || planState.job || planState.videoStatus !== "draft");
  const imageAvailable = Boolean(planState.plan?.approval?.valid && !planState.plan.stale);
  const statusLabel = ({
    draft: "草稿", preparing_sources: "准备资料", generating_script: "生成旁白",
    planning_visuals: "规划画面", awaiting_review: "等待审核", producing_media: "生产媒体",
    awaiting_media_review: "等待媒体审核", rendering: "正在渲染", completed: "已完成",
    failed: "生成失败", cancelled: "已中断",
  } as const)[planState.videoStatus];

  useEffect(() => {
    if (planState.plan || planState.job && planState.job.status !== "failed") {
      setActiveStage((current) => current === 0 ? 1 : current);
    }
  }, [planState.plan, planState.job]);

  return <main className="min-h-screen bg-[var(--bg-canvas)] p-4 text-[var(--fg-primary)] md:p-7">
    <div className="mx-auto min-h-[calc(100vh-56px)] w-full max-w-[1440px] border border-[var(--border-subtle)] bg-[var(--bg-surface)]">
      <header className="flex flex-col gap-5 border-b border-[var(--border-subtle)] px-5 py-5 md:flex-row md:items-end md:justify-between md:px-7">
        <div className="min-w-0"><p className="font-mono text-[11px] font-semibold tracking-[.17em] text-[var(--accent)]">映述 / 视频工作区</p><div className="mt-3 flex flex-wrap items-center gap-3"><h1 className="truncate text-2xl font-semibold" title={state.video?.title}>{state.video?.title ?? "正在恢复草稿"}</h1>{state.video ? <span className="rounded border border-[var(--border-strong)] px-2 py-0.5 text-xs">{statusLabel}</span> : null}</div><p className="mt-2 text-sm text-[var(--fg-secondary)]">{state.project?.name ?? "正在读取所属项目"}{state.video ? ` · ${formatUpdatedAt(state.video.updatedAt)}` : ""}</p></div>
        <div className="flex flex-wrap gap-2"><button className="min-h-11 rounded border border-[var(--border-strong)] px-4 text-sm font-semibold hover:bg-[var(--bg-subtle)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus)]" type="button" onClick={() => navigate(projectPath(projectId))}>返回项目</button><button className="min-h-11 rounded border border-[var(--border-strong)] px-4 text-sm font-semibold hover:bg-[var(--bg-subtle)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus)]" type="button" onClick={onOpenSettings}>设置</button></div>
      </header>
      <StatusStrip message={state.status} busy={!state.loaded} error={failed} />
      {state.video ? <><VideoStageNavigation activeStage={activeStage} planAvailable={planAvailable} imageAvailable={imageAvailable} audioAvailable={imageAvailable} visualAvailable={imageAvailable} exportAvailable={imageAvailable} onSelect={setActiveStage} />{activeStage === 0 ? <VideoInputStage key={`${projectId}:${videoId}`} projectId={projectId} videoId={videoId} planState={planState} onPlanStarted={() => setActiveStage(1)} /> : activeStage === 1 ? <VideoPlanReviewStage state={planState} onApproved={() => setActiveStage(2)} /> : activeStage === 2 ? <VideoImageStage projectId={projectId} videoId={videoId} /> : activeStage === 3 ? <VideoAudioStage projectId={projectId} videoId={videoId} onReturnToScript={() => setActiveStage(1)} /> : activeStage === 4 ? <VideoVisualTimelineStage projectId={projectId} videoId={videoId} /> : <VideoExportStage projectId={projectId} videoId={videoId} />}</> : state.loaded ? <section className="p-6" role="alert"><h2 className="text-lg font-semibold">无法恢复视频工作区</h2><p className="mt-3 text-sm leading-7 text-[var(--fg-secondary)]">该项目或视频不存在，也可能不属于当前项目。请返回项目重新选择。</p><button className="mt-5 min-h-11 rounded bg-[var(--accent)] px-4 text-sm font-semibold text-[var(--accent-contrast)]" type="button" onClick={() => navigate(projectPath(projectId))}>返回项目</button></section> : <p className="p-6 text-sm text-[var(--fg-secondary)]" role="status">正在从后端恢复项目和草稿视频…</p>}
    </div>
  </main>;
}
