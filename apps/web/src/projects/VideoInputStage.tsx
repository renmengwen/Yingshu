import { Button } from "../components/ui/button";
import { Checkbox } from "../components/ui/checkbox";
import { Field, FieldDescription, FieldLabel, FieldLegend, FieldSet } from "../components/ui/field";
import { RadioGroup, RadioGroupItem } from "../components/ui/radio-group";
import { Textarea } from "../components/ui/textarea";
import type { VideoInputDraft } from "./types";
import { useVideoInput } from "./use-video-input";
import { videoPlanLaunchBlockReason, VideoPlanLauncher } from "./VideoPlanLauncher";
import { promptInstructionsStatus, VideoPromptInstructionsDialog } from "./VideoPromptInstructionsDialog";
import type { useVideoPlan } from "./use-video-plan";

const segmentClass = "focus-ring-proxy flex min-h-11 cursor-pointer items-center justify-center rounded-md border border-border px-3 text-center text-sm font-medium has-data-[state=checked]:border-primary has-data-[state=checked]:bg-[var(--surface-selected)] has-data-[state=checked]:text-[var(--accent-strong)]";

export function VideoInputStage({ projectId, videoId, planState, onPlanStarted }: { projectId: string; videoId: string; planState: ReturnType<typeof useVideoPlan>; onPlanStarted: () => void }) {
  const state = useVideoInput(projectId, videoId);
  return <VideoInputContent state={state} planState={planState} onPlanStarted={onPlanStarted} />;
}

export function VideoInputContent({ state, planState, onPlanStarted }: { state: ReturnType<typeof useVideoInput>; planState?: ReturnType<typeof useVideoPlan>; onPlanStarted?: () => void }) {
  const update = <K extends keyof VideoInputDraft>(key: K, value: VideoInputDraft[K]) => state.setDraft((current) => current ? { ...current, [key]: value } : current);
  const launchAvailable = Boolean(planState && state.draft && !planState.plan && (!planState.job || planState.job.status === "failed" || planState.job.status === "cancelled"));
  const launchBlockReason = launchAvailable && planState && state.draft
    ? videoPlanLaunchBlockReason(state.draft, state.dirty, state.busy || planState.busy, planState.modelAvailable) : null;

  return <section className="min-w-0" aria-labelledby="input-stage-heading">
    {state.draft ? <form id="video-input-form" aria-describedby="video-input-status" onSubmit={(event) => { event.preventDefault(); void state.save(); }}>
      <header className="sticky top-0 z-20 flex flex-col gap-4 border-b border-[var(--border-subtle)] bg-[var(--bg-surface)] px-5 py-5 md:flex-row md:flex-wrap md:items-center md:justify-between md:px-7">
        <div className="min-w-0 md:flex-1">
          <p className="font-mono text-[11px] font-semibold tracking-[.14em] text-[var(--accent)]">阶段 01</p>
          <h2 id="input-stage-heading" className="mt-2 text-xl font-semibold">输入与来源</h2>
          <p className="mt-2 text-sm leading-6 text-[var(--fg-secondary)]">准备本次视频的创作内容和制作要求。</p>
          <p id="video-input-status" className={`mt-2 text-sm ${state.error ? "font-medium text-[var(--danger)]" : "text-[var(--fg-secondary)]"}`} role={state.error ? "alert" : "status"} aria-live={state.error ? undefined : "polite"}>{state.dirty ? `有未保存修改。${state.status}` : state.status}</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button type="submit" variant="outline" disabled={state.busy || !state.dirty}>{state.busy ? "正在保存草稿…" : "保存草稿"}</Button>
          {launchAvailable && planState ? <VideoPlanLauncher input={state.draft} dirty={state.dirty} busy={state.busy || planState.busy} modelLabel={planState.modelLabel} modelAvailable={planState.modelAvailable} onStart={() => { void planState.start(); onPlanStarted?.(); }} /> : null}
          {planState && !launchAvailable && (planState.plan || planState.job) && onPlanStarted ? <Button type="button" onClick={onPlanStarted}>{planState.plan ? "查看当前方案" : "查看生成进度"}</Button> : null}
        </div>
        {launchBlockReason ? <p className="text-sm text-[var(--fg-secondary)] md:basis-full md:text-right">{launchBlockReason}</p> : null}
      </header>

      <div className="grid lg:grid-cols-[minmax(0,2fr)_minmax(18rem,1fr)]">
        <section className="grid min-w-0 gap-7 p-5 md:p-7" aria-labelledby="creative-input-heading">
          <div><h3 id="creative-input-heading" className="text-base font-semibold">创作内容</h3><p className="mt-1 text-sm leading-6 text-[var(--fg-secondary)]">选择创作起点，并提供生成旁白所需的核心内容。</p></div>
          <FieldSet disabled={state.busy}>
            <FieldLegend className="mb-0" variant="label">输入方式</FieldLegend>
            <FieldDescription id="input-mode-help">切换方式会保留另一个模式中已经填写的内容。</FieldDescription>
            <RadioGroup className="grid max-w-lg grid-cols-2 gap-2" name="input-mode" aria-describedby="input-mode-help" value={state.draft.inputMode} onValueChange={(value) => update("inputMode", value as VideoInputDraft["inputMode"])}>
              {([['topic', '根据主题创作'], ['body', '根据正文改编']] as const).map(([value, label]) => <FieldLabel className={segmentClass} key={value}><RadioGroupItem className="sr-only" value={value} /><span>{label}</span></FieldLabel>)}
            </RadioGroup>
          </FieldSet>

          {state.draft.inputMode === "topic" ? <Field data-invalid={!!state.error}>
            <FieldLabel htmlFor="video-topic">视频主题</FieldLabel>
            <FieldDescription id="video-topic-help">映述会根据主题组织旁白，并规划对应画面。最多 200 字。</FieldDescription>
            <Textarea id="video-topic" className="min-h-24" placeholder="例如：人类为什么会做梦" required disabled={state.busy} aria-describedby="video-topic-help" aria-invalid={!!state.error} value={state.draft.topic} onChange={(event) => update("topic", event.target.value)} />
          </Field> : <Field data-invalid={!!state.error}>
            <FieldLabel htmlFor="video-body">视频正文</FieldLabel>
            <FieldDescription id="video-body-help">保留原有段落；映述会整理为适合视频旁白的结构。</FieldDescription>
            <Textarea id="video-body" className="min-h-72" placeholder="粘贴需要改编的视频正文" required disabled={state.busy} aria-describedby="video-body-help" aria-invalid={!!state.error} value={state.draft.body} onChange={(event) => update("body", event.target.value)} />
          </Field>}

          <div className="grid gap-5">
            <Field data-invalid={!!state.error}>
              <FieldLabel htmlFor="reference-text">参考资料（可选）</FieldLabel>
              <FieldDescription id="reference-text-help">可提供表达风格参考，也可作为内容资料参与创作。</FieldDescription>
              <Textarea id="reference-text" className="min-h-40" placeholder="粘贴参考资料" disabled={state.busy} aria-describedby="reference-text-help" aria-invalid={!!state.error} value={state.draft.referenceText} onChange={(event) => update("referenceText", event.target.value)} />
            </Field>
            {state.draft.referenceText.trim() ? <FieldSet disabled={state.busy}>
              <FieldLegend className="mb-0" variant="label">参考资料用途</FieldLegend>
              <RadioGroup className="grid gap-2 sm:grid-cols-2" name="reference-role" value={state.draft.referenceRole} onValueChange={(value) => update("referenceRole", value as VideoInputDraft["referenceRole"])}>
                {([['style_only', '只参考表达风格'], ['content_source', '作为内容资料']] as const).map(([value, label]) => <FieldLabel className={segmentClass} key={value}><RadioGroupItem className="sr-only" value={value} /><span>{label}</span></FieldLabel>)}
              </RadioGroup>
            </FieldSet> : null}
          </div>
        </section>

        <aside className="grid content-start gap-7 border-t border-[var(--border-subtle)] bg-[var(--bg-subtle)] p-5 md:p-7 lg:border-l lg:border-t-0" aria-labelledby="production-settings-heading">
          <div><h3 id="production-settings-heading" className="text-base font-semibold">制作参数</h3><p className="mt-1 text-sm leading-6 text-[var(--fg-secondary)]">这些设置会随本次方案一起冻结。</p></div>
          <FieldSet disabled={state.busy}>
            <FieldLegend className="mb-0" variant="label">目标时长</FieldLegend>
            <FieldDescription>时长会影响旁白篇幅和预计画面数量。</FieldDescription>
            <RadioGroup className="grid grid-cols-2 gap-2" name="duration" value={String(state.draft.targetDurationSeconds)} onValueChange={(value) => update("targetDurationSeconds", Number(value))}>
              {([[60, '1 分钟'], [180, '3 分钟'], [300, '5 分钟'], [600, '10 分钟']] as const).map(([value, label]) => <FieldLabel className={segmentClass} key={value}><RadioGroupItem className="sr-only" value={String(value)} /><span>{label}</span></FieldLabel>)}
            </RadioGroup>
          </FieldSet>
          <FieldSet disabled={state.busy}>
            <FieldLegend className="mb-0" variant="label">画面节奏</FieldLegend>
            <RadioGroup className="grid grid-cols-3 gap-2" name="visual-density" value={state.draft.visualDensity} onValueChange={(value) => update("visualDensity", value as VideoInputDraft["visualDensity"])}>
              {([['relaxed', '舒缓'], ['standard', '标准'], ['compact', '紧凑']] as const).map(([value, label]) => <FieldLabel className={segmentClass} key={value}><RadioGroupItem className="sr-only" value={value} /><span>{label}</span></FieldLabel>)}
            </RadioGroup>
            <FieldDescription>{state.draft.visualDensity === "relaxed" ? "单张画面停留更久。" : state.draft.visualDensity === "compact" ? "画面切换更频繁。" : "适合大多数讲解视频。"}</FieldDescription>
          </FieldSet>
          <div><h4 className="text-sm font-medium">输出规格</h4><p className="mt-2 font-mono text-sm">竖屏 · 9:16</p><p className="mt-1 font-mono text-xs text-[var(--fg-tertiary)]">1080 × 1920</p></div>
          <FieldLabel className="flex w-full cursor-pointer items-start gap-3">
            <Checkbox disabled={state.busy} checked={state.draft.webEnabled} onCheckedChange={(checked) => update("webEnabled", checked === true)} />
            <span className="pt-2"><strong className="block text-sm font-medium">联网查证</strong><span className="mt-1 block text-sm leading-6 text-[var(--fg-secondary)]">{state.draft.webEnabled ? "生成方案时搜索并冻结可核验来源。当前保存草稿不会联网。" : "生成方案时不搜索外部资料，仅使用当前输入和参考资料。"}</span></span>
          </FieldLabel>
        </aside>
      </div>

      <section className="grid gap-5 border-t border-[var(--border-subtle)] px-5 py-6 md:px-7" aria-labelledby="advanced-settings-heading">
        <div><h3 id="advanced-settings-heading" className="text-base font-semibold">高级设置</h3><p className="mt-1 text-sm leading-6 text-[var(--fg-secondary)]">低频配置不会占用主编辑区。</p></div>
        <div className="flex flex-col gap-4 bg-[var(--bg-subtle)] p-4 sm:flex-row sm:items-center sm:justify-between">
          <div><h4 className="text-sm font-medium">当前视频提示词补充</h4><p className="mt-1 text-sm text-[var(--fg-secondary)]">{promptInstructionsStatus(state.draft.scriptInstructions, state.draft.visualInstructions)} · 只影响当前视频</p></div>
          <VideoPromptInstructionsDialog disabled={state.busy} scriptInstructions={state.draft.scriptInstructions} visualInstructions={state.draft.visualInstructions} onApply={(scriptInstructions, visualInstructions) => state.setDraft((current) => current ? { ...current, scriptInstructions, visualInstructions } : current)} />
        </div>
      </section>

      <section className="border-t border-[var(--border-subtle)] px-5 py-6 md:px-7" aria-labelledby="sources-heading">
        <h3 id="sources-heading" className="text-base font-semibold">来源</h3><p className="mt-2 text-sm leading-6 text-[var(--fg-secondary)]">{planState?.plan ? `当前方案已冻结 ${planState.sources.length} 条联网来源，可通过顶部“查看当前方案”进入来源详情。` : state.draft.webEnabled ? "尚未生成方案。生成时会检索并冻结可核验来源。" : "本次未开启联网查证，方案将只依据当前输入和参考资料生成。"}</p>
      </section>
    </form> : state.loaded ? <div className="p-6" role="alert"><h2 id="input-stage-heading" className="text-lg font-semibold">创作输入暂不可用</h2><p className="mt-2 text-sm leading-6 text-[var(--fg-secondary)]">请返回项目确认视频是否存在后重试。</p></div> : <p className="p-6 text-sm text-[var(--fg-secondary)]" role="status">正在读取创作输入草稿…</p>}
  </section>;
}
