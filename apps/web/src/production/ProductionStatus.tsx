import { isTerminalJobStatus, jobStatusText, normalizeJobProgress } from "../production-logic";
import type { JobRecord } from "./types";

export function ProductionStatus({ operation, persistentError, busy, job, onDismissError, onCancel }: {
  operation: string; persistentError?: string; busy: boolean; job?: JobRecord; onDismissError: () => void; onCancel: () => void;
}) {
  const progress = job ? normalizeJobProgress(job.status, job.progress) : 0;
  const active = !!job && !isTerminalJobStatus(job.status);
  return <div className="grid min-h-12 gap-2 border-b border-[var(--border-subtle)] bg-[var(--bg-subtle)] px-5 py-2 text-[13px] text-[var(--fg-secondary)] max-md:px-4" role="status" aria-live="polite">
    <div className="grid grid-cols-[auto_minmax(180px,1fr)_auto_auto_auto] items-center gap-2.5 max-md:grid-cols-[auto_1fr]">
      <span className={`h-1.5 w-1.5 rounded-full ${busy || active ? "animate-pulse bg-[var(--accent)]" : "bg-[var(--fg-tertiary)]"}`} aria-hidden="true" /><span>{operation}</span>
      {job ? <><span className="text-xs">{jobStatusText(job.status)}</span><progress className="h-1 w-32 accent-[var(--accent)] max-md:col-start-2" max="100" value={progress}>{progress}%</progress><span>{progress}%</span></> : null}
      {active ? <button type="button" className="border-0 bg-transparent text-xs font-semibold text-[var(--accent)] disabled:opacity-50" disabled={busy} onClick={onCancel}>取消任务</button> : null}
    </div>
    {persistentError ? <div className="flex items-center justify-between gap-3 rounded border border-[var(--danger)] bg-[var(--danger-soft)] px-3 py-2 text-[var(--danger)]" role="alert">
      <span>{persistentError}</span>
      <button type="button" onClick={onDismissError} className="min-h-9 rounded border border-current px-3 text-xs font-semibold">关闭错误</button>
    </div> : null}
  </div>;
}
