import { useCallback, useEffect, useRef, useState } from "react";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "./components/ui/alert-dialog";

import { chapterPagePath, responseJson } from "./client-logic";
import {
  isTerminalJobStatus,
  mergeProductionWorkspaceLocation,
  productionWorkspaceFromSearch,
  productionWorkspacePath,
  PRODUCTION_STAGES,
  resolveProductionStage,
  resolveExportStageIdentity,
  updateWorkspaceStatusLayer,
  usesChapterWorkspaceStatus,
  type WorkspaceStatusLayers,
  type ProductionStageId,
} from "./production-logic";
import { AssetStage } from "./production/assets/AssetStage";
import { AudioStage } from "./production/audio/AudioStage";
import { chapterAnalysisJobPayload, chapterEventsJobPayload, remainingChapterEventPageOffsets, type ChapterEventDraft } from "./production/chapter-event-editor";
import { ChapterEventsStage } from "./production/ChapterEventsStage";
import { EpisodeStage } from "./production/episode/EpisodeStage";
import { EpisodeNavigation } from "./production/episode-navigation/EpisodeNavigation";
import { readEpisodeNavigation } from "./production/episode-navigation/episode-navigation-client";
import { ExportStage } from "./production/export/ExportStage";
import { PipelineProgress } from "./production/pipeline/PipelineProgress";
import { PipelineSetup } from "./production/pipeline/PipelineSetup";
import { pipelineChapterEventsReadOnly } from "./production/pipeline/pipeline-logic";
import { useSeriesPipeline } from "./production/pipeline/use-series-pipeline";
import { ProductionHeader } from "./production/ProductionHeader";
import { ProductionStatus } from "./production/ProductionStatus";
import { ScriptStage } from "./production/scripts/ScriptStage";
import { StageNavigation } from "./production/StageNavigation";
import type { Chapter, ChapterEvent, Episode, JobRecord, SeriesProject } from "./production/types";
import { useJobPolling } from "./production/use-job-polling";
import { VisualStage } from "./production/visual/VisualStage";

export function ProductionWorkspace({ bookId, series, initialStatus, onLeave, onOpenSettings }: { bookId: string; series: SeriesProject; initialStatus: string; onLeave: () => void; onOpenSettings: () => void }) {
  const restored = productionWorkspaceFromSearch(window.location.search);
  const [stage, setStage] = useState<ProductionStageId>(() => resolveProductionStage(restored?.stage));
  const [chapters, setChapters] = useState<Chapter[]>([]);
  const [chapterTotal, setChapterTotal] = useState(0);
  const [selectedChapter, setSelectedChapter] = useState(restored?.chapterId);
  const [episodeIndex, setEpisodeIndex] = useState(restored?.episodeIndex ?? 1);
  const [selectedAssetId, setSelectedAssetId] = useState(restored?.assetId);
  const [timelineHash, setTimelineHash] = useState(restored?.timelineHash);
  const [chapterText, setChapterText] = useState("");
  const [events, setEvents] = useState<ChapterEvent[]>([]);
  const [statusLayers, setStatusLayers] = useState<WorkspaceStatusLayers>({ operation: initialStatus });
  const [busy, setBusy] = useState(false);
  const [jobId, setJobId] = useState(restored?.jobId);
  const [pipelineRunId, setPipelineRunId] = useState(restored?.pipelineRunId);
  const [exportEpisodeId, setExportEpisodeId] = useState<string>();
  const [episodeNavigation, setEpisodeNavigation] = useState<{ state: "loading" | "ready" | "failed"; episodes: Episode[] }>({ state: "loading", episodes: [] });
  const [scriptDraftDirty, setScriptDraftDirty] = useState(false);
  const [pendingNavigation, setPendingNavigation] = useState<{ description: string; commit: () => void }>();
  const currentStage = useRef(stage);
  currentStage.current = stage;
  const setWorkspaceStatus = useCallback((message: string) => {
    setStatusLayers((current) => updateWorkspaceStatusLayer(current, message));
  }, []);
  const dismissPersistentError = useCallback(() => {
    setStatusLayers((current) => ({ ...current, persistentError: undefined }));
  }, []);
  const job = useJobPolling(jobId, setWorkspaceStatus);
  const currentJob = job?.id === jobId ? job : undefined;
  const completedChapterJobId = (currentJob?.type === "chapter_events_replace" || currentJob?.type === "chapter_events_analyze") && currentJob.status === "succeeded" ? currentJob.id : undefined;
  const jobActive = !!jobId && (!currentJob || !isTerminalJobStatus(currentJob.status));
  const selectedChapterRecord = chapters.find((chapter) => chapter.id === selectedChapter);

  const replaceLocation = useCallback((next: { stage?: ProductionStageId; chapterId?: string; episodeIndex?: number; assetId?: string; timelineHash?: string; jobId?: string; pipelineRunId?: string }) => {
    const location = mergeProductionWorkspaceLocation({ stage, chapterId: selectedChapter, episodeIndex, assetId: selectedAssetId, timelineHash, jobId, pipelineRunId }, next);
    window.history.replaceState(null, "", productionWorkspacePath({ bookId, seriesId: series.id, ...location }));
  }, [bookId, episodeIndex, jobId, pipelineRunId, selectedAssetId, selectedChapter, series.id, stage, timelineHash]);

  const changePipelineRun = useCallback((id?: string) => {
    setPipelineRunId(id);
    replaceLocation({ pipelineRunId: id });
  }, [replaceLocation]);
  const pipeline = useSeriesPipeline({
    bookId,
    seriesId: series.id,
    initialRunId: pipelineRunId,
    onRunIdChange: changePipelineRun,
  });
  const chapterEventsReadOnly = pipelineChapterEventsReadOnly(pipeline.run);
  useEffect(() => {
    if (!scriptDraftDirty) return;
    const handler = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [scriptDraftDirty]);

  useEffect(() => {
    const controller = new AbortController();
    setEpisodeNavigation({ state: "loading", episodes: [] });
    void readEpisodeNavigation(series.id, controller.signal).then((episodes) => {
      setEpisodeNavigation({ state: "ready", episodes });
      if (episodes.length && !episodes.some((episode) => episode.index === episodeIndex)) commitEpisode(episodes[0]!.index);
    }).catch((error) => {
      if (error instanceof DOMException && error.name === "AbortError") return;
      setEpisodeNavigation({ state: "failed", episodes: [] });
      setWorkspaceStatus(`分集列表加载失败：${(error as Error).message}`);
    });
    return () => controller.abort();
  }, [series.id, pipeline.run?.status]);

  useEffect(() => {
    let cancelled = false;
    async function loadChapters() {
      if (usesChapterWorkspaceStatus(currentStage.current)) { setBusy(true); setWorkspaceStatus("正在加载章节工作区…"); }
      try {
        const body = await responseJson<{ items: Chapter[]; total: number }>(await fetch(chapterPagePath(bookId, 0)));
        if (!cancelled) { setChapters(body.items); setChapterTotal(body.total); if (usesChapterWorkspaceStatus(currentStage.current)) setWorkspaceStatus(`章节工作区已就绪，共 ${body.total} 章`); }
      } catch (error) { if (!cancelled && usesChapterWorkspaceStatus(currentStage.current)) setWorkspaceStatus(`章节工作区加载失败：${(error as Error).message}`); }
      finally { if (!cancelled && usesChapterWorkspaceStatus(currentStage.current)) setBusy(false); }
    }
    void loadChapters(); return () => { cancelled = true; };
  }, [bookId]);

  useEffect(() => {
    if (!selectedChapter || !selectedChapterRecord) return;
    let cancelled = false;
    async function loadChapter() {
      if (usesChapterWorkspaceStatus(currentStage.current)) { setBusy(true); setWorkspaceStatus("正在读取原文与结构化事件…"); }
      try {
        const [textBody, firstEventsBody] = await Promise.all([
          responseJson<{ text: string }>(await fetch(`/api/books/${encodeURIComponent(bookId)}/chapters/${encodeURIComponent(selectedChapter!)}/text`)),
          responseJson<{ items: ChapterEvent[]; total: number }>(await fetch(`/api/books/${encodeURIComponent(bookId)}/chapters/${encodeURIComponent(selectedChapter!)}/events?limit=100&offset=0`)),
        ]);
        const remainingPages = await Promise.all(remainingChapterEventPageOffsets(firstEventsBody.total, firstEventsBody.items.length).map(async (offset) =>
          responseJson<{ items: ChapterEvent[]; total: number }>(await fetch(`/api/books/${encodeURIComponent(bookId)}/chapters/${encodeURIComponent(selectedChapter!)}/events?limit=100&offset=${offset}`)),
        ));
        const loadedEvents = [firstEventsBody.items, ...remainingPages.map((page) => page.items)].flat();
        if (loadedEvents.length !== firstEventsBody.total) throw new Error("章节事件分页读取不完整，请刷新后重试");
        if (!cancelled) { setChapterText(textBody.text); setEvents(loadedEvents); if (usesChapterWorkspaceStatus(currentStage.current)) setWorkspaceStatus(firstEventsBody.total ? `已加载 ${firstEventsBody.total} 个结构化事件` : "本章尚未生成结构化事件"); }
      } catch (error) { if (!cancelled && usesChapterWorkspaceStatus(currentStage.current)) setWorkspaceStatus(`章节证据加载失败：${(error as Error).message}`); }
      finally { if (!cancelled && usesChapterWorkspaceStatus(currentStage.current)) setBusy(false); }
    }
    void loadChapter(); return () => { cancelled = true; };
  }, [bookId, completedChapterJobId, selectedChapter, selectedChapterRecord]);

  useEffect(() => {
    setExportEpisodeId(undefined);
    if (stage !== "export") return;
    const expected = `${series.id}:${episodeIndex}`;
    let cancelled = false;
    async function loadExportEpisode() {
      try {
        const response = await fetch(`/api/series/${encodeURIComponent(series.id)}/episodes/${episodeIndex}`);
        if (response.status === 404) {
          if (!cancelled) setWorkspaceStatus(`第 ${episodeIndex} 集尚未创建，审核与导出已阻断`);
          return;
        }
        const episode = (await responseJson<{ episode: Episode }>(response)).episode;
        if (episode.seriesProjectId !== series.id || episode.index !== episodeIndex) throw new Error("分集身份与当前工作区不一致");
        if (!cancelled && expected === `${series.id}:${episodeIndex}`) setExportEpisodeId(episode.id);
      } catch (error) {
        if (!cancelled) setWorkspaceStatus(`导出分集加载失败：${(error as Error).message}`);
      }
    }
    void loadExportEpisode();
    return () => { cancelled = true; };
  }, [episodeIndex, series.id, stage]);

  async function saveChapterEvents(drafts: ChapterEventDraft[]) {
    if (!selectedChapterRecord || busy || jobActive) return;
    setBusy(true); setWorkspaceStatus("正在创建章节事件持久任务…");
    try {
      const payload = chapterEventsJobPayload(bookId, selectedChapterRecord, drafts);
      const body = await responseJson<{ message: string; job: JobRecord }>(await fetch("/api/jobs", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ type: "chapter_events_replace", payload }),
      }));
      setJobId(body.job.id); replaceLocation({ jobId: body.job.id }); setWorkspaceStatus(body.message);
    } catch (error) { setWorkspaceStatus(`章节事件保存失败：${(error as Error).message}`); }
    finally { setBusy(false); }
  }

  async function analyzeChapterEvents() {
    if (!selectedChapterRecord || busy || jobActive) return;
    setBusy(true); setWorkspaceStatus("正在创建章节自动分析任务…");
    try {
      const body = await responseJson<{ message: string; job: JobRecord }>(await fetch("/api/jobs", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ type: "chapter_events_analyze", payload: chapterAnalysisJobPayload(bookId, selectedChapterRecord) }),
      }));
      setJobId(body.job.id); replaceLocation({ jobId: body.job.id }); setWorkspaceStatus(body.message);
    } catch (error) { const message = (error as Error).message; setWorkspaceStatus(`章节自动分析失败：${message}${message.includes("人工事件入口") ? "" : "；仍可使用人工事件入口"}`); }
    finally { setBusy(false); }
  }

  async function cancelJob() {
    if (!jobId || !currentJob || isTerminalJobStatus(currentJob.status) || busy) return;
    setBusy(true); setWorkspaceStatus("正在请求取消任务…");
    try {
      const body = await responseJson<{ message: string; job: JobRecord }>(await fetch(`/api/jobs/${encodeURIComponent(jobId)}/cancel`, { method: "POST" }));
      setWorkspaceStatus(body.message);
      if (isTerminalJobStatus(body.job.status)) { setJobId(undefined); replaceLocation({ jobId: undefined }); }
    } catch (error) { setWorkspaceStatus(`取消任务失败：${(error as Error).message}`); }
    finally { setBusy(false); }
  }

  function requestNavigation(description: string, commit: () => void) {
    if (scriptDraftDirty) { setPendingNavigation({ description, commit }); return; }
    commit();
  }
  function commitStage(next: ProductionStageId) { setStage(next); replaceLocation({ stage: next }); setWorkspaceStatus(`已切换到「${PRODUCTION_STAGES.find((item) => item.id === next)!.label}」`); }
  function selectStage(next: ProductionStageId) {
    if (next === stage) return;
    requestNavigation(`切换到「${PRODUCTION_STAGES.find((item) => item.id === next)!.label}」会丢弃当前未保存稿件。`, () => commitStage(next));
  }
  function selectChapter(id: string) {
    if (id === selectedChapter) return;
    setBusy(true); setSelectedChapter(id); setChapterText(""); setEvents([]); setJobId(undefined); replaceLocation({ chapterId: id, jobId: undefined });
  }
  function selectAsset(id: string | undefined) { setSelectedAssetId(id); replaceLocation({ assetId: id }); }
  function commitEpisode(index: number) { setEpisodeIndex(index); setTimelineHash(undefined); setJobId(undefined); replaceLocation({ episodeIndex: index, timelineHash: undefined, jobId: undefined }); }
  function selectEpisode(index: number) {
    if (index === episodeIndex || !episodeNavigation.episodes.some((episode) => episode.index === index)) return;
    requestNavigation(`切换到第 ${index} 集会丢弃当前未保存稿件。`, () => commitEpisode(index));
  }
  function selectTimeline(hash: string | undefined) { setTimelineHash(hash); replaceLocation({ timelineHash: hash }); }
  function trackJob(id?: string) { setJobId(id); replaceLocation({ jobId: id }); }

  return <main className="min-h-screen bg-[var(--bg-canvas)] p-4 text-[var(--fg-primary)] max-md:p-0">
    <div className="mx-auto min-h-[calc(100vh-32px)] w-full max-w-[1640px] border border-[var(--border-subtle)] bg-[var(--bg-surface)] shadow-[var(--shadow)] max-md:min-h-screen max-md:border-0">
      <ProductionHeader series={series} onLeave={() => requestNavigation("离开制作工作区会丢弃当前未保存稿件。", onLeave)} onOpenSettings={() => requestNavigation("打开设置会丢弃当前未保存稿件。", onOpenSettings)} />
      <ProductionStatus operation={statusLayers.operation} persistentError={statusLayers.persistentError} busy={busy} job={currentJob} onDismissError={dismissPersistentError} onCancel={() => void cancelJob()} />
      {pipeline.run ? <PipelineProgress run={pipeline.run} chapters={pipeline.chapters} busyAction={pipeline.busyAction} operation={pipeline.operation} error={pipeline.error} onControl={(action) => void pipeline.control(action)} onReset={pipeline.resetTerminal} />
        : <PipelineSetup bookId={bookId} seriesId={series.id} chapters={pipeline.chapters} chapterTotal={pipeline.chapterTotal} policy={pipeline.policy} loading={pipeline.loading} submitting={pipeline.busyAction === "create"} operation={pipeline.operation} error={pipeline.error} onCreate={(input) => void pipeline.create(input)} />}
      <StageNavigation stage={stage} onChange={selectStage} />
      <EpisodeNavigation current={episodeIndex} episodes={episodeNavigation.episodes} state={episodeNavigation.state} disabled={busy} onChange={selectEpisode} />
      {stage === "events" ? <ChapterEventsStage chapters={chapters} total={chapterTotal} selected={selectedChapterRecord} text={chapterText} events={events} locked={busy || jobActive} readOnly={chapterEventsReadOnly} onSelect={selectChapter} onSave={(drafts) => void saveChapterEvents(drafts)} onAnalyze={() => void analyzeChapterEvents()} /> : stage === "episode" ? <EpisodeStage bookId={bookId} seriesId={series.id} episodeIndex={episodeIndex} chapters={chapters} startChapterId={selectedChapter} currentJob={currentJob} busy={busy} setBusy={setBusy} setStatus={setWorkspaceStatus} onStartChapterChange={(id) => id ? selectChapter(id) : (setSelectedChapter(undefined), setJobId(undefined), replaceLocation({ chapterId: undefined, jobId: undefined }))} onJobCreated={trackJob} onOpenScripts={() => selectStage("scripts")} /> : stage === "scripts" ? <ScriptStage seriesId={series.id} episodeIndex={episodeIndex} busy={busy} jobActive={jobActive} currentJob={currentJob} setBusy={setBusy} setStatus={setWorkspaceStatus} onDraftDirtyChange={setScriptDraftDirty} onJobCreated={trackJob} /> : stage === "assets" ? <AssetStage seriesId={series.id} episodeIndex={episodeIndex} initialAssetId={selectedAssetId} busy={busy} currentJob={currentJob} setStatus={setWorkspaceStatus} onAssetChange={selectAsset} onJobCreated={trackJob} /> : stage === "audio" ? <AudioStage seriesId={series.id} episodeIndex={episodeIndex} timelineHash={timelineHash} busy={busy} jobActive={jobActive} currentJob={currentJob} setBusy={setBusy} setStatus={setWorkspaceStatus} onTimelineChange={selectTimeline} onJobCreated={trackJob} /> : stage === "visual" ? <VisualStage seriesId={series.id} episodeIndex={episodeIndex} timelineHash={timelineHash} externalBusy={busy} jobActive={jobActive} currentJob={currentJob} setBusy={setBusy} setStatus={setWorkspaceStatus} onTimelineChange={selectTimeline} onJobCreated={trackJob} /> : <ProductionExportStage episodeId={exportEpisodeId} timelineHash={timelineHash} jobId={jobId} onJobIdChange={trackJob} />}
    </div>
    <AlertDialog open={!!pendingNavigation} onOpenChange={(open) => { if (!open) setPendingNavigation(undefined); }}>
      <AlertDialogContent>
        <AlertDialogHeader><AlertDialogTitle>当前稿件尚未保存</AlertDialogTitle><AlertDialogDescription>{pendingNavigation?.description}取消会保留草稿，确认后继续。</AlertDialogDescription></AlertDialogHeader>
        <AlertDialogFooter><AlertDialogCancel>取消，保留草稿</AlertDialogCancel><AlertDialogAction onClick={() => { const commit = pendingNavigation?.commit; setPendingNavigation(undefined); commit?.(); }}>确认丢弃并继续</AlertDialogAction></AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  </main>;
}
export function ProductionExportStage({ episodeId, timelineHash, jobId, onJobIdChange }: {
  episodeId?: string;
  timelineHash?: string;
  jobId?: string;
  onJobIdChange: (jobId: string | undefined) => void;
}) {
  const identity = resolveExportStageIdentity(episodeId, timelineHash);
  if ("blocker" in identity) {
    return <section className="grid min-h-[320px] place-items-center p-6" role="alert">
      <div className="max-w-xl rounded-md border border-[var(--border-subtle)] bg-[var(--bg-subtle)] p-5">
        <h2 className="text-base font-semibold">审核与导出暂不可用</h2>
        <p className="mt-2 text-sm leading-7 text-[var(--fg-secondary)]">{identity.blocker}</p>
      </div>
    </section>;
  }
  return <ExportStage episodeId={identity.episodeId} timelineHash={identity.timelineHash} initialJobId={jobId} onJobIdChange={onJobIdChange} />;
}
