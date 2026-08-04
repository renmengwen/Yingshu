import type { PageCommonProps } from "./types";

export function ProjectShell({ title, description, children, onOpenSettings, themePreference, onThemeChange }: PageCommonProps & {
  title: string;
  description: string;
  children: React.ReactNode;
}) {
  return <main className="min-h-screen bg-[var(--bg-canvas)] p-4 text-[var(--fg-primary)] md:p-7">
    <div className="mx-auto min-h-[calc(100vh-56px)] w-full max-w-6xl border border-[var(--border-subtle)] bg-[var(--bg-surface)]">
      <header className="flex flex-col gap-5 border-b border-[var(--border-subtle)] px-5 py-6 md:flex-row md:items-end md:justify-between md:px-7">
        <div>
          <p className="m-0 font-mono text-[11px] font-semibold tracking-[.17em] text-[var(--accent)]">映述 / YINGSHU</p>
          <h1 className="mt-3 text-3xl font-semibold tracking-tight">{title}</h1>
          <p className="mt-2 text-sm text-[var(--fg-secondary)]">{description}</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <div className="flex min-h-11 items-center rounded border border-[var(--border-strong)] bg-[var(--bg-subtle)] p-0.5" role="group" aria-label="页面主题">
            {(["system", "light", "dark"] as const).map((preference) => <button className="min-h-11 min-w-12 rounded-sm px-2 text-xs" type="button" key={preference} aria-pressed={themePreference === preference} onClick={() => onThemeChange(preference)}>{preference === "system" ? "系统" : preference === "light" ? "浅色" : "深色"}</button>)}
          </div>
          <button className="min-h-11 rounded border border-[var(--border-strong)] px-4 text-sm font-semibold hover:bg-[var(--bg-subtle)]" type="button" onClick={onOpenSettings}>设置</button>
        </div>
      </header>
      {children}
    </div>
  </main>;
}

export function StatusStrip({ message, busy = false, error = false }: { message: string; busy?: boolean; error?: boolean }) {
  return <div className={`min-h-11 border-b border-[var(--border-subtle)] px-5 py-3 text-sm ${error ? "bg-[var(--danger-soft)] text-[var(--danger)]" : "bg-[var(--bg-subtle)] text-[var(--fg-secondary)]"}`} role={error ? "alert" : "status"} aria-live={error ? undefined : "polite"}>
    {busy ? <span className="mr-2 inline-block h-2 w-2 animate-pulse rounded-full bg-[var(--accent)]" aria-hidden="true" /> : null}{message}
  </div>;
}
