import { useEffect, useMemo, useRef, useState } from "react";

import { responseJson } from "../../client-logic";
import type { AssetGroup, CandidateRecord } from "../assets/types";
import { flattenAssets } from "../assets/types";
import type { Episode, JobRecord, TtsTimeline, TtsTimelineSummary } from "../types";
import {
  contactSheetReviewPayload, contactSheetReviewUrl, isCurrentContactSheetReviewOperation, parseContactSheetReviewWorkspace,
  type ContactSheetReviewWorkspace,
} from "./contact-sheet-review";
import { conflictRevision, nextVisualDraft, visualDraft, visualPlanStatus, visualSegmentPayload } from "./visual-editor";
import type { ContactSheetResult, VisualAsset, VisualSegment, VisualSegmentDraft } from "./types";

export function useVisualWorkspace({ seriesId, episodeIndex, timelineHash, externalBusy, jobActive, currentJob, setBusy, setStatus, onTimelineChange, onJobCreated }: {
  seriesId: string; episodeIndex: number; timelineHash?: string; externalBusy: boolean; jobActive: boolean; currentJob?: JobRecord;
  setBusy: (busy: boolean) => void; setStatus: (message: string) => void;
  onTimelineChange: (hash: string | undefined) => void; onJobCreated: (id: string) => void;
}) {
  const [episode, setEpisode] = useState<Episode>();
  const [timelines, setTimelines] = useState<TtsTimelineSummary[]>([]);
  const [timeline, setTimeline] = useState<TtsTimeline>();
  const [assets, setAssets] = useState<VisualAsset[]>([]);
  const [segments, setSegments] = useState<VisualSegment[]>([]);
  const [draft, setDraft] = useState<VisualSegmentDraft>();
  const [contactSheet, setContactSheet] = useState<ContactSheetResult>();
  const [reviewWorkspace, setReviewWorkspace] = useState<ContactSheetReviewWorkspace>();
  const [reviewNotes, setReviewNotes] = useState("");
  const [reviewConfirmed, setReviewConfirmed] = useState(false);
  const [reviewStatus, setReviewStatus] = useState<"idle" | "loading" | "success" | "failure" | "interrupted">("idle");
  const [reviewMessage, setReviewMessage] = useState("导出当前联系表后可进行整集人工审核。");
  const [reviewRefresh, setReviewRefresh] = useState(0);
  const [loading, setLoading] = useState(false);
  const writing = useRef(false);
  const reviewing = useRef(false);
  const reviewJob = useRef<{ id: string; epoch: number; identityHash: string } | undefined>(undefined);
  const reviewIdentityHash = useRef("");
  const reviewRequest = useRef(0);
  const epoch = useRef(0);
  const routeKey = `${seriesId}:${episodeIndex}:${timelineHash ?? "latest"}`;
  const plan = useMemo(() => visualPlanStatus(timeline, segments), [segments, timeline]);
  const busy = externalBusy || loading || jobActive;

  async function readSegments(episodeId: string, hash: string) {
    return (await responseJson<{ items: VisualSegment[] }>(await fetch(`/api/episodes/${encodeURIComponent(episodeId)}/visual-segments?timelineHash=${encodeURIComponent(hash)}`))).items;
  }

  useEffect(() => {
    const requestEpoch = ++epoch.current;
    reviewJob.current = undefined; reviewIdentityHash.current = "";
    setEpisode(undefined); setTimelines([]); setTimeline(undefined); setAssets([]); setSegments([]); setDraft(undefined); setContactSheet(undefined);
    setReviewWorkspace(undefined); setReviewNotes(""); setReviewConfirmed(false); setReviewStatus("idle"); setReviewMessage("正在恢复当前联系表审核状态…");
    setLoading(true); setBusy(true); setStatus(`正在恢复第 ${episodeIndex} 集视觉段…`);
    void (async () => {
      const episodeResponse = await fetch(`/api/series/${encodeURIComponent(seriesId)}/episodes/${episodeIndex}`);
      if (episodeResponse.status === 404) return undefined;
      const restoredEpisode = (await responseJson<{ episode: Episode }>(episodeResponse)).episode;
      const [timelineList, assetGroups] = await Promise.all([
        responseJson<{ items: TtsTimelineSummary[] }>(await fetch(`/api/episodes/${encodeURIComponent(restoredEpisode.id)}/tts-timelines`)).then((body) => body.items),
        responseJson<{ items: AssetGroup[] }>(await fetch(`/api/series/${encodeURIComponent(seriesId)}/assets`)).then((body) => body.items),
      ]);
      const hash = timelineHash ?? timelineList[0]?.timelineHash;
      if (!hash) return { episode: restoredEpisode, timelines: timelineList, timeline: undefined, assets: [], segments: [] };
      const flatAssets = flattenAssets(assetGroups);
      const [restoredTimeline, candidates, restoredSegments] = await Promise.all([
        responseJson<{ timeline: TtsTimeline }>(await fetch(`/api/episodes/${encodeURIComponent(restoredEpisode.id)}/tts-timelines/${encodeURIComponent(hash)}`)).then((body) => body.timeline),
        Promise.all(flatAssets.map(async (asset) => ({ ...asset, candidates: (await responseJson<{ items: CandidateRecord[] }>(await fetch(`/api/assets/${encodeURIComponent(asset.id)}/candidates`))).items }))),
        readSegments(restoredEpisode.id, hash),
      ]);
      return { episode: restoredEpisode, timelines: timelineList, timeline: restoredTimeline, assets: candidates, segments: restoredSegments, hash };
    })().then((snapshot) => {
      if (epoch.current !== requestEpoch) return;
      if (!snapshot) { setStatus(`第 ${episodeIndex} 集尚未创建`); return; }
      setEpisode(snapshot.episode); setTimelines(snapshot.timelines); setTimeline(snapshot.timeline); setAssets(snapshot.assets); setSegments(snapshot.segments);
      if (snapshot.hash && snapshot.hash !== timelineHash) onTimelineChange(snapshot.hash);
      setStatus(snapshot.timeline ? `视觉工作区已恢复：${snapshot.segments.length} 个视觉段` : "当前批准稿尚未生成语音时间轴");
    }).catch((error) => { if (epoch.current === requestEpoch) setStatus(`视觉工作区恢复失败：${(error as Error).message}`); })
      .finally(() => { if (epoch.current === requestEpoch) { setLoading(false); setBusy(false); } });
    return () => { epoch.current += 1; setBusy(false); };
  }, [routeKey]);

  useEffect(() => {
    const expectedEpisode = episode;
    const expectedTimeline = timeline;
    const request = ++reviewRequest.current;
    const requestEpoch = epoch.current;
    reviewIdentityHash.current = "";
    setReviewWorkspace(undefined); setReviewNotes(""); setReviewConfirmed(false); setContactSheet(undefined);
    if (!expectedEpisode || !expectedTimeline) {
      setReviewStatus("idle"); setReviewMessage("导出当前联系表后可进行整集人工审核。");
      return;
    }
    setReviewStatus("loading"); setReviewMessage("正在读取当前联系表审核状态…");
    void fetch(contactSheetReviewUrl(expectedEpisode.id, expectedTimeline.timelineHash)).then(async (response) => {
      if (response.status === 404 || response.status === 409) {
        await response.text();
        return undefined;
      }
      return parseContactSheetReviewWorkspace(await responseJson<unknown>(response), {
        episodeId: expectedEpisode.id, timelineHash: expectedTimeline.timelineHash,
      });
    }).then((workspace) => {
      if (epoch.current !== requestEpoch || reviewRequest.current !== request) return;
      if (!workspace) {
        setReviewStatus("idle"); setReviewMessage("尚无当前身份的已验证联系表，请先导出后再审核。");
        return;
      }
      setReviewWorkspace(workspace); setContactSheet(workspace.contactSheet); setReviewNotes(workspace.latestReview?.notes ?? "");
      reviewIdentityHash.current = workspace.identityHash;
      setReviewStatus("success");
      setReviewMessage(workspace.latestReview
        ? `已恢复当前身份的${workspace.latestReview.action === "approve" ? "通过" : "不通过"}审核记录。`
        : workspace.hasStaleReview ? "旧审核已因身份变化失效，请重新查看并审核当前联系表。" : "联系表已验证，等待整集人工审核。");
    }).catch((error) => {
      if (epoch.current !== requestEpoch || reviewRequest.current !== request) return;
      setReviewStatus("failure"); setReviewMessage(`联系表审核状态读取失败：${(error as Error).message}`);
    });
  }, [episode?.id, timeline?.timelineHash, reviewRefresh]);

  useEffect(() => {
    const tracked = reviewJob.current;
    if (!tracked || currentJob?.id !== tracked.id ||
        (currentJob.status !== "succeeded" && currentJob.status !== "failed" && currentJob.status !== "cancelled")) return;
    reviewJob.current = undefined;
    if (!isCurrentContactSheetReviewOperation(tracked, { epoch: epoch.current, identityHash: reviewIdentityHash.current })) return;
    if (currentJob.status === "succeeded") setReviewRefresh((value) => value + 1);
    else {
      setReviewStatus(currentJob.status === "cancelled" ? "interrupted" : "failure");
      setReviewMessage(currentJob.status === "cancelled"
        ? "联系表审核提交已中断，确认与备注仍保留。"
        : `联系表审核提交失败：${currentJob.errorMessage ?? "未提供错误详情"}`);
    }
  }, [currentJob?.id, currentJob?.status, currentJob?.errorMessage]);

  function chooseTimeline(hash: string) { if (hash !== timelineHash) onTimelineChange(hash); }
  function chooseSegment(segment: VisualSegment) { setDraft(visualDraft(segment)); setStatus(`正在编辑视觉段 ${segment.segmentIndex + 1}`); }
  function addSegment() {
    if (!timeline) return;
    const next = nextVisualDraft(timeline, segments, assets);
    if (!next) { setStatus("全部字幕已被视觉段覆盖"); return; }
    setDraft(next); setStatus(`已创建视觉段 ${next.segmentIndex + 1} 草稿，请绑定资产与批准候选`);
  }

  async function saveSegment() {
    if (!episode || !timeline || !draft || writing.current) return;
    let payload;
    try { payload = visualSegmentPayload(timeline.timelineHash, draft); }
    catch (error) { setStatus(`视觉段校验失败：${(error as Error).message}`); return; }
    writing.current = true; setLoading(true); setBusy(true); setContactSheet(undefined); setReviewWorkspace(undefined); setReviewConfirmed(false); reviewIdentityHash.current = "";
    setReviewStatus("idle"); setReviewMessage("视觉段已变化，请重新导出并审核联系表。"); setStatus("正在保存视觉段…");
    const requestEpoch = epoch.current;
    try {
      const response = await fetch(`/api/episodes/${encodeURIComponent(episode.id)}/visual-segments/${draft.segmentIndex}`, {
        method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(payload),
      });
      try { await responseJson(response); } catch (error) {
        if (response.status === 409) {
          const refreshed = await readSegments(episode.id, timeline.timelineHash);
          if (epoch.current !== requestEpoch) return;
          setSegments(refreshed);
          const server = refreshed.find((segment) => segment.segmentIndex === draft.segmentIndex);
          const revision = server?.revision ?? conflictRevision((error as Error).message);
          if (revision !== undefined) setDraft((current) => current?.segmentIndex === draft.segmentIndex ? { ...current, expectedRevision: revision } : current);
          setStatus(`视觉段发生冲突，服务端版本已刷新为 r${revision ?? "?"}；草稿未丢失，请核对后重试`);
          return;
        }
        throw error;
      }
      const refreshed = await readSegments(episode.id, timeline.timelineHash);
      if (epoch.current !== requestEpoch) return;
      setSegments(refreshed);
      const saved = refreshed.find((segment) => segment.segmentIndex === draft.segmentIndex);
      if (!saved) throw new Error("保存后未能回读视觉段");
      setDraft(visualDraft(saved)); setStatus(`视觉段 ${saved.segmentIndex + 1} 已保存并从持久层回读`);
    } catch (error) { if (epoch.current === requestEpoch) setStatus(`视觉段保存失败：${(error as Error).message}`); }
    finally { writing.current = false; if (epoch.current === requestEpoch) { setLoading(false); setBusy(false); } }
  }

  async function exportContactSheet() {
    if (!episode || !timeline || writing.current || !plan.productionReady) return;
    writing.current = true; setLoading(true); setBusy(true); setContactSheet(undefined); setStatus("正在验证并导出联系表…");
    const requestEpoch = epoch.current;
    try {
      const body = await responseJson<{ message: string; contactSheet: ContactSheetResult }>(await fetch(`/api/episodes/${encodeURIComponent(episode.id)}/contact-sheet`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ timelineHash: timeline.timelineHash }),
      }));
      if (epoch.current !== requestEpoch) return;
      setContactSheet(body.contactSheet); setReviewRefresh((value) => value + 1); setStatus("联系表已通过服务端真实门禁并耐久导出，正在读取审核身份");
    } catch (error) { if (epoch.current === requestEpoch) setStatus(`联系表导出失败：${(error as Error).message}`); }
    finally { writing.current = false; if (epoch.current === requestEpoch) { setLoading(false); setBusy(false); } }
  }

  async function submitContactSheetReview(action: "approve" | "reject") {
    if (reviewing.current || jobActive || !reviewWorkspace || (action === "approve" && !reviewConfirmed)) return;
    const requestEpoch = epoch.current;
    const expectedIdentityHash = reviewWorkspace.identityHash;
    const expectedOperation = { epoch: requestEpoch, identityHash: expectedIdentityHash };
    reviewing.current = true; setLoading(true); setBusy(true); setReviewStatus("loading");
    setReviewMessage(action === "approve" ? "正在提交联系表通过审核…" : "正在提交联系表不通过审核…");
    try {
      const body = await responseJson<{ message?: string; job: JobRecord }>(await fetch(
        contactSheetReviewUrl(reviewWorkspace.identity.episodeId, reviewWorkspace.identity.timelineHash), {
          method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify(contactSheetReviewPayload(action, expectedIdentityHash, reviewNotes)),
        },
      ));
      if (!isCurrentContactSheetReviewOperation(expectedOperation, { epoch: epoch.current, identityHash: reviewIdentityHash.current }) || !body.job?.id) return;
      reviewJob.current = { id: body.job.id, ...expectedOperation }; onJobCreated(body.job.id);
      setReviewMessage(body.message || "联系表审核任务已创建并持久化。");
    } catch (error) {
      if (!isCurrentContactSheetReviewOperation(expectedOperation, { epoch: epoch.current, identityHash: reviewIdentityHash.current })) return;
      const interrupted = error instanceof DOMException && error.name === "AbortError";
      setReviewStatus(interrupted ? "interrupted" : "failure");
      setReviewMessage(interrupted ? "联系表审核提交已中断，确认与备注仍保留。" : `联系表审核提交失败：${(error as Error).message}`);
    } finally {
      reviewing.current = false;
      if (isCurrentContactSheetReviewOperation(expectedOperation, { epoch: epoch.current, identityHash: reviewIdentityHash.current })) {
        setLoading(false); setBusy(false);
      }
    }
  }

  return {
    episode, timelines, timeline, assets, segments, draft, setDraft, contactSheet, plan, busy,
    reviewWorkspace, reviewNotes, setReviewNotes, reviewConfirmed, setReviewConfirmed, reviewStatus, reviewMessage,
    chooseTimeline, chooseSegment, addSegment, saveSegment, exportContactSheet, submitContactSheetReview,
  };
}
