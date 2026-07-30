import { CreateForm } from "./CreateForm";
import { formatUpdatedAt, videoPath } from "./logic";
import { ProjectShell, StatusStrip } from "./ProjectShell";
import type { PageCommonProps } from "./types";
import { useProject } from "./use-project-data";

export function ProjectPage(props: PageCommonProps & { projectId: string }) {
  const state = useProject(props.projectId);
  const failed = state.loaded && !state.project;

  return <ProjectShell {...props} title={state.project?.name ?? "正在打开项目"} description="管理本项目的草稿视频。">
    <StatusStrip message={state.status} busy={!state.loaded || state.busy} error={failed} />
    <div className="flex border-b border-[var(--border-subtle)] px-5 py-3 md:px-7"><button className="min-h-11 rounded border border-[var(--border-strong)] px-4 text-sm font-semibold hover:bg-[var(--bg-subtle)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus)]" type="button" onClick={() => props.navigate("/")}>返回首页</button></div>
    {state.project ? <CreateForm kind="视频" busy={state.busy} onSubmit={state.createVideo} /> : null}
    <section className="p-5 md:p-7" aria-labelledby="videos-heading">
      <div className="flex items-center justify-between border-b border-[var(--border-subtle)] pb-3"><h2 id="videos-heading" className="text-base font-semibold">视频列表</h2><span className="font-mono text-xs text-[var(--fg-tertiary)]">{state.videos?.length ?? 0}</span></div>
      {!state.loaded ? <p className="py-10 text-sm text-[var(--fg-secondary)]" role="status">正在读取项目和视频…</p> : failed ? <div className="py-10"><p className="text-sm text-[var(--danger)]">无法打开该项目。它可能已被删除，或地址无效。</p><button className="mt-4 min-h-11 rounded border border-[var(--border-strong)] px-4 text-sm font-semibold" type="button" onClick={() => props.navigate("/")}>返回首页</button></div> : state.videos?.length ? <div className="divide-y divide-[var(--border-subtle)]">{state.videos.map((video) => <article className="flex flex-col gap-4 py-5 md:flex-row md:items-center md:justify-between" key={video.id}>
        <div className="min-w-0"><div className="flex flex-wrap items-center gap-2"><h3 className="truncate text-base font-semibold" title={video.title}>{video.title}</h3><span className="rounded border border-[var(--border-strong)] px-2 py-0.5 text-xs">草稿</span></div><p className="mt-2 font-mono text-xs text-[var(--fg-tertiary)]">{formatUpdatedAt(video.updatedAt)}</p></div>
        <button className="min-h-11 rounded bg-[var(--accent)] px-4 text-sm font-semibold text-[var(--accent-contrast)] hover:bg-[var(--accent-strong)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus)]" type="button" onClick={() => props.navigate(videoPath(props.projectId, video.id))}>打开工作区</button>
      </article>)}</div> : <p className="py-10 text-sm text-[var(--fg-secondary)]">还没有视频。创建草稿后即可进入工作区。</p>}
    </section>
  </ProjectShell>;
}
