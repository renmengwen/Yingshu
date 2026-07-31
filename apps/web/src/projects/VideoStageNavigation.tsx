import React from "react";

import { VIDEO_STAGES } from "./logic";

type VideoStageIndex = 0 | 1 | 2 | 3 | 4 | 5;

export function VideoStageNavigation({ activeStage, planAvailable, imageAvailable, audioAvailable, visualAvailable, exportAvailable, onSelect }: { activeStage: VideoStageIndex; planAvailable: boolean; imageAvailable: boolean; audioAvailable: boolean; visualAvailable: boolean; exportAvailable: boolean; onSelect: (stage: VideoStageIndex) => void }) {
  return <nav className="flex overflow-x-auto border-b border-[var(--border-subtle)] md:grid md:grid-cols-3 xl:grid-cols-6" aria-label="视频制作阶段">
    {VIDEO_STAGES.map((stage, index) => {
      const available = index === 0 || (index === 1 && planAvailable) || (index === 2 && imageAvailable) ||
        (index === 3 && audioAvailable) || (index === 4 && visualAvailable) || (index === 5 && exportAvailable);
      const active = index === activeStage;
      return <button key={stage} className={`grid min-h-20 min-w-40 shrink-0 content-center gap-1 border-r border-[var(--border-subtle)] px-4 py-3 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--focus)] ${active ? "bg-[var(--fg-primary)] text-[var(--bg-surface)]" : available ? "bg-[var(--bg-surface)] text-[var(--fg-primary)] hover:bg-[var(--bg-subtle)]" : "cursor-not-allowed bg-[var(--bg-subtle)] text-[var(--fg-tertiary)]"}`} type="button" disabled={!available} aria-current={active ? "step" : undefined} onClick={() => available && onSelect(index as VideoStageIndex)}>
        <span className="font-mono text-[10px] opacity-70">{String(index + 1).padStart(2, "0")}</span><strong className="text-sm">{stage}</strong><span className="text-xs opacity-80">{active ? "当前阶段" : available ? "可进入" : index === 2 || index === 3 ? "需先批准方案" : "尚未生成"}</span>
      </button>;
    })}
  </nav>;
}
