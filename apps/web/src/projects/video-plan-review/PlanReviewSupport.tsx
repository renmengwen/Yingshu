import { useRef, type RefObject } from "react";

import { Alert, AlertDescription, AlertTitle } from "../../components/ui/alert";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../../components/ui/dialog";
import type { VideoPlan, VideoPlanSource } from "../types";
import type { planReviewGates } from "./logic";

type PlanOverviewProps = {
  plan: VideoPlan;
  sourceCount: number;
  incompatible: boolean;
};

export function PlanOverview({ plan, sourceCount, incompatible }: PlanOverviewProps) {
  const approvalLabel = plan.stale
    ? "已失效"
    : incompatible
      ? "修订不兼容"
      : plan.approval?.valid
        ? "已批准"
        : "等待批准";

  return <section aria-labelledby="plan-overview-heading" className="border-y border-[var(--border-subtle)] bg-[var(--surface-primary)] py-5">
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div>
        <h3 id="plan-overview-heading" className="text-base font-semibold">方案概览</h3>
        <p className="mt-1 text-sm text-[var(--fg-secondary)]">当前旁白与画面修订的审核摘要。</p>
      </div>
      <Badge variant="outline">{approvalLabel}</Badge>
    </div>

    <dl className="mt-5 grid grid-cols-2 gap-x-5 gap-y-4 text-sm sm:grid-cols-3 lg:grid-cols-6">
      <div><dt className="text-xs text-[var(--fg-muted)]">旁白修订</dt><dd className="mt-1 font-mono font-semibold">R{String(plan.script.revision).padStart(2, "0")}</dd></div>
      <div><dt className="text-xs text-[var(--fg-muted)]">画面修订</dt><dd className="mt-1 font-mono font-semibold">R{String(plan.visual.revision).padStart(2, "0")}</dd></div>
      <div><dt className="text-xs text-[var(--fg-muted)]">旁白字数</dt><dd className="mt-1 font-mono font-semibold">{plan.script.estimatedCharacters.toLocaleString("zh-CN")} 字</dd></div>
      <div><dt className="text-xs text-[var(--fg-muted)]">估算时长</dt><dd className="mt-1 font-mono font-semibold">{plan.script.estimatedDurationSeconds} 秒</dd></div>
      <div><dt className="text-xs text-[var(--fg-muted)]">联网来源</dt><dd className="mt-1 font-mono font-semibold">{sourceCount} 条</dd></div>
      <div><dt className="text-xs text-[var(--fg-muted)]">批准状态</dt><dd className="mt-1 font-semibold">{approvalLabel}</dd></div>
    </dl>

    {plan.stale ? <Alert className="mt-5 border-[var(--status-warning)] bg-[var(--status-warning-soft)] text-[var(--status-warning)]"><AlertDescription className="text-current">输入快照已经变化，当前方案已失效。请重新生成方案。</AlertDescription></Alert> : incompatible ? <Alert className="mt-5 border-[var(--status-warning)] bg-[var(--status-warning-soft)] text-[var(--status-warning)]"><AlertDescription className="text-current">画面方案尚未绑定当前旁白修订。请先保存兼容的画面修订。</AlertDescription></Alert> : null}
  </section>;
}

type SourcesRisksDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  triggerRef?: RefObject<HTMLElement | null>;
  webEnabled: boolean;
  sources: readonly VideoPlanSource[];
  sourceSummary: readonly string[];
  risks: readonly string[];
};

export function SourcesRisksDialog({
  open,
  onOpenChange,
  triggerRef,
  webEnabled,
  sources,
  sourceSummary,
  risks,
}: SourcesRisksDialogProps) {
  const closeRef = useRef<HTMLButtonElement>(null);

  return <Dialog open={open} onOpenChange={onOpenChange}>
    <DialogContent showCloseButton={false} onOpenAutoFocus={(event) => { event.preventDefault(); closeRef.current?.focus(); }} onCloseAutoFocus={(event) => { event.preventDefault(); triggerRef?.current?.focus(); }}>
    <DialogHeader>
      <DialogTitle>来源与风险详情</DialogTitle>
      <DialogDescription>查看当前方案冻结的联网来源、资料摘要与待核对项。</DialogDescription>
    </DialogHeader>

    <div className="grid gap-7 p-5 sm:p-6">
      <section aria-labelledby="frozen-sources-heading">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h3 id="frozen-sources-heading" className="text-sm font-semibold">冻结来源</h3>
          <span className="text-xs text-[var(--fg-muted)]">{webEnabled ? `已启用联网 · ${sources.length} 条` : "本次未启用联网"}</span>
        </div>
        {sources.length ? <ol className="mt-3 divide-y divide-[var(--border-subtle)] border-y border-[var(--border-subtle)]">
          {sources.map((source) => <li className="py-4" key={source.id}>
            <a className="font-semibold text-[var(--accent-primary)] underline-offset-4 hover:underline" href={source.url} target="_blank" rel="noreferrer">{source.title}</a>
            <p className="mt-1 break-all font-mono text-xs text-[var(--fg-muted)]">{source.url}</p>
            <p className="mt-2 text-sm leading-6 text-[var(--fg-secondary)]">{source.usageSummary}</p>
            <p className="mt-2 text-xs text-[var(--fg-muted)]">检索于 {new Date(source.retrievedAt).toLocaleString("zh-CN")}</p>
          </li>)}
        </ol> : <p className="mt-3 text-sm leading-6 text-[var(--fg-secondary)]">{webEnabled ? "本次允许联网，但没有冻结可用来源。" : "本次未联网核验，也没有生成来源 URL。"}</p>}
      </section>

      <section aria-labelledby="source-summary-heading">
        <h3 id="source-summary-heading" className="text-sm font-semibold">资料摘要（{sourceSummary.length}）</h3>
        {sourceSummary.length ? <ul className="mt-3 list-disc space-y-2 pl-5 text-sm leading-6 text-[var(--fg-secondary)]">{sourceSummary.map((item, index) => <li key={`${index}:${item}`}>{item}</li>)}</ul> : <p className="mt-3 text-sm text-[var(--fg-secondary)]">当前旁白没有资料摘要。</p>}
      </section>

      <section aria-labelledby="plan-risks-heading">
        <h3 id="plan-risks-heading" className="text-sm font-semibold">风险与待核对项（{risks.length}）</h3>
        {risks.length ? <ul className="mt-3 list-disc space-y-2 pl-5 text-sm leading-6 text-[var(--fg-secondary)]">{risks.map((risk, index) => <li key={`${index}:${risk}`}>{risk}</li>)}</ul> : <p className="mt-3 text-sm text-[var(--fg-secondary)]">当前方案没有标记待核对项。</p>}
      </section>
    </div>

    <DialogFooter><DialogClose asChild><Button ref={closeRef} variant="outline">关闭详情</Button></DialogClose></DialogFooter>
    </DialogContent>
  </Dialog>;
}

type PlanActionBarProps = {
  gates: ReturnType<typeof planReviewGates>;
  busy: boolean;
  approved: boolean;
  incompatible: boolean;
  stale: boolean;
  onSaveScript: () => void | Promise<void>;
  onSaveVisuals: () => void | Promise<void>;
  onApprove: () => void | Promise<void>;
};

export function PlanActionBar({
  gates,
  busy,
  approved,
  incompatible,
  stale,
  onSaveScript,
  onSaveVisuals,
  onApprove,
}: PlanActionBarProps) {
  const status = stale
    ? { label: "方案已失效", reason: gates.approve.reason }
    : incompatible
      ? { label: "修订不兼容", reason: gates.approve.reason }
      : busy
        ? { label: "正在处理…", reason: "当前操作尚未完成，请稍候。" }
        : approved
          ? { label: "当前方案已批准", reason: gates.approve.reason }
          : gates.unsavedCount
            ? { label: `${gates.unsavedCount} 组修改未保存`, reason: gates.approve.reason }
            : { label: "可以批准", reason: "批准只绑定当前方案，不会启动后续生产。" };

  return <aside className="fixed inset-x-0 bottom-0 z-40 mx-auto w-full max-w-[1440px] border border-[var(--border-strong)] bg-[var(--surface-raised)] p-3 shadow-[var(--shadow-popover)] sm:bottom-3 sm:w-[calc(100%-2rem)] sm:rounded-lg sm:p-4" aria-label="方案保存与批准">
    <div className="flex min-w-0 flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
      <Alert className="min-w-0 border-0 bg-transparent p-0" role={stale || incompatible ? "alert" : "status"} aria-live={stale || incompatible ? undefined : "polite"}>
        <AlertTitle>{status.label}</AlertTitle>
        <AlertDescription className="text-xs leading-5">{status.reason}</AlertDescription>
      </Alert>
      <div className="grid min-w-0 shrink-0 gap-2 sm:grid-cols-3">
        <div className="grid min-w-0 content-start gap-1">
          <Button variant="outline" type="button" disabled={!gates.saveScript.allowed} onClick={() => void onSaveScript()}>{busy ? "处理中…" : "保存旁白修订"}</Button>
          {!gates.saveScript.allowed ? <p className="max-w-52 text-xs leading-5 text-[var(--fg-muted)]">{gates.saveScript.reason}</p> : null}
        </div>
        <div className="grid min-w-0 content-start gap-1">
          <Button variant="outline" type="button" disabled={!gates.saveVisual.allowed} onClick={() => void onSaveVisuals()}>{busy ? "处理中…" : incompatible ? "保存兼容画面修订" : "保存画面修订"}</Button>
          {!gates.saveVisual.allowed ? <p className="max-w-52 text-xs leading-5 text-[var(--fg-muted)]">{gates.saveVisual.reason}</p> : null}
        </div>
        <div className="grid min-w-0 content-start gap-1">
          <Button type="button" disabled={!gates.approve.allowed} onClick={() => void onApprove()}>{busy ? "处理中…" : approved ? "当前方案已批准" : "批准当前方案"}</Button>
          {!gates.approve.allowed ? <p className="max-w-52 text-xs leading-5 text-[var(--fg-muted)]">{gates.approve.reason}</p> : null}
        </div>
      </div>
    </div>
  </aside>;
}
