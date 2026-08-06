import { useEffect, useRef, useState } from "react";
import type { RefObject } from "react";

import { Button } from "../../components/ui/button";
import {
  Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "../../components/ui/dialog";
import { ChevronLeftIcon, ChevronRightIcon, LoaderCircleIcon } from "lucide-react";
import { projectApi } from "../api";
import { DouyinDetailContent } from "./DouyinDetailContent";
import type { DouyinDetailKind, DouyinSnapshotSummary } from "./types";

const TITLES: Record<DouyinDetailKind, string> = {
  metadata: "视频资料与冻结身份", report: "结构化分析报告", transcript: "ASR 完整转写", frames: "关键帧证据", comments: "评论样本与受众信号",
};

export function DouyinAnalysisDetails({ projectId, videoId, snapshot, kind, onClose, returnFocusRef }: {
  projectId: string; videoId: string; snapshot: DouyinSnapshotSummary; kind: DouyinDetailKind | null;
  onClose: () => void; returnFocusRef: RefObject<HTMLButtonElement | null>;
}) {
  const [value, setValue] = useState<unknown>();
  const [error, setError] = useState("");
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  const closeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!kind) return;
    if (kind === "metadata") { setValue(undefined); setError(""); return; }
    const controller = new AbortController();
    setValue(undefined);
    setError("");
    const request = kind === "report" ? projectApi.getDouyinAnalysisReport(projectId, videoId, snapshot.id, controller.signal)
      : kind === "transcript" ? projectApi.getDouyinAnalysisTranscript(projectId, videoId, snapshot.id, controller.signal)
      : kind === "frames" ? projectApi.getDouyinAnalysisFrames(projectId, videoId, snapshot.id, controller.signal)
      : projectApi.getDouyinAnalysisComments(projectId, videoId, snapshot.id, page, controller.signal);
    request.then((result) => {
      setValue("report" in result ? result.report : "transcript" in result ? result.transcript : result.items);
      setTotal("total" in result && typeof result.total === "number" ? result.total : 0);
    }).catch((cause: Error) => { if (cause.name !== "AbortError") setError(cause.message); });
    return () => controller.abort();
  }, [kind, page, projectId, snapshot.id, videoId]);

  return <Dialog open={kind !== null} onOpenChange={(open) => { if (!open) onClose(); }}>
    <DialogContent showCloseButton={false} onOpenAutoFocus={(event) => { event.preventDefault(); closeRef.current?.focus(); }} onCloseAutoFocus={(event) => {
      event.preventDefault(); if (returnFocusRef.current?.isConnected) returnFocusRef.current.focus();
    }}>
      <DialogHeader><DialogTitle>{kind ? TITLES[kind] : "分析详情"}</DialogTitle><DialogDescription>当前分析快照 <span className="break-all font-mono">{snapshot.id}</span>。这里仅展示当前分析项的冻结内容，不会把关键帧自动加入成片。</DialogDescription></DialogHeader>
      <div className="min-w-0 p-5 sm:p-6">
        {error ? <p role="alert" className="text-sm text-[var(--danger)]">详情读取失败：{error}。已完成证据仍然保留，可关闭后重试。</p>
          : kind !== "metadata" && value === undefined ? <p role="status" className="flex items-center gap-2 text-sm text-[var(--fg-secondary)]"><LoaderCircleIcon className="size-4 animate-spin" aria-hidden="true" />正在读取冻结详情…</p>
            : kind ? <div className="max-h-[55dvh] overflow-y-auto pr-1"><DouyinDetailContent kind={kind} value={value} snapshot={snapshot} /></div> : null}
      </div>
      <DialogFooter>
        {kind === "comments" && total > 10 ? <div className="mr-auto flex items-center gap-2"><Button type="button" variant="outline" disabled={page === 1} onClick={() => setPage((current) => current - 1)}><ChevronLeftIcon aria-hidden="true" />上一页</Button><span className="text-sm text-[var(--fg-secondary)]">第 {page} 页</span><Button type="button" variant="outline" disabled={page * 10 >= total} onClick={() => setPage((current) => current + 1)}>下一页<ChevronRightIcon aria-hidden="true" /></Button></div> : null}
        <DialogClose asChild><Button ref={closeRef} type="button" variant="outline">关闭详情</Button></DialogClose>
      </DialogFooter>
    </DialogContent>
  </Dialog>;
}
