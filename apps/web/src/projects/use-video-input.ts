import { useEffect, useRef, useState } from "react";

import { projectApi } from "./api";
import { validateVideoInput } from "./input-logic";
import { normalizeVideoInputDraft, type VideoInputDraft } from "./types";

function editableValue(input: VideoInputDraft) {
  const { updatedAt: _, ...editable } = input;
  return editable;
}

export function useVideoInput(projectId: string, videoId: string, onSaved?: () => void) {
  const [draft, setDraft] = useState<VideoInputDraft>();
  const [saved, setSaved] = useState<VideoInputDraft>();
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("正在加载创作输入草稿…");
  const [error, setError] = useState(false);
  const busyRef = useRef(false);
  const draftRef = useRef<VideoInputDraft | undefined>(undefined);
  const failedValueRef = useRef<string | undefined>(undefined);
  const onSavedRef = useRef(onSaved);
  onSavedRef.current = onSaved;
  draftRef.current = draft;
  const dirty = Boolean(
    draft &&
      saved &&
      JSON.stringify(editableValue(draft)) !== JSON.stringify(editableValue(saved)),
  );

  useEffect(() => {
    const controller = new AbortController();
    projectApi
      .getVideoInput(projectId, videoId, controller.signal)
      .then(({ input }) => {
        const normalized = normalizeVideoInputDraft(
          input as VideoInputDraft & { aspectRatio?: unknown },
        );
        setDraft(normalized);
        setSaved(normalized);
        setLoaded(true);
        setStatus("创作输入草稿已加载。");
      })
      .catch((cause: Error) => {
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

  useEffect(() => {
    if (!loaded || !dirty || busy || !draft) return;
    const value = JSON.stringify(editableValue(draft));
    if (failedValueRef.current === value) return;
    setStatus("修改将在停止输入后自动保存…");
    const timer = window.setTimeout(() => {
      void save(draft);
    }, 700);
    return () => window.clearTimeout(timer);
  }, [busy, dirty, draft, loaded]);

  async function save(submitted = draftRef.current) {
    if (!submitted || busyRef.current) return false;
    busyRef.current = true;
    setBusy(true);
    setError(false);
    setStatus("正在自动保存当前修改…");
    const submittedValue = JSON.stringify(editableValue(submitted));
    try {
      const body = await projectApi.saveVideoInput(
        projectId,
        videoId,
        validateVideoInput(submitted, { allowEmptyPrimary: true }),
      );
      const normalized = normalizeVideoInputDraft(
        body.input as VideoInputDraft & { aspectRatio?: unknown },
      );
      if (
        draftRef.current &&
        JSON.stringify(editableValue(draftRef.current)) === submittedValue
      ) {
        setDraft(normalized);
      }
      setSaved(normalized);
      failedValueRef.current = undefined;
      setStatus("所有修改已自动保存。");
      onSavedRef.current?.();
      return true;
    } catch (cause) {
      const interrupted = cause instanceof DOMException && cause.name === "AbortError";
      setError(!interrupted);
      failedValueRef.current = submittedValue;
      setStatus(
        interrupted
          ? "自动保存已中断，当前修改仍保留在页面中。"
          : `自动保存失败：${(cause as Error).message}。继续修改后将重试。`,
      );
      return false;
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }

  return { draft, setDraft, loaded, busy, dirty, status, error, save };
}
