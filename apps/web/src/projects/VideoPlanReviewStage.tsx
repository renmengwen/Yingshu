import { useEffect, useRef, useState } from "react";

import { Alert, AlertDescription } from "../components/ui/alert";
import { Button } from "../components/ui/button";
import { canCancelPlanJob, newVisual, planJobLabel, validateScriptDraft, validateVisualDrafts, videoPlanStageLabel } from "./plan-logic";
import type { VideoScriptParagraph, VideoVisualDraft } from "./types";
import type { useVideoPlan } from "./use-video-plan";
import { isPlanIncompatible, isScriptDirty, isVisualDirty, planReviewGates, syncVisualDrafts } from "./video-plan-review/logic";
import { NarrationReview } from "./video-plan-review/NarrationReview";
import { PlanActionBar, PlanOverview, SourcesRisksDialog } from "./video-plan-review/PlanReviewSupport";
import { VisualReview } from "./video-plan-review/VisualReview";

export function VideoPlanReviewStage({ state }: { state: ReturnType<typeof useVideoPlan> }) {
  const [title, setTitle] = useState("");
  const [summary, setSummary] = useState("");
  const [paragraphs, setParagraphs] = useState<VideoScriptParagraph[]>([]);
  const [visuals, setVisuals] = useState<VideoVisualDraft[]>([]);
  const [validationError, setValidationError] = useState("");
  const [sourcesOpen, setSourcesOpen] = useState(false);
  const sourcesTriggerRef = useRef<HTMLButtonElement>(null);
  const previousVisualRevisionIdRef = useRef<string | null>(null);
  const plan = state.plan;

  useEffect(() => {
    if (!plan) return;
    setTitle(plan.script.title);
    setSummary(plan.script.summary);
    setParagraphs(plan.script.paragraphs);
    setValidationError("");
  }, [plan?.script.id]);

  useEffect(() => {
    if (!plan) {
      previousVisualRevisionIdRef.current = null;
      return;
    }
    const previousVisualRevisionId = previousVisualRevisionIdRef.current;
    // 旁白修订变化不会覆盖本地画面草稿；只有服务端画面修订变化才重新同步。
    setVisuals((current) => syncVisualDrafts(current, previousVisualRevisionId, plan.visual));
    previousVisualRevisionIdRef.current = plan.visual.id;
  }, [plan?.visual.id]);

  const scriptDirty = Boolean(plan && isScriptDirty({ title, summary, paragraphs }, plan.script));
  const visualsDirty = Boolean(plan && isVisualDirty(visuals, plan.visual.visuals));
  const incompatible = Boolean(plan && isPlanIncompatible(plan));
  const approved = Boolean(plan?.approval?.valid);
  const gates = planReviewGates({
    busy: state.busy,
    stale: Boolean(plan?.stale),
    scriptDirty,
    visualDirty: visualsDirty,
    incompatible,
    approved,
  });

  function saveScript() {
    if (!gates.saveScript.allowed) return;
    try {
      setValidationError("");
      void state.saveScript(title.trim(), summary.trim(), validateScriptDraft(title, summary, paragraphs));
    } catch (cause) {
      setValidationError((cause as Error).message);
    }
  }

  function saveVisuals() {
    if (!gates.saveVisual.allowed) return;
    try {
      setValidationError("");
      void state.saveVisuals(validateVisualDrafts(visuals, paragraphs.map((paragraph) => paragraph.id)));
    } catch (cause) {
      setValidationError((cause as Error).message);
    }
  }

  function approve() {
    if (gates.approve.allowed) void state.approve();
  }

  return <section className="p-5 md:p-8" aria-labelledby="plan-stage-heading">
    <div className={`mx-auto max-w-[1440px] ${plan ? "pb-[34rem] sm:pb-[24rem] lg:pb-40" : ""}`}>
      <p className="font-mono text-[11px] text-[var(--accent)]">阶段 02</p>
      <h2 id="plan-stage-heading" className="mt-2 text-xl font-semibold">文案与画面方案</h2>
      <p className="mt-2 text-sm leading-6 text-[var(--fg-secondary)]">方案只用于审核。本阶段不会生成图片、TTS、字幕或 MP4。</p>
      <Alert className="mt-5" variant={state.actionState === "error" ? "destructive" : "default"} role={state.actionState === "error" ? "alert" : "status"} aria-live={state.actionState === "error" ? undefined : "polite"}><AlertDescription>{state.status}</AlertDescription></Alert>
      {validationError ? <Alert className="mt-3" variant="destructive"><AlertDescription>{validationError}。请修正后重试。</AlertDescription></Alert> : null}

      {state.job && !plan ? <section className="mt-6 border-y border-[var(--border-subtle)] py-5" aria-labelledby="plan-job-heading">
        <h3 id="plan-job-heading" className="text-base font-semibold">方案任务</h3>
        <p className="mt-2 font-semibold">{videoPlanStageLabel(state.videoStatus)}</p>
        <p className="mt-2 text-sm leading-6 text-[var(--fg-secondary)]">{planJobLabel(state.job)}</p>
        <p className="mt-2 font-mono text-xs text-[var(--fg-tertiary)]">任务 {state.job.id}</p>
        {canCancelPlanJob(state.job) ? <Button className="mt-4" variant="outline" type="button" disabled={state.busy} onClick={() => void state.cancel()}>{state.busy ? "正在处理中…" : "中断生成"}</Button> : null}
      </section> : null}

      {!plan && state.loaded && !state.job ? <div className="mt-8 border-y border-[var(--border-subtle)] py-10 text-center"><p className="text-sm text-[var(--fg-secondary)]">尚无可审核方案。返回输入阶段保存草稿后创建任务。</p></div> : null}

      {plan ? <div className="mt-6 grid gap-8">
        <PlanOverview plan={plan} sourceCount={state.sources.length} incompatible={incompatible} />

        <div className="flex flex-col gap-3 border-b border-[var(--border-subtle)] pb-5 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h3 className="text-base font-semibold">来源与风险</h3>
            <p className="mt-1 text-sm text-[var(--fg-secondary)]">{state.sources.length} 条冻结来源 · {plan.script.risks.length} 项待核对。</p>
          </div>
          <Button ref={sourcesTriggerRef} variant="outline" type="button" onClick={() => setSourcesOpen(true)}>查看来源与风险详情</Button>
        </div>

        <NarrationReview
          title={title}
          summary={summary}
          paragraphs={paragraphs}
          visuals={visuals}
          busy={state.busy || plan.stale}
          onApplyMetadata={(nextTitle, nextSummary) => { setTitle(nextTitle); setSummary(nextSummary); }}
          onApplyParagraph={(paragraph) => setParagraphs((current) => current.map((item) => item.id === paragraph.id ? paragraph : item))}
        />

        <VisualReview
          visuals={visuals}
          paragraphs={paragraphs}
          busy={state.busy || plan.stale}
          incompatible={incompatible}
          onApplyVisual={(visual) => setVisuals((current) => current.map((item) => item.id === visual.id ? visual : item))}
          onAddVisual={() => setVisuals((current) => [...current, newVisual(paragraphs[0]!.id, current.length + 1)])}
          onDeleteVisual={(visualId) => setVisuals((current) => current.filter((item) => item.id !== visualId))}
        />

        <SourcesRisksDialog
          open={sourcesOpen}
          onOpenChange={setSourcesOpen}
          triggerRef={sourcesTriggerRef}
          webEnabled={state.webEnabled}
          sources={state.sources}
          sourceSummary={plan.script.sourceSummary}
          risks={plan.script.risks}
        />

        <PlanActionBar
          gates={gates}
          busy={state.busy}
          approved={approved && !scriptDirty && !visualsDirty}
          incompatible={incompatible}
          stale={plan.stale}
          onSaveScript={saveScript}
          onSaveVisuals={saveVisuals}
          onApprove={approve}
        />
      </div> : null}
    </div>
  </section>;
}
