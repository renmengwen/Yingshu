import { useEffect, useRef, useState, type RefObject } from "react";

import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "../components/ui/dialog";
import { Input } from "../components/ui/input";
import { NativeSelect, NativeSelectOption } from "../components/ui/native-select";
import { Pagination } from "../components/ui/pagination";
import { Table, TableBody, TableCaption, TableCell, TableHead, TableHeader, TableRow } from "../components/ui/table";
import { DEFAULT_PAGE_SIZE, PAGE_SIZE_OPTIONS, paginate } from "./video-plan-review/logic";
import { formatProductionTime, motionLabel, type VideoMotionKind, type VideoVisualSegment } from "./video-final-production-logic";
import type { AspectRatio } from "./types";

const motions: VideoMotionKind[] = ["still", "zoom_in", "zoom_out", "pan_left", "pan_right"];

function segmentStatus(stale: boolean, issues: string[]) {
  if (stale) return { label: "修订已失效", destructive: true };
  if (issues.length) return { label: "存在校验阻断", destructive: true };
  return { label: "连续有效", destructive: false };
}

export function VideoVisualTimelineList({ segments, aspectRatio = "9:16", timelineHash, stale, issues, busyAction, onDirtyChange, onSave }: {
  segments: VideoVisualSegment[];
  aspectRatio?: AspectRatio;
  timelineHash: string;
  stale: boolean;
  issues: string[];
  busyAction: string | null;
  onDirtyChange: (dirty: boolean) => void;
  onSave: (segmentId: string, patch: { motionKind: VideoMotionKind; motionAmountPpm: number; fadeInMs: number; fadeOutMs: number }) => Promise<void>;
}) {
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(DEFAULT_PAGE_SIZE);
  const [openSegmentId, setOpenSegmentId] = useState<string | null>(null);
  const triggerRef = useRef<HTMLElement | null>(null);
  const view = paginate(segments, page, pageSize);
  const openSegment = segments.find((segment) => segment.id === openSegmentId) ?? null;
  const status = segmentStatus(stale, issues);

  useEffect(() => { if (page !== view.page) setPage(view.page); }, [page, view.page]);
  useEffect(() => { if (openSegmentId && !openSegment) setOpenSegmentId(null); }, [openSegment, openSegmentId]);

  function openDetails(segmentId: string, trigger: HTMLElement) {
    triggerRef.current = trigger;
    setOpenSegmentId(segmentId);
  }

  return <section className="min-w-0 px-4 py-5 md:px-7" aria-labelledby="visual-segments-heading">
    <div className="flex flex-col gap-3 border border-[var(--border-subtle)] bg-[var(--bg-subtle)] p-4 sm:flex-row sm:items-center sm:justify-between">
      <div><h3 id="visual-segments-heading" className="font-semibold">视觉段记录</h3><p className="mt-1 text-sm text-[var(--fg-secondary)]">表格用于扫描连续覆盖；完整旁白和运镜参数在详情中查看与编辑。</p></div>
      <label className="flex items-center gap-2 text-sm">每页<NativeSelect aria-label="视觉段每页条数" value={pageSize} onChange={(event) => { setPageSize(Number(event.target.value)); setPage(1); }}>{PAGE_SIZE_OPTIONS.map((option) => <NativeSelectOption key={option} value={option}>{option} 条</NativeSelectOption>)}</NativeSelect></label>
    </div>
    <div className="hidden border-x border-b border-[var(--border-subtle)] md:block">
      <Table className="table-fixed"><TableCaption className="sr-only">视觉时间轴段落与审核记录</TableCaption><TableHeader><TableRow><TableHead className="w-20">当前图</TableHead><TableHead className="w-16">段号</TableHead><TableHead className="w-28">时间</TableHead><TableHead className="w-20">cue</TableHead><TableHead className="w-[20%]">旁白摘要</TableHead><TableHead className="w-20">运镜</TableHead><TableHead className="w-28">淡入淡出</TableHead><TableHead className="w-28">校验状态</TableHead><TableHead className="w-28 text-right">操作</TableHead></TableRow></TableHeader>
        <TableBody>{view.items.map((segment) => { const number = String(segment.segmentIndex + 1).padStart(2, "0"); return <TableRow key={`${timelineHash}:${segment.id}`}><TableCell><img src={segment.previewUrl} alt={`视觉段 ${number} 当前批准图缩略图`} className="h-14 w-24 bg-[var(--bg-inset)] object-contain" style={{ aspectRatio: aspectRatio.replace(":", " / ") }} /></TableCell><TableCell className="font-mono">{number}</TableCell><TableCell className="font-mono text-xs">{formatProductionTime(segment.startMs)}–{formatProductionTime(segment.endMs)}</TableCell><TableCell className="font-mono text-xs">{segment.cueStartIndex + 1}–{segment.cueEndIndex + 1}</TableCell><TableCell className="whitespace-normal"><p className="line-clamp-2 leading-5">{segment.narrationSummary || "当前段未返回旁白摘要。"}</p></TableCell><TableCell>{motionLabel(segment.motionKind)}</TableCell><TableCell className="font-mono text-xs">{segment.fadeInMs} / {segment.fadeOutMs} ms</TableCell><TableCell className="whitespace-normal"><Badge variant={status.destructive ? "destructive" : "outline"}>{status.label}</Badge></TableCell><TableCell className="text-right"><Button aria-label={`视觉段 ${number}：查看与编辑运镜`} variant="outline" type="button" onClick={(event) => openDetails(segment.id, event.currentTarget)}>查看与编辑</Button></TableCell></TableRow>; })}</TableBody>
      </Table>
    </div>
    <div className="divide-y divide-[var(--border-subtle)] border-x border-b border-[var(--border-subtle)] md:hidden">{view.items.map((segment) => { const number = String(segment.segmentIndex + 1).padStart(2, "0"); return <article key={`${timelineHash}:${segment.id}`} className="min-w-0 p-4"><div className="flex items-start gap-3"><img src={segment.previewUrl} alt={`视觉段 ${number} 当前批准图缩略图`} className="h-20 w-24 shrink-0 bg-[var(--bg-inset)] object-contain" style={{ aspectRatio: aspectRatio.replace(":", " / ") }} /><div className="min-w-0 flex-1"><div className="flex flex-wrap items-center justify-between gap-2"><p className="font-mono text-xs font-semibold text-[var(--accent)]">视觉段 {number}</p><Badge variant={status.destructive ? "destructive" : "outline"}>{status.label}</Badge></div><p className="mt-2 line-clamp-2 text-sm leading-6">{segment.narrationSummary || "当前段未返回旁白摘要。"}</p><p className="mt-2 font-mono text-xs text-[var(--fg-secondary)]">{formatProductionTime(segment.startMs)}–{formatProductionTime(segment.endMs)} · cue {segment.cueStartIndex + 1}–{segment.cueEndIndex + 1}</p></div></div><p className="mt-2 text-xs text-[var(--fg-secondary)]">{motionLabel(segment.motionKind)} · 淡入/淡出 {segment.fadeInMs}/{segment.fadeOutMs} ms</p><Button aria-label={`视觉段 ${number}：查看与编辑运镜`} className="mt-3 w-full" variant="outline" type="button" onClick={(event) => openDetails(segment.id, event.currentTarget)}>查看与编辑</Button></article>; })}</div>
    <Pagination className="mt-4 flex-col gap-3 sm:flex-row sm:items-center sm:justify-between" aria-label="视觉段记录分页"><p className="text-sm text-[var(--fg-secondary)]">共 {view.totalItems} 条 · 第 {view.page} / {view.totalPages} 页</p><div className="flex items-center gap-2"><Button variant="outline" type="button" disabled={view.page <= 1} onClick={() => setPage(view.page - 1)}>上一页</Button><span className="min-w-20 text-center font-mono text-sm" aria-current="page">{view.page} / {view.totalPages}</span><Button variant="outline" type="button" disabled={view.page >= view.totalPages} onClick={() => setPage(view.page + 1)}>下一页</Button></div></Pagination>
    {openSegment ? <VisualSegmentDialog aspectRatio={aspectRatio} segment={openSegment} open triggerRef={triggerRef} busyAction={busyAction} onDirtyChange={onDirtyChange} onOpenChange={(next) => { if (!next) setOpenSegmentId(null); }} onSave={(patch) => onSave(openSegment.id, patch)} /> : null}
  </section>;
}

function VisualSegmentDialog({ aspectRatio, segment, open, triggerRef, busyAction, onDirtyChange, onOpenChange, onSave }: {
  aspectRatio: AspectRatio;
  segment: VideoVisualSegment;
  open: boolean;
  triggerRef: RefObject<HTMLElement | null>;
  busyAction: string | null;
  onDirtyChange: (dirty: boolean) => void;
  onOpenChange: (open: boolean) => void;
  onSave: (patch: { motionKind: VideoMotionKind; motionAmountPpm: number; fadeInMs: number; fadeOutMs: number }) => Promise<void>;
}) {
  const [motionKind, setMotionKind] = useState(segment.motionKind);
  const [motionAmountPpm, setMotionAmountPpm] = useState(segment.motionAmountPpm);
  const [fadeInMs, setFadeInMs] = useState(segment.fadeInMs);
  const [fadeOutMs, setFadeOutMs] = useState(segment.fadeOutMs);
  const [closeBlocked, setCloseBlocked] = useState(false);
  const initialFocusRef = useRef<HTMLButtonElement>(null);
  const busy = busyAction !== null;
  const saving = busyAction === `segment:${segment.id}`;
  const dirty = motionKind !== segment.motionKind || motionAmountPpm !== segment.motionAmountPpm || fadeInMs !== segment.fadeInMs || fadeOutMs !== segment.fadeOutMs;
  const validDraft = Number.isInteger(motionAmountPpm) && motionAmountPpm >= 0 && motionAmountPpm <= 200000 && Number.isInteger(fadeInMs) && fadeInMs >= 0 && fadeInMs <= 3000 && Number.isInteger(fadeOutMs) && fadeOutMs >= 0 && fadeOutMs <= 3000;

  useEffect(() => { onDirtyChange(dirty); return () => onDirtyChange(false); }, [dirty, onDirtyChange]);
  useEffect(() => {
    if (!open) return;
    setMotionKind(segment.motionKind); setMotionAmountPpm(segment.motionAmountPpm); setFadeInMs(segment.fadeInMs); setFadeOutMs(segment.fadeOutMs); setCloseBlocked(false);
  }, [open, segment.id, segment.motionKind, segment.motionAmountPpm, segment.fadeInMs, segment.fadeOutMs]);

  function requestClose() {
    if (dirty && !saving) setCloseBlocked(true);
    else onOpenChange(false);
  }

  const number = String(segment.segmentIndex + 1).padStart(2, "0");
  return <Dialog open={open} onOpenChange={(next) => { if (!next) requestClose(); }}><DialogContent className="w-[min(calc(100vw-2rem),64rem)]" showCloseButton={false} onOpenAutoFocus={(event) => { event.preventDefault(); initialFocusRef.current?.focus(); }} onCloseAutoFocus={(event) => { event.preventDefault(); triggerRef.current?.focus(); }}>
    <DialogHeader className="pr-24"><DialogTitle>视觉段 {number} · 运镜详情</DialogTitle><DialogDescription>{formatProductionTime(segment.startMs)}–{formatProductionTime(segment.endMs)} · cue {segment.cueStartIndex + 1}–{segment.cueEndIndex + 1}</DialogDescription><Button ref={initialFocusRef} className="absolute right-2 top-2" variant="ghost" type="button" disabled={saving} onClick={requestClose}>关闭<span className="sr-only">视觉段详情</span></Button></DialogHeader>
    <div className="grid min-w-0 gap-5 p-4 sm:p-6 lg:grid-cols-[15rem_minmax(0,1fr)]">
      <figure><img src={segment.previewUrl} alt={`视觉段 ${number} 当前批准图片`} className="mx-auto max-h-[52vh] w-full bg-[var(--bg-inset)] object-contain" style={{ aspectRatio: aspectRatio.replace(":", " / ") }} /><figcaption className="mt-2 break-all font-mono text-[10px] text-[var(--fg-secondary)]">当前批准图 · {segment.candidateHash}</figcaption></figure>
      <div className="min-w-0 space-y-5"><section><h4 className="text-sm font-semibold">完整旁白摘要</h4><p className="mt-2 whitespace-pre-wrap text-sm leading-7 text-[var(--fg-secondary)]">{segment.narrationSummary || "当前段未返回旁白摘要。"}</p></section><dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-2 border-y border-[var(--border-subtle)] py-4 text-sm"><dt className="text-[var(--fg-secondary)]">时间范围</dt><dd className="font-mono">{formatProductionTime(segment.startMs)}–{formatProductionTime(segment.endMs)}</dd><dt className="text-[var(--fg-secondary)]">cue 范围</dt><dd className="font-mono">{segment.cueStartIndex + 1}–{segment.cueEndIndex + 1}</dd><dt className="text-[var(--fg-secondary)]">正式画面</dt><dd className="break-all font-mono text-xs">{segment.visualId}</dd></dl>
        <div className="grid gap-4 sm:grid-cols-2"><label className="grid gap-2 text-sm font-semibold">运镜类型<NativeSelect wrapperClassName="w-full" value={motionKind} disabled={busy} onChange={(event) => { const next = event.target.value as VideoMotionKind; setMotionKind(next); if (next === "still") setMotionAmountPpm(0); }}>{motions.map((motion) => <NativeSelectOption key={motion} value={motion}>{motionLabel(motion)}</NativeSelectOption>)}</NativeSelect></label><NumberField label="运镜幅度 ppm" value={motionAmountPpm} disabled={busy || motionKind === "still"} max={200000} onChange={setMotionAmountPpm} /><NumberField label="淡入 ms" value={fadeInMs} disabled={busy} max={3000} onChange={setFadeInMs} /><NumberField label="淡出 ms" value={fadeOutMs} disabled={busy} max={3000} onChange={setFadeOutMs} /></div>
        {!validDraft ? <p className="text-sm font-semibold text-[var(--status-danger)]" role="alert">参数无效：运镜幅度应为 0–200000，淡入和淡出应为 0–3000 ms 的整数。</p> : closeBlocked ? <p className="text-sm font-semibold text-[var(--status-warning)]" role="alert">当前运镜参数尚未保存。可继续编辑，或明确放弃修改后关闭。</p> : null}
      </div>
    </div>
    <DialogFooter><Button variant="outline" type="button" disabled={saving} onClick={() => { if (dirty) { onDirtyChange(false); onOpenChange(false); } else requestClose(); }}>{dirty ? "放弃修改并关闭" : "取消"}</Button><Button type="button" disabled={busy || !dirty || !validDraft} onClick={() => void onSave({ motionKind, motionAmountPpm, fadeInMs, fadeOutMs })}>{saving ? "正在保存本段设置…" : dirty ? "保存本段设置" : "本段设置已保存"}</Button></DialogFooter>
  </DialogContent></Dialog>;
}

function NumberField({ label, value, disabled, max, onChange }: { label: string; value: number; disabled: boolean; max: number; onChange: (value: number) => void }) {
  return <label className="grid gap-2 text-sm font-semibold">{label}<Input className="font-mono font-normal" type="number" min={0} max={max} step={1000} value={value} disabled={disabled} onChange={(event) => { if (Number.isFinite(event.currentTarget.valueAsNumber)) onChange(event.currentTarget.valueAsNumber); }} /></label>;
}
