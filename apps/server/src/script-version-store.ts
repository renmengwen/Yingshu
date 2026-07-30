import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

export type ScriptVersionKind = "faithful" | "packaged";

export interface ScriptVersionInput {
  kind: ScriptVersionKind;
  parentVersionId?: string | null;
  paragraphs: Array<{ text: string; sourceIndexes: number[] }>;
}

interface VersionRow {
  id: string;
  episode_id: string;
  kind: ScriptVersionKind;
  version: number;
  parent_version_id: string | null;
  script_contract_version: 5 | 6;
  content_json: string;
  content_hash: string;
  created_at: number;
}

interface SourceRow {
  episode_source_index: number;
  chapter_id: string;
  source_event_id: string;
  source_byte_start: number;
  source_byte_end: number;
  source_hash: string;
}

export class ScriptVersionStoreError extends Error {
  constructor(readonly statusCode: number, message: string) { super(message); }
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`).join(",")}}`;
  }
  throw new ScriptVersionStoreError(400, "稿件内容必须是可序列化的 JSON");
}

function normalizedContent(paragraphs: ScriptVersionInput["paragraphs"]) {
  validateParagraphs(paragraphs);
  const contentJson = canonicalJson({
    paragraphs: paragraphs.map((paragraph) => ({
      text: paragraph.text.trim(), sourceIndexes: paragraph.sourceIndexes,
    })),
  });
  return { contentJson, contentHash: createHash("sha256").update(contentJson).digest("hex") };
}

export function scriptVersionId(input: {
  episodeId: string;
  kind: ScriptVersionKind;
  version: number;
  contentHash: string;
  parentVersionId: string | null;
}) {
  return `script_${createHash("sha256")
    .update(`script-version-v1\0${input.episodeId}\0${input.kind}\0${input.version}\0${input.contentHash}\0${input.parentVersionId ?? ""}`)
    .digest("hex")}`;
}

interface StoredVersionSourceRow extends SourceRow {
  segment_index: number;
  source_index: number;
}

function versionResult(database: DatabaseSync, row: VersionRow) {
  const content = JSON.parse(row.content_json) as { paragraphs: Array<{ text: string; sourceIndexes: number[] }> };
  const sourceRows = database.prepare(
    `SELECT segment_index, source_index, episode_source_index, chapter_id, source_event_id,
            source_byte_start, source_byte_end, source_hash
     FROM script_version_sources WHERE script_version_id = ? ORDER BY segment_index, source_index`,
  ).all(row.id) as unknown as StoredVersionSourceRow[];
  return {
    id: row.id,
    episodeId: row.episode_id,
    kind: row.kind,
    versionNumber: row.version,
    parentVersionId: row.parent_version_id,
    contractVersion: row.script_contract_version,
    contentHash: row.content_hash,
    paragraphs: content.paragraphs.map((paragraph, paragraphIndex) => ({
      text: paragraph.text,
      sources: sourceRows.filter((source) => source.segment_index === paragraphIndex).map((source) => ({
        episodeSourceIndex: source.episode_source_index,
        chapterId: source.chapter_id,
        sourceEventId: source.source_event_id,
        byteStart: source.source_byte_start,
        byteEnd: source.source_byte_end,
        sourceHash: source.source_hash,
      })),
    })),
  };
}

function validateParagraphs(paragraphs: ScriptVersionInput["paragraphs"]) {
  if (!Array.isArray(paragraphs) || paragraphs.length === 0) {
    throw new ScriptVersionStoreError(400, "稿件必须包含至少一个分段");
  }
  for (const paragraph of paragraphs) {
    if (!paragraph || typeof paragraph.text !== "string" || !paragraph.text.trim() ||
        !Array.isArray(paragraph.sourceIndexes) || paragraph.sourceIndexes.length === 0 ||
        paragraph.sourceIndexes.some((source) => !Number.isSafeInteger(source) || source < 0) ||
        new Set(paragraph.sourceIndexes).size !== paragraph.sourceIndexes.length) {
      throw new ScriptVersionStoreError(400, "每个稿件分段必须引用非空且不重复的来源序号");
    }
  }
}

function sourceMap(database: DatabaseSync, episodeId: string, parentVersionId: string | null) {
  const rows = parentVersionId
    ? database.prepare(
      `SELECT DISTINCT episode_source_index, chapter_id, source_event_id,
              source_byte_start, source_byte_end, source_hash
       FROM script_version_sources WHERE script_version_id = ?`,
    ).all(parentVersionId)
    : database.prepare(
      `SELECT source_index AS episode_source_index, chapter_id, source_event_id,
              source_byte_start, source_byte_end, source_hash
       FROM episode_sources WHERE episode_id = ?`,
    ).all(episodeId);
  return new Map((rows as unknown as SourceRow[]).map((row) => [row.episode_source_index, row]));
}

export function validateStoredScriptVersion(database: DatabaseSync, id: string) {
  const contractColumn = (database.prepare("PRAGMA table_info(script_versions)").all() as Array<{ name: string }>)
    .some((column) => column.name === "script_contract_version")
    ? "script_contract_version"
    : "5 AS script_contract_version";
  const row = database.prepare(
    `SELECT id, episode_id, kind, version, parent_version_id, ${contractColumn}, content_json, content_hash, created_at
     FROM script_versions WHERE id = ?`,
  ).get(id) as VersionRow | undefined;
  if (!row) throw new ScriptVersionStoreError(409, "稿件版本不存在");
  let content: unknown;
  try { content = JSON.parse(row.content_json); } catch { throw new ScriptVersionStoreError(409, "稿件内容不是有效 JSON"); }
  const paragraphs = (content as { paragraphs?: unknown })?.paragraphs as ScriptVersionInput["paragraphs"];
  const normalized = normalizedContent(paragraphs);
  if (row.kind === "faithful" && row.parent_version_id) {
    throw new ScriptVersionStoreError(409, "原著还原稿不能指定父版本");
  }
  if (row.kind === "packaged") {
    const parent = row.parent_version_id && database.prepare(
      "SELECT episode_id, kind FROM script_versions WHERE id = ?",
    ).get(row.parent_version_id) as { episode_id: string; kind: string } | undefined;
    if ((row.script_contract_version === 5 && !row.parent_version_id) ||
        (row.script_contract_version === 6 && row.parent_version_id) ||
        (row.parent_version_id && (!parent || parent.kind !== "faithful" || parent.episode_id !== row.episode_id))) {
      throw new ScriptVersionStoreError(409, "成片旁白稿必须引用同一分集的原著还原稿");
    }
    if (row.parent_version_id) validateStoredScriptVersion(database, row.parent_version_id);
  } else if (row.script_contract_version !== 5) {
    throw new ScriptVersionStoreError(409, "原著还原稿合同版本无效");
  }
  if (row.content_json !== normalized.contentJson || row.content_hash !== normalized.contentHash ||
      row.id !== scriptVersionId({ episodeId: row.episode_id, kind: row.kind, version: row.version,
        contentHash: row.content_hash, parentVersionId: row.parent_version_id })) {
    throw new ScriptVersionStoreError(409, "稿件内容或确定性身份无效");
  }
  const availableSources = sourceMap(database, row.episode_id, row.parent_version_id);
  const expected = paragraphs.flatMap((paragraph, segmentIndex) => paragraph.sourceIndexes.map((episodeSourceIndex, sourceIndex) => {
    const source = availableSources.get(episodeSourceIndex);
    if (!source) throw new ScriptVersionStoreError(409, "稿件引用了不可用的分集来源");
    return {
      segment_index: segmentIndex,
      source_index: sourceIndex,
      episode_source_index: episodeSourceIndex,
      chapter_id: source.chapter_id,
      source_event_id: source.source_event_id,
      source_byte_start: source.source_byte_start,
      source_byte_end: source.source_byte_end,
      source_hash: source.source_hash,
    };
  }));
  const stored = database.prepare(
    `SELECT segment_index, source_index, episode_source_index, chapter_id, source_event_id,
            source_byte_start, source_byte_end, source_hash
     FROM script_version_sources WHERE script_version_id = ? ORDER BY segment_index, source_index`,
  ).all(id) as unknown as StoredVersionSourceRow[];
  if (JSON.stringify(stored) !== JSON.stringify(expected)) {
    throw new ScriptVersionStoreError(409, "稿件冻结来源与内容来源序号不一致");
  }
  return row;
}

function createScriptVersionInTransaction(
  database: DatabaseSync, episodeId: string, input: ScriptVersionInput, now: number,
  allowStandalonePackaged = false,
) {
  if (!database.prepare("SELECT id FROM episodes WHERE id = ?").get(episodeId)) {
    throw new ScriptVersionStoreError(404, "分集不存在");
  }
  if (input.kind !== "faithful" && input.kind !== "packaged") {
    throw new ScriptVersionStoreError(400, "稿件类型无效");
  }
  validateParagraphs(input.paragraphs);
  const parentVersionId = input.parentVersionId ?? null;
  if (input.kind === "faithful" && parentVersionId) {
    throw new ScriptVersionStoreError(400, "原著还原稿不能指定父版本");
  }
  if (input.kind === "packaged") {
    const parent = parentVersionId && database.prepare(
      "SELECT episode_id, kind FROM script_versions WHERE id = ?",
    ).get(parentVersionId) as { episode_id: string; kind: string } | undefined;
    if ((!parentVersionId && !allowStandalonePackaged) ||
        (parentVersionId && (!parent || parent.kind !== "faithful" || parent.episode_id !== episodeId))) {
      throw new ScriptVersionStoreError(409, "成片旁白稿必须引用同一分集的原著还原稿");
    }
  }

  const availableSources = sourceMap(database, episodeId, parentVersionId);
  const requestedSources = input.paragraphs.flatMap((paragraph) => paragraph.sourceIndexes);
  if (requestedSources.some((source) => !availableSources.has(source))) {
    throw new ScriptVersionStoreError(409, "稿件引用了不可用的分集来源");
  }
  const { contentJson, contentHash } = normalizedContent(input.paragraphs);
  const existing = database.prepare(
    `SELECT id, episode_id, kind, version, parent_version_id, script_contract_version, content_json, content_hash, created_at
     FROM script_versions
     WHERE episode_id = ? AND kind = ? AND content_hash = ? AND parent_version_id IS ?`,
  ).get(episodeId, input.kind, contentHash, parentVersionId) as VersionRow | undefined;
  if (existing) return versionResult(database, existing);
  const version = Number(database.prepare(
    "SELECT COALESCE(MAX(version), 0) + 1 AS version FROM script_versions WHERE episode_id = ? AND kind = ?",
  ).get(episodeId, input.kind)?.version);
  const id = scriptVersionId({ episodeId, kind: input.kind, version, contentHash, parentVersionId });
  database.prepare(
    `INSERT INTO script_versions (
       id, episode_id, kind, version, parent_version_id, script_contract_version, content_json, content_hash, created_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, episodeId, input.kind, version, parentVersionId, allowStandalonePackaged ? 6 : 5,
    contentJson, contentHash, now);
  const insertSource = database.prepare(
    `INSERT INTO script_version_sources (
       script_version_id, segment_index, source_index, episode_source_index,
       chapter_id, source_event_id, source_byte_start, source_byte_end, source_hash
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  input.paragraphs.forEach((paragraph, segmentIndex) => paragraph.sourceIndexes.forEach((episodeSourceIndex, sourceIndex) => {
    const source = availableSources.get(episodeSourceIndex)!;
    insertSource.run(id, segmentIndex, sourceIndex, episodeSourceIndex, source.chapter_id,
      source.source_event_id, source.source_byte_start, source.source_byte_end, source.source_hash);
  }));
  return versionResult(database, database.prepare(
    `SELECT id, episode_id, kind, version, parent_version_id, script_contract_version, content_json, content_hash, created_at
     FROM script_versions WHERE id = ?`,
  ).get(id) as unknown as VersionRow);
}

export function createScriptVersion(
  database: DatabaseSync, episodeId: string, input: ScriptVersionInput, now = Date.now(),
) {
  database.exec("BEGIN IMMEDIATE");
  try {
    const version = createScriptVersionInTransaction(database, episodeId, input, now);
    database.exec("COMMIT");
    return version;
  } catch (error) {
    try { database.exec("ROLLBACK"); } catch { /* 保留原始写入错误。 */ }
    throw error;
  }
}

export function createScriptVersionPair(
  database: DatabaseSync,
  episodeId: string,
  input: {
    faithfulParagraphs: ScriptVersionInput["paragraphs"];
    packagedParagraphs: ScriptVersionInput["paragraphs"];
  },
  assertCurrent: () => void,
  now = Date.now(),
) {
  validateParagraphs(input.faithfulParagraphs);
  validateParagraphs(input.packagedParagraphs);
  database.exec("BEGIN IMMEDIATE");
  try {
    const assertionResult = assertCurrent() as unknown;
    if (assertionResult && typeof (assertionResult as { then?: unknown }).then === "function") {
      throw new ScriptVersionStoreError(500, "原子落稿身份检查必须同步完成");
    }
    const faithful = createScriptVersionInTransaction(database, episodeId, {
      kind: "faithful",
      paragraphs: input.faithfulParagraphs,
    }, now);
    const packaged = createScriptVersionInTransaction(database, episodeId, {
      kind: "packaged",
      parentVersionId: faithful.id,
      paragraphs: input.packagedParagraphs,
    }, now);
    database.exec("COMMIT");
    return { faithful, packaged };
  } catch (error) {
    try { database.exec("ROLLBACK"); } catch { /* 保留原始写入错误。 */ }
    throw error;
  }
}

export function createStandalonePackagedScriptVersion(
  database: DatabaseSync,
  episodeId: string,
  paragraphs: ScriptVersionInput["paragraphs"],
  assertCurrent: () => void,
  now = Date.now(),
) {
  validateParagraphs(paragraphs);
  database.exec("BEGIN IMMEDIATE");
  try {
    const assertionResult = assertCurrent() as unknown;
    if (assertionResult && typeof (assertionResult as { then?: unknown }).then === "function") {
      throw new ScriptVersionStoreError(500, "原子落稿身份检查必须同步完成");
    }
    const packaged = createScriptVersionInTransaction(database, episodeId, {
      kind: "packaged", paragraphs,
    }, now, true);
    database.exec("COMMIT");
    return packaged;
  } catch (error) {
    try { database.exec("ROLLBACK"); } catch { /* 保留原始写入错误。 */ }
    throw error;
  }
}

export function listScriptVersions(database: DatabaseSync, episodeId: string, kind?: ScriptVersionKind) {
  const rows = kind
    ? database.prepare(
      `SELECT id, episode_id, kind, version, parent_version_id, script_contract_version, content_json, content_hash, created_at
       FROM script_versions WHERE episode_id = ? AND kind = ? ORDER BY version`,
    ).all(episodeId, kind)
    : database.prepare(
      `SELECT id, episode_id, kind, version, parent_version_id, script_contract_version, content_json, content_hash, created_at
       FROM script_versions WHERE episode_id = ? ORDER BY created_at, kind, version`,
    ).all(episodeId);
  return (rows as unknown as VersionRow[]).map((row) => versionResult(database, row));
}

export function getScriptVersion(database: DatabaseSync, id: string) {
  const row = database.prepare(
    `SELECT id, episode_id, kind, version, parent_version_id, script_contract_version, content_json, content_hash, created_at
     FROM script_versions WHERE id = ?`,
  ).get(id) as VersionRow | undefined;
  return row ? versionResult(database, row) : undefined;
}
