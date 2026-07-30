import { useState } from "react";

import type { Chapter, JobRecord } from "../types";
import { recommendationChapterSummaries } from "./episode-editor";
import { useEpisodeWorkspace } from "./use-episode-workspace";

function summary(payload: Record<string, string>) { return Object.values(payload).filter(Boolean).join(" → "); }

export function EpisodeStage({
  bookId, seriesId, episodeIndex, chapters, startChapterId, currentJob, busy, setBusy, setStatus,
  onStartChapterChange, onJobCreated, onOpenScripts,
}: {
  bookId: string; seriesId: string; episodeIndex: number; chapters: Chapter[]; startChapterId?: string;
  currentJob?: JobRecord; busy: boolean; setBusy: (busy: boolean) => void;
  setStatus: (message: string) => void;
  onStartChapterChange: (id: string | undefined) => void; onJobCreated: (id?: string) => void;
  onOpenScripts: () => void;
}) {
  const [endingPreference, setEndingPreference] = useState("");
  const state = useEpisodeWorkspace({
    bookId, seriesId, episodeIndex, startChapterId, currentJob, busy, setBusy, setStatus, onJobCreated,
  });
  const selected = new Set(state.draft.sourceEventIds);
  const chapterTitle = new Map(chapters.map((chapter) => [chapter.id, `${chapter.chapter_index + 1}. ${chapter.title}`]));
  const recommendationChapters = recommendationChapterSummaries(state.recommendation);
  const persistedChapters = [...new Set(state.episode?.sources.map((source) => source.chapterId) ?? [])];
  const toggle = (id: string) => state.updateDraft({
    sourceEventIds: selected.has(id)
      ? state.draft.sourceEventIds.filter((item) => item !== id)
      : [...state.draft.sourceEventIds, id],
  });
  const activeJob = currentJob?.type === "episode_sources_recommend" &&
    (currentJob.status === "queued" || currentJob.status === "running");

  return <div className="grid min-h-[calc(100vh-344px)] grid-cols-[minmax(300px,.9fr)_minmax(460px,1.2fr)_minmax(360px,1fr)] max-md:grid-cols-1">
    <section className="border-r border-[var(--border-subtle)] p-6 max-md:border-r-0 max-md:border-b">
      <div className="grid grid-cols-2 gap-3">
        <label className="text-xs text-[var(--fg-secondary)]">故事起点<select aria-label="故事起点" disabled={busy} value={startChapterId ?? ""} onChange={(event) => onStartChapterChange(event.target.value || undefined)} className="mt-1 block w-full rounded border border-[var(--border-subtle)] bg-[var(--bg-canvas)] p-2"><option value="">{episodeIndex > 1 ? "从上一集边界继续" : "从故事开头开始"}</option>{chapters.map((chapter) => <option key={chapter.id} value={chapter.id}>{chapter.chapter_index + 1}. {chapter.title}</option>)}</select></label>
      </div>
      <label className="mt-4 block text-xs text-[var(--fg-secondary)]">结尾倾向（可选）<input disabled={busy} value={endingPreference} onChange={(event) => setEndingPreference(event.target.value)} placeholder="例如：在揭示前留下悬念" className="mt-1 block w-full rounded border border-[var(--border-subtle)] bg-[var(--bg-canvas)] p-3 text-sm" /></label>
      <button type="button" disabled={busy || activeJob} onClick={() => void state.recommend(endingPreference)} className="mt-4 rounded border border-[var(--accent)] px-4 py-3 text-sm font-semibold text-[var(--accent)] disabled:opacity-50">{activeJob ? "正在推荐…" : "推荐连续章节与事件"}</button>
      <p className="mt-3 text-xs leading-6 text-[var(--fg-tertiary)]">推荐只读取逐章结构化事件摘要，不拼接多章全文；未确认前不会写入 Episode。</p>
      {state.recommendation ? <div className="mt-6 border-t border-[var(--border-subtle)] pt-4">
        {state.recommendation.status === "recommended" ? <>
          <p className="text-sm font-semibold">多章范围：{chapterTitle.get(state.recommendation.startChapterId) ?? state.recommendation.startChapterId} → {chapterTitle.get(state.recommendation.endChapterId ?? "") ?? state.recommendation.endChapterId}</p>
          <p className="mt-2 text-xs text-[var(--fg-secondary)]">{state.recommendation.chapterIds?.length} 章 · 预计 {state.recommendation.estimatedCharacterCount} 字 / {state.recommendation.estimatedDurationSeconds} 秒 · 建议{state.recommendation.advice}</p>
          <div className="mt-4 rounded border border-[var(--border-subtle)] bg-[var(--bg-canvas)] p-3">
            <p className="text-xs font-semibold">逐章摘要</p>
            <div className="mt-2 space-y-2">{recommendationChapters.map((chapter) => <p key={chapter.chapterId} className="text-xs leading-5 text-[var(--fg-secondary)]"><b>{chapterTitle.get(chapter.chapterId) ?? chapter.chapterId}</b> · {chapter.eventCount} 个事件 · {chapter.summary}</p>)}</div>
          </div>
          <div className="mt-4 space-y-2">{state.recommendation.events?.map((event) => <label key={event.id} className="flex gap-3 rounded border border-[var(--border-subtle)] p-3 text-sm"><input type="checkbox" disabled={busy} checked={selected.has(event.id)} onChange={() => toggle(event.id)} /><span><b className="block text-xs">{event.chapterId} · {event.type}</b>{summary(event.payload)}</span></label>)}</div>
        </> : null}
        {state.recommendation.missingChapters.map((chapter) => <div key={chapter.id} className="mt-3 rounded border border-[var(--border-subtle)] p-3 text-xs text-[var(--fg-secondary)]"><p>缺少事件分析：{chapter.title}（{chapter.id}），不能当作无剧情。</p><button type="button" disabled={busy} onClick={() => void state.analyzeMissing(chapter.id)} className="mt-2 font-semibold text-[var(--accent)] disabled:opacity-50">复用单章分析任务补齐</button></div>)}
      </div> : null}
    </section>
    <section className="border-r border-[var(--border-subtle)] p-[clamp(26px,4vw,52px)] max-md:border-r-0 max-md:border-b">
      <p className="mb-2 font-mono text-[11px] font-semibold tracking-[.17em] text-[var(--accent)]">EPISODE SOURCES</p><h2 className="m-0 font-serif text-[clamp(30px,4vw,54px)] font-semibold leading-none tracking-[-.045em]">第 {episodeIndex} 集</h2>
      <div className="mt-8 space-y-4">
        <label className="block text-xs text-[var(--fg-secondary)]">标题<input disabled={busy} value={state.draft.title} onChange={(event) => state.updateDraft({ title: event.target.value })} className="mt-1 block w-full rounded border border-[var(--border-subtle)] bg-[var(--bg-canvas)] p-3 text-sm" /></label>
        <label className="block text-xs text-[var(--fg-secondary)]">故事弧<textarea disabled={busy} rows={6} value={state.draft.storyArc} onChange={(event) => state.updateDraft({ storyArc: event.target.value })} className="mt-1 block w-full rounded border border-[var(--border-subtle)] bg-[var(--bg-canvas)] p-3 text-sm leading-6" /></label>
        <label className="block text-xs text-[var(--fg-secondary)]">目标时长（秒）<input type="number" min={state.policy.minimumSeconds} max={state.policy.maximumSeconds} step={state.policy.stepSeconds} disabled={busy} value={state.draft.targetDurationSeconds} onChange={(event) => state.updateDraft({ targetDurationSeconds: Number(event.target.value) })} className="mt-1 block w-full rounded border border-[var(--border-subtle)] bg-[var(--bg-canvas)] p-3 text-sm" /><span className="mt-1 block text-[10px] text-[var(--fg-tertiary)]">技术范围 {state.policy.minimumSeconds}–{state.policy.maximumSeconds}，默认 {state.policy.defaultSeconds}</span></label>
        <label className="block text-xs text-[var(--fg-secondary)]">前情回顾（可选）<textarea disabled={busy} rows={2} value={state.draft.recap} onChange={(event) => state.updateDraft({ recap: event.target.value })} className="mt-1 block w-full rounded border border-[var(--border-subtle)] bg-[var(--bg-canvas)] p-3 text-sm" /></label>
        <label className="block text-xs text-[var(--fg-secondary)]">下集钩子（可选）<textarea disabled={busy} rows={2} value={state.draft.nextHook} onChange={(event) => state.updateDraft({ nextHook: event.target.value })} className="mt-1 block w-full rounded border border-[var(--border-subtle)] bg-[var(--bg-canvas)] p-3 text-sm" /></label>
        <button type="button" disabled={busy || !state.draft.sourceEventIds.length} onClick={() => void state.save()} className="rounded bg-[var(--accent)] px-4 py-3 text-sm font-semibold text-white disabled:opacity-50">{busy ? "处理中…" : "明确确认并保存选材"}</button>
      </div>
    </section>
    <section className="bg-[color-mix(in_srgb,var(--bg-surface)_86%,var(--bg-canvas))]"><div className="flex h-12 items-center justify-between border-b border-[var(--border-subtle)] px-4"><h2 className="text-xs font-bold tracking-wider">持久证据快照</h2><span className="font-mono text-[10px] text-[var(--fg-tertiary)]">READ ONLY</span></div><div className="space-y-4 p-6">
      <div className="rounded border border-[var(--border-subtle)] bg-[var(--bg-canvas)] p-4">
        <p className="text-xs font-semibold">生产入口状态</p>
        {state.episode ? <>
          <p className="mt-2 text-sm leading-6">已冻结 {state.episode.sources.length} 条来源，覆盖 {persistedChapters.length} 章：{persistedChapters.map((id) => chapterTitle.get(id) ?? id).join("、")}</p>
          <button type="button" disabled={busy} onClick={onOpenScripts} className="mt-3 rounded bg-[var(--accent)] px-4 py-2 text-sm font-semibold text-white disabled:opacity-50">进入稿件阶段生成长稿</button>
        </> : <p className="mt-2 text-sm leading-7 text-[var(--fg-tertiary)]">先推荐多章范围、确认来源并保存 Episode；保存后可进入稿件阶段触发 episode_scripts_generate。</p>}
      </div>
      {state.episode?.sources.map((source) => <article key={source.sourceIndex} className="border-b border-[var(--border-subtle)] pb-4">
        <p className="font-mono text-[10px] text-[var(--fg-tertiary)]">{source.chapterId} · {source.byteStart}–{source.byteEnd}</p>
        <details className="mt-2 rounded border border-[var(--border-subtle)] bg-[var(--bg-canvas)]">
          <summary className="min-h-11 cursor-pointer px-3 py-2 text-sm font-semibold focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--focus)]">展开来源快照全文与 SHA-256</summary>
          <div className="border-t border-[var(--border-subtle)] p-3">
            <p className="text-sm leading-6">{source.sourceText}</p>
            <p className="mt-2 break-all font-mono text-[9px] text-[var(--fg-tertiary)]">SHA-256 {source.sourceHash}</p>
          </div>
        </details>
      </article>)}
    </div></section>
  </div>;
}
