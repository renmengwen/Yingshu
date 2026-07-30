import { useCallback, useEffect, useRef, useState } from "react";

import { responseJson } from "../../client-logic";
import type { EpisodeChapterRange } from "./pipeline-setup-logic";

export interface BookPromptProfileContent {
  sharedInstructions: string;
  chapterAnalysisInstructions: string;
  storyBibleInstructions: string;
  episodePlanningInstructions: string;
  narrationInstructions: string;
  assetInstructions: string;
}

export interface BookPromptProfile extends BookPromptProfileContent {
  revision: number;
  profileHash: string | null;
}

export const EMPTY_PROMPT_PROFILE: BookPromptProfileContent = {
  sharedInstructions: "",
  chapterAnalysisInstructions: "",
  storyBibleInstructions: "",
  episodePlanningInstructions: "",
  narrationInstructions: "",
  assetInstructions: "",
};

export function usePipelineSetup(bookId: string, seriesId: string) {
  const [profile, setProfile] = useState<BookPromptProfileContent>(EMPTY_PROMPT_PROFILE);
  const [savedProfile, setSavedProfile] = useState<BookPromptProfileContent>(EMPTY_PROMPT_PROFILE);
  const [profileRevision, setProfileRevision] = useState(0);
  const [ranges, setRanges] = useState<EpisodeChapterRange[]>();
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState<"loading" | "preview" | "profile" | undefined>("loading");
  const [ready, setReady] = useState(false);
  const [status, setStatus] = useState("正在读取本书专属提示词…");
  const [error, setError] = useState<string>();
  const loadIdentity = useRef(`${bookId}:${seriesId}`);
  loadIdentity.current = `${bookId}:${seriesId}`;

  useEffect(() => {
    const identity = `${bookId}:${seriesId}`;
    const controller = new AbortController();
    setBusy("loading");
    setReady(false);
    setError(undefined);
    setRanges(undefined);
    setConfirmed(false);
    requestJson<{ profile: BookPromptProfile }>(`/api/books/${encodeURIComponent(bookId)}/prompt-profile`, controller.signal).then((profileBody) => {
      if (loadIdentity.current !== identity) return;
      const content = profileContent(profileBody.profile);
      setProfile(content);
      setSavedProfile(content);
      setProfileRevision(profileBody.profile.revision);
      setReady(true);
      setStatus(profileBody.profile.revision
        ? `已读取本书专属提示词第 ${profileBody.profile.revision} 版。`
        : "本书尚未设置专属提示词，可按需填写。完善范围后先预览分集。"
      );
    }).catch((cause) => {
      if (cause instanceof DOMException && cause.name === "AbortError") return;
      if (loadIdentity.current !== identity) return;
      const message = `提示词设置加载失败：${(cause as Error).message}`;
      setError(message);
      setStatus(message);
    }).finally(() => {
      if (!controller.signal.aborted && loadIdentity.current === identity) setBusy((current) => current === "loading" ? undefined : current);
    });
    return () => controller.abort();
  }, [bookId, seriesId]);

  const preview = useCallback(async (input: {
    episodeCount: number; sourceStartChapterId: string; sourceEndChapterId: string;
  }) => {
    if (busy) return;
    setBusy("preview");
    setError(undefined);
    setConfirmed(false);
    setStatus("正在计算连续分集范围…");
    try {
      const body = await responseJson<{ ranges: EpisodeChapterRange[] }>(await fetch(
        `/api/series/${encodeURIComponent(seriesId)}/pipeline-runs/episode-ranges/preview`,
        { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(input) },
      ));
      setRanges(body.ranges);
      setStatus(`范围预览完成，共 ${body.ranges.length} 集。调整相邻边界后请确认。`);
    } catch (cause) {
      const message = cause instanceof DOMException && cause.name === "AbortError"
        ? "范围预览已中断，请重新预览。"
        : `范围预览失败：${(cause as Error).message}`;
      setError(message);
      setStatus(message);
    } finally {
      setBusy(undefined);
    }
  }, [busy, seriesId]);

  const saveProfile = useCallback(async () => {
    if (busy) return;
    setBusy("profile");
    setError(undefined);
    setStatus("正在保存本书专属提示词…");
    try {
      const body = await responseJson<{ message: string; profile: BookPromptProfile }>(await fetch(
        `/api/books/${encodeURIComponent(bookId)}/prompt-profile`,
        { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(profile) },
      ));
      const content = profileContent(body.profile);
      setProfile(content);
      setSavedProfile(content);
      setProfileRevision(body.profile.revision);
      setStatus(body.message);
    } catch (cause) {
      const message = cause instanceof DOMException && cause.name === "AbortError"
        ? "提示词保存已中断，未创建新版本。"
        : `本书专属提示词保存失败：${(cause as Error).message}`;
      setError(message);
      setStatus(message);
    } finally {
      setBusy(undefined);
    }
  }, [bookId, busy, profile]);

  return {
    profile, setProfile, profileRevision, ranges, setRanges, confirmed, setConfirmed,
    busy, ready, status, error, dirty: JSON.stringify(profile) !== JSON.stringify(savedProfile), preview, saveProfile,
  };
}

function profileContent(profile: BookPromptProfile): BookPromptProfileContent {
  const { sharedInstructions, chapterAnalysisInstructions, storyBibleInstructions, episodePlanningInstructions,
    narrationInstructions, assetInstructions } = profile;
  return { sharedInstructions, chapterAnalysisInstructions, storyBibleInstructions, episodePlanningInstructions,
    narrationInstructions, assetInstructions };
}

async function requestJson<T>(url: string, signal: AbortSignal) {
  return responseJson<T>(await fetch(url, { signal }));
}
