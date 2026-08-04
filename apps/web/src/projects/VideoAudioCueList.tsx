import { useEffect, useRef, useState } from "react";

import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "../components/ui/dialog";
import { NativeSelect, NativeSelectOption } from "../components/ui/native-select";
import { Pagination } from "../components/ui/pagination";
import { Table, TableBody, TableCaption, TableCell, TableHead, TableHeader, TableRow } from "../components/ui/table";
import { DEFAULT_PAGE_SIZE, PAGE_SIZE_OPTIONS, paginate } from "./video-plan-review/logic";
import { formatTtsDuration, type VideoTtsCue } from "./video-tts-logic";

function cueNumber(index: number) {
  return String(index + 1).padStart(2, "0");
}

export function VideoAudioCueList({ base, cues, busy, stale, fullPlaybackConfirmed }: {
  base: string;
  cues: VideoTtsCue[];
  busy: boolean;
  stale: boolean;
  fullPlaybackConfirmed: boolean;
}) {
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(DEFAULT_PAGE_SIZE);
  const [openCueId, setOpenCueId] = useState<string | null>(null);
  const triggerRef = useRef<HTMLElement | null>(null);
  const initialFocusRef = useRef<HTMLButtonElement>(null);
  const dialogAudioRef = useRef<HTMLAudioElement>(null);
  const view = paginate(cues, page, pageSize);
  const openCue = cues.find((cue) => cue.id === openCueId) ?? null;
  const openIndex = openCue ? cues.indexOf(openCue) : -1;

  useEffect(() => { if (page !== view.page) setPage(view.page); }, [page, view.page]);
  useEffect(() => { if (openCueId && !openCue) setOpenCueId(null); }, [openCue, openCueId]);

  function openDetails(cueId: string, trigger: HTMLElement) {
    triggerRef.current = trigger;
    setOpenCueId(cueId);
  }

  function closeDetails() {
    dialogAudioRef.current?.pause();
    setOpenCueId(null);
  }

  function seekDialogAudio(seconds: number) {
    if (!dialogAudioRef.current) return;
    dialogAudioRef.current.currentTime = seconds;
    void dialogAudioRef.current.play().catch(() => undefined);
  }

  return <section className="min-w-0" aria-labelledby="audio-cues-heading">
    <div className="flex flex-col gap-3 border border-[var(--border-subtle)] bg-[var(--bg-subtle)] p-4 sm:flex-row sm:items-center sm:justify-between">
      <div><h4 id="audio-cues-heading" className="font-semibold">音频分段</h4><p className="mt-1 text-sm text-[var(--fg-secondary)]">表格用于定位与检查；完整旁白和字幕时间进入单段详情。</p></div>
      <label className="flex items-center gap-2 text-sm">每页<NativeSelect aria-label="音频分段每页条数" value={pageSize} onChange={(event) => { setPageSize(Number(event.target.value)); setPage(1); }}>{PAGE_SIZE_OPTIONS.map((option) => <NativeSelectOption key={option} value={option}>{option} 条</NativeSelectOption>)}</NativeSelect></label>
    </div>
    <div className="hidden border-x border-b border-[var(--border-subtle)] md:block">
      <Table className="table-fixed"><TableCaption className="sr-only">配音与字幕分段记录</TableCaption><TableHeader><TableRow><TableHead className="w-16">分段</TableHead><TableHead className="w-[24%]">旁白摘要</TableHead><TableHead className="w-24">开始</TableHead><TableHead className="w-24">结束</TableHead><TableHead className="w-24">真实时长</TableHead><TableHead className="w-24">音频状态</TableHead><TableHead className="w-24">字幕状态</TableHead><TableHead className="w-28">试听状态</TableHead><TableHead className="w-28 text-right">操作</TableHead></TableRow></TableHeader>
        <TableBody>{view.items.map((cue) => { const index = cues.indexOf(cue); const number = cueNumber(index); return <TableRow key={cue.id}><TableCell className="font-mono">{number}</TableCell><TableCell className="whitespace-normal"><p className="line-clamp-2 leading-5">{cue.text}</p></TableCell><TableCell className="font-mono">{formatTtsDuration(cue.startSeconds)}</TableCell><TableCell className="font-mono">{formatTtsDuration(cue.endSeconds)}</TableCell><TableCell className="font-mono">{formatTtsDuration(Math.max(0, cue.endSeconds - cue.startSeconds))}</TableCell><TableCell><Badge variant={stale ? "outline" : "default"}>{stale ? "历史音频" : "生成成功"}</Badge></TableCell><TableCell><Badge variant="outline">已生成</Badge></TableCell><TableCell><Badge variant="outline">{fullPlaybackConfirmed ? "整片已试听" : "可定位试听"}</Badge></TableCell><TableCell className="text-right"><Button aria-label={`音频分段 ${number}：查看详情`} variant="outline" type="button" onClick={(event) => openDetails(cue.id, event.currentTarget)}>查看详情</Button></TableCell></TableRow>; })}</TableBody>
      </Table>
    </div>
    <div className="divide-y divide-[var(--border-subtle)] border-x border-b border-[var(--border-subtle)] md:hidden">{view.items.map((cue) => { const index = cues.indexOf(cue); const number = cueNumber(index); return <article key={cue.id} className="min-w-0 p-4"><div className="flex items-start justify-between gap-3"><div className="min-w-0"><p className="font-mono text-xs font-semibold text-[var(--accent)]">音频分段 {number}</p><p className="mt-2 line-clamp-2 break-words text-sm leading-6">{cue.text}</p></div><Badge variant={stale ? "outline" : "default"}>{stale ? "历史音频" : "已生成"}</Badge></div><p className="mt-2 font-mono text-xs text-[var(--fg-secondary)]">{formatTtsDuration(cue.startSeconds)}–{formatTtsDuration(cue.endSeconds)} · {formatTtsDuration(Math.max(0, cue.endSeconds - cue.startSeconds))}</p><p className="mt-1 text-xs text-[var(--fg-secondary)]">字幕已生成 · {fullPlaybackConfirmed ? "整片已试听" : "可定位试听"}</p><Button aria-label={`音频分段 ${number}：查看详情`} className="mt-3 w-full" variant="outline" type="button" onClick={(event) => openDetails(cue.id, event.currentTarget)}>查看详情</Button></article>; })}</div>
    <Pagination className="mt-4 flex-col gap-3 sm:flex-row sm:items-center sm:justify-between" aria-label="音频分段分页"><p className="text-sm text-[var(--fg-secondary)]">共 {view.totalItems} 条 · 第 {view.page} / {view.totalPages} 页</p><div className="flex items-center gap-2"><Button variant="outline" type="button" disabled={view.page <= 1} onClick={() => setPage(view.page - 1)}>上一页</Button><span className="min-w-20 text-center font-mono text-sm" aria-current="page">{view.page} / {view.totalPages}</span><Button variant="outline" type="button" disabled={view.page >= view.totalPages} onClick={() => setPage(view.page + 1)}>下一页</Button></div></Pagination>
    {openCue ? <Dialog open onOpenChange={(next) => { if (!next) closeDetails(); }}><DialogContent showCloseButton={false} onOpenAutoFocus={(event) => { event.preventDefault(); initialFocusRef.current?.focus(); }} onCloseAutoFocus={(event) => { event.preventDefault(); triggerRef.current?.focus(); }}><DialogHeader className="pr-20"><DialogTitle>音频分段 {cueNumber(openIndex)}</DialogTitle><DialogDescription>旁白段落 {openIndex + 1} · {formatTtsDuration(openCue.startSeconds)}–{formatTtsDuration(openCue.endSeconds)}</DialogDescription><Button ref={initialFocusRef} className="absolute right-2 top-2" variant="ghost" type="button" onClick={closeDetails}>关闭<span className="sr-only">音频分段详情</span></Button></DialogHeader><div className="min-w-0 space-y-5 p-5 sm:p-6"><section><h5 className="text-sm font-semibold">完整旁白</h5><p className="mt-2 whitespace-pre-wrap break-words text-sm leading-7 text-[var(--fg-secondary)]">{openCue.text}</p></section><dl className="grid gap-3 bg-[var(--bg-subtle)] p-4 text-sm sm:grid-cols-3"><div><dt className="text-[var(--fg-tertiary)]">开始时间</dt><dd className="mt-1 font-mono">{formatTtsDuration(openCue.startSeconds)}</dd></div><div><dt className="text-[var(--fg-tertiary)]">结束时间</dt><dd className="mt-1 font-mono">{formatTtsDuration(openCue.endSeconds)}</dd></div><div><dt className="text-[var(--fg-tertiary)]">真实时长</dt><dd className="mt-1 font-mono">{formatTtsDuration(Math.max(0, openCue.endSeconds - openCue.startSeconds))}</dd></div></dl><section><h5 className="text-sm font-semibold">试听</h5><audio ref={dialogAudioRef} className="mt-2 w-full" controls preload="metadata" src={`${base}/tts/audio`}>浏览器不支持音频播放。</audio><p className="mt-2 text-xs leading-5 text-[var(--fg-secondary)]">当前服务只提供整片音频；可从本段开始定位试听。试听不会自动批准。</p><Button className="mt-3" variant="outline" type="button" disabled={busy} onClick={() => seekDialogAudio(openCue.startSeconds)}>从本段开始试听</Button></section><section><h5 className="text-sm font-semibold">字幕详情</h5><p className="mt-2 text-sm leading-6 text-[var(--fg-secondary)]">本段字幕文本与完整旁白一致，时间范围以当前 canonical cue 为准。</p><div className="mt-2 flex flex-wrap gap-3"><a className="min-h-11 py-3 font-semibold text-[var(--accent)] underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus)]" href={`${base}/tts/subtitles/srt`} download>下载 SRT</a><a className="min-h-11 py-3 font-semibold text-[var(--accent)] underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus)]" href={`${base}/tts/subtitles/ass`} download>下载 ASS</a></div></section><p className="text-xs leading-5 text-[var(--fg-secondary)]">重新生成沿用整片音频审核合同，不创建逐段任务。</p></div><DialogFooter><Button variant="outline" type="button" onClick={closeDetails}>关闭详情</Button></DialogFooter></DialogContent></Dialog> : null}
  </section>;
}
