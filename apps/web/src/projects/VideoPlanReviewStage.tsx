import { useEffect, useMemo, useState } from "react";

import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from "../components/ui/accordion";
import { canCancelPlanJob, narrationFromParagraphs, newVisual, planJobLabel, validateScriptDraft, validateVisualDrafts, videoPlanStageLabel } from "./plan-logic";
import type { VideoScriptParagraph, VideoVisualDraft } from "./types";
import type { useVideoPlan } from "./use-video-plan";

const inputClass = "mt-2 min-h-11 w-full rounded border border-[var(--border-strong)] bg-[var(--bg-canvas)] px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus)] disabled:opacity-60";
const textareaClass = `${inputClass} min-h-28 leading-6`;
const secondaryButton = "min-h-11 rounded border border-[var(--border-strong)] px-4 text-sm font-semibold hover:bg-[var(--bg-subtle)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus)] disabled:cursor-not-allowed disabled:opacity-50";

export function VideoPlanReviewStage({ state }: { state: ReturnType<typeof useVideoPlan> }) {
  const [title, setTitle] = useState("");
  const [summary, setSummary] = useState("");
  const [paragraphs, setParagraphs] = useState<VideoScriptParagraph[]>([]);
  const [visuals, setVisuals] = useState<VideoVisualDraft[]>([]);
  const [validationError, setValidationError] = useState("");
  const plan = state.plan;

  useEffect(() => {
    if (!plan) return;
    setTitle(plan.script.title);
    setSummary(plan.script.summary);
    setParagraphs(plan.script.paragraphs);
    setVisuals(plan.visual.visuals);
    setValidationError("");
  }, [plan?.script.id, plan?.visual.id]);

  const scriptDirty = Boolean(plan && JSON.stringify({ title, summary, paragraphs }) !== JSON.stringify({ title: plan.script.title, summary: plan.script.summary, paragraphs: plan.script.paragraphs }));
  const visualsDirty = Boolean(plan && JSON.stringify(visuals) !== JSON.stringify(plan.visual.visuals));
  const incompatible = Boolean(plan && (plan.visual.scriptRevisionId !== plan.script.id || plan.visual.scriptContentHash !== plan.script.contentHash));
  const narration = useMemo(() => narrationFromParagraphs(paragraphs), [paragraphs]);

  function saveScript() {
    try {
      setValidationError("");
      void state.saveScript(title.trim(), summary.trim(), validateScriptDraft(title, summary, paragraphs));
    } catch (cause) { setValidationError((cause as Error).message); }
  }

  function saveVisuals() {
    try {
      setValidationError("");
      void state.saveVisuals(validateVisualDrafts(visuals, paragraphs.map((paragraph) => paragraph.id)));
    } catch (cause) { setValidationError((cause as Error).message); }
  }

  return <section className="p-5 md:p-8" aria-labelledby="plan-stage-heading">
    <div className="mx-auto max-w-5xl">
      <p className="font-mono text-[11px] text-[var(--accent)]">阶段 02</p>
      <h2 id="plan-stage-heading" className="mt-2 text-xl font-semibold">文案与画面方案</h2>
      <p className="mt-2 text-sm leading-6 text-[var(--fg-secondary)]">方案只用于审核。本阶段不会生成图片、TTS、字幕或 MP4。</p>
      <div className={`mt-5 min-h-11 border px-3 py-3 text-sm ${state.actionState === "error" ? "border-[var(--danger)] bg-[var(--danger-soft)] text-[var(--danger)]" : "border-[var(--border-subtle)] bg-[var(--bg-subtle)] text-[var(--fg-secondary)]"}`} role={state.actionState === "error" ? "alert" : "status"} aria-live={state.actionState === "error" ? undefined : "polite"}>{state.status}</div>
      {validationError ? <p className="mt-3 border border-[var(--danger)] bg-[var(--danger-soft)] px-3 py-3 text-sm text-[var(--danger)]" role="alert">{validationError}。请修正后重试。</p> : null}

      {state.job && !plan ? <section className="mt-6 border-y border-[var(--border-subtle)] py-5" aria-labelledby="plan-job-heading">
        <h3 id="plan-job-heading" className="text-base font-semibold">方案任务</h3>
        <p className="mt-2 font-semibold">{videoPlanStageLabel(state.videoStatus)}</p>
        <p className="mt-2 text-sm leading-6 text-[var(--fg-secondary)]">{planJobLabel(state.job)}</p>
        <p className="mt-2 font-mono text-xs text-[var(--fg-tertiary)]">任务 {state.job.id}</p>
        {canCancelPlanJob(state.job) ? <button className={`${secondaryButton} mt-4`} type="button" disabled={state.busy} onClick={() => void state.cancel()}>{state.busy ? "正在处理中…" : "中断生成"}</button> : null}
      </section> : null}

      {!plan && state.loaded && !state.job ? <div className="mt-8 border-y border-[var(--border-subtle)] py-10 text-center"><p className="text-sm text-[var(--fg-secondary)]">尚无可审核方案。返回输入阶段保存草稿后创建任务。</p></div> : null}
      {plan ? <div className="mt-6 grid gap-7">
        <section className="border-y border-[var(--border-subtle)] py-5" aria-labelledby="plan-summary-heading">
          <div className="flex flex-wrap items-start justify-between gap-3"><div><h3 id="plan-summary-heading" className="text-base font-semibold">当前方案</h3><p className="mt-1 font-mono text-xs text-[var(--fg-tertiary)]">旁白修订 {plan.script.revision} · 画面修订 {plan.visual.revision}</p></div><span className="rounded border border-[var(--border-strong)] px-2 py-1 text-xs">{plan.stale ? "已失效" : plan.approval?.valid ? "已批准" : "等待批准"}</span></div>
          <dl className="mt-4 grid gap-3 bg-[var(--bg-subtle)] px-4 py-4 text-sm sm:grid-cols-3"><div><dt className="text-[var(--fg-tertiary)]">估算字数</dt><dd className="mt-1 font-mono">{plan.script.estimatedCharacters} 字</dd></div><div><dt className="text-[var(--fg-tertiary)]">估算时长</dt><dd className="mt-1 font-mono">约 {plan.script.estimatedDurationSeconds} 秒</dd></div><div><dt className="text-[var(--fg-tertiary)]">联网状态</dt><dd className="mt-1">{plan.webEnabled ? "已保存联网来源" : "本次未联网核验"}</dd></div></dl>
          {plan.stale ? <p className="mt-4 text-sm text-[var(--warning)]" role="alert">生成输入已经变化，当前方案已失效。请返回输入阶段重新生成，旧方案不能批准或用于后续生产。</p> : null}
        </section>

        <section aria-labelledby="script-editor-heading"><h3 id="script-editor-heading" className="text-base font-semibold">旁白</h3><p className="mt-2 text-sm text-[var(--fg-secondary)]">按稳定段落编辑；保存会创建新修订，不覆盖历史。</p>
          <div className="mt-4 grid gap-4 sm:grid-cols-2"><label className="text-sm font-semibold">标题建议<input className={inputClass} disabled={state.busy} value={title} onChange={(event) => setTitle(event.target.value)} /></label><label className="text-sm font-semibold">摘要<textarea className={textareaClass} disabled={state.busy} value={summary} onChange={(event) => setSummary(event.target.value)} /></label></div>
          <div className="mt-5 border-t border-[var(--border-subtle)]"><h4 className="py-4 text-sm font-semibold">完整旁白（按段落编辑）</h4>{paragraphs.map((paragraph, index) => <label className="block border-t border-[var(--border-subtle)] py-4 text-sm font-semibold" key={paragraph.id}><span className="font-mono text-xs text-[var(--fg-tertiary)]">段落 {String(index + 1).padStart(2, "0")} · {paragraph.id}</span><textarea aria-label={`旁白段落 ${index + 1}`} className={`${textareaClass} min-h-36 font-[var(--font-reading)]`} disabled={state.busy} value={paragraph.text} onChange={(event) => setParagraphs((current) => current.map((item) => item.id === paragraph.id ? { ...item, text: event.target.value } : item))} /></label>)}</div>
          <details className="border-t border-[var(--border-subtle)] py-3"><summary className="flex min-h-11 cursor-pointer items-center text-sm font-semibold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus)]">预览合并后的完整旁白</summary><p className="whitespace-pre-wrap py-4 font-[var(--font-reading)] text-sm leading-8">{narration}</p></details>
          <button className={`${secondaryButton} mt-4`} type="button" disabled={state.busy || !scriptDirty} onClick={saveScript}>{state.busy && scriptDirty ? "正在保存旁白…" : "保存旁白修订"}</button>
        </section>

        <Accordion type="multiple" defaultValue={["sources", "risks"]} className="border-y border-[var(--border-subtle)]">
          <AccordionItem value="sources"><AccordionTrigger>来源与资料摘要</AccordionTrigger><AccordionContent className="px-3 py-4">{state.webEnabled ? state.sources.length ? <ul className="divide-y divide-[var(--border-subtle)]">{state.sources.map((source) => <li className="py-4 first:pt-0 last:pb-0" key={source.id}><a className="font-semibold text-[var(--accent)] underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus)]" href={source.url} target="_blank" rel="noreferrer">{source.title}</a><p className="mt-1 break-all font-mono text-xs text-[var(--fg-tertiary)]">{source.url}</p><p className="mt-2 text-sm leading-6 text-[var(--fg-secondary)]">{source.usageSummary}</p><p className="mt-2 text-xs text-[var(--fg-tertiary)]">检索于 {new Date(source.retrievedAt).toLocaleString("zh-CN")}</p></li>)}</ul> : <p className="text-sm text-[var(--fg-secondary)]">本次允许联网，但没有保存可用来源。</p> : <p className="text-sm text-[var(--fg-secondary)]">本次未联网核验，未调用外部搜索，也没有生成来源 URL。</p>}{plan.script.sourceSummary.length ? <ul className="mt-4 list-disc space-y-2 pl-5 text-sm text-[var(--fg-secondary)]">{plan.script.sourceSummary.map((item, index) => <li key={`${index}:${item}`}>{item}</li>)}</ul> : null}</AccordionContent></AccordionItem>
          <AccordionItem value="risks"><AccordionTrigger>风险与待核对项（{plan.script.risks.length}）</AccordionTrigger><AccordionContent className="px-3 py-4">{plan.script.risks.length ? <ul className="list-disc space-y-2 pl-5 text-sm text-[var(--fg-secondary)]">{plan.script.risks.map((risk, index) => <li key={`${index}:${risk}`}>{risk}</li>)}</ul> : <p className="text-sm text-[var(--fg-secondary)]">当前方案没有标记待核对项。</p>}</AccordionContent></AccordionItem>
        </Accordion>

        <section aria-labelledby="visual-editor-heading"><div className="flex flex-wrap items-end justify-between gap-3"><div><h3 id="visual-editor-heading" className="text-base font-semibold">画面方案</h3><p className="mt-2 text-sm text-[var(--fg-secondary)]">所有画面均为“未生成”，当前候选为空。图片内可读文字由后续渲染层处理。</p></div><button className={secondaryButton} type="button" disabled={state.busy || !paragraphs.length} onClick={() => setVisuals((current) => [...current, newVisual(paragraphs[0]!.id, current.length + 1)])}>增加画面</button></div>
          <div className="mt-4 border-t border-[var(--border-subtle)]">{visuals.map((visual, index) => <fieldset className="grid gap-4 border-b border-[var(--border-subtle)] py-5" disabled={state.busy} key={visual.id}><legend className="sr-only">画面 {index + 1}</legend><div className="flex flex-wrap items-center justify-between gap-3"><p className="font-mono text-xs text-[var(--fg-tertiary)]">画面 {String(index + 1).padStart(2, "0")} · {visual.id} · 未生成</p><button className="min-h-11 px-3 text-sm font-semibold text-[var(--danger)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus)] disabled:opacity-50" type="button" disabled={visuals.length === 1} onClick={() => setVisuals((current) => current.filter((item) => item.id !== visual.id))}>删除画面</button></div><div className="grid gap-4 sm:grid-cols-2"><label className="text-sm font-semibold">关联旁白段落<select className={inputClass} value={visual.paragraphId} onChange={(event) => setVisuals((current) => current.map((item) => item.id === visual.id ? { ...item, paragraphId: event.target.value } : item))}>{paragraphs.map((paragraph, paragraphIndex) => <option value={paragraph.id} key={paragraph.id}>段落 {paragraphIndex + 1} · {paragraph.id}</option>)}</select></label><label className="text-sm font-semibold">画面用途<input className={inputClass} value={visual.purpose} onChange={(event) => setVisuals((current) => current.map((item) => item.id === visual.id ? { ...item, purpose: event.target.value } : item))} /></label></div><label className="text-sm font-semibold">中文画面描述<textarea className={textareaClass} value={visual.description} onChange={(event) => setVisuals((current) => current.map((item) => item.id === visual.id ? { ...item, description: event.target.value } : item))} /></label><label className="text-sm font-semibold">最终生图 prompt<textarea className={textareaClass} value={visual.prompt} onChange={(event) => setVisuals((current) => current.map((item) => item.id === visual.id ? { ...item, prompt: event.target.value } : item))} /></label><label className="text-sm font-semibold">负面 prompt<textarea className={inputClass} value={visual.negativePrompt} onChange={(event) => setVisuals((current) => current.map((item) => item.id === visual.id ? { ...item, negativePrompt: event.target.value } : item))} /></label></fieldset>)}</div>
          {scriptDirty ? <p className="mt-4 text-sm text-[var(--warning)]">请先保存旁白修订，再让画面方案绑定新的旁白版本。</p> : null}<button className={`${secondaryButton} mt-4`} type="button" disabled={state.busy || scriptDirty || (!visualsDirty && !incompatible)} onClick={saveVisuals}>{state.busy && visualsDirty ? "正在保存画面…" : incompatible ? "保存兼容画面修订" : "保存画面修订"}</button>
        </section>

        <section className="border-t border-[var(--border-subtle)] pt-6" aria-labelledby="approve-heading"><h3 id="approve-heading" className="text-base font-semibold">人工批准</h3><p className="mt-2 text-sm leading-6 text-[var(--fg-secondary)]">批准只绑定当前输入快照、旁白修订和画面修订，不会启动图片生成、TTS 或后续生产。</p>{scriptDirty || visualsDirty || incompatible ? <p className="mt-3 text-sm text-[var(--warning)]">请先保存全部编辑，并让画面方案绑定当前旁白修订，再批准同一组兼容版本。</p> : null}<button className="mt-5 min-h-11 rounded bg-[var(--accent)] px-5 text-sm font-semibold text-[var(--accent-contrast)] hover:bg-[var(--accent-strong)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus)] disabled:cursor-not-allowed disabled:opacity-50" type="button" disabled={state.busy || plan.stale || scriptDirty || visualsDirty || incompatible || Boolean(plan.approval?.valid)} onClick={() => void state.approve()}>{plan.approval?.valid ? "当前方案已批准" : state.busy ? "正在批准…" : "批准当前方案"}</button></section>
      </div> : null}
    </div>
  </section>;
}
