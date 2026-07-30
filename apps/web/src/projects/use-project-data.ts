import { useCallback, useEffect, useRef, useState } from "react";

import { projectApi } from "./api";
import { normalizeName } from "./logic";
import type { Project, ProjectSummary, Video } from "./types";

export function useProjects() {
  const [items, setItems] = useState<ProjectSummary[]>();
  const [loaded, setLoaded] = useState(false);
  const [status, setStatus] = useState("正在加载项目…");
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);

  const load = useCallback(async (signal?: AbortSignal) => {
    const body = await projectApi.list(signal);
    setItems(body.items);
    setLoaded(true);
    setStatus(body.items.length ? `已加载${body.items.length}个项目。` : "还没有项目。创建项目后开始制作视频。");
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    load(controller.signal).catch((error: Error) => {
      if (error.name !== "AbortError") { setLoaded(true); setStatus(`项目加载失败：${error.message}。请稍后重试。`); }
    });
    return () => controller.abort();
  }, [load]);

  async function perform(action: () => Promise<void>) {
    // ref 在 React 提交新 disabled 状态前立即上锁，拦截同一帧内的重复点击。
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    try { await action(); } finally { busyRef.current = false; setBusy(false); }
  }

  const create = (rawName: string) => perform(async () => {
    const name = normalizeName(rawName, "项目名称");
    setStatus(`正在创建项目“${name}”…`);
    try {
      const { project } = await projectApi.create(name);
      setItems((current) => [{ ...project, videoCount: 0 }, ...(current ?? [])]);
      setStatus(`项目“${project.name}”已创建。`);
    } catch (error) {
      setStatus(`项目创建失败：${(error as Error).message}。请检查名称后重试。`);
      throw error;
    }
  });

  const remove = (project: ProjectSummary) => perform(async () => {
    setStatus(`正在删除项目“${project.name}”…`);
    try {
      const body = await projectApi.delete(project.id);
      setItems((current) => current?.filter((item) => item.id !== project.id));
      setStatus(body.message || `项目“${project.name}”已删除。`);
    } catch (error) {
      setStatus(`项目删除失败：${(error as Error).message}。请重试。`);
      throw error;
    }
  });

  return { items, loaded, status, busy, create, remove };
}

export function useProject(projectId: string) {
  const [project, setProject] = useState<Project>();
  const [videos, setVideos] = useState<Video[]>();
  const [loaded, setLoaded] = useState(false);
  const [status, setStatus] = useState("正在加载项目…");
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);

  useEffect(() => {
    const controller = new AbortController();
    Promise.all([projectApi.get(projectId, controller.signal), projectApi.listVideos(projectId, controller.signal)])
      .then(([projectBody, videosBody]) => {
        setProject(projectBody.project);
        setVideos(videosBody.items);
        setLoaded(true);
        setStatus(videosBody.items.length ? `已加载${videosBody.items.length}个草稿视频。` : "还没有视频。创建草稿后进入工作区。");
      })
      .catch((error: Error) => { if (error.name !== "AbortError") { setLoaded(true); setStatus(`项目加载失败：${error.message}。请返回首页确认项目是否存在。`); } });
    return () => controller.abort();
  }, [projectId]);

  async function createVideo(rawTitle: string) {
    if (busyRef.current) return;
    const title = normalizeName(rawTitle, "视频标题");
    busyRef.current = true;
    setBusy(true);
    setStatus(`正在创建草稿“${title}”…`);
    try {
      const body = await projectApi.createVideo(projectId, title);
      setVideos((current) => [body.video, ...(current ?? [])]);
      setStatus(`草稿“${body.video.title}”已创建。`);
      return body.video;
    } catch (error) {
      setStatus(`草稿创建失败：${(error as Error).message}。请检查标题后重试。`);
      throw error;
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }

  return { project, videos, loaded, status, busy, createVideo };
}

export function useVideo(projectId: string, videoId: string) {
  const [project, setProject] = useState<Project>();
  const [video, setVideo] = useState<Video>();
  const [loaded, setLoaded] = useState(false);
  const [status, setStatus] = useState("正在恢复视频工作区…");

  useEffect(() => {
    const controller = new AbortController();
    Promise.all([projectApi.get(projectId, controller.signal), projectApi.getVideo(projectId, videoId, controller.signal)])
      .then(([projectBody, videoBody]) => {
        setProject(projectBody.project);
        setVideo(videoBody.video);
        setLoaded(true);
        setStatus(`草稿“${videoBody.video.title}”已恢复。`);
      })
      .catch((error: Error) => { if (error.name !== "AbortError") { setLoaded(true); setStatus(`工作区恢复失败：${error.message}。请返回项目确认草稿是否存在。`); } });
    return () => controller.abort();
  }, [projectId, videoId]);

  return { project, video, loaded, status };
}
