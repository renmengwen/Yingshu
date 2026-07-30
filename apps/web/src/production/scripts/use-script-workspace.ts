import { useEffect, useLayoutEffect, useRef, useState } from "react";

import { responseJson } from "../../client-logic";
import type {
  Episode, JobRecord, ScriptApproval, ScriptVersion, ScriptVersionKind, TtsCalibrationSelection,
} from "../types";
import {
  approvalPutPayload,
  canStartEpisodeScriptGeneration,
  completedEpisodeScriptVersions,
  emptyScriptParagraph,
  episodeScriptCalibration,
  isScriptDraftDirty,
  scriptDraft,
  scriptDraftSignature,
  scriptPostPayload,
  scriptWorkspaceContractVersion,
  resolveEpisodeScriptWorkspaceStatus,
  type ScriptParagraphDraft,
} from "./script-editor";

interface WorkspaceSnapshot {
  episode: Episode;
  scripts: ScriptVersion[];
  approval: ScriptApproval;
  calibration?: TtsCalibrationSelection;
}

export function useCommittedScriptWorkspaceRefs(
  routeRef: { current: string },
  jobRef: { current: JobRecord | undefined },
  routeKey: string,
  currentJob: JobRecord | undefined,
  mountedRef?: { current: boolean },
) {
  useLayoutEffect(() => {
    if (mountedRef) mountedRef.current = true;
    routeRef.current = routeKey;
    jobRef.current = currentJob;
    return () => {
      if (routeRef.current !== routeKey) return;
      routeRef.current = "";
      jobRef.current = undefined;
      if (mountedRef) mountedRef.current = false;
    };
  }, [routeRef, jobRef, routeKey, currentJob, mountedRef]);
}

export function applyIfCurrentScriptRoute(
  mounted: boolean,
  routeRef: { current: string },
  expectedRoute: string,
  apply: () => void,
) {
  if (!mounted || routeRef.current !== expectedRoute) return false;
  apply();
  return true;
}

export function useScriptWorkspace({
  seriesId, episodeIndex, currentJob, jobActive, setBusy, setStatus, onDraftDirtyChange, onJobCreated,
}: {
  seriesId: string;
  episodeIndex: number;
  currentJob?: JobRecord;
  jobActive: boolean;
  setBusy: (busy: boolean) => void;
  setStatus: (message: string) => void;
  onDraftDirtyChange?: (dirty: boolean) => void;
  onJobCreated: (id: string) => void;
}) {
  const [episode, setEpisode] = useState<Episode>();
  const [scripts, setScripts] = useState<ScriptVersion[]>([]);
  const [approval, setApproval] = useState<ScriptApproval>();
  const [kind, setKind] = useState<ScriptVersionKind>("faithful");
  const [parentVersionId, setParentVersionId] = useState("");
  const [paragraphs, setParagraphs] = useState<ScriptParagraphDraft[]>(() => [emptyScriptParagraph()]);
  const [selectedPackagedId, setSelectedPackagedId] = useState("");
  const [voice, setVoice] = useState("Microsoft Huihui Desktop");
  const [rate, setRate] = useState(0);
  const [charactersPerSecond, setCharactersPerSecond] = useState(4.5);
  const [narrationOccupancy, setNarrationOccupancy] = useState(0.8);
  const [calibration, setCalibration] = useState<TtsCalibrationSelection>();
  const [initialDraftSignature, setInitialDraftSignature] = useState(() => scriptDraftSignature("faithful", "", [emptyScriptParagraph()]));
  const [pendingLoadVersion, setPendingLoadVersion] = useState<ScriptVersion>();
  const [pendingKind, setPendingKind] = useState<ScriptVersionKind>();
  const writing = useRef(false);
  const consumedJobId = useRef("");
  const currentJobRef = useRef(currentJob);
  const mounted = useRef(true);
  const routeKey = `${seriesId}:${episodeIndex}`;
  const currentRoute = useRef(routeKey);
  useCommittedScriptWorkspaceRefs(currentRoute, currentJobRef, routeKey, currentJob, mounted);

  const baseUrl = `/api/series/${encodeURIComponent(seriesId)}/episodes/${episodeIndex}`;
  const draftDirty = isScriptDraftDirty(initialDraftSignature, kind, parentVersionId, paragraphs);
  const contractVersion = scriptWorkspaceContractVersion(scripts);

  useEffect(() => {
    onDraftDirtyChange?.(draftDirty);
    return () => onDraftDirtyChange?.(false);
  }, [draftDirty, onDraftDirtyChange]);

  async function readWorkspace(expectedRoute: string): Promise<WorkspaceSnapshot | undefined> {
    const episodeResponse = await fetch(baseUrl);
    if (episodeResponse.status === 404) return undefined;
    const restoredEpisode = (await responseJson<{ episode: Episode }>(episodeResponse)).episode;
    const [scriptsBody, approvalBody] = await Promise.all([
      responseJson<{ items: ScriptVersion[] }>(await fetch(`${baseUrl}/scripts`)),
      responseJson<{ approval: ScriptApproval }>(await fetch(`${baseUrl}/approval`)),
    ]);
    if (!mounted.current || currentRoute.current !== expectedRoute) return undefined;
    const measured = approvalBody.approval.status === "approved"
      ? (await responseJson<{ calibration: { selection?: TtsCalibrationSelection } }>(await fetch(
        `/api/episodes/${encodeURIComponent(restoredEpisode.id)}/tts-calibration`,
      ))).calibration.selection
      : undefined;
    if (!mounted.current || currentRoute.current !== expectedRoute) return undefined;
    return { episode: restoredEpisode, scripts: scriptsBody.items, approval: approvalBody.approval, calibration: measured };
  }

  function applySnapshot(snapshot: WorkspaceSnapshot | undefined, draftKind = kind) {
    setEpisode(snapshot?.episode);
    setScripts(snapshot?.scripts ?? []);
    setApproval(snapshot?.approval);
    setCalibration(snapshot?.calibration);
    if (snapshot?.calibration) {
      setVoice(snapshot.calibration.voice);
      setRate(snapshot.calibration.rate);
      setCharactersPerSecond(snapshot.calibration.charactersPerSecond);
    }
    if (!snapshot) {
      const empty = [emptyScriptParagraph()];
      setParagraphs(empty);
      setParentVersionId("");
      setSelectedPackagedId("");
      setInitialDraftSignature(scriptDraftSignature("faithful", "", empty));
      return;
    }
    const snapshotContractVersion = scriptWorkspaceContractVersion(snapshot.scripts);
    const effectiveDraftKind = snapshotContractVersion === 6 ? "packaged" : draftKind;
    setKind(effectiveDraftKind);
    const latestFaithful = snapshot.scripts.filter((item) => item.kind === "faithful").at(-1);
    const packaged = snapshot.scripts.filter((item) => item.kind === "packaged");
    const latest = effectiveDraftKind === "faithful" ? latestFaithful : packaged.at(-1);
    const nextParagraphs = scriptDraft(latest);
    const nextParentVersionId = effectiveDraftKind === "packaged" && snapshotContractVersion === 5
      ? latest?.parentVersionId ?? latestFaithful?.id ?? ""
      : "";
    setParagraphs(nextParagraphs);
    setParentVersionId(nextParentVersionId);
    setInitialDraftSignature(scriptDraftSignature(effectiveDraftKind, nextParentVersionId, nextParagraphs));
    setSelectedPackagedId((current) => packaged.some((item) => item.id === current)
      ? current
      : snapshot.approval.scriptVersionId ?? packaged.at(-1)?.id ?? "");
  }

  useEffect(() => {
    const expectedRoute = routeKey;
    setEpisode(undefined); setScripts([]); setApproval(undefined);
    setKind("faithful"); setParentVersionId(""); setParagraphs([emptyScriptParagraph()]); setSelectedPackagedId("");
    setCalibration(undefined); setVoice("Microsoft Huihui Desktop"); setRate(0); setCharactersPerSecond(4.5);
    setBusy(true); setStatus(`正在恢复第 ${episodeIndex} 集稿件与批准状态…`);
    void readWorkspace(expectedRoute).then((snapshot) => {
      if (!mounted.current || currentRoute.current !== expectedRoute) return;
      applySnapshot(snapshot, "faithful");
      const baseStatus = snapshot
        ? `第 ${episodeIndex} 集稿件与批准状态已从服务端恢复`
        : `第 ${episodeIndex} 集尚未创建，请先保存故事弧`;
      setStatus(resolveEpisodeScriptWorkspaceStatus(
        baseStatus, currentJobRef.current, seriesId, episodeIndex, snapshot?.episode.id,
      ));
    }).catch((error) => {
      if (mounted.current && currentRoute.current === expectedRoute) setStatus(`稿件工作区恢复失败：${(error as Error).message}`);
    }).finally(() => {
      if (mounted.current && currentRoute.current === expectedRoute) setBusy(false);
    });
  }, [seriesId, episodeIndex]);

  function applyKind(nextKind: ScriptVersionKind) {
    setKind(nextKind);
    const faithful = scripts.filter((item) => item.kind === "faithful");
    const latest = scripts.filter((item) => item.kind === nextKind).at(-1);
    const nextParagraphs = scriptDraft(latest);
    const nextParentVersionId = nextKind === "packaged" ? latest?.parentVersionId ?? faithful.at(-1)?.id ?? "" : "";
    setParagraphs(nextParagraphs);
    setParentVersionId(nextParentVersionId);
    setInitialDraftSignature(scriptDraftSignature(nextKind, nextParentVersionId, nextParagraphs));
  }

  function changeKind(nextKind: ScriptVersionKind) {
    if (nextKind === kind) return;
    if (draftDirty) { setPendingKind(nextKind); return; }
    applyKind(nextKind);
  }

  function confirmChangeKind() {
    if (!pendingKind) return;
    applyKind(pendingKind);
    setPendingKind(undefined);
  }

  function applyVersion(version: ScriptVersion) {
    const nextParagraphs = scriptDraft(version);
    const nextParentVersionId = version.parentVersionId ?? "";
    setKind(version.kind); setParagraphs(nextParagraphs);
    setParentVersionId(nextParentVersionId);
    setInitialDraftSignature(scriptDraftSignature(version.kind, nextParentVersionId, nextParagraphs));
  }

  function loadVersion(version: ScriptVersion) {
    if (isScriptDraftDirty(initialDraftSignature, kind, parentVersionId, paragraphs)) {
      setPendingLoadVersion(version);
      return;
    }
    applyVersion(version);
  }

  function confirmLoadVersion() {
    if (!pendingLoadVersion) return;
    applyVersion(pendingLoadVersion);
    setPendingLoadVersion(undefined);
  }

  function cancelLoadVersion() {
    setPendingLoadVersion(undefined);
  }

  function chooseParent(id: string) {
    const parent = scripts.find((item) => item.id === id && item.kind === "faithful");
    setParentVersionId(id);
    if (parent) setParagraphs(scriptDraft(parent));
  }

  function updateParagraph(key: string, change: Partial<ScriptParagraphDraft>) {
    setParagraphs((current) => current.map((paragraph) => paragraph.key === key ? { ...paragraph, ...change } : paragraph));
  }

  async function refreshAfterWrite(expectedRoute: string) {
    const snapshot = await readWorkspace(expectedRoute);
    if (mounted.current && currentRoute.current === expectedRoute) applySnapshot(snapshot);
  }

  useEffect(() => {
    const completed = completedEpisodeScriptVersions(currentJob, seriesId, episodeIndex, episode?.id);
    if (!episode || consumedJobId.current === currentJob?.id || !completed) return;
    const expectedRoute = routeKey;
    setBusy(true); setStatus("跨章骨架与长稿已生成，正在回读不可变稿件版本…");
    void refreshAfterWrite(expectedRoute).then(() => {
      if (!mounted.current || currentRoute.current !== expectedRoute) return;
      consumedJobId.current = currentJob!.id;
      setStatus(completed.contractVersion === 6
        ? "成片旁白稿已逐段生成并从持久层回读；仍需人工批准"
        : "原著还原稿与成片旁白稿已生成并从持久层回读；仍需人工批准成片旁白稿");
    }).catch((error) => {
      if (mounted.current && currentRoute.current === expectedRoute) setStatus(`长稿生成成功，但稿件回读失败：${(error as Error).message}`);
    }).finally(() => {
      if (mounted.current && currentRoute.current === expectedRoute) setBusy(false);
    });
  }, [currentJob?.id, currentJob?.status, episode?.id, seriesId, episodeIndex]);

  useEffect(() => {
    if (!episode) return;
    const terminalStatus = resolveEpisodeScriptWorkspaceStatus(
      "", currentJob, seriesId, episodeIndex, episode.id,
    );
    if (terminalStatus) setStatus(terminalStatus);
  }, [currentJob?.id, currentJob?.status, currentJob?.errorMessage, episode?.id, seriesId, episodeIndex]);

  async function generateScripts() {
    if (writing.current || !canStartEpisodeScriptGeneration(false, jobActive, episode?.id)) return;
    const expectedRoute = currentRoute.current;
    writing.current = true;
    setBusy(true); setStatus("正在创建跨章骨架与长稿持久任务…");
    try {
      const body = await responseJson<{ message: string; job: JobRecord }>(await fetch("/api/jobs", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          type: "episode_scripts_generate",
          payload: {
            seriesId,
            episodeIndex,
            voice: voice.trim(),
            rate,
            charactersPerSecond,
            narrationOccupancy,
            ...episodeScriptCalibration(calibration),
          },
        }),
      }));
      applyIfCurrentScriptRoute(mounted.current, currentRoute, expectedRoute, () => {
        onJobCreated(body.job.id);
        setStatus(`${body.message}；生成完成后仍需人工批准成片旁白稿`);
      });
    } catch (error) {
      applyIfCurrentScriptRoute(mounted.current, currentRoute, expectedRoute, () => {
        setStatus(`跨章骨架与长稿任务创建失败：${(error as Error).message}`);
      });
    } finally {
      writing.current = false;
      applyIfCurrentScriptRoute(mounted.current, currentRoute, expectedRoute, () => setBusy(false));
    }
  }

  async function saveVersion() {
    if (writing.current || !episode) return;
    if (contractVersion === 6) {
      setStatus("成片旁白 v6 版本由流水线逐段生成；如需修改侧重点，请更新本书专属要求后显式重新生成");
      return;
    }
    writing.current = true;
    const expectedRoute = routeKey;
    setBusy(true); setStatus(`正在创建第 ${episodeIndex} 集${kind === "faithful" ? "原著还原稿" : "成片旁白稿"}不可变新版本…`);
    let message = "";
    try {
      const parent = scripts.find((item) => item.id === parentVersionId);
      const payload = scriptPostPayload(kind, paragraphs, parent);
      const response = await fetch(`${baseUrl}/scripts`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload),
      });
      const body = await responseJson<{ message: string }>(response);
      message = `${body.message}；新版本不会自动迁移批准指针`;
    } catch (error) {
      message = `稿件保存失败：${(error as Error).message}`;
    }
    try { await refreshAfterWrite(expectedRoute); }
    catch (error) { message += `；服务端回读失败：${(error as Error).message}`; }
    if (mounted.current && currentRoute.current === expectedRoute) { setStatus(message); setBusy(false); }
    writing.current = false;
  }

  async function changeApproval(action: "approve" | "withdraw") {
    if (writing.current || !approval) return;
    writing.current = true;
    const expectedRoute = routeKey;
    setBusy(true); setStatus(action === "approve" ? "正在提交人工批准…" : "正在撤回人工批准…");
    let message = "";
    try {
      const payload = approvalPutPayload(action, approval, selectedPackagedId);
      const response = await fetch(`${baseUrl}/approval`, {
        method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(payload),
      });
      if (response.status === 409) {
        try { await responseJson(response); } catch (error) { message = `批准状态已变化：${(error as Error).message}；已刷新，请重新确认`; }
      } else {
        const body = await responseJson<{ message: string }>(response);
        message = body.message;
      }
    } catch (error) {
      message = `批准操作失败：${(error as Error).message}`;
    }
    try { await refreshAfterWrite(expectedRoute); }
    catch (error) { message += `；服务端回读失败：${(error as Error).message}`; }
    if (mounted.current && currentRoute.current === expectedRoute) { setStatus(message); setBusy(false); }
    writing.current = false;
  }

  return {
    episode, scripts, approval, kind, parentVersionId, paragraphs, selectedPackagedId, contractVersion,
    pendingLoadVersion, pendingKind,
    voice, rate, charactersPerSecond, narrationOccupancy, calibration,
    setVoice, setRate, setCharactersPerSecond, setNarrationOccupancy,
    setParentVersionId: chooseParent, setSelectedPackagedId, changeKind, confirmChangeKind,
    cancelChangeKind: () => setPendingKind(undefined), loadVersion, confirmLoadVersion, cancelLoadVersion,
    draftDirty,
    updateParagraph,
    addParagraph: () => setParagraphs((current) => [...current, emptyScriptParagraph()]),
    removeParagraph: (key: string) => setParagraphs((current) => current.length === 1 ? current : current.filter((item) => item.key !== key)),
    saveVersion, changeApproval, generateScripts,
  };
}
