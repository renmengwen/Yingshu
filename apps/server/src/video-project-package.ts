import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, readdir, realpath, rename, rm } from "node:fs/promises";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { backup, DatabaseSync, type DatabaseSync as Database } from "node:sqlite";

export const VIDEO_PROJECT_PACKAGE_VERSION = "yingshu-video-project-package-v1" as const;
const SCHEMA_VERSION = 27;
const HASH = /^[0-9a-f]{64}$/u;
const MAX_FILES = 10_000;
const MAX_MANIFEST_BYTES = 8 * 1024 * 1024;
const MAX_FILE_BYTES = 4 * 1024 * 1024 * 1024;
const MAX_TOTAL_BYTES = 100 * 1024 * 1024 * 1024;
const DEVICE = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/iu;

interface PackageFile { path: string; role: string; bytes: number; sha256: string }

const DOUYIN_MANIFEST_VERSION = "yingshu-douyin-evidence-v1";
const DOUYIN_ARTIFACT_KINDS = new Set(["metadata", "video", "audio", "transcript", "frame", "comments", "report"]);
const ZHIHU_MANIFEST_VERSION = "yingshu-zhihu-evidence-v1";
const ZHIHU_REPLY_FAILURE_KINDS = new Set([
  "invalid_url", "authentication_required", "access_denied", "rate_limited", "timeout", "aborted",
  "response_too_large", "content_too_large", "structure_changed", "request_failed",
]);
const SECRET_KEY = /(?:authorization|api.?key|cookie|access.?token|refresh.?token|client.?secret|password|browser.?profile|profile.?path|download.?url|play.?url|audio.?url)/iu;
const ABSOLUTE_PATH = /^(?:[A-Za-z]:[\\/]|\\\\|\/)/u;

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

async function assertSafeEvidenceJson(root: string, file: PackageFile) {
  if ((!file.role.startsWith("douyin-") && !file.role.startsWith("zhihu-")) || !file.path.endsWith(".json")) return;
  const measured = await measureOrdinary(controlled(root, file.path), MAX_MANIFEST_BYTES);
  if (measured.bytes !== file.bytes || measured.sha256 !== file.sha256) throw new Error("来源证据 JSON 哈希不一致");
  try {
    const value = JSON.parse(measured.content!.toString("utf8")) as Record<string, unknown>;
    assertNoSecrets(value, "来源证据文件");
    if (file.role === "zhihu-comments") {
      if (value.interpretationOnly !== true) throw new Error("知乎评论必须保持 interpretationOnly");
      assertZhihuReplyFailureSummary(value);
    }
    if (file.role === "zhihu-report") {
      if ((value.original as Record<string, unknown> | null)?.sourceEvidenceOnly !== true) throw new Error("知乎原文必须保持 sourceEvidenceOnly");
      if (value.audience !== null && (value.audience as Record<string, unknown>)?.interpretationOnly !== true) {
        throw new Error("知乎受众分析必须保持 interpretationOnly");
      }
    }
  } catch (error) { if (error instanceof SyntaxError) throw new Error("来源证据文件不是有效 JSON"); throw error; }
}

function assertZhihuReplyFailureSummary(value: Record<string, unknown>) {
  if (value.failedReplyCount !== undefined &&
      (!Number.isSafeInteger(value.failedReplyCount) || (value.failedReplyCount as number) < 0)) {
    throw new Error("知乎子评论失败计数无效");
  }
  if (value.replyFailureKinds !== undefined && (!Array.isArray(value.replyFailureKinds) ||
      value.replyFailureKinds.some((kind) => typeof kind !== "string" || !ZHIHU_REPLY_FAILURE_KINDS.has(kind)))) {
    throw new Error("知乎子评论失败类型无效");
  }
}

function validateDatabase(database: Database) {
  const versions = database.prepare("SELECT version FROM schema_migrations ORDER BY version").all() as Array<{ version: number }>;
  if (versions.length !== SCHEMA_VERSION || versions.some((row, index) => row.version !== index + 1)) {
    throw new Error("视频项目包只支持当前 v27 数据库");
  }
  if (database.prepare("PRAGMA integrity_check").get()?.integrity_check !== "ok" || database.prepare("PRAGMA foreign_key_check").all().length) {
    throw new Error("视频项目数据库完整性校验失败");
  }
}

const NO_DELETE_TRIGGERS = [
  "video_plan_snapshots_no_delete", "video_script_revisions_no_delete", "video_visual_revisions_no_delete",
  "video_plan_approvals_no_delete", "video_image_candidates_no_delete", "video_image_approvals_no_delete",
  "video_tts_snapshots_no_delete", "video_tts_artifacts_no_delete", "video_tts_cues_no_delete", "video_audio_reviews_no_delete",
  "video_douyin_snapshots_no_delete", "video_douyin_events_no_delete",
  "video_zhihu_snapshots_no_delete", "video_zhihu_events_no_delete",
] as const;

function assertNoSecrets(value: unknown, label: string) {
  const visit = (current: unknown) => {
    if (typeof current === "string") {
      if (ABSOLUTE_PATH.test(current) || /\bBearer\s+[A-Za-z0-9._~+\/-]+=*/iu.test(current)) {
        throw new Error(`${label}包含绝对路径或秘密`);
      }
      return;
    }
    if (Array.isArray(current)) { current.forEach(visit); return; }
    if (!current || typeof current !== "object") return;
    for (const [key, child] of Object.entries(current)) {
      if (SECRET_KEY.test(key)) throw new Error(`${label}包含秘密字段`);
      visit(child);
    }
  };
  visit(value);
}

function parseDouyinManifest(value: string, videoId: string, snapshotId: string, evidenceHash: string | null) {
  let manifest: unknown;
  try { manifest = JSON.parse(value); } catch { throw new Error("抖音证据清单不是有效 JSON"); }
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) throw new Error("抖音证据清单合同无效");
  const record = manifest as Record<string, unknown>;
  const allowedTop = new Set(["version", "evidenceHash", "artifacts", "transcript", "frames", "comments"]);
  if (Object.keys(record).some((key) => !allowedTop.has(key)) || record.version !== DOUYIN_MANIFEST_VERSION ||
      typeof record.evidenceHash !== "string" || !HASH.test(record.evidenceHash) || record.evidenceHash !== evidenceHash ||
      !Array.isArray(record.artifacts) || record.artifacts.length < 1 || record.artifacts.length > 1_000) {
    throw new Error("抖音证据清单合同无效");
  }
  assertNoSecrets(record, "抖音证据清单");
  const artifacts = record.artifacts as unknown[];
  const prefix = `douyin/analyses/${videoId}/${snapshotId}/`;
  const ids = new Set<string>();
  const files = artifacts.map((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error("抖音证据产物合同无效");
    const artifact = item as Record<string, unknown>;
    const keys = Object.keys(artifact);
    const allowed = new Set(["id", "kind", "relativePath", "bytes", "sha256", "mime", "status"]);
    const suffix = typeof artifact.relativePath === "string" && artifact.relativePath.startsWith(prefix)
      ? artifact.relativePath.slice(prefix.length) : "";
    const kindOwnsPath = artifact.kind === "metadata" && suffix === "metadata.json" ||
      artifact.kind === "video" && suffix === "video.mp4" || artifact.kind === "audio" && /^audio\/[A-Za-z0-9._-]+$/u.test(suffix) ||
      artifact.kind === "transcript" && suffix === "transcript.json" || artifact.kind === "frame" && /^frames\/[A-Za-z0-9._-]+\.jpe?g$/iu.test(suffix) ||
      artifact.kind === "comments" && suffix === "comments.json" || artifact.kind === "report" && suffix === "report.json";
    if (keys.some((key) => !allowed.has(key)) || !["id", "kind", "relativePath", "bytes", "sha256", "status"].every((key) => key in artifact) ||
        typeof artifact.id !== "string" || !artifact.id || ids.has(artifact.id) ||
        typeof artifact.kind !== "string" || !DOUYIN_ARTIFACT_KINDS.has(artifact.kind) ||
        typeof artifact.relativePath !== "string" || !kindOwnsPath ||
        !Number.isSafeInteger(artifact.bytes) || (artifact.bytes as number) < 1 || (artifact.bytes as number) > MAX_FILE_BYTES ||
        typeof artifact.sha256 !== "string" || !HASH.test(artifact.sha256) ||
        !["succeeded", "partial"].includes(String(artifact.status)) ||
        ("mime" in artifact && typeof artifact.mime !== "string")) throw new Error("抖音证据产物合同无效");
    ids.add(artifact.id);
    safeRelativePath(artifact.relativePath);
    return { path: artifact.relativePath, role: `douyin-${artifact.kind}`, bytes: artifact.bytes as number, sha256: artifact.sha256 };
  });
  const frames = record.frames;
  if (frames !== undefined && (!Array.isArray(frames) || frames.some((frame) => {
    if (!frame || typeof frame !== "object" || Array.isArray(frame)) return true;
    const artifactId = (frame as Record<string, unknown>).artifactId;
    return typeof artifactId !== "string" || !ids.has(artifactId) ||
      !artifacts.some((artifact) => (artifact as Record<string, unknown>).id === artifactId &&
        (artifact as Record<string, unknown>).kind === "frame");
  }))) throw new Error("抖音帧清单引用无效");
  const transcript = record.transcript;
  if (transcript !== undefined) {
    if (!transcript || typeof transcript !== "object" || Array.isArray(transcript)) throw new Error("抖音转写清单合同无效");
    const item = transcript as Record<string, unknown>;
    if (Object.keys(item).some((key) => !["status", "textHash", "segments", "missingRanges"].includes(key)) ||
        typeof item.status !== "string" || typeof item.textHash !== "string" || !HASH.test(item.textHash) ||
        !Array.isArray(item.segments) || !Array.isArray(item.missingRanges) || item.segments.some((segment) => {
          if (!segment || typeof segment !== "object" || Array.isArray(segment)) return true;
          const value = segment as Record<string, unknown>;
          return Object.keys(value).some((key) => !["id", "startMs", "endMs", "text", "status"].includes(key)) ||
            typeof value.id !== "string" || !Number.isSafeInteger(value.startMs) || !Number.isSafeInteger(value.endMs) ||
            (value.startMs as number) < 0 || (value.endMs as number) <= (value.startMs as number) ||
            typeof value.text !== "string" || typeof value.status !== "string";
        })) throw new Error("抖音转写清单合同无效");
  }
  if (record.comments !== undefined && (!record.comments || typeof record.comments !== "object" ||
      Array.isArray(record.comments) || (record.comments as Record<string, unknown>).interpretationOnly !== true)) {
    throw new Error("抖音评论清单必须保持 interpretationOnly");
  }
  return files;
}

function parseZhihuManifest(value: string, videoId: string, snapshotId: string, evidenceHash: string | null) {
  let manifest: unknown;
  try { manifest = JSON.parse(value); } catch { throw new Error("知乎证据清单不是有效 JSON"); }
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) throw new Error("知乎证据清单合同无效");
  const record = manifest as Record<string, unknown>;
  if (Object.keys(record).some((key) => !["version", "evidenceHash", "artifacts", "answer", "images", "comments"].includes(key)) ||
      record.version !== ZHIHU_MANIFEST_VERSION || record.evidenceHash !== evidenceHash || !Array.isArray(record.artifacts)) {
    throw new Error("知乎证据清单合同无效");
  }
  assertNoSecrets(record, "知乎证据清单");
  const prefix = `zhihu/analyses/${videoId}/${snapshotId}/`;
  const required = new Set(["answer", "comments", "report"]);
  const artifactIds = new Set<string>();
  const files = record.artifacts.map((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error("知乎证据产物合同无效");
    const artifact = item as Record<string, unknown>;
    const isJson = typeof artifact.kind === "string" && required.has(artifact.kind) && artifact.id === artifact.kind &&
      artifact.relativePath === `${prefix}${artifact.kind}.json`;
    const isImage = artifact.kind === "image" && typeof artifact.id === "string" && /^image-[0-9a-f]{64}$/u.test(artifact.id) &&
      typeof artifact.relativePath === "string" && new RegExp(`^${prefix.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}images/[0-9a-f]{64}\\.(?:jpg|png|webp)$`, "u").test(artifact.relativePath);
    if (Object.keys(artifact).some((key) => !["id", "kind", "relativePath", "bytes", "sha256", "mime"].includes(key)) ||
        !isJson && !isImage || artifactIds.has(String(artifact.id)) || !Number.isSafeInteger(artifact.bytes) ||
        (artifact.bytes as number) < 1 || typeof artifact.sha256 !== "string" || !HASH.test(artifact.sha256)) {
      throw new Error("知乎证据产物合同无效");
    }
    if (isImage && (artifact.id !== `image-${artifact.sha256}` || !(artifact.relativePath as string).includes(`/${artifact.sha256}.`))) {
      throw new Error("知乎图片证据身份不一致");
    }
    artifactIds.add(String(artifact.id));
    if (isJson) required.delete(artifact.kind as string);
    return { path: artifact.relativePath as string, role: `zhihu-${artifact.kind}`,
      bytes: artifact.bytes as number, sha256: artifact.sha256 as string };
  });
  if (required.size) throw new Error("知乎冻结证据不完整");
  if (record.images !== undefined && (!Array.isArray(record.images) || record.images.some((image) => {
    if (!image || typeof image !== "object" || Array.isArray(image)) return true;
    const item = image as Record<string, unknown>;
    return Object.keys(item).some((key) => !["evidenceRef", "sha256", "mime", "bytes"].includes(key)) ||
      typeof item.sha256 !== "string" || !HASH.test(item.sha256) || item.evidenceRef !== `answer:image:${item.sha256}` ||
      !["image/jpeg", "image/png", "image/webp"].includes(String(item.mime)) || !Number.isSafeInteger(item.bytes) ||
      !artifactIds.has(`image-${item.sha256}`);
  }))) throw new Error("知乎图片证据字段无效");
  const answer = record.answer as Record<string, unknown>;
  if (!answer || Object.keys(answer).some((key) => !["questionId", "answerId", "canonicalUrl", "questionTitle", "content", "excerpt",
    "authorName", "publishedAt", "updatedAt", "voteupCount", "commentCount"].includes(key))) throw new Error("知乎回答证据字段无效");
  const comments = record.comments as Record<string, unknown>;
  if (!comments || comments.interpretationOnly !== true || !Array.isArray(comments.items)) throw new Error("知乎评论证据字段无效");
  assertZhihuReplyFailureSummary(comments);
  return files;
}

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
    const selected = database.prepare("SELECT snapshot_id FROM video_douyin_analysis_selections WHERE video_id=?")
      .get(videoId) as { snapshot_id: string } | undefined;
    if (selected) {
      database.prepare("DELETE FROM video_douyin_analysis_selection_events WHERE video_id=? AND snapshot_id<>?").run(videoId, selected.snapshot_id);
      database.prepare("DELETE FROM video_douyin_analysis_snapshots WHERE video_id=? AND id<>?").run(videoId, selected.snapshot_id);
    } else {
      database.prepare("DELETE FROM video_douyin_analysis_selection_events WHERE video_id=?").run(videoId);
      database.prepare("DELETE FROM video_douyin_analysis_snapshots WHERE video_id=?").run(videoId);
    }
    const selectedZhihu = database.prepare("SELECT snapshot_id FROM video_zhihu_analysis_selections WHERE video_id=?")
      .get(videoId) as { snapshot_id: string } | undefined;
    if (selectedZhihu) {
      database.prepare("DELETE FROM video_zhihu_analysis_selection_events WHERE video_id=? AND snapshot_id<>?").run(videoId, selectedZhihu.snapshot_id);
      database.prepare("DELETE FROM video_zhihu_analysis_snapshots WHERE video_id=? AND id<>?").run(videoId, selectedZhihu.snapshot_id);
    } else {
      database.prepare("DELETE FROM video_zhihu_analysis_selection_events WHERE video_id=?").run(videoId);
      database.prepare("DELETE FROM video_zhihu_analysis_snapshots WHERE video_id=?").run(videoId);
    }
    // 已完成项目恢复不续跑旧任务；只保留 FK 所需任务壳，并移除可能含路径或上游响应的载荷。
    database.exec(`
      DELETE FROM jobs WHERE id NOT IN (
        SELECT job_id FROM video_plan_jobs UNION SELECT job_id FROM video_tts_jobs
        UNION SELECT job_id FROM video_douyin_analysis_jobs
        UNION SELECT job_id FROM video_zhihu_analysis_jobs
        UNION SELECT job_id FROM video_tts_artifacts UNION SELECT job_id FROM video_image_batch_items WHERE job_id IS NOT NULL
        UNION SELECT job_id FROM video_image_candidates WHERE job_id IS NOT NULL
        UNION SELECT job_id FROM video_render_runs WHERE job_id IS NOT NULL
      );
      DELETE FROM job_checkpoints;
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
  const douyin = database.prepare(`
    SELECT snapshot.id,snapshot.evidence_hash,snapshot.report_hash,snapshot.source_text,snapshot.config_json,snapshot.report_json,
           snapshot.artifact_manifest_json,snapshot.model_snapshot_json
    FROM video_douyin_analysis_selections selection
    JOIN video_douyin_analysis_snapshots snapshot ON snapshot.id=selection.snapshot_id AND snapshot.video_id=selection.video_id
    WHERE selection.video_id=?
  `).get(project.videoId) as { id: string; evidence_hash: string | null; report_hash: string | null; source_text: string; config_json: string;
    report_json: string | null; artifact_manifest_json: string | null; model_snapshot_json: string | null } | undefined;
  if (douyin) {
    if (!douyin.evidence_hash || !douyin.report_hash || !douyin.report_json || !douyin.artifact_manifest_json) {
      throw new Error("当前抖音分析选择缺少冻结证据或报告");
    }
    assertNoSecrets(douyin.source_text, "抖音来源文本");
    for (const [label, json] of [["抖音分析配置", douyin.config_json], ["抖音分析报告", douyin.report_json],
      ["抖音模型快照", douyin.model_snapshot_json]] as const) {
      if (json) { try { assertNoSecrets(JSON.parse(json), label); } catch (error) {
        if (error instanceof SyntaxError) throw new Error(`${label}不是有效 JSON`); throw error;
      } }
    }
    addRows(parseDouyinManifest(douyin.artifact_manifest_json, project.videoId, douyin.id, douyin.evidence_hash));
  }
  const zhihu = database.prepare(`
    SELECT snapshot.id,snapshot.evidence_hash,snapshot.report_hash,snapshot.config_json,snapshot.report_json,
           snapshot.artifact_manifest_json,snapshot.model_snapshot_json
    FROM video_zhihu_analysis_selections selection
    JOIN video_zhihu_analysis_snapshots snapshot ON snapshot.id=selection.snapshot_id AND snapshot.video_id=selection.video_id
    WHERE selection.video_id=?
  `).get(project.videoId) as { id: string; evidence_hash: string | null; report_hash: string | null; config_json: string;
    report_json: string | null; artifact_manifest_json: string | null; model_snapshot_json: string | null } | undefined;
  if (zhihu) {
    if (!zhihu.evidence_hash || !zhihu.report_hash || !zhihu.report_json || !zhihu.artifact_manifest_json) {
      throw new Error("当前知乎分析选择缺少冻结证据或报告");
    }
    for (const [label, json] of [["知乎分析配置", zhihu.config_json], ["知乎分析报告", zhihu.report_json],
      ["知乎模型快照", zhihu.model_snapshot_json]] as const) if (json) {
      try { assertNoSecrets(JSON.parse(json), label); }
      catch (error) { if (error instanceof SyntaxError) throw new Error(`${label}不是有效 JSON`); throw error; }
    }
    addRows(parseZhihuManifest(zhihu.artifact_manifest_json, project.videoId, zhihu.id, zhihu.evidence_hash));
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
      await assertSafeEvidenceJson(dataRoot, file);
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
    for (const file of manifest.files) {
      await copyVerified(payload, file.path, controlled(staging, file.path), file);
      await assertSafeEvidenceJson(staging, file);
    }
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
