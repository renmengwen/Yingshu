import React from "react";

import { VIDEO_STAGES } from "./logic";

export function VideoStageNavigation() {
  return <nav className="grid overflow-x-auto border-b border-[var(--border-subtle)] md:grid-cols-3 xl:grid-cols-6" aria-label="视频制作阶段">
    {VIDEO_STAGES.map((stage, index) => {
      const available = index === 0;
      return <button key={stage} className={`grid min-h-20 min-w-40 content-center gap-1 border-r border-[var(--border-subtle)] px-4 py-3 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--focus)] ${available ? "bg-[var(--fg-primary)] text-[var(--bg-surface)]" : "cursor-not-allowed bg-[var(--bg-subtle)] text-[var(--fg-tertiary)]"}`} type="button" disabled={!available} aria-current={available ? "step" : undefined}>
        <span className="font-mono text-[10px] opacity-70">{String(index + 1).padStart(2, "0")}</span><strong className="text-sm">{stage}</strong><span className="text-xs opacity-80">{available ? "当前阶段" : "尚未生成"}</span>
      </button>;
    })}
  </nav>;
}
