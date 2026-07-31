import React from "react";

import { buttonVariants } from "../components/ui/button";
import { candidateIdentity, currentImageCandidates, formatImageCandidateTime, historicalImageCandidates, styleSnapshotLabel, type VideoImageCandidate, type VideoImageVisual } from "./image-logic";

const secondaryButton = buttonVariants({ variant: "outline" });
const primaryButton = buttonVariants({ variant: "default" });

function Candidate({ candidate, candidateIndex, visual, disabled, approving, onApprove }: {
  candidate: VideoImageCandidate;
  candidateIndex: number;
  visual: VideoImageVisual;
  disabled: boolean;
  approving: boolean;
  onApprove: (candidateId: string) => void;
}) {
  return <article className="w-[min(19rem,calc(100vw-3rem))] shrink-0 border border-[var(--border-subtle)] bg-[var(--bg-surface)]" aria-label={`${candidateIdentity(candidate)}${candidate.approved ? "，已批准" : ""}`}>
    <div className="aspect-[9/16] overflow-hidden bg-[var(--bg-inset)]">
      <img className="h-full w-full object-contain" src={candidate.previewUrl} alt={`画面 ${String(visual.order + 1).padStart(2, "0")}：${visual.description}；候选 ${candidateIndex + 1}，${candidate.origin === "upload" ? "上传" : "生成"}，${candidate.approved ? "已批准" : candidate.currentCompatible ? "待审核" : "历史"}`} loading="lazy" />
    </div>
    <div className="space-y-3 p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm font-semibold">{candidate.origin === "upload" ? "上传候选" : "生成候选"}</p>
        <span className="rounded border border-[var(--border-strong)] px-2 py-0.5 text-xs">{candidate.approved ? "已批准" : candidate.currentCompatible ? "当前可用" : "历史 / 已失效"}</span>
      </div>
      <p className="break-words font-mono text-[11px] leading-5 text-[var(--fg-tertiary)]">{candidateIdentity(candidate)}</p>
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs leading-5 text-[var(--fg-secondary)]">
        <dt>实际媒体</dt><dd>{candidate.width}×{candidate.height} · {Math.ceil(candidate.bytes / 1024)}KiB</dd>
        <dt>画幅</dt><dd>{candidate.params.aspectRatio || "未返回"}</dd>
        <dt>创建时间</dt><dd>{formatImageCandidateTime(candidate.createdAt)}</dd>
        <dt>文件哈希</dt><dd className="truncate font-mono" title={candidate.fileHash}>{candidate.fileHash}</dd>
        {candidate.providerRequestId ? <><dt>上游请求</dt><dd className="truncate font-mono" title={candidate.providerRequestId}>{candidate.providerRequestId}</dd></> : null}
      </dl>
      <details className="border-t border-[var(--border-subtle)] pt-3 text-xs leading-5">
        <summary className="min-h-11 cursor-pointer py-3 font-semibold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus)]">查看完整生成身份</summary>
        <div className="space-y-3 break-words text-[var(--fg-secondary)]">
          <div><p className="font-semibold text-[var(--fg-primary)]">Prompt</p><p className="mt-1 whitespace-pre-wrap">{candidate.prompt || "未记录"}</p></div>
          <div><p className="font-semibold text-[var(--fg-primary)]">Negative prompt</p><p className="mt-1 whitespace-pre-wrap">{candidate.negativePrompt || "未设置"}</p></div>
          <div><p className="font-semibold text-[var(--fg-primary)]">画面风格快照</p><p className="mt-1 whitespace-pre-wrap">{styleSnapshotLabel(candidate.styleSnapshot) || "未设置"}</p></div>
          <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 font-mono">
            <dt>候选</dt><dd className="break-all">{candidate.id}</dd>
            <dt>方案快照</dt><dd className="break-all">{candidate.planSnapshotId} / {candidate.planSnapshotHash}</dd>
            <dt>旁白修订</dt><dd className="break-all">{candidate.scriptRevisionId} / {candidate.scriptContentHash}</dd>
            <dt>画面修订</dt><dd className="break-all">{candidate.visualRevisionId} / {candidate.visualContentHash}</dd>
            <dt>Prompt hash</dt><dd className="break-all">{candidate.promptHash}</dd>
            <dt>请求身份</dt><dd className="break-all">{candidate.requestIdentity}</dd>
            <dt>批次 / 幂等键</dt><dd className="break-all">{candidate.batchId ?? "上传"} / {candidate.idempotencyKey ?? "无"}</dd>
            <dt>Job / 尝试</dt><dd className="break-all">{candidate.jobId ?? "无"} / {candidate.attempt}</dd>
            <dt>Checkpoint</dt><dd className="break-all">{candidate.checkpointScope ?? "无"}</dd>
            <dt>媒体身份</dt><dd className="break-all">{candidate.mime} / {candidate.relativePath}</dd>
          </dl>
        </div>
      </details>
      {candidate.currentCompatible ? <button className={`${candidate.approved ? secondaryButton : primaryButton} w-full`} type="button" disabled={disabled || candidate.approved} onClick={() => onApprove(candidate.id)}>{candidate.approved ? "当前已批准" : approving ? "正在批准…" : "选择并批准"}</button> : <p className="text-xs leading-5 text-[var(--fg-tertiary)]">上游方案或提示词已经变化。此候选仅供历史查看，不能批准。</p>}
    </div>
  </article>;
}

export function VisualImageReviewRow({ visual, productionAllowed, busyAction, onGenerate, onUpload, onApprove }: {
  visual: VideoImageVisual;
  productionAllowed: boolean;
  busyAction: string | null;
  onGenerate: (regenerate: boolean) => void;
  onUpload: (file: File) => void;
  onApprove: (candidateId: string) => void;
}) {
  const current = currentImageCandidates(visual);
  const historical = historicalImageCandidates(visual);
  const approved = current.some((candidate) => candidate.approved);
  const busy = busyAction !== null;
  const generating = busyAction === `generate:${visual.id}`;
  const uploading = busyAction === `upload:${visual.id}`;
  const approving = busyAction === `approve:${visual.id}`;
  const activeGeneration = visual.generationState?.status === "queued" || visual.generationState?.status === "running";
  const generationLabel = visual.generationState && ({ queued: "排队中", running: "正在生成", succeeded: "已生成候选", failed: "生成失败", cancelled: "已中断" } as const)[visual.generationState.status];

  return <article className="min-w-0 border-t border-[var(--border-subtle)] py-6 first:border-t-0" aria-labelledby={`visual-${visual.id}`}>
    <div className="grid min-w-0 gap-5 lg:grid-cols-[minmax(15rem,21rem)_minmax(0,1fr)]">
      <header className="min-w-0 px-5 lg:px-0">
        <div className="flex flex-wrap items-center justify-between gap-2"><p className="font-mono text-[11px] font-semibold tracking-[.12em] text-[var(--accent)]">画面 {String(visual.order + 1).padStart(2, "0")}</p><span className="rounded border border-[var(--border-strong)] px-2 py-0.5 text-xs">{approved ? "图片已批准" : "等待批准"}</span></div>
        <h3 id={`visual-${visual.id}`} className="mt-3 text-base font-semibold leading-7">{visual.description}</h3>
        <p className="mt-3 text-sm leading-6 text-[var(--fg-secondary)]"><span className="font-semibold text-[var(--fg-primary)]">旁白摘要：</span>{visual.narrationSummary}</p>
        <div className="mt-4 space-y-3 text-sm leading-6"><div><p className="font-semibold">Prompt</p><p className="mt-1 whitespace-pre-wrap break-words text-[var(--fg-secondary)]">{visual.prompt}</p></div>{visual.negativePrompt ? <div><p className="font-semibold">Negative prompt</p><p className="mt-1 whitespace-pre-wrap break-words text-[var(--fg-secondary)]">{visual.negativePrompt}</p></div> : null}</div>
        {generationLabel ? <p className="mt-4 text-sm font-semibold" role={visual.generationState?.status === "failed" ? "alert" : "status"}>{generationLabel}{visual.generationState?.errorSummary ? `：${visual.generationState.errorSummary}` : ""}</p> : null}
        <div className="mt-5 flex flex-wrap gap-2">
          <button className={secondaryButton} type="button" disabled={!productionAllowed || busy || activeGeneration} onClick={() => onGenerate(current.length > 0)}>{generating ? "正在创建任务…" : activeGeneration ? generationLabel : current.length ? "重新生成" : visual.generationState?.status === "failed" ? "重试失败项" : "生成单张"}</button>
          <label className={`${secondaryButton} cursor-pointer ${!productionAllowed || busy ? "pointer-events-none opacity-50" : ""}`}>
            {uploading ? "正在上传…" : "上传图片"}
            <input className="sr-only" type="file" accept="image/png,image/jpeg,image/webp" disabled={!productionAllowed || busy} onChange={(event) => { const file = event.currentTarget.files?.[0]; if (file) onUpload(file); event.currentTarget.value = ""; }} />
          </label>
        </div>
      </header>
      <div className="min-w-0">
        {current.length ? <div className="overflow-x-auto px-5 pb-3 lg:px-0" aria-label="当前可用图片候选"><div className="flex w-max gap-3">{current.map((candidate, index) => <Candidate key={candidate.id} candidate={candidate} candidateIndex={index} visual={visual} disabled={!productionAllowed || busy} approving={approving} onApprove={onApprove} />)}</div></div> : <div className="mx-5 min-h-32 border border-dashed border-[var(--border-strong)] bg-[var(--bg-inset)] p-5 text-sm leading-6 text-[var(--fg-secondary)] lg:mx-0"><p>该画面尚无当前可用候选。</p><p className="mt-1">可生成单张图片，或上传本地 PNG、JPEG、WebP 文件。</p></div>}
        {historical.length ? <details className="mx-5 mt-4 border-t border-[var(--border-subtle)] lg:mx-0"><summary className="min-h-11 cursor-pointer py-3 text-sm font-semibold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus)]">历史 / 已失效候选（{historical.length}）</summary><div className="overflow-x-auto pb-3"><div className="flex w-max gap-3">{historical.map((candidate, index) => <Candidate key={candidate.id} candidate={candidate} candidateIndex={current.length + index} visual={visual} disabled approving={false} onApprove={() => undefined} />)}</div></div></details> : null}
      </div>
    </div>
  </article>;
}
