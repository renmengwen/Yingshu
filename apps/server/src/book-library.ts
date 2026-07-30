import { randomUUID } from "node:crypto";
import { closeSync, fsyncSync, mkdirSync, openSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { open, readdir, readFile, rm } from "node:fs/promises";
import { resolve, sep } from "node:path";
import type { DatabaseSync } from "node:sqlite";

import { withDataFileMutationLock } from "./data-file-mutation-lock.js";

export class BookLibraryError extends Error {
  constructor(
    readonly statusCode: number,
    message: string,
  ) {
    super(message);
  }
}

export function listBooks(database: DatabaseSync) {
  return database
    .prepare(
      `SELECT books.id, books.title, books.author, books.encoding, books.import_status,
              books.created_at, COUNT(chapters.id) AS chapter_count
       FROM books LEFT JOIN chapters ON chapters.book_id = books.id
       GROUP BY books.id ORDER BY books.created_at DESC, books.id`,
    )
    .all();
}

const RELATED_BOOK_JOBS = `
  WITH target_book(id) AS (SELECT id FROM books WHERE id = ?),
  targets(value) AS (
    SELECT id FROM target_book
    UNION SELECT id FROM chapters WHERE book_id IN target_book
    UNION SELECT chapter_events.id FROM chapter_events
      JOIN chapters ON chapters.id = chapter_events.chapter_id WHERE chapters.book_id IN target_book
    UNION SELECT id FROM series_projects WHERE book_id IN target_book
    UNION SELECT episodes.id FROM episodes
      JOIN series_projects ON series_projects.id = episodes.series_project_id WHERE series_projects.book_id IN target_book
    UNION SELECT script_versions.id FROM script_versions
      JOIN episodes ON episodes.id = script_versions.episode_id
      JOIN series_projects ON series_projects.id = episodes.series_project_id WHERE series_projects.book_id IN target_book
    UNION SELECT assets.id FROM assets
      JOIN series_projects ON series_projects.id = assets.series_project_id WHERE series_projects.book_id IN target_book
    UNION SELECT asset_candidates.id FROM asset_candidates
      JOIN assets ON assets.id = asset_candidates.asset_id
      JOIN series_projects ON series_projects.id = assets.series_project_id WHERE series_projects.book_id IN target_book
    UNION SELECT visual_segments.id FROM visual_segments
      JOIN episodes ON episodes.id = visual_segments.episode_id
      JOIN series_projects ON series_projects.id = episodes.series_project_id WHERE series_projects.book_id IN target_book
  )
  SELECT DISTINCT jobs.id, jobs.status FROM jobs
  WHERE EXISTS (
    SELECT 1 FROM json_tree(CASE WHEN json_valid(jobs.payload_json) THEN jobs.payload_json ELSE 'null' END)
    WHERE type = 'text' AND value IN targets
  ) OR EXISTS (
    SELECT 1 FROM json_tree(CASE WHEN json_valid(jobs.result_json) THEN jobs.result_json ELSE 'null' END)
    WHERE type = 'text' AND value IN targets
  )`;

function controlledDataPath(dataRoot: string, relativePath: string) {
  const root = resolve(dataRoot);
  const path = resolve(root, relativePath);
  if (path === root || !path.startsWith(`${root}${sep}`)) throw new BookLibraryError(500, "书籍本地文件路径无效");
  return path;
}

interface BookDeletionManifest {
  version: 1;
  bookId: string;
  paths: string[];
}

function validDeletionPath(bookId: string, relativePath: string) {
  return relativePath === `books/${bookId}`
    || /^episodes\/[A-Za-z0-9_-]+$/.test(relativePath)
    || /^assets\/candidates\/[0-9a-f]{2}\/[0-9a-f]{64}\.(?:jpg|png|webp)$/.test(relativePath);
}

function parseDeletionManifest(value: unknown): BookDeletionManifest | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const manifest = value as Partial<BookDeletionManifest>;
  if (manifest.version !== 1 || typeof manifest.bookId !== "string" || !/^[A-Za-z0-9_-]+$/.test(manifest.bookId)) {
    return undefined;
  }
  if (!Array.isArray(manifest.paths) || !manifest.paths.every(
    (path): path is string => typeof path === "string" && validDeletionPath(manifest.bookId!, path),
  )) return undefined;
  return { version: 1, bookId: manifest.bookId, paths: [...new Set(manifest.paths)] };
}

function writeDeletionManifest(dataRoot: string, manifest: BookDeletionManifest) {
  const root = controlledDataPath(dataRoot, ".trash/book-deletions");
  mkdirSync(root, { recursive: true });
  const path = controlledDataPath(root, `${randomUUID()}.json`);
  const temporary = `${path}.tmp`;
  const handle = openSync(temporary, "wx");
  try {
    writeFileSync(handle, JSON.stringify(manifest), "utf8");
    fsyncSync(handle);
  } finally {
    closeSync(handle);
  }
  renameSync(temporary, path);
  try {
    const directory = openSync(root, "r");
    try { fsyncSync(directory); } finally { closeSync(directory); }
  } catch { /* Windows 不保证目录句柄可 fsync；文件本身已经落盘。 */ }
  return path;
}

async function cleanupDeletionManifest(
  database: DatabaseSync,
  dataRoot: string,
  manifestPath: string,
  removePath: typeof rm,
) {
  let manifest: BookDeletionManifest | undefined;
  try {
    manifest = parseDeletionManifest(JSON.parse(await readFile(manifestPath, "utf8")));
  } catch {
    return false;
  }
  if (!manifest) return false;
  return withDataFileMutationLock(dataRoot, async () => {
    if (database.prepare("SELECT 1 FROM books WHERE id = ?").get(manifest.bookId)) {
      try {
        await rm(manifestPath, { force: true });
        return true;
      } catch {
        return false;
      }
    }
    try {
      for (const relativePath of manifest.paths) {
        const episode = /^episodes\/([A-Za-z0-9_-]+)$/.exec(relativePath);
        const episodeId = episode?.[1];
        if (episodeId && database.prepare("SELECT 1 FROM episodes WHERE id = ?").get(episodeId)) return false;
        if (relativePath.startsWith("assets/candidates/") && database.prepare(
          "SELECT 1 FROM asset_candidates WHERE relative_path = ? LIMIT 1",
        ).get(relativePath)) return false;
        await removePath(controlledDataPath(dataRoot, relativePath), { recursive: true, force: true });
      }
      await rm(manifestPath, { force: true });
      return true;
    } catch {
      return false;
    }
  });
}

export async function cleanupPendingBookDeletions(
  database: DatabaseSync,
  dataRoot: string,
  removePath: typeof rm = rm,
) {
  const root = controlledDataPath(dataRoot, ".trash/book-deletions");
  const names = await readdir(root).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return [];
    throw error;
  });
  let completed = 0;
  let pending = 0;
  for (const name of names.filter((item) => /^[0-9a-f-]+\.json$/.test(item))) {
    if (await cleanupDeletionManifest(database, dataRoot, controlledDataPath(root, name), removePath)) completed += 1;
    else pending += 1;
  }
  return { completed, pending };
}

export async function deleteBook(database: DatabaseSync, dataRoot: string, bookId: string) {
  const deletion = await withDataFileMutationLock(dataRoot, async () => {
    let book: { id: string; title: string } | undefined;
    let manifestPath: string | undefined;
    database.exec("BEGIN IMMEDIATE");
    try {
      book = database.prepare("SELECT id, title FROM books WHERE id = ?").get(bookId) as
        | { id: string; title: string }
        | undefined;
      if (!book) throw new BookLibraryError(404, "书籍不存在");
      if (!/^[A-Za-z0-9_-]+$/.test(book.id)) throw new BookLibraryError(500, "书籍本地文件路径无效");

      const jobs = database.prepare(RELATED_BOOK_JOBS).all(book.id) as Array<{ id: string; status: string }>;
      if (jobs.some((job) => job.status === "running")) {
        throw new BookLibraryError(409, "书籍仍有任务正在执行，请等待任务结束后重试");
      }

      const episodeIds = database.prepare(
      `SELECT episodes.id FROM episodes
       JOIN series_projects ON series_projects.id = episodes.series_project_id
       WHERE series_projects.book_id = ?`,
    ).all(book.id) as Array<{ id: string }>;
      const unsharedCandidates = database.prepare(
      `SELECT DISTINCT asset_candidates.relative_path, asset_candidates.file_hash, asset_candidates.mime
       FROM asset_candidates
       JOIN assets ON assets.id = asset_candidates.asset_id
       JOIN series_projects ON series_projects.id = assets.series_project_id
       WHERE series_projects.book_id = ? AND NOT EXISTS (
         SELECT 1 FROM asset_candidates AS other_candidate
         JOIN assets AS other_asset ON other_asset.id = other_candidate.asset_id
         JOIN series_projects AS other_series ON other_series.id = other_asset.series_project_id
         WHERE other_candidate.relative_path = asset_candidates.relative_path AND other_series.book_id <> ?
       )`,
    ).all(book.id, book.id) as Array<{ relative_path: string; file_hash: string; mime: string }>;

      const paths = new Set<string>([
      `books/${book.id}`,
      ...episodeIds.map((episode) => {
        if (!/^[A-Za-z0-9_-]+$/.test(episode.id)) throw new BookLibraryError(500, "分集本地文件路径无效");
        return `episodes/${episode.id}`;
      }),
      ...unsharedCandidates.map((candidate) => {
        const extension = candidate.mime === "image/jpeg" ? "jpg"
          : candidate.mime === "image/png" ? "png"
            : candidate.mime === "image/webp" ? "webp" : undefined;
        const expected = extension && /^[0-9a-f]{64}$/.test(candidate.file_hash)
          ? `assets/candidates/${candidate.file_hash.slice(0, 2)}/${candidate.file_hash}.${extension}`
          : undefined;
        if (!expected || candidate.relative_path !== expected) {
          throw new BookLibraryError(500, "候选图片本地文件路径无效");
        }
        return expected;
      }),
    ]);
      manifestPath = writeDeletionManifest(dataRoot, { version: 1, bookId: book.id, paths: [...paths] });

      const deleteJob = database.prepare("DELETE FROM jobs WHERE id = ?");
      database.prepare("DELETE FROM books WHERE id = ?").run(book.id);
      for (const job of jobs) deleteJob.run(job.id);
      database.exec("COMMIT");
      return { book, manifestPath };
    } catch (error) {
      try { database.exec("ROLLBACK"); } catch { /* 保留原始删除错误。 */ }
      if (manifestPath) rmSync(manifestPath, { force: true });
      throw error;
    }
  });
  const fileCleanupComplete = await cleanupDeletionManifest(database, dataRoot, deletion.manifestPath, rm);
  return { id: deletion.book.id, title: deletion.book.title, fileCleanupComplete };
}

export function listChapters(database: DatabaseSync, bookId: string, limit: number, offset: number) {
  const book = database.prepare("SELECT id FROM books WHERE id = ?").get(bookId);
  if (!book) throw new BookLibraryError(404, "书籍不存在");
  const items = database
    .prepare(
      `SELECT id, chapter_index, chapter_number, title, byte_start, byte_end, char_count, content_hash
       FROM chapters WHERE book_id = ? ORDER BY chapter_index LIMIT ? OFFSET ?`,
    )
    .all(bookId, limit, offset);
  const total = database.prepare("SELECT COUNT(*) AS count FROM chapters WHERE book_id = ?").get(bookId)?.count;
  return { items, total };
}

export function deleteChapter(database: DatabaseSync, bookId: string, chapterId: string) {
  database.exec("BEGIN IMMEDIATE");
  try {
    const chapter = database.prepare(
      "SELECT chapter_index, title FROM chapters WHERE id = ? AND book_id = ?",
    ).get(chapterId, bookId) as { chapter_index: number; title: string } | undefined;
    if (!chapter) throw new BookLibraryError(404, "章节不存在");
    if (database.prepare("SELECT 1 FROM episode_sources WHERE chapter_id = ? LIMIT 1").get(chapterId)) {
      throw new BookLibraryError(409, "章节已被分集引用，请先调整分集选材");
    }
    if (database.prepare(
      `SELECT 1 FROM jobs
       WHERE status IN ('queued', 'running')
         AND EXISTS (SELECT 1 FROM json_tree(jobs.payload_json) WHERE type = 'text' AND value = ?)
       LIMIT 1`,
    ).get(chapterId)) throw new BookLibraryError(409, "章节仍有任务正在执行，请稍后重试");

    database.prepare(
      `DELETE FROM jobs
       WHERE status NOT IN ('queued', 'running')
         AND (
           EXISTS (SELECT 1 FROM json_tree(jobs.payload_json) WHERE type = 'text' AND value = ?)
           OR (result_json IS NOT NULL AND json_valid(result_json)
             AND EXISTS (SELECT 1 FROM json_tree(jobs.result_json) WHERE type = 'text' AND value = ?))
         )`,
    ).run(chapterId, chapterId);
    database.prepare("DELETE FROM chapters WHERE id = ? AND book_id = ?").run(chapterId, bookId);
    database.exec("COMMIT");
    return { id: chapterId, title: chapter.title };
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

export async function readChapterText(database: DatabaseSync, dataRoot: string, bookId: string, chapterId: string) {
  const row = database
    .prepare(
      `SELECT chapters.byte_start, chapters.byte_end, books.encoding, books.original_file_path
       FROM chapters JOIN books ON books.id = chapters.book_id
       WHERE chapters.id = ? AND books.id = ?`,
    )
    .get(chapterId, bookId) as
    | { byte_start: number; byte_end: number; encoding: string; original_file_path: string }
    | undefined;
  if (!row) throw new BookLibraryError(404, "章节不存在");

  const root = resolve(dataRoot);
  const path = resolve(root, row.original_file_path);
  if (!path.startsWith(`${root}${sep}`)) throw new BookLibraryError(500, "原文路径无效");
  const length = row.byte_end - row.byte_start;
  const bytes = Buffer.alloc(length);
  const file = await open(path, "r").catch(() => {
    throw new BookLibraryError(500, "原文文件无法读取");
  });
  try {
    let read = 0;
    while (read < length) {
      const result = await file.read(bytes, read, length - read, row.byte_start + read);
      if (result.bytesRead === 0) throw new BookLibraryError(500, "原文文件不完整");
      read += result.bytesRead;
    }
  } finally {
    await file.close();
  }
  try {
    return new TextDecoder(row.encoding.toLowerCase(), { fatal: true }).decode(bytes);
  } catch {
    throw new BookLibraryError(500, "原文编码无效");
  }
}
