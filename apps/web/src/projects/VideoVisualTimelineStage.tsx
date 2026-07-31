import { useState } from "react";

import { buttonVariants } from "../components/ui/button";
import { formatProductionTime, motionLabel, type VideoMotionKind, type VideoVisualSegment } from "./video-final-production-logic";
import { useVideoVisualTimeline } from "./use-video-final-production";

const primaryButton = buttonVariants({ variant: "default" });
const secondaryButton = buttonVariants({ variant: "outline" });
const motions: VideoMotionKind[] = ["still", "zoom_in", "zoom_out", "pan_left", "pan_right"];

export function VideoVisualTimelineStage({ projectId, videoId }: { projectId: string; videoId: string }) {
  const state = useVideoVisualTimeline(projectId, videoId);
  const [confirmed, setConfirmed] = useState(false);
  const [notes, setNotes] = useState("");
  const workspace = state.workspace;
  if (!state.loaded) return <section className="p-6 text-sm text-[var(--fg-secondary)]" aria-live="polite">正在恢复画面时间轴与整片审核状态…</section>;
  if (!workspace) return <section className="p-6" role="alert"><h2 className="text-lg font-semibold">无法恢复画面时间轴</h2><p className="mt-2 text-sm leading-6 text-[var(--fg-secondary)]">{state.message}</p><button className={`${secondaryButton} mt-5`} type="button" disabled={state.state === "loading"} onClick={() => void state.refresh()}>{state.state === "loading" ? "正在重新加载…" : "重新加载"}</button></section>;

  const busy = state.busyAction !== null;
  const timeline = workspace.timeline;
  // 服务端始终事务重验完整门禁；旧响应未带摘要时仍允许提交并展示准确阻断原因。
  const canCreate = workspace.gates.length === 0 || workspace.gates.every((gate) => gate.valid);
  const canReview = Boolean(timeline && !timeline.stale && workspace.issues.length === 0 && workspace.segments.length > 0);
  return <section className="min-w-0" aria-labelledby="visual-timeline-heading">
    <header className="border-b border-[var(--border-subtle)] bg-[var(--bg-subtle)] px-5 py-5 md:px-7">
      <div className="flex flex-col gap-5 lg:flex-row lg:items-start lg:justify-between">
        <div className="min-w-0"><p className="font-mono text-[11px] font-semibold tracking-[.14em] text-[var(--accent)]">MVP 第五阶段</p><h2 id="visual-timeline-heading" className="mt-2 text-xl font-semibold">画面时间轴</h2><p className="mt-2 max-w-3xl text-sm leading-6 text-[var(--fg-secondary)]">按真实音频和 canonical cues 连续绑定当前批准图片。首版只调整简单运镜和淡入淡出，不提供拖拽、多轨或逐帧编辑。</p></div>
        <div className="flex flex-wrap gap-2">
          {timeline ? <button className={secondaryButton} type="button" disabled={busy || !canCreate} onClick={() => void state.createTimeline(true)}>{state.busyAction === "timeline" ? "正在重建…" : "重建时间轴"}</button> : null}
          {!timeline ? <button className={primaryButton} type="button" disabled={busy || !canCreate} onClick={() => void state.createTimeline()}>{state.busyAction === "timeline" ? "正在创建…" : "创建正式时间轴"}</button> : null}
        </div>
      </div>
      <div className="mt-5 grid gap-3 border-t border-[var(--border-subtle)] pt-4 sm:grid-cols-2 xl:grid-cols-4" aria-label="时间轴启动门禁">
        {workspace.gates.map((gate) => <p key={gate.key} className="text-sm"><span className="text-[var(--fg-secondary)]">{gate.label}：</span><strong>{gate.valid ? "已通过" : "未通过"}</strong>{gate.message ? <span className="mt-1 block text-xs text-[var(--fg-secondary)]">{gate.message}</span> : null}</p>)}
        {!workspace.gates.length ? <p className="text-sm text-[var(--fg-secondary)]">服务端尚未返回门禁摘要。</p> : null}
      </div>
      <div className="mt-4 min-h-11 border border-[var(--border-subtle)] bg-[var(--bg-surface)] px-4 py-3 text-sm leading-6" aria-live="polite" role={state.state === "error" ? "alert" : "status"}><strong>{state.state === "loading" ? "正在进行：" : state.state === "success" ? "成功：" : state.state === "error" ? "失败：" : state.state === "interrupted" ? "已中断：" : "就绪："}</strong>{state.message}</div>
    </header>

    {!timeline ? <div className="p-6"><p className="text-sm leading-7 text-[var(--fg-secondary)]">{canCreate ? "上游门禁已通过。创建是确定性本地操作，不会调用模型或产生模型费用。" : "请先完成并批准旁白方案、图片和音频。门禁未通过时服务端也会拒绝创建。"}</p>{workspace.issues.length ? <IssueList items={workspace.issues} /> : null}</div> : <>
      <div className="border-b border-[var(--border-subtle)] px-5 py-4 md:px-7"><div className="flex flex-wrap gap-x-6 gap-y-2 text-sm"><p><span className="text-[var(--fg-secondary)]">修订：</span><strong className="font-mono">r{timeline.revision}</strong></p><p><span className="text-[var(--fg-secondary)]">真实时长：</span><strong className="font-mono">{formatProductionTime(timeline.durationMs)}</strong></p><p><span className="text-[var(--fg-secondary)]">视觉段：</span><strong>{workspace.segments.length}</strong></p><p><span className="text-[var(--fg-secondary)]">状态：</span><strong>{timeline.stale ? "已失效" : workspace.issues.length ? "需修正" : "连续有效"}</strong></p></div><p className="mt-2 truncate font-mono text-[11px] text-[var(--fg-secondary)]" title={timeline.hash}>timeline {timeline.hash}</p></div>
      {workspace.issues.length ? <div className="px-5 md:px-7"><IssueList items={workspace.issues} /></div> : null}
      <div className="grid min-w-0 lg:grid-cols-[minmax(0,1.2fr)_minmax(280px,.8fr)]">
        <div className="min-w-0 border-b border-[var(--border-subtle)] lg:border-b-0 lg:border-r">
          <h3 className="border-b border-[var(--border-subtle)] px-5 py-4 text-sm font-semibold md:px-7">连续画面段</h3>
          <div>{workspace.segments.map((segment) => <SegmentEditor key={`${timeline.hash}:${segment.id}`} segment={segment} busy={busy} onSave={(patch) => state.updateSegment(segment.id, patch)} />)}</div>
        </div>
        <aside className="min-w-0 p-5 md:p-7" aria-labelledby="visual-review-heading">
          <h3 id="visual-review-heading" className="text-sm font-semibold">整片顺序预览</h3><p className="mt-2 text-xs leading-6 text-[var(--fg-secondary)]">逐段展示服务端受控真实图片、旁白顺序和运镜。批准当前修订不会自动渲染。</p>
          <ol className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-2">{workspace.segments.map((segment) => <li key={segment.id} className="min-w-0 overflow-hidden rounded border border-[var(--border-subtle)] bg-[var(--bg-subtle)]"><img src={segment.previewUrl} alt={`画面段 ${segment.segmentIndex + 1}：${segment.narrationSummary || segment.visualId}`} className="aspect-[9/16] w-full object-cover" /><p className="p-2 text-xs"><strong>段 {segment.segmentIndex + 1}</strong><span className="mt-1 block font-mono text-[10px] text-[var(--fg-secondary)]">{formatProductionTime(segment.startMs)}–{formatProductionTime(segment.endMs)}</span></p></li>)}</ol>
          <div className="mt-5 border-t border-[var(--border-subtle)] pt-5"><p className="text-sm"><span className="text-[var(--fg-secondary)]">审核：</span><strong>{workspace.review?.complete ? "当前修订已批准" : workspace.review?.hasStaleReview ? "旧审核已失效" : "等待人工审核"}</strong></p><label className="mt-4 flex min-h-11 items-start gap-3 border border-[var(--border-subtle)] p-3 text-sm leading-6"><input className="mt-0.5 h-5 w-5 shrink-0 accent-[var(--accent)]" type="checkbox" checked={confirmed} disabled={busy || !canReview} onChange={(event) => setConfirmed(event.target.checked)} /><span>我已按顺序查看全部画面，并核对连续覆盖、开头节奏和字幕安全区。</span></label><label className="mt-3 grid gap-2 text-sm font-semibold">审核备注（可选）<textarea className="min-h-24 rounded border border-[var(--border-subtle)] bg-[var(--bg-canvas)] p-3 font-normal focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus)]" maxLength={2000} value={notes} disabled={busy} onChange={(event) => setNotes(event.target.value)} placeholder="记录节奏、运镜或画面顺序。" /></label><button className={`${primaryButton} mt-3 w-full`} type="button" disabled={busy || !canReview || !confirmed || workspace.review?.complete === true} onClick={() => void state.reviewTimeline("approve", notes)}>{state.busyAction === "review" ? "正在提交审核…" : workspace.review?.complete ? "当前修订已批准" : "批准当前整片视觉"}</button><button className={`${secondaryButton} mt-2 w-full`} type="button" disabled={busy || !canReview || !notes.trim()} onClick={() => void state.reviewTimeline("needs_changes", notes)}>{state.busyAction === "review" ? "正在记录…" : "记录返修意见"}</button></div>
        </aside>
      </div>
    </>}
  </section>;
}

function SegmentEditor({ segment, busy, onSave }: { segment: VideoVisualSegment; busy: boolean; onSave: (patch: { motionKind: VideoMotionKind; motionAmountPpm: number; fadeInMs: number; fadeOutMs: number }) => Promise<void> }) {
  const [motionKind, setMotionKind] = useState(segment.motionKind);
  const [motionAmountPpm, setMotionAmountPpm] = useState(segment.motionAmountPpm);
  const [fadeInMs, setFadeInMs] = useState(segment.fadeInMs);
  const [fadeOutMs, setFadeOutMs] = useState(segment.fadeOutMs);
  const changed = motionKind !== segment.motionKind || motionAmountPpm !== segment.motionAmountPpm || fadeInMs !== segment.fadeInMs || fadeOutMs !== segment.fadeOutMs;
  return <article className="grid min-w-0 gap-4 border-b border-[var(--border-subtle)] p-5 last:border-b-0 md:grid-cols-[112px_minmax(0,1fr)] md:p-7">
    <img src={segment.previewUrl} alt={`画面段 ${segment.segmentIndex + 1} 当前批准图片`} className="aspect-[9/16] w-28 rounded border border-[var(--border-subtle)] object-cover" />
    <div className="min-w-0"><div className="flex flex-wrap items-center justify-between gap-2"><h4 className="font-semibold">段 {segment.segmentIndex + 1} · cue {segment.cueStartIndex + 1}–{segment.cueEndIndex + 1}</h4><span className="font-mono text-xs text-[var(--fg-secondary)]">{formatProductionTime(segment.startMs)}–{formatProductionTime(segment.endMs)}</span></div><p className="mt-2 text-sm leading-6 text-[var(--fg-secondary)]">{segment.narrationSummary || "当前段未返回旁白摘要。"}</p><p className="mt-1 truncate font-mono text-[10px] text-[var(--fg-secondary)]" title={segment.candidateHash}>图片 {segment.candidateHash}</p>
      <div className="mt-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-3"><label className="grid gap-1 text-xs font-semibold">运镜<select className="min-h-11 rounded border border-[var(--border-subtle)] bg-[var(--bg-canvas)] px-3 font-normal focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus)]" value={motionKind} disabled={busy} onChange={(event) => { const next = event.target.value as VideoMotionKind; setMotionKind(next); if (next === "still") setMotionAmountPpm(0); }}>{motions.map((motion) => <option key={motion} value={motion}>{motionLabel(motion)}</option>)}</select></label><NumberField label="运镜幅度 ppm" value={motionAmountPpm} disabled={busy || motionKind === "still"} max={200000} onChange={setMotionAmountPpm} /><NumberField label="淡入淡出 ms" value={fadeInMs} disabled={busy} max={3000} onChange={(value) => { setFadeInMs(value); setFadeOutMs(value); }} /></div>
      <button className={`${secondaryButton} mt-3`} type="button" disabled={busy || !changed} onClick={() => void onSave({ motionKind, motionAmountPpm, fadeInMs, fadeOutMs })}>保存本段设置</button>
    </div>
  </article>;
}

function NumberField({ label, value, disabled, max, onChange }: { label: string; value: number; disabled: boolean; max: number; onChange: (value: number) => void }) {
  return <label className="grid gap-1 text-xs font-semibold">{label}<input className="min-h-11 min-w-0 rounded border border-[var(--border-subtle)] bg-[var(--bg-canvas)] px-3 font-mono font-normal focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus)]" type="number" min={0} max={max} step={1000} value={value} disabled={disabled} onChange={(event) => onChange(Number(event.target.value))} /></label>;
}

function IssueList({ items }: { items: string[] }) {
  return <ul className="mt-4 grid gap-2" aria-label="时间轴校验问题">{items.map((item) => <li key={item} className="border border-[var(--danger)] px-3 py-2 text-sm text-[var(--danger)]"><strong>阻断：</strong>{item}</li>)}</ul>;
}
