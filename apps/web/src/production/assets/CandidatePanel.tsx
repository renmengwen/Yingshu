import { useState } from "react";

import { Badge } from "../../components/ui/badge";
import { Button, buttonVariants } from "../../components/ui/button";
import { Textarea } from "../../components/ui/textarea";
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
    <div className="m-3 grid gap-2">
      <label className={`focus-ring-proxy ${buttonVariants({ variant: "outline" })} ${busy || !assetName ? "cursor-not-allowed opacity-50" : "cursor-pointer"}`}>上传原图<input className="sr-only" type="file" accept="image/png,image/jpeg,image/webp" disabled={busy || !assetName} onChange={(event) => { const file = event.currentTarget.files?.[0]; event.currentTarget.value = ""; if (file) onUpload(file); }} /></label>
      {!assetName ? <p className="text-xs leading-5 text-[var(--fg-tertiary)]">无法上传：请先选择资产。</p> : null}
    </div>
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
              {source.kind === "generation" ? <><span className="text-[10px] text-[var(--fg-tertiary)]">{source.provider} / {source.model} · 稿件 {source.scriptVersionId} · 批准 r{source.approvalRevision}</span><span className="break-all font-mono text-[9px] text-[var(--fg-tertiary)]">prompt {source.promptHash}{source.derivedFromCandidateId ? ` · 父候选 ${source.derivedFromCandidateId}` : ""}</span>{source.revisedPrompt ? <p className="text-[10px] leading-5 text-[var(--fg-tertiary)]">模型修订：{source.revisedPrompt}</p> : null}<Button className="justify-self-start" variant="link" size="sm" disabled={busy} type="button" onClick={() => onRestore(candidate)}>恢复完整 Prompt 并派生</Button></> : <span className="text-[10px] text-[var(--fg-tertiary)]">{source.originalName ?? "本地来源"}</span>}
            </div>
          </details>
        </div>
        <div className="grid grid-cols-[1fr_auto_auto] items-center gap-2 border-t border-[var(--border-subtle)] p-2.5"><div className="flex flex-wrap items-center gap-2"><Badge variant={candidate.reviewStatus === "approved" ? "default" : "outline"}>{statusLabel[candidate.reviewStatus]}</Badge><span className="font-mono text-[10px] text-[var(--fg-tertiary)]">r{candidate.reviewRevision}</span></div><Button variant="outline" size="sm" type="button" disabled={busy} onClick={() => void onReview(candidate, "approve")}>批准</Button><Button variant="outline" size="sm" type="button" disabled={busy} onClick={() => void onReview(candidate, "reject")}>淘汰</Button></div>
        <div className="grid gap-2 border-t border-[var(--border-subtle)] p-2.5"><Textarea className="min-h-16 resize-y text-xs" value={note} disabled={busy} placeholder="审核备注（不会改变批准状态）" onChange={(event) => setNotes((current) => ({ ...current, [candidate.id]: event.target.value }))} /><div className="flex flex-wrap gap-2"><Button variant="outline" size="sm" type="button" disabled={busy || !note.trim()} onClick={() => void onReview(candidate, "note", note.trim()).then((saved) => { if (saved) setNotes((current) => ({ ...current, [candidate.id]: "" })); })}>记录备注</Button><Button variant="ghost" size="sm" type="button" disabled={busy} onClick={() => onLoadHistory(candidate)}>刷新审核历史</Button></div>
          {history ? <details className="rounded border border-[var(--border-subtle)] bg-[var(--bg-canvas)]">
            <summary className="min-h-11 cursor-pointer px-3 py-2 text-xs font-semibold focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--focus)]">展开候选审核历史</summary>
            <ol className="grid gap-1 border-t border-[var(--border-subtle)] p-3 text-[10px] text-[var(--fg-tertiary)]">{history.map((event) => <li key={event.revision}>r{event.revision} · {actionLabel[event.action]}{event.note ? ` · ${event.note}` : ""}</li>)}</ol>
          </details> : null}
        </div>
      </article>;
    })}{assetName && !candidates.length ? <p className="m-7 text-[13px] text-[var(--fg-tertiary)]">尚无候选图。生成和上传都应追加到这里，不覆盖旧图。</p> : null}</div>
  </aside>;
}
