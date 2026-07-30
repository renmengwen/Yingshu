import type { AssetGapCounts } from "./types";

export function AssetGapSummary({ counts }: { counts: AssetGapCounts }) {
  return <section className="grid gap-2 border-b border-[var(--border-subtle)] p-3.5" aria-labelledby="asset-gap-heading">
    <div><h3 id="asset-gap-heading" className="text-xs font-bold">系列资产生产缺口</h3><p className="mt-1 text-[10px] leading-4 text-[var(--fg-tertiary)]">仅按当前系列已建资产的候选状态统计，不代表自动识别了全部人物、场景和道具。</p></div>
    <div className="grid grid-cols-3 gap-2 text-center text-[10px]">
      <span className="rounded border border-[var(--border-subtle)] p-2"><strong className="block text-sm text-[var(--fg-primary)]">{counts.noCandidates}</strong>无候选</span>
      <span className="rounded border border-[var(--border-subtle)] p-2"><strong className="block text-sm text-[var(--fg-primary)]">{counts.awaitingApproval}</strong>待批准</span>
      <span className="rounded border border-[var(--border-subtle)] p-2"><strong className="block text-sm text-[var(--fg-primary)]">{counts.approved}</strong>已批准</span>
    </div>
  </section>;
}
