import { useRef, useState } from "react";

import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "../components/ui/alert-dialog";
import { CreateForm } from "./CreateForm";
import { formatUpdatedAt, projectPath } from "./logic";
import { ProjectShell, StatusStrip } from "./ProjectShell";
import type { PageCommonProps, ProjectSummary } from "./types";
import { useProjects } from "./use-project-data";

export function ProjectHomePage(props: PageCommonProps) {
  const state = useProjects();
  const [pendingDelete, setPendingDelete] = useState<ProjectSummary>();
  const deleteButtonRef = useRef<HTMLButtonElement>(null);
  const failed = state.loaded && !state.items;

  return <ProjectShell {...props} title="视频项目" description="创建独立项目，在项目内管理草稿视频。">
    <StatusStrip message={state.status} busy={!state.loaded || state.busy} error={failed} />
    <CreateForm kind="项目" busy={state.busy} onSubmit={state.create} />
    <section className="p-5 md:p-7" aria-labelledby="projects-heading">
      <div className="flex items-center justify-between border-b border-[var(--border-subtle)] pb-3"><h2 id="projects-heading" className="text-base font-semibold">项目列表</h2><span className="font-mono text-xs text-[var(--fg-tertiary)]">{state.items?.length ?? 0}</span></div>
      {!state.loaded ? <p className="py-10 text-sm text-[var(--fg-secondary)]" role="status">正在读取项目数据…</p> : failed ? <p className="py-10 text-sm text-[var(--danger)]">项目暂时无法显示。请刷新页面重试。</p> : state.items?.length ? <div className="divide-y divide-[var(--border-subtle)]">{state.items.map((project) => <article className="flex flex-col gap-4 py-5 md:flex-row md:items-center md:justify-between" key={project.id}>
        <div className="min-w-0"><h3 className="truncate text-base font-semibold" title={project.name}>{project.name}</h3><p className="mt-2 font-mono text-xs text-[var(--fg-tertiary)]">{project.videoCount}个视频 · {formatUpdatedAt(project.updatedAt)}</p></div>
        <div className="flex gap-2"><button className="min-h-11 rounded border border-[var(--border-strong)] px-4 text-sm font-semibold hover:bg-[var(--bg-subtle)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus)]" type="button" onClick={() => props.navigate(projectPath(project.id))}>打开项目</button><button className="min-h-11 rounded border border-[var(--danger)] px-4 text-sm font-semibold text-[var(--danger)] hover:bg-[var(--danger-soft)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus)] disabled:opacity-50" type="button" disabled={state.busy} onClick={(event) => { deleteButtonRef.current = event.currentTarget; setPendingDelete(project); }}>删除</button></div>
      </article>)}</div> : <p className="py-10 text-sm text-[var(--fg-secondary)]">还没有项目。填写名称后创建第一个项目。</p>}
    </section>
    <AlertDialog open={!!pendingDelete} onOpenChange={(open) => { if (!open) setPendingDelete(undefined); }}><AlertDialogContent onCloseAutoFocus={(event) => {
      event.preventDefault();
      // 受控弹框没有 Trigger，关闭时必须把焦点显式归还实际触发按钮。
      if (deleteButtonRef.current?.isConnected) deleteButtonRef.current.focus();
    }}><AlertDialogHeader><AlertDialogTitle>永久删除这个项目？</AlertDialogTitle><AlertDialogDescription>删除后无法恢复项目“{pendingDelete?.name}”及其中全部草稿视频。</AlertDialogDescription></AlertDialogHeader><AlertDialogFooter><AlertDialogCancel>取消</AlertDialogCancel><AlertDialogAction disabled={state.busy} onClick={() => { const project = pendingDelete; setPendingDelete(undefined); if (project) void state.remove(project).catch(() => undefined); }}>永久删除项目</AlertDialogAction></AlertDialogFooter></AlertDialogContent></AlertDialog>
  </ProjectShell>;
}
