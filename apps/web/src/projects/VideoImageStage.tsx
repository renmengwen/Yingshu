import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger } from "../components/ui/alert-dialog";
import { buttonVariants } from "../components/ui/button";
import { imageBatchSummary, imageWorkspaceCounts, isActiveImageBatch } from "./image-logic";
import { useVideoImages } from "./use-video-images";
import { VideoImageReviewList } from "./VideoImageReviewList";

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
  const failedVisuals = workspace.visuals.filter((visual) => visual.generationState?.status === "failed").length;
  const approvedVisuals = workspace.visuals.filter((visual) => visual.candidates.some((candidate) => candidate.currentCompatible && candidate.approved)).length;
  const providerLabel = workspace.provider ? `${workspace.provider.name || workspace.provider.id} / ${workspace.provider.model}` : "未配置";
  const generateDisabledReason = !workspace.productionAllowed ? workspace.blockedReason ?? "当前生产门禁未通过。" : busy ? "当前操作尚未完成，请稍候。" : batchActive ? "当前批次尚未结束。" : counts.missing === 0 ? "所有正式画面都已有当前候选。" : null;

  return <section className="min-w-0 pb-[22rem] sm:pb-52 lg:pb-36" aria-labelledby="image-stage-heading">
    <header className="border-b border-[var(--border-subtle)] bg-[var(--bg-subtle)] px-5 py-5 md:px-7">
      <div className="min-w-0"><p className="font-mono text-[11px] font-semibold tracking-[.14em] text-[var(--accent)]">MVP 第三阶段</p><h2 id="image-stage-heading" className="mt-2 text-xl font-semibold">配图候选与人工审核</h2><p className="mt-2 max-w-3xl text-sm leading-6 text-[var(--fg-secondary)]">批量操作只生成缺少当前候选的正式画面。候选不会自动批准，图片审核完成后也不会启动 TTS、字幕或渲染。</p><p className="mt-2 truncate text-sm text-[var(--fg-secondary)]" title={providerLabel}>供应商：<strong className="text-[var(--fg-primary)]">{providerLabel}</strong></p></div>
      <div className="mt-4 min-h-11 border border-[var(--border-subtle)] bg-[var(--bg-surface)] px-4 py-3 text-sm leading-6" aria-live="polite" role={state.actionState === "error" ? "alert" : "status"}>
        <p>{state.status}</p>
        {workspace.blockedReason ? <p className="mt-1 font-semibold text-[var(--status-warning)]">当前阻断：{workspace.blockedReason}</p> : null}
        {generateDisabledReason ? <p className="mt-1 text-[var(--fg-secondary)]">生成全部缺失当前不可用：{generateDisabledReason}</p> : null}
        {workspace.batch ? <p className="mt-1 text-[var(--fg-secondary)]">{imageBatchSummary(workspace.batch)}{workspace.batch.status === "cancelled" ? " 已完成的候选仍保留。" : ""}</p> : null}
      </div>
    </header>
    <VideoImageReviewList visuals={workspace.visuals} productionAllowed={workspace.productionAllowed} busyAction={state.busyAction} onGenerate={(visualId, regenerate) => void state.generate(visualId, regenerate)} onUpload={(visualId, file) => void state.upload(visualId, file)} onApprove={(visualId, candidateId) => void state.approve(visualId, candidateId)} />
    {workspace.visuals.length === 0 ? <p className="p-6 text-sm text-[var(--fg-secondary)]">当前方案没有正式画面，无法生产图片候选。</p> : null}
    <aside className="fixed inset-x-0 bottom-0 z-40 mx-auto w-full max-w-[1440px] border border-[var(--border-strong)] bg-[var(--surface-raised)] p-3 shadow-[var(--shadow-popover)] sm:bottom-3 sm:w-[calc(100%-2rem)] sm:rounded-lg sm:p-4" aria-label="配图批量操作">
      <div className="flex min-w-0 flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
        <div className="min-w-0 space-y-2">
          <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs"><span>总画面 <strong>{counts.total}</strong></span><span>已有候选 <strong>{counts.candidates}</strong></span><span>待生成 <strong>{counts.missing}</strong></span><span>失败 <strong>{failedVisuals}</strong></span><span>已批准 <strong>{approvedVisuals}</strong></span></div>
          <p className="text-xs leading-5 text-[var(--fg-secondary)]">{generateDisabledReason ? `生成全部缺失当前不可用：${generateDisabledReason}` : "批量生成只补齐缺失画面，候选仍需逐画面人工批准。"}</p>
        </div>
        <div className="grid shrink-0 gap-2 sm:grid-cols-3">
          {hasFailures && !batchActive ? <AlertDialog><AlertDialogTrigger className={secondaryButton} disabled={!workspace.productionAllowed || busy}>只重试失败项</AlertDialogTrigger><AlertDialogContent><AlertDialogHeader><AlertDialogTitle>确认重试失败画面</AlertDialogTitle><AlertDialogDescription>此操作会为失败画面创建可能计费的持久任务。已有候选会保留，新候选不会自动批准。</AlertDialogDescription></AlertDialogHeader><AlertDialogFooter><AlertDialogCancel>返回检查</AlertDialogCancel><AlertDialogAction onClick={() => void state.startBatch("retry_failed")}>确认重试</AlertDialogAction></AlertDialogFooter></AlertDialogContent></AlertDialog> : <span aria-hidden="true" />}
          {batchActive && workspace.batch ? <button className={secondaryButton} type="button" disabled={busy} onClick={() => void state.cancelBatch()}>{state.busyAction === "cancel" ? "正在中断…" : "中断批次"}</button> : <span aria-hidden="true" />}
          <AlertDialog><AlertDialogTrigger className={primaryButton} disabled={!workspace.productionAllowed || busy || batchActive || counts.missing === 0}>生成全部缺失配图</AlertDialogTrigger><AlertDialogContent><AlertDialogHeader><AlertDialogTitle>确认生成全部缺失配图</AlertDialogTitle><AlertDialogDescription asChild><div className="space-y-3"><p>此操作会创建可能计费的持久任务，只有明确确认后才会调用图片供应商。</p><dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-[var(--fg-primary)]"><dt>正式画面</dt><dd>{counts.total}</dd><dt>已有当前候选</dt><dd>{counts.candidates}</dd><dt>已覆盖画面</dt><dd>{counts.covered}</dd><dt>本次目标 / 预计请求</dt><dd>{counts.missing}</dd><dt>供应商 / 模型</dt><dd>{providerLabel}</dd><dt>每画面候选</dt><dd>{workspace.summary.plannedPerVisual}</dd><dt>预计费用</dt><dd>{workspace.feeEstimate ?? "费用未知"}</dd></dl></div></AlertDialogDescription></AlertDialogHeader><AlertDialogFooter><AlertDialogCancel>返回检查</AlertDialogCancel><AlertDialogAction className={primaryButton} onClick={() => void state.startBatch("missing")}>确认生成</AlertDialogAction></AlertDialogFooter></AlertDialogContent></AlertDialog>
        </div>
      </div>
    </aside>
  </section>;
}
