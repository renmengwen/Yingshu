import { useCallback, useEffect, useRef, useState } from "react";

import { CHAPTER_PAGE_SIZE, chapterPagePath, responseJson } from "../../client-logic";
import type { EpisodeDurationPolicy } from "../episode/episode-editor";
import type { Chapter } from "../types";
import { pipelineIsTerminal, type PipelineCreateInput, type SeriesPipelineRun } from "./pipeline-logic";

type PipelineAction = "create" | "pause" | "resume" | "retry" | "cancel";

async function readAllChapters(bookId: string, signal: AbortSignal) {
  const first = await responseJson<{ items: Chapter[]; total: number }>(
    await fetch(chapterPagePath(bookId, 0), { signal }),
  );
  const offsets = Array.from(
    { length: Math.max(0, Math.ceil(first.total / CHAPTER_PAGE_SIZE) - 1) },
    (_, index) => (index + 1) * CHAPTER_PAGE_SIZE,
  );
  const pages = await Promise.all(offsets.map(async (offset) =>
    responseJson<{ items: Chapter[]; total: number }>(await fetch(chapterPagePath(bookId, offset), { signal })),
  ));
  const chapters = [first.items, ...pages.map((page) => page.items)].flat()
    .sort((left, right) => left.chapter_index - right.chapter_index);
  if (chapters.length !== first.total) throw new Error(`章节分页读取不完整：已读取 ${chapters.length}/${first.total} 章`);
  return { chapters, total: first.total };
}

export async function readInitialRun(seriesId: string, runId: string | undefined, signal: AbortSignal) {
  if (runId) {
    const response = await fetch(`/api/pipeline-runs/${encodeURIComponent(runId)}`, { signal });
    if (response.ok) {
      const candidate = (await responseJson<{ run: SeriesPipelineRun }>(response)).run;
      if (candidate.seriesProjectId === seriesId) return candidate;
    } else if (response.status !== 404) await responseJson(response);
  }
  const response = await fetch(`/api/series/${encodeURIComponent(seriesId)}/pipeline-runs/current`, { signal });
  if (response.status === 404) return undefined;
  const current = (await responseJson<{ run: SeriesPipelineRun }>(response)).run;
  if (current.seriesProjectId !== seriesId) throw new Error("服务端返回的全本改写任务不属于当前系列");
  return current;
}

async function readPolicy(signal: AbortSignal) {
  return responseJson<{ duration: EpisodeDurationPolicy }>(await fetch("/api/episode-policy", { signal }));
}

export function useSeriesPipeline({ bookId, seriesId, initialRunId, onRunIdChange }: {
  bookId: string;
  seriesId: string;
  initialRunId?: string;
  onRunIdChange: (runId?: string) => void;
}) {
  const [chapters, setChapters] = useState<Chapter[]>([]);
  const [chapterTotal, setChapterTotal] = useState(0);
  const [policy, setPolicy] = useState<EpisodeDurationPolicy>();
  const [run, setRun] = useState<SeriesPipelineRun>();
  const [loading, setLoading] = useState(true);
  const [busyAction, setBusyAction] = useState<PipelineAction>();
  const [operation, setOperation] = useState("正在恢复全本改写任务…");
  const [error, setError] = useState<string>();
  const actionRef = useRef<PipelineAction | undefined>(undefined);
  const currentSeriesRef = useRef(seriesId);
  currentSeriesRef.current = seriesId;
  const runIdChangeRef = useRef(onRunIdChange);
  runIdChangeRef.current = onRunIdChange;

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setRun(undefined);
    setError(undefined);
    setOperation("正在恢复全本改写任务…");
    Promise.all([
      readAllChapters(bookId, controller.signal),
      readPolicy(controller.signal),
      readInitialRun(seriesId, initialRunId, controller.signal),
    ]).then(([chapterPage, policyBody, restoredRun]) => {
      setChapters(chapterPage.chapters);
      setChapterTotal(chapterPage.total);
      setPolicy(policyBody.duration);
      setRun(restoredRun);
      if (restoredRun) runIdChangeRef.current(restoredRun.id);
      else if (initialRunId) runIdChangeRef.current(undefined);
      setOperation(restoredRun ? "已恢复全本改写任务。" : "全本改写设置已就绪。请确认范围、成片规格和分析速度。");
    }).catch((cause) => {
      if (cause instanceof DOMException && cause.name === "AbortError") return;
      const message = `全本改写任务加载失败：${(cause as Error).message}`;
      setError(message);
      setOperation(message);
    }).finally(() => {
      if (!controller.signal.aborted) setLoading(false);
    });
    return () => controller.abort();
  }, [bookId, seriesId]);

  useEffect(() => {
    if (!run || pipelineIsTerminal(run)) return;
    let cancelled = false;
    let timer: number | undefined;
    async function poll() {
      try {
        const body = await responseJson<{ run: SeriesPipelineRun }>(
          await fetch(`/api/pipeline-runs/${encodeURIComponent(run!.id)}`),
        );
        if (body.run.seriesProjectId !== seriesId) throw new Error("全本改写任务与当前系列不匹配");
        if (!cancelled) {
          setRun(body.run);
          setError(undefined);
        }
      } catch (cause) {
        if (!cancelled) setError(`全本改写进度刷新失败：${(cause as Error).message}`);
      }
      if (!cancelled) timer = window.setTimeout(poll, 3000);
    }
    timer = window.setTimeout(poll, 3000);
    return () => {
      cancelled = true;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [run?.id, run?.status, seriesId]);

  const perform = useCallback(async (action: PipelineAction, request: () => Promise<Response>) => {
    if (actionRef.current) return;
    const expectedSeriesId = currentSeriesRef.current;
    actionRef.current = action;
    setBusyAction(action);
    setError(undefined);
    const loadingText = action === "create" ? "正在创建全本改写任务…"
      : action === "pause" ? "正在暂停当前任务…"
      : action === "resume" ? "正在继续全本改写任务…"
      : action === "retry" ? "正在重新排队失败章节…"
      : "正在取消全本改写任务…";
    setOperation(loadingText);
    try {
      const body = await responseJson<{ message: string; run: SeriesPipelineRun }>(await request());
      if (currentSeriesRef.current !== expectedSeriesId) return;
      if (body.run.seriesProjectId !== expectedSeriesId) throw new Error("全本改写任务与当前系列不匹配");
      setRun(body.run);
      runIdChangeRef.current(body.run.id);
      setOperation(body.message);
    } catch (cause) {
      if (currentSeriesRef.current !== expectedSeriesId) return;
      const actionText = action === "create" ? "创建全本改写任务" : action === "pause" ? "暂停任务"
        : action === "resume" ? "继续任务" : action === "retry" ? "重试失败章节" : "取消任务";
      const message = `${actionText}失败：${(cause as Error).message}`;
      setError(message);
      setOperation(message);
    } finally {
      actionRef.current = undefined;
      setBusyAction(undefined);
    }
  }, []);

  const create = useCallback((input: PipelineCreateInput) => perform("create", () => fetch(
    `/api/series/${encodeURIComponent(seriesId)}/pipeline-runs`,
    { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(input) },
  )), [perform, seriesId]);

  const control = useCallback((action: Exclude<PipelineAction, "create">) => {
    if (!run || run.seriesProjectId !== currentSeriesRef.current) return Promise.resolve();
    return perform(action, () => fetch(`/api/pipeline-runs/${encodeURIComponent(run.id)}/${action}`, { method: "POST" }));
  }, [perform, run]);

  const resetTerminal = useCallback(() => {
    if (!run || !pipelineIsTerminal(run) || actionRef.current) return;
    setRun(undefined);
    setError(undefined);
    setOperation("全本改写设置已就绪。请确认范围、成片规格和分析速度。");
    runIdChangeRef.current(undefined);
  }, [run]);

  return {
    chapters, chapterTotal, policy, run, loading, busyAction, operation, error,
    create, control, resetTerminal,
  };
}
