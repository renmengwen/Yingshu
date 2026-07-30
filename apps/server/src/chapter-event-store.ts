import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { open } from "node:fs/promises";
import { resolve, sep } from "node:path";
import type { DatabaseSync } from "node:sqlite";

import type { CheckpointTransaction } from "./checkpoint-store.js";

export const CHAPTER_EVENT_TYPES = [
  "character", "location", "prop", "causality", "revelation", "suspense",
] as const;
export type ChapterEventType = (typeof CHAPTER_EVENT_TYPES)[number];

interface NamedPayload { name: string; detail?: string }
interface CausalityPayload { cause: string; effect: string }
interface RevelationPayload { fact: string }
interface SuspensePayload { question: string }
export type ChapterEventInput =
  | { type: "character" | "location" | "prop"; payload: NamedPayload; occurrence?: number; sources: ChapterEventSourceInput[] }
  | { type: "causality"; payload: CausalityPayload; occurrence?: number; sources: ChapterEventSourceInput[] }
  | { type: "revelation"; payload: RevelationPayload; occurrence?: number; sources: ChapterEventSourceInput[] }
  | { type: "suspense"; payload: SuspensePayload; occurrence?: number; sources: ChapterEventSourceInput[] };

export interface ChapterEventSourceInput { byteStart: number; byteEnd: number }
export interface PreparedChapterEventSource extends ChapterEventSourceInput {
  sourceIndex: number;
  sourceHash: string;
  sourceText: string;
}
export interface PreparedChapterEvent {
  id: string;
  chapterId: string;
  eventIndex: number;
  occurrence: number;
  type: ChapterEventType;
  payload: NamedPayload | CausalityPayload | RevelationPayload | SuspensePayload;
  sources: PreparedChapterEventSource[];
}

interface ChapterSourceRow {
  chapter_id: string;
  byte_start: number;
  byte_end: number;
  content_hash: string;
  encoding: string;
  original_file_path: string;
}
interface EventRow {
  id: string; chapter_id: string; event_index: number; occurrence: number;
  event_type: ChapterEventType; payload_json: string; created_at: number;
}
interface SourceRow {
  event_id: string; source_index: number; source_byte_start: number;
  source_byte_end: number; source_hash: string;
}

const EVENT_TYPE_SET = new Set<string>(CHAPTER_EVENT_TYPES);
const MAX_EVENTS_PER_CHAPTER = 200;
const MAX_SOURCES_PER_EVENT = 20;
const MAX_TEXT_LENGTH = 2_000;
const MAX_EVIDENCE_BYTES = 1024 * 1024;
const MAX_TOTAL_EVIDENCE_BYTES = 8 * 1024 * 1024;

export class ChapterEventError extends Error {
  constructor(readonly statusCode: number, message: string) { super(message); }
}

function sourceRow(database: DatabaseSync, bookId: string, chapterId: string) {
  const row = database.prepare(
    `SELECT chapters.id AS chapter_id, chapters.byte_start, chapters.byte_end,
            chapters.content_hash, books.encoding, books.original_file_path
     FROM chapters JOIN books ON books.id = chapters.book_id
     WHERE books.id = ? AND chapters.id = ?`,
  ).get(bookId, chapterId) as ChapterSourceRow | undefined;
  if (!row) throw new ChapterEventError(404, "章节不存在");
  return row;
}

function text(value: unknown, label: string, optional = false) {
  if (value === undefined && optional) return undefined;
  if (typeof value !== "string") throw new ChapterEventError(400, `${label}不能为空`);
  const normalized = value.trim();
  if (!normalized || normalized.length > MAX_TEXT_LENGTH) {
    throw new ChapterEventError(400, `${label}长度必须在 1～${MAX_TEXT_LENGTH} 个字符之间`);
  }
  return normalized;
}

function payload(type: ChapterEventType, value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ChapterEventError(400, "章节事件内容无效");
  }
  const item = value as Record<string, unknown>;
  if (type === "character" || type === "location" || type === "prop") {
    return { name: text(item.name, "事件名称")!, detail: text(item.detail, "事件详情", true) };
  }
  if (type === "causality") return { cause: text(item.cause, "原因")!, effect: text(item.effect, "结果")! };
  if (type === "revelation") return { fact: text(item.fact, "揭示内容")! };
  return { question: text(item.question, "悬念问题")! };
}

async function hashRange(path: string, start: number, end: number) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path, { start, end: end - 1 })) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

async function validateBoundaries(
  path: string,
  chapterStart: number,
  chapterEnd: number,
  positions: readonly number[],
  encoding: string,
) {
  const boundaries = [...new Set(positions)].sort((left, right) => left - right);
  const decoder = new TextDecoder(encoding.toLowerCase(), { fatal: true });
  let absoluteOffset = chapterStart;
  let boundaryIndex = boundaries[0] === chapterStart ? 1 : 0;
  try {
    for await (const rawChunk of createReadStream(path, { start: chapterStart, end: chapterEnd - 1 })) {
      const chunk = rawChunk as Buffer;
      let chunkOffset = 0;
      while (boundaryIndex < boundaries.length) {
        const relativeBoundary = boundaries[boundaryIndex]! - absoluteOffset;
        if (relativeBoundary > chunk.length) break;
        decoder.decode(chunk.subarray(chunkOffset, relativeBoundary), { stream: true });
        decoder.decode();
        chunkOffset = relativeBoundary;
        boundaryIndex += 1;
      }
      decoder.decode(chunk.subarray(chunkOffset), { stream: true });
      absoluteOffset += chunk.length;
    }
    decoder.decode();
  } catch (error) {
    if (error instanceof TypeError) throw new ChapterEventError(422, "原文证据范围未对齐有效字符边界");
    throw new ChapterEventError(500, "原文文件无法读取");
  }
  if (absoluteOffset !== chapterEnd || boundaryIndex !== boundaries.length) {
    throw new ChapterEventError(500, "原文文件不完整");
  }
}

async function readExact(path: string, start: number, end: number) {
  const bytes = Buffer.alloc(end - start);
  const file = await open(path, "r").catch(() => { throw new ChapterEventError(500, "原文文件无法读取"); });
  try {
    let read = 0;
    while (read < bytes.length) {
      const result = await file.read(bytes, read, bytes.length - read, start + read);
      if (result.bytesRead === 0) throw new ChapterEventError(500, "原文文件不完整");
      read += result.bytesRead;
    }
    return bytes;
  } finally {
    await file.close();
  }
}

function sourceInput(value: unknown, chapter: ChapterSourceRow) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ChapterEventError(422, "原文证据范围无效");
  }
  const item = value as Record<string, unknown>;
  const byteStart = item.byteStart;
  const byteEnd = item.byteEnd;
  if (!Number.isSafeInteger(byteStart) || !Number.isSafeInteger(byteEnd) ||
      (byteStart as number) < chapter.byte_start || (byteEnd as number) > chapter.byte_end ||
      (byteEnd as number) <= (byteStart as number)) {
    throw new ChapterEventError(422, "原文证据范围必须位于当前章节内且不能为空");
  }
  if ((byteEnd as number) - (byteStart as number) > MAX_EVIDENCE_BYTES) {
    throw new ChapterEventError(422, `单条原文证据不能超过 ${MAX_EVIDENCE_BYTES} 字节`);
  }
  return { byteStart: byteStart as number, byteEnd: byteEnd as number };
}

export async function prepareChapterEvents(
  database: DatabaseSync, dataRoot: string, bookId: string, chapterId: string,
  inputs: readonly ChapterEventInput[],
) {
  if (!Array.isArray(inputs)) throw new ChapterEventError(400, "章节事件参数无效");
  if (inputs.length > MAX_EVENTS_PER_CHAPTER) {
    throw new ChapterEventError(400, `每章事件数量不能超过 ${MAX_EVENTS_PER_CHAPTER}`);
  }
  const chapter = sourceRow(database, bookId, chapterId);
  const root = resolve(dataRoot);
  const path = resolve(root, chapter.original_file_path);
  if (!path.startsWith(`${root}${sep}`)) throw new ChapterEventError(500, "原文路径无效");
  let currentHash: string;
  try {
    currentHash = await hashRange(path, chapter.byte_start, chapter.byte_end);
  } catch {
    throw new ChapterEventError(500, "原文文件无法读取");
  }
  if (currentHash !== chapter.content_hash) throw new ChapterEventError(409, "原文内容已变化，请重新索引");

  const identities = new Set<string>();
  let totalEvidenceBytes = 0;
  const normalized = [] as Array<{
    eventIndex: number;
    occurrence: number;
    type: ChapterEventType;
    payload: NamedPayload | CausalityPayload | RevelationPayload | SuspensePayload;
    sources: Array<{ byteStart: number; byteEnd: number }>;
    identity: string;
  }>;
  const boundaries = [chapter.byte_start, chapter.byte_end];
  for (let eventIndex = 0; eventIndex < inputs.length; eventIndex += 1) {
    const input = inputs[eventIndex] as ChapterEventInput | undefined;
    if (!input || typeof input !== "object" || !EVENT_TYPE_SET.has(input.type)) {
      throw new ChapterEventError(400, "章节事件类型无效");
    }
    const occurrence = input.occurrence ?? 0;
    if (!Number.isSafeInteger(occurrence) || occurrence < 0) throw new ChapterEventError(400, "事件序号无效");
    if (!Array.isArray(input.sources) || input.sources.length < 1 || input.sources.length > MAX_SOURCES_PER_EVENT) {
      throw new ChapterEventError(400, `每个事件必须包含 1～${MAX_SOURCES_PER_EVENT} 条原文证据`);
    }
    const normalizedPayload = payload(input.type, input.payload);
    const normalizedSources = input.sources.map((item) => sourceInput(item, chapter));
    const uniqueRanges = new Set(normalizedSources.map((item) => `${item.byteStart}:${item.byteEnd}`));
    if (uniqueRanges.size !== normalizedSources.length) throw new ChapterEventError(422, "同一事件不能重复引用相同原文范围");
    totalEvidenceBytes += normalizedSources.reduce(
      (total, item) => total + item.byteEnd - item.byteStart,
      0,
    );
    if (totalEvidenceBytes > MAX_TOTAL_EVIDENCE_BYTES) {
      throw new ChapterEventError(422, `每章原文证据总量不能超过 ${MAX_TOTAL_EVIDENCE_BYTES} 字节`);
    }
    const ranges = normalizedSources.map((item) => `${item.byteStart}:${item.byteEnd}`).join("|");
    const identity = `${input.type}\0${ranges}\0${occurrence}`;
    if (identities.has(identity)) throw new ChapterEventError(400, "章节事件身份重复");
    identities.add(identity);
    for (const source of normalizedSources) boundaries.push(source.byteStart, source.byteEnd);
    normalized.push({
      eventIndex, occurrence, type: input.type, payload: normalizedPayload,
      sources: normalizedSources, identity,
    });
  }
  await validateBoundaries(path, chapter.byte_start, chapter.byte_end, boundaries, chapter.encoding);

  const events: PreparedChapterEvent[] = [];
  for (const event of normalized) {
    const sources: PreparedChapterEventSource[] = [];
    for (let sourceIndex = 0; sourceIndex < event.sources.length; sourceIndex += 1) {
      const source = event.sources[sourceIndex]!;
      const bytes = await readExact(path, source.byteStart, source.byteEnd);
      sources.push({
        ...source,
        sourceIndex,
        sourceHash: createHash("sha256").update(bytes).digest("hex"),
        sourceText: new TextDecoder(chapter.encoding.toLowerCase(), { fatal: true }).decode(bytes),
      });
    }
    events.push({
      id: `event_${createHash("sha256").update(`chapter-event-v1\0${chapterId}\0${event.identity}`).digest("hex")}`,
      chapterId,
      eventIndex: event.eventIndex,
      occurrence: event.occurrence,
      type: event.type,
      payload: event.payload,
      sources,
    });
  }
  let verifiedHash: string;
  try {
    verifiedHash = await hashRange(path, chapter.byte_start, chapter.byte_end);
  } catch {
    throw new ChapterEventError(500, "原文文件无法读取");
  }
  if (verifiedHash !== chapter.content_hash) {
    throw new ChapterEventError(409, "原文内容已变化，请重新索引");
  }
  return events;
}

export function queueChapterEventReplacement(
  transaction: CheckpointTransaction, chapterId: string, events: readonly PreparedChapterEvent[], now = Date.now(),
) {
  if (events.some((event) => event.chapterId !== chapterId)) {
    throw new Error("章节事件与目标章节不一致");
  }
  transaction.run("DELETE FROM chapter_events WHERE chapter_id = ?", chapterId);
  for (const event of events) {
    transaction.run(
      `INSERT INTO chapter_events (
         id, chapter_id, event_index, occurrence, event_type, payload_json, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      event.id, chapterId, event.eventIndex, event.occurrence, event.type, JSON.stringify(event.payload), now,
    );
    for (const source of event.sources) {
      transaction.run(
        `INSERT INTO chapter_event_sources (
           event_id, source_index, source_byte_start, source_byte_end, source_hash
         ) VALUES (?, ?, ?, ?, ?)`,
        event.id, source.sourceIndex, source.byteStart, source.byteEnd, source.sourceHash,
      );
    }
  }
}

export async function replaceChapterEvents(
  database: DatabaseSync, dataRoot: string, bookId: string, chapterId: string,
  inputs: readonly ChapterEventInput[],
) {
  const events = await prepareChapterEvents(database, dataRoot, bookId, chapterId, inputs);
  database.exec("BEGIN IMMEDIATE");
  try {
    queueChapterEventReplacement(
      { run(sql, ...parameters) { database.prepare(sql).run(...parameters); } }, chapterId, events,
    );
    database.exec("COMMIT");
  } catch (error) {
    try { database.exec("ROLLBACK"); } catch { /* 保留原始事件写入错误。 */ }
    throw error;
  }
  return events;
}

export async function listChapterEvents(
  database: DatabaseSync, dataRoot: string, bookId: string, chapterId: string, limit: number, offset: number,
) {
  const chapter = sourceRow(database, bookId, chapterId);
  const root = resolve(dataRoot);
  const path = resolve(root, chapter.original_file_path);
  if (!path.startsWith(`${root}${sep}`)) throw new ChapterEventError(500, "原文路径无效");
  let currentHash: string;
  try {
    currentHash = await hashRange(path, chapter.byte_start, chapter.byte_end);
  } catch {
    throw new ChapterEventError(500, "原文文件无法读取");
  }
  if (currentHash !== chapter.content_hash) throw new ChapterEventError(409, "原文内容已变化，请重新索引");
  const rows = database.prepare(
    `SELECT id, chapter_id, event_index, occurrence, event_type, payload_json, created_at
     FROM chapter_events WHERE chapter_id = ? ORDER BY event_index, id LIMIT ? OFFSET ?`,
  ).all(chapterId, limit, offset) as unknown as EventRow[];
  const items = [];
  for (const row of rows) {
    const sourceRows = database.prepare(
      `SELECT event_id, source_index, source_byte_start, source_byte_end, source_hash
       FROM chapter_event_sources WHERE event_id = ? ORDER BY source_index`,
    ).all(row.id) as unknown as SourceRow[];
    const sources = [];
    for (const source of sourceRows) {
      const bytes = await readExact(path, source.source_byte_start, source.source_byte_end);
      const hash = createHash("sha256").update(bytes).digest("hex");
      if (hash !== source.source_hash) throw new ChapterEventError(409, "原文内容已变化，请重新索引");
      sources.push({
        sourceIndex: source.source_index,
        byteStart: source.source_byte_start,
        byteEnd: source.source_byte_end,
        sourceHash: source.source_hash,
        sourceText: new TextDecoder(chapter.encoding.toLowerCase(), { fatal: true }).decode(bytes),
      });
    }
    items.push({
      id: row.id, chapterId: row.chapter_id, eventIndex: row.event_index, occurrence: row.occurrence,
      type: row.event_type, payload: JSON.parse(row.payload_json) as unknown, sources,
    });
  }
  const total = database.prepare("SELECT COUNT(*) AS count FROM chapter_events WHERE chapter_id = ?").get(chapterId)?.count;
  return { items, total };
}
