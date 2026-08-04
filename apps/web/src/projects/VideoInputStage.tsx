import { Button } from "../components/ui/button";
import { Checkbox } from "../components/ui/checkbox";
import { Field, FieldDescription, FieldLabel, FieldLegend, FieldSet } from "../components/ui/field";
import { RadioGroup, RadioGroupItem } from "../components/ui/radio-group";
import { Textarea } from "../components/ui/textarea";
import type { VideoInputDraft } from "./types";
import { useVideoInput } from "./use-video-input";
import { VideoPlanLauncher } from "./VideoPlanLauncher";
import type { useVideoPlan } from "./use-video-plan";

const choiceClass = "flex min-h-11 cursor-pointer items-center gap-3 rounded-md border border-border px-3 py-2 text-sm has-data-[state=checked]:border-primary has-data-[state=checked]:bg-primary/5";

export function VideoInputStage({ projectId, videoId, planState, onPlanStarted }: { projectId: string; videoId: string; planState: ReturnType<typeof useVideoPlan>; onPlanStarted: () => void }) {
  const state = useVideoInput(projectId, videoId);
  return <VideoInputContent state={state} planState={planState} onPlanStarted={onPlanStarted} />;
}

export function VideoInputContent({ state, planState, onPlanStarted }: { state: ReturnType<typeof useVideoInput>; planState?: ReturnType<typeof useVideoPlan>; onPlanStarted?: () => void }) {
  const update = <K extends keyof VideoInputDraft>(key: K, value: VideoInputDraft[K]) => state.setDraft((current) => current ? { ...current, [key]: value } : current);

  return <section className="p-5 md:p-8" aria-labelledby="input-stage-heading">
    <div className="mx-auto max-w-4xl">
      <p className="font-mono text-[11px] text-[var(--accent)]">阶段 01</p>
      <h2 id="input-stage-heading" className="mt-2 text-xl font-semibold">输入与来源</h2>
      <p className="mt-2 text-sm leading-6 text-[var(--fg-secondary)]">保存当前可编辑草稿。本阶段不会联网、调用模型或生成方案。</p>
      <div className="mt-5 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between"><div id="video-input-status" className={`min-h-11 flex-1 rounded border px-3 py-3 text-sm ${state.error ? "border-[var(--danger)] bg-[var(--danger-soft)] text-[var(--danger)]" : "border-[var(--border-subtle)] bg-[var(--bg-subtle)] text-[var(--fg-secondary)]"}`} role={state.error ? "alert" : "status"} aria-live={state.error ? undefined : "polite"}>{state.status}{state.dirty ? " 有未保存修改。" : ""}</div>{state.draft ? <Button type="submit" form="video-input-form" disabled={state.busy || !state.dirty}>{state.busy ? "正在保存草稿…" : "保存草稿"}</Button> : null}</div>
      {state.draft ? <form id="video-input-form" className="mt-6 grid gap-7" aria-describedby="video-input-status" onSubmit={(event) => { event.preventDefault(); void state.save(); }}>
        <FieldSet disabled={state.busy}>
          <FieldLegend className="mb-0" variant="label">输入模式</FieldLegend>
          <FieldDescription id="input-mode-help">切换模式会保留另一模式中已经填写的内容。</FieldDescription>
          <RadioGroup className="grid gap-2 sm:grid-cols-2" name="input-mode" aria-describedby="input-mode-help" value={state.draft.inputMode} onValueChange={(value) => update("inputMode", value as VideoInputDraft["inputMode"])}>
            {([['topic', '输入主题'], ['body', '粘贴正文']] as const).map(([value, label]) => <FieldLabel className={choiceClass} key={value}><RadioGroupItem value={value} /><span>{label}</span></FieldLabel>)}
          </RadioGroup>
        </FieldSet>

        {state.draft.inputMode === "topic" ? <Field data-invalid={!!state.error}><FieldLabel htmlFor="video-topic">视频主题</FieldLabel><FieldDescription id="video-topic-help">必填，最多200个Unicode字符。</FieldDescription><Textarea id="video-topic" className="min-h-28" required disabled={state.busy} aria-describedby="video-topic-help" aria-invalid={!!state.error} value={state.draft.topic} onChange={(event) => update("topic", event.target.value)} /></Field> : <Field data-invalid={!!state.error}><FieldLabel htmlFor="video-body">视频正文</FieldLabel><FieldDescription id="video-body-help">必填，保留段落换行，最多128KiB（按UTF-8计算）。</FieldDescription><Textarea id="video-body" className="min-h-64" required disabled={state.busy} aria-describedby="video-body-help" aria-invalid={!!state.error} value={state.draft.body} onChange={(event) => update("body", event.target.value)} /></Field>}

        <div className="grid gap-5 border-t border-[var(--border-subtle)] pt-6">
          <Field data-invalid={!!state.error}><FieldLabel htmlFor="reference-text">参考文本（可选）</FieldLabel><FieldDescription id="reference-text-help">最多64KiB（按UTF-8计算）。默认仅参考表达方式，不作为事实来源。</FieldDescription><Textarea id="reference-text" className="min-h-40" disabled={state.busy} aria-describedby="reference-text-help" aria-invalid={!!state.error} value={state.draft.referenceText} onChange={(event) => update("referenceText", event.target.value)} /></Field>
          <FieldSet disabled={state.busy}>
            <FieldLegend className="mb-0" variant="label">参考文本角色</FieldLegend>
            <RadioGroup className="grid gap-2 sm:grid-cols-2" name="reference-role" value={state.draft.referenceRole} onValueChange={(value) => update("referenceRole", value as VideoInputDraft["referenceRole"])}>
              {([['style_only', '仅参考表达方式'], ['content_source', '同时作为内容资料']] as const).map(([value, label]) => <FieldLabel className={choiceClass} key={value}><RadioGroupItem value={value} /><span>{label}</span></FieldLabel>)}
            </RadioGroup>
          </FieldSet>
        </div>

        <div className="grid gap-6 border-t border-[var(--border-subtle)] pt-6 md:grid-cols-2">
          <FieldSet disabled={state.busy}><FieldLegend className="mb-0" variant="label">目标时长</FieldLegend><FieldDescription>本 MVP 支持60～600秒，底层按秒保存。</FieldDescription><RadioGroup className="grid grid-cols-2 gap-2" name="duration" value={String(state.draft.targetDurationSeconds)} onValueChange={(value) => update("targetDurationSeconds", Number(value))}>{([[60, '1分钟'], [180, '3分钟'], [300, '5分钟'], [600, '10分钟']] as const).map(([value, label]) => <FieldLabel className={choiceClass} key={value}><RadioGroupItem value={String(value)} /><span>{label}</span></FieldLabel>)}</RadioGroup></FieldSet>
          <FieldSet disabled={state.busy}><FieldLegend className="mb-0" variant="label">画面密度</FieldLegend><RadioGroup className="grid gap-2" name="visual-density" value={state.draft.visualDensity} onValueChange={(value) => update("visualDensity", value as VideoInputDraft["visualDensity"])}>{([['relaxed', '舒缓'], ['standard', '标准'], ['compact', '紧凑']] as const).map(([value, label]) => <FieldLabel className={choiceClass} key={value}><RadioGroupItem value={value} /><span>{label}</span></FieldLabel>)}</RadioGroup></FieldSet>
        </div>

        <div className="grid gap-4 border-t border-[var(--border-subtle)] pt-6 md:grid-cols-2">
          <div><p className="text-sm font-semibold">固定画幅</p><p className="mt-2 font-mono text-sm">9:16 · 1080×1920</p><p className="mt-1 text-sm text-[var(--fg-tertiary)]">首个 MVP 固定为竖屏，无需单独设置。</p></div>
          <FieldLabel className={choiceClass}><Checkbox disabled={state.busy} checked={state.draft.webEnabled} onCheckedChange={(checked) => update("webEnabled", checked === true)} /><span><strong className="block">本次允许联网</strong><span className="mt-1 block text-[var(--fg-tertiary)]">仅保存开关；本阶段不会执行真实联网。</span></span></FieldLabel>
        </div>

        <details className="border-t border-[var(--border-subtle)] pt-5">
          <summary className="flex min-h-11 cursor-pointer items-center text-sm font-semibold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus)]">当前视频提示词补充</summary>
          <div className="grid gap-5 pb-2 pt-3">
            <p className="text-sm leading-6 text-[var(--fg-secondary)]">当前视频补充只影响本视频，不会复制或覆盖全局、项目设置。</p>
            <Field><FieldLabel htmlFor="video-script-instructions">当前视频文案补充</FieldLabel><FieldDescription id="video-script-help">最多20,000个字符。</FieldDescription><Textarea id="video-script-instructions" className="min-h-32" disabled={state.busy} aria-describedby="video-script-help" value={state.draft.scriptInstructions} onChange={(event) => update("scriptInstructions", event.target.value)} /></Field>
            <Field><FieldLabel htmlFor="video-visual-instructions">当前视频画面补充</FieldLabel><FieldDescription id="video-visual-help">最多20,000个字符。</FieldDescription><Textarea id="video-visual-instructions" className="min-h-32" disabled={state.busy} aria-describedby="video-visual-help" value={state.draft.visualInstructions} onChange={(event) => update("visualInstructions", event.target.value)} /></Field>
          </div>
        </details>

        <section className="border-t border-[var(--border-subtle)] pt-6" aria-labelledby="sources-heading"><h3 id="sources-heading" className="text-base font-semibold">联网来源</h3><p className="mt-2 text-sm leading-6 text-[var(--fg-secondary)]">{planState?.plan ? "来源已随当前方案冻结，请在“文案与画面方案”阶段查看。" : "尚未生成方案，暂无联网来源。"}</p></section>
        <div className="border-t border-[var(--border-subtle)] pt-6"><span className="text-sm text-[var(--fg-tertiary)]">保存不会创建任务或改变视频状态。</span></div>
        {planState && state.draft && !planState.plan && (!planState.job || planState.job.status === "failed" || planState.job.status === "cancelled") ? <VideoPlanLauncher input={state.draft} dirty={state.dirty} busy={state.busy || planState.busy} modelLabel={planState.modelLabel} modelAvailable={planState.modelAvailable} onStart={() => { void planState.start(); onPlanStarted?.(); }} /> : null}
      </form> : state.loaded ? <div className="py-10"><p className="text-sm text-[var(--danger)]">创作输入暂不可用。请返回项目确认视频后重试。</p></div> : <p className="py-10 text-sm text-[var(--fg-secondary)]" role="status">正在读取创作输入草稿…</p>}
    </div>
  </section>;
}
