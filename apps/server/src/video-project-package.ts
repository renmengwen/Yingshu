import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, readdir, realpath, rename, rm } from "node:fs/promises";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { backup, DatabaseSync, type DatabaseSync as Database } from "node:sqlite";

export const VIDEO_PROJECT_PACKAGE_VERSION = "yingshu-video-project-package-v1" as const;
const SCHEMA_VERSION = 25;
const HASH = /^[0-9a-f]{64}$/u;
const MAX_FILES = 10_000;
const MAX_MANIFEST_BYTES = 8 * 1024 * 1024;
const MAX_FILE_BYTES = 4 * 1024 * 1024 * 1024;
const MAX_TOTAL_BYTES = 100 * 1024 * 1024 * 1024;
const DEVICE = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/iu;

interface PackageFile { path: string; role: string; bytes: number; sha256: string }

export interface VideoProjectPackageManifest {
  version: typeof VIDEO_PROJECT_PACKAGE_VERSION;
  schemaVersion: typeof SCHEMA_VERSION;
  packageHash: string;
  project: { projectId: string; videoId: string; finalVideoId: string; finalIdentityHash: string };
  files: PackageFile[];
}

function safeRelativePath(value: string) {
  if (!value || value.includes("\\") || /[:*?"<>|]/u.test(value) || isAbsolute(value) || /^[A-Za-z]:/u.test(value) ||
      value.startsWith("//") || /[\0-\x1f\x7f]/u.test(value)) throw new Error("视频项目包相对路径无效");
  const parts = value.split("/");
  if (parts.some((part) => !part || part === "." || part === ".." || /[. ]$/u.test(part) || DEVICE.test(part))) {
    throw new Error("视频项目包相对路径包含不安全名称");
  }
  return value;
}

function controlled(root: string, relativePath: string) {
  safeRelativePath(relativePath);
  const rootPath = resolve(root);
  const path = resolve(rootPath, ...relativePath.split("/"));
  const value = relative(rootPath, path);
  if (!value || value === ".." || value.startsWith(`..${sep}`) || isAbsolute(value)) throw new Error("视频项目包路径越界");
  return path;
}

async function assertRealParents(rootValue: string, path: string) {
  const root = resolve(rootValue);
  if (await realpath(root) !== root || !(await lstat(root)).isDirectory()) throw new Error("数据根必须是真实目录");
  let cursor = root;
  for (const part of relative(root, dirname(path)).split(sep).filter(Boolean)) {
    cursor = resolve(cursor, part);
    const info = await lstat(cursor);
    if (!info.isDirectory() || info.isSymbolicLink() || await realpath(cursor) !== cursor) {
      throw new Error("视频项目文件父目录必须是数据根内真实目录");
    }
  }
}

async function copyVerified(root: string, relativePath: string, destination: string, expected?: { bytes: number; sha256: string }) {
  const path = controlled(root, relativePath);
  await assertRealParents(root, path);
  await mkdir(dirname(destination), { recursive: true });
  const source = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  const target = await open(destination, "wx");
  try {
    const before = await source.stat();
    const pathInfo = await lstat(path);
    if (!before.isFile() || before.nlink !== 1 || pathInfo.isSymbolicLink() || before.dev !== pathInfo.dev || before.ino !== pathInfo.ino ||
        before.size < 1 || before.size > MAX_FILE_BYTES || (expected && before.size !== expected.bytes)) {
      throw new Error("视频项目文件必须是大小受限的普通独占文件");
    }
    const digest = createHash("sha256");
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    let position = 0;
    while (position < before.size) {
      const { bytesRead } = await source.read(buffer, 0, Math.min(buffer.length, before.size - position), position);
      if (!bytesRead) throw new Error("视频项目文件读取提前结束");
      digest.update(buffer.subarray(0, bytesRead));
      let written = 0;
      while (written < bytesRead) {
        const count = (await target.write(buffer, written, bytesRead - written, position + written)).bytesWritten;
        if (!count) throw new Error("视频项目文件写入没有进展");
        written += count;
      }
      position += bytesRead;
    }
    const after = await source.stat();
    const sha256 = digest.digest("hex");
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || after.nlink !== 1 ||
        (expected && sha256 !== expected.sha256)) throw new Error("视频项目文件在复制期间变化或哈希不一致");
    await target.sync();
    return { bytes: before.size, sha256 };
  } finally {
    await Promise.allSettled([source.close(), target.close()]);
  }
}

async function measureOrdinary(path: string, maxBytes = MAX_FILE_BYTES) {
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const before = await handle.stat();
    const pathInfo = await lstat(path);
    if (!before.isFile() || before.nlink !== 1 || pathInfo.isSymbolicLink() || before.dev !== pathInfo.dev || before.ino !== pathInfo.ino ||
        before.size < 1 || before.size > maxBytes) throw new Error("视频项目文件必须是大小受限的普通独占文件");
    const digest = createHash("sha256");
    const chunks: Buffer[] = [];
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    let position = 0;
    while (position < before.size) {
      const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, before.size - position), position);
      if (!bytesRead) throw new Error("视频项目文件读取提前结束");
      digest.update(buffer.subarray(0, bytesRead));
      if (maxBytes === MAX_MANIFEST_BYTES) chunks.push(Buffer.from(buffer.subarray(0, bytesRead)));
      position += bytesRead;
    }
    const after = await handle.stat();
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || after.nlink !== 1) {
      throw new Error("视频项目文件在校验期间变化");
    }
    return { bytes: before.size, sha256: digest.digest("hex"), content: chunks.length ? Buffer.concat(chunks, before.size) : undefined };
  } finally { await handle.close(); }
}

function validateDatabase(database: Database) {
  const versions = database.prepare("SELECT version FROM schema_migrations ORDER BY version").all() as Array<{ version: number }>;
  if (versions.length !== SCHEMA_VERSION || versions.some((row, index) => row.version !== index + 1)) {
    throw new Error("视频项目包只支持当前 v25 数据库");
  }
  if (database.prepare("PRAGMA integrity_check").get()?.integrity_check !== "ok" || database.prepare("PRAGMA foreign_key_check").all().length) {
    throw new Error("视频项目数据库完整性校验失败");
  }
}

const NO_DELETE_TRIGGERS = [
  "video_plan_snapshots_no_delete", "video_script_revisions_no_delete", "video_visual_revisions_no_delete",
  "video_plan_approvals_no_delete", "video_image_candidates_no_delete", "video_image_approvals_no_delete",
  "video_tts_snapshots_no_delete", "video_tts_artifacts_no_delete", "video_tts_cues_no_delete", "video_audio_reviews_no_delete",
] as const;

function pruneSnapshot(database: Database, projectId: string, videoId: string) {
  database.exec("PRAGMA foreign_keys=ON; BEGIN IMMEDIATE");
  try {
    const triggers = NO_DELETE_TRIGGERS.map((name) => database.prepare(
      "SELECT sql FROM sqlite_schema WHERE type='trigger' AND name=?",
    ).get(name) as { sql: string } | undefined);
    if (triggers.some((trigger) => !trigger?.sql)) throw new Error("视频项目数据库不可变约束缺失");
    for (const trigger of NO_DELETE_TRIGGERS) database.exec(`DROP TRIGGER ${trigger}`);
    database.prepare("DELETE FROM videos WHERE id<>? OR project_id<>?").run(videoId, projectId);
    database.prepare("DELETE FROM projects WHERE id<>?").run(projectId);
    // 已完成项目恢复不续跑旧任务；只保留 FK 所需任务壳，并移除可能含路径或上游响应的载荷。
    database.exec(`
      DELETE FROM jobs WHERE id NOT IN (
        SELECT job_id FROM video_plan_jobs UNION SELECT job_id FROM video_tts_jobs
        UNION SELECT job_id FROM video_tts_artifacts UNION SELECT job_id FROM video_image_batch_items WHERE job_id IS NOT NULL
        UNION SELECT job_id FROM video_image_candidates WHERE job_id IS NOT NULL
        UNION SELECT job_id FROM video_render_runs WHERE job_id IS NOT NULL
      );
      UPDATE jobs SET payload_json='{}', result_json=NULL, error_message=NULL;
    `);
    const legacy = database.prepare("SELECT (SELECT COUNT(*) FROM books)+(SELECT COUNT(*) FROM series_projects) AS count").get() as { count: number };
    if (legacy.count) throw new Error("Video 项目包拒绝混入旧 Book/Episode 数据");
    for (const trigger of triggers) database.exec(trigger!.sql);
    validateDatabase(database);
    database.exec("COMMIT");
  } catch (error) {
    try { database.exec("ROLLBACK"); } catch { /* 保留原始错误。 */ }
    throw error;
  }
  database.exec("VACUUM");
}

function addFile(files: Map<string, PackageFile>, row: { path: string; role: string; bytes: number; sha256: string }) {
  safeRelativePath(row.path);
  if (!Number.isSafeInteger(row.bytes) || row.bytes < 1 || row.bytes > MAX_FILE_BYTES || !HASH.test(row.sha256)) {
    throw new Error("视频项目文件身份无效");
  }
  const key = row.path.toLowerCase();
  const previous = files.get(key);
  if (previous && (previous.bytes !== row.bytes || previous.sha256 !== row.sha256)) throw new Error("视频项目文件路径身份冲突");
  if (!previous) files.set(key, row);
}

function enumerateSnapshot(database: Database, expected?: VideoProjectPackageManifest["project"]) {
  validateDatabase(database);
  const projects = database.prepare("SELECT id FROM projects ORDER BY id").all() as Array<{ id: string }>;
  const videos = database.prepare("SELECT id,project_id FROM videos ORDER BY id").all() as Array<{ id: string; project_id: string }>;
  if (projects.length !== 1 || videos.length !== 1 || videos[0]!.project_id !== projects[0]!.id) {
    throw new Error("视频项目包数据库必须恰好包含一个项目和一个视频");
  }
  const finals = database.prepare(`
    SELECT final.id,final.identity_hash,final.relative_path,final.bytes,final.file_hash,
           final.manifest_relative_path,final.manifest_bytes,final.manifest_hash,run.status
    FROM video_final_videos final JOIN video_render_runs run ON run.id=final.run_id AND run.video_id=final.video_id
    WHERE final.project_id=? AND final.video_id=? ORDER BY final.created_at DESC,final.id DESC
  `).all(projects[0]!.id, videos[0]!.id) as Array<{ id: string; identity_hash: string; relative_path: string; bytes: number;
    file_hash: string; manifest_relative_path: string; manifest_bytes: number; manifest_hash: string; status: string }>;
  const final = finals[0];
  if (!final || final.status !== "succeeded") throw new Error("视频项目包需要当前成功的最终视频");
  const project = { projectId: projects[0]!.id, videoId: videos[0]!.id, finalVideoId: final.id, finalIdentityHash: final.identity_hash };
  if (expected && JSON.stringify(project) !== JSON.stringify(expected)) throw new Error("视频项目包身份与数据库不一致");
  const files = new Map<string, PackageFile>();
  const addRows = (rows: Array<{ path: string; role: string; bytes: number; sha256: string }>) => rows.forEach((row) => addFile(files, row));
  addRows(database.prepare(`SELECT relative_path path,'approved-image' role,bytes,file_hash sha256 FROM video_image_candidates
    WHERE video_id=? AND status='succeeded' ORDER BY relative_path`).all(project.videoId) as never);
  addRows(database.prepare(`SELECT audio_relative_path path,'tts-audio' role,audio_bytes bytes,audio_hash sha256 FROM video_tts_artifacts
    WHERE video_id=? UNION ALL SELECT srt_relative_path,'subtitle-srt',srt_bytes,srt_hash FROM video_tts_artifacts WHERE video_id=?
    UNION ALL SELECT ass_relative_path,'subtitle-ass',ass_bytes,ass_hash FROM video_tts_artifacts WHERE video_id=?`).all(
      project.videoId, project.videoId, project.videoId) as never);
  addRows(database.prepare(`SELECT relative_path path,'render-chunk' role,bytes,file_hash sha256 FROM video_render_chunks
    WHERE video_id=? AND relative_path IS NOT NULL ORDER BY chunk_index`).all(project.videoId) as never);
  for (const item of finals) {
    addFile(files, { path: item.relative_path, role: "final-video", bytes: item.bytes, sha256: item.file_hash });
    addFile(files, { path: item.manifest_relative_path, role: "final-manifest", bytes: item.manifest_bytes, sha256: item.manifest_hash });
  }
  return { project, files: [...files.values()].sort((a, b) => a.path.localeCompare(b.path, "en")) };
}

function packageHash(value: Omit<VideoProjectPackageManifest, "packageHash">) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

async function walk(root: string, relativeRoot = ""): Promise<string[]> {
  const directory = relativeRoot ? controlled(root, relativeRoot) : resolve(root);
  const result: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isSymbolicLink() || (!entry.isFile() && !entry.isDirectory())) throw new Error("视频项目包包含链接或特殊文件");
    const path = relativeRoot ? `${relativeRoot}/${entry.name}` : entry.name;
    if (entry.isDirectory()) result.push(...await walk(root, path)); else result.push(safeRelativePath(path));
  }
  return result.sort();
}

function parseManifest(text: string) {
  let value: unknown;
  try { value = JSON.parse(text); } catch { throw new Error("视频项目包清单不是有效 JSON"); }
  const manifest = value as VideoProjectPackageManifest;
  if (!manifest || manifest.version !== VIDEO_PROJECT_PACKAGE_VERSION || manifest.schemaVersion !== SCHEMA_VERSION ||
      !HASH.test(manifest.packageHash ?? "") || !manifest.project || !Array.isArray(manifest.files) ||
      !manifest.files.length || manifest.files.length > MAX_FILES || !manifest.project.projectId || !manifest.project.videoId ||
      !manifest.project.finalVideoId || !HASH.test(manifest.project.finalIdentityHash ?? "")) throw new Error("视频项目包清单合同无效");
  const keys = new Set<string>();
  let total = 0;
  for (const file of manifest.files) {
    safeRelativePath(file.path);
    const key = file.path.toLowerCase();
    if (keys.has(key) || !file.role || !Number.isSafeInteger(file.bytes) || file.bytes < 1 || file.bytes > MAX_FILE_BYTES ||
        !HASH.test(file.sha256)) throw new Error("视频项目包文件清单无效");
    keys.add(key); total += file.bytes;
  }
  if (total > MAX_TOTAL_BYTES || !manifest.files.some((file) => file.path === "yingshu.sqlite3" && file.role === "database")) {
    throw new Error("视频项目包大小或数据库清单无效");
  }
  const { packageHash: _, ...identity } = manifest;
  if (packageHash(identity) !== manifest.packageHash) throw new Error("视频项目包身份哈希不一致");
  return manifest;
}

export async function createVideoProjectPackage(database: Database, dataRootValue: string, input: {
  packagePath: string; projectId: string; videoId: string; finalVideoId: string;
}) {
  const dataRoot = resolve(dataRootValue);
  const packagePath = resolve(input.packagePath);
  const relation = relative(dataRoot, packagePath);
  if (!relation || !relation.startsWith(`..${sep}`) || isAbsolute(relation)) throw new Error("视频项目包必须位于数据根之外");
  if (await lstat(packagePath).then(() => true, (error) => (error as NodeJS.ErrnoException).code === "ENOENT" ? false : Promise.reject(error))) {
    throw new Error("视频项目包目标已存在");
  }
  const staging = `${packagePath}.tmp-${randomUUID()}`;
  await mkdir(resolve(staging, "payload"), { recursive: true });
  let snapshot: DatabaseSync | undefined;
  try {
    const databasePath = resolve(staging, "payload", "yingshu.sqlite3");
    await backup(database, databasePath);
    snapshot = new DatabaseSync(databasePath);
    pruneSnapshot(snapshot, input.projectId, input.videoId);
    const enumerated = enumerateSnapshot(snapshot);
    if (enumerated.project.projectId !== input.projectId || enumerated.project.videoId !== input.videoId ||
        enumerated.project.finalVideoId !== input.finalVideoId) throw new Error("请求的视频最终产物身份不匹配");
    snapshot.close(); snapshot = undefined;
    const databaseMeasured = await measureOrdinary(databasePath);
    const files: PackageFile[] = [{ path: "yingshu.sqlite3", role: "database", bytes: databaseMeasured.bytes, sha256: databaseMeasured.sha256 }];
    for (const file of enumerated.files) {
      const measured = await copyVerified(dataRoot, file.path, controlled(resolve(staging, "payload"), file.path), file);
      files.push({ ...file, ...measured });
    }
    files.sort((a, b) => a.path.localeCompare(b.path, "en"));
    const identity = { version: VIDEO_PROJECT_PACKAGE_VERSION, schemaVersion: SCHEMA_VERSION, project: enumerated.project, files } as const;
    const manifest: VideoProjectPackageManifest = { ...identity, packageHash: packageHash(identity) };
    await open(resolve(staging, "manifest.json"), "wx").then(async (handle) => {
      try { await handle.writeFile(`${JSON.stringify(manifest, null, 2)}\n`, "utf8"); await handle.sync(); } finally { await handle.close(); }
    });
    await rename(staging, packagePath);
    return { manifest, packagePath };
  } finally {
    snapshot?.close();
    await rm(staging, { recursive: true, force: true });
  }
}

export async function restoreVideoProjectPackage(packagePathValue: string, targetValue: string) {
  const packagePath = resolve(packagePathValue);
  const target = resolve(targetValue);
  if (await lstat(target).then(() => true, (error) => (error as NodeJS.ErrnoException).code === "ENOENT" ? false : Promise.reject(error))) {
    throw new Error("视频项目恢复目标已存在");
  }
  if (await realpath(packagePath) !== packagePath || !(await lstat(packagePath)).isDirectory()) throw new Error("视频项目包必须是真实目录");
  const manifestMeasured = await measureOrdinary(resolve(packagePath, "manifest.json"), MAX_MANIFEST_BYTES);
  const manifest = parseManifest(manifestMeasured.content!.toString("utf8"));
  const payload = resolve(packagePath, "payload");
  if (JSON.stringify(await walk(payload)) !== JSON.stringify(manifest.files.map((file) => file.path).sort())) {
    throw new Error("视频项目包包含未登记或缺失文件");
  }
  const staging = `${target}.tmp-${randomUUID()}`;
  await mkdir(staging, { recursive: true });
  try {
    for (const file of manifest.files) await copyVerified(payload, file.path, controlled(staging, file.path), file);
    const restoredDatabase = new DatabaseSync(controlled(staging, "yingshu.sqlite3"), { readOnly: true });
    try {
      const enumerated = enumerateSnapshot(restoredDatabase, manifest.project);
      if (JSON.stringify(enumerated.files) !== JSON.stringify(manifest.files.filter((file) => file.path !== "yingshu.sqlite3"))) {
        throw new Error("恢复文件与数据库登记不一致");
      }
    } finally { restoredDatabase.close(); }
    await rename(staging, target);
    return { manifest, dataRoot: target };
  } finally { await rm(staging, { recursive: true, force: true }); }
}
