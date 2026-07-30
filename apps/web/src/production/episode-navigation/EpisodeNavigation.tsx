import { episodeNavigationTarget } from "./episode-navigation-client";
import type { Episode } from "../types";

export function EpisodeNavigation({ current, episodes, state, disabled, onChange }: {
  current: number;
  episodes: Episode[];
  state: "loading" | "ready" | "failed";
  disabled: boolean;
  onChange: (index: number) => void;
}) {
  const previous = episodeNavigationTarget(episodes, current, -1);
  const next = episodeNavigationTarget(episodes, current, 1);
  const currentExists = episodes.some((episode) => episode.index === current);
  return <nav className="flex flex-wrap items-center justify-between gap-3 border-t border-[var(--border-subtle)] bg-[var(--bg-subtle)] px-4 py-2" aria-label="分集导航">
    <div className="flex items-center gap-2">
      <button type="button" disabled={disabled || previous === undefined} onClick={() => previous !== undefined && onChange(previous)} className="min-h-11 rounded border border-[var(--border-subtle)] px-4 text-sm font-semibold disabled:cursor-not-allowed disabled:text-[var(--fg-tertiary)]">上一集</button>
      <label className="flex min-h-11 items-center gap-2 text-sm text-[var(--fg-secondary)]">
        <span>分集</span>
        <select aria-label="选择分集" disabled={disabled || !episodes.length} value={currentExists ? current : ""} onChange={(event) => onChange(Number(event.target.value))} className="min-h-11 max-w-[min(54vw,420px)] rounded border border-[var(--border-subtle)] bg-[var(--bg-canvas)] px-3 text-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--focus)]">
          {!currentExists ? <option value="">请选择分集</option> : null}
          {episodes.map((episode) => <option key={episode.id} value={episode.index}>第 {episode.index} 集 · {episode.title}</option>)}
        </select>
      </label>
      <button type="button" disabled={disabled || next === undefined} onClick={() => next !== undefined && onChange(next)} className="min-h-11 rounded border border-[var(--border-subtle)] px-4 text-sm font-semibold disabled:cursor-not-allowed disabled:text-[var(--fg-tertiary)]">下一集</button>
    </div>
    <p className={`font-mono text-xs ${state === "failed" ? "text-[var(--danger)]" : "text-[var(--fg-secondary)]"}`} role={state === "failed" ? "alert" : "status"} aria-live="polite">
      {state === "loading" ? "正在加载真实分集列表…" : state === "failed" ? "分集列表加载失败" : episodes.length ? `第 ${current} 集，共 ${episodes.length} 集` : "尚未冻结分集"}
    </p>
  </nav>;
}
