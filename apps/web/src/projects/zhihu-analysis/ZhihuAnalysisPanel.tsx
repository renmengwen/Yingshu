import { useRef, useState } from "react";

import { Alert, AlertDescription, AlertTitle } from "../../components/ui/alert";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { Checkbox } from "../../components/ui/checkbox";
import {
  Field,
  FieldDescription,
  FieldLabel,
  FieldLegend,
  FieldSet,
} from "../../components/ui/field";
import { Input } from "../../components/ui/input";
import { Progress } from "../../components/ui/progress";
import { RadioGroup, RadioGroupItem } from "../../components/ui/radio-group";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "../../components/ui/table";
import { Textarea } from "../../components/ui/textarea";
import {
  BanIcon,
  EyeIcon,
  LoaderCircleIcon,
  PlayIcon,
  RefreshCwIcon,
} from "lucide-react";
import {
  evidenceRows,
  evidenceStatusLabel,
  usageRoleLabel,
  validateZhihuDraft,
  ZHIHU_STATUS_LABELS,
  zhihuStatusMessage,
} from "./logic";
import { ZhihuAnalysisDetails } from "./ZhihuAnalysisDetails";
import type {
  ZhihuAnalysisConfig,
  ZhihuDetailKind,
  ZhihuUsageRole,
} from "./types";
import type { useZhihuAnalysis } from "./use-zhihu-analysis";

const USAGE_OPTIONS: Array<{ value: ZhihuUsageRole; description: string }> = [
  {
    value: "method_only",
    description:
      "只提取抽象表达、结构与论证方法，不传递原句、人物、事件、数字或评论原文。",
  },
  {
    value: "topic_seed",
    description:
      "只沿用问题、核心议题和受众争议点；事实由映述重新联网研究并冻结来源。",
  },
  {
    value: "content_source",
    description:
      "允许冻结回答原文作为内容证据；需要确认你有权处理内容，评论仍只作受众信号。",
  },
];

export function ZhihuAnalysisPanel({
  projectId,
  videoId,
  state,
}: {
  projectId: string;
  videoId: string;
  state: ReturnType<typeof useZhihuAnalysis>;
}) {
  const [detailKind, setDetailKind] = useState<ZhihuDetailKind | null>(null);
  const detailTriggerRef = useRef<HTMLButtonElement | null>(null);
  const update = <K extends keyof ZhihuAnalysisConfig>(
    key: K,
    value: ZhihuAnalysisConfig[K],
  ) => state.setDraft((current) => ({ ...current, [key]: value }));
  const snapshot = state.summary?.snapshot;
  const rows = evidenceRows(
    snapshot?.evidence ?? null,
    snapshot?.config ?? state.draft,
  );
  const validationError = validateZhihuDraft(state.draft);
  const serverAllowsStart = state.summary?.allowedActions.start ?? false;
  const startBlockReason = !state.loaded
    ? "正在恢复知乎分析状态，请稍候。"
    : (validationError ??
      (!serverAllowsStart
        ? (state.summary?.blockReasons[0] ?? "服务端暂不允许开始新的分析任务。")
        : null));
  const active = Boolean(
    state.summary?.job &&
    ["queued", "running"].includes(state.summary.job.status),
  );
  const openDetails = (
    event: React.MouseEvent<HTMLButtonElement>,
    kind: ZhihuDetailKind,
  ) => {
    detailTriggerRef.current = event.currentTarget;
    setDetailKind(kind);
  };

  return (
    <section className="min-w-0" aria-labelledby="zhihu-analysis-heading">
      <div className="flex min-w-0 flex-col gap-6">
        <div className="flex min-w-0 flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
          <div className="min-w-0">
            <p className="font-mono text-[11px] font-semibold tracking-[.14em] text-[var(--accent)]">
              可冻结来源
            </p>
            <h3
              id="zhihu-analysis-heading"
              className="mt-2 text-base font-semibold"
            >
              知乎回答分析
            </h3>
            <p className="mt-2 max-w-3xl text-sm leading-6 text-[var(--fg-secondary)]">
              绑定一条公开知乎回答，冻结回答原文及评论样本。回答原文是可追溯来源，但不自动等于客观事实；评论固定只作受众解读。
            </p>
          </div>
          <div className="flex shrink-0 flex-wrap gap-2">
            {active && state.summary?.allowedActions.cancel ? (
              <Button
                type="button"
                variant="outline"
                disabled={state.busy}
                onClick={() => {
                  void state.cancel();
                }}
              >
                <BanIcon aria-hidden="true" />
                {state.busy ? "正在中断…" : "中断分析"}
              </Button>
            ) : (
              <Button
                type="button"
                disabled={state.busy || Boolean(startBlockReason)}
                onClick={() => {
                  void state.start();
                }}
              >
                {state.busy ? (
                  <LoaderCircleIcon
                    className="animate-spin"
                    aria-hidden="true"
                  />
                ) : snapshot &&
                  ["partial", "failed", "cancelled"].includes(
                    snapshot.status,
                  ) ? (
                  <RefreshCwIcon aria-hidden="true" />
                ) : (
                  <PlayIcon aria-hidden="true" />
                )}
                {state.busy ? "正在提交…" : snapshot ? "重新分析" : "开始分析"}
              </Button>
            )}
          </div>
        </div>
        {startBlockReason && !active ? (
          <p className="text-sm text-[var(--fg-secondary)]">
            {startBlockReason}
          </p>
        ) : null}
        <p
          className={`text-sm ${state.error ? "font-medium text-[var(--danger)]" : "text-[var(--fg-secondary)]"}`}
          role={state.error ? "alert" : "status"}
          aria-live={state.error ? undefined : "polite"}
        >
          {state.status}
        </p>

        <div className="grid min-w-0 gap-5 lg:grid-cols-[minmax(0,1fr)_18rem]">
          <Field>
            <FieldLabel htmlFor="zhihu-source-url">知乎回答链接</FieldLabel>
            <FieldDescription id="zhihu-source-help">
              首版支持 zhihu.com/question/.../answer/...
              格式；每个映述视频最多绑定 1 条知乎回答。
            </FieldDescription>
            <Input
              id="zhihu-source-url"
              type="url"
              inputMode="url"
              autoComplete="url"
              placeholder="https://www.zhihu.com/question/.../answer/..."
              disabled={state.busy || active}
              aria-describedby="zhihu-source-help"
              value={state.draft.sourceUrl}
              onChange={(event) => update("sourceUrl", event.target.value)}
            />
          </Field>
          <FieldSet
            disabled={state.busy || active}
            className="grid content-start gap-2"
          >
            <FieldLegend variant="label">评论证据</FieldLegend>
            <FieldLabel className="flex min-h-11 items-center gap-2 font-normal">
              <Checkbox
                checked={state.draft.analyzeComments}
                onCheckedChange={(checked) =>
                  update("analyzeComments", checked === true)
                }
              />
              <span>分析评论与回复</span>
            </FieldLabel>
            <Field>
              <FieldLabel htmlFor="zhihu-max-comments">评论上限</FieldLabel>
              <Input
                id="zhihu-max-comments"
                className="max-w-28"
                type="number"
                min={0}
                max={50}
                step={1}
                disabled={!state.draft.analyzeComments || state.busy || active}
                value={state.draft.maxComments}
                onChange={(event) =>
                  update("maxComments", Number(event.target.value))
                }
              />
              <FieldDescription>
                首版默认 50 条；评论仅作受众解读，不作为原文事实。
              </FieldDescription>
            </Field>
          </FieldSet>
        </div>

        {snapshot ? (
          <div className="min-w-0">
            <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
              <div className="flex items-center gap-2">
                <h4 className="text-sm font-semibold">分析结果摘要</h4>
                <Badge variant="outline">
                  {ZHIHU_STATUS_LABELS[snapshot.status]}
                </Badge>
              </div>
              <span className="break-all font-mono text-xs text-[var(--fg-tertiary)]">
                {snapshot.id}
              </span>
            </div>
            <p className="mb-3 text-sm text-[var(--fg-secondary)]">
              {zhihuStatusMessage(snapshot.status)}
            </p>
            {snapshot.status === "failed" &&
            state.summary?.job?.errorMessage ? (
              <p className="mb-3 text-sm text-[var(--danger)]" role="alert">
                分析失败：{state.summary.job.errorMessage}
                。已完成证据仍然保留，可修正后重试。
              </p>
            ) : null}
            {state.summary?.job && active ? (
              <div className="mb-4">
                <Progress
                  value={state.summary.job.progress}
                  aria-label={`分析进度 ${state.summary.job.progress}%`}
                />
              </div>
            ) : null}
            <div className="hidden md:block">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>分析项</TableHead>
                    <TableHead>证据</TableHead>
                    <TableHead>状态</TableHead>
                    <TableHead>摘要</TableHead>
                    <TableHead className="text-right">操作</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rows.map((row) => (
                    <TableRow key={row.id}>
                      <TableCell className="font-medium">{row.name}</TableCell>
                      <TableCell>{row.evidence}</TableCell>
                      <TableCell>
                        <Badge variant="outline">
                          {evidenceStatusLabel(row.status)}
                        </Badge>
                      </TableCell>
                      <TableCell className="max-w-md whitespace-normal text-[var(--fg-secondary)]">
                        {row.summary}
                      </TableCell>
                      <TableCell className="text-right">
                        <Button
                          type="button"
                          variant="outline"
                          onClick={(event) => openDetails(event, row.detail)}
                        >
                          <EyeIcon aria-hidden="true" />
                          查看详情
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
            <div className="grid min-w-0 gap-3 md:hidden">
              {rows.map((row) => (
                <article
                  key={row.id}
                  className="min-w-0 border-b border-[var(--border-subtle)] py-3"
                >
                  <div className="flex min-w-0 items-start justify-between gap-3">
                    <div className="min-w-0">
                      <h5 className="text-sm font-semibold">{row.name}</h5>
                      <Badge className="mt-2" variant="outline">
                        {evidenceStatusLabel(row.status)}
                      </Badge>
                      <p className="mt-2 break-words text-sm leading-6 text-[var(--fg-secondary)]">
                        {row.summary}
                      </p>
                    </div>
                    <Button
                      className="shrink-0"
                      type="button"
                      variant="outline"
                      onClick={(event) => openDetails(event, row.detail)}
                    >
                      <EyeIcon aria-hidden="true" />
                      查看
                    </Button>
                  </div>
                </article>
              ))}
            </div>
          </div>
        ) : null}

        {snapshot && state.summary?.allowedActions.selectUsage ? (
          <section
            className="grid min-w-0 gap-5 border-t border-[var(--border-subtle)] pt-6"
            aria-labelledby="zhihu-usage-heading"
          >
            <div>
              <h4 id="zhihu-usage-heading" className="text-sm font-semibold">
                选择使用方式
              </h4>
              <p className="mt-2 text-sm leading-6 text-[var(--fg-secondary)]">
                修改后会自动保存，并使现有文案、画面方案和下游失效。评论无论哪种方式都固定仅作受众解读。
              </p>
            </div>
            <RadioGroup
              value={state.usageRole ?? ""}
              onValueChange={(value) =>
                state.setUsageRole(value as ZhihuUsageRole)
              }
              className="grid min-w-0 gap-3 lg:grid-cols-3"
            >
              {USAGE_OPTIONS.map((option) => (
                <FieldLabel
                  key={option.value}
                  className="flex min-w-0 items-start gap-3 border-b border-[var(--border-subtle)] py-3 lg:border-b-0 lg:bg-[var(--surface-secondary)] lg:p-4"
                >
                  <RadioGroupItem value={option.value} />
                  <span className="min-w-0">
                    <strong className="block text-sm">
                      {usageRoleLabel(option.value)}
                    </strong>
                    <span className="mt-1 block text-sm font-normal leading-6 text-[var(--fg-secondary)]">
                      {option.description}
                    </span>
                  </span>
                </FieldLabel>
              ))}
            </RadioGroup>
            <Field>
              <FieldLabel htmlFor="zhihu-creative-angle">
                补充创作角度（可选）
              </FieldLabel>
              <FieldDescription>
                只说明如何使用该来源，不作为事实来源；最多 2,000 字。
              </FieldDescription>
              <Textarea
                id="zhihu-creative-angle"
                className="min-h-24"
                maxLength={2000}
                value={state.creativeAngle}
                onChange={(event) => state.setCreativeAngle(event.target.value)}
              />
            </Field>
            {state.usageRole === "content_source" ? (
              <Alert>
                <AlertTitle>内容使用权利确认</AlertTitle>
                <AlertDescription>
                  <FieldLabel className="flex min-h-11 items-start gap-2 font-normal">
                    <Checkbox
                      checked={state.rightsConfirmed}
                      onCheckedChange={(checked) =>
                        state.setRightsConfirmed(checked === true)
                      }
                    />
                    <span>
                      我确认该回答为自有、已授权、公版或其他有权处理的内容，并理解改写不代表自动获得发布权。
                    </span>
                  </FieldLabel>
                </AlertDescription>
              </Alert>
            ) : null}
            {snapshot.status === "partial" ? (
              <FieldLabel className="flex min-h-11 items-start gap-2 font-normal">
                <Checkbox
                  checked={state.acceptPartial}
                  onCheckedChange={(checked) =>
                    state.setAcceptPartial(checked === true)
                  }
                />
                <span>
                  使用部分结果继续；我已查看缺失维度，并接受服务端按当前使用方式再次校验。
                </span>
              </FieldLabel>
            ) : null}
            {state.selectionDirty ? (
              <p className="text-sm text-[var(--warning)]">
                {snapshot.status === "partial" && !state.acceptPartial
                  ? "请先确认接受部分分析结果。"
                  : state.usageRole === "content_source" &&
                      !state.rightsConfirmed
                    ? "请先确认内容使用权利。"
                    : "使用方式将在停止修改后自动保存。"}
              </p>
            ) : null}
          </section>
        ) : snapshot && state.summary?.blockReasons.length ? (
          <Alert>
            <AlertTitle>当前分析仍有阻断项</AlertTitle>
            <AlertDescription>
              {state.summary.blockReasons.join("；")}
              。服务端门禁满足后，使用方式将自动保存。
            </AlertDescription>
          </Alert>
        ) : null}
      </div>
      {snapshot ? (
        <ZhihuAnalysisDetails
          projectId={projectId}
          videoId={videoId}
          snapshotId={snapshot.id}
          kind={detailKind}
          onClose={() => setDetailKind(null)}
          returnFocusRef={detailTriggerRef}
        />
      ) : null}
    </section>
  );
}
