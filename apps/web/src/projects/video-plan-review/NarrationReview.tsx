import { useEffect, useId, useMemo, useRef, useState } from "react";

import { Alert, AlertDescription } from "../../components/ui/alert";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import {
  Dialog,
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
import { Table, TableBody, TableCaption, TableCell, TableHead, TableHeader, TableRow } from "../../components/ui/table";
import { Textarea } from "../../components/ui/textarea";
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
  const pageSizeId = useId();
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
  const metadataTitleId = useId();
  const metadataSummaryId = useId();
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
  const paragraphTextId = useId();
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
      <Button ref={metadataTriggerRef} className="shrink-0" variant="outline" type="button" disabled={busy} onClick={openMetadata}>编辑标题与摘要</Button>
    </div>

    <div className="mt-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
      <p className="text-sm text-[var(--fg-secondary)]">共 {paragraphs.length} 条旁白。编辑只应用到当前页面草稿，保存后才创建新修订。</p>
      <div className="flex min-h-11 items-center gap-2 text-sm font-semibold">
        <label htmlFor={pageSizeId}>每页</label>
        <NativeSelect
          id={pageSizeId}
          aria-label="旁白每页条数"
          value={pageSize}
          onChange={(event) => {
            setPageSize(Number(event.target.value) as (typeof PAGE_SIZE_OPTIONS)[number]);
            setPage(1);
          }}
        >
          {PAGE_SIZE_OPTIONS.map((option) => <NativeSelectOption key={option} value={option}>{option} 条</NativeSelectOption>)}
        </NativeSelect>
      </div>
    </div>

    <div className="mt-3 hidden overflow-hidden border-y border-[var(--border-subtle)] md:block">
      <Table className="table-fixed">
        <TableCaption className="sr-only">旁白方案列表</TableCaption>
        <TableHeader>
          <TableRow>
            <TableHead className="w-36" scope="col">段落</TableHead>
            <TableHead scope="col">内容摘要</TableHead>
            <TableHead className="w-24" scope="col">关联画面</TableHead>
            <TableHead className="w-28" scope="col">状态</TableHead>
            <TableHead className="w-28" scope="col">操作</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {paged.items.map((paragraph) => {
            const index = paragraphs.findIndex((item) => item.id === paragraph.id);
            return <TableRow key={paragraph.id}>
              <TableHead className="h-auto align-top font-mono text-xs text-[var(--fg-secondary)]" scope="row">{recordLabel(index)}</TableHead>
              <TableCell className="align-top whitespace-normal"><p className="line-clamp-2 break-words leading-6">{paragraph.text || "未填写内容"}</p><p className="mt-1 font-mono text-xs text-[var(--fg-tertiary)]">{paragraph.text.length} 字</p></TableCell>
              <TableCell className="align-top font-mono">{visualCounts.get(paragraph.id) ?? 0}</TableCell>
              <TableCell className="align-top"><Badge variant="secondary">当前草稿</Badge></TableCell>
              <TableCell className="align-top"><Button variant="outline" type="button" disabled={busy} onClick={(event) => openParagraph(paragraph, event.currentTarget)}>查看与编辑</Button></TableCell>
            </TableRow>;
          })}
        </TableBody>
      </Table>
    </div>

    <ul className="mt-3 divide-y divide-[var(--border-subtle)] border-y border-[var(--border-subtle)] md:hidden">
      {paged.items.map((paragraph) => {
        const index = paragraphs.findIndex((item) => item.id === paragraph.id);
        return <li className="min-w-0 py-4" key={paragraph.id}>
          <div className="flex min-w-0 items-center justify-between gap-2">
            <p className="min-w-0 truncate font-mono text-xs text-[var(--fg-secondary)]">{recordLabel(index)}</p>
            <Badge className="shrink-0" variant="secondary">当前草稿</Badge>
          </div>
          <p className="mt-2 line-clamp-2 break-words text-sm leading-6">{paragraph.text || "未填写内容"}</p>
          <p className="mt-1 text-xs text-[var(--fg-tertiary)]">{paragraph.text.length} 字 · 关联 {visualCounts.get(paragraph.id) ?? 0} 个画面</p>
          <Button className="mt-3 w-full" variant="outline" type="button" disabled={busy} onClick={(event) => openParagraph(paragraph, event.currentTarget)}>查看与编辑</Button>
        </li>;
      })}
    </ul>

    <Pagination aria-label="旁白分页" className="mt-3 flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
      <p className="text-sm text-[var(--fg-secondary)]">第 {paged.page} / {paged.totalPages} 页，共 {paged.totalItems} 条</p>
      <div className="flex flex-wrap gap-2">
        <Button variant="outline" type="button" disabled={paged.page === 1} onClick={() => setPage((current) => current - 1)}>上一页</Button>
        <Button variant="outline" type="button" disabled={paged.page === paged.totalPages} onClick={() => setPage((current) => current + 1)}>下一页</Button>
      </div>
    </Pagination>

    <Dialog open={metadataOpen} onOpenChange={(open) => open ? setMetadataOpen(true) : closeMetadata()}>
      <DialogContent showCloseButton={false} onOpenAutoFocus={(event) => { event.preventDefault(); metadataInitialFocusRef.current?.focus(); }} onCloseAutoFocus={(event) => { event.preventDefault(); metadataTriggerRef.current?.focus(); }}>
      <DialogHeader>
        <div className="flex items-start justify-between gap-4">
          <div><DialogTitle>编辑旁白标题与摘要</DialogTitle><DialogDescription className="mt-2">修改方案级文案；应用后仍需在阶段操作栏保存旁白修订。</DialogDescription></div>
          <Button variant="outline" type="button" onClick={closeMetadata}>关闭</Button>
        </div>
      </DialogHeader>
      <div className="grid gap-5 p-5 sm:p-6">
        <Field data-invalid={Boolean(metadataErrors.title)}>
          <FieldLabel htmlFor={metadataTitleId}>标题建议</FieldLabel>
          <Input id={metadataTitleId} ref={metadataInitialFocusRef} aria-invalid={Boolean(metadataErrors.title)} aria-describedby={metadataErrors.title ? metadataTitleErrorId : undefined} disabled={busy} value={metadataTitle} onChange={(event) => { setMetadataTitle(event.target.value); setMetadataDiscard(false); setMetadataErrors((current) => ({ ...current, title: null })); }} />
          {metadataErrors.title ? <FieldError id={metadataTitleErrorId}>{metadataErrors.title}</FieldError> : null}
        </Field>
        <Field data-invalid={Boolean(metadataErrors.summary)}>
          <FieldLabel htmlFor={metadataSummaryId}>摘要</FieldLabel>
          <Textarea id={metadataSummaryId} ref={metadataSummaryRef} aria-invalid={Boolean(metadataErrors.summary)} aria-describedby={metadataErrors.summary ? metadataSummaryErrorId : undefined} className="min-h-32 resize-y leading-6" disabled={busy} value={metadataSummary} onChange={(event) => { setMetadataSummary(event.target.value); setMetadataDiscard(false); setMetadataErrors((current) => ({ ...current, summary: null })); }} />
          {metadataErrors.summary ? <FieldError id={metadataSummaryErrorId}>{metadataErrors.summary}</FieldError> : null}
        </Field>
      </div>
      <DialogFooter className="items-stretch">
        {metadataDiscard ? <Alert className="mb-2 w-full border-[var(--status-warning)] bg-[var(--status-warning-soft)] text-[var(--status-warning)] sm:mr-auto sm:mb-0"><AlertDescription className="text-inherit"><p>标题或摘要还有未应用修改。</p><div className="mt-3 flex flex-col gap-2 sm:flex-row"><Button ref={metadataContinueRef} variant="outline" type="button" onClick={() => { setMetadataDiscard(false); metadataInitialFocusRef.current?.focus(); }}>继续编辑</Button><Button variant="outline" type="button" onClick={discardMetadata}>放弃修改并关闭</Button></div></AlertDescription></Alert> : <Button variant="outline" type="button" onClick={closeMetadata}>取消</Button>}
        <Button type="button" disabled={busy || !metadataDirty} onClick={() => {
          const errors = scriptMetadataFieldErrors(metadataTitle, metadataSummary);
          setMetadataErrors(errors);
          if (errors.title) metadataInitialFocusRef.current?.focus();
          else if (errors.summary) metadataSummaryRef.current?.focus();
          else {
            onApplyMetadata(metadataTitle, metadataSummary);
            setMetadataOpen(false);
          }
        }}>应用到当前草稿</Button>
      </DialogFooter>
      </DialogContent>
    </Dialog>

    <Dialog open={selectedParagraph !== null} onOpenChange={(open) => { if (!open) closeParagraph(); }}>
      <DialogContent showCloseButton={false} onOpenAutoFocus={(event) => { event.preventDefault(); paragraphInitialFocusRef.current?.focus(); }} onCloseAutoFocus={(event) => { event.preventDefault(); paragraphTriggerRef.current?.focus(); }}>
      <DialogHeader>
        <div className="flex items-start justify-between gap-4">
          <div><DialogTitle>编辑{selectedIndex >= 0 ? recordLabel(selectedIndex) : "旁白段落"}</DialogTitle><DialogDescription className="mt-2">记录 {selectedParagraph?.id ?? ""} · 关联 {selectedParagraph ? visualCounts.get(selectedParagraph.id) ?? 0 : 0} 个画面。应用后仍需保存旁白修订。</DialogDescription></div>
          <Button variant="outline" type="button" onClick={closeParagraph}>关闭</Button>
        </div>
      </DialogHeader>
      <div className="p-5 sm:p-6">
        <Field data-invalid={Boolean(paragraphError)}>
          <FieldLabel htmlFor={paragraphTextId}>旁白正文</FieldLabel>
          <Textarea id={paragraphTextId} ref={paragraphInitialFocusRef} aria-invalid={Boolean(paragraphError)} aria-describedby={paragraphError ? paragraphErrorId : undefined} className="min-h-64 resize-y leading-7" disabled={busy} value={paragraphText} onChange={(event) => { setParagraphText(event.target.value); setParagraphDiscard(false); setParagraphError(null); }} />
          {paragraphError ? <FieldError id={paragraphErrorId}>{paragraphError}</FieldError> : null}
        </Field>
        <p className="mt-2 font-mono text-xs text-[var(--fg-tertiary)]">{paragraphText.length} 字</p>
      </div>
      <DialogFooter className="items-stretch">
        {paragraphDiscard ? <Alert className="mb-2 w-full border-[var(--status-warning)] bg-[var(--status-warning-soft)] text-[var(--status-warning)] sm:mr-auto sm:mb-0"><AlertDescription className="text-inherit"><p>旁白正文还有未应用修改。</p><div className="mt-3 flex flex-col gap-2 sm:flex-row"><Button ref={paragraphContinueRef} variant="outline" type="button" onClick={() => { setParagraphDiscard(false); paragraphInitialFocusRef.current?.focus(); }}>继续编辑</Button><Button variant="outline" type="button" onClick={discardParagraph}>放弃修改并关闭</Button></div></AlertDescription></Alert> : <Button variant="outline" type="button" onClick={closeParagraph}>取消</Button>}
        <Button type="button" disabled={busy || !paragraphDirty || !selectedParagraph} onClick={() => {
          const error = paragraphTextFieldError(paragraphText);
          setParagraphError(error);
          if (error) paragraphInitialFocusRef.current?.focus();
          else {
            if (selectedParagraph) onApplyParagraph({ ...selectedParagraph, text: paragraphText });
            setSelectedParagraph(null);
          }
        }}>应用到当前草稿</Button>
      </DialogFooter>
      </DialogContent>
    </Dialog>
  </section>;
}
