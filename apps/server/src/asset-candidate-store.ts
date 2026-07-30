import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, open, readFile, rename, rm, stat, unlink } from "node:fs/promises";
import { basename, dirname, join, resolve, sep } from "node:path";
import { spawn } from "node:child_process";
import type { DatabaseSync, SQLInputValue } from "node:sqlite";

import { withDataFileMutationLock } from "./data-file-mutation-lock.js";

const MAX_BYTES = 30 * 1024 * 1024;
const MAX_PIXELS = 40_000_000;
const HASH = /^[0-9a-f]{64}$/u;

export type AssetCandidateSource =
  | { kind: "upload"; originalName: string }
  | {
      kind: "generation";
      episodeId: string;
      scriptVersionId: string;
      approvalRevision: number;
      provider: string;
      model: string;
      promptHash: string;
      requestHash: string;
      size: string;
      outputIndex: number;
      revisedPrompt?: string;
      derivedFromCandidateId?: string;
    };
export type AssetCandidateMime = "image/png" | "image/jpeg" | "image/webp";
export type AssetCandidateReviewAction = "approve" | "reject" | "note";
export type AssetCandidateReviewStatus = "pending" | "approved" | "rejected";

export interface RegisterAssetCandidateInput {
  assetId: string;
  source: AssetCandidateSource;
  raw: AsyncIterable<Uint8Array>;
  signal?: AbortSignal;
  now?: number;
}

export interface AssetCandidateRecord {
  id: string;
  assetId: string;
  source: AssetCandidateSource;
  sourceJson: string;
  sourceIdentityHash: string;
  fileHash: string;
  mime: AssetCandidateMime;
  width: number;
  height: number;
  bytes: number;
  relativePath: string;
  createdAt: number;
  reviewRevision: number;
  reviewStatus: AssetCandidateReviewStatus;
}

export interface PublishedAssetCandidate {
  id: string;
  assetId: string;
  source: AssetCandidateSource;
  sourceIdentityHash: string;
  sourceJson: string;
  fileHash: string;
  mime: AssetCandidateMime;
  width: number;
  height: number;
  bytes: number;
  relativePath: string;
  createdAt: number;
}

export interface AssetCandidateWriter {
  run(sql: string, ...parameters: SQLInputValue[]): void;
}

export interface AssetCandidateReviewEvent {
  candidateId: string;
  revision: number;
  action: AssetCandidateReviewAction;
  note: string | null;
  createdAt: number;
}

interface CandidateRow {
  id: string;
  asset_id: string;
  source_json: string;
  source_identity_hash: string;
  file_hash: string;
  mime: AssetCandidateMime;
  width: number;
  height: number;
  bytes: number;
  relative_path: string;
  created_at: number;
  review_revision: number;
  review_action: "approve" | "reject" | "note" | null;
  review_status_action: "approve" | "reject" | null;
}

export class AssetCandidateStoreError extends Error {
  constructor(readonly statusCode: number, message: string) { super(message); }
}

function text(value: unknown, label: string, max = 255) {
  if (typeof value !== "string") throw new AssetCandidateStoreError(400, `${label}不能为空`);
  const normalized = value.normalize("NFKC").trim();
  if (!normalized || normalized.length > max) throw new AssetCandidateStoreError(400, `${label}无效`);
  return normalized;
}

function safeSource(source: AssetCandidateSource): AssetCandidateSource {
  if (!source || typeof source !== "object") throw new AssetCandidateStoreError(400, "候选图来源无效");
  if (source.kind === "upload") {
    const originalName = basename(text(source.originalName, "原始文件名"));
    if (originalName === "." || originalName === "..") throw new AssetCandidateStoreError(400, "原始文件名无效");
    return { kind: "upload", originalName };
  }
  if (source.kind === "generation") {
    const promptHash = text(source.promptHash, "提示词哈希", 64).toLowerCase();
    const requestHash = text(source.requestHash, "生成请求哈希", 64).toLowerCase();
    if (!HASH.test(promptHash)) throw new AssetCandidateStoreError(400, "提示词哈希无效");
    if (!HASH.test(requestHash)) throw new AssetCandidateStoreError(400, "生成请求哈希无效");
    if (!Number.isSafeInteger(source.approvalRevision) || source.approvalRevision < 1) {
      throw new AssetCandidateStoreError(400, "批准版本号无效");
    }
    if (!Number.isSafeInteger(source.outputIndex) || source.outputIndex < 0) {
      throw new AssetCandidateStoreError(400, "生成结果序号无效");
    }
    const result: AssetCandidateSource = {
      kind: "generation",
      episodeId: text(source.episodeId, "分集 ID"),
      scriptVersionId: text(source.scriptVersionId, "稿件版本 ID"),
      approvalRevision: source.approvalRevision,
      provider: text(source.provider, "生成服务", 100),
      model: text(source.model, "生成模型", 150),
      promptHash,
      requestHash,
      size: text(source.size, "生成尺寸", 50),
      outputIndex: source.outputIndex,
    };
    if (source.revisedPrompt !== undefined) result.revisedPrompt = text(source.revisedPrompt, "修订提示词", 4000);
    if (source.derivedFromCandidateId !== undefined) {
      result.derivedFromCandidateId = text(source.derivedFromCandidateId, "父候选 ID");
    }
    return result;
  }
  throw new AssetCandidateStoreError(400, "候选图来源无效");
}

function sourceJson(source: AssetCandidateSource) {
  const safe = safeSource(source);
  return { safe, json: JSON.stringify(safe) };
}

function imageType(header: Uint8Array): { mime: AssetCandidateMime; codec: string; ext: string } {
  if (header.length >= 8 && Buffer.from(header.subarray(0, 8)).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
    return { mime: "image/png", codec: "png", ext: "png" };
  }
  if (header.length >= 3 && header[0] === 0xff && header[1] === 0xd8 && header[2] === 0xff) {
    return { mime: "image/jpeg", codec: "mjpeg", ext: "jpg" };
  }
  if (header.length >= 12 && Buffer.from(header.subarray(0, 4)).toString("ascii") === "RIFF" &&
      Buffer.from(header.subarray(8, 12)).toString("ascii") === "WEBP") {
    return { mime: "image/webp", codec: "webp", ext: "webp" };
  }
  throw new AssetCandidateStoreError(400, "只支持真实 PNG、JPEG 或 WebP 图片");
}

async function probeImage(path: string, expectedCodec: string, signal?: AbortSignal) {
  if (signal?.aborted) throw new AssetCandidateStoreError(499, "候选图导入已中断");
  const output = await new Promise<string>((resolveOutput, reject) => {
    const child = spawn("ffprobe", [
      "-v", "error", "-select_streams", "v:0", "-show_entries", "stream=codec_name,width,height",
      "-of", "json", path,
    ], { windowsHide: true });
    const chunks: Buffer[] = [];
    const errors: Buffer[] = [];
    const abort = () => child.kill();
    signal?.addEventListener("abort", abort, { once: true });
    child.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => errors.push(chunk));
    child.once("error", reject);
    child.once("close", (code) => {
      signal?.removeEventListener("abort", abort);
      if (signal?.aborted) reject(new AssetCandidateStoreError(499, "候选图导入已中断"));
      else if (code !== 0) reject(new AssetCandidateStoreError(400, `图片无法解码：${Buffer.concat(errors).toString("utf8").trim()}`));
      else resolveOutput(Buffer.concat(chunks).toString("utf8"));
    });
  });
  let stream: { codec_name?: unknown; width?: unknown; height?: unknown } | undefined;
  try {
    stream = (JSON.parse(output) as { streams?: Array<typeof stream> }).streams?.[0];
  } catch {
    throw new AssetCandidateStoreError(400, "图片探测结果无效");
  }
  const width = stream?.width;
  const height = stream?.height;
  if (stream?.codec_name !== expectedCodec || !Number.isInteger(width) || !Number.isInteger(height) ||
      (width as number) < 16 || (width as number) > 8192 || (height as number) < 16 || (height as number) > 8192 ||
      (width as number) * (height as number) > MAX_PIXELS) {
    throw new AssetCandidateStoreError(400, "图片格式或尺寸不符合要求");
  }
  return { width: width as number, height: height as number };
}

async function hashFile(path: string) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

async function verifyPublishedFile(
  path: string,
  expected: { bytes: number; fileHash: string; mime: AssetCandidateMime; width: number; height: number },
  signal?: AbortSignal,
) {
  const existing = await stat(path);
  const existingHeader = (await readFile(path)).subarray(0, 12);
  const existingType = imageType(existingHeader);
  const dimensions = await probeImage(path, existingType.codec, signal);
  if (existing.size !== expected.bytes || await hashFile(path) !== expected.fileHash ||
      existingType.mime !== expected.mime || dimensions.width !== expected.width || dimensions.height !== expected.height) {
    throw new AssetCandidateStoreError(409, "内容寻址候选图与已有文件冲突");
  }
}

function assertInside(root: string, path: string) {
  const resolvedRoot = resolve(root);
  const resolvedPath = resolve(path);
  if (!resolvedPath.startsWith(`${resolvedRoot}${sep}`)) throw new AssetCandidateStoreError(500, "候选图存储路径无效");
}

function rollback(database: DatabaseSync) {
  try { database.exec("ROLLBACK"); } catch { /* 保留原始错误。 */ }
}

function rowResult(row: CandidateRow): AssetCandidateRecord {
  return {
    id: row.id,
    assetId: row.asset_id,
    source: JSON.parse(row.source_json) as AssetCandidateSource,
    sourceJson: row.source_json,
    sourceIdentityHash: row.source_identity_hash,
    fileHash: row.file_hash,
    mime: row.mime,
    width: row.width,
    height: row.height,
    bytes: row.bytes,
    relativePath: row.relative_path,
    createdAt: row.created_at,
    reviewRevision: row.review_revision,
    reviewStatus: row.review_status_action === "approve" ? "approved" :
      row.review_status_action === "reject" ? "rejected" : "pending",
  };
}

const CANDIDATE_SELECT = `
  SELECT c.id, c.asset_id, c.source_json, c.source_identity_hash, c.file_hash, c.mime,
         c.width, c.height, c.bytes, c.relative_path, c.created_at,
         COALESCE((SELECT MAX(e.revision) FROM asset_candidate_review_events e WHERE e.candidate_id = c.id), 0)
           AS review_revision,
         (SELECT e.action FROM asset_candidate_review_events e WHERE e.candidate_id = c.id
          ORDER BY e.revision DESC LIMIT 1) AS review_action,
         (SELECT e.action FROM asset_candidate_review_events e
          WHERE e.candidate_id = c.id AND e.action IN ('approve', 'reject')
          ORDER BY e.revision DESC LIMIT 1) AS review_status_action
  FROM asset_candidates c`;

export async function publishAssetCandidate(
  dataRoot: string,
  input: RegisterAssetCandidateInput,
): Promise<PublishedAssetCandidate> {
  const assetId = text(input.assetId, "资产 ID");
  const source = sourceJson(input.source);
  const sourceIdentityHash = createHash("sha256").update(source.json).digest("hex");
  const stagingDirectory = join(dataRoot, ".imports", "images", randomUUID());
  const stagingPath = join(stagingDirectory, "image");
  assertInside(dataRoot, stagingPath);
  await mkdir(stagingDirectory, { recursive: true });
  try {
    const handle = await open(stagingPath, "wx");
    const hash = createHash("sha256");
    let bytes = 0;
    let header = Buffer.alloc(0);
    try {
      for await (const chunk of input.raw) {
        if (input.signal?.aborted) throw new AssetCandidateStoreError(499, "候选图导入已中断");
        if (!(chunk instanceof Uint8Array)) throw new AssetCandidateStoreError(400, "候选图数据流无效");
        bytes += chunk.byteLength;
        if (bytes > MAX_BYTES) throw new AssetCandidateStoreError(413, "候选图不能超过 30 MiB");
        if (header.length < 12) header = Buffer.concat([header, Buffer.from(chunk)]).subarray(0, 12);
        hash.update(chunk);
        await handle.write(chunk);
      }
      if (input.signal?.aborted) throw new AssetCandidateStoreError(499, "候选图导入已中断");
      if (bytes === 0) throw new AssetCandidateStoreError(400, "候选图不能为空");
      await handle.sync();
    } finally {
      await handle.close();
    }

    const type = imageType(header);
    const dimensions = await probeImage(stagingPath, type.codec, input.signal);
    const fileHash = hash.digest("hex");
    const relativePath = `assets/candidates/${fileHash.slice(0, 2)}/${fileHash}.${type.ext}`;
    const targetPath = join(dataRoot, ...relativePath.split("/"));
    assertInside(dataRoot, targetPath);
    await mkdir(dirname(targetPath), { recursive: true });
    const expected = {
      bytes, fileHash, mime: type.mime, width: dimensions.width, height: dimensions.height,
    };
    const targetExists = await stat(targetPath).then(() => true, (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return false;
      throw error;
    });
    if (targetExists) {
      await verifyPublishedFile(targetPath, expected, input.signal);
      await unlink(stagingPath);
    } else {
      try {
        await rename(stagingPath, targetPath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        await verifyPublishedFile(targetPath, expected, input.signal);
        await unlink(stagingPath);
      }
    }

    const id = createHash("sha256").update(`${assetId}\0${sourceIdentityHash}\0${fileHash}`).digest("hex");
    return {
      id,
      assetId,
      source: source.safe,
      sourceIdentityHash,
      sourceJson: source.json,
      fileHash,
      mime: type.mime,
      width: dimensions.width,
      height: dimensions.height,
      bytes,
      relativePath,
      createdAt: input.now ?? Date.now(),
    };
  } finally {
    await rm(stagingDirectory, { recursive: true, force: true });
  }
}

export function registerPublishedAssetCandidate(
  writer: AssetCandidateWriter,
  published: PublishedAssetCandidate,
): AssetCandidateRecord {
  writer.run(
    `INSERT INTO asset_candidates (
       id, asset_id, source_kind, source_identity_hash, source_json, file_hash, mime,
       width, height, bytes, relative_path, created_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(asset_id, source_identity_hash, file_hash) DO NOTHING`,
    published.id, published.assetId, published.source.kind, published.sourceIdentityHash,
    published.sourceJson, published.fileHash, published.mime, published.width, published.height,
    published.bytes, published.relativePath, published.createdAt,
  );
  return { ...published, reviewRevision: 0, reviewStatus: "pending" };
}

export async function registerAssetCandidate(
  database: DatabaseSync,
  dataRoot: string,
  input: RegisterAssetCandidateInput,
) {
  const assetId = text(input.assetId, "资产 ID");
  const writer: AssetCandidateWriter = {
    run: (sql, ...parameters) => { database.prepare(sql).run(...parameters); },
  };
  return withDataFileMutationLock(dataRoot, async () => {
    if (!database.prepare("SELECT id FROM assets WHERE id = ?").get(assetId)) {
      throw new AssetCandidateStoreError(404, "资产不存在");
    }
    const published = await publishAssetCandidate(dataRoot, { ...input, assetId });
    registerPublishedAssetCandidate(writer, published);
    const row = database.prepare(`${CANDIDATE_SELECT} WHERE c.id = ?`).get(published.id) as CandidateRow | undefined;
    if (!row) throw new AssetCandidateStoreError(500, "候选图登记失败");
    return rowResult(row);
  });
}

export function listAssetCandidates(database: DatabaseSync, assetId: string): AssetCandidateRecord[] {
  const id = text(assetId, "资产 ID");
  return (database.prepare(`${CANDIDATE_SELECT} WHERE c.asset_id = ? ORDER BY c.created_at, c.id`)
    .all(id) as unknown as CandidateRow[]).map(rowResult);
}

export function findGeneratedAssetCandidate(
  database: DatabaseSync,
  assetId: string,
  requestHash: string,
): AssetCandidateRecord | undefined {
  const id = text(assetId, "资产 ID");
  const hash = text(requestHash, "生成请求哈希", 64).toLowerCase();
  if (!HASH.test(hash)) throw new AssetCandidateStoreError(400, "生成请求哈希无效");
  const row = database.prepare(
    `${CANDIDATE_SELECT}
     WHERE c.asset_id = ? AND c.source_kind = 'generation'
       AND json_extract(c.source_json, '$.requestHash') = ?
     ORDER BY c.created_at, c.id LIMIT 1`,
  ).get(id, hash) as CandidateRow | undefined;
  return row ? rowResult(row) : undefined;
}

export function appendAssetCandidateReview(
  database: DatabaseSync,
  candidateId: string,
  input: { expectedRevision: number; action: AssetCandidateReviewAction; note?: string | null; now?: number },
): AssetCandidateReviewEvent {
  const id = text(candidateId, "候选图 ID");
  if (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 0) {
    throw new AssetCandidateStoreError(400, "审核版本号无效");
  }
  if (!["approve", "reject", "note"].includes(input.action)) {
    throw new AssetCandidateStoreError(400, "审核操作无效");
  }
  const note = input.note === undefined || input.note === null ? null : text(input.note, "审核备注", 2000);
  if (input.action === "note" && note === null) throw new AssetCandidateStoreError(400, "备注操作必须填写内容");
  database.exec("BEGIN IMMEDIATE");
  try {
    if (!database.prepare("SELECT id FROM asset_candidates WHERE id = ?").get(id)) {
      throw new AssetCandidateStoreError(404, "候选图不存在");
    }
    const current = database.prepare(
      "SELECT COALESCE(MAX(revision), 0) AS revision FROM asset_candidate_review_events WHERE candidate_id = ?",
    ).get(id) as { revision: number };
    if (current.revision !== input.expectedRevision) {
      throw new AssetCandidateStoreError(409, `审核状态已变化，请按 revision=${current.revision} 重试`);
    }
    const event: AssetCandidateReviewEvent = {
      candidateId: id,
      revision: current.revision + 1,
      action: input.action,
      note,
      createdAt: input.now ?? Date.now(),
    };
    database.prepare(
      `INSERT INTO asset_candidate_review_events (candidate_id, revision, action, note, created_at)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(event.candidateId, event.revision, event.action, event.note, event.createdAt);
    database.exec("COMMIT");
    return event;
  } catch (error) {
    rollback(database);
    throw error;
  }
}

export function listAssetCandidateReviewEvents(
  database: DatabaseSync,
  candidateId: string,
): AssetCandidateReviewEvent[] {
  const id = text(candidateId, "候选图 ID");
  return database.prepare(
    `SELECT candidate_id AS candidateId, revision, action, note, created_at AS createdAt
     FROM asset_candidate_review_events WHERE candidate_id = ? ORDER BY revision`,
  ).all(id) as unknown as AssetCandidateReviewEvent[];
}
