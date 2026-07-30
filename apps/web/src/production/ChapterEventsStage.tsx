import { useEffect, useState } from "react";

import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "../components/ui/accordion";
import {
  CHAPTER_EVENT_TYPE_OPTIONS,
  chapterEventDraft,
  emptyChapterEventDraft,
  type ChapterEventDraft,
} from "./chapter-event-editor";
import type { Chapter, ChapterEvent } from "./types";

const eventTypeLabel = new Map(CHAPTER_EVENT_TYPE_OPTIONS.map((option) => [option.value, option.label]));

export function ChapterEventsStage({ chapters, total, selected, text, events, locked, readOnly = false, onSelect, onSave, onAnalyze }: { chapters: Chapter[]; total: number; selected?: Chapter; text: string; events: ChapterEvent[]; locked: boolean; readOnly?: boolean; onSelect: (id: string) => void; onSave: (drafts: ChapterEventDraft[]) => void; onAnalyze: () => void }) {
  const [drafts, setDrafts] = useState<ChapterEventDraft[]>([]);
  const editingLocked = locked || readOnly;

  useEffect(() => { setDrafts(events.map(chapterEventDraft)); }, [events]);

  function updateDraft(index: number, change: Partial<ChapterEventDraft>) {
    setDrafts((current) => current.map((draft, draftIndex) => draftIndex === index ? { ...draft, ...change } : draft));
  }

  return <div className="grid min-h-[calc(100vh-344px)] grid-cols-[minmax(230px,.72fr)_minmax(480px,1.45fr)_minmax(360px,1fr)] max-md:grid-cols-1">
    <section className="min-w-0 border-r border-[var(--border-subtle)] max-md:border-r-0 max-md:border-b" aria-labelledby="production-chapters-heading">
      <div className="flex h-12 items-center justify-between border-b border-[var(--border-subtle)] px-4"><h2 id="production-chapters-heading" className="text-xs font-bold tracking-wider">章节范围</h2><span className="font-mono text-[10px] text-[var(--fg-tertiary)]">{chapters.length}/{total}</span></div>
      <div className="max-h-[calc(100vh-392px)] overflow-y-auto p-2">{chapters.map((chapter) => <button key={chapter.id} type="button" disabled={locked} className={`flex min-h-11 w-full items-center gap-3 rounded px-3 text-left hover:bg-[var(--bg-subtle)] ${selected?.id === chapter.id ? "bg-[var(--bg-subtle)] ring-1 ring-[var(--border-strong)]" : ""}`} onClick={() => onSelect(chapter.id)}><span className="font-mono text-[10px] text-[var(--fg-tertiary)]">{String(chapter.chapter_index + 1).padStart(3, "0")}</span><span className="truncate text-sm">{chapter.title}</span></button>)}</div>
    </section>
    <section className="min-w-0 border-r border-[var(--border-subtle)] p-[clamp(26px,4vw,52px)] max-md:border-r-0 max-md:border-b" aria-labelledby="events-heading">
      <p className="mb-2 font-mono text-[11px] font-semibold tracking-[.17em] text-[var(--accent)]">STRUCTURED EVIDENCE</p><h2 id="events-heading" className="m-0 max-w-3xl font-serif text-[clamp(28px,3.6vw,50px)] font-semibold leading-[1.13] tracking-[-.04em]">章节事件是后续生产的证据索引。</h2><p className="my-6 max-w-3xl text-sm leading-7 text-[var(--fg-secondary)]">先核对人物、地点、冲突、转折和线索，再进入故事弧；所有改编必须能回到原文字节范围。</p>
      <div className="border-t border-[var(--border-subtle)]">
        {readOnly ? <p className="m-0 border-b border-[var(--border-subtle)] bg-[var(--bg-subtle)] px-4 py-3 text-sm text-[var(--fg-secondary)]" role="status">全本流水线运行期间章节事件只读；暂停流水线后可修复。你仍可浏览不同章节及其原文证据。</p> : null}
        {selected ? <div className="flex flex-wrap items-center gap-3 border-b border-[var(--border-subtle)] py-4">
          <button type="button" disabled={editingLocked} className="rounded border border-[var(--accent)] px-3 py-2 text-xs font-semibold text-[var(--accent)] disabled:opacity-50" onClick={onAnalyze}>自动分析本章</button>
          <button type="button" disabled={editingLocked} className="rounded border border-[var(--border-strong)] px-3 py-2 text-xs font-semibold disabled:opacity-50" onClick={() => setDrafts((current) => [...current, emptyChapterEventDraft(selected)])}>添加人工事件</button>
          <button type="button" disabled={editingLocked} className="rounded bg-[var(--accent)] px-3 py-2 text-xs font-semibold text-white disabled:opacity-50" onClick={() => onSave(drafts)}>保存为持久任务</button>
          <span className="text-[11px] text-[var(--fg-tertiary)]">自动分析只引用服务端冻结的原文证据段；人工保存入口保持独立。章节字节范围 {selected.byte_start}～{selected.byte_end}</span>
        </div> : null}
        <Accordion type="multiple" className="grid gap-3 py-4">
        {drafts.map((draft, index) => <AccordionItem className="rounded border border-[var(--border-subtle)] bg-[var(--bg-canvas)]" key={draft.key} value={draft.key}>
          <AccordionTrigger>
            <span className="min-w-0">
              <span className="block">{eventTypeLabel.get(draft.type) ?? draft.type} · {eventSummary(draft)}</span>
              <span className="block truncate text-xs font-normal text-[var(--fg-tertiary)]">事件 {index + 1} · {draft.sources.length} 个证据范围{editingLocked ? " · 已锁定" : ""}</span>
            </span>
          </AccordionTrigger>
          <AccordionContent>
          <div className="grid grid-cols-[120px_minmax(0,1fr)_auto] gap-3 p-3 max-md:grid-cols-1">
            <label className="text-xs text-[var(--fg-secondary)]">事件类型<select aria-label={`事件 ${index + 1} 类型`} disabled={editingLocked} value={draft.type} onChange={(event) => updateDraft(index, { type: event.target.value as ChapterEventDraft["type"] })} className="mt-1 block w-full rounded border border-[var(--border-subtle)] bg-[var(--bg-canvas)] p-2 text-sm">{CHAPTER_EVENT_TYPE_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select></label>
            <div className="grid grid-cols-2 gap-3 max-md:grid-cols-1">
              <label className="text-xs text-[var(--fg-secondary)]">{draft.type === "causality" ? "原因" : draft.type === "revelation" ? "揭示内容" : draft.type === "suspense" ? "悬念问题" : "名称"}<input aria-label={`事件 ${index + 1} 主要内容`} disabled={editingLocked} value={draft.primary} onChange={(event) => updateDraft(index, { primary: event.target.value })} className="mt-1 block w-full rounded border border-[var(--border-subtle)] bg-[var(--bg-canvas)] p-2 text-sm" /></label>
              {draft.type === "causality" || draft.type === "character" || draft.type === "location" || draft.type === "prop" ? <label className="text-xs text-[var(--fg-secondary)]">{draft.type === "causality" ? "结果" : "详情（可选）"}<input aria-label={`事件 ${index + 1} 次要内容`} disabled={editingLocked} value={draft.secondary} onChange={(event) => updateDraft(index, { secondary: event.target.value })} className="mt-1 block w-full rounded border border-[var(--border-subtle)] bg-[var(--bg-canvas)] p-2 text-sm" /></label> : null}
            </div>
            <button type="button" disabled={editingLocked} className="self-end px-2 py-2 text-xs text-[var(--accent)] disabled:opacity-50" onClick={() => setDrafts((current) => current.filter((_, draftIndex) => draftIndex !== index))}>移除事件</button>
          </div>
          <div className="space-y-2 px-3 pb-3">{draft.sources.map((source, sourceIndex) => <div className="grid grid-cols-[1fr_1fr_auto] gap-2" key={`${draft.key}-${sourceIndex}`}>
            <label className="text-xs text-[var(--fg-secondary)]">证据起始字节<input aria-label={`事件 ${index + 1} 证据 ${sourceIndex + 1} 起始字节`} type="number" disabled={editingLocked} value={source.byteStart} onChange={(event) => updateDraft(index, { sources: draft.sources.map((item, itemIndex) => itemIndex === sourceIndex ? { ...item, byteStart: Number(event.target.value) } : item) })} className="mt-1 block w-full rounded border border-[var(--border-subtle)] bg-[var(--bg-canvas)] p-2 font-mono text-xs" /></label>
            <label className="text-xs text-[var(--fg-secondary)]">证据结束字节<input aria-label={`事件 ${index + 1} 证据 ${sourceIndex + 1} 结束字节`} type="number" disabled={editingLocked} value={source.byteEnd} onChange={(event) => updateDraft(index, { sources: draft.sources.map((item, itemIndex) => itemIndex === sourceIndex ? { ...item, byteEnd: Number(event.target.value) } : item) })} className="mt-1 block w-full rounded border border-[var(--border-subtle)] bg-[var(--bg-canvas)] p-2 font-mono text-xs" /></label>
            <button type="button" disabled={editingLocked || draft.sources.length === 1} className="self-end px-2 py-2 text-xs text-[var(--accent)] disabled:opacity-50" onClick={() => updateDraft(index, { sources: draft.sources.filter((_, itemIndex) => itemIndex !== sourceIndex) })}>移除证据</button>
          </div>)}</div>
          <button type="button" disabled={editingLocked} className="mx-3 mb-3 text-xs font-semibold text-[var(--accent)] disabled:opacity-50" onClick={() => updateDraft(index, { sources: [...draft.sources, { byteStart: selected!.byte_start, byteEnd: selected!.byte_end }] })}>添加证据范围</button>
          </AccordionContent>
        </AccordionItem>)}
        </Accordion>
        {selected && !drafts.length && !editingLocked ? <p className="m-7 text-[13px] text-[var(--fg-tertiary)]">本章还没有结构化事件。可添加人工事件；保存空列表会清空本章已有事件。</p> : null}{!selected ? <p className="m-7 text-[13px] text-[var(--fg-tertiary)]">选择章节后查看结构化事件和原文证据。</p> : null}
      </div>
    </section>
    <section className="min-w-0 bg-[color-mix(in_srgb,var(--bg-surface)_86%,var(--bg-canvas))]" aria-labelledby="production-evidence-heading"><div className="flex h-12 items-center justify-between border-b border-[var(--border-subtle)] px-4"><h2 id="production-evidence-heading" className="text-xs font-bold tracking-wider">原文证据</h2><span className="font-mono text-[10px] text-[var(--fg-tertiary)]">READ ONLY</span></div><pre className="m-0 max-h-[calc(100vh-392px)] overflow-auto whitespace-pre-wrap p-[clamp(20px,4vw,44px)] font-serif text-[15px] leading-8 text-[var(--fg-secondary)]">{text || "选择章节后在此查看原文。"}</pre></section>
  </div>;
}

function eventSummary(draft: ChapterEventDraft) {
  return [draft.primary, draft.secondary].filter(Boolean).join(" / ") || "未填写摘要";
}
