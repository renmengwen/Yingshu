import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

import {
  assertCurrentVideoVisualTimelineReady,
  getCurrentVideoVisualTimeline,
} from "./video-visual-timeline.js";

export type VideoVisualReviewAction = "approve" | "needs_changes";

interface ReviewRow {
  id: string;
  project_id: string;
  video_id: string;
  revision: number;
  timeline_id: string;
  timeline_revision: number;
  timeline_hash: string;
  identity_hash: string;
  action: VideoVisualReviewAction;
  notes: string;
  created_at: number;
}

export class VideoVisualReviewError extends Error {
  constructor(readonly statusCode: number, message: string) { super(message); }
}

function notes(value: unknown, required: boolean) {
  if (value == null || value === "") {
    if (required) throw new VideoVisualReviewError(422, "请说明需要修改的画面问题");
    return "";
  }
  if (typeof value !== "string") throw new VideoVisualReviewError(422, "整片审核备注无效");
  const normalized = value.replace(/\r\n?/gu, "\n").trim();
  if (!normalized || [...normalized].length > 2_000) throw new VideoVisualReviewError(422, "整片审核备注无效");
  return normalized;
}

function record(row: ReviewRow | undefined) {
  return row ? {
    id: row.id,
    revision: row.revision,
    timelineId: row.timeline_id,
    timelineRevision: row.timeline_revision,
    timelineHash: row.timeline_hash,
    identityHash: row.identity_hash,
    action: row.action,
    notes: row.notes,
    createdAt: row.created_at,
  } : null;
}

function latestReview(database: DatabaseSync, videoId: string) {
  return database.prepare(
    "SELECT * FROM video_visual_review_events WHERE video_id=? ORDER BY revision DESC,id DESC LIMIT 1",
  ).get(videoId) as ReviewRow | undefined;
}

function sameTimeline(row: ReviewRow | undefined, timeline: NonNullable<ReturnType<typeof getCurrentVideoVisualTimeline>>) {
  return !!row && row.timeline_id === timeline.id && row.timeline_revision === timeline.revision &&
    row.timeline_hash === timeline.timelineHash && row.identity_hash === timeline.identityHash;
}

export function getVideoVisualReview(database: DatabaseSync, projectId: string, videoId: string) {
  const timeline = getCurrentVideoVisualTimeline(database, projectId, videoId);
  const latest = latestReview(database, videoId);
  const current = !!timeline && !timeline.stale && sameTimeline(latest, timeline);
  const complete = current && latest!.action === "approve";
  const hasStaleReview = !!timeline && database.prepare(
    `SELECT 1 FROM video_visual_review_events
     WHERE video_id=? AND (timeline_id<>? OR timeline_revision<>? OR timeline_hash<>? OR identity_hash<>?) LIMIT 1`,
  ).get(videoId, timeline.id, timeline.revision, timeline.timelineHash, timeline.identityHash) !== undefined;
  const cues = timeline ? database.prepare(
    "SELECT cue_index,text FROM video_tts_cues WHERE artifact_id=? AND video_id=? ORDER BY cue_index",
  ).all(timeline.ttsArtifactId, videoId) as Array<{ cue_index: number; text: string }> : [];
  const validationIssues: string[] = [];
  if (timeline) {
    if (timeline.stale) validationIssues.push("当前画面时间轴的上游身份已变化，请重新创建时间轴");
    if (!timeline.segments.length || timeline.segments[0]?.startMs !== 0 ||
        timeline.segments.at(-1)?.endMs !== timeline.audioDurationMs) {
      validationIssues.push("画面时间轴未连续覆盖完整音频");
    }
    if (timeline.segments.some((segment, index) => segment.segmentIndex !== index ||
        segment.endMs <= segment.startMs || (index > 0 && segment.startMs !== timeline.segments[index - 1]!.endMs))) {
      validationIssues.push("画面段存在空洞、重叠或顺序错误");
    }
  }
  return {
    timeline,
    preview: timeline?.segments.map((segment) => ({
      id: segment.id,
      segmentIndex: segment.segmentIndex,
      cueStartIndex: segment.cueStartIndex,
      cueEndIndex: segment.cueEndIndex,
      startMs: segment.startMs,
      endMs: segment.endMs,
      visualId: segment.visualId,
      candidateId: segment.candidateId,
      candidateHash: segment.candidateHash,
      narrationSummary: cues.slice(segment.cueStartIndex, segment.cueEndIndex + 1)
        .map((cue) => cue.text).join(" ").slice(0, 240),
      previewUrl: `/api/projects/${encodeURIComponent(projectId)}/videos/${encodeURIComponent(videoId)}` +
        `/image-candidates/${encodeURIComponent(segment.candidateId)}/preview`,
      motionKind: segment.motionKind,
      motionAmountPpm: segment.motionAmountPpm,
      fadeInMs: segment.fadeInMs,
      fadeOutMs: segment.fadeOutMs,
    })) ?? [],
    latestReview: record(latest),
    reviewGate: { complete, approval: complete ? record(latest) : null },
    hasStaleReview: !!latest && (!current || hasStaleReview),
    validationIssues,
  };
}

function body(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new VideoVisualReviewError(422, "整片审核请求无效");
  }
  const input = value as Record<string, unknown>;
  if (Object.keys(input).some((key) => ![
    "timelineId", "timelineRevision", "timelineHash", "identityHash", "action", "notes",
  ].includes(key)) || (input.action !== "approve" && input.action !== "needs_changes")) {
    throw new VideoVisualReviewError(422, "整片审核字段无效");
  }
  return input as Record<string, unknown> & { action: VideoVisualReviewAction };
}

export function saveVideoVisualReview(
  database: DatabaseSync,
  projectId: string,
  videoId: string,
  value: unknown,
  now = Date.now(),
) {
  const input = body(value);
  const timeline = assertCurrentVideoVisualTimelineReady(database, projectId, videoId);
  if (input.timelineId !== timeline.id || input.timelineRevision !== timeline.revision ||
      input.timelineHash !== timeline.timelineHash || input.identityHash !== timeline.identityHash) {
    throw new VideoVisualReviewError(409, "画面时间轴已变化，请刷新整片预览后重新审核");
  }
  const note = notes(input.notes, input.action === "needs_changes");
  database.exec("BEGIN IMMEDIATE");
  try {
    const latest = latestReview(database, videoId);
    // 相同审核请求幂等返回，避免双击产生没有意义的重复事件。
    if (sameTimeline(latest, timeline) && latest!.action === input.action && latest!.notes === note) {
      database.exec("COMMIT");
      return getVideoVisualReview(database, projectId, videoId);
    }
    const revision = (latest?.revision ?? 0) + 1;
    database.prepare(
      `INSERT INTO video_visual_review_events
       (id,project_id,video_id,revision,timeline_id,timeline_revision,timeline_hash,identity_hash,action,notes,created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(`vvre_${randomUUID()}`, projectId, videoId, revision, timeline.id, timeline.revision,
      timeline.timelineHash, timeline.identityHash, input.action, note, now);
    database.exec("COMMIT");
  } catch (error) {
    try { database.exec("ROLLBACK"); } catch { /* 保留原始写入错误。 */ }
    throw error;
  }
  return getVideoVisualReview(database, projectId, videoId);
}
