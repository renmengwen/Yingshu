import type { JobRecord } from "../types";
import {
  AUDIO_SEGMENTS_PER_PAGE,
  audioPageCount,
  audioSegmentUrl,
  audioSegmentsForPage,
  clampAudioPage,
} from "./audio-editor";
import { useAudioWorkspace } from "./use-audio-workspace";
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from "../../components/ui/accordion";
import { useEffect, useMemo, useState } from "react";

export function AudioStage(props: {
  seriesId: string; episodeIndex: number; timelineHash?: string; busy: boolean; jobActive: boolean; currentJob?: JobRecord;
  setBusy: (busy: boolean) => void; setStatus: (message: string) => void;
  onTimelineChange: (hash: string | undefined) => void; onJobCreated: (id: string) => void;
}) {
  const state = useAudioWorkspace(props);
  const [page, setPage] = useState(0);
  const [playingIndex, setPlayingIndex] = useState<number>();
  const [manualSource, setManualSource] = useState<{ label: string; src: string }>();
  const pageCount = audioPageCount(state.timeline?.segments.length ?? 0);
  const currentPage = clampAudioPage(page, state.timeline?.segments.length ?? 0);
  const pageSegments = useMemo(() => audioSegmentsForPage(state.timeline?.segments ?? [], currentPage), [state.timeline?.segments, currentPage]);
  const playingSegment = state.timeline?.segments.find((segment) => segment.index === playingIndex);
  const playerSource = playingSegment
    ? { label: `当前播放段 ${playingSegment.index + 1}：${playingSegment.text}`, src: audioSegmentUrl(state.timeline!, playingSegment.index) }
    : manualSource;
  useEffect(() => { setPage(0); setPlayingIndex(undefined); setManualSource(undefined); }, [state.timeline?.timelineHash]);
  const selectSegment = (index: number) => {
    setManualSource(undefined);
    setPlayingIndex(index);
    setPage(Math.floor(index / AUDIO_SEGMENTS_PER_PAGE));
  };
  const listening = state.listeningWorkspace;
  const listeningBusy = props.busy || props.jobActive || state.listeningStatus === "loading";
  const listeningComplete = Boolean(listening &&
    listening.requiredSegmentIndexes.every((index) => state.checkedListeningSegments.has(index)) &&
    listening.requiredProperNouns.every((item) => state.checkedProperNouns.has(item.term)));
  return <div className="grid grid-cols-[280px_minmax(0,1fr)] border-t border-[var(--border-subtle)] max-xl:grid-cols-1">
    <aside className="border-r border-[var(--border-subtle)] p-5 max-xl:border-r-0 max-xl:border-b">
      <p className="mt-5 text-xs leading-6 text-[var(--fg-tertiary)]">首版只提供逐段试听，不冒充整集混音。时间轴和字幕身份来自持久层回读。</p>
      <p className="mt-4 break-all font-mono text-[10px] text-[var(--fg-tertiary)]">批准稿：{state.approval?.scriptVersionId ?? "未批准"}</p>
      <div className="mt-5 rounded border border-[var(--border-subtle)] bg-[var(--bg-canvas)] p-3 text-xs leading-6">
        <p className="font-semibold text-[var(--fg-secondary)]">当前活动 TTS</p>
        <p>{state.runtimeLabel}</p>
        <p className="break-all font-mono text-[10px] text-[var(--fg-tertiary)]">任务 voiceId：{state.calibration?.selection?.voice ?? state.voice}</p>
        <p className="font-mono text-[10px] text-[var(--fg-tertiary)]">rate：{state.calibration?.selection?.rate ?? state.rate}</p>
        {state.runtimeError ? <p className="text-[var(--danger)]">设置读取失败：{state.runtimeError}</p> : null}
      </div>
      <button type="button" disabled={props.busy || props.jobActive || state.approval?.status !== "approved" || !state.voice.trim() || !Number.isInteger(state.rate) || state.rate < -10 || state.rate > 10} onClick={() => void state.createCalibration()} className="mt-5 w-full rounded border border-[var(--accent)] px-4 py-2 text-sm font-semibold text-[var(--accent)] disabled:opacity-50">生成两个真实短样</button>
      <button type="button" disabled={props.busy || props.jobActive || state.approval?.status !== "approved" || !state.voice.trim() || !Number.isInteger(state.rate) || state.rate < -10 || state.rate > 10} onClick={() => void state.createTimeline()} className="mt-3 w-full rounded bg-[var(--accent)] px-4 py-2 text-sm font-semibold text-white disabled:opacity-50">生成完整语音时间轴</button>
      <p className="mt-3 text-xs leading-5 text-[var(--fg-tertiary)]">{state.calibration?.selection
        ? `已选实测短样：${state.calibration.selection.voice} / rate ${state.calibration.selection.rate} / ${state.calibration.selection.charactersPerSecond.toFixed(3)} 字/秒`
        : "尚未选择短样；完整 TTS 使用当前 provisional 音色与语速。"}</p>
    </aside>
    <section className="p-6">
      <div className="mb-5 rounded border border-[var(--border-subtle)] bg-[var(--bg-canvas)] p-4">
        <p className="mb-2 text-xs font-semibold">共享播放器</p>
        {playerSource ? <p className="mb-3 text-sm leading-6">{playerSource.label}</p> : <p className="mb-3 text-sm text-[var(--fg-tertiary)]">选择短样或下方任一音频段后在这里试听；不会自动播放。</p>}
        <audio controls preload="none" className="w-full" src={playerSource?.src} onError={() => props.setStatus("音频加载失败：请确认 WAV 文件仍在数据根中")} />
      </div>
      {state.calibration?.samples.length ? <div className="mb-7 grid gap-4 md:grid-cols-2">{state.calibration.samples.map((sample) => <article key={sample.sampleId} className="rounded border border-[var(--border-subtle)] p-4">
        <div className="flex flex-wrap gap-3 text-xs text-[var(--fg-tertiary)]"><span>{sample.voice}</span><span>rate {sample.rate}</span><span>{formatMs(sample.durationMs)}</span><span>{sample.characterCount} 字符</span><span>{sample.charactersPerSecond.toFixed(3)} 字/秒</span></div>
        <p className="my-3 text-sm leading-6">{sample.exactText}</p>
        <button type="button" disabled={props.busy} className="mt-3 w-full rounded border border-[var(--border-subtle)] px-3 py-2 text-sm disabled:opacity-50" onClick={() => { setPlayingIndex(undefined); setManualSource({ label: `短样 ${sample.voice} / rate ${sample.rate}：${sample.exactText}`, src: `/api/episodes/${encodeURIComponent(sample.episodeId)}/tts-calibration/${encodeURIComponent(sample.sampleId)}/audio` }); }}>载入共享播放器试听</button>
        <button type="button" disabled={props.busy || props.jobActive || state.calibration?.selection?.sampleId === sample.sampleId} onClick={() => void state.selectCalibration(sample.sampleId)} className="mt-3 w-full rounded border border-[var(--border-subtle)] px-3 py-2 text-sm disabled:opacity-50">{state.calibration?.selection?.sampleId === sample.sampleId ? "当前已选短样" : "选择此短样"}</button>
      </article>)}</div> : null}
      {!state.episode ? <p className="rounded border border-dashed border-[var(--border-subtle)] p-8 text-sm text-[var(--fg-tertiary)]">该分集尚未创建，请先保存故事弧。</p> : !state.timeline ? <p className="rounded border border-dashed border-[var(--border-subtle)] p-8 text-sm text-[var(--fg-tertiary)]">{state.approval?.status === "approved" ? "批准稿尚无持久化语音时间轴。" : "请先在稿件阶段人工批准成片旁白稿。"}</p> : <>
        <header className="mb-5 flex flex-wrap gap-x-6 gap-y-2 text-sm"><strong>{formatMs(state.timeline.durationMs)}</strong><span>{state.timeline.segmentCount} 段</span><span>{state.timeline.cueCount} 条 cue</span><span>复用段：{state.timeline.reusedSegments ?? "历史任务未记录"}</span><span>provider：{state.timeline.providerId}</span><span>voice：{state.timeline.voice}</span><span>rate {state.timeline.rate}</span></header>
        <section aria-labelledby="listening-review-title" className="mb-7 border-y border-[var(--border-subtle)] bg-[var(--bg-canvas)] py-5">
          <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
            <div>
              <h3 id="listening-review-title" className="text-base font-semibold">人工听审</h3>
              <p className="mt-1 text-xs leading-5 text-[var(--fg-tertiary)]">逐项试听并显式勾选。载入、播放结束或选择短样都不会自动核对或批准。</p>
            </div>
            <p className="text-xs font-semibold">{listeningComplete ? "全部必听项已核对" : "仍有必听项待核对"}</p>
          </div>
          <p aria-live="polite" className={`mb-4 rounded border px-3 py-2 text-sm ${state.listeningStatus === "failure" ? "border-[var(--danger)] text-[var(--danger)]" : "border-[var(--border-subtle)] text-[var(--fg-secondary)]"}`}>
            {state.listeningMessage}
          </p>
          {listening ? <>
            <div className="grid gap-3">
              <h4 className="text-sm font-semibold">动态必听代表段</h4>
              {listening.requiredSegmentIndexes.map((index) => {
                const segment = listening.segments[index]!;
                const checked = state.checkedListeningSegments.has(index);
                return <div key={index} className="grid gap-2 border-b border-[var(--border-subtle)] pb-3 md:grid-cols-[minmax(0,1fr)_auto] md:items-center">
                  <label className="flex min-h-11 cursor-pointer items-center gap-3 rounded px-2 hover:bg-[var(--bg-subtle)]">
                    <input type="checkbox" checked={checked} disabled={listeningBusy} onChange={() => state.toggleListeningSegment(index)} className="h-5 w-5 accent-[var(--accent)]" />
                    <span className="min-w-0 text-sm"><strong className="font-mono">段 {index + 1}</strong><span className="ml-2 text-[var(--fg-tertiary)]">{formatMs(segment.durationMs)} · {segment.text}</span></span>
                    <span className="sr-only">{checked ? "已听" : "未听"}</span>
                  </label>
                  <button type="button" onClick={() => selectSegment(index)} className="min-h-11 rounded border border-[var(--border-subtle)] px-3 text-sm font-semibold hover:bg-[var(--bg-subtle)]">试听此段</button>
                </div>;
              })}
            </div>
            <div className="mt-5 grid gap-3">
              <h4 className="text-sm font-semibold">专名读音核对</h4>
              {listening.requiredProperNouns.length ? listening.requiredProperNouns.map((item) => {
                const checked = state.checkedProperNouns.has(item.term);
                return <div key={item.term} className="grid gap-2 border-b border-[var(--border-subtle)] pb-3 md:grid-cols-[minmax(0,1fr)_auto] md:items-center">
                  <label className="flex min-h-11 cursor-pointer items-center gap-3 rounded px-2 hover:bg-[var(--bg-subtle)]">
                    <input type="checkbox" checked={checked} disabled={listeningBusy} onChange={() => state.toggleProperNoun(item.term)} className="h-5 w-5 accent-[var(--accent)]" />
                    <span className="text-sm"><strong>{item.term}</strong><span className="ml-2 font-mono text-xs text-[var(--fg-tertiary)]">{item.pronunciation}</span><span className="ml-2 text-[var(--fg-tertiary)]">命中“{item.matchedText}” · 段 {item.segmentIndex + 1}</span></span>
                    <span className="sr-only">{checked ? "已核对" : "未核对"}</span>
                  </label>
                  <button type="button" onClick={() => selectSegment(item.segmentIndex)} className="min-h-11 rounded border border-[var(--border-subtle)] px-3 text-sm font-semibold hover:bg-[var(--bg-subtle)]">试听命中段</button>
                </div>;
              }) : <p className="text-sm text-[var(--fg-tertiary)]">当前没有可用的专名核对清单；仍需完成代表片段听审。</p>}
            </div>
            <label className="mt-5 grid gap-2 text-sm font-semibold">听审备注（可选）
              <textarea value={state.listeningNotes} disabled={listeningBusy} maxLength={2000} onChange={(event) => state.setListeningNotes(event.target.value)} className="min-h-20 rounded border border-[var(--border-subtle)] bg-[var(--bg-primary)] p-3 font-normal focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--focus)]" placeholder="记录需返修的读音、停连或节奏。" />
            </label>
            <div className="mt-5 grid gap-3 sm:grid-cols-2">
              <button type="button" disabled={listeningBusy || !listeningComplete} onClick={() => void state.submitListeningReview("approve")} className="min-h-11 rounded bg-[var(--accent)] px-4 text-sm font-semibold text-white disabled:opacity-50">{listeningBusy ? "正在处理…" : "通过人工听审"}</button>
              <button type="button" disabled={listeningBusy} onClick={() => void state.submitListeningReview("reject")} className="min-h-11 rounded border border-[var(--border-strong)] px-4 text-sm font-semibold disabled:opacity-50">标记听审不通过</button>
            </div>
            {listening.latestReview ? <p className="mt-4 text-xs text-[var(--fg-tertiary)]">当前身份最新结果：{listening.latestReview.action === "approve" ? "已通过" : "不通过"}{listening.latestReview.notes ? ` · ${listening.latestReview.notes}` : ""}</p> : null}
          </> : null}
        </section>
        <div className="mb-4 flex items-center justify-between gap-3 text-xs">
          <button type="button" disabled={currentPage === 0} onClick={() => setPage((value) => Math.max(0, value - 1))} className="min-h-10 rounded border border-[var(--border-subtle)] px-3 disabled:opacity-50">上一页</button>
          <span>第 {currentPage + 1}/{pageCount} 页 · 每页 {AUDIO_SEGMENTS_PER_PAGE} 段</span>
          <button type="button" disabled={currentPage >= pageCount - 1} onClick={() => setPage((value) => Math.min(pageCount - 1, value + 1))} className="min-h-10 rounded border border-[var(--border-subtle)] px-3 disabled:opacity-50">下一页</button>
        </div>
        <Accordion type="single" collapsible className="grid gap-3">
          {pageSegments.map((segment) => {
            const selected = playingIndex === segment.index;
            return <AccordionItem value={`segment-${segment.index}`} key={segment.index} className={`rounded border ${selected ? "border-[var(--accent)] bg-[var(--bg-subtle)]" : "border-[var(--border-subtle)] bg-[var(--bg-canvas)]"}`}>
              <AccordionTrigger onClick={() => selectSegment(segment.index)}>
                <span className="min-w-0">
                  <span className="block">段 {segment.index + 1}{selected ? " · 当前播放源" : ""}</span>
                  <span className="block truncate text-xs font-normal text-[var(--fg-tertiary)]">{formatMs(segment.durationMs)} · {segment.bytes} bytes · {segment.text}</span>
                </span>
              </AccordionTrigger>
              <AccordionContent>
                <div className="grid gap-3 p-3">
                  <p className="text-sm leading-6">{segment.text}</p>
                  <button type="button" onClick={() => selectSegment(segment.index)} className="min-h-10 justify-self-start rounded border border-[var(--accent)] px-3 text-xs font-semibold text-[var(--accent)]">载入共享播放器</button>
                  <div className="grid gap-1 text-xs text-[var(--fg-tertiary)]">{state.timeline!.cues.filter((cue) => cue.segmentIndex === segment.index).map((cue) => <span key={cue.index}>cue {cue.index + 1} · {formatMs(cue.startMs)} → {formatMs(cue.endMs)} · {cue.text}</span>)}</div>
                </div>
              </AccordionContent>
            </AccordionItem>;
          })}
        </Accordion>
      </>}
    </section>
  </div>;
}

function formatMs(ms: number) { return `${(ms / 1000).toFixed(2)} 秒`; }
