import { createHash, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

import {
  BOOK_STORY_BIBLE_CONTRACT_VERSION,
  canonicalBookStoryBibleJson,
  parseBookStoryBibleContent,
  type BookStoryBibleContent,
} from "./book-story-bible-contract.js";

const HASH = /^[0-9a-f]{64}$/u;
const MAX_PROVENANCE_LENGTH = 200;
const MAX_SOURCE_EVENTS = 20_000;
const MAX_PARENTS = 2_000;

export type BookStoryBibleScope = "interval" | "final";

export interface BookStoryBibleInput {
  bookId: string;
  scope: BookStoryBibleScope;
  sourceStartChapterId: string;
  sourceEndChapterId: string;
  sourceEventIds: string[];
  parentBibleIds?: string[];
  providerId: string;
  model: string;
  jobId?: string | null;
  content: unknown;
}

interface BibleRow {
  id: string;
  book_id: string;
  scope: BookStoryBibleScope;
  source_start_chapter_id: string;
  source_end_chapter_id: string;
  source_event_ids_json: string;
  source_events_hash: string;
  parent_bible_ids_json: string;
  input_hash: string;
  contract_version: string;
  revision: number;
  provider_id: string;
  model: string;
  job_id: string | null;
  content_json: string;
  content_hash: string;
  created_at: number;
  invalidated_at: number | null;
}

interface ChapterRow { id: string; chapter_index: number }

export class BookStoryBibleStoreError extends Error {
  constructor(readonly statusCode: number, message: string) { super(message); }
}

function sha256(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

function plainText(value: unknown, label: string, maximum = MAX_PROVENANCE_LENGTH) {
  if (typeof value !== "string") throw new BookStoryBibleStoreError(400, `${label}无效`);
  const normalized = value.trim();
  if (!normalized || normalized.length > maximum) throw new BookStoryBibleStoreError(400, `${label}无效`);
  return normalized;
}

function uniqueIds(value: unknown, label: string, maximum: number, allowEmpty: boolean) {
  if (!Array.isArray(value) || (!allowEmpty && value.length === 0) || value.length > maximum ||
      value.some((id) => typeof id !== "string" || !id.trim() || id.length > 200)) {
    throw new BookStoryBibleStoreError(400, `${label}无效`);
  }
  const normalized = value.map((id) => id.trim()).sort((left, right) => left.localeCompare(right));
  if (new Set(normalized).size !== normalized.length) throw new BookStoryBibleStoreError(400, `${label}不能重复`);
  return normalized;
}

function frozenParents(value: unknown) {
  if (!Array.isArray(value) || value.length > MAX_PARENTS) {
    throw new BookStoryBibleStoreError(409, "全书世界观冻结父层输入无效");
  }
  const parents = value.map((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item) || Object.getPrototypeOf(item) !== Object.prototype) {
      throw new BookStoryBibleStoreError(409, "全书世界观冻结父层输入无效");
    }
    const row = item as Record<string, unknown>;
    if (Object.keys(row).sort().join(",") !== "contentHash,id" || typeof row.id !== "string" || !row.id ||
        row.id.length > 200 || typeof row.contentHash !== "string" || !HASH.test(row.contentHash)) {
      throw new BookStoryBibleStoreError(409, "全书世界观冻结父层输入无效");
    }
    return { id: row.id, contentHash: row.contentHash };
  }).sort((left, right) => left.id.localeCompare(right.id));
  if (new Set(parents.map((parent) => parent.id)).size !== parents.length) {
    throw new BookStoryBibleStoreError(409, "全书世界观冻结父层输入不能重复");
  }
  return parents;
}

function range(database: DatabaseSync, bookId: string, startId: string, endId: string) {
  const rows = database.prepare(
    `SELECT id, chapter_index FROM chapters
     WHERE book_id = ? AND chapter_index BETWEEN
       (SELECT chapter_index FROM chapters WHERE id = ? AND book_id = ?)
       AND (SELECT chapter_index FROM chapters WHERE id = ? AND book_id = ?)
     ORDER BY chapter_index`,
  ).all(bookId, startId, bookId, endId, bookId) as unknown as ChapterRow[];
  if (!rows.length || rows[0]!.id !== startId || rows.at(-1)!.id !== endId) {
    throw new BookStoryBibleStoreError(409, "全书世界观覆盖章节无效或倒序");
  }
  return rows;
}

function sourceSnapshot(database: DatabaseSync, bookId: string, chapters: ChapterRow[], sourceEventIds: string[]) {
  const chapterIds = new Set(chapters.map((chapter) => chapter.id));
  const placeholders = sourceEventIds.map(() => "?").join(",");
  const rows = database.prepare(
    `SELECT event.id, event.chapter_id, chapter.chapter_index, event.event_index, event.occurrence,
            event.event_type, event.payload_json, source.source_index, source.source_byte_start,
            source.source_byte_end, source.source_hash
     FROM chapter_events event
     JOIN chapters chapter ON chapter.id = event.chapter_id
     LEFT JOIN chapter_event_sources source ON source.event_id = event.id
     WHERE event.id IN (${placeholders})
     ORDER BY chapter.chapter_index, event.event_index, event.id, source.source_index`,
  ).all(...sourceEventIds) as unknown as Array<Record<string, unknown> & { id: string; chapter_id: string }>;
  const found = new Set(rows.map((row) => row.id));
  if (found.size !== sourceEventIds.length || rows.some((row) => !chapterIds.has(row.chapter_id))) {
    throw new BookStoryBibleStoreError(409, "全书世界观引用了不存在、跨书或范围外的章节事件");
  }
  return sha256(JSON.stringify({ contract: "book-story-bible-source-events-v1", eventIds: sourceEventIds, rows }));
}

function validateContentChapters(content: BookStoryBibleContent, allowedChapterIds: ReadonlySet<string>) {
  const ids = [
    ...content.characters.flatMap((item) => item.stateChanges.flatMap((state) => state.chapterIds)),
    ...content.relationships.flatMap((item) => item.chapterIds),
    ...content.timeline.flatMap((item) => item.chapterIds),
    ...content.flashbacks.flatMap((item) => [item.startChapterId, item.endChapterId]),
    ...content.plotThreads.flatMap((item) => item.chapterIds),
  ];
  if (ids.some((id) => !allowedChapterIds.has(id))) {
    throw new BookStoryBibleStoreError(409, "全书世界观内容引用了覆盖范围外的章节");
  }
}

function parentSnapshot(
  database: DatabaseSync, bookId: string, chapters: ChapterRow[], parentBibleIds: string[],
) {
  if (!parentBibleIds.length) return [] as Array<{ id: string; contentHash: string }>;
  const rows = database.prepare(
    `SELECT bible.id, bible.book_id, bible.source_start_chapter_id, bible.source_end_chapter_id,
            bible.content_hash, start.chapter_index AS start_index, finish.chapter_index AS end_index
     FROM book_story_bibles bible
     JOIN chapters start ON start.id = bible.source_start_chapter_id
     JOIN chapters finish ON finish.id = bible.source_end_chapter_id
     WHERE bible.id IN (${parentBibleIds.map(() => "?").join(",")}) AND bible.invalidated_at IS NULL`,
  ).all(...parentBibleIds) as unknown as Array<{
    id: string; book_id: string; source_start_chapter_id: string; source_end_chapter_id: string;
    content_hash: string; start_index: number; end_index: number;
  }>;
  const minimum = chapters[0]!.chapter_index;
  const maximum = chapters.at(-1)!.chapter_index;
  if (rows.length !== parentBibleIds.length || rows.some((row) => row.book_id !== bookId ||
      row.start_index < minimum || row.end_index > maximum || !HASH.test(row.content_hash))) {
    throw new BookStoryBibleStoreError(409, "全书世界观父层输入不存在、失效或超出覆盖范围");
  }
  return rows.map((row) => ({ id: row.id, contentHash: row.content_hash }))
    .sort((left, right) => left.id.localeCompare(right.id));
}

function rowResult(database: DatabaseSync, row: BibleRow) {
  let sourceEventIds: string[];
  let parents: Array<{ id: string; contentHash: string }>;
  let rawContent: unknown;
  try {
    sourceEventIds = uniqueIds(JSON.parse(row.source_event_ids_json), "全书世界观来源事件", MAX_SOURCE_EVENTS, false);
    parents = frozenParents(JSON.parse(row.parent_bible_ids_json));
    rawContent = JSON.parse(row.content_json);
  } catch (error) {
    if (error instanceof BookStoryBibleStoreError) throw error;
    throw new BookStoryBibleStoreError(409, "全书世界观持久内容不是有效 JSON");
  }
  const chapters = range(database, row.book_id, row.source_start_chapter_id, row.source_end_chapter_id);
  const inputHash = sha256(JSON.stringify({ sourceEventsHash: row.source_events_hash, parents }));
  const content = parseBookStoryBibleContent(rawContent, new Set(sourceEventIds));
  validateContentChapters(content, new Set(chapters.map((chapter) => chapter.id)));
  const contentJson = canonicalBookStoryBibleJson(content);
  if (row.contract_version !== BOOK_STORY_BIBLE_CONTRACT_VERSION || !HASH.test(row.source_events_hash) ||
      row.input_hash !== inputHash || row.content_json !== contentJson || row.content_hash !== sha256(contentJson) ||
      row.source_event_ids_json !== JSON.stringify(sourceEventIds) ||
      row.parent_bible_ids_json !== JSON.stringify(parents)) {
    throw new BookStoryBibleStoreError(409, "全书世界观持久身份或内容校验失败");
  }
  return {
    id: row.id, bookId: row.book_id, scope: row.scope, sourceStartChapterId: row.source_start_chapter_id,
    sourceEndChapterId: row.source_end_chapter_id, sourceEventIds, sourceEventsHash: row.source_events_hash,
    parentBibleIds: parents.map((parent) => parent.id),
    inputHash, contractVersion: row.contract_version, revision: row.revision, providerId: row.provider_id,
    model: row.model, jobId: row.job_id, content, contentHash: row.content_hash, createdAt: row.created_at,
    invalidatedAt: row.invalidated_at,
  };
}

const SELECT_COLUMNS = `id, book_id, scope, source_start_chapter_id, source_end_chapter_id,
  source_event_ids_json, source_events_hash, parent_bible_ids_json, input_hash, contract_version,
  revision, provider_id, model, job_id, content_json, content_hash, created_at, invalidated_at`;

export function getBookStoryBible(database: DatabaseSync, id: string) {
  const row = database.prepare(`SELECT ${SELECT_COLUMNS} FROM book_story_bibles WHERE id = ?`).get(id) as BibleRow | undefined;
  if (!row) throw new BookStoryBibleStoreError(404, "全书世界观版本不存在");
  return rowResult(database, row);
}

export function findBookStoryBibleForJob(
  database: DatabaseSync,
  input: {
    jobId: string; bookId: string; scope: BookStoryBibleScope;
    sourceStartChapterId: string; sourceEndChapterId: string;
    sourceEventIds: readonly string[]; parentBibleIds?: readonly string[];
  },
) {
  const rows = database.prepare(
    `SELECT ${SELECT_COLUMNS} FROM book_story_bibles
     WHERE job_id = ? AND book_id = ? AND scope = ?
       AND source_start_chapter_id = ? AND source_end_chapter_id = ? AND invalidated_at IS NULL
     ORDER BY revision DESC`,
  ).all(input.jobId, input.bookId, input.scope, input.sourceStartChapterId,
    input.sourceEndChapterId) as unknown as BibleRow[];
  const sourceEventIds = [...input.sourceEventIds].sort((left, right) => left.localeCompare(right));
  const parentBibleIds = [...(input.parentBibleIds ?? [])].sort((left, right) => left.localeCompare(right));
  for (const row of rows) {
    const bible = rowResult(database, row);
    if (JSON.stringify(bible.sourceEventIds) === JSON.stringify(sourceEventIds) &&
        JSON.stringify(bible.parentBibleIds) === JSON.stringify(parentBibleIds)) return bible;
  }
  return undefined;
}

export function createBookStoryBible(
  database: DatabaseSync, input: BookStoryBibleInput, options: { forceRebuild?: boolean; now?: number } = {},
) {
  const bookId = plainText(input.bookId, "书籍");
  if (input.scope !== "interval" && input.scope !== "final") throw new BookStoryBibleStoreError(400, "全书世界观层级无效");
  const sourceEventIds = uniqueIds(input.sourceEventIds, "全书世界观来源事件", MAX_SOURCE_EVENTS, false);
  const parentBibleIds = uniqueIds(input.parentBibleIds ?? [], "全书世界观父层输入", MAX_PARENTS, true);
  const sourceStartChapterId = plainText(input.sourceStartChapterId, "起始章节");
  const sourceEndChapterId = plainText(input.sourceEndChapterId, "结束章节");
  const providerId = plainText(input.providerId, "模型服务");
  const model = plainText(input.model, "模型");
  const jobId = input.jobId == null ? null : plainText(input.jobId, "任务");
  const now = options.now ?? Date.now();
  if (!Number.isSafeInteger(now) || now < 0) throw new BookStoryBibleStoreError(400, "创建时间无效");

  database.exec("BEGIN IMMEDIATE");
  try {
    const chapters = range(database, bookId, sourceStartChapterId, sourceEndChapterId);
    const sourceEventsHash = sourceSnapshot(database, bookId, chapters, sourceEventIds);
    const parents = parentSnapshot(database, bookId, chapters, parentBibleIds);
    const inputHash = sha256(JSON.stringify({ sourceEventsHash, parents }));
    const content = parseBookStoryBibleContent(input.content, new Set(sourceEventIds));
    validateContentChapters(content, new Set(chapters.map((chapter) => chapter.id)));
    const contentJson = canonicalBookStoryBibleJson(content);
    const contentHash = sha256(contentJson);
    const identity = [bookId, input.scope, chapters[0]!.id, chapters.at(-1)!.id,
      sourceEventsHash, inputHash, BOOK_STORY_BIBLE_CONTRACT_VERSION];
    if (!options.forceRebuild) {
      const existing = database.prepare(
        `SELECT ${SELECT_COLUMNS} FROM book_story_bibles
         WHERE book_id = ? AND scope = ? AND source_start_chapter_id = ? AND source_end_chapter_id = ?
           AND source_events_hash = ? AND input_hash = ? AND contract_version = ? AND invalidated_at IS NULL
         ORDER BY revision DESC LIMIT 1`,
      ).get(...identity) as BibleRow | undefined;
      if (existing) {
        const result = rowResult(database, existing);
        database.exec("COMMIT");
        return result;
      }
    }
    const revision = Number(database.prepare(
      `SELECT COALESCE(MAX(revision), 0) + 1 AS revision FROM book_story_bibles
       WHERE book_id = ? AND scope = ? AND source_start_chapter_id = ? AND source_end_chapter_id = ?
         AND source_events_hash = ? AND input_hash = ? AND contract_version = ?`,
    ).get(...identity)?.revision);
    const id = `bible_${randomUUID()}`;
    database.prepare(
      `INSERT INTO book_story_bibles (
         id, book_id, scope, source_start_chapter_id, source_end_chapter_id, source_event_ids_json,
         source_events_hash, parent_bible_ids_json, input_hash, contract_version, revision,
         provider_id, model, job_id, content_json, content_hash, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(id, bookId, input.scope, chapters[0]!.id, chapters.at(-1)!.id, JSON.stringify(sourceEventIds),
      sourceEventsHash, JSON.stringify(parents), inputHash, BOOK_STORY_BIBLE_CONTRACT_VERSION,
      revision, providerId, model, jobId, contentJson, contentHash, now);
    const result = getBookStoryBible(database, id);
    database.exec("COMMIT");
    return result;
  } catch (error) {
    try { database.exec("ROLLBACK"); } catch { /* 保留原始写入错误。 */ }
    throw error;
  }
}

export function invalidateBookStoryBible(database: DatabaseSync, id: string, now = Date.now()) {
  if (!Number.isSafeInteger(now) || now < 0) throw new BookStoryBibleStoreError(400, "失效时间无效");
  const result = database.prepare(
    "UPDATE book_story_bibles SET invalidated_at = ? WHERE id = ? AND invalidated_at IS NULL",
  ).run(now, id);
  if (result.changes !== 1) throw new BookStoryBibleStoreError(404, "可失效的全书世界观版本不存在");
}
