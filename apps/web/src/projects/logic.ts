export type AppRoute =
  | { page: "home" }
  | { page: "project"; projectId: string }
  | { page: "video"; projectId: string; videoId: string }
  | { page: "not-found" };

function decodeSegment(value: string) {
  try {
    return decodeURIComponent(value).trim() || undefined;
  } catch {
    return undefined;
  }
}

export function parseAppRoute(pathname: string): AppRoute {
  // 只接受本阶段公开的稳定路径，避免旧查询参数或多余层级误入工作区。
  const segments = pathname.replace(/\/+$/, "").split("/").filter(Boolean);
  if (!segments.length) return { page: "home" };
  if (segments[0] !== "projects") return { page: "not-found" };
  const projectId = segments[1] && decodeSegment(segments[1]);
  if (segments.length === 2 && projectId) return { page: "project", projectId };
  const videoId = segments[3] && decodeSegment(segments[3]);
  if (segments.length === 4 && projectId && segments[2] === "videos" && videoId) {
    return { page: "video", projectId, videoId };
  }
  return { page: "not-found" };
}

export function projectPath(projectId: string) {
  return `/projects/${encodeURIComponent(projectId)}`;
}

export function videoPath(projectId: string, videoId: string) {
  return `${projectPath(projectId)}/videos/${encodeURIComponent(videoId)}`;
}

export function normalizeName(value: string, label: "项目名称" | "视频标题") {
  const normalized = value.normalize("NFKC").trim().replace(/\s+/gu, " ");
  if (!normalized) throw new Error(`请输入${label}`);
  if ([...normalized].length > 100) throw new Error(`${label}不能超过100个字符`);
  return normalized;
}

export function formatUpdatedAt(value: number) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "更新时间未知" : `更新于 ${new Intl.DateTimeFormat("zh-CN", {
    year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit",
  }).format(date)}`;
}

export const VIDEO_STAGES = [
  "输入与来源",
  "文案与画面方案",
  "配图",
  "配音与字幕",
  "画面时间轴",
  "审核与导出",
] as const;
