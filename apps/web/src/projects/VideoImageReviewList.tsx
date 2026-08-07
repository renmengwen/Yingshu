import { useEffect, useRef, useState } from "react";

import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { NativeSelect, NativeSelectOption } from "../components/ui/native-select";
import { Pagination } from "../components/ui/pagination";
import { Table, TableBody, TableCaption, TableCell, TableHead, TableHeader, TableRow } from "../components/ui/table";
import { currentImageCandidates, historicalImageCandidates, imageCandidateAspectRatio, type VideoImageVisual } from "./image-logic";
import { DEFAULT_PAGE_SIZE, PAGE_SIZE_OPTIONS, paginate } from "./video-plan-review/logic";
import { VisualImageReviewRow } from "./VisualImageReviewRow";

function generationLabel(visual: VideoImageVisual) {
  if (!visual.generationState) return "等待生成";
  return ({ queued: "排队中", running: "正在生成", succeeded: "生成完成", failed: "生成失败", cancelled: "已中断" } as const)[visual.generationState.status];
}

function reviewLabel(visual: VideoImageVisual) {
  const current = currentImageCandidates(visual);
  if (current.some((candidate) => candidate.approved)) return "已批准";
  if (current.length) return "等待选择";
  return historicalImageCandidates(visual).length ? "候选已失效" : "尚无候选";
}

export function VideoImageReviewList({ visuals, productionAllowed, busyAction, onGenerate, onUpload, onApprove }: {
  visuals: VideoImageVisual[];
  productionAllowed: boolean;
  busyAction: string | null;
  onGenerate: (visualId: string, regenerate: boolean) => void;
  onUpload: (visualId: string, file: File) => void;
  onApprove: (visualId: string, candidateId: string) => void;
}) {
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(DEFAULT_PAGE_SIZE);
  const [openVisualId, setOpenVisualId] = useState<string | null>(null);
  const triggerRef = useRef<HTMLElement | null>(null);
  const view = paginate(visuals, page, pageSize);
  const openVisual = visuals.find((visual) => visual.id === openVisualId) ?? null;

  useEffect(() => { if (page !== view.page) setPage(view.page); }, [page, view.page]);
  useEffect(() => { if (openVisualId && !openVisual) setOpenVisualId(null); }, [openVisual, openVisualId]);

  function openDetails(visualId: string, trigger: HTMLElement) {
    triggerRef.current = trigger;
    setOpenVisualId(visualId);
  }

  return <section className="min-w-0 px-4 py-5 md:px-7" aria-labelledby="image-records-heading">
    <div className="flex flex-col gap-3 border border-[var(--border-subtle)] bg-[var(--bg-subtle)] p-4 sm:flex-row sm:items-center sm:justify-between">
      <div><h3 id="image-records-heading" className="font-semibold">画面记录</h3><p className="mt-1 text-sm text-[var(--fg-secondary)]">表格用于扫描状态；完整描述、Prompt 与候选画廊在详情中查看。</p></div>
      <label className="flex items-center gap-2 text-sm">每页<NativeSelect aria-label="每页条数" value={pageSize} onChange={(event) => { setPageSize(Number(event.target.value)); setPage(1); }}>{PAGE_SIZE_OPTIONS.map((option) => <NativeSelectOption key={option} value={option}>{option} 条</NativeSelectOption>)}</NativeSelect></label>
    </div>
    <div className="hidden border-x border-b border-[var(--border-subtle)] md:block">
      <Table className="table-fixed"><TableCaption className="sr-only">配图候选与审核记录</TableCaption><TableHeader><TableRow><TableHead className="w-24">画面</TableHead><TableHead className="w-[25%]">旁白摘要</TableHead><TableHead>生成状态</TableHead><TableHead className="w-20">候选</TableHead><TableHead className="w-28">当前批准图</TableHead><TableHead className="w-32">修订状态</TableHead><TableHead className="w-32 text-right">操作</TableHead></TableRow></TableHeader><TableBody>{view.items.map((visual) => {
        const current = currentImageCandidates(visual); const approved = current.find((candidate) => candidate.approved); const thumbnail = current[0]; const historyCount = historicalImageCandidates(visual).length;
        const visualNumber = String(visual.order + 1).padStart(2, "0");
        const actionLabel = current.length ? approved ? "查看候选" : "选择与批准" : visual.generationState?.status === "failed" ? "查看并重试" : "查看与生成";
        return <TableRow key={visual.id}><TableCell><div className="flex items-center gap-2"><div className="h-14 w-24 shrink-0 overflow-hidden bg-[var(--bg-inset)]">{thumbnail ? <img className="h-full w-full object-contain" style={{ aspectRatio: imageCandidateAspectRatio(thumbnail) }} src={thumbnail.previewUrl} alt={`画面 ${visualNumber} 当前候选缩略图`} /> : null}</div><span className="font-mono">{visualNumber}</span></div></TableCell><TableCell className="whitespace-normal"><p className="line-clamp-2 leading-5">{visual.narrationSummary}</p><p className="mt-1 line-clamp-1 text-xs text-[var(--fg-tertiary)]">{visual.description}</p></TableCell><TableCell className="whitespace-normal"><Badge variant={visual.generationState?.status === "failed" ? "destructive" : "outline"}>{generationLabel(visual)}</Badge>{visual.generationState?.errorSummary ? <p className="mt-1 line-clamp-2 text-xs text-[var(--status-danger)]">{visual.generationState.errorSummary}</p> : null}</TableCell><TableCell className="font-mono">{current.length}</TableCell><TableCell>{approved ? <img className="h-14 w-24 bg-[var(--bg-inset)] object-contain" style={{ aspectRatio: imageCandidateAspectRatio(approved) }} src={approved.previewUrl} alt={`画面 ${visualNumber} 当前批准图缩略图`} /> : <span className="text-xs text-[var(--fg-secondary)]">未批准</span>}</TableCell><TableCell className="whitespace-normal"><Badge variant="outline">当前修订</Badge>{historyCount ? <p className="mt-1 text-xs text-[var(--status-warning)]">存在 {historyCount} 个历史已失效候选</p> : <p className="mt-1 text-xs text-[var(--fg-secondary)]">无历史失效候选</p>}</TableCell><TableCell className="text-right"><Button aria-label={`画面 ${visualNumber}：${actionLabel}`} variant="outline" type="button" onClick={(event) => openDetails(visual.id, event.currentTarget)}>{actionLabel}</Button></TableCell></TableRow>;
      })}</TableBody></Table>
    </div>
    <div className="divide-y divide-[var(--border-subtle)] border-x border-b border-[var(--border-subtle)] md:hidden">{view.items.map((visual) => { const current = currentImageCandidates(visual); const approved = current.some((candidate) => candidate.approved); const visualNumber = String(visual.order + 1).padStart(2, "0"); const actionLabel = current.length ? approved ? "查看候选" : "选择与批准" : "查看与生成"; return <article key={visual.id} className="min-w-0 p-4"><div className="flex items-start justify-between gap-3"><div className="min-w-0"><p className="font-mono text-xs font-semibold text-[var(--accent)]">画面 {visualNumber}</p><p className="mt-2 line-clamp-2 text-sm leading-6">{visual.narrationSummary}</p></div><Badge variant={approved ? "default" : "outline"}>{reviewLabel(visual)}</Badge></div><p className="mt-2 text-xs text-[var(--fg-secondary)]">{generationLabel(visual)} · {current.length} 个当前候选</p><Button aria-label={`画面 ${visualNumber}：${actionLabel}`} className="mt-3 w-full" variant="outline" type="button" onClick={(event) => openDetails(visual.id, event.currentTarget)}>{actionLabel}</Button></article>; })}</div>
    <Pagination className="mt-4 flex-col gap-3 sm:flex-row sm:items-center sm:justify-between" aria-label="配图记录分页"><p className="text-sm text-[var(--fg-secondary)]">共 {view.totalItems} 条 · 第 {view.page} / {view.totalPages} 页</p><div className="flex items-center gap-2"><Button variant="outline" type="button" disabled={view.page <= 1} onClick={() => setPage(view.page - 1)}>上一页</Button><span className="min-w-20 text-center font-mono text-sm" aria-current="page">{view.page} / {view.totalPages}</span><Button variant="outline" type="button" disabled={view.page >= view.totalPages} onClick={() => setPage(view.page + 1)}>下一页</Button></div></Pagination>
    {openVisual ? <VisualImageReviewRow visual={openVisual} open triggerRef={triggerRef} productionAllowed={productionAllowed} busyAction={busyAction} onOpenChange={(next) => { if (!next) setOpenVisualId(null); }} onGenerate={(regenerate) => onGenerate(openVisual.id, regenerate)} onUpload={(file) => onUpload(openVisual.id, file)} onApprove={(candidateId) => onApprove(openVisual.id, candidateId)} /> : null}
  </section>;
}
