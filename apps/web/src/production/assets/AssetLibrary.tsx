import { AssetGapSummary } from "./AssetGapSummary";
import type { AssetGapCounts, AssetGroup, AssetType } from "./types";
import { ASSET_TYPE_LABEL } from "./types";

const control = "min-h-10 w-full rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-subtle)] px-2.5 text-sm text-[var(--fg-primary)]";

export function AssetLibrary({ assets, count, gaps, selectedId, busy, draft, onDraft, onSelect, onCreate }: { assets: AssetGroup[]; count: number; gaps: AssetGapCounts; selectedId?: string; busy: boolean; draft: { name: string; type: AssetType; parentId: string; stateLabel: string }; onDraft: (next: Partial<typeof draft>) => void; onSelect: (id: string) => void; onCreate: () => void }) {
  const masters = assets.filter((asset) => asset.type === draft.type);
  return <aside className="min-w-0 border-r border-[var(--border-subtle)] max-md:border-r-0 max-md:border-b" aria-labelledby="asset-library-heading">
    <div className="flex h-12 items-center justify-between border-b border-[var(--border-subtle)] px-4"><h2 id="asset-library-heading" className="text-xs font-bold tracking-wider">系列资产</h2><span className="font-mono text-[10px] text-[var(--fg-tertiary)]">{count}</span></div>
    <AssetGapSummary counts={gaps} />
    <div className="grid gap-2 border-b border-[var(--border-subtle)] p-3.5">
      <select className={control} value={draft.type} disabled={busy} onChange={(event) => onDraft({ type: event.target.value as AssetType, parentId: "" })} aria-label="资产类型">{Object.entries(ASSET_TYPE_LABEL).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select>
      <input className={control} value={draft.name} disabled={busy} onChange={(event) => onDraft({ name: event.target.value })} placeholder="资产名称" aria-label="资产名称" />
      <select className={control} value={draft.parentId} disabled={busy} onChange={(event) => onDraft({ parentId: event.target.value })} aria-label="资产层级"><option value="">创建主资产</option>{masters.map((asset) => <option key={asset.id} value={asset.id}>状态属于：{asset.name}</option>)}</select>
      {draft.parentId ? <input className={control} value={draft.stateLabel} disabled={busy} onChange={(event) => onDraft({ stateLabel: event.target.value })} placeholder="状态标签，如：下墓装束" aria-label="状态标签" /> : null}
      <button className="min-h-10 rounded bg-[var(--accent)] px-3 text-sm font-semibold text-[var(--accent-contrast)] hover:bg-[var(--accent-strong)] disabled:opacity-50" type="button" disabled={busy || !draft.name.trim() || (!!draft.parentId && !draft.stateLabel.trim())} onClick={onCreate}>保存资产</button>
    </div>
    <div className="max-h-[calc(100vh-540px)] overflow-y-auto">{assets.map((master) => <div className="border-b border-[var(--border-subtle)]" key={master.id}><AssetRow asset={master} selected={selectedId === master.id} onSelect={onSelect} />{master.states.map((state) => <AssetRow key={state.id} asset={state} selected={selectedId === state.id} onSelect={onSelect} state />)}</div>)}{!assets.length ? <p className="m-7 text-[13px] text-[var(--fg-tertiary)]">当前系列还没有资产。先建立人物、场景或道具主资产。</p> : null}</div>
  </aside>;
}

function AssetRow({ asset, selected, state = false, onSelect }: { asset: AssetGroup | AssetGroup["states"][number]; selected: boolean; state?: boolean; onSelect: (id: string) => void }) {
  return <button type="button" className={`grid w-full gap-1 px-4 py-3 text-left hover:bg-[var(--bg-hover)] ${state ? "pl-8" : ""} ${selected ? "bg-[var(--bg-hover)] shadow-[inset_3px_0_var(--accent)]" : ""}`} onClick={() => onSelect(asset.id)}><span className="text-[10px] text-[var(--fg-tertiary)]">{state ? `状态 · ${asset.stateLabel}` : `${ASSET_TYPE_LABEL[asset.type]} · 主资产`}</span><strong className="text-[13px]">{asset.name}</strong><small className="text-[10px] text-[var(--fg-tertiary)]">{asset.aliases.join(" / ") || (state ? "继承主资产语义" : "暂无别名")}</small></button>;
}
