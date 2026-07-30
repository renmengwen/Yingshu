import { useEffect, useLayoutEffect, useRef, useState } from "react";

import { responseJson } from "../../client-logic";
import { activeModelLabel, loadModelConfig, type ModelConfig } from "../../settings/model-settings";
import type {
  Episode, JobRecord, ScriptApproval, TtsCalibrationWorkspace, TtsTimeline, TtsTimelineSummary,
} from "../types";
import {
  completedTtsCalibrationMode, completedTtsTimelineHash, listeningIdentityKey, listeningReviewPayload,
  listeningReviewUrl, parseListeningReviewWorkspace, ttsTimelinePayload, type TtsListeningReviewWorkspace,
} from "./audio-editor";

export function useAudioWorkspace({ seriesId, episodeIndex, timelineHash, currentJob, jobActive, setBusy, setStatus, onTimelineChange, onJobCreated }: {
  seriesId: string; episodeIndex: number; timelineHash?: string; currentJob?: JobRecord; jobActive: boolean;
  setBusy: (busy: boolean) => void; setStatus: (message: string) => void;
  onTimelineChange: (hash: string | undefined) => void; onJobCreated: (id: string) => void;
}) {
  const [episode, setEpisode] = useState<Episode>();
  const [approval, setApproval] = useState<ScriptApproval>();
  const [timeline, setTimeline] = useState<TtsTimeline>();
  const [calibration, setCalibration] = useState<TtsCalibrationWorkspace>();
  const [voice, setVoice] = useState("Microsoft Huihui Desktop");
  const [rate, setRate] = useState(0);
  const [modelConfig, setModelConfig] = useState<ModelConfig>();
  const [modelConfigError, setModelConfigError] = useState("");
  const [listeningWorkspace, setListeningWorkspace] = useState<TtsListeningReviewWorkspace>();
  const [checkedListeningSegments, setCheckedListeningSegments] = useState<Set<number>>(new Set());
  const [checkedProperNouns, setCheckedProperNouns] = useState<Set<string>>(new Set());
  const [listeningNotes, setListeningNotes] = useState("");
  const [listeningStatus, setListeningStatus] = useState<"idle" | "loading" | "success" | "failure" | "interrupted">("idle");
  const [listeningMessage, setListeningMessage] = useState("语音时间轴生成后可开始人工听审。");
  const [listeningRefresh, setListeningRefresh] = useState(0);
  const mounted = useRef(true);
  const writing = useRef(false);
  const reviewing = useRef(false);
  const reviewJobId = useRef("");
  const listeningIdentity = useRef("");
  const listeningRequest = useRef(0);
  const routeKey = `${seriesId}:${episodeIndex}:${timelineHash ?? ""}`;
  const currentRoute = useRef(routeKey);
  useLayoutEffect(() => {
    mounted.current = true;
    currentRoute.current = routeKey;
    return () => {
      if (currentRoute.current !== routeKey) return;
      mounted.current = false;
      currentRoute.current = "";
    };
  }, [routeKey]);

  async function readTimeline(episodeId: string, hash: string) {
    return (await responseJson<{ timeline: TtsTimeline }>(await fetch(
      `/api/episodes/${encodeURIComponent(episodeId)}/tts-timelines/${encodeURIComponent(hash)}`,
    ))).timeline;
  }

  async function readCalibration(episodeId: string) {
    return (await responseJson<{ calibration: TtsCalibrationWorkspace }>(await fetch(
      `/api/episodes/${encodeURIComponent(episodeId)}/tts-calibration`,
    ))).calibration;
  }

  useEffect(() => {
    let cancelled = false;
    loadModelConfig()
      .then((config) => {
        if (cancelled) return;
        setModelConfig(config);
        setModelConfigError("");
        const [providerId] = (config.active.tts ?? "").split("/");
        const model = providerId ? config.providers[providerId]?.models.tts : undefined;
        if (model?.voiceId) setVoice(model.voiceId);
      })
      .catch((error: Error) => {
        if (!cancelled) setModelConfigError(error.message);
      });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    const expectedRoute = routeKey;
    setEpisode(undefined); setApproval(undefined); setTimeline(undefined); setCalibration(undefined);
    setBusy(true); setStatus(`正在恢复第 ${episodeIndex} 集语音时间轴…`);
    const baseUrl = `/api/series/${encodeURIComponent(seriesId)}/episodes/${episodeIndex}`;
    void (async () => {
      const episodeResponse = await fetch(baseUrl);
      if (episodeResponse.status === 404) return { episode: undefined, approval: undefined, timeline: undefined, calibration: undefined };
      const restoredEpisode = (await responseJson<{ episode: Episode }>(episodeResponse)).episode;
      const restoredApproval = (await responseJson<{ approval: ScriptApproval }>(await fetch(`${baseUrl}/approval`))).approval;
      let hash = timelineHash;
      if (!hash) {
        const summaries = (await responseJson<{ items: TtsTimelineSummary[] }>(await fetch(
          `/api/episodes/${encodeURIComponent(restoredEpisode.id)}/tts-timelines`,
        ))).items;
        hash = summaries[0]?.timelineHash;
        if (hash && mounted.current && currentRoute.current === expectedRoute) onTimelineChange(hash);
      }
      return {
        episode: restoredEpisode,
        approval: restoredApproval,
        timeline: hash ? await readTimeline(restoredEpisode.id, hash) : undefined,
        calibration: restoredApproval.status === "approved" ? await readCalibration(restoredEpisode.id) : undefined,
      };
    })().then((snapshot) => {
      if (!mounted.current || currentRoute.current !== expectedRoute) return;
      setEpisode(snapshot.episode); setApproval(snapshot.approval); setTimeline(snapshot.timeline); setCalibration(snapshot.calibration);
      if (snapshot.calibration?.selection) {
        setVoice(snapshot.calibration.selection.voice);
        setRate(snapshot.calibration.selection.rate);
      }
      setStatus(!snapshot.episode ? `第 ${episodeIndex} 集尚未创建` : snapshot.timeline
        ? `第 ${episodeIndex} 集语音时间轴已从持久层恢复`
        : snapshot.approval?.status === "approved" ? "当前批准稿尚未生成语音时间轴" : "当前分集没有已批准的成片旁白稿");
    }).catch((error) => {
      if (mounted.current && currentRoute.current === expectedRoute) setStatus(`语音工作区恢复失败：${(error as Error).message}`);
    }).finally(() => {
      if (mounted.current && currentRoute.current === expectedRoute) setBusy(false);
    });
  }, [seriesId, episodeIndex, timelineHash]);

  useEffect(() => {
    if (!episode || !completedTtsCalibrationMode(currentJob, episode.id)) return;
    const expectedRoute = routeKey;
    setBusy(true); setStatus("短样校准任务已完成，正在回读持久选择…");
    void readCalibration(episode.id).then((restored) => {
      if (!mounted.current || currentRoute.current !== expectedRoute) return;
      setCalibration(restored);
      if (restored.selection) { setVoice(restored.selection.voice); setRate(restored.selection.rate); }
      setStatus(restored.selection ? "已恢复当前实测短样选择" : `已生成 ${restored.samples.length} 个真实短样，请试听后选择`);
    }).catch((error) => {
      if (mounted.current && currentRoute.current === expectedRoute) setStatus(`短样校准回读失败：${(error as Error).message}`);
    }).finally(() => {
      if (mounted.current && currentRoute.current === expectedRoute) setBusy(false);
    });
  }, [currentJob?.id, currentJob?.status, episode?.id]);

  useEffect(() => {
    if (!episode) return;
    const hash = completedTtsTimelineHash(currentJob, episode.id);
    if (!hash || hash === timeline?.timelineHash) return;
    const expectedRoute = routeKey;
    setBusy(true); setStatus("语音任务已完成，正在回读持久化时间轴…");
    void readTimeline(episode.id, hash).then((restored) => {
      if (!mounted.current || currentRoute.current !== expectedRoute) return;
      setTimeline(restored); onTimelineChange(hash); setStatus("语音时间轴已生成并从持久层回读");
    }).catch((error) => {
      if (mounted.current && currentRoute.current === expectedRoute) setStatus(`语音时间轴回读失败：${(error as Error).message}`);
    }).finally(() => {
      if (mounted.current && currentRoute.current === expectedRoute) setBusy(false);
    });
  }, [currentJob, episode, timeline?.timelineHash]);

  useEffect(() => {
    const expectedRoute = routeKey;
    const expectedTimeline = timeline;
    const request = ++listeningRequest.current;
    listeningIdentity.current = "";
    setListeningWorkspace(undefined);
    setCheckedListeningSegments(new Set());
    setCheckedProperNouns(new Set());
    setListeningNotes("");
    if (!expectedTimeline) {
      setListeningStatus("idle");
      setListeningMessage("语音时间轴生成后可开始人工听审。");
      return;
    }
    setListeningStatus("loading");
    setListeningMessage("正在读取当前语音时间轴的人工听审清单…");
    void fetch(listeningReviewUrl(expectedTimeline.episodeId, expectedTimeline.timelineHash))
      .then((response) => responseJson<unknown>(response))
      .then((body) => parseListeningReviewWorkspace(body, {
        episodeId: expectedTimeline.episodeId, timelineHash: expectedTimeline.timelineHash,
      }))
      .then((workspace) => {
        if (!mounted.current || currentRoute.current !== expectedRoute || listeningRequest.current !== request) return;
        listeningIdentity.current = listeningIdentityKey(workspace.identity);
        setListeningWorkspace(workspace);
        setCheckedListeningSegments(new Set(workspace.latestReview?.checkedSegmentIndexes ?? []));
        setCheckedProperNouns(new Set(workspace.latestReview?.checkedProperNouns ?? []));
        setListeningNotes(workspace.latestReview?.notes ?? "");
        setListeningStatus("success");
        setListeningMessage(workspace.latestReview
          ? `已恢复当前身份的${workspace.latestReview.action === "approve" ? "通过" : "不通过"}听审记录。`
          : `待人工核对 ${workspace.requiredSegmentIndexes.length} 个必听片段和 ${workspace.requiredProperNouns.length} 个专名。`);
      })
      .catch((error) => {
        if (!mounted.current || currentRoute.current !== expectedRoute || listeningRequest.current !== request) return;
        setListeningStatus("failure");
        setListeningMessage(`人工听审清单读取失败：${(error as Error).message}`);
      });
  }, [listeningRefresh, routeKey, timeline]);

  useEffect(() => {
    if (!reviewJobId.current || currentJob?.id !== reviewJobId.current ||
        (currentJob.status !== "succeeded" && currentJob.status !== "failed" && currentJob.status !== "cancelled")) return;
    reviewJobId.current = "";
    if (currentJob.status === "succeeded") setListeningRefresh((value) => value + 1);
    else {
      setListeningStatus(currentJob.status === "cancelled" ? "interrupted" : "failure");
      setListeningMessage(currentJob.status === "cancelled"
        ? "人工听审提交已中断，当前勾选仍保留。"
        : `人工听审提交失败：${currentJob.errorMessage ?? "未提供错误详情"}`);
    }
  }, [currentJob?.id, currentJob?.status, currentJob?.errorMessage]);

  async function createTimeline() {
    if (writing.current || jobActive || !episode || approval?.status !== "approved") return;
    writing.current = true; setBusy(true); setStatus("正在创建语音时间轴任务…");
    try {
      const body = await responseJson<{ message: string; job: JobRecord }>(await fetch("/api/jobs", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ type: "tts_timeline", payload: ttsTimelinePayload(
          episode.id, voice, rate, calibration?.selection,
        ) }),
      }));
      onJobCreated(body.job.id); setStatus(body.message);
    } catch (error) {
      setStatus(`语音任务创建失败：${(error as Error).message}`);
    } finally {
      writing.current = false; setBusy(false);
    }
  }

  async function createCalibration() {
    if (writing.current || jobActive || !episode || approval?.status !== "approved") return;
    const expectedRoute = routeKey;
    writing.current = true; setBusy(true); setStatus("正在创建双短样校准任务…");
    try {
      const body = await responseJson<{ message: string; job: JobRecord }>(await fetch("/api/jobs", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ type: "tts_calibration", payload: { mode: "generate", episodeId: episode.id, voice: voice.trim(), rate } }),
      }));
      if (mounted.current && currentRoute.current === expectedRoute) { onJobCreated(body.job.id); setStatus(body.message); }
    } catch (error) {
      if (mounted.current && currentRoute.current === expectedRoute) setStatus(`短样校准任务创建失败：${(error as Error).message}`);
    } finally {
      writing.current = false;
      if (mounted.current && currentRoute.current === expectedRoute) setBusy(false);
    }
  }

  async function selectCalibration(sampleId: string) {
    if (writing.current || jobActive || !episode || !calibration?.generationJobId) return;
    const expectedRoute = routeKey;
    writing.current = true; setBusy(true); setStatus("正在持久化短样选择…");
    try {
      const body = await responseJson<{ message: string; job: JobRecord }>(await fetch("/api/jobs", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ type: "tts_calibration", payload: {
          mode: "select", episodeId: episode.id, generateJobId: calibration.generationJobId, sampleId,
        } }),
      }));
      if (mounted.current && currentRoute.current === expectedRoute) { onJobCreated(body.job.id); setStatus(body.message); }
    } catch (error) {
      if (mounted.current && currentRoute.current === expectedRoute) setStatus(`短样选择失败：${(error as Error).message}`);
    } finally {
      writing.current = false;
      if (mounted.current && currentRoute.current === expectedRoute) setBusy(false);
    }
  }

  function toggleListeningSegment(index: number) {
    setCheckedListeningSegments((current) => {
      const next = new Set(current);
      if (next.has(index)) next.delete(index); else next.add(index);
      return next;
    });
  }

  function toggleProperNoun(term: string) {
    setCheckedProperNouns((current) => {
      const next = new Set(current);
      if (next.has(term)) next.delete(term); else next.add(term);
      return next;
    });
  }

  async function submitListeningReview(action: "approve" | "reject") {
    if (reviewing.current || jobActive || !listeningWorkspace) return;
    const expectedRoute = routeKey;
    const expectedIdentity = listeningIdentity.current;
    const expectedTimeline = listeningWorkspace.identity.timelineHash;
    reviewing.current = true;
    setBusy(true);
    setListeningStatus("loading");
    setListeningMessage(action === "approve" ? "正在提交通过听审…" : "正在提交不通过听审…");
    try {
      const body = await responseJson<{ message: string; job: JobRecord }>(await fetch(
        listeningReviewUrl(listeningWorkspace.identity.episodeId, expectedTimeline), {
          method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify(listeningReviewPayload(action, checkedListeningSegments, checkedProperNouns, listeningNotes)),
        },
      ));
      if (!mounted.current || currentRoute.current !== expectedRoute || listeningIdentity.current !== expectedIdentity) return;
      reviewJobId.current = body.job.id;
      onJobCreated(body.job.id);
      setListeningStatus("loading");
      setListeningMessage(body.message || "人工听审任务已创建并持久化。");
    } catch (error) {
      if (!mounted.current || currentRoute.current !== expectedRoute || listeningIdentity.current !== expectedIdentity) return;
      const interrupted = error instanceof DOMException && error.name === "AbortError";
      setListeningStatus(interrupted ? "interrupted" : "failure");
      setListeningMessage(interrupted ? "人工听审提交已中断，当前勾选仍保留。" : `人工听审提交失败：${(error as Error).message}`);
    } finally {
      reviewing.current = false;
      if (mounted.current && currentRoute.current === expectedRoute) setBusy(false);
    }
  }

  return {
    episode, approval, timeline, calibration, voice, rate, setVoice, setRate,
    runtimeLabel: modelConfig ? activeModelLabel(modelConfig, "tts") : "正在读取设置中心 TTS…",
    runtimeError: modelConfigError,
    createTimeline, createCalibration, selectCalibration,
    listeningWorkspace, checkedListeningSegments, checkedProperNouns, listeningNotes, setListeningNotes,
    listeningStatus, listeningMessage, toggleListeningSegment, toggleProperNoun, submitListeningReview,
  };
}
