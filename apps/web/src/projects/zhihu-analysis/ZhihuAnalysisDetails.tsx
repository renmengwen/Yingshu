import { useEffect, useRef, useState, type RefObject } from "react";

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
import {
  ChevronLeftIcon,
  ChevronRightIcon,
  LoaderCircleIcon,
} from "lucide-react";
import { projectApi } from "../api";
import type { ZhihuDetailKind } from "./types";

const TITLES: Record<ZhihuDetailKind, string> = {
  answer: "知乎回答原文",
  comments: "评论样本与受众信号",
  report: "结构化分析报告",
};

export function ZhihuAnalysisDetails({
  projectId,
  videoId,
  snapshotId,
  kind,
  onClose,
  returnFocusRef,
}: {
  projectId: string;
  videoId: string;
  snapshotId: string;
  kind: ZhihuDetailKind | null;
  onClose: () => void;
  returnFocusRef: RefObject<HTMLButtonElement | null>;
}) {
  const [value, setValue] = useState<unknown>();
  const [error, setError] = useState("");
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  const closeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!kind) return;
    const controller = new AbortController();
    setValue(undefined);
    setError("");
    const request =
      kind === "answer"
        ? projectApi.getZhihuAnalysisAnswer(
            projectId,
            videoId,
            snapshotId,
            controller.signal,
          )
        : kind === "report"
          ? projectApi.getZhihuAnalysisReport(
              projectId,
              videoId,
              snapshotId,
              controller.signal,
            )
          : projectApi.getZhihuAnalysisComments(
              projectId,
              videoId,
              snapshotId,
              page,
              controller.signal,
            );
    request
      .then((result) => {
        setValue(
          "answer" in result
            ? result.answer
            : "report" in result
              ? result.report
              : result.items,
        );
        setTotal(
          "total" in result && typeof result.total === "number"
            ? result.total
            : 0,
        );
      })
      .catch((cause: Error) => {
        if (cause.name !== "AbortError") setError(cause.message);
      });
    return () => controller.abort();
  }, [kind, page, projectId, snapshotId, videoId]);

  return (
    <Dialog
      open={kind !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent
        showCloseButton={false}
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          closeRef.current?.focus();
        }}
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          if (returnFocusRef.current?.isConnected)
            returnFocusRef.current.focus();
        }}
      >
        <DialogHeader>
          <DialogTitle>{kind ? TITLES[kind] : "分析详情"}</DialogTitle>
          <DialogDescription>
            当前分析快照{" "}
            <span className="break-all font-mono">{snapshotId}</span>
            。回答原文是可追溯来源；评论固定仅作受众解读，不作为原文事实。
          </DialogDescription>
        </DialogHeader>
        <div className="min-w-0 p-5 sm:p-6">
          {error ? (
            <p role="alert" className="text-sm text-[var(--danger)]">
              详情读取失败：{error}。已完成证据仍然保留，可关闭后重试。
            </p>
          ) : value === undefined ? (
            <p
              role="status"
              className="flex items-center gap-2 text-sm text-[var(--fg-secondary)]"
            >
              <LoaderCircleIcon
                className="size-4 animate-spin"
                aria-hidden="true"
              />
              正在读取冻结详情…
            </p>
          ) : (
            <pre className="max-h-[55dvh] max-w-full overflow-auto whitespace-pre-wrap break-words rounded-md bg-[var(--surface-inset)] p-4 font-mono text-xs leading-6">
              {JSON.stringify(value, null, 2)}
            </pre>
          )}
        </div>
        <DialogFooter>
          {kind === "comments" && total > 10 ? (
            <div className="mr-auto flex items-center gap-2">
              <Button
                type="button"
                variant="outline"
                disabled={page === 1}
                onClick={() => setPage((current) => current - 1)}
              >
                <ChevronLeftIcon aria-hidden="true" />
                上一页
              </Button>
              <span className="text-sm text-[var(--fg-secondary)]">
                第 {page} 页
              </span>
              <Button
                type="button"
                variant="outline"
                disabled={page * 10 >= total}
                onClick={() => setPage((current) => current + 1)}
              >
                下一页
                <ChevronRightIcon aria-hidden="true" />
              </Button>
            </div>
          ) : null}
          <DialogClose asChild>
            <Button ref={closeRef} type="button" variant="outline">
              关闭详情
            </Button>
          </DialogClose>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
