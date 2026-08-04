import { useCallback, useEffect, useState } from "react";

import { Button } from "../components/ui/button";
import { Textarea } from "../components/ui/textarea";
import { formatProductionTime } from "./video-final-production-logic";
import { useVideoVisualTimeline } from "./use-video-final-production";
import { VideoVisualTimelineList } from "./VideoVisualTimelineList";

export function VideoVisualTimelineStage({ projectId, videoId }: { projectId: string; videoId: string }) {
  const state = useVideoVisualTimeline(projectId, videoId);
  const [confirmed, setConfirmed] = useState(false);
  const [notes, setNotes] = useState("");
  const [segmentDirty, setSegmentDirty] = useState(false);
  const onSegmentDirtyChange = useCallback((dirty: boolean) => setSegmentDirty(dirty), []);
  const workspace = state.workspace;
  useEffect(() => { setConfirmed(false); }, [workspace?.timeline?.hash]);
  if (!state.loaded) return <section className="p-6 text-sm text-[var(--fg-secondary)]" aria-live="polite">正在恢复画面时间轴与整片审核状态…</section>;
  if (!workspace) return <section className="p-6" role="alert"><h2 className="text-lg font-semibold">无法恢复画面时间轴</h2><p className="mt-2 text-sm leading-6 text-[var(--fg-secondary)]">{state.message}</p><Button className="mt-5" variant="outline" type="button" disabled={state.state === "loading"} onClick={() => void state.refresh()}>{state.state === "loading" ? "正在重新加载…" : "重新加载"}</Button></section>;

  const busy = state.busyAction !== null;
  const timeline = workspace.timeline;
  // 服务端始终事务重验完整门禁；旧响应未带摘要时仍允许提交并展示准确阻断原因。
  const canCreate = workspace.gates.length === 0 || workspace.gates.every((gate) => gate.valid);
  const canReview = Boolean(timeline && !timeline.stale && workspace.issues.length === 0 && workspace.segments.length > 0 && !segmentDirty);
  const reviewComplete = workspace.review?.complete === true;
  const reviewDisabledReason = reviewComplete ? null : segmentDirty ? "当前段落详情还有未保存修改。" : timeline?.stale ? "当前时间轴修订已失效，请按上游身份重建。" : workspace.issues.length ? `仍有 ${workspace.issues.length} 项连续覆盖或绑定问题。` : !workspace.segments.length ? "当前时间轴没有可审核视觉段。" : !confirmed ? "请先确认已按顺序查看全部画面。" : null;

  return <section className={`min-w-0 ${timeline ? "pb-[30rem] sm:pb-[25rem] lg:pb-56" : ""}`} aria-labelledby="visual-timeline-heading">
    <header className="border-b border-[var(--border-subtle)] bg-[var(--bg-subtle)] px-5 py-5 md:px-7">
      <div className="flex flex-col gap-5 lg:flex-row lg:items-start lg:justify-between">
        <div className="min-w-0"><p className="font-mono text-[11px] font-semibold tracking-[.14em] text-[var(--accent)]">阶段 05</p><h2 id="visual-timeline-heading" className="mt-2 text-xl font-semibold">视觉时间轴</h2><p className="mt-2 max-w-3xl text-sm leading-6 text-[var(--fg-secondary)]">按真实音频和 canonical cues 连续绑定当前批准图片。段落详情只调整简单运镜和淡入淡出，不提供拖拽、多轨或逐帧编辑。</p></div>
        <div className="flex flex-wrap gap-2">{timeline ? <Button variant="outline" type="button" disabled={busy || !canCreate || segmentDirty} onClick={() => void state.createTimeline(true)}>{state.busyAction === "timeline" ? "正在重建…" : "重建时间轴"}</Button> : <Button type="button" disabled={busy || !canCreate} onClick={() => void state.createTimeline()}>{state.busyAction === "timeline" ? "正在创建…" : "创建正式时间轴"}</Button>}</div>
      </div>
      <div className="mt-5 grid gap-3 border-t border-[var(--border-subtle)] pt-4 sm:grid-cols-2 xl:grid-cols-4" aria-label="时间轴启动门禁">{workspace.gates.map((gate) => <p key={gate.key} className="text-sm"><span className="text-[var(--fg-secondary)]">{gate.label}：</span><strong>{gate.valid ? "已通过" : "未通过"}</strong>{gate.message ? <span className="mt-1 block text-xs text-[var(--fg-secondary)]">{gate.message}</span> : null}</p>)}{!workspace.gates.length ? <p className="text-sm text-[var(--fg-secondary)]">服务端尚未返回门禁摘要。</p> : null}</div>
      <div className="mt-4 min-h-11 border border-[var(--border-subtle)] bg-[var(--bg-surface)] px-4 py-3 text-sm leading-6" aria-live="polite" role={state.state === "error" ? "alert" : "status"}><strong>{state.state === "loading" ? "正在进行：" : state.state === "success" ? "成功：" : state.state === "error" ? "失败：" : state.state === "interrupted" ? "已中断：" : "就绪："}</strong>{state.message}</div>
    </header>

    {!timeline ? <div className="p-6"><p className="text-sm leading-7 text-[var(--fg-secondary)]">{canCreate ? "上游门禁已通过。创建是确定性本地操作，不会调用模型或产生模型费用。" : "请先完成并批准旁白方案、图片和音频。门禁未通过时服务端也会拒绝创建。"}</p>{workspace.issues.length ? <IssueList items={workspace.issues} /> : null}</div> : <>
      <div className="border-b border-[var(--border-subtle)] px-5 py-4 md:px-7"><div className="flex flex-wrap gap-x-6 gap-y-2 text-sm"><p><span className="text-[var(--fg-secondary)]">修订：</span><strong className="font-mono">r{timeline.revision}</strong></p><p><span className="text-[var(--fg-secondary)]">真实时长：</span><strong className="font-mono">{formatProductionTime(timeline.durationMs)}</strong></p><p><span className="text-[var(--fg-secondary)]">视觉段：</span><strong>{workspace.segments.length}</strong></p><p><span className="text-[var(--fg-secondary)]">状态：</span><strong>{timeline.stale ? "已失效" : workspace.issues.length ? "需修正" : "连续有效"}</strong></p></div><p className="mt-2 truncate font-mono text-[11px] text-[var(--fg-secondary)]" title={timeline.hash}>timeline {timeline.hash}</p></div>
      {workspace.issues.length ? <div className="px-5 md:px-7"><IssueList items={workspace.issues} /></div> : null}
      <VideoVisualTimelineList segments={workspace.segments} timelineHash={timeline.hash} stale={timeline.stale} issues={workspace.issues} busyAction={state.busyAction} onDirtyChange={onSegmentDirtyChange} onSave={(segmentId, patch) => state.updateSegment(segmentId, patch)} />
      <section className="border-t border-[var(--border-subtle)] px-5 py-5 md:px-7" aria-labelledby="visual-preview-heading"><div><h3 id="visual-preview-heading" className="font-semibold">整片顺序预览</h3><p className="mt-1 text-sm text-[var(--fg-secondary)]">横向按时间顺序展示当前批准图；批准视觉修订不会自动启动最终渲染。</p></div><ol className="mt-4 flex max-w-full gap-3 overflow-x-auto pb-3" aria-label="整片画面顺序">{workspace.segments.map((segment) => <li key={segment.id} className="w-28 shrink-0"><img src={segment.previewUrl} alt={`视觉段 ${segment.segmentIndex + 1}：${segment.narrationSummary || segment.visualId}`} className="aspect-[9/16] w-full bg-[var(--bg-inset)] object-cover" /><p className="mt-2 text-xs"><strong>段 {segment.segmentIndex + 1}</strong><span className="mt-1 block font-mono text-[10px] text-[var(--fg-secondary)]">{formatProductionTime(segment.startMs)}–{formatProductionTime(segment.endMs)}</span></p></li>)}</ol></section>
      <aside className="fixed inset-x-0 bottom-0 z-40 mx-auto w-full max-w-[1440px] border border-[var(--border-strong)] bg-[var(--surface-raised)] p-3 shadow-[var(--shadow-popover)] sm:bottom-3 sm:w-[calc(100%-2rem)] sm:rounded-lg sm:p-4" aria-label="视觉时间轴审核操作">
        <div className="grid min-w-0 gap-3 lg:grid-cols-[minmax(0,1fr)_minmax(18rem,28rem)_auto] lg:items-end"><div className="min-w-0"><p className="font-semibold">当前修订 r{timeline.revision} · {reviewComplete ? "已批准" : workspace.review?.hasStaleReview ? "旧审核已失效" : "等待人工审核"}</p><p className={`mt-1 text-xs leading-5 ${reviewDisabledReason ? "text-[var(--status-warning)]" : "text-[var(--fg-secondary)]"}`}>{reviewComplete ? "当前修订已完成人工审核，无需再次确认。" : segmentDirty ? "1 个段落设置未保存；请先在详情中保存或放弃修改。" : reviewDisabledReason ?? "连续覆盖、cue 与当前批准图片绑定均可提交人工审核。"}</p><p className="mt-1 text-xs text-[var(--fg-secondary)]">段落设置在单段详情中保存；保存与整片批准始终分离。</p><label className="mt-2 flex min-h-11 items-start gap-3 text-sm leading-6"><input className="mt-0.5 h-5 w-5 shrink-0 accent-[var(--accent)]" type="checkbox" checked={reviewComplete || confirmed} disabled={reviewComplete || busy || !canReview} onChange={(event) => setConfirmed(event.target.checked)} /><span>我已按顺序查看全部画面，并核对连续覆盖、开头节奏和字幕安全区。</span></label></div><label className="grid gap-1 text-sm font-semibold">审核备注（返修时必填）<Textarea className="min-h-20 max-h-28 font-normal" maxLength={2000} value={notes} disabled={busy} onChange={(event) => setNotes(event.target.value)} placeholder="记录节奏、运镜或画面顺序。" /></label><div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-1"><Button variant="outline" type="button" disabled={busy || !canReview || !notes.trim()} onClick={() => void state.reviewTimeline("needs_changes", notes)}>{state.busyAction === "review" ? "正在记录…" : "记录返修意见"}</Button><Button type="button" disabled={busy || !canReview || !confirmed || reviewComplete} onClick={() => void state.reviewTimeline("approve", notes)}>{state.busyAction === "review" ? "正在提交审核…" : reviewComplete ? "当前修订已批准" : "批准当前整片视觉"}</Button></div></div>
      </aside>
    </>}
  </section>;
}

function IssueList({ items }: { items: string[] }) {
  return <ul className="mt-4 grid gap-2" aria-label="时间轴校验问题">{items.map((item) => <li key={item} className="border border-[var(--danger)] px-3 py-2 text-sm text-[var(--danger)]"><strong>阻断：</strong>{item}</li>)}</ul>;
}
