import { useEffect, useRef, useState } from "react";

import { projectApi } from "./api";
import { validateVideoInput } from "./input-logic";
import type { VideoInputDraft } from "./types";

function editableValue(input: VideoInputDraft) {
  const { updatedAt: _, ...editable } = input;
  return editable;
}

export function useVideoInput(projectId: string, videoId: string) {
  const [draft, setDraft] = useState<VideoInputDraft>();
  const [saved, setSaved] = useState<VideoInputDraft>();
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("正在加载创作输入…");
  const [error, setError] = useState(false);
  const busyRef = useRef(false);
  const dirty = Boolean(draft && saved && JSON.stringify(editableValue(draft)) !== JSON.stringify(editableValue(saved)));

  useEffect(() => {
    const controller = new AbortController();
    projectApi.getVideoInput(projectId, videoId, controller.signal).then(({ input }) => {
      setDraft(input);
      setSaved(input);
      setLoaded(true);
      setStatus("创作输入草稿已加载。");
    }).catch((cause: Error) => {
      if (cause.name === "AbortError") return;
      setLoaded(true);
      setError(true);
      setStatus(`创作输入加载失败：${cause.message}。请返回项目确认视频是否存在。`);
    });
    return () => controller.abort();
  }, [projectId, videoId]);

  useEffect(() => {
    if (!dirty) return;
    const handler = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [dirty]);

  async function save() {
    if (!draft || busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setError(false);
    setStatus("正在保存创作输入草稿…");
    try {
      const body = await projectApi.saveVideoInput(projectId, videoId, validateVideoInput(draft));
      setDraft(body.input);
      setSaved(body.input);
      setStatus("创作输入草稿已保存。下一步将生成文案和画面方案。");
    } catch (cause) {
      const interrupted = cause instanceof DOMException && cause.name === "AbortError";
      setError(!interrupted);
      setStatus(interrupted ? "草稿保存已中断，未保存的内容仍保留在页面中。" : `草稿保存失败：${(cause as Error).message}。请修正后重试。`);
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }

  return { draft, setDraft, loaded, busy, dirty, status, error, save };
}
