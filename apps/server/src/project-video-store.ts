import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

export interface Project {
  id: string;
  name: string;
  createdAt: number;
  updatedAt: number;
}

export interface ProjectSummary extends Project {
  videoCount: number;
}

export interface Video {
  id: string;
  projectId: string;
  title: string;
  status: VideoStatus;
  createdAt: number;
  updatedAt: number;
}

export type VideoStatus =
  | "draft"
  | "preparing_sources"
  | "generating_script"
  | "planning_visuals"
  | "awaiting_review"
  | "producing_media"
  | "awaiting_media_review"
  | "rendering"
  | "completed"
  | "failed"
  | "cancelled";

interface ProjectRow {
  id: string;
  name: string;
  created_at: number;
  updated_at: number;
}

interface ProjectSummaryRow extends ProjectRow {
  video_count: number;
}

interface VideoRow {
  id: string;
  project_id: string;
  title: string;
  status: VideoStatus;
  created_at: number;
  updated_at: number;
}

export class ProjectVideoStoreError extends Error {
  constructor(readonly statusCode: number, message: string) { super(message); }
}

export function normalizeProjectVideoText(value: unknown, label: string) {
  if (typeof value !== "string") throw new ProjectVideoStoreError(400, `${label}不能为空`);
  const text = value.normalize("NFKC").trim().replace(/\s+/gu, " ");
  if (!text) throw new ProjectVideoStoreError(400, `${label}不能为空`);
  if ([...text].length > 100) throw new ProjectVideoStoreError(400, `${label}不能超过 100 个字符`);
  return text;
}

function requiredId(value: unknown, label: string) {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new ProjectVideoStoreError(400, `${label}无效`);
  }
  return value;
}

function projectResult(row: ProjectRow): Project {
  return { id: row.id, name: row.name, createdAt: row.created_at, updatedAt: row.updated_at };
}

function projectSummaryResult(row: ProjectSummaryRow): ProjectSummary {
  return { ...projectResult(row), videoCount: row.video_count };
}

function videoResult(row: VideoRow): Video {
  return {
    id: row.id,
    projectId: row.project_id,
    title: row.title,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function listProjects(database: DatabaseSync) {
  return (database.prepare(
    `SELECT projects.id, projects.name, projects.created_at, projects.updated_at,
            COUNT(videos.id) AS video_count
     FROM projects LEFT JOIN videos ON videos.project_id = projects.id
     GROUP BY projects.id
     ORDER BY projects.updated_at DESC, projects.id`,
  ).all() as unknown as ProjectSummaryRow[]).map(projectSummaryResult);
}

export function createProject(database: DatabaseSync, input: { name?: unknown }, now = Date.now()) {
  const name = normalizeProjectVideoText(input?.name, "项目名称");
  const id = `project_${randomUUID()}`;
  database.prepare(
    "INSERT INTO projects (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)",
  ).run(id, name, now, now);
  return projectResult(database.prepare(
    "SELECT id, name, created_at, updated_at FROM projects WHERE id = ?",
  ).get(id) as unknown as ProjectRow);
}

export function getProject(database: DatabaseSync, projectId: string) {
  const id = requiredId(projectId, "项目 ID");
  const row = database.prepare(
    "SELECT id, name, created_at, updated_at FROM projects WHERE id = ?",
  ).get(id) as ProjectRow | undefined;
  if (!row) throw new ProjectVideoStoreError(404, "项目不存在");
  return projectResult(row);
}

export function deleteProject(database: DatabaseSync, projectId: string) {
  const project = getProject(database, projectId);
  database.prepare("DELETE FROM projects WHERE id = ?").run(project.id);
  return project;
}

export function listVideos(database: DatabaseSync, projectId: string) {
  const project = getProject(database, projectId);
  return (database.prepare(
    `SELECT id, project_id, title, status, created_at, updated_at
     FROM videos WHERE project_id = ? ORDER BY updated_at DESC, id`,
  ).all(project.id) as unknown as VideoRow[]).map(videoResult);
}

export function createVideo(
  database: DatabaseSync,
  projectId: string,
  input: { title?: unknown },
  now = Date.now(),
) {
  const project = getProject(database, projectId);
  const title = normalizeProjectVideoText(input?.title, "视频标题");
  const id = `video_${randomUUID()}`;
  const updatedAt = Math.max(now, project.updatedAt + 1);

  // 视频和项目更新时间必须原子提交，避免首页摘要与视频列表出现不一致。
  database.exec("BEGIN IMMEDIATE");
  try {
    database.prepare(
      `INSERT INTO videos (id, project_id, title, status, created_at, updated_at)
       VALUES (?, ?, ?, 'draft', ?, ?)`,
    ).run(id, project.id, title, now, now);
    database.prepare("UPDATE projects SET updated_at = ? WHERE id = ?").run(updatedAt, project.id);
    database.exec("COMMIT");
  } catch (error) {
    try { database.exec("ROLLBACK"); } catch { /* 保留原始写入错误。 */ }
    throw error;
  }

  return videoResult(database.prepare(
    `SELECT id, project_id, title, status, created_at, updated_at FROM videos WHERE id = ?`,
  ).get(id) as unknown as VideoRow);
}

export function getVideo(database: DatabaseSync, projectId: string, videoId: string) {
  const normalizedProjectId = requiredId(projectId, "项目 ID");
  const normalizedVideoId = requiredId(videoId, "视频 ID");
  const row = database.prepare(
    `SELECT id, project_id, title, status, created_at, updated_at
     FROM videos WHERE id = ? AND project_id = ?`,
  ).get(normalizedVideoId, normalizedProjectId) as VideoRow | undefined;
  if (!row) {
    if (!database.prepare("SELECT 1 FROM projects WHERE id = ?").get(normalizedProjectId)) {
      throw new ProjectVideoStoreError(404, "项目不存在");
    }
    throw new ProjectVideoStoreError(404, "视频不存在或不属于当前项目");
  }
  return videoResult(row);
}

export function deleteVideo(database: DatabaseSync, projectId: string, videoId: string, now = Date.now()) {
  const video = getVideo(database, projectId, videoId);
  const project = getProject(database, projectId);
  const updatedAt = Math.max(now, project.updatedAt + 1);

  database.exec("BEGIN IMMEDIATE");
  try {
    database.prepare("DELETE FROM videos WHERE id = ? AND project_id = ?").run(video.id, project.id);
    database.prepare("UPDATE projects SET updated_at = ? WHERE id = ?").run(updatedAt, project.id);
    database.exec("COMMIT");
  } catch (error) {
    try { database.exec("ROLLBACK"); } catch { /* 保留原始删除错误。 */ }
    throw error;
  }
  return video;
}
