import { useProjectSettings } from "./use-project-settings";

const textareaClass = "mt-2 min-h-32 w-full rounded border border-[var(--border-strong)] bg-[var(--bg-canvas)] p-3 text-sm leading-6 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus)] disabled:opacity-60";

export function ProjectCreativeSettings({ projectId }: { projectId: string }) {
  const state = useProjectSettings(projectId);

  return <details className="border-b border-[var(--border-subtle)] px-5 py-4 md:px-7">
    <summary className="flex min-h-11 cursor-pointer items-center font-semibold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus)]">项目创作设置</summary>
    <div className="max-w-3xl pb-3 pt-2">
      <p className="text-sm leading-6 text-[var(--fg-secondary)]">项目设置影响本项目后续生成；当前视频补充只影响对应视频。</p>
      <div className={`mt-4 min-h-11 rounded border px-3 py-3 text-sm ${state.error ? "border-[var(--danger)] bg-[var(--danger-soft)] text-[var(--danger)]" : "border-[var(--border-subtle)] bg-[var(--bg-subtle)] text-[var(--fg-secondary)]"}`} role={state.error ? "alert" : "status"} aria-live={state.error ? undefined : "polite"}>{state.status}{state.dirty ? " 有未保存修改。" : ""}</div>
      {state.draft ? <form className="mt-5 grid gap-5" onSubmit={(event) => { event.preventDefault(); void state.save(); }}>
        <label className="text-sm font-semibold" htmlFor="project-script-instructions">项目文案补充
          <span id="project-script-help" className="mt-1 block font-normal leading-6 text-[var(--fg-tertiary)]">为本项目后续文案生成补充语气、结构或禁用表达，最多20,000个字符。</span>
          <textarea id="project-script-instructions" className={textareaClass} disabled={state.busy} aria-describedby="project-script-help" aria-invalid={state.error || undefined} value={state.draft.scriptInstructions} onChange={(event) => state.setDraft((current) => current ? { ...current, scriptInstructions: event.target.value } : current)} />
        </label>
        <label className="text-sm font-semibold" htmlFor="project-visual-instructions">项目画面补充
          <span id="project-visual-help" className="mt-1 block font-normal leading-6 text-[var(--fg-tertiary)]">为本项目后续画面生成补充构图、色彩或禁用元素，最多20,000个字符。</span>
          <textarea id="project-visual-instructions" className={textareaClass} disabled={state.busy} aria-describedby="project-visual-help" aria-invalid={state.error || undefined} value={state.draft.visualInstructions} onChange={(event) => state.setDraft((current) => current ? { ...current, visualInstructions: event.target.value } : current)} />
        </label>
        <div><button className="min-h-11 rounded bg-[var(--accent)] px-4 text-sm font-semibold text-[var(--accent-contrast)] hover:bg-[var(--accent-strong)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus)] disabled:cursor-not-allowed disabled:opacity-50" type="submit" disabled={state.busy || !state.dirty}>{state.busy ? "正在保存…" : "保存项目设置"}</button></div>
      </form> : state.loaded ? <p className="mt-4 text-sm text-[var(--danger)]">项目创作设置暂不可用。请刷新页面重试。</p> : <p className="mt-4 text-sm text-[var(--fg-secondary)]" role="status">正在读取项目创作设置…</p>}
    </div>
  </details>;
}
