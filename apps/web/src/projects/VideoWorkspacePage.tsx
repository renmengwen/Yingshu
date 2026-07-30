import { formatUpdatedAt, projectPath } from "./logic";
import { StatusStrip } from "./ProjectShell";
import { useVideo } from "./use-project-data";
import { VideoStageNavigation } from "./VideoStageNavigation";

export function VideoWorkspacePage({ projectId, videoId, navigate, onOpenSettings }: {
  projectId: string;
  videoId: string;
  navigate: (path: string) => void;
  onOpenSettings: () => void;
}) {
  const state = useVideo(projectId, videoId);
  const failed = state.loaded && !state.video;

  return <main className="min-h-screen bg-[var(--bg-canvas)] p-4 text-[var(--fg-primary)] md:p-7">
    <div className="mx-auto min-h-[calc(100vh-56px)] w-full max-w-[1440px] border border-[var(--border-subtle)] bg-[var(--bg-surface)]">
      <header className="flex flex-col gap-5 border-b border-[var(--border-subtle)] px-5 py-5 md:flex-row md:items-end md:justify-between md:px-7">
        <div className="min-w-0"><p className="font-mono text-[11px] font-semibold tracking-[.17em] text-[var(--accent)]">映述 / 视频工作区</p><div className="mt-3 flex flex-wrap items-center gap-3"><h1 className="truncate text-2xl font-semibold" title={state.video?.title}>{state.video?.title ?? "正在恢复草稿"}</h1>{state.video ? <span className="rounded border border-[var(--border-strong)] px-2 py-0.5 text-xs">草稿</span> : null}</div><p className="mt-2 text-sm text-[var(--fg-secondary)]">{state.project?.name ?? "正在读取所属项目"}{state.video ? ` · ${formatUpdatedAt(state.video.updatedAt)}` : ""}</p></div>
        <div className="flex flex-wrap gap-2"><button className="min-h-11 rounded border border-[var(--border-strong)] px-4 text-sm font-semibold hover:bg-[var(--bg-subtle)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus)]" type="button" onClick={() => navigate(projectPath(projectId))}>返回项目</button><button className="min-h-11 rounded border border-[var(--border-strong)] px-4 text-sm font-semibold hover:bg-[var(--bg-subtle)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus)]" type="button" onClick={onOpenSettings}>设置</button></div>
      </header>
      <StatusStrip message={state.status} busy={!state.loaded} error={failed} />
      {state.video ? <><VideoStageNavigation /><section className="p-5 md:p-8" aria-labelledby="input-stage-heading"><div className="max-w-3xl border border-[var(--border-subtle)] bg-[var(--bg-subtle)] p-5 md:p-6"><p className="font-mono text-[11px] text-[var(--accent)]">阶段 01</p><h2 id="input-stage-heading" className="mt-2 text-xl font-semibold">输入与来源</h2><p className="mt-3 text-sm leading-7 text-[var(--fg-secondary)]">下一步：填写视频内容。</p><p className="mt-2 text-sm leading-7 text-[var(--fg-tertiary)]">本阶段只建立可恢复的草稿工作区，内容输入将在下一阶段接入。</p></div></section></> : state.loaded ? <section className="p-6" role="alert"><h2 className="text-lg font-semibold">无法恢复视频工作区</h2><p className="mt-3 text-sm leading-7 text-[var(--fg-secondary)]">该项目或视频不存在，也可能不属于当前项目。请返回项目重新选择。</p><button className="mt-5 min-h-11 rounded bg-[var(--accent)] px-4 text-sm font-semibold text-[var(--accent-contrast)]" type="button" onClick={() => navigate(projectPath(projectId))}>返回项目</button></section> : <p className="p-6 text-sm text-[var(--fg-secondary)]" role="status">正在从后端恢复项目和草稿视频…</p>}
    </div>
  </main>;
}
