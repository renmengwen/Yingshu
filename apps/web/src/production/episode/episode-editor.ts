import type { Episode, EpisodeRecommendation } from "../types";

export interface EpisodeDraft {
  title: string;
  storyArc: string;
  targetDurationSeconds: number;
  recap: string;
  nextHook: string;
  sourceEventIds: string[];
}

export interface EpisodeDurationPolicy {
  minimumSeconds: number;
  defaultSeconds: number;
  maximumSeconds: number;
  stepSeconds: number;
}

export const FALLBACK_EPISODE_DURATION_POLICY: EpisodeDurationPolicy = {
  minimumSeconds: 60, defaultSeconds: 1200, maximumSeconds: 3600, stepSeconds: 30,
};

export const emptyEpisodeDraft = (defaultSeconds = FALLBACK_EPISODE_DURATION_POLICY.defaultSeconds): EpisodeDraft => ({
  title: "", storyArc: "", targetDurationSeconds: defaultSeconds, recap: "", nextHook: "", sourceEventIds: [],
});

export function episodeDraft(episode: Episode): EpisodeDraft {
  return {
    title: episode.title,
    storyArc: episode.storyArc,
    targetDurationSeconds: episode.targetDurationSeconds,
    recap: episode.recap ?? "",
    nextHook: episode.nextHook ?? "",
    sourceEventIds: [...new Set(episode.sources.map((source) => source.sourceEventId))],
  };
}

export function recommendationChapterSummaries(recommendation?: EpisodeRecommendation) {
  const events = recommendation?.status === "recommended" ? recommendation.events ?? [] : [];
  const summaries = new Map<string, { chapterId: string; eventCount: number; summary: string }>();
  for (const event of events) {
    const current = summaries.get(event.chapterId) ?? { chapterId: event.chapterId, eventCount: 0, summary: "" };
    const summary = Object.values(event.payload).filter(Boolean).join(" / ");
    summaries.set(event.chapterId, {
      chapterId: event.chapterId,
      eventCount: current.eventCount + 1,
      summary: current.summary || summary || event.type,
    });
  }
  return [...summaries.values()];
}

function recommendationStatus(recommendation: EpisodeRecommendation) {
  return recommendation.status === "recommended" && recommendation.eventIds
    ? `推荐完成：${recommendation.chapterIds?.length ?? 0} 章、${recommendation.eventIds.length} 个事件，等待明确确认`
    : "起始章节缺少结构化分析，请先补齐后重新推荐";
}

function mergeRecommendationIntoDraft(draft: EpisodeDraft, recommendation?: EpisodeRecommendation) {
  return recommendation?.status === "recommended" && recommendation.eventIds
    ? { ...draft, sourceEventIds: [...recommendation.eventIds] }
    : draft;
}

export function createEpisodeHydrationCoordinator(initialIdentity: string) {
  let identity = initialIdentity;
  let acceptedRecommendation: EpisodeRecommendation | undefined;
  return {
    transitionIdentity(nextIdentity: string) {
      if (nextIdentity === identity) return false;
      identity = nextIdentity;
      acceptedRecommendation = undefined;
      return true;
    },
    isCurrent(expectedIdentity: string) {
      return identity === expectedIdentity;
    },
    acceptRecommendation(expectedIdentity: string, recommendation: EpisodeRecommendation) {
      if (identity !== expectedIdentity) return undefined;
      acceptedRecommendation = recommendation;
      return { recommendation, status: recommendationStatus(recommendation) };
    },
    clearRecommendation(expectedIdentity: string) {
      if (identity !== expectedIdentity) return false;
      acceptedRecommendation = undefined;
      return true;
    },
    resolve(expectedIdentity: string, draft: EpisodeDraft, fallbackStatus: string) {
      if (identity !== expectedIdentity) return undefined;
      return {
        draft: mergeRecommendationIntoDraft(draft, acceptedRecommendation),
        recommendation: acceptedRecommendation,
        status: acceptedRecommendation ? recommendationStatus(acceptedRecommendation) : fallbackStatus,
      };
    },
  };
}

export function episodeRecommendationJobMatchesIdentity(
  payload: { seriesId?: string; episodeIndex?: number; requestedStartChapterId?: string | null },
  seriesId: string,
  episodeIndex: number,
  startChapterId?: string,
) {
  return payload.seriesId === seriesId && payload.episodeIndex === episodeIndex &&
    (payload.requestedStartChapterId ?? "") === (startChapterId ?? "");
}

export function consumeEpisodeRecommendation(
  coordinator: ReturnType<typeof createEpisodeHydrationCoordinator>,
  identity: string,
  clearJob: (id?: string) => void,
) {
  if (!coordinator.clearRecommendation(identity)) return false;
  clearJob(undefined);
  return true;
}

export function episodePutPayload(draft: EpisodeDraft, policy = FALLBACK_EPISODE_DURATION_POLICY) {
  const title = draft.title.trim();
  const storyArc = draft.storyArc.trim();
  const recap = draft.recap.trim();
  const nextHook = draft.nextHook.trim();
  const sourceEventIds = [...new Set(draft.sourceEventIds.map((id) => id.trim()).filter(Boolean))];
  if (!title) throw new Error("分集标题不能为空");
  if (!storyArc) throw new Error("故事弧不能为空");
  if (!Number.isSafeInteger(draft.targetDurationSeconds) || draft.targetDurationSeconds < policy.minimumSeconds || draft.targetDurationSeconds > policy.maximumSeconds) {
    throw new Error(`目标时长必须为 ${policy.minimumSeconds} 至 ${policy.maximumSeconds} 秒`);
  }
  if (!sourceEventIds.length) throw new Error("至少选择一个章节事件作为原文证据");
  return { title, storyArc, targetDurationSeconds: draft.targetDurationSeconds, recap: recap || null, nextHook: nextHook || null, sourceEventIds };
}
