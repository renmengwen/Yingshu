import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, readdir, realpath, rename, rm } from "node:fs/promises";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { backup, DatabaseSync, type DatabaseSync as Database } from "node:sqlite";

import { openDatabase } from "./database.js";
import { FINAL_VIDEO_MANIFEST_VERSION, type FinalVideoManifest } from "./final-video.js";
import { loadRenderPlanSnapshot, RENDER_CONTRACT } from "./render-chunk-job.js";
import { scriptApprovalEventId } from "./script-approval-store.js";
import { validateStoredScriptVersion } from "./script-version-store.js";

export const PROJECT_PACKAGE_VERSION = "narralume-project-package-v1" as const;
export const RESTORABLE_PROJECT_SCHEMA_VERSIONS = [13, 14, 15, 16, 17, 18, 19] as const;
const CURRENT_SCHEMA_VERSION = 19;
const MAX_MANIFEST_BYTES = 8 * 1024 * 1024;
const MAX_FILES = 10_000;
const MAX_FILE_BYTES = 4 * 1024 * 1024 * 1024;
const MAX_TOTAL_BYTES = 100 * 1024 * 1024 * 1024;
const HASH = /^[0-9a-f]{64}$/u;
const DEVICE = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/iu;
const compareText = (left: string, right: string) => left < right ? -1 : left > right ? 1 : 0;

interface PackageFile {
  path: string;
  roles: string[];
  bytes: number;
  sha256: string;
}

export interface ProjectPackageManifest {
  version: typeof PROJECT_PACKAGE_VERSION;
  packageHash: string;
  project: {
    seriesProjectId: string;
    bookId: string;
    episodeId: string;
    scriptVersionId: string;
    approvalRevision: number;
    timelineHash: string;
    finalExportHash: string;
    finalManifestPath: string;
  };
  files: PackageFile[];
}

interface PackageOps {
  backup: typeof backup;
  rename: typeof rename;
  remove: typeof rm;
  syncDirectory(path: string): Promise<void>;
  afterCopy?(relativePath: string): Promise<void>;
  afterPayloadCopied?(): Promise<void>;
}

const defaultOps: PackageOps = { backup, rename, remove: rm, syncDirectory };

function safeRelativePath(value: string) {
  if (!value || value.includes("\\") || /[:*?"<>|]/u.test(value) || isAbsolute(value) || /^[A-Za-z]:/u.test(value) || value.startsWith("//") ||
      /[\0-\x1f\x7f]/u.test(value)) throw new Error("项目包相对路径无效");
  const parts = value.split("/");
  if (parts.some((part) => !part || part === "." || part === ".." || /[. ]$/u.test(part) || DEVICE.test(part))) {
    throw new Error("项目包相对路径包含不安全名称");
  }
  return value;
}

function inside(root: string, path: string) {
  const value = relative(root, path);
  return value !== "" && value !== ".." && !value.startsWith(`..${sep}`) && !isAbsolute(value);
}

async function physicalPath(pathValue: string) {
  let cursor = resolve(pathValue);
  const missing: string[] = [];
  while (true) {
    try {
      await lstat(cursor);
      return resolve(await realpath(cursor), ...missing);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const parent = dirname(cursor);
      if (parent === cursor) throw error;
      missing.unshift(basename(cursor));
      cursor = parent;
    }
  }
}

function sameOrInside(parent: string, child: string) {
  return parent === child || inside(parent, child);
}

async function assertSeparateTrees(leftValue: string, rightValue: string) {
  const [left, right] = await Promise.all([physicalPath(leftValue), physicalPath(rightValue)]);
  if (sameOrInside(left, right) || sameOrInside(right, left)) {
    throw new Error("源数据、项目包与恢复目标不能相同或互为父子目录");
  }
}

async function assertRealDirectory(pathValue: string, label: string) {
  const path = resolve(pathValue);
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink() || await realpath(path) !== path) {
    throw new Error(`${label} 必须是真实目录`);
  }
}

async function pathExists(path: string) {
  try { await lstat(path); return true; } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

function controlledPath(root: string, relativePath: string) {
  safeRelativePath(relativePath);
  const resolvedRoot = resolve(root);
  const path = resolve(resolvedRoot, ...relativePath.split("/"));
  if (!inside(resolvedRoot, path)) throw new Error("项目包路径越界");
  return path;
}

async function assertRealParents(root: string, path: string) {
  const rootReal = await realpath(root);
  if (rootReal !== resolve(root)) throw new Error("数据根不能是链接");
  const parts = relative(root, dirname(path)).split(sep).filter(Boolean);
  let cursor = resolve(root);
  for (const part of parts) {
    cursor = resolve(cursor, part);
    const info = await lstat(cursor);
    if (!info.isDirectory() || info.isSymbolicLink() || !inside(rootReal, await realpath(cursor))) {
      throw new Error("项目文件父目录不是数据根内的真实目录");
    }
  }
}

async function readOrdinaryFile(
  root: string,
  relativePath: string,
  options: { destination?: string; maxBytes?: number; expectedBytes?: number; expectedHash?: string; capture?: boolean } = {},
) {
  const path = controlledPath(root, relativePath);
  await assertRealParents(root, path);
  const source = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  let destination: Awaited<ReturnType<typeof open>> | undefined;
  let failure: unknown;
  try {
    const before = await source.stat();
    const [pathInfo, rootReal, fileReal] = await Promise.all([lstat(path), realpath(root), realpath(path)]);
    const limit = options.maxBytes ?? MAX_FILE_BYTES;
    if (!before.isFile() || before.isSymbolicLink() || pathInfo.isSymbolicLink() || before.nlink !== 1 ||
        before.dev !== pathInfo.dev || before.ino !== pathInfo.ino || !inside(rootReal, fileReal) || before.size < 0 || before.size > limit ||
        (options.expectedBytes !== undefined && before.size !== options.expectedBytes)) {
      throw new Error("项目文件必须是大小受限的普通独占文件");
    }
    if (options.destination) {
      await mkdir(dirname(options.destination), { recursive: true });
      destination = await open(options.destination, "wx");
    }
    const digest = createHash("sha256");
    const captured: Buffer[] = [];
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    let position = 0;
    while (position < before.size) {
      const { bytesRead } = await source.read(buffer, 0, Math.min(buffer.length, before.size - position), position);
      if (!bytesRead) throw new Error("项目文件读取提前结束");
      const chunk = buffer.subarray(0, bytesRead);
      digest.update(chunk);
      if (options.capture) captured.push(Buffer.from(chunk));
      if (destination) {
        let written = 0;
        while (written < bytesRead) {
          const count = (await destination.write(buffer, written, bytesRead - written, position + written)).bytesWritten;
          if (!count) throw new Error("项目文件写入没有进展");
          written += count;
        }
      }
      position += bytesRead;
    }
    const after = await source.stat();
    const sha256 = digest.digest("hex");
    if (before.dev !== after.dev || before.ino !== after.ino || after.nlink !== 1 || before.size !== after.size ||
        (options.expectedHash !== undefined && sha256 !== options.expectedHash)) {
      throw new Error("项目文件在校验期间变化或哈希不一致");
    }
    if (destination) await destination.sync();
    return { bytes: before.size, sha256, content: options.capture ? Buffer.concat(captured, before.size) : undefined };
  } catch (error) {
    failure = error;
    throw error;
  } finally {
    let closeError: unknown;
    try { await destination?.close(); } catch (error) { closeError = error; }
    try { await source.close(); } catch (error) { closeError ??= error; }
    if (!failure && closeError) throw closeError;
  }
}

async function syncDirectory(path: string) {
  if (process.platform === "win32") return;
  const handle = await open(path, "r");
  try { await handle.sync(); } finally { await handle.close(); }
}

async function durableText(path: string, text: string) {
  const handle = await open(path, "wx");
  try { await handle.writeFile(text, "utf8"); await handle.sync(); } finally { await handle.close(); }
}

function validateDatabase(database: Database, allowedVersions = [CURRENT_SCHEMA_VERSION]) {
  const integrity = database.prepare("PRAGMA integrity_check").all() as Array<Record<string, unknown>>;
  if (integrity.length !== 1 || Object.values(integrity[0] ?? {})[0] !== "ok") throw new Error("项目数据库完整性校验失败");
  if ((database.prepare("PRAGMA foreign_key_check").all() as unknown[]).length) throw new Error("项目数据库外键校验失败");
  const versions = database.prepare("SELECT version FROM schema_migrations ORDER BY version").all() as Array<{ version: number }>;
  const version = versions.length;
  if (!allowedVersions.includes(version) || versions.some((row, index) => row.version !== index + 1)) {
    throw new Error("项目数据库迁移版本不兼容");
  }
  return version;
}

function parseFinalManifest(text: string): FinalVideoManifest {
  let value: unknown;
  try { value = JSON.parse(text); } catch { throw new Error("最终视频清单不是有效 JSON"); }
  const manifest = value as Partial<FinalVideoManifest>;
  if (!manifest || manifest.version !== FINAL_VIDEO_MANIFEST_VERSION ||
      JSON.stringify(manifest.contract) !== JSON.stringify(RENDER_CONTRACT) ||
      typeof manifest.episodeId !== "string" || typeof manifest.scriptVersionId !== "string" ||
      !Number.isSafeInteger(manifest.approvalRevision) || !HASH.test(manifest.timelineHash ?? "") ||
      !HASH.test(manifest.exportHash ?? "") || !Array.isArray(manifest.chunks) || !manifest.chunks.length ||
      !manifest.finalVideo || typeof manifest.finalVideo.relativePath !== "string" ||
      !HASH.test(manifest.finalVideo.fileHash ?? "") || !Number.isSafeInteger(manifest.finalVideo.bytes)) {
    throw new Error("最终视频清单合同无效");
  }
  const complete = manifest as FinalVideoManifest;
  if (complete.chunks.some((chunk, index) => chunk.index !== index || !Number.isSafeInteger(chunk.startMs) ||
      !Number.isSafeInteger(chunk.endMs) || chunk.startMs < 0 || chunk.endMs <= chunk.startMs || !HASH.test(chunk.renderHash) ||
      chunk.relativePath !== `episodes/${complete.episodeId}/renders/chunks/${chunk.renderHash.slice(0, 2)}/${chunk.renderHash}.mp4` ||
      !HASH.test(chunk.fileHash) || !Number.isSafeInteger(chunk.bytes) || chunk.bytes < 1 ||
      !Number.isSafeInteger(chunk.durationMs) || chunk.durationMs < 1) || complete.finalVideo.bytes < 1 ||
      !Number.isSafeInteger(complete.finalVideo.durationMs) || complete.finalVideo.durationMs < 1 ||
      complete.finalVideo.streams?.video !== "h264:1080x1920:25:yuv420p" || complete.finalVideo.streams?.audio !== "aac") {
    throw new Error("最终视频清单文件身份无效");
  }
  const identity = {
    version: complete.version, contract: complete.contract, episodeId: complete.episodeId,
    scriptVersionId: complete.scriptVersionId, approvalRevision: complete.approvalRevision,
    timelineHash: complete.timelineHash, chunks: complete.chunks.map((chunk) => ({
      index: chunk.index, startMs: chunk.startMs, endMs: chunk.endMs, renderHash: chunk.renderHash,
      fileHash: chunk.fileHash, bytes: chunk.bytes, durationMs: chunk.durationMs,
    })),
  };
  if (createHash("sha256").update(JSON.stringify(identity)).digest("hex") !== complete.exportHash) {
    throw new Error("最终视频清单导出身份无效");
  }
  const directory = `episodes/${complete.episodeId}/exports/${complete.exportHash.slice(0, 2)}/${complete.exportHash}`;
  if (complete.finalVideo.relativePath !== `${directory}/video.mp4`) throw new Error("最终视频不是规范内容寻址路径");
  return complete;
}

function addSpec(specs: Map<string, { path: string; roles: Set<string>; bytes?: number; hash?: string }>, path: string, role: string, bytes?: number, hash?: string) {
  safeRelativePath(path);
  if (bytes !== undefined && (!Number.isSafeInteger(bytes) || bytes < 1 || bytes > MAX_FILE_BYTES)) throw new Error("项目文件大小记录无效");
  if (hash !== undefined && !HASH.test(hash)) throw new Error("项目文件哈希记录无效");
  const key = path.toLowerCase();
  const existing = specs.get(key);
  if (existing && (existing.bytes !== bytes || existing.hash !== hash)) throw new Error("同一路径存在冲突的文件身份");
  const value = existing ?? { path, roles: new Set<string>(), bytes, hash };
  value.roles.add(role);
  specs.set(key, value);
}

function enumerateProject(
  database: Database,
  finalManifestPath: string,
  finalManifest: FinalVideoManifest,
  allowedSchemaVersions = [CURRENT_SCHEMA_VERSION],
  sealedRenderPlanSchemaVersion?: number,
) {
  const schemaVersion = validateDatabase(database, allowedSchemaVersions);
  const series = database.prepare("SELECT id, book_id FROM series_projects ORDER BY id").all() as Array<{ id: string; book_id: string }>;
  if (series.length !== 1) throw new Error("首版项目包只支持恰好一个系列项目的数据根");
  const books = database.prepare("SELECT id, original_file_path, original_file_hash FROM books ORDER BY id").all() as
    Array<{ id: string; original_file_path: string; original_file_hash: string }>;
  if (books.length !== 1 || books[0]!.id !== series[0]!.book_id) throw new Error("首版项目包数据根必须只包含目标项目原文");
  const episodes = database.prepare("SELECT id, series_project_id FROM episodes ORDER BY id").all() as
    Array<{ id: string; series_project_id: string }>;
  if (episodes.length !== 1 || episodes[0]!.id !== finalManifest.episodeId || episodes[0]!.series_project_id !== series[0]!.id) {
    throw new Error("首版项目包只支持恰好一个目标分集的数据根");
  }
  if (finalManifestPath !== `episodes/${finalManifest.episodeId}/exports/${finalManifest.exportHash.slice(0, 2)}/${finalManifest.exportHash}/manifest.json`) {
    throw new Error("最终视频清单不是规范内容寻址路径");
  }
  const sealedRenderPlan = schemaVersion === sealedRenderPlanSchemaVersion;
  if (sealedRenderPlan) {
    const approval = database.prepare(
      `SELECT id, revision, action, script_version_id FROM script_approval_events
       WHERE episode_id = ? ORDER BY revision DESC LIMIT 1`,
    ).get(finalManifest.episodeId) as { id: string; revision: number; action: string; script_version_id: string } | undefined;
    if (!approval || approval.action !== "approve" || approval.revision !== finalManifest.approvalRevision ||
        approval.script_version_id !== finalManifest.scriptVersionId ||
        approval.id !== scriptApprovalEventId({ episodeId: finalManifest.episodeId, revision: approval.revision,
          action: "approve", scriptVersionId: approval.script_version_id })) {
      throw new Error("历史最终清单不是封存时最新批准的成片旁白稿");
    }
    const script = validateStoredScriptVersion(database, finalManifest.scriptVersionId);
    if (script.episode_id !== finalManifest.episodeId || script.kind !== "packaged") {
      throw new Error("历史最终清单不是封存时最新批准的成片旁白稿");
    }
  } else {
    const snapshot = loadRenderPlanSnapshot(database, finalManifest.episodeId, finalManifest.timelineHash);
    if (snapshot.scriptVersionId !== finalManifest.scriptVersionId || snapshot.approvalRevision !== finalManifest.approvalRevision ||
        JSON.stringify(snapshot.chunks) !== JSON.stringify(finalManifest.chunks.map((chunk) => ({
          index: chunk.index, startMs: chunk.startMs, endMs: chunk.endMs, renderHash: chunk.renderHash,
        })))) throw new Error("最终清单不是当前批准稿与渲染计划");
  }

  const specs = new Map<string, { path: string; roles: Set<string>; bytes?: number; hash?: string }>();
  addSpec(specs, books[0]!.original_file_path, "original-text", undefined, books[0]!.original_file_hash);
  const audio = database.prepare(
    "SELECT relative_path, file_hash, bytes FROM audio_segments WHERE episode_id = ? AND timeline_hash = ? ORDER BY segment_index",
  ).all(finalManifest.episodeId, finalManifest.timelineHash) as Array<{ relative_path: string; file_hash: string; bytes: number }>;
  if (!audio.length) throw new Error("当前项目没有音频段");
  const allAudio = (database.prepare("SELECT COUNT(*) AS count FROM audio_segments").get() as { count: number }).count;
  if (allAudio !== audio.length) throw new Error("数据根包含目标时间轴之外的音频文件记录");
  audio.forEach((row) => addSpec(specs, row.relative_path, "audio-segment", row.bytes, row.file_hash));
  addSpec(specs, `episodes/${finalManifest.episodeId}/audio/${finalManifest.timelineHash}.srt`, "subtitle-srt");
  addSpec(specs, `episodes/${finalManifest.episodeId}/audio/${finalManifest.timelineHash}.ass`, "subtitle-ass");
  const images = database.prepare(
    `SELECT DISTINCT candidate.id, candidate.relative_path, candidate.file_hash, candidate.bytes
     FROM visual_segments segment
     JOIN visual_segment_assets relation ON relation.visual_segment_id = segment.id
     JOIN asset_candidates candidate ON candidate.id = relation.selected_candidate_id
     WHERE segment.episode_id = ? AND segment.timeline_hash = ? ORDER BY candidate.relative_path`,
  ).all(finalManifest.episodeId, finalManifest.timelineHash) as Array<{ id: string; relative_path: string; file_hash: string; bytes: number }>;
  if (!images.length) throw new Error("当前视觉计划没有选中图片");
  const allCandidates = (database.prepare("SELECT COUNT(*) AS count FROM asset_candidates").get() as { count: number }).count;
  if (allCandidates !== images.length) throw new Error("数据根包含当前视觉计划之外的候选图片文件记录");
  images.forEach((row) => addSpec(specs, row.relative_path, "selected-image", row.bytes, row.file_hash));
  const chunks = database.prepare(
    `SELECT render_hash, episode_id, timeline_hash, chunk_index, script_version_id, approval_revision,
            start_ms, end_ms, relative_path, file_hash, bytes, duration_ms FROM render_chunks
     WHERE episode_id = ? AND timeline_hash = ? AND chunk_index < ? ORDER BY chunk_index`,
  ).all(finalManifest.episodeId, finalManifest.timelineHash, finalManifest.chunks.length) as
    Array<{ render_hash: string; episode_id: string; timeline_hash: string; chunk_index: number; script_version_id: string;
      approval_revision: number; start_ms: number; end_ms: number; relative_path: string; file_hash: string; bytes: number;
      duration_ms: number }>;
  if (chunks.length !== finalManifest.chunks.length || chunks.some((row, index) => {
    const chunk = finalManifest.chunks[index];
    return !chunk || row.episode_id !== finalManifest.episodeId || row.timeline_hash !== finalManifest.timelineHash ||
      row.script_version_id !== finalManifest.scriptVersionId || row.approval_revision !== finalManifest.approvalRevision ||
      row.render_hash !== chunk.renderHash || row.chunk_index !== chunk.index || row.start_ms !== chunk.startMs ||
      row.end_ms !== chunk.endMs || row.relative_path !== chunk.relativePath || row.file_hash !== chunk.fileHash ||
      row.bytes !== chunk.bytes || row.duration_ms !== chunk.durationMs;
  })) throw new Error("最终清单分片与当前数据库不一致");
  const allChunks = (database.prepare("SELECT COUNT(*) AS count FROM render_chunks").get() as { count: number }).count;
  if (allChunks !== chunks.length) throw new Error("数据根包含当前渲染计划之外的分片文件记录");
  const allCues = (database.prepare("SELECT COUNT(*) AS count FROM subtitle_cues").get() as { count: number }).count;
  const currentCues = (database.prepare(
    "SELECT COUNT(*) AS count FROM subtitle_cues WHERE episode_id = ? AND timeline_hash = ?",
  ).get(finalManifest.episodeId, finalManifest.timelineHash) as { count: number }).count;
  const allVisuals = (database.prepare("SELECT COUNT(*) AS count FROM visual_segments").get() as { count: number }).count;
  const currentVisuals = (database.prepare(
    "SELECT COUNT(*) AS count FROM visual_segments WHERE episode_id = ? AND timeline_hash = ?",
  ).get(finalManifest.episodeId, finalManifest.timelineHash) as { count: number }).count;
  if (allCues !== currentCues || allVisuals !== currentVisuals) throw new Error("数据根包含目标时间轴之外的字幕或视觉记录");
  chunks.forEach((row) => addSpec(specs, row.relative_path, "render-chunk", row.bytes, row.file_hash));
  addSpec(specs, finalManifest.finalVideo.relativePath, "final-video", finalManifest.finalVideo.bytes, finalManifest.finalVideo.fileHash);
  addSpec(specs, finalManifestPath, "final-manifest");
  return {
    schemaVersion,
    project: {
      seriesProjectId: series[0]!.id, bookId: books[0]!.id, episodeId: finalManifest.episodeId,
      scriptVersionId: finalManifest.scriptVersionId, approvalRevision: finalManifest.approvalRevision,
      timelineHash: finalManifest.timelineHash, finalExportHash: finalManifest.exportHash, finalManifestPath,
    },
    specs: [...specs.values()].sort((a, b) => compareText(a.path, b.path)),
  };
}

function packageIdentity(manifest: Omit<ProjectPackageManifest, "packageHash">) {
  return createHash("sha256").update(JSON.stringify(manifest)).digest("hex");
}

async function assertDirectoryTarget(path: string) {
  try {
    const info = await lstat(path);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("项目包目标必须是普通目录");
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function publishDirectory(target: string, staging: string, ops: PackageOps) {
  const backupPath = `${target}.backup`;
  if (await assertDirectoryTarget(backupPath)) throw new Error("项目包目标存在未恢复备份");
  const existed = await assertDirectoryTarget(target);
  const stagingInfo = await lstat(staging);
  let moved = false;
  let installed = false;
  try {
    if (existed) { await ops.rename(target, backupPath); moved = true; }
    await ops.rename(staging, target);
    const targetInfo = await lstat(target);
    if (targetInfo.dev !== stagingInfo.dev || targetInfo.ino !== stagingInfo.ino || !targetInfo.isDirectory() || targetInfo.isSymbolicLink()) {
      throw new Error("项目包目标在 rename 后身份异常");
    }
    installed = true;
    await ops.syncDirectory(dirname(target));
  } catch (error) {
    if (installed) {
      const current = await lstat(target).catch(() => undefined);
      if (current?.dev === stagingInfo.dev && current.ino === stagingInfo.ino) {
        await ops.remove(target, { recursive: true, force: true }).catch(() => undefined);
      }
    }
    if (moved) {
      await ops.rename(backupPath, target).catch(() => undefined);
      await ops.syncDirectory(dirname(target)).catch(() => undefined);
    }
    throw error;
  }
  if (!moved) return;
  try {
    await ops.remove(backupPath, { recursive: true });
    await ops.syncDirectory(dirname(target));
  } catch (error) {
    throw new Error("新项目包已发布，但旧包清理未完整完成", { cause: error });
  }
}

export async function createProjectPackage(
  database: Database,
  dataRootValue: string,
  input: { packagePath: string; finalManifestRelativePath: string },
  overrides: Partial<PackageOps> = {},
) {
  const dataRoot = resolve(dataRootValue);
  const packagePath = resolve(input.packagePath);
  safeRelativePath(input.finalManifestRelativePath);
  await assertRealDirectory(dataRoot, "数据根");
  await assertSeparateTrees(dataRoot, packagePath);
  await assertDirectoryTarget(packagePath);
  if (await assertDirectoryTarget(`${packagePath}.backup`)) throw new Error("项目包目标存在未恢复备份");
  const ops = { ...defaultOps, ...overrides };
  const staging = resolve(dirname(packagePath), `.${basename(packagePath)}.${process.pid}.${randomUUID()}.tmp`);
  await mkdir(dirname(packagePath), { recursive: true });
  await mkdir(resolve(staging, "payload"), { recursive: true });
  try {
    const databasePath = resolve(staging, "payload", "yingshu.sqlite3");
    await ops.backup(database, databasePath);
    const databaseHandle = await open(databasePath, "r+");
    try { await databaseHandle.sync(); } finally { await databaseHandle.close(); }
    const snapshot = new DatabaseSync(databasePath);
    let enumerated: ReturnType<typeof enumerateProject>;
    try {
      snapshot.exec("PRAGMA journal_mode = DELETE; PRAGMA query_only = ON;");
      const measured = await readOrdinaryFile(dataRoot, input.finalManifestRelativePath, { maxBytes: MAX_MANIFEST_BYTES, capture: true });
      enumerated = enumerateProject(snapshot, input.finalManifestRelativePath, parseFinalManifest(measured.content!.toString("utf8")));
      const finalSpec = enumerated.specs.find((spec) => spec.path === input.finalManifestRelativePath)!;
      finalSpec.bytes = measured.bytes;
      finalSpec.hash = measured.sha256;
    } finally { snapshot.close(); }
    const finalizedDatabaseHandle = await open(databasePath, "r+");
    try { await finalizedDatabaseHandle.sync(); } finally { await finalizedDatabaseHandle.close(); }
    const { project, specs } = enumerated;
    {
      const files: PackageFile[] = [];
      const databaseMeasured = await readOrdinaryFile(resolve(staging, "payload"), "yingshu.sqlite3");
      files.push({ path: "yingshu.sqlite3", roles: ["database"], ...databaseMeasured });
      let totalBytes = databaseMeasured.bytes;
      for (const spec of specs) {
        const destination = controlledPath(resolve(staging, "payload"), spec.path);
        const measuredFile = await readOrdinaryFile(dataRoot, spec.path, {
          destination, expectedBytes: spec.bytes, expectedHash: spec.hash,
          maxBytes: spec.path === input.finalManifestRelativePath ? MAX_MANIFEST_BYTES : MAX_FILE_BYTES,
        });
        await readOrdinaryFile(resolve(staging, "payload"), spec.path, {
          expectedBytes: measuredFile.bytes, expectedHash: measuredFile.sha256,
        });
        await ops.afterCopy?.(spec.path);
        totalBytes += measuredFile.bytes;
        if (totalBytes > MAX_TOTAL_BYTES || files.length + 1 > MAX_FILES) throw new Error("项目包文件数量或总大小超过限制");
        files.push({ path: spec.path, roles: [...spec.roles].sort(), ...measuredFile });
      }
      files.sort((a, b) => compareText(a.path, b.path));
      const base = { version: PROJECT_PACKAGE_VERSION, project, files } as const;
      const manifest: ProjectPackageManifest = { ...base, packageHash: packageIdentity(base) };
      const text = `${JSON.stringify(manifest, null, 2)}\n`;
      if (Buffer.byteLength(text) > MAX_MANIFEST_BYTES) throw new Error("项目包清单超过大小限制");
      await durableText(resolve(staging, "manifest.json"), text);
      await readOrdinaryFile(staging, "manifest.json", { expectedBytes: Buffer.byteLength(text), expectedHash: createHash("sha256").update(text).digest("hex") });
      await ops.syncDirectory(resolve(staging, "payload"));
      await ops.syncDirectory(staging);
      await publishDirectory(packagePath, staging, ops);
      return { manifest, manifestPath: resolve(packagePath, "manifest.json"), packagePath };
    }
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

function parsePackageManifest(text: string): ProjectPackageManifest {
  if (Buffer.byteLength(text) > MAX_MANIFEST_BYTES) throw new Error("项目包清单超过大小限制");
  let value: unknown;
  try { value = JSON.parse(text); } catch { throw new Error("项目包清单不是有效 JSON"); }
  const manifest = value as Partial<ProjectPackageManifest>;
  if (!manifest || manifest.version !== PROJECT_PACKAGE_VERSION || !HASH.test(manifest.packageHash ?? "") ||
      !manifest.project || !Array.isArray(manifest.files) || !manifest.files.length || manifest.files.length > MAX_FILES) {
    throw new Error("项目包清单合同无效");
  }
  const project = manifest.project;
  if (typeof project.seriesProjectId !== "string" || !project.seriesProjectId || typeof project.bookId !== "string" || !project.bookId ||
      typeof project.episodeId !== "string" || !project.episodeId || typeof project.scriptVersionId !== "string" || !project.scriptVersionId ||
      !Number.isSafeInteger(project.approvalRevision) || project.approvalRevision < 1 || !HASH.test(project.timelineHash) ||
      !HASH.test(project.finalExportHash) || typeof project.finalManifestPath !== "string") throw new Error("项目包项目身份无效");
  safeRelativePath(project.finalManifestPath);
  const seen = new Set<string>();
  let total = 0;
  for (const file of manifest.files) {
    if (!file || typeof file.path !== "string" || !Array.isArray(file.roles) || !file.roles.length ||
        file.roles.some((role) => typeof role !== "string" || !role) || !Number.isSafeInteger(file.bytes) || file.bytes < 1 ||
        file.bytes > MAX_FILE_BYTES || !HASH.test(file.sha256)) throw new Error("项目包文件记录无效");
    safeRelativePath(file.path);
    const key = file.path.toLowerCase();
    if (seen.has(key)) throw new Error("项目包清单存在大小写折叠重复路径");
    seen.add(key);
    total += file.bytes;
    if (total > MAX_TOTAL_BYTES) throw new Error("项目包总大小超过限制");
  }
  const { packageHash: _, ...identity } = manifest as ProjectPackageManifest;
  if (packageIdentity(identity) !== manifest.packageHash) throw new Error("项目包清单身份哈希不一致");
  return manifest as ProjectPackageManifest;
}

async function walkPayload(root: string) {
  const paths: string[] = [];
  async function walk(directory: string) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = resolve(directory, entry.name);
      const relativePath = relative(root, path).split(sep).join("/");
      safeRelativePath(relativePath);
      const info = await lstat(path);
      if (info.isSymbolicLink()) throw new Error("项目包 payload 不允许链接或 Junction");
      if (info.isDirectory()) await walk(path);
      else if (info.isFile() && info.nlink === 1) paths.push(relativePath);
      else throw new Error("项目包 payload 只允许普通独占文件");
      if (paths.length > MAX_FILES) throw new Error("项目包文件数量超过限制");
    }
  }
  await walk(root);
  return paths.sort(compareText);
}

async function loadPackageStructure(packagePathValue: string) {
  const packagePath = resolve(packagePathValue);
  if (!await assertDirectoryTarget(packagePath)) throw new Error("项目包目录不存在");
  const manifestMeasured = await readOrdinaryFile(packagePath, "manifest.json", { maxBytes: MAX_MANIFEST_BYTES, capture: true });
  const text = manifestMeasured.content!.toString("utf8");
  const manifest = parsePackageManifest(text);
  const payload = resolve(packagePath, "payload");
  const payloadInfo = await lstat(payload);
  if (!payloadInfo.isDirectory() || payloadInfo.isSymbolicLink()) throw new Error("项目包 payload 目录无效");
  const actual = await walkPayload(payload);
  const expected = manifest.files.map((file) => file.path).sort(compareText);
  if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error("项目包 payload 存在缺失或额外文件");
  const databaseFile = manifest.files.find((file) => file.path === "yingshu.sqlite3" && file.roles.includes("database"));
  const finalManifestFile = manifest.files.find((file) => file.path === manifest.project.finalManifestPath && file.roles.includes("final-manifest"));
  if (!databaseFile || JSON.stringify(databaseFile.roles) !== JSON.stringify(["database"]) || !finalManifestFile) {
    throw new Error("项目包缺少数据库或最终清单");
  }
  return { manifest, packagePath, payload };
}

async function validateStagedPackage(
  staging: string,
  manifest: ProjectPackageManifest,
  options: {
    allowedSchemaVersions?: number[];
    requireOriginalDatabaseBytes?: boolean;
    sealedRenderPlanSchemaVersion?: number;
  } = {},
) {
  const allowedSchemaVersions = options.allowedSchemaVersions ?? [CURRENT_SCHEMA_VERSION];
  const requireOriginalDatabaseBytes = options.requireOriginalDatabaseBytes ?? true;
  const actual = await walkPayload(staging);
  const expected = manifest.files.map((file) => file.path).sort(compareText);
  if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error("恢复 staging 存在缺失或额外文件");
  for (const file of manifest.files) {
    if (file.path === "yingshu.sqlite3" && !requireOriginalDatabaseBytes) continue;
    await readOrdinaryFile(staging, file.path, { expectedBytes: file.bytes, expectedHash: file.sha256 });
  }
  const database = new DatabaseSync(resolve(staging, "yingshu.sqlite3"), { readOnly: true });
  try {
    const finalMeasured = await readOrdinaryFile(staging, manifest.project.finalManifestPath, { maxBytes: MAX_MANIFEST_BYTES, capture: true });
    const finalText = finalMeasured.content!.toString("utf8");
    const enumerated = enumerateProject(
      database,
      manifest.project.finalManifestPath,
      parseFinalManifest(finalText),
      allowedSchemaVersions,
      options.sealedRenderPlanSchemaVersion,
    );
    if (JSON.stringify(enumerated.project) !== JSON.stringify(manifest.project)) throw new Error("项目包项目身份与数据库不一致");
    const expectedSpecs = new Map(enumerated.specs.map((spec) => [spec.path.toLowerCase(), spec]));
    for (const file of manifest.files.filter((item) => item.path !== "yingshu.sqlite3")) {
      const spec = expectedSpecs.get(file.path.toLowerCase());
      if (!spec || JSON.stringify(file.roles) !== JSON.stringify([...spec.roles].sort()) ||
          (spec.bytes !== undefined && file.bytes !== spec.bytes) || (spec.hash !== undefined && file.sha256 !== spec.hash)) {
        throw new Error("项目包文件与可信数据库清单不一致");
      }
      expectedSpecs.delete(file.path.toLowerCase());
    }
    if (expectedSpecs.size) throw new Error("项目包缺少数据库要求的文件");
    return enumerated.schemaVersion;
  } finally { database.close(); }
}

async function renameNoReplace(staging: string, target: string, ops: PackageOps) {
  if (await pathExists(target)) throw new Error("恢复目标在发布前已存在");
  if (process.platform !== "win32") {
    throw new Error("当前平台缺少目录 rename no-replace 保证，拒绝不安全恢复");
  }
  const before = await lstat(staging);
  try {
    await ops.rename(staging, target);
    const after = await lstat(target);
    if (before.dev !== after.dev || before.ino !== after.ino || !after.isDirectory() || after.isSymbolicLink()) {
      throw new Error("恢复目标在 rename 后身份异常");
    }
    return { dev: before.dev, ino: before.ino };
  } catch (error) {
    if (await pathExists(target)) throw new Error("恢复发布期间出现并发目标，未覆盖该目标", { cause: error });
    throw error;
  }
}

export async function restoreProjectPackage(
  packagePathValue: string,
  targetDataRootValue: string,
  overrides: Partial<PackageOps> = {},
) {
  const packagePath = resolve(packagePathValue);
  const target = resolve(targetDataRootValue);
  await assertSeparateTrees(packagePath, target);
  if (await pathExists(target)) throw new Error("恢复目标必须完全不存在");
  const structure = await loadPackageStructure(packagePath);
  const ops = { ...defaultOps, ...overrides };
  const staging = resolve(dirname(target), `.${basename(target)}.${process.pid}.${randomUUID()}.tmp`);
  await mkdir(dirname(target), { recursive: true });
  await assertSeparateTrees(packagePath, target);
  if (await pathExists(target)) throw new Error("恢复目标必须完全不存在");
  await mkdir(staging);
  try {
    for (const file of structure.manifest.files) {
      await readOrdinaryFile(structure.payload, file.path, {
        destination: controlledPath(staging, file.path), expectedBytes: file.bytes, expectedHash: file.sha256,
      });
      await readOrdinaryFile(staging, file.path, { expectedBytes: file.bytes, expectedHash: file.sha256 });
      await ops.afterCopy?.(file.path);
    }
    await ops.afterPayloadCopied?.();
    const schemaVersion = await validateStagedPackage(
      staging,
      structure.manifest,
      {
        allowedSchemaVersions: [...RESTORABLE_PROJECT_SCHEMA_VERSIONS],
        sealedRenderPlanSchemaVersion: 13,
      },
    );
    if (schemaVersion !== CURRENT_SCHEMA_VERSION) {
      const migrated = openDatabase(staging);
      migrated.close();
      const databaseHandle = await open(resolve(staging, "yingshu.sqlite3"), "r+");
      try { await databaseHandle.sync(); } finally { await databaseHandle.close(); }
      await validateStagedPackage(staging, structure.manifest, {
        allowedSchemaVersions: [CURRENT_SCHEMA_VERSION],
        requireOriginalDatabaseBytes: false,
        sealedRenderPlanSchemaVersion: schemaVersion === 13 ? CURRENT_SCHEMA_VERSION : undefined,
      });
    }
    await ops.syncDirectory(staging);
    const installed = await renameNoReplace(staging, target, ops);
    try { await ops.syncDirectory(dirname(target)); } catch (error) {
      const current = await lstat(target).catch(() => undefined);
      if (current?.dev === installed.dev && current.ino === installed.ino) {
        await ops.remove(target, { recursive: true, force: true });
      }
      throw error;
    }
    return { manifest: structure.manifest, dataRoot: target };
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}
