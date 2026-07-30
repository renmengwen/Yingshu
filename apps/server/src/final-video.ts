import { createHash, randomUUID } from "node:crypto";
import { constants, createReadStream, lstatSync, renameSync, rmSync } from "node:fs";
import { copyFile, lstat, mkdir, open, readFile, realpath, rename, rm } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { DatabaseSync } from "node:sqlite";

import { probeNineSixteenVideo, runVideoProcess } from "./ffmpeg-video.js";
import { JobCancelledError } from "./job-worker.js";
import type { JobExecutionContext, JobHandler } from "./job-worker.js";
import { ensureSafeOutputDirectory, loadRenderPlanSnapshot, RENDER_CONTRACT } from "./render-chunk-job.js";

export const FINAL_VIDEO_MANIFEST_VERSION = "final-export-v1" as const;
export const FINAL_VIDEO_JOB_TYPE = "final_video";
const MAX_DURATION_DRIFT_MS = 1_000;

interface ChunkRow {
  render_hash: string;
  chunk_index: number;
  script_version_id: string;
  approval_revision: number;
  start_ms: number;
  end_ms: number;
  relative_path: string;
  file_hash: string;
  bytes: number;
  duration_ms: number;
}

export interface FinalVideoManifest {
  version: typeof FINAL_VIDEO_MANIFEST_VERSION;
  contract: typeof RENDER_CONTRACT;
  episodeId: string;
  scriptVersionId: string;
  approvalRevision: number;
  timelineHash: string;
  exportHash: string;
  chunks: Array<{
    index: number;
    startMs: number;
    endMs: number;
    renderHash: string;
    relativePath: string;
    fileHash: string;
    bytes: number;
    durationMs: number;
  }>;
  finalVideo: {
    relativePath: string;
    fileHash: string;
    bytes: number;
    durationMs: number;
    streams: { video: "h264:1080x1920:25:yuv420p"; audio: "aac" };
  };
}

interface FinalVideoDependencies {
  run: typeof runVideoProcess;
  probe: typeof probeNineSixteenVideo;
  publishLstat: typeof lstat;
  publishRenameSync: typeof renameSync;
  publishRemoveSync: typeof rmSync;
  recoverRemoveSync: typeof rmSync;
}

interface PublishedDirectoryInspection {
  identity: { dev: number; ino: number };
  valid: boolean;
}

function sha256(content: string | Buffer) {
  return createHash("sha256").update(content).digest("hex");
}

async function sha256File(path: string) {
  return new Promise<string>((resolvePromise, reject) => {
    const digest = createHash("sha256");
    createReadStream(path).on("data", (chunk) => digest.update(chunk)).once("error", reject)
      .once("end", () => resolvePromise(digest.digest("hex")));
  });
}

function controlledPath(dataRoot: string, relativePath: string) {
  if (!relativePath || /[\0\r\n]/u.test(relativePath)) throw new Error("产物相对路径无效");
  const root = resolve(dataRoot);
  const path = resolve(root, ...relativePath.split("/"));
  if (path === root || !path.startsWith(`${root}${sep}`)) throw new Error("产物路径越界");
  return path;
}

function isInside(root: string, path: string) {
  const value = relative(root, path);
  return value !== "" && value !== ".." && !value.startsWith(`..${sep}`) && !isAbsolute(value);
}

async function assertOrdinaryDataFile(dataRoot: string, path: string) {
  const [rootReal, fileReal, info] = await Promise.all([realpath(dataRoot), realpath(path), lstat(path)]);
  if (!isInside(rootReal, fileReal) || !info.isFile() || info.isSymbolicLink() || info.nlink !== 1) {
    throw new Error("分片必须是数据目录内的普通独占文件");
  }
}

async function assertSafeDirectoryIfPresent(dataRoot: string, path: string) {
  let info;
  try { info = await lstat(path); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  const [rootReal, pathReal] = await Promise.all([realpath(dataRoot), realpath(path)]);
  if (!isInside(rootReal, pathReal) || !info.isDirectory() || info.isSymbolicLink()) {
    throw new Error("最终导出目录必须是数据目录内的真实目录");
  }
}

async function syncFile(path: string) {
  const handle = await open(path, "r+");
  try { await handle.sync(); } finally { await handle.close(); }
}

function manifestText(manifest: FinalVideoManifest) {
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

function exportIdentity(snapshot: ReturnType<typeof loadRenderPlanSnapshot>, rows: ChunkRow[]) {
  return {
    version: FINAL_VIDEO_MANIFEST_VERSION,
    contract: RENDER_CONTRACT,
    episodeId: snapshot.episodeId,
    scriptVersionId: snapshot.scriptVersionId,
    approvalRevision: snapshot.approvalRevision,
    timelineHash: snapshot.timelineHash,
    chunks: rows.map((row) => ({
      index: row.chunk_index,
      startMs: row.start_ms,
      endMs: row.end_ms,
      renderHash: row.render_hash,
      fileHash: row.file_hash,
      bytes: row.bytes,
      durationMs: row.duration_ms,
    })),
  } as const;
}

const HASH = /^[0-9a-f]{64}$/u;
const ID = /^[A-Za-z0-9_-]+$/u;
const MAX_MANIFEST_BYTES = 1024 * 1024;

export class FinalExportReadError extends Error {
  constructor(message: string, readonly statusCode: 400 | 404 | 409) { super(message); }
}

async function openOrdinaryExclusiveFile(dataRoot: string, path: string) {
  const root = resolve(dataRoot);
  let before;
  try {
    const [rootReal, fileReal, info] = await Promise.all([realpath(root), realpath(path), lstat(path)]);
    if (!isInside(rootReal, fileReal) || !info.isFile() || info.isSymbolicLink() || info.nlink !== 1) {
      throw new FinalExportReadError("导出产物必须是数据目录内的普通独占文件", 409);
    }
    before = info;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new FinalExportReadError("导出产物不存在", 404);
    throw error;
  }
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.nlink !== 1 || opened.dev !== before.dev || opened.ino !== before.ino) {
      throw new FinalExportReadError("导出产物在打开期间已被替换", 409);
    }
    return handle;
  } catch (error) {
    await handle.close();
    throw error;
  }
}

async function readBounded(handle: FileHandle, maximum: number) {
  const info = await handle.stat();
  if (!Number.isSafeInteger(info.size) || info.size < 1 || info.size > maximum) {
    throw new FinalExportReadError("导出清单大小无效", 409);
  }
  const content = Buffer.alloc(info.size);
  let offset = 0;
  while (offset < content.length) {
    const { bytesRead } = await handle.read(content, offset, content.length - offset, offset);
    if (!bytesRead) break;
    offset += bytesRead;
  }
  if (offset !== content.length) throw new FinalExportReadError("导出清单读取不完整", 409);
  return content;
}

function currentExportBase(database: DatabaseSync, episodeId: string, timelineHash: string) {
  const snapshot = loadRenderPlanSnapshot(database, episodeId, timelineHash);
  const rows = database.prepare(
    `SELECT render_hash, chunk_index, script_version_id, approval_revision, start_ms, end_ms,
            relative_path, file_hash, bytes, duration_ms
     FROM render_chunks WHERE episode_id = ? AND timeline_hash = ? AND chunk_index < ? ORDER BY chunk_index`,
  ).all(episodeId, timelineHash, snapshot.chunks.length) as unknown as ChunkRow[];
  if (rows.length !== snapshot.chunks.length) throw new FinalExportReadError("当前完整分片尚未全部渲染", 409);
  for (const [index, expected] of snapshot.chunks.entries()) {
    const row = rows[index];
    const canonical = `episodes/${episodeId}/renders/chunks/${expected.renderHash.slice(0, 2)}/${expected.renderHash}.mp4`;
    if (!row || row.chunk_index !== index || row.start_ms !== expected.startMs || row.end_ms !== expected.endMs ||
        row.render_hash !== expected.renderHash || row.relative_path !== canonical ||
        row.script_version_id !== snapshot.scriptVersionId || row.approval_revision !== snapshot.approvalRevision ||
        row.bytes < 1 || row.duration_ms < 1 || Math.abs(row.duration_ms - (row.end_ms - row.start_ms)) > MAX_DURATION_DRIFT_MS ||
        !HASH.test(row.file_hash) || (index > 0 && row.start_ms !== rows[index - 1]!.end_ms)) {
      throw new FinalExportReadError("分片记录不属于当前完整渲染身份", 409);
    }
  }
  const identity = exportIdentity(snapshot, rows);
  return { ...identity, chunks: rows.map((row) => ({
    index: row.chunk_index, startMs: row.start_ms, endMs: row.end_ms, renderHash: row.render_hash,
    relativePath: row.relative_path, fileHash: row.file_hash, bytes: row.bytes, durationMs: row.duration_ms,
  })) };
}

function hashExportBase(base: ReturnType<typeof currentExportBase>) {
  return sha256(JSON.stringify({
    version: base.version,
    contract: base.contract,
    episodeId: base.episodeId,
    scriptVersionId: base.scriptVersionId,
    approvalRevision: base.approvalRevision,
    timelineHash: base.timelineHash,
    chunks: base.chunks.map(({ relativePath: _relativePath, ...chunk }) => chunk),
  }));
}

export async function openVerifiedFinalExport(
  database: DatabaseSync,
  dataRoot: string,
  input: { episodeId: string; exportHash: string },
) {
  if (!ID.test(input.episodeId) || !HASH.test(input.exportHash)) {
    throw new FinalExportReadError("导出标识无效", 400);
  }
  const directory = `episodes/${input.episodeId}/exports/${input.exportHash.slice(0, 2)}/${input.exportHash}`;
  const manifestPath = controlledPath(dataRoot, `${directory}/manifest.json`);
  const manifestHandle = await openOrdinaryExclusiveFile(dataRoot, manifestPath);
  let manifest: FinalVideoManifest;
  try {
    try { manifest = JSON.parse((await readBounded(manifestHandle, MAX_MANIFEST_BYTES)).toString("utf8")) as FinalVideoManifest; }
    catch (error) {
      if (error instanceof FinalExportReadError) throw error;
      throw new FinalExportReadError("导出清单损坏", 409);
    }
  } finally {
    await manifestHandle.close();
  }
  if (!manifest || manifest.version !== FINAL_VIDEO_MANIFEST_VERSION ||
      JSON.stringify(manifest.contract) !== JSON.stringify(RENDER_CONTRACT) ||
      manifest.episodeId !== input.episodeId || manifest.exportHash !== input.exportHash || !HASH.test(manifest.timelineHash ?? "")) {
    throw new FinalExportReadError("导出清单身份无效", 409);
  }
  let base;
  try { base = currentExportBase(database, input.episodeId, manifest.timelineHash); }
  catch (error) {
    if (error instanceof FinalExportReadError) throw error;
    throw new FinalExportReadError(error instanceof Error ? error.message : "当前生产身份不可用", 409);
  }
  if (hashExportBase(base) !== input.exportHash) throw new FinalExportReadError("导出已过期", 409);
  const expectedVideoPath = `${directory}/video.mp4`;
  if (manifest.finalVideo?.relativePath !== expectedVideoPath || !HASH.test(manifest.finalVideo.fileHash ?? "") ||
      !Number.isSafeInteger(manifest.finalVideo.bytes) || manifest.finalVideo.bytes < 1 ||
      !Number.isSafeInteger(manifest.finalVideo.durationMs) || manifest.finalVideo.durationMs < 1 ||
      Object.keys(manifest.finalVideo).sort().join(",") !== "bytes,durationMs,fileHash,relativePath,streams" ||
      JSON.stringify(manifest.finalVideo.streams) !== JSON.stringify({ video: "h264:1080x1920:25:yuv420p", audio: "aac" }) ||
      JSON.stringify({ ...manifest, finalVideo: undefined }) !==
        JSON.stringify({ ...base, exportHash: input.exportHash, finalVideo: undefined })) {
    throw new FinalExportReadError("导出清单与当前生产身份不一致", 409);
  }
  const videoHandle = await openOrdinaryExclusiveFile(dataRoot, controlledPath(dataRoot, expectedVideoPath));
  try {
    const before = await videoHandle.stat();
    if (before.size !== manifest.finalVideo.bytes) throw new FinalExportReadError("导出视频大小不一致", 409);
    const digest = createHash("sha256");
    const buffer = Buffer.allocUnsafe(256 * 1024);
    let offset = 0;
    while (offset < before.size) {
      const { bytesRead } = await videoHandle.read(buffer, 0, Math.min(buffer.length, before.size - offset), offset);
      if (!bytesRead) break;
      digest.update(buffer.subarray(0, bytesRead));
      offset += bytesRead;
    }
    const after = await videoHandle.stat();
    if (offset !== before.size || digest.digest("hex") !== manifest.finalVideo.fileHash || after.size !== before.size ||
        after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs) {
      throw new FinalExportReadError("导出视频内容不一致", 409);
    }
    try {
      if (hashExportBase(currentExportBase(database, input.episodeId, manifest.timelineHash)) !== input.exportHash) {
        throw new FinalExportReadError("视频复核期间当前生产身份已变化", 409);
      }
    } catch (error) {
      if (error instanceof FinalExportReadError) throw error;
      throw new FinalExportReadError("视频复核期间当前生产身份已变化", 409);
    }
    return { manifest, videoHandle };
  } catch (error) {
    await videoHandle.close();
    throw error;
  }
}

async function exists(path: string, publishLstat: typeof lstat) {
  try { await publishLstat(path); return true; } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function directoryIdentity(path: string, publishLstat: typeof lstat) {
  const info = await publishLstat(path);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("最终导出发布路径必须是真实目录");
  return { dev: info.dev, ino: info.ino };
}

function sameDirectory(
  left: PublishedDirectoryInspection["identity"],
  right: PublishedDirectoryInspection["identity"],
) {
  return left.dev === right.dev && left.ino === right.ino;
}

async function validPublishedPair(
  dataRoot: string,
  directory: string,
  manifestBase: Omit<FinalVideoManifest, "finalVideo">,
  finalRelativePath: string,
  probe: typeof probeNineSixteenVideo,
  publishLstat: typeof lstat,
): Promise<PublishedDirectoryInspection | null> {
  let before: PublishedDirectoryInspection["identity"];
  try { before = await directoryIdentity(directory, publishLstat); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  let valid = false;
  try {
    const videoPath = join(directory, "video.mp4");
    const manifestPath = join(directory, "manifest.json");
    await assertOrdinaryDataFile(dataRoot, videoPath);
    await assertOrdinaryDataFile(dataRoot, manifestPath);
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as FinalVideoManifest;
    if (JSON.stringify({ ...manifest, finalVideo: undefined }) ===
        JSON.stringify({ ...manifestBase, finalVideo: undefined }) &&
        manifest.finalVideo?.relativePath === finalRelativePath) {
      const measured = await probe(videoPath);
      valid = measured.bytes === manifest.finalVideo.bytes && measured.durationMs === manifest.finalVideo.durationMs &&
        await sha256File(videoPath) === manifest.finalVideo.fileHash;
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT" && !(error instanceof SyntaxError)) throw error;
  }
  const after = await directoryIdentity(directory, publishLstat);
  if (!sameDirectory(before, after)) throw new Error("最终导出发布目录在验证期间已被替换");
  return { identity: after, valid };
}

function existsSync(path: string) {
  try { lstatSync(path); return true; } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

function assertSameDirectorySync(path: string, identity: PublishedDirectoryInspection["identity"]) {
  const info = lstatSync(path);
  if (!info.isDirectory() || info.isSymbolicLink() || info.dev !== identity.dev || info.ino !== identity.ino) {
    throw new Error("最终导出捕获目录已被替换");
  }
}

async function recoverPublish(
  dataRoot: string,
  target: string,
  backup: string,
  manifestBase: Omit<FinalVideoManifest, "finalVideo">,
  finalRelativePath: string,
  probe: typeof probeNineSixteenVideo,
  publishLstat: typeof lstat,
  publishRenameNow: typeof renameSync,
  recoverRemoveNow: typeof rmSync,
) {
  if (!await exists(backup, publishLstat)) return;
  const expectedBackup = await validPublishedPair(dataRoot, backup, manifestBase, finalRelativePath, probe, publishLstat);
  if (!expectedBackup) return;
  const expectedTarget = await validPublishedPair(dataRoot, target, manifestBase, finalRelativePath, probe, publishLstat);
  const suffix = `.recover-${process.pid}-${randomUUID()}`;
  const backupQuarantine = `${backup}${suffix}`;
  const targetQuarantine = `${target}${suffix}`;
  let backupCaptured = false;
  let targetCaptured = false;
  try {
    publishRenameNow(backup, backupQuarantine);
    backupCaptured = true;
    if (existsSync(target)) {
      publishRenameNow(target, targetQuarantine);
      targetCaptured = true;
    }
    const backupInspection = await validPublishedPair(
      dataRoot, backupQuarantine, manifestBase, finalRelativePath, probe, publishLstat,
    );
    const targetInspection = targetCaptured
      ? await validPublishedPair(dataRoot, targetQuarantine, manifestBase, finalRelativePath, probe, publishLstat)
      : null;
    if (!backupInspection) throw new Error("最终导出备份捕获后消失");
    if (!sameDirectory(expectedBackup.identity, backupInspection.identity) ||
        Boolean(expectedTarget) !== Boolean(targetInspection) ||
        (expectedTarget && targetInspection && !sameDirectory(expectedTarget.identity, targetInspection.identity))) {
      throw new Error("最终导出发布目录在捕获前已被替换");
    }

    if (targetInspection?.valid) {
      assertSameDirectorySync(targetQuarantine, targetInspection.identity);
      publishRenameNow(targetQuarantine, target);
      targetCaptured = false;
      assertSameDirectorySync(target, targetInspection.identity);
      assertSameDirectorySync(backupQuarantine, backupInspection.identity);
      recoverRemoveNow(backupQuarantine, { recursive: true });
      backupCaptured = false;
      return;
    }
    if (!backupInspection.valid) throw new Error("最终导出目标与备份均不完整，拒绝恢复");
    if (targetInspection) {
      assertSameDirectorySync(targetQuarantine, targetInspection.identity);
      rmSync(targetQuarantine, { recursive: true });
      targetCaptured = false;
    }
    assertSameDirectorySync(backupQuarantine, backupInspection.identity);
    publishRenameNow(backupQuarantine, target);
    backupCaptured = false;
    assertSameDirectorySync(target, backupInspection.identity);
  } catch (error) {
    if (targetCaptured) {
      try {
        if (existsSync(target)) throw new Error("最终导出目标已存在，不能回滚隔离目录");
        renameSync(targetQuarantine, target); targetCaptured = false;
      } catch { /* 保留隔离目录以便人工恢复。 */ }
    }
    if (backupCaptured) {
      try {
        if (existsSync(backup)) throw new Error("最终导出备份已存在，不能回滚隔离目录");
        renameSync(backupQuarantine, backup); backupCaptured = false;
      } catch { /* 保留隔离目录以便人工恢复。 */ }
    }
    throw error;
  }
}

function publishDirectorySync(
  target: string,
  staging: string,
  publishRename: typeof renameSync,
  publishRemove: typeof rmSync,
) {
  const backup = `${target}.backup`;
  let oldMoved = false;
  try {
    try { publishRename(target, backup); oldMoved = true; } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    publishRename(staging, target);
  } catch (error) {
    if (oldMoved) {
      try { publishRename(backup, target); } catch { /* 保留原始发布错误和可恢复 backup。 */ }
    }
    throw error;
  }
  if (oldMoved) publishRemove(backup, { recursive: true });
}

export async function exportFinalVideo(
  database: DatabaseSync,
  dataRoot: string,
  input: { episodeId: string; timelineHash: string; signal?: AbortSignal },
  dependencies: Partial<FinalVideoDependencies> = {},
) {
  const run = dependencies.run ?? runVideoProcess;
  const probe = dependencies.probe ?? probeNineSixteenVideo;
  const publishLstat = dependencies.publishLstat ?? lstat;
  const publishRenameNow = dependencies.publishRenameSync ?? renameSync;
  const publishRemoveNow = dependencies.publishRemoveSync ?? rmSync;
  const recoverRemoveNow = dependencies.recoverRemoveSync ?? rmSync;
  const snapshot = loadRenderPlanSnapshot(database, input.episodeId, input.timelineHash);
  const rows = database.prepare(
    `SELECT render_hash, chunk_index, script_version_id, approval_revision, start_ms, end_ms,
            relative_path, file_hash, bytes, duration_ms
     FROM render_chunks WHERE episode_id = ? AND timeline_hash = ? AND chunk_index < ? ORDER BY chunk_index`,
  ).all(input.episodeId, input.timelineHash, snapshot.chunks.length) as unknown as ChunkRow[];
  if (rows.length !== snapshot.chunks.length) throw new Error("当前完整分片计划尚未全部渲染");
  for (const [index, expected] of snapshot.chunks.entries()) {
    const row = rows[index];
    const canonical = `episodes/${input.episodeId}/renders/chunks/${expected.renderHash.slice(0, 2)}/${expected.renderHash}.mp4`;
    if (!row || row.chunk_index !== index || row.start_ms !== expected.startMs || row.end_ms !== expected.endMs ||
        row.render_hash !== expected.renderHash || row.relative_path !== canonical ||
        row.script_version_id !== snapshot.scriptVersionId || row.approval_revision !== snapshot.approvalRevision ||
        row.bytes < 1 || row.duration_ms < 1 || Math.abs(row.duration_ms - (row.end_ms - row.start_ms)) > MAX_DURATION_DRIFT_MS ||
        !/^[0-9a-f]{64}$/u.test(row.file_hash)) throw new Error("分片记录不属于当前完整渲染身份");
    if (index > 0 && row.start_ms !== rows[index - 1]!.end_ms) throw new Error("分片边界不连续");
  }

  const identity = exportIdentity(snapshot, rows);
  const exportHash = sha256(JSON.stringify(identity));
  const manifestBase = { ...identity, chunks: rows.map((row) => ({
    index: row.chunk_index, startMs: row.start_ms, endMs: row.end_ms, renderHash: row.render_hash,
    relativePath: row.relative_path, fileHash: row.file_hash, bytes: row.bytes, durationMs: row.duration_ms,
  })) };
  const directoryRelativePath = `episodes/${input.episodeId}/exports/${exportHash.slice(0, 2)}/${exportHash}`;
  const target = controlledPath(dataRoot, directoryRelativePath);
  const finalRelativePath = `${directoryRelativePath}/video.mp4`;
  const finalPath = controlledPath(dataRoot, finalRelativePath);
  const manifestPath = join(target, "manifest.json");
  await ensureSafeOutputDirectory(dataRoot, dirname(target));
  await assertSafeDirectoryIfPresent(dataRoot, target);
  await assertSafeDirectoryIfPresent(dataRoot, `${target}.backup`);
  await recoverPublish(dataRoot, target, `${target}.backup`, { ...manifestBase, exportHash }, finalRelativePath,
    probe, publishLstat, publishRenameNow, recoverRemoveNow);

  const validatedChunks = [];
  for (const row of rows) {
    const path = controlledPath(dataRoot, row.relative_path);
    try {
      await assertOrdinaryDataFile(dataRoot, path);
      const measured = await probe(path, input.signal);
      if (measured.bytes !== row.bytes || measured.durationMs !== row.duration_ms || await sha256File(path) !== row.file_hash) {
        throw new Error("mismatch");
      }
    } catch (error) {
      if (input.signal?.aborted) throw new JobCancelledError();
      throw new Error("分片文件与登记信息不一致");
    }
    validatedChunks.push({ row, path });
  }

  let currentIdentityCheckStarted = false;
  try {
    await assertOrdinaryDataFile(dataRoot, finalPath);
    await assertOrdinaryDataFile(dataRoot, manifestPath);
    const measured = await probe(finalPath, input.signal);
    const fileHash = await sha256File(finalPath);
    const manifest: FinalVideoManifest = { ...manifestBase, exportHash, finalVideo: {
      relativePath: finalRelativePath, fileHash, bytes: measured.bytes, durationMs: measured.durationMs,
      streams: { video: "h264:1080x1920:25:yuv420p", audio: "aac" },
    } };
    if (Math.abs(measured.durationMs - rows.at(-1)!.end_ms) <= MAX_DURATION_DRIFT_MS &&
        await readFile(manifestPath, "utf8") === manifestText(manifest)) {
      if (input.signal?.aborted) throw new JobCancelledError();
      currentIdentityCheckStarted = true;
      const currentSnapshot = loadRenderPlanSnapshot(database, input.episodeId, input.timelineHash);
      const currentRows = database.prepare(
        `SELECT render_hash, chunk_index, script_version_id, approval_revision, start_ms, end_ms,
                relative_path, file_hash, bytes, duration_ms
         FROM render_chunks WHERE episode_id = ? AND timeline_hash = ? AND chunk_index < ? ORDER BY chunk_index`,
      ).all(input.episodeId, input.timelineHash, currentSnapshot.chunks.length) as unknown as ChunkRow[];
      if (JSON.stringify(currentSnapshot) !== JSON.stringify(snapshot) || JSON.stringify(currentRows) !== JSON.stringify(rows) ||
          sha256(JSON.stringify(exportIdentity(currentSnapshot, currentRows))) !== exportHash) {
        throw new Error("最终导出复用检查期间当前渲染身份已变化");
      }
      if (input.signal?.aborted) throw new JobCancelledError();
      return { manifest, manifestPath, finalPath, reused: true };
    }
  } catch (error) {
    if (input.signal?.aborted || error instanceof JobCancelledError) throw new JobCancelledError();
    if (currentIdentityCheckStarted) throw error;
    /* 缺失、损坏或过期的同身份导出必须重建。 */
  }

  const staging = join(dirname(target), `.${basename(target)}.${process.pid}.${randomUUID()}.tmp`);
  await mkdir(staging);
  try {
    const listLines = [];
    for (const [index, { row, path }] of validatedChunks.entries()) {
      if (input.signal?.aborted) throw new JobCancelledError();
      const name = `chunk-${String(index).padStart(4, "0")}.mp4`;
      const snapshotPath = join(staging, name);
      await copyFile(path, snapshotPath, constants.COPYFILE_EXCL);
      await syncFile(snapshotPath);
      const measured = await probe(snapshotPath, input.signal);
      if (measured.bytes !== row.bytes || measured.durationMs !== row.duration_ms || await sha256File(snapshotPath) !== row.file_hash) {
        throw new Error("分片快照与登记信息不一致");
      }
      listLines.push(`file '${name}'`);
    }
    const listPath = join(staging, "chunks.ffconcat");
    await writeDurable(listPath, `ffconcat version 1.0\n${listLines.join("\n")}\n`);
    const temporaryVideo = join(staging, "final.tmp.mp4");
    await run("ffmpeg", ["-v", "error", "-y", "-f", "concat", "-safe", "1", "-i", "chunks.ffconcat",
      "-c", "copy", "-movflags", "+faststart", "final.tmp.mp4"], { cwd: staging, signal: input.signal });
    const measured = await probe(temporaryVideo, input.signal);
    if (Math.abs(measured.durationMs - rows.at(-1)!.end_ms) > MAX_DURATION_DRIFT_MS) {
      throw new Error("最终视频时长与完整分片边界不一致");
    }
    await syncFile(temporaryVideo);
    const fileHash = await sha256File(temporaryVideo);
    const manifest: FinalVideoManifest = { ...manifestBase, exportHash, finalVideo: {
      relativePath: finalRelativePath, fileHash, bytes: measured.bytes, durationMs: measured.durationMs,
      streams: { video: "h264:1080x1920:25:yuv420p", audio: "aac" },
    } };
    await writeDurable(join(staging, "manifest.json"), manifestText(manifest));
    await rename(temporaryVideo, join(staging, "video.mp4"));
    await Promise.all([rm(listPath), ...validatedChunks.map((_, index) => rm(join(staging, `chunk-${String(index).padStart(4, "0")}.mp4`)))]);
    for (const { row, path } of validatedChunks) {
      const currentProbe = await probe(path, input.signal);
      if (currentProbe.bytes !== row.bytes || currentProbe.durationMs !== row.duration_ms || await sha256File(path) !== row.file_hash) {
        throw new Error("最终导出期间分片文件已变化");
      }
    }
    if (input.signal?.aborted) throw new JobCancelledError();
    database.exec("BEGIN IMMEDIATE");
    try {
      const currentSnapshot = loadRenderPlanSnapshot(database, input.episodeId, input.timelineHash);
      const currentRows = database.prepare(
        `SELECT render_hash, chunk_index, script_version_id, approval_revision, start_ms, end_ms,
                relative_path, file_hash, bytes, duration_ms
         FROM render_chunks WHERE episode_id = ? AND timeline_hash = ? AND chunk_index < ? ORDER BY chunk_index`,
      ).all(input.episodeId, input.timelineHash, currentSnapshot.chunks.length) as unknown as ChunkRow[];
      if (JSON.stringify(currentSnapshot) !== JSON.stringify(snapshot) ||
          sha256(JSON.stringify(exportIdentity(currentSnapshot, currentRows))) !== exportHash ||
          JSON.stringify(currentRows) !== JSON.stringify(rows)) {
        throw new Error("最终导出期间当前渲染身份已变化");
      }
      if (input.signal?.aborted) throw new JobCancelledError();
      publishDirectorySync(target, staging, publishRenameNow, publishRemoveNow);
      database.exec("COMMIT");
    } catch (error) {
      try { database.exec("ROLLBACK"); } catch { /* 保留原始发布错误。 */ }
      throw error;
    }
    return { manifest, manifestPath, finalPath, reused: false };
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

async function writeDurable(path: string, content: string) {
  const handle = await open(path, "wx");
  try { await handle.writeFile(content); await handle.sync(); } finally { await handle.close(); }
}

export function createFinalVideoJobHandler(
  database: DatabaseSync,
  dataRoot: string,
  dependencies: Partial<FinalVideoDependencies> = {},
): JobHandler {
  return async (context: JobExecutionContext) => {
    const payload = context.job.payload as { episodeId?: unknown; timelineHash?: unknown } | null;
    if (!payload || typeof payload.episodeId !== "string" || !/^[A-Za-z0-9_-]+$/u.test(payload.episodeId) ||
        typeof payload.timelineHash !== "string" || !/^[0-9a-f]{64}$/u.test(payload.timelineHash)) {
      throw new Error("最终导出任务参数无效");
    }
    const controller = new AbortController();
    const poll = setInterval(() => { if (context.isCancellationRequested()) controller.abort(); }, 50);
    try {
      const result = await exportFinalVideo(database, dataRoot, {
        episodeId: payload.episodeId, timelineHash: payload.timelineHash, signal: controller.signal,
      }, dependencies);
      context.throwIfCancellationRequested();
      context.reportProgress(1);
      return {
        episodeId: result.manifest.episodeId,
        scriptVersionId: result.manifest.scriptVersionId,
        approvalRevision: result.manifest.approvalRevision,
        timelineHash: result.manifest.timelineHash,
        finalHash: result.manifest.exportHash,
        video: result.manifest.finalVideo,
        manifestRelativePath: `${dirname(result.manifest.finalVideo.relativePath).split(sep).join("/")}/manifest.json`,
        reused: result.reused,
      };
    } finally {
      clearInterval(poll);
    }
  };
}
