import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, realpath, rename, rm } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { DatabaseSync } from "node:sqlite";

import { assertVisualPlanReady } from "./visual-segment-store.js";

const HASH = /^[0-9a-f]{64}$/u;
const MAX_CANDIDATE_BYTES = 30 * 1024 * 1024;
const MAX_CONTACT_SHEET_BYTES = 10 * 1024 * 1024;
const EXTENSIONS = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
} as const;

type CandidateMime = keyof typeof EXTENSIONS;

interface CandidateRow {
  id: string;
  asset_id: string;
  source_json: string;
  file_hash: string;
  mime: CandidateMime;
  width: number;
  height: number;
  bytes: number;
  relative_path: string;
}

interface AssetRow {
  id: string;
  asset_type: "character" | "scene" | "prop";
  asset_role: "master" | "state";
  canonical_name: string;
  state_label: string | null;
}

export interface VerifiedCandidateFile {
  candidateId: string;
  absolutePath: string;
  relativePath: string;
  mime: CandidateMime;
  bytes: number;
  fileHash: string;
  width: number;
  height: number;
  content: Buffer;
}

type DurableFileHandle = Pick<FileHandle, "writeFile" | "sync" | "close">;

export interface ContactSheetExportOptions {
  openFile?: (path: string, flags: number, mode: number) => Promise<DurableFileHandle>;
  publishRename?: typeof rename;
}

export interface ContactSheetExportResult {
  episodeId: string;
  timelineHash: string;
  directoryPath: string;
  jsonPath: string;
  htmlPath: string;
  jsonHash: string;
  htmlHash: string;
}

export interface ContactSheetIdentity {
  contract: "contact-sheet-review-v1";
  episodeId: string;
  scriptVersionId: string;
  approvalRevision: number;
  timelineHash: string;
  visualPlanHash: string;
  jsonHash: string;
  htmlHash: string;
}

export interface VerifiedContactSheetArtifact extends ContactSheetExportResult {
  identity: ContactSheetIdentity;
  identityHash: string;
}

export class ContactSheetError extends Error {
  constructor(readonly statusCode: number, message: string) { super(message); }
}

function candidateRow(database: DatabaseSync, candidateId: string) {
  const row = database.prepare(
    `SELECT id, asset_id, source_json, file_hash, mime, width, height, bytes, relative_path
     FROM asset_candidates WHERE id = ?`,
  ).get(candidateId) as CandidateRow | undefined;
  if (!row) throw new ContactSheetError(404, "候选图不存在");
  return row;
}

function isInside(root: string, path: string) {
  const value = relative(root, path);
  return value !== "" && value !== ".." && !value.startsWith(`..${sep}`) && !isAbsolute(value);
}

export async function resolveVerifiedCandidateFile(
  database: DatabaseSync,
  dataRoot: string,
  candidateId: string,
): Promise<VerifiedCandidateFile> {
  const row = candidateRow(database, candidateId);
  if (!HASH.test(row.file_hash) || !(row.mime in EXTENSIONS)) {
    throw new ContactSheetError(409, "候选图存储记录无效");
  }
  const expectedRelativePath = `assets/candidates/${row.file_hash.slice(0, 2)}/${row.file_hash}.${EXTENSIONS[row.mime]}`;
  if (row.relative_path !== expectedRelativePath) throw new ContactSheetError(409, "候选图不是规范内容寻址路径");

  const root = resolve(dataRoot);
  const absolutePath = resolve(root, ...expectedRelativePath.split("/"));
  if (!isInside(root, absolutePath)) throw new ContactSheetError(409, "候选图路径越出数据目录");
  try {
    const [rootRealPath, fileRealPath, info] = await Promise.all([
      realpath(root),
      realpath(absolutePath),
      lstat(absolutePath),
    ]);
    if (!isInside(rootRealPath, fileRealPath) || !info.isFile() || info.isSymbolicLink()) {
      throw new ContactSheetError(409, "候选图必须是数据目录内的普通文件");
    }
    const handle = await open(absolutePath, constants.O_RDONLY);
    let content: Buffer;
    try {
      const opened = await handle.stat();
      if (!opened.isFile() || opened.size > MAX_CANDIDATE_BYTES) {
        throw new ContactSheetError(409, "候选图必须是大小不超过 30 MiB 的普通文件");
      }
      const bounded = Buffer.allocUnsafe(MAX_CANDIDATE_BYTES + 1);
      let bytesRead = 0;
      while (bytesRead < bounded.length) {
        const result = await handle.read(bounded, bytesRead, bounded.length - bytesRead, bytesRead);
        if (result.bytesRead === 0) break;
        bytesRead += result.bytesRead;
      }
      if (bytesRead > MAX_CANDIDATE_BYTES) {
        throw new ContactSheetError(409, "候选图必须是大小不超过 30 MiB 的普通文件");
      }
      content = bounded.subarray(0, bytesRead);
    } finally {
      await handle.close();
    }
    if (content.length !== row.bytes || createHash("sha256").update(content).digest("hex") !== row.file_hash) {
      throw new ContactSheetError(409, "候选图文件缺失或已被篡改");
    }
    return {
      candidateId: row.id,
      absolutePath,
      relativePath: expectedRelativePath,
      mime: row.mime,
      bytes: row.bytes,
      fileHash: row.file_hash,
      width: row.width,
      height: row.height,
      content,
    };
  } catch (error) {
    if (error instanceof ContactSheetError) throw error;
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new ContactSheetError(409, "候选图文件缺失或已被篡改");
    throw error;
  }
}

function escapeHtml(value: unknown) {
  return String(value).replace(/[&<>"']/gu, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;",
  })[character]!);
}

async function writeDurableTemp(
  target: string,
  content: Buffer,
  openFile: NonNullable<ContactSheetExportOptions["openFile"]>,
) {
  const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
  let handle: DurableFileHandle | undefined;
  try {
    handle = await openFile(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
    await handle.writeFile(content);
    await handle.sync();
    await handle.close();
    handle = undefined;
    return temporary;
  } catch (error) {
    await handle?.close().catch(() => undefined);
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}

async function exists(path: string) {
  try { await lstat(path); return true; } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function publishDirectory(
  target: string,
  staged: string,
  publishRename: typeof rename,
) {
  const backup = `${target}.backup`;
  if (await exists(backup)) {
    if (await exists(target)) await rm(backup, { recursive: true });
    else await rename(backup, target);
  }
  let oldMoved = false;
  if (await exists(target)) {
    await publishRename(target, backup);
    oldMoved = true;
  }
  try {
    await publishRename(staged, target);
  } catch (error) {
    if (oldMoved) await publishRename(backup, target);
    throw error;
  }
  if (oldMoved) await rm(backup, { recursive: true });
}

function sha256(content: Buffer) {
  return createHash("sha256").update(content).digest("hex");
}

async function buildContactSheet(
  database: DatabaseSync,
  dataRoot: string,
  episodeId: string,
  timelineHash: string,
) {
  if (!database.prepare("SELECT id FROM episodes WHERE id = ?").get(episodeId)) {
    throw new ContactSheetError(404, "分集不存在");
  }
  const segments = assertVisualPlanReady(database, episodeId, timelineHash);
  const selectedIds = [...new Set(segments.flatMap((segment) =>
    segment.assets.flatMap((asset) => asset.selectedCandidateId ? [asset.selectedCandidateId] : []),
  ))].sort();
  const candidates = new Map<string, { row: CandidateRow; file: VerifiedCandidateFile }>();
  for (const candidateId of selectedIds) {
    candidates.set(candidateId, {
      row: candidateRow(database, candidateId),
      file: await resolveVerifiedCandidateFile(database, dataRoot, candidateId),
    });
  }

  const assetIds = [...new Set(segments.flatMap((segment) => segment.assets.map((asset) => asset.assetId)))].sort();
  const assets = new Map(assetIds.map((assetId) => {
    const row = database.prepare(
      `SELECT id, asset_type, asset_role, canonical_name, state_label FROM assets WHERE id = ?`,
    ).get(assetId) as AssetRow | undefined;
    if (!row) throw new ContactSheetError(409, "视觉段引用的资产不存在");
    return [assetId, row] as const;
  }));
  const directoryPath = join(resolve(dataRoot), "episodes", episodeId, "contact-sheets", timelineHash);
  if (!isInside(resolve(dataRoot), directoryPath)) throw new ContactSheetError(409, "联系表路径越出数据目录");
  const visualPlanHash = sha256(Buffer.from(JSON.stringify(segments.map((segment) => ({
    id: segment.id,
    revision: segment.revision,
    cueStartIndex: segment.cueStartIndex,
    cueEndIndex: segment.cueEndIndex,
    startMs: segment.startMs,
    endMs: segment.endMs,
    motionKind: segment.motionKind,
    motionAmountPpm: segment.motionAmountPpm,
    fadeMs: segment.fadeMs,
    assets: segment.assets.map((asset) => ({
      assetId: asset.assetId,
      selectedCandidateId: asset.selectedCandidateId,
      candidateReviewRevision: asset.candidateReviewRevision,
    })),
  }))), "utf8"));
  const document = {
    schemaVersion: 1,
    episodeId,
    scriptVersionId: segments[0]!.scriptVersionId,
    approvalRevision: segments[0]!.approvalRevision,
    timelineHash,
    visualPlanHash,
    segments: segments.map((segment) => ({
      id: segment.id,
      segmentIndex: segment.segmentIndex,
      startMs: segment.startMs,
      endMs: segment.endMs,
      motionKind: segment.motionKind,
      motionAmountPpm: segment.motionAmountPpm,
      fadeMs: segment.fadeMs,
      assets: segment.assets.map((link) => {
        const asset = assets.get(link.assetId)!;
        const selected = link.selectedCandidateId ? candidates.get(link.selectedCandidateId)! : undefined;
        return {
          id: asset.id,
          type: asset.asset_type,
          role: asset.asset_role,
          name: asset.canonical_name,
          stateLabel: asset.state_label,
          selectedCandidate: selected ? {
            id: selected.row.id,
            source: JSON.parse(selected.row.source_json) as unknown,
            fileHash: selected.file.fileHash,
            mime: selected.file.mime,
            width: selected.file.width,
            height: selected.file.height,
            bytes: selected.file.bytes,
            relativePath: selected.file.relativePath,
            reviewRevision: link.candidateReviewRevision,
          } : null,
        };
      }),
    })),
  };
  const cards = document.segments.map((segment) => {
    const selected = segment.assets.find((asset) => asset.selectedCandidate)?.selectedCandidate;
    const imagePath = selected
      ? relative(directoryPath, candidates.get(selected.id)!.file.absolutePath).split(sep).map(encodeURIComponent).join("/")
      : "";
    const names = segment.assets.map((asset) => asset.stateLabel ? `${asset.name}（${asset.stateLabel}）` : asset.name).join("、");
    return `<article><img src="${escapeHtml(imagePath)}" alt="${escapeHtml(names)}"><div><strong>段 ${segment.segmentIndex + 1}</strong><span>${segment.startMs}–${segment.endMs} ms</span><p>${escapeHtml(names)}</p></div></article>`;
  }).join("\n");
  const html = `<!doctype html>\n<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>联系表</title><style>body{margin:0;padding:24px;background:#181715;color:#eee8df;font:14px system-ui,sans-serif}main{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:16px}article{overflow:hidden;border:1px solid #514a40;border-radius:10px;background:#24211d}img{display:block;width:100%;aspect-ratio:9/16;object-fit:cover}div{padding:12px}strong,span{display:block}span,p{color:#bdb4a8}</style></head><body><h1>分集联系表</h1><p>${escapeHtml(episodeId)} · ${escapeHtml(timelineHash)}</p><main>\n${cards}\n</main></body></html>\n`;
  const jsonContent = Buffer.from(`${JSON.stringify(document, null, 2)}\n`, "utf8");
  const htmlContent = Buffer.from(html, "utf8");
  const identity: ContactSheetIdentity = {
    contract: "contact-sheet-review-v1",
    episodeId,
    scriptVersionId: segments[0]!.scriptVersionId,
    approvalRevision: segments[0]!.approvalRevision,
    timelineHash,
    visualPlanHash,
    jsonHash: sha256(jsonContent),
    htmlHash: sha256(htmlContent),
  };
  return {
    directoryPath,
    jsonPath: join(directoryPath, "contact-sheet.json"),
    htmlPath: join(directoryPath, "contact-sheet.html"),
    jsonContent,
    htmlContent,
    identity,
    identityHash: sha256(Buffer.from(JSON.stringify(identity), "utf8")),
  };
}

async function readControlledContactSheetFile(dataRoot: string, path: string) {
  const root = resolve(dataRoot);
  if (!isInside(root, path)) throw new ContactSheetError(409, "联系表路径越出数据目录");
  try {
    const [rootRealPath, fileRealPath, info] = await Promise.all([realpath(root), realpath(path), lstat(path)]);
    if (!isInside(rootRealPath, fileRealPath) || !info.isFile() || info.isSymbolicLink() || info.size > MAX_CONTACT_SHEET_BYTES) {
      throw new ContactSheetError(409, "联系表必须是数据目录内大小受限的普通文件");
    }
    const handle = await open(path, constants.O_RDONLY);
    try {
      const opened = await handle.stat();
      if (!opened.isFile() || opened.size > MAX_CONTACT_SHEET_BYTES) {
        throw new ContactSheetError(409, "联系表必须是数据目录内大小受限的普通文件");
      }
      const bounded = Buffer.allocUnsafe(MAX_CONTACT_SHEET_BYTES + 1);
      let bytesRead = 0;
      while (bytesRead < bounded.length) {
        const result = await handle.read(bounded, bytesRead, bounded.length - bytesRead, bytesRead);
        if (result.bytesRead === 0) break;
        bytesRead += result.bytesRead;
      }
      if (bytesRead > MAX_CONTACT_SHEET_BYTES) throw new ContactSheetError(409, "联系表文件过大");
      return bounded.subarray(0, bytesRead);
    } finally {
      await handle.close();
    }
  } catch (error) {
    if (error instanceof ContactSheetError) throw error;
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new ContactSheetError(409, "联系表缺失或已失效");
    throw error;
  }
}

export async function verifyCurrentContactSheetArtifact(
  database: DatabaseSync,
  dataRoot: string,
  episodeId: string,
  timelineHash: string,
): Promise<VerifiedContactSheetArtifact> {
  const expected = await buildContactSheet(database, dataRoot, episodeId, timelineHash);
  const [jsonContent, htmlContent] = await Promise.all([
    readControlledContactSheetFile(dataRoot, expected.jsonPath),
    readControlledContactSheetFile(dataRoot, expected.htmlPath),
  ]);
  try { JSON.parse(jsonContent.toString("utf8")); } catch { throw new ContactSheetError(409, "联系表 JSON 无效"); }
  if (!jsonContent.equals(expected.jsonContent) || !htmlContent.equals(expected.htmlContent)) {
    throw new ContactSheetError(409, "联系表内容与当前视觉计划不一致");
  }
  return {
    episodeId,
    timelineHash,
    directoryPath: expected.directoryPath,
    jsonPath: expected.jsonPath,
    htmlPath: expected.htmlPath,
    jsonHash: expected.identity.jsonHash,
    htmlHash: expected.identity.htmlHash,
    identity: expected.identity,
    identityHash: expected.identityHash,
  };
}

export async function exportContactSheet(
  database: DatabaseSync,
  dataRoot: string,
  episodeId: string,
  timelineHash: string,
  options: ContactSheetExportOptions = {},
): Promise<ContactSheetExportResult> {
  const artifact = await buildContactSheet(database, dataRoot, episodeId, timelineHash);
  const { directoryPath, jsonPath, htmlPath, jsonContent, htmlContent } = artifact;
  const parentPath = dirname(directoryPath);
  const stagingPath = join(parentPath, `.${basename(directoryPath)}.${process.pid}.${randomUUID()}.tmp`);
  await mkdir(parentPath, { recursive: true });
  await mkdir(stagingPath);
  let jsonTemp: string | undefined;
  let htmlTemp: string | undefined;
  try {
    const stagedJsonPath = join(stagingPath, "contact-sheet.json");
    const stagedHtmlPath = join(stagingPath, "contact-sheet.html");
    const openFile = options.openFile ?? open;
    jsonTemp = await writeDurableTemp(stagedJsonPath, jsonContent, openFile);
    htmlTemp = await writeDurableTemp(stagedHtmlPath, htmlContent, openFile);
    await rename(jsonTemp, stagedJsonPath);
    jsonTemp = undefined;
    await rename(htmlTemp, stagedHtmlPath);
    htmlTemp = undefined;
    await publishDirectory(directoryPath, stagingPath, options.publishRename ?? rename);
  } finally {
    await Promise.all([
      ...[jsonTemp, htmlTemp].filter((path): path is string => Boolean(path)).map((path) => rm(path, { force: true })),
      rm(stagingPath, { recursive: true, force: true }),
    ]);
  }
  return {
    episodeId,
    timelineHash,
    directoryPath,
    jsonPath,
    htmlPath,
    jsonHash: artifact.identity.jsonHash,
    htmlHash: artifact.identity.htmlHash,
  };
}
