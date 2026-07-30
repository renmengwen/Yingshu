import type { SeriesProject } from "./types";

export function ProductionHeader({ series, onLeave, onOpenSettings }: { series: SeriesProject; onLeave: () => void; onOpenSettings: () => void }) {
  return (
    <header className="flex min-h-20 items-center justify-between gap-4 border-b border-[var(--border-subtle)] px-5 py-4 max-md:flex-col max-md:items-start max-md:px-4">
      <div>
        <p className="mb-1 font-mono text-[10px] font-semibold tracking-[.14em] text-[var(--accent)]">系列生产</p>
        <div className="flex items-center gap-3"><h1 className="m-0 text-2xl font-semibold tracking-[-.02em]">{series.title}</h1><span className="border border-[var(--border-strong)] px-1.5 py-0.5 font-mono text-[10px] tracking-wider text-[var(--fg-tertiary)]">SERIES</span></div>
      </div>
      <div className="flex gap-2 max-md:w-full">
        <button className="min-h-11 rounded border border-[var(--border-strong)] px-4 text-sm text-[var(--fg-secondary)] hover:bg-[var(--bg-subtle)] disabled:opacity-50 max-md:flex-1" type="button" onClick={onOpenSettings}>设置</button>
        <button className="min-h-11 rounded border border-[var(--border-strong)] px-4 text-sm text-[var(--fg-secondary)] hover:bg-[var(--bg-subtle)] disabled:opacity-50 max-md:flex-1" type="button" onClick={onLeave}>返回书库</button>
      </div>
    </header>
  );
}
