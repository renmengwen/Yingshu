import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger } from "../components/ui/alert-dialog";
import { buttonVariants } from "../components/ui/button";
import { imageBatchSummary, imageWorkspaceCounts, isActiveImageBatch } from "./image-logic";
import { useVideoImages } from "./use-video-images";
import { VisualImageReviewRow } from "./VisualImageReviewRow";

const primaryButton = buttonVariants({ variant: "default" });
const secondaryButton = buttonVariants({ variant: "outline" });

export function VideoImageStage({ projectId, videoId }: { projectId: string; videoId: string }) {
  const state = useVideoImages(projectId, videoId);
  const workspace = state.workspace;
  if (!state.loaded) return <section className="p-6 text-sm text-[var(--fg-secondary)]" aria-live="polite">正在恢复图片候选与审核状态…</section>;
  if (!workspace) return <section className="p-6" role="alert"><h2 className="text-lg font-semibold">无法恢复配图工作区</h2><p className="mt-2 text-sm leading-6 text-[var(--fg-secondary)]">{state.status}</p><button className={`${secondaryButton} mt-5`} type="button" onClick={() => void state.refresh()}>重新加载</button></section>;

  const counts = imageWorkspaceCounts(workspace);
  const batchActive = isActiveImageBatch(workspace.batch);
  const busy = state.busyAction !== null;
  const hasFailures = Boolean(workspace.batch && workspace.batch.counts.failed > 0);
  const providerLabel = workspace.provider ? `${workspace.provider.name || workspace.provider.id} / ${workspace.provider.model}` : "未配置";

  return <section className="min-w-0" aria-labelledby="image-stage-heading">
    <header className="border-b border-[var(--border-subtle)] bg-[var(--bg-subtle)] px-5 py-5 md:px-7">
      <div className="flex flex-col gap-5 xl:flex-row xl:items-start xl:justify-between">
        <div className="min-w-0"><p className="font-mono text-[11px] font-semibold tracking-[.14em] text-[var(--accent)]">MVP 第三阶段</p><h2 id="image-stage-heading" className="mt-2 text-xl font-semibold">配图候选与人工审核</h2><p className="mt-2 max-w-3xl text-sm leading-6 text-[var(--fg-secondary)]">批量操作只生成缺少当前候选的正式画面。候选不会自动批准，图片审核完成后也不会启动 TTS、字幕或渲染。</p></div>
        <div className="flex flex-wrap gap-2">
          {hasFailures && !batchActive ? <button className={secondaryButton} type="button" disabled={!workspace.productionAllowed || busy} onClick={() => void state.startBatch("retry_failed")}>{state.busyAction === "batch" ? "正在创建重试批次…" : "只重试失败项"}</button> : null}
          {batchActive && workspace.batch ? <button className={secondaryButton} type="button" disabled={busy} onClick={() => void state.cancelBatch()}>{state.busyAction === "cancel" ? "正在中断…" : "中断批次"}</button> : null}
          <AlertDialog>
            <AlertDialogTrigger className={primaryButton} disabled={!workspace.productionAllowed || busy || batchActive || counts.missing === 0}>生成全部缺失配图</AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader><AlertDialogTitle>确认生成全部缺失配图</AlertDialogTitle><AlertDialogDescription asChild><div className="space-y-3"><p>此操作会创建可能计费的持久任务，只有明确确认后才会调用图片供应商。</p><dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-[var(--fg-primary)]"><dt>正式画面</dt><dd>{counts.total}</dd><dt>已有当前候选</dt><dd>{counts.candidates}</dd><dt>已覆盖画面</dt><dd>{counts.covered}</dd><dt>本次目标 / 预计请求</dt><dd>{counts.missing}</dd><dt>供应商 / 模型</dt><dd>{providerLabel}</dd><dt>每画面候选</dt><dd>{workspace.summary.plannedPerVisual}</dd><dt>预计费用</dt><dd>{workspace.feeEstimate ?? "费用未知"}</dd></dl></div></AlertDialogDescription></AlertDialogHeader>
              <AlertDialogFooter><AlertDialogCancel>返回检查</AlertDialogCancel><AlertDialogAction className={primaryButton} onClick={() => void state.startBatch("missing")}>确认生成</AlertDialogAction></AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </div>
      </div>
      <div className="mt-5 grid gap-3 border-t border-[var(--border-subtle)] pt-4 sm:grid-cols-2 xl:grid-cols-4">
        <p className="text-sm"><span className="text-[var(--fg-secondary)]">图片审核：</span><strong>{workspace.gate.status === "complete" ? "已完成" : `${workspace.gate.approvedCount}/${workspace.gate.total} 已批准`}</strong></p>
        <p className="text-sm"><span className="text-[var(--fg-secondary)]">候选覆盖：</span><strong>{counts.covered}/{counts.total}</strong></p>
        <p className="truncate text-sm" title={providerLabel}><span className="text-[var(--fg-secondary)]">供应商：</span><strong>{providerLabel}</strong></p>
        <p className="text-sm"><span className="text-[var(--fg-secondary)]">Gate 修订：</span><strong className="font-mono">{workspace.gate.revision}</strong></p>
      </div>
      <div className="mt-4 min-h-11 border border-[var(--border-subtle)] bg-[var(--bg-surface)] px-4 py-3 text-sm leading-6" aria-live="polite" role={state.actionState === "error" ? "alert" : "status"}>
        <p>{state.status}</p>
        {workspace.blockedReason ? <p className="mt-1 font-semibold text-[var(--status-warning)]">当前阻断：{workspace.blockedReason}</p> : null}
        {workspace.batch ? <p className="mt-1 text-[var(--fg-secondary)]">{imageBatchSummary(workspace.batch)}{workspace.batch.status === "cancelled" ? " 已完成的候选仍保留。" : ""}</p> : null}
      </div>
    </header>
    <div className="min-w-0 px-0 md:px-7">{workspace.visuals.map((visual) => <VisualImageReviewRow key={visual.id} visual={visual} productionAllowed={workspace.productionAllowed} busyAction={state.busyAction} onGenerate={(regenerate) => void state.generate(visual.id, regenerate)} onUpload={(file) => void state.upload(visual.id, file)} onApprove={(candidateId) => void state.approve(visual.id, candidateId)} />)}</div>
    {workspace.visuals.length === 0 ? <p className="p-6 text-sm text-[var(--fg-secondary)]">当前方案没有正式画面，无法生产图片候选。</p> : null}
  </section>;
}
