import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import type { DatabaseSync } from "node:sqlite";

import { createJob, getJob, requestJobCancellation } from "./job-store.js";
import { getVideo } from "./project-video-store.js";
import { canonical } from "./video-plan-contract.js";
import { getVideoPlan } from "./video-plan-store.js";
import { getVideoImageWorkspace } from "./video-image-store.js";
import { getVideoAudioReview } from "./video-audio-review.js";
import { getVideoVisualReview } from "./video-visual-review.js";
import { assertCurrentVideoVisualTimelineReady } from "./video-visual-timeline.js";

export const VIDEO_RENDER_JOB_TYPE = "video_render";
export const VIDEO_RENDER_PARAMS = {
  width: 1080, height: 1920, fps: 25, videoCodec: "h264", audioCodec: "aac",
  pixelFormat: "yuv420p", container: "mp4", subtitles: "ass",
} as const;

const HASH = /^[0-9a-f]{64}$/u;
const ID = /^[A-Za-z0-9_-]+$/u;

export class VideoRenderError extends Error {
  constructor(readonly statusCode: number, message: string) { super(message); }
}

export const videoRenderSha256 = (value: string | Buffer) =>
  createHash("sha256").update(value).digest("hex");

function currentReview(database: DatabaseSync, projectId: string, videoId: string) {
  const timeline = assertCurrentVideoVisualTimelineReady(database, projectId, videoId);
  const review = getVideoVisualReview(database, projectId, videoId);
  if (!review.reviewGate.complete || !review.reviewGate.approval) {
    throw new VideoRenderError(409, "请先明确批准当前整片画面，再生成最终视频");
  }
  return { timeline, review: review.reviewGate.approval };
}

export function videoRenderIdentity(database: DatabaseSync, projectId: string, videoId: string) {
  getVideo(database, projectId, videoId);
  const { timeline, review } = currentReview(database, projectId, videoId);
  const paramsJson = canonical(VIDEO_RENDER_PARAMS);
  const paramsHash = videoRenderSha256(paramsJson);
  const identityHash = videoRenderSha256(canonical({
    projectId, videoId, timelineId: timeline.id, timelineHash: timeline.timelineHash,
    timelineIdentityHash: timeline.identityHash, visualReviewId: review.id, paramsHash,
  }));
  return { timeline, review, paramsJson, paramsHash, identityHash };
}

interface RunRow {
  id: string; project_id: string; video_id: string; timeline_id: string; timeline_hash: string;
  visual_review_id: string; identity_hash: string; job_id: string | null; status: string;
  params_json: string; params_hash: string; error_summary: string | null; created_at: number; updated_at: number;
}

interface FinalRow {
  id: string; run_id: string; project_id: string; video_id: string; identity_hash: string;
  relative_path: string; bytes: number; file_hash: string; media_info_json: string;
  manifest_relative_path: string; manifest_bytes: number; manifest_hash: string; ffmpeg_version: string; created_at: number;
}

function runRecord(database: DatabaseSync, row: RunRow | undefined) {
  if (!row) return null;
  const job = row.job_id ? getJob(database, row.job_id) : undefined;
  const counts = database.prepare(
    `SELECT COUNT(*) AS total,
      SUM(status='queued') AS queued,SUM(status='running') AS running,SUM(status='succeeded') AS succeeded,
      SUM(status='failed') AS failed,SUM(status='cancelled') AS cancelled
     FROM video_render_chunks WHERE run_id=?`,
  ).get(row.id) as { total: number; queued: number | null; running: number | null; succeeded: number | null;
    failed: number | null; cancelled: number | null };
  const final = database.prepare("SELECT * FROM video_final_videos WHERE run_id=?").get(row.id) as FinalRow | undefined;
  return {
    id: row.id, status: row.status, jobId: row.job_id, progress: job?.progress ?? (row.status === "succeeded" ? 1 : 0),
    errorMessage: row.error_summary ?? job?.errorMessage ?? null,
    chunks: { total: counts.total, queued: counts.queued ?? 0, running: counts.running ?? 0,
      succeeded: counts.succeeded ?? 0, failed: counts.failed ?? 0, cancelled: counts.cancelled ?? 0 },
    final: final ? { id: final.id, bytes: final.bytes, fileHash: final.file_hash,
      mediaInfo: JSON.parse(final.media_info_json) as unknown, manifestHash: final.manifest_hash,
      createdAt: final.created_at } : null,
    createdAt: row.created_at, updatedAt: row.updated_at,
  };
}

export function getVideoRenderWorkspace(database: DatabaseSync, projectId: string, videoId: string) {
  getVideo(database, projectId, videoId);
  const plan = getVideoPlan(database, projectId, videoId);
  const images = getVideoImageWorkspace(database, projectId, videoId);
  const audio = getVideoAudioReview(database, projectId, videoId);
  const visual = getVideoVisualReview(database, projectId, videoId);
  const gates = [
    { key: "script", label: "文案与画面方案", valid: !!plan?.approval?.valid && !plan.stale,
      message: plan?.approval?.valid && !plan.stale ? "当前方案已批准" : "请先批准当前方案" },
    { key: "image", label: "图片审核", valid: images.gateComplete,
      message: images.gateComplete ? "每个画面已有批准图片" : "请完成当前图片审核" },
    { key: "audio", label: "配音听音", valid: audio.audioGate.complete && !audio.stale,
      message: audio.audioGate.complete && !audio.stale ? "当前配音已试听批准" : "请完成当前配音听音审核" },
    { key: "visual", label: "整片画面", valid: visual.reviewGate.complete && !visual.timeline?.stale,
      message: visual.reviewGate.complete && !visual.timeline?.stale ? "当前整片画面已批准" : "请批准当前整片画面" },
  ];
  let readiness: ReturnType<typeof videoRenderIdentity> | null = null;
  let issue: string | null = null;
  try { readiness = videoRenderIdentity(database, projectId, videoId); }
  catch (error) { issue = error instanceof Error ? error.message : "当前生产门禁未通过"; }
  const row = readiness
    ? database.prepare("SELECT * FROM video_render_runs WHERE project_id=? AND video_id=? AND identity_hash=?")
      .get(projectId, videoId, readiness.identityHash) as RunRow | undefined
    : database.prepare(
      "SELECT * FROM video_render_runs WHERE project_id=? AND video_id=? ORDER BY created_at DESC,id DESC LIMIT 1",
    ).get(projectId, videoId) as RunRow | undefined;
  return {
    readiness: {
      ready: readiness !== null, issues: issue ? [issue] : [], gates, spec: VIDEO_RENDER_PARAMS,
      segmentCount: readiness?.timeline.segments.length ?? 0,
      durationMs: readiness?.timeline.audioDurationMs ?? 0,
      estimatedChunks: readiness?.timeline.segments.length ?? 0,
    },
    render: runRecord(database, row),
  };
}

export function enqueueVideoRender(database: DatabaseSync, projectId: string, videoId: string, now = Date.now()) {
  const identity = videoRenderIdentity(database, projectId, videoId);
  database.exec("BEGIN IMMEDIATE");
  try {
    const existing = database.prepare(
      "SELECT * FROM video_render_runs WHERE video_id=? AND identity_hash=?",
    ).get(videoId, identity.identityHash) as RunRow | undefined;
    if (existing && (existing.status === "queued" || existing.status === "running" || existing.status === "succeeded")) {
      database.exec("COMMIT");
      return getVideoRenderWorkspace(database, projectId, videoId);
    }
    const runId = existing?.id ?? `vrr_${randomUUID()}`;
    const job = createJob(database, {
      id: `job_video_render_${randomUUID()}`, type: VIDEO_RENDER_JOB_TYPE,
      payload: { runId, projectId, videoId, identityHash: identity.identityHash }, maxAttempts: 1,
    }, now);
    if (existing) {
      database.prepare(
        "UPDATE video_render_runs SET job_id=?,status='queued',error_summary=NULL,updated_at=? WHERE id=?",
      ).run(job.id, now, runId);
      database.prepare(
        "UPDATE video_render_chunks SET status='queued',error_summary=NULL,updated_at=? WHERE run_id=? AND status<>'succeeded'",
      ).run(now, runId);
    } else {
      database.prepare(
        `INSERT INTO video_render_runs
         (id,project_id,video_id,timeline_id,timeline_hash,visual_review_id,identity_hash,job_id,status,
          params_json,params_hash,error_summary,created_at,updated_at)
         VALUES (?,?,?,?,?,?,?,?, 'queued',?,?,NULL,?,?)`,
      ).run(runId, projectId, videoId, identity.timeline.id, identity.timeline.timelineHash, identity.review.id,
        identity.identityHash, job.id, identity.paramsJson, identity.paramsHash, now, now);
    }
    database.prepare("UPDATE videos SET status='rendering',updated_at=? WHERE id=? AND project_id=?")
      .run(now, videoId, projectId);
    database.exec("COMMIT");
  } catch (error) {
    try { database.exec("ROLLBACK"); } catch { /* 保留原始错误。 */ }
    throw error;
  }
  return getVideoRenderWorkspace(database, projectId, videoId);
}

export function cancelVideoRender(database: DatabaseSync, projectId: string, videoId: string, runId: string, now = Date.now()) {
  getVideo(database, projectId, videoId);
  if (!ID.test(runId)) throw new VideoRenderError(400, "渲染 ID 无效");
  const row = database.prepare("SELECT * FROM video_render_runs WHERE id=? AND project_id=? AND video_id=?")
    .get(runId, projectId, videoId) as RunRow | undefined;
  if (!row) throw new VideoRenderError(404, "渲染任务不存在或不属于当前视频");
  if (row.job_id) requestJobCancellation(database, row.job_id, now);
  if (row.status === "queued") {
    database.prepare("UPDATE video_render_runs SET status='cancelled',updated_at=? WHERE id=?").run(now, runId);
    database.prepare("UPDATE video_render_chunks SET status='cancelled',updated_at=? WHERE run_id=? AND status='queued'")
      .run(now, runId);
  }
  return getVideoRenderWorkspace(database, projectId, videoId);
}

function controlledPath(dataRoot: string, relativePath: string) {
  if (!relativePath || /[\0\r\n]/u.test(relativePath)) throw new VideoRenderError(409, "最终视频路径无效");
  const root = resolve(dataRoot);
  const path = resolve(root, ...relativePath.split("/"));
  if (path === root || !path.startsWith(`${root}${sep}`)) throw new VideoRenderError(409, "最终视频路径越界");
  return path;
}

function inside(root: string, path: string) {
  const value = relative(root, path);
  return value !== "" && value !== ".." && !value.startsWith(`..${sep}`) && !isAbsolute(value);
}

async function openOrdinary(dataRoot: string, path: string) {
  const root = resolve(dataRoot);
  const [rootReal, fileReal, before] = await Promise.all([realpath(root), realpath(path), lstat(path)]);
  if (!inside(rootReal, fileReal) || !before.isFile() || before.isSymbolicLink() || before.nlink !== 1) {
    throw new VideoRenderError(409, "最终视频必须是受控目录内的普通独占文件");
  }
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  const after = await handle.stat();
  if (!after.isFile() || after.dev !== before.dev || after.ino !== before.ino || after.nlink !== 1) {
    await handle.close();
    throw new VideoRenderError(409, "最终视频在打开期间发生变化");
  }
  return handle;
}

async function hashHandle(handle: FileHandle, bytes: number) {
  const hash = createHash("sha256");
  const buffer = Buffer.allocUnsafe(256 * 1024);
  let offset = 0;
  while (offset < bytes) {
    const read = await handle.read(buffer, 0, Math.min(buffer.length, bytes - offset), offset);
    if (!read.bytesRead) break;
    hash.update(buffer.subarray(0, read.bytesRead));
    offset += read.bytesRead;
  }
  if (offset !== bytes) throw new VideoRenderError(409, "最终视频读取不完整");
  return hash.digest("hex");
}

export async function openCurrentFinalVideo(database: DatabaseSync, dataRoot: string, projectId: string, videoId: string) {
  const identity = videoRenderIdentity(database, projectId, videoId);
  const finalIdentity = videoRenderSha256(canonical({ renderIdentity: identity.identityHash, stage: "final-v1" }));
  const row = database.prepare(
    `SELECT final.* FROM video_final_videos final JOIN video_render_runs run ON run.id=final.run_id
     WHERE final.project_id=? AND final.video_id=? AND run.identity_hash=? AND run.status='succeeded'`,
  ).get(projectId, videoId, identity.identityHash) as FinalRow | undefined;
  if (!row) throw new VideoRenderError(404, "当前视频尚无可下载的最终成片");
  const directory = `videos/${videoId}/renders/final/${finalIdentity.slice(0, 2)}/${finalIdentity}`;
  if (row.identity_hash !== finalIdentity || row.relative_path !== `${directory}/video.mp4` ||
      row.manifest_relative_path !== `${directory}/manifest.json` || !HASH.test(row.file_hash) || row.bytes < 1 ||
      !HASH.test(row.manifest_hash) || row.manifest_bytes < 1 || row.manifest_bytes > 8 * 1024 * 1024) {
    throw new VideoRenderError(409, "最终视频登记信息无效");
  }
  const manifestHandle = await openOrdinary(dataRoot, controlledPath(dataRoot, row.manifest_relative_path));
  try {
    const manifestInfo = await manifestHandle.stat();
    if (manifestInfo.size !== row.manifest_bytes || await hashHandle(manifestHandle, row.manifest_bytes) !== row.manifest_hash) {
      throw new VideoRenderError(409, "最终视频清单与登记哈希不一致");
    }
    const content = await manifestHandle.readFile();
    const manifest = JSON.parse(content.toString("utf8")) as Record<string, unknown>;
    if (content.length !== row.manifest_bytes || manifest.version !== "yingshu-video-final-v1" ||
        manifest.projectId !== projectId || manifest.videoId !== videoId ||
        (manifest.final as Record<string, unknown> | undefined)?.identityHash !== finalIdentity) {
      throw new VideoRenderError(409, "最终视频清单身份无效");
    }
  } catch (error) {
    if (error instanceof VideoRenderError) throw error;
    throw new VideoRenderError(409, "最终视频清单损坏");
  } finally { await manifestHandle.close(); }
  const handle = await openOrdinary(dataRoot, controlledPath(dataRoot, row.relative_path));
  try {
    const info = await handle.stat();
    if (info.size !== row.bytes || await hashHandle(handle, row.bytes) !== row.file_hash) {
      throw new VideoRenderError(409, "最终视频文件与登记哈希不一致");
    }
    if (videoRenderIdentity(database, projectId, videoId).identityHash !== identity.identityHash) {
      throw new VideoRenderError(409, "最终视频复核期间上游身份已变化");
    }
    return { handle, bytes: row.bytes, fileHash: row.file_hash, mediaInfo: JSON.parse(row.media_info_json) as unknown };
  } catch (error) { await handle.close(); throw error; }
}
