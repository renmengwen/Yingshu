import { useEffect, useRef, useState, type RefObject } from "react";

import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger } from "../components/ui/alert-dialog";
import { Badge } from "../components/ui/badge";
import { Button, buttonVariants } from "../components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "../components/ui/dialog";
import { candidateIdentity, currentImageCandidates, formatImageCandidateTime, historicalImageCandidates, styleSnapshotLabel, type VideoImageCandidate, type VideoImageVisual } from "./image-logic";

const secondaryButton = buttonVariants({ variant: "outline" });

function CandidateDetails({ candidate }: { candidate: VideoImageCandidate }) {
  return <details className="border-t border-[var(--border-subtle)] pt-3 text-xs leading-5">
    <summary className="min-h-11 cursor-pointer py-3 font-semibold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus)]">查看完整生成身份</summary>
    <div className="space-y-3 break-words text-[var(--fg-secondary)]">
      <p>{candidateIdentity(candidate)} · {candidate.width} × {candidate.height} · {Math.ceil(candidate.bytes / 1024)} KiB · {formatImageCandidateTime(candidate.createdAt)}</p>
      <div><p className="font-semibold text-[var(--fg-primary)]">候选冻结 Prompt</p><p className="mt-1 whitespace-pre-wrap">{candidate.prompt || "未记录"}</p></div>
      <div><p className="font-semibold text-[var(--fg-primary)]">候选冻结负面 Prompt</p><p className="mt-1 whitespace-pre-wrap">{candidate.negativePrompt || "未设置"}</p></div>
      <p><span className="font-semibold text-[var(--fg-primary)]">画面风格快照：</span>{styleSnapshotLabel(candidate.styleSnapshot) || "未设置"}</p>
      <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 font-mono">
        <dt>候选</dt><dd className="break-all">{candidate.id}</dd><dt>方案快照</dt><dd className="break-all">{candidate.planSnapshotId} / {candidate.planSnapshotHash}</dd>
        <dt>旁白修订</dt><dd className="break-all">{candidate.scriptRevisionId} / {candidate.scriptContentHash}</dd><dt>画面修订</dt><dd className="break-all">{candidate.visualRevisionId} / {candidate.visualContentHash}</dd>
        <dt>Prompt hash</dt><dd className="break-all">{candidate.promptHash}</dd><dt>请求身份</dt><dd className="break-all">{candidate.requestIdentity}</dd>
        <dt>批次 / 幂等键</dt><dd className="break-all">{candidate.batchId ?? "上传"} / {candidate.idempotencyKey ?? "无"}</dd><dt>Job / 尝试</dt><dd className="break-all">{candidate.jobId ?? "无"} / {candidate.attempt}</dd>
        <dt>Checkpoint</dt><dd className="break-all">{candidate.checkpointScope ?? "无"}</dd><dt>媒体身份</dt><dd className="break-all">{candidate.mime} / {candidate.relativePath}</dd>
        <dt>文件哈希</dt><dd className="break-all">{candidate.fileHash}</dd>{candidate.providerRequestId ? <><dt>上游请求</dt><dd className="break-all">{candidate.providerRequestId}</dd></> : null}
      </dl>
    </div>
  </details>;
}

export function VisualImageReviewRow({ visual, open, triggerRef, productionAllowed, busyAction, onOpenChange, onGenerate, onUpload, onApprove }: {
  visual: VideoImageVisual;
  open: boolean;
  triggerRef: RefObject<HTMLElement | null>;
  productionAllowed: boolean;
  busyAction: string | null;
  onOpenChange: (open: boolean) => void;
  onGenerate: (regenerate: boolean) => void;
  onUpload: (file: File) => void;
  onApprove: (candidateId: string) => void;
}) {
  const current = currentImageCandidates(visual);
  const historical = historicalImageCandidates(visual);
  const approvedId = current.find((candidate) => candidate.approved)?.id ?? null;
  const [selectedId, setSelectedId] = useState<string | null>(approvedId);
  const [previewId, setPreviewId] = useState<string | null>(approvedId ?? current[0]?.id ?? null);
  const [confirmClose, setConfirmClose] = useState(false);
  const initialFocusRef = useRef<HTMLButtonElement>(null);
  const busy = busyAction !== null;
  const generating = busyAction === `generate:${visual.id}`;
  const uploading = busyAction === `upload:${visual.id}`;
  const approving = busyAction === `approve:${visual.id}`;
  const activeGeneration = visual.generationState?.status === "queued" || visual.generationState?.status === "running";
  const dirty = selectedId !== approvedId;
  const selected = current.find((candidate) => candidate.id === selectedId) ?? null;
  const preview = [...current, ...historical].find((candidate) => candidate.id === previewId) ?? current[0] ?? historical[0] ?? null;

  useEffect(() => {
    if (!open) return;
    setSelectedId(approvedId);
    setPreviewId(approvedId ?? current[0]?.id ?? historical[0]?.id ?? null);
  }, [open, approvedId, visual.id]);

  function requestClose() {
    if (dirty && !approving) setConfirmClose(true);
    else onOpenChange(false);
  }

  const disabledReason = !productionAllowed ? "当前生产门禁未通过，不能生成、上传或批准。" : busy ? "当前操作尚未完成，请稍候。" : null;

  return <>
    <Dialog open={open} onOpenChange={(next) => { if (!next) requestClose(); }}>
      <DialogContent className="w-[min(calc(100vw-2rem),70rem)]" showCloseButton={false} onOpenAutoFocus={(event) => { event.preventDefault(); initialFocusRef.current?.focus(); }} onCloseAutoFocus={(event) => { event.preventDefault(); triggerRef.current?.focus(); }}>
        <DialogHeader className="pr-16">
          <DialogTitle>画面 {String(visual.order + 1).padStart(2, "0")} · 候选图片</DialogTitle>
          <DialogDescription>{visual.narrationSummary} · 当前 {current.length} 个可用候选{historical.length ? ` · ${historical.length} 个历史候选` : ""}</DialogDescription>
          <Button ref={initialFocusRef} className="absolute right-2 top-2" variant="ghost" type="button" onClick={requestClose}>关闭<span className="sr-only">画面候选详情</span></Button>
        </DialogHeader>
        <div className="grid min-w-0 gap-5 p-4 sm:p-6 lg:grid-cols-[minmax(17rem,24rem)_minmax(0,1fr)]">
          <div className="min-w-0 space-y-4">
            <section><h4 className="text-sm font-semibold">完整中文描述</h4><p className="mt-1 whitespace-pre-wrap text-sm leading-6 text-[var(--fg-secondary)]">{visual.description}</p></section>
            <section><h4 className="text-sm font-semibold">当前画面最终 Prompt</h4><p className="mt-1 max-h-40 overflow-y-auto whitespace-pre-wrap break-words font-mono text-xs leading-5 text-[var(--fg-secondary)]">{visual.prompt || "未设置"}</p></section>
            <section><h4 className="text-sm font-semibold">当前画面负面 Prompt</h4><p className="mt-1 max-h-28 overflow-y-auto whitespace-pre-wrap break-words font-mono text-xs leading-5 text-[var(--fg-secondary)]">{visual.negativePrompt || "未设置"}</p></section>
            {visual.generationState?.errorSummary ? <p className="text-sm font-semibold text-[var(--status-danger)]" role="alert">生成失败：{visual.generationState.errorSummary}</p> : null}
            {disabledReason ? <p className="text-sm text-[var(--status-warning)]">{disabledReason}</p> : null}
          </div>
          <div className="min-w-0 space-y-4">
            {preview ? <figure className="min-w-0"><div className="mx-auto aspect-[9/16] max-h-[46vh] overflow-hidden bg-[var(--bg-inset)]"><img className="h-full w-full object-contain" src={preview.previewUrl} alt={`画面 ${String(visual.order + 1).padStart(2, "0")}候选大图：${candidateIdentity(preview)}`} /></div><figcaption className="mt-2 text-center text-xs text-[var(--fg-secondary)]">放大查看 · {candidateIdentity(preview)}</figcaption></figure> : <p className="min-h-32 border border-dashed border-[var(--border-strong)] bg-[var(--bg-inset)] p-5 text-sm text-[var(--fg-secondary)]">尚无图片候选。可重新生成或上传本地图片。</p>}
            {current.length ? <div><h4 className="text-sm font-semibold">选择一个候选</h4><p className="mt-1 text-xs leading-5 text-[var(--fg-secondary)]">选择只保留在当前弹框；点击“批准所选图片”后才会写入审核结果。</p><div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-3">{current.map((candidate, index) => <article key={candidate.id} className={`min-w-0 border p-2 ${selectedId === candidate.id ? "border-[var(--accent)] bg-[var(--surface-selected)]" : "border-[var(--border-subtle)]"}`}>
              <button className="block w-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus)]" type="button" onClick={() => setPreviewId(candidate.id)}><img className="aspect-[9/16] w-full bg-[var(--bg-inset)] object-cover" src={candidate.previewUrl} alt={`候选 ${index + 1}，点击放大查看`} /></button>
              <div className="mt-2 flex flex-wrap items-center justify-between gap-2"><span className="text-xs font-semibold">候选 {index + 1}</span><Badge variant={candidate.approved ? "default" : "outline"}>{candidate.approved ? "已批准" : "待审核"}</Badge></div>
              <Button className="mt-2 w-full" size="sm" variant={selectedId === candidate.id ? "default" : "outline"} type="button" disabled={busy || candidate.approved} onClick={() => { setSelectedId(candidate.id); setPreviewId(candidate.id); }}>{candidate.approved ? "当前已批准" : selectedId === candidate.id ? "已选择" : "选择候选"}</Button>
            </article>)}</div></div> : null}
            {preview ? <CandidateDetails candidate={preview} /> : null}
            {historical.length ? <details className="border-t border-[var(--border-subtle)]"><summary className="min-h-11 cursor-pointer py-3 text-sm font-semibold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus)]">历史 / 已失效候选（{historical.length}）</summary><div className="grid grid-cols-2 gap-3 sm:grid-cols-3">{historical.map((candidate, index) => <button key={candidate.id} className="border border-[var(--border-subtle)] p-2 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus)]" type="button" onClick={() => setPreviewId(candidate.id)}><img className="aspect-[9/16] w-full object-cover opacity-70" src={candidate.previewUrl} alt={`历史候选 ${index + 1}，点击放大查看`} /><span className="mt-2 block text-xs">历史候选 {index + 1}</span></button>)}</div></details> : null}
          </div>
        </div>
        <DialogFooter className="sm:items-center sm:justify-between">
          <div className="flex flex-col gap-2 sm:flex-row">
            <AlertDialog><AlertDialogTrigger asChild><Button variant="outline" type="button" disabled={!productionAllowed || busy || activeGeneration}>{generating ? "正在创建任务…" : activeGeneration ? "当前画面正在生成" : current.length ? "重新生成当前画面" : "生成当前画面"}</Button></AlertDialogTrigger><AlertDialogContent><AlertDialogHeader><AlertDialogTitle>{current.length ? "确认重新生成当前画面" : "确认生成当前画面"}</AlertDialogTitle><AlertDialogDescription>此操作会创建可能计费的持久图片任务。现有候选会继续保留，且新候选不会自动批准。</AlertDialogDescription></AlertDialogHeader><AlertDialogFooter><AlertDialogCancel>返回检查</AlertDialogCancel><AlertDialogAction onClick={() => onGenerate(current.length > 0)}>确认生成</AlertDialogAction></AlertDialogFooter></AlertDialogContent></AlertDialog>
            <label className={`focus-ring-proxy ${secondaryButton} ${!productionAllowed || busy ? "cursor-not-allowed opacity-50" : "cursor-pointer"}`} aria-disabled={!productionAllowed || busy}>{uploading ? "正在上传…" : "上传图片"}<input className="sr-only" type="file" accept="image/png,image/jpeg,image/webp" disabled={!productionAllowed || busy} onChange={(event) => { const file = event.currentTarget.files?.[0]; event.currentTarget.value = ""; if (file) onUpload(file); }} /></label>
          </div>
          <div className="flex flex-col-reverse gap-2 sm:flex-row"><Button variant="outline" type="button" onClick={requestClose}>取消</Button><Button type="button" disabled={!selected || selected.approved || !productionAllowed || busy} onClick={() => selected && onApprove(selected.id)}>{approving ? "正在批准…" : selected ? selected.approved ? "当前已批准" : "批准所选图片" : "先选择候选"}</Button></div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
    <AlertDialog open={confirmClose} onOpenChange={setConfirmClose}><AlertDialogContent><AlertDialogHeader><AlertDialogTitle>放弃未提交的候选选择？</AlertDialogTitle><AlertDialogDescription>当前选择只保留在本地，关闭后将恢复为已批准候选或未选择状态。</AlertDialogDescription></AlertDialogHeader><AlertDialogFooter><AlertDialogCancel>继续选择</AlertDialogCancel><AlertDialogAction onClick={() => { setConfirmClose(false); onOpenChange(false); }}>放弃并关闭</AlertDialogAction></AlertDialogFooter></AlertDialogContent></AlertDialog>
  </>;
}
