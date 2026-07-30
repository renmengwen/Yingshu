import { useEffect, useLayoutEffect, useRef, useState } from "react";

import { responseJson } from "../../client-logic";
import type { Episode, EpisodeRecommendation, JobRecord } from "../types";
import {
  consumeEpisodeRecommendation, createEpisodeHydrationCoordinator, emptyEpisodeDraft, episodeDraft,
  episodePutPayload, episodeRecommendationJobMatchesIdentity,
  FALLBACK_EPISODE_DURATION_POLICY,
  type EpisodeDraft, type EpisodeDurationPolicy,
} from "./episode-editor";

export function useCommittedEpisodeIdentity(
  coordinator: ReturnType<typeof createEpisodeHydrationCoordinator>, identity: string,
) {
  useLayoutEffect(() => {
    coordinator.transitionIdentity(identity);
  }, [coordinator, identity]);
}

export function useEpisodeWorkspace({
  bookId, seriesId, episodeIndex, startChapterId, currentJob, busy, setBusy, setStatus, onJobCreated,
}: {
  bookId: string; seriesId: string; episodeIndex: number; startChapterId?: string; currentJob?: JobRecord;
  busy: boolean; setBusy: (busy: boolean) => void; setStatus: (message: string) => void;
  onJobCreated: (id?: string) => void;
}) {
  const [episode, setEpisode] = useState<Episode>();
  const [draft, setDraft] = useState<EpisodeDraft>(() => emptyEpisodeDraft());
  const [policy, setPolicy] = useState<EpisodeDurationPolicy>(FALLBACK_EPISODE_DURATION_POLICY);
  const [recommendation, setRecommendation] = useState<EpisodeRecommendation>();
  const identity = `${seriesId}\0${episodeIndex}\0${startChapterId ?? ""}`;
  const hydrationCoordinatorRef = useRef<ReturnType<typeof createEpisodeHydrationCoordinator> | null>(null);
  hydrationCoordinatorRef.current ??= createEpisodeHydrationCoordinator(identity);
  const hydrationCoordinator = hydrationCoordinatorRef.current;
  const mutationRef = useRef(false);
  useCommittedEpisodeIdentity(hydrationCoordinator, identity);

  async function fetchEpisode() {
    const response = await fetch(`/api/series/${encodeURIComponent(seriesId)}/episodes/${episodeIndex}`);
    if (response.status === 404) return undefined;
    return (await responseJson<{ episode: Episode }>(response)).episode;
  }

  useEffect(() => {
    const expected = identity;
    setRecommendation(undefined);
    async function hydrate() {
      setBusy(true); setStatus(`正在恢复第 ${episodeIndex} 集故事弧与证据…`);
      try {
        const [restored, policyBody] = await Promise.all([
          fetchEpisode(),
          responseJson<{ duration: EpisodeDurationPolicy }>(await fetch("/api/episode-policy")),
        ]);
        const restoredDraft = restored ? episodeDraft(restored) : emptyEpisodeDraft(policyBody.duration.defaultSeconds);
        const resolved = hydrationCoordinator.resolve(
          expected,
          restoredDraft,
          restored ? `第 ${episodeIndex} 集已恢复，可继续编辑` : `第 ${episodeIndex} 集尚未创建，可先生成跨章选材推荐`,
        );
        if (!resolved) return;
        setPolicy(policyBody.duration);
        setEpisode(restored);
        setDraft(resolved.draft);
        setRecommendation(resolved.recommendation);
        setStatus(resolved.status);
      } catch (error) { if (hydrationCoordinator.isCurrent(expected)) setStatus(`分集恢复失败：${(error as Error).message}`); }
      finally { if (hydrationCoordinator.isCurrent(expected)) setBusy(false); }
    }
    void hydrate();
  }, [seriesId, episodeIndex, startChapterId]);

  useEffect(() => {
    if (currentJob?.type !== "episode_sources_recommend" || currentJob.status !== "succeeded") return;
    const payload = currentJob.payload as {
      seriesId?: string; episodeIndex?: number; requestedStartChapterId?: string | null;
    };
    if (!episodeRecommendationJobMatchesIdentity(payload, seriesId, episodeIndex, startChapterId)) return;
    const result = currentJob.result as EpisodeRecommendation;
    const accepted = hydrationCoordinator.acceptRecommendation(identity, result);
    if (!accepted) return;
    setRecommendation(accepted.recommendation);
    setDraft((current) => hydrationCoordinator.resolve(identity, current, accepted.status)?.draft ?? current);
    setStatus(accepted.status);
  }, [currentJob?.id, currentJob?.status, seriesId, episodeIndex, startChapterId]);

  function updateDraft(change: Partial<EpisodeDraft>) { setDraft((current) => ({ ...current, ...change })); }

  async function recommend(endingPreference: string) {
    if (busy || mutationRef.current) return;
    mutationRef.current = true; setBusy(true); setStatus("正在创建跨章选材推荐任务…");
    const expected = identity;
    try {
      const body = await responseJson<{ message: string; job: JobRecord }>(await fetch("/api/jobs", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ type: "episode_sources_recommend", payload: {
          seriesId, episodeIndex, ...(startChapterId ? { startChapterId } : {}),
          targetDurationSeconds: draft.targetDurationSeconds, endingPreference: endingPreference.trim() || undefined,
        } }),
      }));
      if (!hydrationCoordinator.isCurrent(expected)) return;
      onJobCreated(body.job.id); setStatus(body.message);
    } catch (error) { if (hydrationCoordinator.isCurrent(expected)) setStatus(`跨章选材推荐失败：${(error as Error).message}`); }
    finally { mutationRef.current = false; if (hydrationCoordinator.isCurrent(expected)) setBusy(false); }
  }

  async function analyzeMissing(chapterId: string) {
    if (busy || mutationRef.current) return;
    mutationRef.current = true; setBusy(true); setStatus("正在创建缺失章节的单章分析任务…");
    const expected = identity;
    try {
      const body = await responseJson<{ message: string; job: JobRecord }>(await fetch("/api/jobs", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ type: "chapter_events_analyze", payload: { bookId, chapterId } }),
      }));
      if (!hydrationCoordinator.isCurrent(expected)) return;
      onJobCreated(body.job.id); setStatus(`${body.message}；完成后请重新推荐`);
    } catch (error) { if (hydrationCoordinator.isCurrent(expected)) setStatus(`缺失章节分析失败：${(error as Error).message}`); }
    finally { mutationRef.current = false; if (hydrationCoordinator.isCurrent(expected)) setBusy(false); }
  }

  async function save() {
    if (busy || mutationRef.current) return;
    mutationRef.current = true; setBusy(true); setStatus(`正在确认并保存第 ${episodeIndex} 集选材…`);
    const expected = identity;
    try {
      const payload = episodePutPayload(draft, policy);
      await responseJson(await fetch(`/api/series/${encodeURIComponent(seriesId)}/episodes/${episodeIndex}`, {
        method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(payload),
      }));
      const restored = await fetchEpisode();
      if (!restored) throw new Error("保存后未能回读分集");
      if (!hydrationCoordinator.isCurrent(expected)) return;
      consumeEpisodeRecommendation(hydrationCoordinator, expected, onJobCreated);
      setEpisode(restored); setDraft(episodeDraft(restored)); setRecommendation(undefined);
      setStatus(`第 ${episodeIndex} 集已确认，并从持久层回读跨章证据`);
    } catch (error) { if (hydrationCoordinator.isCurrent(expected)) setStatus(`分集保存失败：${(error as Error).message}`); }
    finally { mutationRef.current = false; if (hydrationCoordinator.isCurrent(expected)) setBusy(false); }
  }

  return { episode, draft, policy, recommendation, updateDraft, recommend, analyzeMissing, save };
}
