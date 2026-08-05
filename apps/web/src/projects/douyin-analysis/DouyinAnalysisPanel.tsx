import { useRef, useState } from "react";

import { Alert, AlertDescription, AlertTitle } from "../../components/ui/alert";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { Checkbox } from "../../components/ui/checkbox";
import { Field, FieldDescription, FieldLabel, FieldLegend, FieldSet } from "../../components/ui/field";
import { Input } from "../../components/ui/input";
import { Progress } from "../../components/ui/progress";
import { RadioGroup, RadioGroupItem } from "../../components/ui/radio-group";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../../components/ui/table";
import { Textarea } from "../../components/ui/textarea";
import { BanIcon, EyeIcon, LoaderCircleIcon, PlayIcon, RefreshCwIcon, SaveIcon } from "lucide-react";
import {
  DOUYIN_STATUS_LABELS, douyinStatusMessage, evidenceRows, evidenceStatusLabel, usageRoleLabel,
  validateDouyinDraft,
} from "./logic";
import { DouyinAnalysisDetails } from "./DouyinAnalysisDetails";
import type { DouyinAnalysisConfig, DouyinDetailKind, DouyinUsageRole } from "./types";
import { useDouyinAnalysis } from "./use-douyin-analysis";

const USAGE_OPTIONS: Array<{ value: DouyinUsageRole; description: string }> = [
  { value: "method_only", description: "只提取抽象叙事、节奏与视觉方法，不传递人物、事件、数字、引文、专有名词或评论原文。" },
  { value: "topic_seed", description: "只沿用主题、核心问题和受众角度；事实必须由映述重新联网研究并冻结来源。" },
  { value: "content_source", description: "允许冻结转写作为内容证据；需要确认你有权处理素材，评论仍只作受众信号。" },
];

export function DouyinAnalysisPanel({ projectId, videoId, inputDirty }: { projectId: string; videoId: string; inputDirty: boolean }) {
  const state = useDouyinAnalysis(projectId, videoId);
  const [detailKind, setDetailKind] = useState<DouyinDetailKind | null>(null);
  const detailTriggerRef = useRef<HTMLButtonElement | null>(null);
  const update = <K extends keyof DouyinAnalysisConfig>(key: K, value: DouyinAnalysisConfig[K]) => state.setDraft((current) => ({ ...current, [key]: value }));
  const snapshot = state.summary?.snapshot;
  const rows = evidenceRows(snapshot?.evidence ?? null, snapshot?.config ?? state.savedDraft);
  const validationError = validateDouyinDraft(state.savedDraft);
  const serverAllowsStart = state.summary?.allowedActions.start ?? false;
  const startBlockReason = inputDirty ? "请先保存上方创作输入草稿，再开始抖音分析。" : state.dirty ? "请先保存抖音分析配置草稿。" : validationError
    ?? (!serverAllowsStart ? state.summary?.blockReasons[0] ?? "服务端暂不允许开始新的分析任务。" : null);
  const active = Boolean(state.summary?.job && ["queued", "running"].includes(state.summary.job.status));
  const openDetails = (event: React.MouseEvent<HTMLButtonElement>, kind: DouyinDetailKind) => {
    detailTriggerRef.current = event.currentTarget;
    setDetailKind(kind);
  };

  return <section className="min-w-0 border-t border-[var(--border-subtle)] px-5 py-7 md:px-7" aria-labelledby="douyin-analysis-heading">
    <div className="flex min-w-0 flex-col gap-6">
      <div className="flex min-w-0 flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
        <div className="min-w-0"><p className="font-mono text-[11px] font-semibold tracking-[.14em] text-[var(--accent)]">可冻结来源</p><h3 id="douyin-analysis-heading" className="mt-2 text-base font-semibold">抖音视频分析</h3><p className="mt-2 max-w-3xl text-sm leading-6 text-[var(--fg-secondary)]">绑定一条你有权处理的公开抖音视频。分析不会覆盖主题、正文或参考资料，也不会把抽帧自动加入图片候选或成片。</p></div>
        <div className="flex shrink-0 flex-wrap gap-2">
          <Button type="button" variant="outline" disabled={state.busy || !state.dirty} onClick={state.saveDraft}><SaveIcon aria-hidden="true" />保存分析配置</Button>
          {active && state.summary?.allowedActions.cancel ? <Button type="button" variant="outline" disabled={state.busy} onClick={() => { void state.cancel(); }}><BanIcon aria-hidden="true" />{state.busy ? "正在中断…" : "中断分析"}</Button>
            : <Button type="button" disabled={state.busy || Boolean(startBlockReason)} onClick={() => { void state.start(); }}>{state.busy ? <LoaderCircleIcon className="animate-spin" aria-hidden="true" /> : snapshot && ["partial", "failed", "cancelled", "need_login", "need_verify"].includes(snapshot.status) ? <RefreshCwIcon aria-hidden="true" /> : <PlayIcon aria-hidden="true" />}{state.busy ? "正在提交…" : snapshot ? "重新分析" : "开始分析"}</Button>}
        </div>
      </div>

      {startBlockReason && !active ? <p className="text-sm text-[var(--fg-secondary)]">{startBlockReason}</p> : null}
      <p className={`text-sm ${state.error ? "font-medium text-[var(--danger)]" : "text-[var(--fg-secondary)]"}`} role={state.error ? "alert" : "status"} aria-live={state.error ? undefined : "polite"}>{state.dirty ? `分析配置有未保存修改。${state.status}` : state.status}</p>

      <div className="grid min-w-0 gap-5 lg:grid-cols-[minmax(0,1.4fr)_minmax(18rem,.6fr)]">
        <Field><FieldLabel htmlFor="douyin-source-text">抖音分享文案或链接</FieldLabel><FieldDescription id="douyin-source-help">支持分享文案、v.douyin.com 短链接和标准视频链接；首版每个映述视频最多绑定 1 条。</FieldDescription><Textarea id="douyin-source-text" className="min-h-28" placeholder="粘贴分享文案、短链接或完整视频链接" disabled={state.busy || active} aria-describedby="douyin-source-help" value={state.draft.sourceText} onChange={(event) => update("sourceText", event.target.value)} /></Field>
        <FieldSet disabled={state.busy || active} className="grid content-start gap-2"><FieldLegend variant="label">分析证据</FieldLegend>
          <FieldLabel className="flex min-h-11 items-center gap-2 font-normal"><Checkbox checked={state.draft.extractFrames} onCheckedChange={(checked) => update("extractFrames", checked === true)} /><span>抽取关键帧</span></FieldLabel>
          <Field className="pl-13"><FieldLabel htmlFor="douyin-frame-count">关键帧数量</FieldLabel><Input id="douyin-frame-count" className="max-w-28" type="number" min={6} max={30} step={1} disabled={!state.draft.extractFrames || state.busy || active} value={state.draft.frameCount} onChange={(event) => update("frameCount", Number(event.target.value))} /><FieldDescription>系统优先覆盖开头，再均匀覆盖剩余视频；支持 6～30 张。</FieldDescription></Field>
          <FieldLabel className="flex min-h-11 items-center gap-2 font-normal"><Checkbox checked={state.draft.transcribeAudio} onCheckedChange={(checked) => update("transcribeAudio", checked === true)} /><span>执行 ASR 音频转写</span></FieldLabel>
          <FieldLabel className="flex min-h-11 items-center gap-2 font-normal"><Checkbox checked={state.draft.analyzeComments} onCheckedChange={(checked) => update("analyzeComments", checked === true)} /><span>分析评论</span></FieldLabel>
          <FieldDescription>评论只用于提取观众问题、共鸣和争议，固定为受众解读信号，永远不作为内容事实。</FieldDescription>
        </FieldSet>
      </div>

      {snapshot ? <div className="min-w-0">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-3"><div className="flex items-center gap-2"><h4 className="text-sm font-semibold">分析结果摘要</h4><Badge variant="outline">{DOUYIN_STATUS_LABELS[snapshot.status]}</Badge></div><span className="break-all font-mono text-xs text-[var(--fg-tertiary)]">{snapshot.id}</span></div>
        <p className="mb-3 text-sm text-[var(--fg-secondary)]">{douyinStatusMessage(snapshot.status, snapshot.config)}</p>
        {snapshot.status === "failed" && state.summary?.job?.errorMessage ? <p className="mb-3 text-sm text-[var(--danger)]" role="alert">分析失败：{state.summary.job.errorMessage}。已完成证据仍然保留，可修正后重试。</p> : null}
        {state.summary?.job && active ? <div className="mb-4"><Progress value={state.summary.job.progress} aria-label={`分析进度 ${state.summary.job.progress}%`} /></div> : null}
        <div className="hidden md:block"><Table><TableHeader><TableRow><TableHead>分析项</TableHead><TableHead>证据</TableHead><TableHead>状态</TableHead><TableHead>摘要</TableHead><TableHead className="text-right">操作</TableHead></TableRow></TableHeader><TableBody>{rows.map((row) => <TableRow key={row.id}><TableCell className="font-medium">{row.name}</TableCell><TableCell>{row.evidence}</TableCell><TableCell><Badge variant="outline">{evidenceStatusLabel(row.status)}</Badge></TableCell><TableCell className="max-w-md whitespace-normal text-[var(--fg-secondary)]">{row.summary}</TableCell><TableCell className="text-right"><Button type="button" variant="outline" onClick={(event) => openDetails(event, row.detail)}><EyeIcon aria-hidden="true" />查看详情</Button></TableCell></TableRow>)}</TableBody></Table></div>
        <div className="grid min-w-0 gap-3 md:hidden">{rows.map((row) => <article key={row.id} className="min-w-0 border-b border-[var(--border-subtle)] py-3"><div className="flex min-w-0 items-start justify-between gap-3"><div className="min-w-0"><h5 className="text-sm font-semibold">{row.name}</h5><Badge className="mt-2" variant="outline">{evidenceStatusLabel(row.status)}</Badge><p className="mt-2 break-words text-sm leading-6 text-[var(--fg-secondary)]">{row.summary}</p></div><Button className="shrink-0" type="button" variant="outline" onClick={(event) => openDetails(event, row.detail)}><EyeIcon aria-hidden="true" />查看</Button></div></article>)}</div>
      </div> : null}

      {snapshot && state.summary?.allowedActions.selectUsage ? <section className="grid min-w-0 gap-5 border-t border-[var(--border-subtle)] pt-6" aria-labelledby="douyin-usage-heading">
        <div><h4 id="douyin-usage-heading" className="text-sm font-semibold">选择使用方式</h4><p className="mt-2 text-sm leading-6 text-[var(--fg-secondary)]">分析快照与使用方式分别保存。切换方式不会重跑下载、ASR 或抽帧，但会使现有文案、画面方案和下游失效。</p></div>
        <RadioGroup value={state.usageRole} onValueChange={(value) => state.setUsageRole(value as DouyinUsageRole)} className="grid min-w-0 gap-3 lg:grid-cols-3">{USAGE_OPTIONS.map((option) => <FieldLabel key={option.value} className="flex min-w-0 items-start gap-3 border-b border-[var(--border-subtle)] py-3 lg:border-b-0 lg:bg-[var(--surface-secondary)] lg:p-4"><RadioGroupItem value={option.value} /><span className="min-w-0"><strong className="block text-sm">{usageRoleLabel(option.value)}</strong><span className="mt-1 block text-sm font-normal leading-6 text-[var(--fg-secondary)]">{option.description}</span></span></FieldLabel>)}</RadioGroup>
        <Field><FieldLabel htmlFor="douyin-creative-angle">补充创作角度（可选）</FieldLabel><FieldDescription>只说明如何使用该来源，不作为事实来源；最多 2,000 字。</FieldDescription><Textarea id="douyin-creative-angle" className="min-h-24" maxLength={2000} value={state.creativeAngle} onChange={(event) => state.setCreativeAngle(event.target.value)} /></Field>
        {state.usageRole === "content_source" ? <Alert><AlertTitle>内容使用权利确认</AlertTitle><AlertDescription><FieldLabel className="flex min-h-11 items-start gap-2 font-normal"><Checkbox checked={state.rightsConfirmed} onCheckedChange={(checked) => state.setRightsConfirmed(checked === true)} /><span>我确认该素材为自有、已授权、公版或其他有权处理的内容，并理解改写不代表自动获得发布权。</span></FieldLabel></AlertDescription></Alert> : null}
        {snapshot.status === "partial" ? <FieldLabel className="flex min-h-11 items-start gap-2 font-normal"><Checkbox checked={state.acceptPartial} onCheckedChange={(checked) => state.setAcceptPartial(checked === true)} /><span>使用部分结果继续；我已查看缺失维度，并接受服务端按当前使用方式再次校验。</span></FieldLabel> : null}
        {state.selectionDirty ? <p className="text-sm text-[var(--warning)]">使用方式有未保存修改；保存后当前方案及下游可能失效。</p> : null}
        <div><Button type="button" disabled={state.busy || !state.selectionDirty || (snapshot.status === "partial" && !state.acceptPartial) || (state.usageRole === "content_source" && !state.rightsConfirmed)} onClick={() => { void state.saveSelection(); }}><SaveIcon aria-hidden="true" />{state.busy ? "正在保存使用方式…" : "保存使用方式"}</Button></div>
      </section> : snapshot && state.summary?.blockReasons.length ? <Alert><AlertTitle>当前分析仍有阻断项</AlertTitle><AlertDescription>{state.summary.blockReasons.join("；")}。服务端门禁满足后才可保存使用方式。</AlertDescription></Alert> : null}
    </div>
    {snapshot ? <DouyinAnalysisDetails projectId={projectId} videoId={videoId} snapshotId={snapshot.id} kind={detailKind} onClose={() => setDetailKind(null)} returnFocusRef={detailTriggerRef} /> : null}
  </section>;
}
