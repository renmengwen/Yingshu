import { useRef, useState } from "react";

import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "../components/ui/alert-dialog";
import { Button } from "../components/ui/button";
import { CreateForm } from "./CreateForm";
import { formatUpdatedAt, videoPath } from "./logic";
import { ProjectCreativeSettings } from "./ProjectCreativeSettings";
import { ProjectShell, StatusStrip } from "./ProjectShell";
import type { PageCommonProps, Video } from "./types";
import { useProject } from "./use-project-data";

export function ProjectPage(props: PageCommonProps & { projectId: string }) {
  const state = useProject(props.projectId);
  const [pendingDelete, setPendingDelete] = useState<Video>();
  const deleteButtonRef = useRef<HTMLButtonElement>(null);
  const failed = state.loaded && !state.project;

  return <ProjectShell {...props} title={state.project?.name ?? "正在打开项目"} description="管理本项目的草稿视频。">
    <StatusStrip message={state.status} busy={!state.loaded || state.busy} error={failed} />
    <div className="flex border-b border-[var(--border-subtle)] px-5 py-3 md:px-7"><button className="min-h-11 rounded border border-[var(--border-strong)] px-4 text-sm font-semibold hover:bg-[var(--bg-subtle)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus)]" type="button" onClick={() => props.navigate("/")}>返回首页</button></div>
    {state.project ? <ProjectCreativeSettings key={props.projectId} projectId={props.projectId} /> : null}
    {state.project ? <CreateForm kind="视频" busy={state.busy} onSubmit={state.createVideo} /> : null}
    <section className="p-5 md:p-7" aria-labelledby="videos-heading">
      <div className="flex items-center justify-between border-b border-[var(--border-subtle)] pb-3"><h2 id="videos-heading" className="text-base font-semibold">视频列表</h2><span className="font-mono text-xs text-[var(--fg-tertiary)]">{state.videos?.length ?? 0}</span></div>
      {!state.loaded ? <p className="py-10 text-sm text-[var(--fg-secondary)]" role="status">正在读取项目和视频…</p> : failed ? <div className="py-10"><p className="text-sm text-[var(--danger)]">无法打开该项目。它可能已被删除，或地址无效。</p><button className="mt-4 min-h-11 rounded border border-[var(--border-strong)] px-4 text-sm font-semibold" type="button" onClick={() => props.navigate("/")}>返回首页</button></div> : state.videos?.length ? <div className="divide-y divide-[var(--border-subtle)]">{state.videos.map((video) => <article className="flex flex-col gap-4 py-5 md:flex-row md:items-center md:justify-between" key={video.id}>
        <div className="min-w-0"><div className="flex flex-wrap items-center gap-2"><h3 className="truncate text-base font-semibold" title={video.title}>{video.title}</h3><span className="rounded border border-[var(--border-strong)] px-2 py-0.5 text-xs">草稿</span></div><p className="mt-2 font-mono text-xs text-[var(--fg-tertiary)]">{formatUpdatedAt(video.updatedAt)}</p></div>
        <div className="flex gap-2"><Button type="button" onClick={() => props.navigate(videoPath(props.projectId, video.id))}>打开工作区</Button><Button variant="outline" className="border-destructive text-destructive hover:bg-destructive/10 hover:text-destructive" type="button" disabled={state.busy} onClick={(event) => { deleteButtonRef.current = event.currentTarget; setPendingDelete(video); }}>删除</Button></div>
      </article>)}</div> : <p className="py-10 text-sm text-[var(--fg-secondary)]">还没有视频。创建草稿后即可进入工作区。</p>}
    </section>
    <AlertDialog open={!!pendingDelete} onOpenChange={(open) => { if (!open) setPendingDelete(undefined); }}><AlertDialogContent onCloseAutoFocus={(event) => {
      event.preventDefault();
      // 受控弹框没有 Trigger，关闭后把焦点归还实际触发按钮。
      if (deleteButtonRef.current?.isConnected) deleteButtonRef.current.focus();
    }}><AlertDialogHeader><AlertDialogTitle>永久删除这个视频？</AlertDialogTitle><AlertDialogDescription>删除后无法恢复视频“{pendingDelete?.title}”的创作输入、旁白与画面方案、图片、配音、时间轴、渲染文件和最终成片。</AlertDialogDescription></AlertDialogHeader><AlertDialogFooter><AlertDialogCancel>取消</AlertDialogCancel><AlertDialogAction disabled={state.busy} onClick={() => { const video = pendingDelete; setPendingDelete(undefined); if (video) void state.removeVideo(video).catch(() => undefined); }}>永久删除全部内容</AlertDialogAction></AlertDialogFooter></AlertDialogContent></AlertDialog>
  </ProjectShell>;
}
