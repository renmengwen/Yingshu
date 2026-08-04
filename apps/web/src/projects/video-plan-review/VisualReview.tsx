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
import { buttonVariants } from "../../components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../../components/ui/dialog";
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

const fieldClass = "mt-2 min-h-11 w-full rounded border border-[var(--border-strong)] bg-[var(--bg-canvas)] px-3 py-2 text-sm disabled:cursor-not-allowed disabled:opacity-50";
const textAreaClass = `${fieldClass} min-h-24 resize-y leading-6`;
const outlineButton = buttonVariants({ variant: "outline" });

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
    <button
      type="button"
      className={outlineButton}
      disabled={busy}
      data-visual-focus-id={visual.id}
      onClick={(event) => openEditor(visual, event.currentTarget)}
    >
      查看与编辑
    </button>
    <AlertDialog>
      <AlertDialogTrigger asChild>
        <button
          type="button"
          className={`${outlineButton} text-[var(--danger)]`}
          disabled={busy || visuals.length <= 1}
          title={visuals.length <= 1 ? "至少保留一个画面" : "删除当前画面草稿"}
        >
          删除
        </button>
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
      <button ref={addVisualRef} type="button" className={outlineButton} disabled={busy || !paragraphs.length} onClick={onAddVisual}>增加画面</button>
    </div>

    <div className="mt-4 flex flex-wrap items-center justify-between gap-3 border-y border-[var(--border-subtle)] bg-[var(--bg-subtle)] px-3 py-2 text-sm">
      <p className="text-[var(--fg-secondary)]">共 {visuals.length} 个画面 · {incompatible ? "需绑定当前旁白修订" : "当前草稿可继续审核"}</p>
      {visuals.length <= 1 ? <p className="text-[var(--warning)]" role="status">至少保留一个画面，当前不可删除。</p> : null}
    </div>

    <div className="hidden overflow-x-auto md:block">
      <table className="w-full border-collapse text-left text-sm">
        <caption className="sr-only">画面方案列表</caption>
        <thead className="bg-[var(--bg-subtle)] text-xs text-[var(--fg-secondary)]">
          <tr>
            <th className="px-3 py-3 font-semibold" scope="col">编号</th>
            <th className="px-3 py-3 font-semibold" scope="col">关联旁白</th>
            <th className="px-3 py-3 font-semibold" scope="col">用途与描述</th>
            <th className="px-3 py-3 font-semibold" scope="col">状态</th>
            <th className="px-3 py-3 font-semibold" scope="col">操作</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-[var(--border-subtle)]">
          {view.items.map((visual) => {
            const index = visuals.indexOf(visual);
            return <tr key={visual.id}>
              <th className="whitespace-nowrap px-3 py-3 font-mono text-xs font-semibold" scope="row">画面 {String(index + 1).padStart(2, "0")}</th>
              <td className="px-3 py-3">{paragraphLabel(visual.paragraphId)}</td>
              <td className="max-w-md px-3 py-3"><strong className="block font-semibold">{summary(visual.purpose)}</strong><span className="mt-1 block line-clamp-2 text-[var(--fg-secondary)]">{summary(visual.description)}</span></td>
              <td className="px-3 py-3"><span className="inline-flex rounded border border-[var(--border-strong)] bg-[var(--bg-subtle)] px-2 py-1 text-xs">{incompatible ? "需重新绑定" : "当前草稿"}</span><span className="mt-1 block text-xs text-[var(--fg-secondary)]">未生成候选</span></td>
              <td className="px-3 py-3">{actions(visual)}</td>
            </tr>;
          })}
        </tbody>
      </table>
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

    <nav className="mt-3 flex flex-wrap items-center justify-between gap-3" aria-label="画面方案分页">
      <label className="flex min-h-11 items-center gap-2 text-sm text-[var(--fg-secondary)]">每页
        <select className={`${fieldClass} mt-0 w-auto`} value={pageSize} onChange={(event) => { setPageSize(Number(event.target.value)); setPage(1); }}>
          {PAGE_SIZE_OPTIONS.map((option) => <option key={option} value={option}>{option} 条</option>)}
        </select>
      </label>
      <p className="font-mono text-xs text-[var(--fg-secondary)]">第 {view.page} / {view.totalPages} 页</p>
      <div className="flex gap-2">
        <button type="button" className={outlineButton} disabled={view.page <= 1} onClick={() => setPage(view.page - 1)}>上一页</button>
        <button type="button" className={outlineButton} disabled={view.page >= view.totalPages} onClick={() => setPage(view.page + 1)}>下一页</button>
      </div>
    </nav>

    <Dialog open={Boolean(editingId && draft)} onOpenChange={requestClose} initialFocusRef={initialFocusRef} triggerRef={triggerRef}>
      {draft ? <>
        <DialogHeader>
          <div className="flex items-start justify-between gap-4">
            <div className="grid min-w-0 gap-2">
              <DialogTitle>编辑画面 {String(visuals.findIndex((visual) => visual.id === draft.id) + 1).padStart(2, "0")}</DialogTitle>
              <DialogDescription>{paragraphLabel(draft.paragraphId)} · 修改仅应用到当前页面草稿，保存修订后才写入服务端。</DialogDescription>
            </div>
            <DialogClose className="shrink-0" disabled={busy}>关闭</DialogClose>
          </div>
        </DialogHeader>
        <div className="grid gap-5 p-5 sm:grid-cols-2 sm:p-6">
          {closeBlocked ? <div className="grid gap-3 border border-[var(--warning)] bg-[var(--status-warning-soft)] p-4 sm:col-span-2" role="alert">
            <p className="text-sm font-semibold text-[var(--warning)]">当前画面还有未应用修改。要放弃修改并关闭吗？</p>
            <div className="flex flex-wrap gap-2"><button ref={continueEditingRef} type="button" className={outlineButton} onClick={() => { setCloseBlocked(false); initialFocusRef.current?.focus(); }}>继续编辑</button><button type="button" className={`${outlineButton} text-[var(--danger)]`} onClick={discardAndClose}>放弃修改并关闭</button></div>
          </div> : null}
          <label className="text-sm font-semibold">关联旁白段落
            <select ref={initialFocusRef} className={fieldClass} disabled={busy} value={draft.paragraphId} onChange={(event) => setDraft({ ...draft, paragraphId: event.target.value })}>
              {paragraphs.map((paragraph, index) => <option key={paragraph.id} value={paragraph.id}>旁白段落 {String(index + 1).padStart(2, "0")} · {paragraph.id}</option>)}
            </select>
          </label>
          <label className="text-sm font-semibold">画面用途
            <input className={fieldClass} disabled={busy} value={draft.purpose} onChange={(event) => setDraft({ ...draft, purpose: event.target.value })} />
          </label>
          <label className="text-sm font-semibold sm:col-span-2">中文画面描述
            <textarea ref={descriptionRef} className={textAreaClass} disabled={busy} value={draft.description} aria-invalid={Boolean(fieldErrors.description)} aria-describedby={fieldErrors.description ? descriptionErrorId : undefined} onChange={(event) => { setDraft({ ...draft, description: event.target.value }); if (fieldErrors.description) setFieldErrors((current) => ({ ...current, description: null })); }} />
            {fieldErrors.description ? <span id={descriptionErrorId} className="mt-2 block text-sm font-normal text-[var(--danger)]" role="alert">{fieldErrors.description}</span> : null}
          </label>
          <label className="text-sm font-semibold sm:col-span-2">最终生图 prompt
            <textarea ref={promptRef} className={textAreaClass} disabled={busy} value={draft.prompt} aria-invalid={Boolean(fieldErrors.prompt)} aria-describedby={fieldErrors.prompt ? promptErrorId : undefined} onChange={(event) => { setDraft({ ...draft, prompt: event.target.value }); if (fieldErrors.prompt) setFieldErrors((current) => ({ ...current, prompt: null })); }} />
            {fieldErrors.prompt ? <span id={promptErrorId} className="mt-2 block text-sm font-normal text-[var(--danger)]" role="alert">{fieldErrors.prompt}</span> : null}
          </label>
          <label className="text-sm font-semibold sm:col-span-2">负面 prompt
            <textarea className={textAreaClass} disabled={busy} value={draft.negativePrompt} onChange={(event) => setDraft({ ...draft, negativePrompt: event.target.value })} />
          </label>
          <dl className="grid gap-3 bg-[var(--bg-subtle)] p-4 text-sm sm:col-span-2 sm:grid-cols-2">
            <div><dt className="text-[var(--fg-secondary)]">建议时长</dt><dd className="mt-1 font-mono">{draft.suggestedDurationSeconds} 秒</dd></div>
            <div><dt className="text-[var(--fg-secondary)]">画面权重</dt><dd className="mt-1 font-mono">{draft.weight}</dd></div>
            <div><dt className="text-[var(--fg-secondary)]">生成状态</dt><dd className="mt-1">未生成</dd></div>
            <div><dt className="text-[var(--fg-secondary)]">当前候选</dt><dd className="mt-1">无</dd></div>
          </dl>
        </div>
        <DialogFooter>
          <DialogClose disabled={busy}>取消</DialogClose>
          <button type="button" className={buttonVariants()} disabled={busy || !dirty} onClick={applyDraft}>{busy ? "正在处理…" : "应用到当前草稿"}</button>
        </DialogFooter>
      </> : null}
    </Dialog>
  </section>;
}
