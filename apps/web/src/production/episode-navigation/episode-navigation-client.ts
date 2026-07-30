import { responseJson } from "../../client-logic";
import type { Episode } from "../types";

export async function readEpisodeNavigation(seriesId: string, signal: AbortSignal) {
  const body = await responseJson<{ episodes: Episode[] }>(await fetch(
    `/api/series/${encodeURIComponent(seriesId)}/episodes`, { signal },
  ));
  if (!Array.isArray(body.episodes) || body.episodes.some((episode) =>
    episode.seriesProjectId !== seriesId || !Number.isSafeInteger(episode.index) || episode.index < 1 || !episode.title,
  )) throw new Error("服务端返回的分集列表身份或格式无效");
  return [...body.episodes].sort((left, right) => left.index - right.index);
}

export function episodeNavigationTarget(episodes: Episode[], current: number, direction: -1 | 1) {
  const position = episodes.findIndex((episode) => episode.index === current);
  return position < 0 ? undefined : episodes[position + direction]?.index;
}
