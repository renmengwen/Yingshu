import { useState } from "react";

import { formatTimelineTime, visualCandidateState } from "./visual-editor";
import type { VisualSegmentDraft } from "./types";
import { useVisualWorkspace } from "./use-visual-workspace";

const motionLabels = { none: "静态", "pan-left": "左移", "pan-right": "右移", "zoom-in": "推近", "zoom-out": "拉远" } as const;

export function VisualStage(props: Parameters<typeof useVisualWorkspace>[0]) {
  const state = useVisualWorkspace(props);
  const update = (patch: Partial<VisualSegmentDraft>) => state.setDraft((current) => current ? { ...current, ...patch } : current);
  const approvedForSelected = state.assets.find((asset) => asset.id === state.draft?.selectedAssetId)?.candidates.filter((candidate) => candidate.reviewStatus === "approved") ?? [];
  const openingSuggestion = state.plan.suggestion.openingMin === state.plan.suggestion.openingMax ? `${state.plan.suggestion.openingMin}` : `${state.plan.suggestion.openingMin}～${state.plan.suggestion.openingMax}`;
  return <section className="grid min-h-[calc(100vh-344px)] grid-cols-[minmax(270px,.75fr)_minmax(440px,1.2fr)_minmax(300px,.85fr)] max-xl:grid-cols-1" aria-labelledby="visual-stage-heading">
    <aside className="border-r border-[var(--border-subtle)] p-4 max-xl:border-b max-xl:border-r-0">
      <div className="mb-4 flex items-center justify-between"><h2 id="visual-stage-heading" className="text-sm font-bold">视觉段</h2><button type="button" disabled={state.busy || !state.timeline} onClick={state.addSegment} className="text-xs text-[var(--accent)] disabled:opacity-40">新增未覆盖段</button></div>
      <label className="grid gap-1 text-xs text-[var(--fg-secondary)]">明确时间轴<select className="rounded border border-[var(--border-subtle)] bg-[var(--bg-canvas)] p-2 font-mono text-[10px]" disabled={state.busy} value={state.timeline?.timelineHash ?? ""} onChange={(event) => state.chooseTimeline(event.target.value)}><option value="">无可用时间轴</option>{state.timelines.map((item) => <option value={item.timelineHash} key={item.timelineHash}>{item.timelineHash.slice(0, 12)} · {formatTimelineTime(item.durationMs)}</option>)}</select></label>
      <div className="mt-4 grid gap-2">{state.segments.map((segment) => <button type="button" key={segment.id} onClick={() => state.chooseSegment(segment)} className={`rounded border p-3 text-left ${state.draft?.segmentIndex === segment.segmentIndex ? "border-[var(--accent)]" : "border-[var(--border-subtle)]"}`}><span className="block text-xs font-semibold">段 {segment.segmentIndex + 1} · cue {segment.cueStartIndex + 1}–{segment.cueEndIndex + 1}</span><span className="mt-1 block text-[10px] text-[var(--fg-tertiary)]">{formatTimelineTime(segment.startMs)}–{formatTimelineTime(segment.endMs)} · {segment.productionReady ? "可生产" : "门禁未通过"} · r{segment.revision}</span></button>)}</div>
      {!state.segments.length ? <p className="mt-6 text-xs leading-6 text-[var(--fg-tertiary)]">尚无视觉段。建议按时间轴节奏覆盖全部字幕 cue，开头 15 秒保留 3～4 个有效画面。</p> : null}
    </aside>
    <div className="min-w-0 border-r border-[var(--border-subtle)] p-5 max-xl:border-b max-xl:border-r-0">
      {state.draft && state.timeline ? <div className="grid gap-5"><div><p className="font-mono text-[10px] text-[var(--accent)]">SEGMENT {state.draft.segmentIndex + 1} · EXPECTED R{state.draft.expectedRevision}</p><h3 className="mt-1 text-xl font-semibold">字幕与画面绑定</h3></div>
        <div className="grid grid-cols-2 gap-3"><label className="grid gap-1 text-xs">起始 cue<select className="rounded border border-[var(--border-subtle)] bg-[var(--bg-canvas)] p-2" value={state.draft.cueStartIndex} onChange={(event) => update({ cueStartIndex: Number(event.target.value), cueEndIndex: Math.max(state.draft!.cueEndIndex, Number(event.target.value)) })}>{state.timeline.cues.map((cue) => <option key={cue.index} value={cue.index}>{cue.index + 1} · {formatTimelineTime(cue.startMs)}</option>)}</select></label><label className="grid gap-1 text-xs">结束 cue<select className="rounded border border-[var(--border-subtle)] bg-[var(--bg-canvas)] p-2" value={state.draft.cueEndIndex} onChange={(event) => update({ cueEndIndex: Number(event.target.value) })}>{state.timeline.cues.filter((cue) => cue.index >= state.draft!.cueStartIndex).map((cue) => <option key={cue.index} value={cue.index}>{cue.index + 1} · {formatTimelineTime(cue.endMs)}</option>)}</select></label></div>
        <ol className="max-h-44 overflow-y-auto rounded border border-[var(--border-subtle)] bg-[var(--bg-subtle)] p-3 text-xs leading-6">{state.timeline.cues.slice(state.draft.cueStartIndex, state.draft.cueEndIndex + 1).map((cue) => <li key={cue.index}><span className="mr-2 font-mono text-[10px] text-[var(--fg-tertiary)]">{formatTimelineTime(cue.startMs)}–{formatTimelineTime(cue.endMs)}</span>{cue.text}</li>)}</ol>
        <fieldset className="grid gap-2"><legend className="mb-2 text-xs font-semibold">系列资产（至少一个）</legend>{state.assets.map((asset) => <label key={asset.id} className="flex items-center gap-2 text-xs"><input type="checkbox" checked={state.draft!.assetIds.includes(asset.id)} onChange={(event) => { const assetIds = event.target.checked ? [...state.draft!.assetIds, asset.id] : state.draft!.assetIds.filter((id) => id !== asset.id); update({ assetIds, ...(!assetIds.includes(state.draft!.selectedAssetId) ? { selectedAssetId: "", selectedCandidateId: "" } : {}) }); }} />{asset.name}{asset.stateLabel ? `（${asset.stateLabel}）` : ""}</label>)}</fieldset>
        <label className="grid gap-1 text-xs">承载画面的资产<select className="rounded border border-[var(--border-subtle)] bg-[var(--bg-canvas)] p-2" value={state.draft.selectedAssetId} onChange={(event) => update({ selectedAssetId: event.target.value, selectedCandidateId: "" })}><option value="">请选择</option>{state.assets.filter((asset) => state.draft!.assetIds.includes(asset.id)).map((asset) => <option key={asset.id} value={asset.id}>{asset.name}{asset.stateLabel ? `（${asset.stateLabel}）` : ""}</option>)}</select></label>
        <fieldset className="grid gap-2">
          <legend className="text-xs font-semibold">已批准候选画面</legend>
          {approvedForSelected.length ? <div className="grid grid-cols-[repeat(auto-fill,minmax(120px,1fr))] gap-3">
            {approvedForSelected.map((candidate) => {
              const candidateState = visualCandidateState(state.draft!.selectedCandidateId, candidate.id);
              return <button
                key={candidate.id}
                type="button"
                aria-pressed={candidateState.selected}
                onClick={() => update({ selectedCandidateId: candidate.id })}
                className={`min-h-11 overflow-hidden rounded border text-left focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--focus)] ${candidateState.selected ? "border-[var(--accent)] bg-[var(--bg-subtle)] ring-2 ring-[var(--accent)]" : "border-[var(--border-subtle)] bg-[var(--bg-canvas)] hover:bg-[var(--bg-subtle)]"}`}
              >
                <CandidateThumbnail id={candidate.id} label={`候选画面 ${candidate.width}×${candidate.height}`} />
                <span className="grid gap-1 p-2">
                  <span className="text-xs font-semibold">{candidateState.label}</span>
                  <span className="font-mono text-[10px] text-[var(--fg-tertiary)]">{candidate.width}×{candidate.height} · {Math.ceil(candidate.bytes / 1024)} KiB</span>
                </span>
              </button>;
            })}
          </div> : <p className="rounded border border-dashed border-[var(--border-subtle)] p-4 text-xs text-[var(--fg-tertiary)]">当前资产没有已批准候选图。请先在资产阶段批准候选后再绑定画面。</p>}
        </fieldset>
        <div className="grid grid-cols-3 gap-3"><label className="grid gap-1 text-xs">运镜<select className="rounded border border-[var(--border-subtle)] bg-[var(--bg-canvas)] p-2" value={state.draft.motionKind} onChange={(event) => update({ motionKind: event.target.value as VisualSegmentDraft["motionKind"], ...(event.target.value === "none" ? { motionAmountPpm: 0 } : {}) })}>{Object.entries(motionLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label><label className="grid gap-1 text-xs">幅度 ppm<input type="number" min="0" max="1000000" disabled={state.draft.motionKind === "none"} className="rounded border border-[var(--border-subtle)] bg-[var(--bg-canvas)] p-2" value={state.draft.motionAmountPpm} onChange={(event) => update({ motionAmountPpm: Number(event.target.value) })} /></label><label className="grid gap-1 text-xs">淡变 ms<input type="number" min="0" max="10000" className="rounded border border-[var(--border-subtle)] bg-[var(--bg-canvas)] p-2" value={state.draft.fadeMs} onChange={(event) => update({ fadeMs: Number(event.target.value) })} /></label></div>
        <button type="button" disabled={state.busy} onClick={() => void state.saveSegment()} className="min-h-10 rounded bg-[var(--accent)] px-4 text-sm font-semibold text-white disabled:opacity-40">保存并回读视觉段</button>
      </div> : <div className="grid min-h-72 place-items-center text-sm text-[var(--fg-tertiary)]">选择已有视觉段，或新增一个未覆盖段。</div>}
    </div>
    <aside className="p-4"><h3 className="text-sm font-bold">联系表预览</h3><p className="mt-2 text-xs leading-6 text-[var(--fg-tertiary)]">{state.plan.continuous ? "字幕已连续覆盖" : "字幕尚未完整连续覆盖"} · {state.segments.length}/{state.plan.suggestion.targetCount || "?"} 段建议 · 开头 {state.plan.suggestion.openingCount}/{openingSuggestion} 画面 · {state.plan.productionReady ? "全部可生产" : "存在未通过门禁的绑定"}</p>
      <div className="mt-4 grid grid-cols-2 gap-2">{[...state.segments].sort((a, b) => a.segmentIndex - b.segmentIndex).map((segment) => { const selected = segment.assets.find((asset) => asset.selectedCandidateId)?.selectedCandidateId; return <article key={segment.id} className="overflow-hidden rounded border border-[var(--border-subtle)] bg-[var(--bg-subtle)]">{selected ? <img src={`/api/candidates/${encodeURIComponent(selected)}/image`} alt={`视觉段 ${segment.segmentIndex + 1} 预览`} className="aspect-[9/16] w-full object-cover" /> : <div className="grid aspect-[9/16] place-items-center text-[10px] text-[var(--fg-tertiary)]">未绑定图片</div>}<p className="p-2 text-[10px]">段 {segment.segmentIndex + 1} · cue {segment.cueStartIndex + 1}–{segment.cueEndIndex + 1}</p></article>; })}</div>
      {!state.reviewWorkspace ? <button type="button" disabled={state.busy || !state.plan.productionReady} onClick={() => void state.exportContactSheet()} className="mt-4 min-h-11 w-full rounded bg-[var(--accent)] px-3 text-xs font-semibold text-white disabled:bg-[var(--bg-subtle)] disabled:text-[var(--fg-tertiary)]">{state.busy ? "正在处理…" : "服务端真实导出联系表"}</button> : null}
      {state.contactSheet ? <dl className="mt-4 grid gap-2 break-all rounded border border-[var(--border-subtle)] p-3 text-[10px]"><div><dt className="text-[var(--fg-tertiary)]">JSON</dt><dd>{state.contactSheet.jsonPath}</dd><dd className="font-mono">{state.contactSheet.jsonHash}</dd></div><div><dt className="text-[var(--fg-tertiary)]">HTML</dt><dd>{state.contactSheet.htmlPath}</dd><dd className="font-mono">{state.contactSheet.htmlHash}</dd></div></dl> : null}
      <section aria-labelledby="contact-sheet-review-title" className="mt-5 border-t border-[var(--border-subtle)] pt-5">
        <h4 id="contact-sheet-review-title" className="text-sm font-bold">整集联系表人工审核</h4>
        <p className="mt-2 text-xs leading-5 text-[var(--fg-tertiary)]">导出、预览和逐图批准都不会自动通过整集审核。视觉段或时间轴变化后，旧审核会自动失效。</p>
        <p aria-live="polite" className={`mt-3 rounded border px-3 py-2 text-xs leading-5 ${state.reviewStatus === "failure" ? "border-[var(--danger)] text-[var(--danger)]" : "border-[var(--border-subtle)] text-[var(--fg-secondary)]"}`}>{state.reviewMessage}</p>
        {state.reviewWorkspace ? <>
          <label className="mt-4 flex min-h-11 cursor-pointer items-start gap-3 rounded border border-[var(--border-subtle)] p-3 text-xs leading-5">
            <input type="checkbox" checked={state.reviewConfirmed} disabled={state.busy} onChange={(event) => state.setReviewConfirmed(event.target.checked)} className="mt-0.5 h-5 w-5 shrink-0 accent-[var(--accent)]" />
            <span>我已查看本集全部画面，并核对开头节奏与字幕覆盖。</span>
          </label>
          <label className="mt-3 grid gap-2 text-xs font-semibold">审核备注（可选）
            <textarea value={state.reviewNotes} disabled={state.busy} maxLength={2000} onChange={(event) => state.setReviewNotes(event.target.value)} className="min-h-20 rounded border border-[var(--border-subtle)] bg-[var(--bg-canvas)] p-3 font-normal focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--focus)]" placeholder="记录需返修的画面、节奏或字幕覆盖问题。" />
          </label>
          <button type="button" disabled={state.busy || !state.reviewConfirmed} onClick={() => void state.submitContactSheetReview("approve")} className="mt-3 min-h-11 w-full rounded bg-[var(--accent)] px-3 text-xs font-semibold text-white disabled:bg-[var(--bg-subtle)] disabled:text-[var(--fg-tertiary)]">{state.reviewStatus === "loading" ? "正在处理…" : "通过整集联系表审核"}</button>
          <button type="button" disabled={state.busy} onClick={() => void state.submitContactSheetReview("reject")} className="mt-3 min-h-11 w-full rounded border border-[var(--border-strong)] px-3 text-xs font-semibold disabled:opacity-50">不通过</button>
          {state.reviewWorkspace.latestReview ? <p className="mt-3 text-xs leading-5 text-[var(--fg-tertiary)]">当前身份最新结果：{state.reviewWorkspace.latestReview.action === "approve" ? "已通过" : "不通过"}{state.reviewWorkspace.latestReview.notes ? ` · ${state.reviewWorkspace.latestReview.notes}` : ""}</p> : null}
        </> : null}
      </section>
    </aside>
  </section>;
}

function CandidateThumbnail({ id, label }: { id: string; label: string }) {
  const [failed, setFailed] = useState(false);
  return failed
    ? <div className="grid aspect-[9/16] place-items-center bg-[var(--bg-canvas)] p-2 text-center text-xs text-[var(--danger)]">图片加载失败</div>
    : <img src={`/api/candidates/${encodeURIComponent(id)}/image`} alt={label} className="aspect-[9/16] w-full bg-[var(--bg-canvas)] object-cover" onError={() => setFailed(true)} />;
}
