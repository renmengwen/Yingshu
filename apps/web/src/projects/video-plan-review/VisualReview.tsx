import { useEffect, useId, useRef, useState } from "react";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "../../components/ui/alert-dialog";
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
import { Field, FieldError, FieldLabel } from "../../components/ui/field";
import { Input } from "../../components/ui/input";
import { NativeSelect, NativeSelectOption } from "../../components/ui/native-select";
import { Pagination } from "../../components/ui/pagination";
import {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "../../components/ui/table";
import { Textarea } from "../../components/ui/textarea";
import type { VideoScriptParagraph, VideoVisualDraft } from "../types";
import { visualDraftFieldErrors } from "../plan-logic";
import { adjacentVisualIdAfterDelete, DEFAULT_PAGE_SIZE, PAGE_SIZE_OPTIONS, paginate } from "./logic";

type VisualReviewProps = {
  visuals: VideoVisualDraft[];
  paragraphs: VideoScriptParagraph[];
  busy: boolean;
  incompatible: boolean;
  onApplyVisual: (visual: VideoVisualDraft) => void;
  onAddVisual: () => void;
  onDeleteVisual: (visualId: string) => void;
};

function summary(value: string) {
  const normalized = value.trim().replace(/\s+/g, " ");
  return normalized || "未填写";
}

export function VisualReview({ visuals, paragraphs, busy, incompatible, onApplyVisual, onAddVisual, onDeleteVisual }: VisualReviewProps) {
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(DEFAULT_PAGE_SIZE);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState<VideoVisualDraft | null>(null);
  const [closeBlocked, setCloseBlocked] = useState(false);
  const [fieldErrors, setFieldErrors] = useState({ description: null as string | null, prompt: null as string | null });
  const initialFocusRef = useRef<HTMLSelectElement>(null);
  const continueEditingRef = useRef<HTMLButtonElement>(null);
  const descriptionRef = useRef<HTMLTextAreaElement>(null);
  const promptRef = useRef<HTMLTextAreaElement>(null);
  const triggerRef = useRef<HTMLElement>(null);
  const addVisualRef = useRef<HTMLButtonElement>(null);
  const deleteFocusIdRef = useRef<string | null>(null);
  const deleteConfirmedRef = useRef(false);
  const descriptionErrorId = useId();
  const promptErrorId = useId();
  const paragraphId = useId();
  const purposeId = useId();
  const descriptionId = useId();
  const promptId = useId();
  const negativePromptId = useId();
  const view = paginate(visuals, page, pageSize);
  const savedVisual = editingId ? visuals.find((visual) => visual.id === editingId) ?? null : null;
  const dirty = Boolean(draft && savedVisual && JSON.stringify(draft) !== JSON.stringify(savedVisual));

  useEffect(() => {
    if (page !== view.page) setPage(view.page);
  }, [page, view.page]);

  useEffect(() => {
    if (closeBlocked) continueEditingRef.current?.focus();
  }, [closeBlocked]);

  function openEditor(visual: VideoVisualDraft, trigger: HTMLElement) {
    triggerRef.current = trigger;
    setDraft({ ...visual });
    setEditingId(visual.id);
    setCloseBlocked(false);
    setFieldErrors({ description: null, prompt: null });
  }

  function requestClose(open: boolean) {
    if (open) return;
    if (dirty) {
      setCloseBlocked(true);
      return;
    }
    setEditingId(null);
    setDraft(null);
    setCloseBlocked(false);
    setFieldErrors({ description: null, prompt: null });
  }

  function discardAndClose() {
    setEditingId(null);
    setDraft(null);
    setCloseBlocked(false);
    setFieldErrors({ description: null, prompt: null });
  }

  function applyDraft() {
    if (!draft) return;
    const errors = visualDraftFieldErrors(draft);
    setFieldErrors(errors);
    if (errors.description || errors.prompt) {
      queueMicrotask(() => (errors.description ? descriptionRef : promptRef).current?.focus());
      return;
    }
    onApplyVisual(draft);
    setEditingId(null);
    setDraft(null);
    setCloseBlocked(false);
    setFieldErrors({ description: null, prompt: null });
  }

  function focusAfterDelete(event: Event) {
    if (!deleteConfirmedRef.current) return;
    event.preventDefault();
    requestAnimationFrame(() => {
      const fallbackId = deleteFocusIdRef.current;
      const candidates = fallbackId
        ? document.querySelectorAll<HTMLElement>("[data-visual-focus-id]")
        : [];
      const target = Array.from(candidates).find((candidate) => {
        const style = getComputedStyle(candidate);
        return candidate.dataset.visualFocusId === fallbackId && candidate.getClientRects().length > 0 && style.display !== "none" && style.visibility !== "hidden";
      });
      (target ?? addVisualRef.current)?.focus();
      deleteFocusIdRef.current = null;
      deleteConfirmedRef.current = false;
    });
  }

  const paragraphLabel = (paragraphId: string) => {
    const index = paragraphs.findIndex((paragraph) => paragraph.id === paragraphId);
    return index < 0 ? `未知段落 · ${paragraphId}` : `旁白段落 ${String(index + 1).padStart(2, "0")}`;
  };

  const actions = (visual: VideoVisualDraft) => <div className="flex flex-wrap gap-2">
    <Button
      type="button"
      variant="outline"
      disabled={busy}
      data-visual-focus-id={visual.id}
      onClick={(event) => openEditor(visual, event.currentTarget)}
    >
      查看与编辑
    </Button>
    <AlertDialog>
      <AlertDialogTrigger asChild>
        <Button
          type="button"
          variant="outline"
          className="text-destructive"
          disabled={busy || visuals.length <= 1}
          title={visuals.length <= 1 ? "至少保留一个画面" : "删除当前画面草稿"}
        >
          删除
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent onCloseAutoFocus={focusAfterDelete}>
        <AlertDialogHeader>
          <AlertDialogTitle>删除画面 {String(visuals.indexOf(visual) + 1).padStart(2, "0")}</AlertDialogTitle>
          <AlertDialogDescription>该操作会从当前未保存草稿中移除画面“{summary(visual.purpose)}”。保存画面修订前不会写入服务端。</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>取消</AlertDialogCancel>
          <AlertDialogAction disabled={busy} onClick={() => {
            deleteFocusIdRef.current = adjacentVisualIdAfterDelete(visuals.map((item) => item.id), visual.id);
            deleteConfirmedRef.current = true;
            onDeleteVisual(visual.id);
          }}>确认删除</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  </div>;

  return <section aria-labelledby="visual-review-heading">
    <div className="flex flex-wrap items-end justify-between gap-3">
      <div>
        <h3 id="visual-review-heading" className="text-base font-semibold">画面方案</h3>
        <p className="mt-2 text-sm text-[var(--fg-secondary)]">行内仅展示决策摘要，完整描述和生图提示词在详情中编辑。</p>
      </div>
      <Button ref={addVisualRef} type="button" variant="outline" disabled={busy || !paragraphs.length} onClick={onAddVisual}>增加画面</Button>
    </div>

    <div className="mt-4 flex flex-wrap items-center justify-between gap-3 border-y border-[var(--border-subtle)] bg-[var(--bg-subtle)] px-3 py-2 text-sm">
      <p className="text-[var(--fg-secondary)]">共 {visuals.length} 个画面 · {incompatible ? "需绑定当前旁白修订" : "当前草稿可继续审核"}</p>
      {visuals.length <= 1 ? <p className="text-[var(--warning)]" role="status">至少保留一个画面，当前不可删除。</p> : null}
    </div>

    <div className="hidden md:block">
      <Table className="text-left">
        <TableCaption className="sr-only">画面方案列表</TableCaption>
        <TableHeader>
          <TableRow>
            <TableHead scope="col">编号</TableHead>
            <TableHead scope="col">关联旁白</TableHead>
            <TableHead scope="col">用途与描述</TableHead>
            <TableHead scope="col">状态</TableHead>
            <TableHead scope="col">操作</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {view.items.map((visual) => {
            const index = visuals.indexOf(visual);
            return <TableRow key={visual.id}>
              <TableHead className="whitespace-nowrap font-mono text-xs" scope="row">画面 {String(index + 1).padStart(2, "0")}</TableHead>
              <TableCell className="whitespace-nowrap">{paragraphLabel(visual.paragraphId)}</TableCell>
              <TableCell className="max-w-md whitespace-normal"><strong className="block break-words font-semibold">{summary(visual.purpose)}</strong><span className="mt-1 block line-clamp-2 break-words text-[var(--fg-secondary)]">{summary(visual.description)}</span></TableCell>
              <TableCell className="whitespace-nowrap"><Badge variant={incompatible ? "destructive" : "secondary"}>{incompatible ? "需重新绑定" : "当前草稿"}</Badge><span className="mt-1 block text-xs text-[var(--fg-secondary)]">未生成候选</span></TableCell>
              <TableCell className="whitespace-nowrap">{actions(visual)}</TableCell>
            </TableRow>;
          })}
        </TableBody>
      </Table>
    </div>

    <div className="divide-y divide-[var(--border-subtle)] md:hidden">
      {view.items.map((visual) => {
        const index = visuals.indexOf(visual);
        return <article className="min-w-0 py-4" key={visual.id} aria-labelledby={`visual-mobile-${visual.id}`}>
          <div className="flex min-w-0 items-start justify-between gap-3">
            <div className="min-w-0"><h4 id={`visual-mobile-${visual.id}`} className="font-mono text-xs font-semibold">画面 {String(index + 1).padStart(2, "0")}</h4><p className="mt-1 text-xs text-[var(--fg-secondary)]">{paragraphLabel(visual.paragraphId)} · {incompatible ? "需重新绑定" : "当前草稿"}</p></div>
          </div>
          <p className="mt-3 break-words text-sm font-semibold">{summary(visual.purpose)}</p>
          <p className="mt-1 line-clamp-2 break-words text-sm leading-6 text-[var(--fg-secondary)]">{summary(visual.description)}</p>
          <div className="mt-3">{actions(visual)}</div>
        </article>;
      })}
    </div>

    {!visuals.length ? <p className="border-b border-[var(--border-subtle)] py-8 text-center text-sm text-[var(--fg-secondary)]">尚无画面。请先增加画面并关联旁白段落。</p> : null}

    <Pagination className="mt-3 flex-wrap justify-between gap-3" aria-label="画面方案分页">
      <Field orientation="horizontal" className="w-auto gap-2">
        <FieldLabel htmlFor={`${paragraphId}-page-size`} className="whitespace-nowrap text-[var(--fg-secondary)]">每页</FieldLabel>
        <NativeSelect id={`${paragraphId}-page-size`} className="w-auto" value={pageSize} onChange={(event) => { setPageSize(Number(event.target.value)); setPage(1); }}>
          {PAGE_SIZE_OPTIONS.map((option) => <NativeSelectOption key={option} value={option}>{option} 条</NativeSelectOption>)}
        </NativeSelect>
      </Field>
      <p className="whitespace-nowrap font-mono text-xs text-[var(--fg-secondary)]">第 {view.page} / {view.totalPages} 页</p>
      <div className="flex gap-2">
        <Button type="button" variant="outline" disabled={view.page <= 1} onClick={() => setPage(view.page - 1)}>上一页</Button>
        <Button type="button" variant="outline" disabled={view.page >= view.totalPages} onClick={() => setPage(view.page + 1)}>下一页</Button>
      </div>
    </Pagination>

    <Dialog open={Boolean(editingId && draft)} onOpenChange={requestClose}>
      {draft ? <DialogContent showCloseButton={false} onOpenAutoFocus={(event) => { event.preventDefault(); initialFocusRef.current?.focus(); }} onCloseAutoFocus={(event) => { event.preventDefault(); triggerRef.current?.focus(); }}>
        <DialogHeader>
          <div className="flex items-start justify-between gap-4">
            <div className="grid min-w-0 gap-2">
              <DialogTitle>编辑画面 {String(visuals.findIndex((visual) => visual.id === draft.id) + 1).padStart(2, "0")}</DialogTitle>
              <DialogDescription>{paragraphLabel(draft.paragraphId)} · 修改仅应用到当前页面草稿，保存修订后才写入服务端。</DialogDescription>
            </div>
            <DialogClose asChild>
              <Button type="button" variant="outline" className="shrink-0" disabled={busy}>关闭</Button>
            </DialogClose>
          </div>
        </DialogHeader>
        <div className="grid gap-5 p-5 sm:grid-cols-2 sm:p-6">
          {closeBlocked ? <Alert className="border-[var(--warning)] bg-[var(--status-warning-soft)] sm:col-span-2">
            <AlertTitle className="text-[var(--warning)]">当前画面还有未应用修改。要放弃修改并关闭吗？</AlertTitle>
            <AlertDescription>
              <div className="flex flex-wrap gap-2"><Button ref={continueEditingRef} type="button" variant="outline" onClick={() => { setCloseBlocked(false); initialFocusRef.current?.focus(); }}>继续编辑</Button><Button type="button" variant="outline" className="text-destructive" onClick={discardAndClose}>放弃修改并关闭</Button></div>
            </AlertDescription>
          </Alert> : null}
          <Field>
            <FieldLabel htmlFor={paragraphId}>关联旁白段落</FieldLabel>
            <NativeSelect id={paragraphId} ref={initialFocusRef} wrapperClassName="w-full" className="w-full" disabled={busy} value={draft.paragraphId} onChange={(event) => setDraft({ ...draft, paragraphId: event.target.value })}>
              {paragraphs.map((paragraph, index) => <NativeSelectOption key={paragraph.id} value={paragraph.id}>旁白段落 {String(index + 1).padStart(2, "0")} · {paragraph.id}</NativeSelectOption>)}
            </NativeSelect>
          </Field>
          <Field>
            <FieldLabel htmlFor={purposeId}>画面用途</FieldLabel>
            <Input id={purposeId} disabled={busy} value={draft.purpose} onChange={(event) => setDraft({ ...draft, purpose: event.target.value })} />
          </Field>
          <Field className="sm:col-span-2" data-invalid={Boolean(fieldErrors.description)}>
            <FieldLabel htmlFor={descriptionId}>中文画面描述</FieldLabel>
            <Textarea id={descriptionId} ref={descriptionRef} className="min-h-24 resize-y leading-6" disabled={busy} value={draft.description} aria-invalid={Boolean(fieldErrors.description)} aria-describedby={fieldErrors.description ? descriptionErrorId : undefined} onChange={(event) => { setDraft({ ...draft, description: event.target.value }); if (fieldErrors.description) setFieldErrors((current) => ({ ...current, description: null })); }} />
            <FieldError id={descriptionErrorId}>{fieldErrors.description}</FieldError>
          </Field>
          <Field className="sm:col-span-2" data-invalid={Boolean(fieldErrors.prompt)}>
            <FieldLabel htmlFor={promptId}>最终生图 prompt</FieldLabel>
            <Textarea id={promptId} ref={promptRef} className="min-h-24 resize-y leading-6" disabled={busy} value={draft.prompt} aria-invalid={Boolean(fieldErrors.prompt)} aria-describedby={fieldErrors.prompt ? promptErrorId : undefined} onChange={(event) => { setDraft({ ...draft, prompt: event.target.value }); if (fieldErrors.prompt) setFieldErrors((current) => ({ ...current, prompt: null })); }} />
            <FieldError id={promptErrorId}>{fieldErrors.prompt}</FieldError>
          </Field>
          <Field className="sm:col-span-2">
            <FieldLabel htmlFor={negativePromptId}>负面 prompt</FieldLabel>
            <Textarea id={negativePromptId} className="min-h-24 resize-y leading-6" disabled={busy} value={draft.negativePrompt} onChange={(event) => setDraft({ ...draft, negativePrompt: event.target.value })} />
          </Field>
          <dl className="grid gap-3 bg-[var(--bg-subtle)] p-4 text-sm sm:col-span-2 sm:grid-cols-2">
            <div><dt className="text-[var(--fg-secondary)]">建议时长</dt><dd className="mt-1 font-mono">{draft.suggestedDurationSeconds} 秒</dd></div>
            <div><dt className="text-[var(--fg-secondary)]">画面权重</dt><dd className="mt-1 font-mono">{draft.weight}</dd></div>
            <div><dt className="text-[var(--fg-secondary)]">生成状态</dt><dd className="mt-1">未生成</dd></div>
            <div><dt className="text-[var(--fg-secondary)]">当前候选</dt><dd className="mt-1">无</dd></div>
          </dl>
        </div>
        <DialogFooter>
          <DialogClose asChild>
            <Button type="button" variant="outline" disabled={busy}>取消</Button>
          </DialogClose>
          <Button type="button" disabled={busy || !dirty} onClick={applyDraft}>{busy ? "正在处理…" : "应用到当前草稿"}</Button>
        </DialogFooter>
      </DialogContent> : null}
    </Dialog>
  </section>;
}
