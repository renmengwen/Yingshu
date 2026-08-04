import { useEffect, useId, useMemo, useRef, useState } from "react";

import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../../components/ui/dialog";
import type { VideoScriptParagraph, VideoVisualDraft } from "../types";
import { paragraphTextFieldError, scriptMetadataFieldErrors } from "../plan-logic";
import { PAGE_SIZE_OPTIONS, paginate } from "./logic";

type NarrationReviewProps = {
  title: string;
  summary: string;
  paragraphs: VideoScriptParagraph[];
  visuals: VideoVisualDraft[];
  busy: boolean;
  onApplyMetadata: (title: string, summary: string) => void;
  onApplyParagraph: (paragraph: VideoScriptParagraph) => void;
};

const buttonClass = "min-h-11 rounded border border-[var(--border-strong)] bg-transparent px-4 text-sm font-semibold text-[var(--fg-primary)] hover:bg-[var(--bg-subtle)] disabled:cursor-not-allowed disabled:opacity-50";
const primaryButtonClass = "min-h-11 rounded border border-[var(--accent)] bg-[var(--accent)] px-4 text-sm font-semibold text-[var(--accent-contrast)] hover:border-[var(--accent-strong)] hover:bg-[var(--accent-strong)] disabled:cursor-not-allowed disabled:opacity-50";
const fieldClass = "mt-2 min-h-11 w-full rounded border border-[var(--border-strong)] bg-[var(--bg-surface)] px-3 py-2 text-sm text-[var(--fg-primary)] disabled:opacity-60";

function recordLabel(index: number) {
  return `旁白段落 ${String(index + 1).padStart(2, "0")}`;
}

export function NarrationReview({
  title,
  summary,
  paragraphs,
  visuals,
  busy,
  onApplyMetadata,
  onApplyParagraph,
}: NarrationReviewProps) {
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState<(typeof PAGE_SIZE_OPTIONS)[number]>(10);
  const paged = paginate(paragraphs, page, pageSize);
  const visualCounts = useMemo(() => {
    const counts = new Map<string, number>();
    visuals.forEach((visual) => counts.set(visual.paragraphId, (counts.get(visual.paragraphId) ?? 0) + 1));
    return counts;
  }, [visuals]);

  const [metadataOpen, setMetadataOpen] = useState(false);
  const [metadataTitle, setMetadataTitle] = useState(title);
  const [metadataSummary, setMetadataSummary] = useState(summary);
  const [metadataDiscard, setMetadataDiscard] = useState(false);
  const [metadataErrors, setMetadataErrors] = useState<{ title: string | null; summary: string | null }>({ title: null, summary: null });
  const metadataTriggerRef = useRef<HTMLButtonElement>(null);
  const metadataInitialFocusRef = useRef<HTMLInputElement>(null);
  const metadataSummaryRef = useRef<HTMLTextAreaElement>(null);
  const metadataContinueRef = useRef<HTMLButtonElement>(null);
  const metadataTitleErrorId = useId();
  const metadataSummaryErrorId = useId();
  const metadataDirty = metadataTitle !== title || metadataSummary !== summary;

  const [selectedParagraph, setSelectedParagraph] = useState<VideoScriptParagraph | null>(null);
  const [paragraphText, setParagraphText] = useState("");
  const [paragraphDiscard, setParagraphDiscard] = useState(false);
  const [paragraphError, setParagraphError] = useState<string | null>(null);
  const paragraphTriggerRef = useRef<HTMLButtonElement>(null);
  const paragraphInitialFocusRef = useRef<HTMLTextAreaElement>(null);
  const paragraphContinueRef = useRef<HTMLButtonElement>(null);
  const paragraphErrorId = useId();
  const paragraphDirty = selectedParagraph !== null && paragraphText !== selectedParagraph.text;
  const selectedIndex = selectedParagraph ? paragraphs.findIndex((item) => item.id === selectedParagraph.id) : -1;

  useEffect(() => {
    if (paged.page !== page) setPage(paged.page);
  }, [page, paged.page]);

  useEffect(() => {
    if (metadataDiscard) metadataContinueRef.current?.focus();
  }, [metadataDiscard]);

  useEffect(() => {
    if (paragraphDiscard) paragraphContinueRef.current?.focus();
  }, [paragraphDiscard]);

  const openMetadata = () => {
    setMetadataTitle(title);
    setMetadataSummary(summary);
    setMetadataDiscard(false);
    setMetadataErrors({ title: null, summary: null });
    setMetadataOpen(true);
  };
  const closeMetadata = () => {
    if (metadataDirty) setMetadataDiscard(true);
    else setMetadataOpen(false);
  };
  const discardMetadata = () => {
    setMetadataTitle(title);
    setMetadataSummary(summary);
    setMetadataDiscard(false);
    setMetadataOpen(false);
  };

  const openParagraph = (paragraph: VideoScriptParagraph, trigger: HTMLButtonElement) => {
    paragraphTriggerRef.current = trigger;
    setSelectedParagraph(paragraph);
    setParagraphText(paragraph.text);
    setParagraphDiscard(false);
    setParagraphError(null);
  };
  const closeParagraph = () => {
    if (paragraphDirty) setParagraphDiscard(true);
    else setSelectedParagraph(null);
  };
  const discardParagraph = () => {
    setParagraphText(selectedParagraph?.text ?? "");
    setParagraphDiscard(false);
    setSelectedParagraph(null);
  };

  return <section aria-labelledby="narration-review-heading">
    <div className="flex flex-col gap-4 border-b border-[var(--border-subtle)] pb-4 sm:flex-row sm:items-end sm:justify-between">
      <div className="min-w-0">
        <h3 id="narration-review-heading" className="text-base font-semibold">旁白方案</h3>
        <p className="mt-1 truncate text-sm font-semibold text-[var(--fg-primary)]">{title || "未填写标题"}</p>
        <p className="mt-1 line-clamp-2 text-sm leading-6 text-[var(--fg-secondary)]">{summary || "未填写摘要"}</p>
      </div>
      <button ref={metadataTriggerRef} className={`${buttonClass} shrink-0`} type="button" disabled={busy} onClick={openMetadata}>编辑标题与摘要</button>
    </div>

    <div className="mt-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
      <p className="text-sm text-[var(--fg-secondary)]">共 {paragraphs.length} 条旁白。编辑只应用到当前页面草稿，保存后才创建新修订。</p>
      <label className="flex min-h-11 items-center gap-2 text-sm font-semibold">
        每页
        <select
          aria-label="旁白每页条数"
          className="min-h-11 rounded border border-[var(--border-strong)] bg-[var(--bg-surface)] px-3"
          value={pageSize}
          onChange={(event) => {
            setPageSize(Number(event.target.value) as (typeof PAGE_SIZE_OPTIONS)[number]);
            setPage(1);
          }}
        >
          {PAGE_SIZE_OPTIONS.map((option) => <option key={option} value={option}>{option} 条</option>)}
        </select>
      </label>
    </div>

    <div className="mt-3 hidden overflow-hidden border-y border-[var(--border-subtle)] md:block">
      <table className="w-full table-fixed border-collapse text-left text-sm">
        <caption className="sr-only">旁白方案列表</caption>
        <thead className="bg-[var(--bg-subtle)] text-xs text-[var(--fg-tertiary)]">
          <tr>
            <th className="w-36 px-3 py-3 font-semibold" scope="col">段落</th>
            <th className="px-3 py-3 font-semibold" scope="col">内容摘要</th>
            <th className="w-24 px-3 py-3 font-semibold" scope="col">关联画面</th>
            <th className="w-28 px-3 py-3 font-semibold" scope="col">状态</th>
            <th className="w-28 px-3 py-3 font-semibold" scope="col">操作</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-[var(--border-subtle)]">
          {paged.items.map((paragraph) => {
            const index = paragraphs.findIndex((item) => item.id === paragraph.id);
            return <tr key={paragraph.id}>
              <th className="px-3 py-3 align-top font-mono text-xs font-medium text-[var(--fg-secondary)]" scope="row">{recordLabel(index)}</th>
              <td className="px-3 py-3 align-top"><p className="line-clamp-2 break-words leading-6">{paragraph.text || "未填写内容"}</p><p className="mt-1 font-mono text-xs text-[var(--fg-tertiary)]">{paragraph.text.length} 字</p></td>
              <td className="px-3 py-3 align-top font-mono">{visualCounts.get(paragraph.id) ?? 0}</td>
              <td className="px-3 py-3 align-top"><span className="inline-flex min-h-7 items-center rounded border border-[var(--border-strong)] bg-[var(--bg-subtle)] px-2 text-xs">当前草稿</span></td>
              <td className="px-3 py-2 align-top"><button className={buttonClass} type="button" disabled={busy} onClick={(event) => openParagraph(paragraph, event.currentTarget)}>查看与编辑</button></td>
            </tr>;
          })}
        </tbody>
      </table>
    </div>

    <ul className="mt-3 divide-y divide-[var(--border-subtle)] border-y border-[var(--border-subtle)] md:hidden">
      {paged.items.map((paragraph) => {
        const index = paragraphs.findIndex((item) => item.id === paragraph.id);
        return <li className="min-w-0 py-4" key={paragraph.id}>
          <div className="flex min-w-0 items-center justify-between gap-2">
            <p className="min-w-0 truncate font-mono text-xs text-[var(--fg-secondary)]">{recordLabel(index)}</p>
            <span className="shrink-0 text-xs text-[var(--fg-secondary)]">当前草稿</span>
          </div>
          <p className="mt-2 line-clamp-2 break-words text-sm leading-6">{paragraph.text || "未填写内容"}</p>
          <p className="mt-1 text-xs text-[var(--fg-tertiary)]">{paragraph.text.length} 字 · 关联 {visualCounts.get(paragraph.id) ?? 0} 个画面</p>
          <button className={`${buttonClass} mt-3 w-full`} type="button" disabled={busy} onClick={(event) => openParagraph(paragraph, event.currentTarget)}>查看与编辑</button>
        </li>;
      })}
    </ul>

    <nav aria-label="旁白分页" className="mt-3 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
      <p className="text-sm text-[var(--fg-secondary)]">第 {paged.page} / {paged.totalPages} 页，共 {paged.totalItems} 条</p>
      <div className="flex flex-wrap gap-2">
        <button className={buttonClass} type="button" disabled={paged.page === 1} onClick={() => setPage((current) => current - 1)}>上一页</button>
        <button className={buttonClass} type="button" disabled={paged.page === paged.totalPages} onClick={() => setPage((current) => current + 1)}>下一页</button>
      </div>
    </nav>

    <Dialog open={metadataOpen} onOpenChange={(open) => open ? setMetadataOpen(true) : closeMetadata()} initialFocusRef={metadataInitialFocusRef} triggerRef={metadataTriggerRef}>
      <DialogHeader>
        <div className="flex items-start justify-between gap-4">
          <div><DialogTitle>编辑旁白标题与摘要</DialogTitle><DialogDescription className="mt-2">修改方案级文案；应用后仍需在阶段操作栏保存旁白修订。</DialogDescription></div>
          <button className={buttonClass} type="button" onClick={closeMetadata}>关闭</button>
        </div>
      </DialogHeader>
      <div className="grid gap-5 p-5 sm:p-6">
        <label className="text-sm font-semibold">标题建议<input ref={metadataInitialFocusRef} aria-invalid={Boolean(metadataErrors.title)} aria-describedby={metadataErrors.title ? metadataTitleErrorId : undefined} className={fieldClass} disabled={busy} value={metadataTitle} onChange={(event) => { setMetadataTitle(event.target.value); setMetadataDiscard(false); setMetadataErrors((current) => ({ ...current, title: null })); }} />{metadataErrors.title ? <span id={metadataTitleErrorId} className="mt-2 block text-sm font-normal text-[var(--danger)]">{metadataErrors.title}</span> : null}</label>
        <label className="text-sm font-semibold">摘要<textarea ref={metadataSummaryRef} aria-invalid={Boolean(metadataErrors.summary)} aria-describedby={metadataErrors.summary ? metadataSummaryErrorId : undefined} className={`${fieldClass} min-h-32 resize-y leading-6`} disabled={busy} value={metadataSummary} onChange={(event) => { setMetadataSummary(event.target.value); setMetadataDiscard(false); setMetadataErrors((current) => ({ ...current, summary: null })); }} />{metadataErrors.summary ? <span id={metadataSummaryErrorId} className="mt-2 block text-sm font-normal text-[var(--danger)]">{metadataErrors.summary}</span> : null}</label>
      </div>
      <DialogFooter className="items-stretch">
        {metadataDiscard ? <div className="mb-2 w-full bg-[var(--status-warning-soft)] p-3 text-sm text-[var(--warning)] sm:mr-auto sm:mb-0" role="alert"><p>标题或摘要还有未应用修改。</p><div className="mt-3 flex flex-col gap-2 sm:flex-row"><button ref={metadataContinueRef} className={buttonClass} type="button" onClick={() => { setMetadataDiscard(false); metadataInitialFocusRef.current?.focus(); }}>继续编辑</button><button className={buttonClass} type="button" onClick={discardMetadata}>放弃修改并关闭</button></div></div> : <button className={buttonClass} type="button" onClick={closeMetadata}>取消</button>}
        <button className={primaryButtonClass} type="button" disabled={busy || !metadataDirty} onClick={() => {
          const errors = scriptMetadataFieldErrors(metadataTitle, metadataSummary);
          setMetadataErrors(errors);
          if (errors.title) metadataInitialFocusRef.current?.focus();
          else if (errors.summary) metadataSummaryRef.current?.focus();
          else {
            onApplyMetadata(metadataTitle, metadataSummary);
            setMetadataOpen(false);
          }
        }}>应用到当前草稿</button>
      </DialogFooter>
    </Dialog>

    <Dialog open={selectedParagraph !== null} onOpenChange={(open) => { if (!open) closeParagraph(); }} initialFocusRef={paragraphInitialFocusRef} triggerRef={paragraphTriggerRef}>
      <DialogHeader>
        <div className="flex items-start justify-between gap-4">
          <div><DialogTitle>编辑{selectedIndex >= 0 ? recordLabel(selectedIndex) : "旁白段落"}</DialogTitle><DialogDescription className="mt-2">记录 {selectedParagraph?.id ?? ""} · 关联 {selectedParagraph ? visualCounts.get(selectedParagraph.id) ?? 0 : 0} 个画面。应用后仍需保存旁白修订。</DialogDescription></div>
          <button className={buttonClass} type="button" onClick={closeParagraph}>关闭</button>
        </div>
      </DialogHeader>
      <div className="p-5 sm:p-6">
        <label className="text-sm font-semibold">旁白正文<textarea ref={paragraphInitialFocusRef} aria-invalid={Boolean(paragraphError)} aria-describedby={paragraphError ? paragraphErrorId : undefined} className={`${fieldClass} min-h-64 resize-y leading-7`} disabled={busy} value={paragraphText} onChange={(event) => { setParagraphText(event.target.value); setParagraphDiscard(false); setParagraphError(null); }} />{paragraphError ? <span id={paragraphErrorId} className="mt-2 block text-sm font-normal text-[var(--danger)]">{paragraphError}</span> : null}</label>
        <p className="mt-2 font-mono text-xs text-[var(--fg-tertiary)]">{paragraphText.length} 字</p>
      </div>
      <DialogFooter className="items-stretch">
        {paragraphDiscard ? <div className="mb-2 w-full bg-[var(--status-warning-soft)] p-3 text-sm text-[var(--warning)] sm:mr-auto sm:mb-0" role="alert"><p>旁白正文还有未应用修改。</p><div className="mt-3 flex flex-col gap-2 sm:flex-row"><button ref={paragraphContinueRef} className={buttonClass} type="button" onClick={() => { setParagraphDiscard(false); paragraphInitialFocusRef.current?.focus(); }}>继续编辑</button><button className={buttonClass} type="button" onClick={discardParagraph}>放弃修改并关闭</button></div></div> : <button className={buttonClass} type="button" onClick={closeParagraph}>取消</button>}
        <button className={primaryButtonClass} type="button" disabled={busy || !paragraphDirty || !selectedParagraph} onClick={() => {
          const error = paragraphTextFieldError(paragraphText);
          setParagraphError(error);
          if (error) paragraphInitialFocusRef.current?.focus();
          else {
            if (selectedParagraph) onApplyParagraph({ ...selectedParagraph, text: paragraphText });
            setSelectedParagraph(null);
          }
        }}>应用到当前草稿</button>
      </DialogFooter>
    </Dialog>
  </section>;
}
