import { createHash } from "node:crypto";
import { open } from "node:fs/promises";
import { resolve, sep } from "node:path";
import type { DatabaseSync } from "node:sqlite";

import { EPISODE_DURATION_POLICY } from "./episode-policy.js";
import { withdrawScriptApprovalForEpisodeChange } from "./script-approval-store.js";

export interface SeriesProjectInput { id?: string; bookId: string; title: string }
export interface EpisodeInput {
  index: number;
  title: string;
  storyArc: string;
  targetDurationSeconds: number;
  recap?: string | null;
  nextHook?: string | null;
  sourceEventIds: string[];
}

interface ProjectRow {
  id: string; book_id: string; title: string; created_at: number; updated_at: number;
}
interface EpisodeRow {
  id: string; series_project_id: string; episode_index: number; title: string;
  story_arc: string; target_duration_seconds: number; recap: string | null;
  next_hook: string | null; created_at: number; updated_at: number;
}
interface SourceSnapshot {
  chapterId: string; sourceEventId: string; byteStart: number; byteEnd: number; sourceHash: string;
}
interface StoredSourceRow {
  source_index: number; chapter_id: string; source_event_id: string;
  source_byte_start: number; source_byte_end: number; source_hash: string;
  encoding: string; original_file_path: string;
}

export class EpisodeStoreError extends Error {
  constructor(readonly statusCode: number, message: string) { super(message); }
}

function requiredText(value: unknown, label: string) {
  if (typeof value !== "string" || !value.trim()) throw new EpisodeStoreError(400, `${label}不能为空`);
  return value.trim();
}

function optionalText(value: unknown, label: string) {
  if (value === undefined || value === null || value === "") return null;
  return requiredText(value, label);
}

function projectResult(row: ProjectRow) {
  return {
    id: row.id, bookId: row.book_id, title: row.title,
    createdAt: row.created_at, updatedAt: row.updated_at,
  };
}

function episodeResult(row: EpisodeRow) {
  return {
    id: row.id, seriesProjectId: row.series_project_id, index: row.episode_index,
    title: row.title, storyArc: row.story_arc, targetDurationSeconds: row.target_duration_seconds,
    recap: row.recap, nextHook: row.next_hook,
    createdAt: row.created_at, updatedAt: row.updated_at,
  };
}

export function createSeriesProject(database: DatabaseSync, input: SeriesProjectInput, now = Date.now()) {
  const bookId = requiredText(input.bookId, "书籍 ID");
  const title = requiredText(input.title, "系列标题");
  if (!database.prepare("SELECT id FROM books WHERE id = ?").get(bookId)) {
    throw new EpisodeStoreError(404, "书籍不存在");
  }
  const id = input.id
    ? requiredText(input.id, "系列项目 ID")
    : `series_${createHash("sha256").update(`series-project-v1\0${bookId}\0${title}`).digest("hex")}`;
  database.prepare(
    `INSERT INTO series_projects (id, book_id, title, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET title = excluded.title, updated_at = excluded.updated_at`,
  ).run(id, bookId, title, now, now);
  return projectResult(database.prepare(
    `SELECT id, book_id, title, created_at, updated_at FROM series_projects WHERE id = ?`,
  ).get(id) as unknown as ProjectRow);
}

export function listSeriesProjects(database: DatabaseSync, bookId: string) {
  return (database.prepare(
    `SELECT id, book_id, title, created_at, updated_at
     FROM series_projects WHERE book_id = ? ORDER BY created_at, id`,
  ).all(bookId) as unknown as ProjectRow[]).map(projectResult);
}

export function listEpisodes(database: DatabaseSync, seriesProjectId: string) {
  const id = requiredText(seriesProjectId, "系列项目 ID");
  if (!database.prepare("SELECT id FROM series_projects WHERE id = ?").get(id)) {
    throw new EpisodeStoreError(404, "系列项目不存在");
  }
  return (database.prepare(
    `SELECT id, series_project_id, episode_index, title, story_arc, target_duration_seconds,
            recap, next_hook, created_at, updated_at
     FROM episodes WHERE series_project_id = ? ORDER BY episode_index, id`,
  ).all(id) as unknown as EpisodeRow[]).map(episodeResult);
}

export function replaceEpisode(
  database: DatabaseSync, seriesProjectId: string, input: EpisodeInput, now = Date.now(),
) {
  const project = database.prepare(
    "SELECT id, book_id, title, created_at, updated_at FROM series_projects WHERE id = ?",
  ).get(seriesProjectId) as ProjectRow | undefined;
  if (!project) throw new EpisodeStoreError(404, "系列项目不存在");
  if (!Number.isSafeInteger(input.index) || input.index < 1) throw new EpisodeStoreError(400, "分集序号必须从 1 开始");
  if (!Number.isSafeInteger(input.targetDurationSeconds) ||
      input.targetDurationSeconds < EPISODE_DURATION_POLICY.minimumSeconds ||
      input.targetDurationSeconds > EPISODE_DURATION_POLICY.maximumSeconds) {
    throw new EpisodeStoreError(400, `目标时长必须为 ${EPISODE_DURATION_POLICY.minimumSeconds} 至 ${EPISODE_DURATION_POLICY.maximumSeconds} 秒`);
  }
  const title = requiredText(input.title, "分集标题");
  const storyArc = requiredText(input.storyArc, "故事弧");
  const recap = optionalText(input.recap, "前情回顾");
  const nextHook = optionalText(input.nextHook, "下集钩子");
  if (!Array.isArray(input.sourceEventIds) || input.sourceEventIds.length === 0 ||
      new Set(input.sourceEventIds).size !== input.sourceEventIds.length) {
    throw new EpisodeStoreError(400, "原文事件 ID 必须为非空且不能重复");
  }

  const snapshots: SourceSnapshot[] = [];
  const chapterIndexes = new Set<number>();
  for (const sourceEventId of input.sourceEventIds) {
    const rows = database.prepare(
      `SELECT chapter_events.id AS source_event_id, chapters.id AS chapter_id, chapters.book_id,
              chapter_event_sources.source_byte_start, chapter_event_sources.source_byte_end,
              chapter_event_sources.source_hash, chapters.chapter_index
       FROM chapter_events
       JOIN chapters ON chapters.id = chapter_events.chapter_id
       JOIN chapter_event_sources ON chapter_event_sources.event_id = chapter_events.id
       WHERE chapter_events.id = ? ORDER BY chapter_event_sources.source_index`,
    ).all(requiredText(sourceEventId, "原文事件 ID")) as unknown as Array<{
      source_event_id: string; chapter_id: string; book_id: string;
      source_byte_start: number; source_byte_end: number; source_hash: string; chapter_index: number;
    }>;
    if (rows.length === 0) throw new EpisodeStoreError(404, "原文事件不存在");
    if (rows.some((row) => row.book_id !== project.book_id)) {
      throw new EpisodeStoreError(409, "分集不能引用其他书籍的事件");
    }
    rows.forEach((row) => chapterIndexes.add(row.chapter_index));
    snapshots.push(...rows.map((row) => ({
      chapterId: row.chapter_id, sourceEventId: row.source_event_id,
      byteStart: row.source_byte_start, byteEnd: row.source_byte_end, sourceHash: row.source_hash,
    })));
  }

  const id = `episode_${createHash("sha256")
    .update(`episode-v1\0${seriesProjectId}\0${input.index}`).digest("hex")}`;
  const existing = database.prepare(
    `SELECT id, series_project_id, episode_index, title, story_arc, target_duration_seconds,
            recap, next_hook, created_at, updated_at FROM episodes WHERE id = ?`,
  ).get(id) as EpisodeRow | undefined;
  const stored = existing ? database.prepare(
    `SELECT chapter_id, source_event_id, source_byte_start, source_byte_end, source_hash
     FROM episode_sources WHERE episode_id = ? ORDER BY source_index`,
  ).all(id) as unknown as Array<{
    chapter_id: string; source_event_id: string; source_byte_start: number;
    source_byte_end: number; source_hash: string;
  }> : [];
  const sourcesMatch = stored.length === snapshots.length && stored.every((source, index) => {
    const next = snapshots[index]!;
    return source.chapter_id === next.chapterId && source.source_event_id === next.sourceEventId &&
      source.source_byte_start === next.byteStart && source.source_byte_end === next.byteEnd &&
      source.source_hash === next.sourceHash;
  });
  const orderedChapterIndexes = [...chapterIndexes].sort((left, right) => left - right);
  if (orderedChapterIndexes.some((value, index) => index > 0 && value !== orderedChapterIndexes[index - 1]! + 1)) {
    throw new EpisodeStoreError(409, "分集来源必须覆盖连续章节范围");
  }
  if (existing && existing.title === title && existing.story_arc === storyArc &&
      existing.target_duration_seconds === input.targetDurationSeconds && existing.recap === recap &&
      existing.next_hook === nextHook && sourcesMatch) return episodeResult(existing);
  const nested = database.isTransaction;
  database.exec(nested ? "SAVEPOINT replace_episode" : "BEGIN IMMEDIATE");
  try {
    database.prepare(
      `INSERT INTO episodes (
         id, series_project_id, episode_index, title, story_arc, target_duration_seconds,
         recap, next_hook, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(series_project_id, episode_index) DO UPDATE SET
         title = excluded.title, story_arc = excluded.story_arc,
         target_duration_seconds = excluded.target_duration_seconds,
         recap = excluded.recap, next_hook = excluded.next_hook, updated_at = excluded.updated_at`,
    ).run(id, seriesProjectId, input.index, title, storyArc, input.targetDurationSeconds,
      recap, nextHook, now, existing ? Math.max(now, existing.updated_at + 1) : now);
    database.prepare("DELETE FROM episode_sources WHERE episode_id = ?").run(id);
    const insertSource = database.prepare(
      `INSERT INTO episode_sources (
         episode_id, source_index, chapter_id, source_event_id,
         source_byte_start, source_byte_end, source_hash
       ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    snapshots.forEach((source, sourceIndex) => insertSource.run(
      id, sourceIndex, source.chapterId, source.sourceEventId,
      source.byteStart, source.byteEnd, source.sourceHash,
    ));
    if (existing && (existing.target_duration_seconds !== input.targetDurationSeconds || !sourcesMatch)) {
      withdrawScriptApprovalForEpisodeChange(database, id, now);
    }
    database.exec(nested ? "RELEASE SAVEPOINT replace_episode" : "COMMIT");
  } catch (error) {
    try {
      if (nested) database.exec("ROLLBACK TO SAVEPOINT replace_episode; RELEASE SAVEPOINT replace_episode");
      else database.exec("ROLLBACK");
    } catch { /* 保留原始写入错误。 */ }
    throw error;
  }
  return episodeResult(database.prepare(
    `SELECT id, series_project_id, episode_index, title, story_arc, target_duration_seconds,
            recap, next_hook, created_at, updated_at FROM episodes WHERE id = ?`,
  ).get(id) as unknown as EpisodeRow);
}

async function readExact(path: string, start: number, end: number) {
  const bytes = Buffer.alloc(end - start);
  const file = await open(path, "r").catch(() => { throw new EpisodeStoreError(500, "原文文件无法读取"); });
  try {
    let offset = 0;
    while (offset < bytes.length) {
      const result = await file.read(bytes, offset, bytes.length - offset, start + offset);
      if (result.bytesRead === 0) throw new EpisodeStoreError(500, "原文文件不完整");
      offset += result.bytesRead;
    }
    return bytes;
  } finally {
    await file.close();
  }
}

export async function getEpisode(
  database: DatabaseSync, dataRoot: string, seriesProjectId: string, index: number,
) {
  const row = database.prepare(
    `SELECT id, series_project_id, episode_index, title, story_arc, target_duration_seconds,
            recap, next_hook, created_at, updated_at
     FROM episodes WHERE series_project_id = ? AND episode_index = ?`,
  ).get(seriesProjectId, index) as EpisodeRow | undefined;
  if (!row) throw new EpisodeStoreError(404, "分集不存在");
  const sourceRows = database.prepare(
    `SELECT episode_sources.source_index, episode_sources.chapter_id,
            episode_sources.source_event_id, episode_sources.source_byte_start,
            episode_sources.source_byte_end, episode_sources.source_hash,
            books.encoding, books.original_file_path
     FROM episode_sources
     JOIN chapters ON chapters.id = episode_sources.chapter_id
     JOIN books ON books.id = chapters.book_id
     WHERE episode_sources.episode_id = ? ORDER BY episode_sources.source_index`,
  ).all(row.id) as unknown as StoredSourceRow[];
  const root = resolve(dataRoot);
  const sources = [];
  for (const source of sourceRows) {
    const path = resolve(root, source.original_file_path);
    if (!path.startsWith(`${root}${sep}`)) throw new EpisodeStoreError(500, "原文路径无效");
    const bytes = await readExact(path, source.source_byte_start, source.source_byte_end);
    if (createHash("sha256").update(bytes).digest("hex") !== source.source_hash) {
      throw new EpisodeStoreError(409, "原文内容已变化，请重新索引");
    }
    sources.push({
      sourceIndex: source.source_index, chapterId: source.chapter_id,
      sourceEventId: source.source_event_id, byteStart: source.source_byte_start,
      byteEnd: source.source_byte_end, sourceHash: source.source_hash,
      sourceText: new TextDecoder(source.encoding.toLowerCase(), { fatal: true }).decode(bytes),
    });
  }
  return { ...episodeResult(row), sources };
}
