import { PRODUCTION_STAGES, stageDependencyLabel, type ProductionStageId } from "../production-logic";

export function StageNavigation({ stage, onChange }: { stage: ProductionStageId; onChange: (stage: ProductionStageId) => void }) {
  return (
    <nav className="grid grid-cols-[repeat(7,minmax(124px,1fr))] overflow-x-auto border-b border-[var(--border-subtle)]" aria-label="系列生产阶段">
      {PRODUCTION_STAGES.map((item, index) => {
        const current = stage === item.id;
        return <button key={item.id} type="button" aria-current={current ? "step" : undefined} onClick={() => onChange(item.id)} className={`grid min-h-16 content-center gap-1 border-r border-[var(--border-subtle)] px-3 py-2 text-left ${current ? "bg-[var(--fg-primary)] text-[var(--bg-surface)]" : "bg-[var(--bg-subtle)] text-[var(--fg-secondary)] hover:bg-[var(--bg-hover)]"}`}>
          <span className="font-mono text-[10px] opacity-65">{String(index + 1).padStart(2, "0")}</span><strong className="truncate text-[13px]">{item.label}</strong><small className="truncate font-mono text-[10px] opacity-65">{stageDependencyLabel(item.id, current)}</small>
        </button>;
      })}
    </nav>
  );
}
