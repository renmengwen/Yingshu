import { useState } from "react";

import type { CandidateRecord, CandidateReviewEvent } from "./types";

const statusLabel = { pending: "待审核", approved: "已批准", rejected: "已淘汰" } as const;
const actionLabel = { approve: "批准", reject: "淘汰", note: "备注" } as const;

export function CandidatePanel({ candidates, histories, assetName, busy, onUpload, onRestore, onLoadHistory, onReview }: {
  candidates: CandidateRecord[];
  histories: Record<string, CandidateReviewEvent[]>;
  assetName?: string;
  busy: boolean;
  onUpload: (file: File) => void;
  onRestore: (candidate: CandidateRecord) => void;
  onLoadHistory: (candidate: CandidateRecord) => void;
  onReview: (candidate: CandidateRecord, action: "approve" | "reject" | "note", note?: string) => Promise<boolean>;
}) {
  const [notes, setNotes] = useState<Record<string, string>>({});
  return <aside className="min-w-0" aria-labelledby="candidate-heading">
    <div className="flex h-12 items-center justify-between border-b border-[var(--border-subtle)] px-4"><h2 id="candidate-heading" className="text-xs font-bold tracking-wider">候选图</h2><span className="font-mono text-[10px] text-[var(--fg-tertiary)]">{candidates.length}</span></div>
    <label className="focus-ring-proxy m-3 grid min-h-11 cursor-pointer place-items-center rounded border border-dashed border-[var(--border-subtle)] px-3 text-xs text-[var(--accent)]">上传原图<input className="sr-only" type="file" accept="image/png,image/jpeg,image/webp" disabled={busy || !assetName} onChange={(event) => { const file = event.currentTarget.files?.[0]; event.currentTarget.value = ""; if (file) onUpload(file); }} /></label>
    <div className="max-h-[calc(100vh-457px)] overflow-y-auto p-3">{candidates.map((candidate) => {
      const source = candidate.source;
      const history = histories[candidate.id];
      const note = notes[candidate.id] ?? "";
      return <article className={`mb-3 overflow-hidden rounded-xl border bg-[var(--bg-subtle)] ${candidate.reviewStatus === "approved" ? "border-[var(--accent)]" : "border-[var(--border-subtle)]"}`} key={candidate.id}>
        <img className="block aspect-[9/16] w-full bg-[var(--bg-canvas)] object-cover" src={`/api/candidates/${encodeURIComponent(candidate.id)}/image`} alt={`${assetName ?? "资产"}候选图`} />
        <div className="grid gap-1 p-2.5"><strong className="text-xs">{source.kind === "generation" ? "生成候选 / Prompt 版本" : "上传候选（无 Prompt 版本）"}</strong><span className="text-[10px] text-[var(--fg-tertiary)]">{candidate.width}×{candidate.height} · {Math.ceil(candidate.bytes / 1024)} KiB</span>
          <details className="mt-2 rounded border border-[var(--border-subtle)] bg-[var(--bg-canvas)]">
            <summary className="min-h-11 cursor-pointer px-3 py-2 text-xs font-semibold focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--focus)]">展开候选溯源元数据与备注辅助信息</summary>
            <div className="grid gap-2 border-t border-[var(--border-subtle)] p-3">
              {source.kind === "generation" ? <><span className="text-[10px] text-[var(--fg-tertiary)]">{source.provider} / {source.model} · 稿件 {source.scriptVersionId} · 批准 r{source.approvalRevision}</span><span className="break-all font-mono text-[9px] text-[var(--fg-tertiary)]">prompt {source.promptHash}{source.derivedFromCandidateId ? ` · 父候选 ${source.derivedFromCandidateId}` : ""}</span>{source.revisedPrompt ? <p className="text-[10px] leading-5 text-[var(--fg-tertiary)]">模型修订：{source.revisedPrompt}</p> : null}<button className="justify-self-start text-xs text-[var(--accent)] disabled:opacity-50" disabled={busy} type="button" onClick={() => onRestore(candidate)}>恢复完整 Prompt 并派生</button></> : <span className="text-[10px] text-[var(--fg-tertiary)]">{source.originalName ?? "本地来源"}</span>}
            </div>
          </details>
        </div>
        <div className="grid grid-cols-[1fr_auto_auto] items-center gap-2 border-t border-[var(--border-subtle)] p-2.5"><span className="text-[10px] text-[var(--fg-tertiary)]">{statusLabel[candidate.reviewStatus]} · r{candidate.reviewRevision}</span><button className="text-xs text-[var(--accent)] disabled:opacity-50" type="button" disabled={busy} onClick={() => void onReview(candidate, "approve")}>批准</button><button className="text-xs text-[var(--accent)] disabled:opacity-50" type="button" disabled={busy} onClick={() => void onReview(candidate, "reject")}>淘汰</button></div>
        <div className="grid gap-2 border-t border-[var(--border-subtle)] p-2.5"><textarea className="min-h-16 resize-y rounded border border-[var(--border-subtle)] bg-[var(--bg-canvas)] p-2 text-xs" value={note} disabled={busy} placeholder="审核备注（不会改变批准状态）" onChange={(event) => setNotes((current) => ({ ...current, [candidate.id]: event.target.value }))} /><div className="flex gap-3"><button className="text-xs text-[var(--accent)] disabled:opacity-50" type="button" disabled={busy || !note.trim()} onClick={() => void onReview(candidate, "note", note.trim()).then((saved) => { if (saved) setNotes((current) => ({ ...current, [candidate.id]: "" })); })}>记录备注</button><button className="text-xs text-[var(--accent)] disabled:opacity-50" type="button" disabled={busy} onClick={() => onLoadHistory(candidate)}>刷新审核历史</button></div>
          {history ? <details className="rounded border border-[var(--border-subtle)] bg-[var(--bg-canvas)]">
            <summary className="min-h-11 cursor-pointer px-3 py-2 text-xs font-semibold focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--focus)]">展开候选审核历史</summary>
            <ol className="grid gap-1 border-t border-[var(--border-subtle)] p-3 text-[10px] text-[var(--fg-tertiary)]">{history.map((event) => <li key={event.revision}>r{event.revision} · {actionLabel[event.action]}{event.note ? ` · ${event.note}` : ""}</li>)}</ol>
          </details> : null}
        </div>
      </article>;
    })}{assetName && !candidates.length ? <p className="m-7 text-[13px] text-[var(--fg-tertiary)]">尚无候选图。生成和上传都应追加到这里，不覆盖旧图。</p> : null}</div>
  </aside>;
}
