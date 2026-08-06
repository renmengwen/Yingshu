import { Badge } from "../../components/ui/badge";
import type { DouyinDetailKind, DouyinSnapshotSummary } from "./types";

type Item = Record<string, unknown>;

const item = (value: unknown): Item => value && typeof value === "object" && !Array.isArray(value) ? value as Item : {};
const items = (value: unknown): Item[] => Array.isArray(value) ? value.map(item) : [];
const text = (value: unknown, fallback = "—") => typeof value === "string" && value.trim() ? value : fallback;
const number = (value: unknown) => typeof value === "number" && Number.isFinite(value) ? value : null;
const duration = (value: unknown) => {
  const milliseconds = number(value);
  if (milliseconds === null) return "—";
  const seconds = Math.max(0, Math.floor(milliseconds / 1000));
  return `${Math.floor(seconds / 60).toString().padStart(2, "0")}:${(seconds % 60).toString().padStart(2, "0")}`;
};
const dateTime = (value: unknown) => {
  const milliseconds = number(value);
  return milliseconds === null ? "—" : new Intl.DateTimeFormat("zh-CN", { dateStyle: "medium", timeStyle: "short" }).format(milliseconds);
};
const STATUS: Record<string, string> = {
  available: "可用", partial: "部分可用", unavailable: "不可用", succeeded: "已完成", failed: "失败",
  pending: "待执行", not_requested: "未开启", complete: "完整", running: "执行中", cancelled: "已中断",
  queued: "等待执行", need_login: "需要登录", need_verify: "需要验证", empty: "无数据",
  content: "内容", narrative: "叙事", pacing: "节奏", visualOverall: "整体画面", visualOpening: "开场画面",
  audioSubtitle: "音频与字幕", audience: "受众信号", narrationVisualAlignment: "旁白与画面对齐",
  observation: "观察", inference: "推断", unknown: "未知", high: "高", medium: "中", low: "低",
};
const label = (value: unknown) => STATUS[String(value)] ?? text(value);

function Fields({ values }: { values: Array<{ label: string; value: React.ReactNode; mono?: boolean }> }) {
  return <dl className="grid gap-x-6 gap-y-4 sm:grid-cols-2">{values.map((field) => <div key={field.label} className="min-w-0"><dt className="text-xs font-medium text-[var(--fg-tertiary)]">{field.label}</dt><dd className={`mt-1 break-words text-sm ${field.mono ? "font-mono" : ""}`}>{field.value}</dd></div>)}</dl>;
}

function MetadataDetails({ snapshot }: { snapshot: DouyinSnapshotSummary }) {
  return <div className="grid gap-6">
    <Fields values={[
      { label: "来源链接", value: snapshot.sourceUrl }, { label: "分析状态", value: label(snapshot.status) },
      { label: "创建时间", value: dateTime(snapshot.createdAt) }, { label: "完成时间", value: dateTime(snapshot.completedAt) },
      { label: "证据完整性", value: label(snapshot.completeness) }, { label: "计划关键帧", value: `${snapshot.config.frameCount} 张` },
      { label: "证据 Hash", value: snapshot.evidenceHash ?? "尚未生成", mono: true }, { label: "报告 Hash", value: snapshot.reportHash ?? "尚未生成", mono: true },
    ]} />
    <p className="text-sm leading-6 text-[var(--fg-secondary)]">本次配置：{snapshot.config.extractFrames ? "抽取关键帧" : "不抽帧"}、{snapshot.config.transcribeAudio ? "执行 ASR" : "不执行 ASR"}、{snapshot.config.analyzeComments ? "分析评论" : "不分析评论"}。</p>
  </div>;
}

function TranscriptDetails({ value }: { value: unknown }) {
  const transcript = item(value); const segments = items(transcript.segments); const missing = items(transcript.missingRanges);
  return <div className="grid gap-6">
    <Fields values={[{ label: "转写状态", value: label(transcript.status) }, { label: "分段数量", value: `${segments.length} 段` }, { label: "缺失区间", value: `${missing.length} 段` }, { label: "文本 Hash", value: text(transcript.textHash), mono: true }]} />
    <section aria-labelledby="douyin-transcript-segments"><h3 id="douyin-transcript-segments" className="text-sm font-semibold">分段转写</h3><div className="mt-3 divide-y divide-[var(--border-subtle)] border-y border-[var(--border-subtle)]">{segments.length ? segments.map((segment, index) => <article key={text(segment.id, String(index))} className="py-4"><div className="flex flex-wrap items-center justify-between gap-2"><span className="font-mono text-xs text-[var(--fg-secondary)]">{duration(segment.startMs)}–{duration(segment.endMs)}</span><Badge variant="outline">{label(segment.status)}</Badge></div><p className="mt-2 whitespace-pre-wrap break-words text-sm leading-7">{text(segment.text, "该分段没有可用转写。")}</p></article>) : <p className="py-4 text-sm text-[var(--fg-secondary)]">没有可展示的转写分段。</p>}</div></section>
  </div>;
}

function FramesDetails({ value }: { value: unknown }) {
  const frames = items(value);
  return <section aria-labelledby="douyin-frame-list"><div className="flex items-center justify-between gap-3"><h3 id="douyin-frame-list" className="text-sm font-semibold">关键帧时间点</h3><span className="text-sm text-[var(--fg-secondary)]">共 {frames.length} 张</span></div><div className="mt-3 divide-y divide-[var(--border-subtle)] border-y border-[var(--border-subtle)]">{frames.length ? frames.map((frame, index) => <div key={`${text(frame.artifactId, "frame")}-${index}`} className="grid gap-2 py-4 sm:grid-cols-[8rem_1fr_auto] sm:items-center"><span className="font-mono text-sm">关键帧 {String((number(frame.index) ?? index) + 1).padStart(2, "0")}</span><span className="text-sm text-[var(--fg-secondary)]">视频时间 {duration(frame.timestampMs)}</span><Badge variant="outline">{label(frame.status)}</Badge></div>) : <p className="py-4 text-sm text-[var(--fg-secondary)]">没有成功冻结的关键帧。</p>}</div></section>;
}

function CommentsDetails({ value }: { value: unknown }) {
  const comments = items(value);
  return <section aria-labelledby="douyin-comment-list"><div className="flex items-center justify-between gap-3"><h3 id="douyin-comment-list" className="text-sm font-semibold">评论样本</h3><span className="text-sm text-[var(--fg-secondary)]">本页 {comments.length} 条</span></div><p className="mt-2 text-sm text-[var(--fg-secondary)]">评论仅用于受众解读，不作为原视频事实。</p><div className="mt-3 divide-y divide-[var(--border-subtle)] border-y border-[var(--border-subtle)]">{comments.length ? comments.map((comment, index) => { const replies = items(comment.replies); return <article key={text(comment.id, String(index))} className="py-4"><div className="flex flex-wrap items-center justify-between gap-2"><span className="font-mono text-xs text-[var(--fg-secondary)]">匿名作者 {text(comment.authorId)}</span><span className="text-xs text-[var(--fg-secondary)]">{number(comment.likeCount)?.toLocaleString("zh-CN") ?? 0} 个赞</span></div><p className="mt-2 whitespace-pre-wrap break-words text-sm leading-7">{text(comment.text, "该评论没有可展示文本。")}</p>{replies.length ? <div className="mt-3 border-l-2 border-[var(--border-subtle)] pl-4">{replies.map((reply, replyIndex) => <p key={text(reply.id, String(replyIndex))} className="py-1 text-sm leading-6 text-[var(--fg-secondary)]">回复：{text(reply.text)}</p>)}</div> : null}</article>; }) : <p className="py-4 text-sm text-[var(--fg-secondary)]">本页没有评论样本。</p>}</div></section>;
}

function ReportDetails({ value }: { value: unknown }) {
  const report = item(value); const evidence = item(report.evidence); const availability = item(report.availability);
  const observations = items(report.observations); const risks = items(report.risks);
  return <div className="grid gap-6">
    <Fields values={[{ label: "报告完整性", value: label(evidence.completeness) }, { label: "ASR 字数", value: (number(evidence.asrTextCharacters) ?? 0).toLocaleString("zh-CN") }, { label: "成功关键帧", value: `${number(evidence.succeededFrames) ?? 0} 张` }, { label: "评论样本", value: `${number(evidence.commentCount) ?? 0} 条` }]} />
    <section aria-labelledby="douyin-availability"><h3 id="douyin-availability" className="text-sm font-semibold">分析维度可用性</h3><div className="mt-3 divide-y divide-[var(--border-subtle)] border-y border-[var(--border-subtle)]">{Object.entries(availability).map(([key, raw]) => { const current = item(raw); return <div key={key} className="grid gap-2 py-3 sm:grid-cols-[10rem_auto_1fr] sm:items-start"><span className="font-medium">{label(key)}</span><Badge variant="outline">{label(current.status)}</Badge><span className="text-sm leading-6 text-[var(--fg-secondary)]">{text(current.reason)}</span></div>; })}</div></section>
    <section aria-labelledby="douyin-observations"><h3 id="douyin-observations" className="text-sm font-semibold">综合观察</h3><div className="mt-3 divide-y divide-[var(--border-subtle)] border-y border-[var(--border-subtle)]">{observations.length ? observations.map((observation, index) => <article key={`${text(observation.dimension)}-${index}`} className="py-4"><div className="flex flex-wrap gap-2"><Badge variant="outline">{label(observation.dimension ?? "综合")}</Badge><Badge variant="outline">{label(observation.nature ?? "observation")}</Badge><span className="text-xs text-[var(--fg-secondary)]">置信度：{label(observation.confidence)}</span></div><p className="mt-2 text-sm leading-7">{text(observation.conclusion)}</p><p className="mt-2 break-words font-mono text-xs text-[var(--fg-secondary)]">证据：{Array.isArray(observation.evidenceRefs) ? observation.evidenceRefs.join("、") : "—"}</p></article>) : <p className="py-4 text-sm text-[var(--fg-secondary)]">报告没有综合观察。</p>}</div></section>
    {risks.length ? <section aria-labelledby="douyin-risks"><h3 id="douyin-risks" className="text-sm font-semibold">待核验风险</h3><div className="mt-3 divide-y divide-[var(--border-subtle)] border-y border-[var(--border-subtle)]">{risks.map((risk, index) => <article key={`${text(risk.code)}-${index}`} className="py-4"><p className="font-mono text-xs text-[var(--warning)]">{text(risk.code)}</p><p className="mt-2 text-sm leading-7">{text(risk.summary)}</p></article>)}</div></section> : null}
  </div>;
}

export function DouyinDetailContent({ kind, value, snapshot }: { kind: DouyinDetailKind; value: unknown; snapshot: DouyinSnapshotSummary }) {
  if (kind === "metadata") return <MetadataDetails snapshot={snapshot} />;
  if (kind === "transcript") return <TranscriptDetails value={value} />;
  if (kind === "frames") return <FramesDetails value={value} />;
  if (kind === "comments") return <CommentsDetails value={value} />;
  return <ReportDetails value={value} />;
}
