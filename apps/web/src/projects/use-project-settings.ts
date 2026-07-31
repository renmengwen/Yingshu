import { useEffect, useRef, useState } from "react";

import { projectApi } from "./api";
import { validateProjectSettings } from "./input-logic";
import type { ProjectCreativeSettings } from "./types";

export function useProjectSettings(projectId: string) {
  const [draft, setDraft] = useState<ProjectCreativeSettings>();
  const [saved, setSaved] = useState<ProjectCreativeSettings>();
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("正在加载项目创作设置…");
  const [error, setError] = useState(false);
  const busyRef = useRef(false);
  const dirty = Boolean(draft && saved && (draft.scriptInstructions !== saved.scriptInstructions || draft.visualInstructions !== saved.visualInstructions));

  useEffect(() => {
    const controller = new AbortController();
    projectApi.getSettings(projectId, controller.signal).then(({ settings }) => {
      setDraft(settings);
      setSaved(settings);
      setLoaded(true);
      setStatus("项目创作设置已加载。");
    }).catch((cause: Error) => {
      if (cause.name === "AbortError") return;
      setLoaded(true);
      setError(true);
      setStatus(`项目创作设置加载失败：${cause.message}。请刷新页面重试。`);
    });
    return () => controller.abort();
  }, [projectId]);

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
    setStatus("正在保存项目创作设置…");
    try {
      const body = await projectApi.saveSettings(projectId, validateProjectSettings(draft));
      setDraft(body.settings);
      setSaved(body.settings);
      setStatus("项目创作设置已保存。");
    } catch (cause) {
      const interrupted = cause instanceof DOMException && cause.name === "AbortError";
      setError(!interrupted);
      setStatus(interrupted ? "项目创作设置保存已中断，未保存的内容仍保留在页面中。" : `项目创作设置保存失败：${(cause as Error).message}。请修正后重试。`);
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }

  return { draft, setDraft, loaded, busy, dirty, status, error, save };
}
