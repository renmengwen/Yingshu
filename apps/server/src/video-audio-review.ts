import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

import { getVideoTtsState, type VideoTtsArtifact, type VideoTtsSnapshot } from "./video-tts-store.js";

export type VideoAudioDurationDecision = "within_target" | "accept_actual" | "reprocess";
export type VideoAudioReviewAction = "approve" | "needs_regeneration";

interface ReviewRow {
  id: string; revision: number; snapshot_id: string; snapshot_hash: string; artifact_id: string;
  action: VideoAudioReviewAction; notes: string; duration_decision: VideoAudioDurationDecision;
  script_revision_id: string; script_content_hash: string; provider_id: string; model_id: string;
  voice_id: string; rate: number; language: string; audio_hash: string; cues_hash: string;
  srt_hash: string; ass_hash: string; deviation_ratio: number; created_at: number;
}

export class VideoAudioReviewError extends Error {
  constructor(readonly statusCode: number, message: string) { super(message); }
}

function requiredId(value: unknown, label: string) {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]+$/u.test(value)) throw new VideoAudioReviewError(422, `${label}无效`);
  return value;
}

function reviewNotes(value: unknown) {
  if (value == null || value === "") return "";
  if (typeof value !== "string") throw new VideoAudioReviewError(422, "听音备注无效");
  const normalized = value.replace(/\r\n?/gu, "\n").trim();
  if ([...normalized].length > 2_000) throw new VideoAudioReviewError(422, "听音备注无效");
  return normalized;
}

function reviewRecord(row: ReviewRow | undefined) {
  return row ? {
    id: row.id, revision: row.revision, snapshotId: row.snapshot_id, snapshotHash: row.snapshot_hash,
    artifactId: row.artifact_id, action: row.action, notes: row.notes, durationDecision: row.duration_decision,
    deviationRatio: row.deviation_ratio, createdAt: row.created_at,
  } : null;
}

function identityMatches(row: ReviewRow, snapshot: VideoTtsSnapshot, artifact: VideoTtsArtifact) {
  return row.snapshot_id === snapshot.id && row.snapshot_hash === snapshot.snapshotHash && row.artifact_id === artifact.id &&
    row.script_revision_id === snapshot.scriptRevisionId && row.script_content_hash === snapshot.scriptContentHash &&
    row.provider_id === snapshot.providerId && row.model_id === snapshot.modelId && row.voice_id === snapshot.voiceId &&
    row.rate === snapshot.rate && row.language === snapshot.language && row.audio_hash === artifact.audio.hash &&
    row.cues_hash === artifact.cuesHash && row.srt_hash === artifact.subtitles.srt.hash && row.ass_hash === artifact.subtitles.ass.hash;
}

function validateCues(snapshot: VideoTtsSnapshot, artifact: VideoTtsArtifact) {
  const paragraphIds = new Set(snapshot.paragraphs.map((item) => item.id));
  if (!artifact.cues.length || artifact.cues[0]!.startMs !== 0 ||
      artifact.cues[artifact.cues.length - 1]!.endMs !== artifact.audio.durationMs ||
      artifact.cues.some((cue, index) => cue.index !== index || !paragraphIds.has(cue.paragraphId) ||
      !cue.text || cue.startMs < 0 || cue.endMs <= cue.startMs || cue.endMs > artifact.audio.durationMs ||
      (index > 0 && cue.startMs < artifact.cues[index - 1]!.endMs))) {
    throw new VideoAudioReviewError(409, "当前字幕时间轴无效，不能完成听音审核");
  }
}

function latestReview(database: DatabaseSync, videoId: string) {
  return database.prepare(
    "SELECT * FROM video_audio_review_events WHERE video_id = ? ORDER BY revision DESC,id DESC LIMIT 1",
  ).get(videoId) as ReviewRow | undefined;
}

export function getVideoAudioReview(database: DatabaseSync, projectId: string, videoId: string) {
  const state = getVideoTtsState(database, projectId, videoId);
  if (!state) return { snapshot: null, artifact: null, cues: [], latestReview: null, audioGate: { complete: false }, stale: false };
  const { snapshot, artifact, stale } = state;
  const latest = latestReview(database, videoId);
  const ratio = artifact?.deviationRatio ?? null;
  const complete = !!artifact && !stale && !!latest && latest.action === "approve" && identityMatches(latest, snapshot, artifact) &&
    ((ratio! <= 0.1 && latest.duration_decision === "within_target") ||
      (ratio! > 0.1 && latest.duration_decision === "accept_actual"));
  return {
    snapshot: {
      id: snapshot.id, snapshotHash: snapshot.snapshotHash, providerId: snapshot.providerId,
      providerName: snapshot.providerName, providerKind: snapshot.providerKind, modelId: snapshot.modelId,
      voiceId: snapshot.voiceId, rate: snapshot.rate, language: snapshot.language,
      targetDurationSeconds: snapshot.targetDurationSeconds, scriptRevisionId: snapshot.scriptRevisionId,
      scriptContentHash: snapshot.scriptContentHash, createdAt: snapshot.createdAt,
    },
    artifact: artifact && {
      id: artifact.id, jobId: artifact.jobId, durationMs: artifact.audio.durationMs, audioMime: artifact.audio.mime,
      audioCodec: artifact.audio.codec, sampleRate: artifact.audio.sampleRate, channels: artifact.audio.channels,
      audioBytes: artifact.audio.bytes, audioHash: artifact.audio.hash, cuesHash: artifact.cuesHash,
      srtHash: artifact.subtitles.srt.hash, assHash: artifact.subtitles.ass.hash, createdAt: artifact.createdAt,
    },
    cues: artifact?.cues.map((cue) => ({ index: cue.index, paragraphId: cue.paragraphId, text: cue.text,
      startMs: cue.startMs, endMs: cue.endMs, cueHash: cue.hash })) ?? [],
    deviationRatio: ratio, withinTarget: ratio === null ? null : ratio <= 0.1,
    latestReview: reviewRecord(latest), audioGate: { complete, approval: complete ? reviewRecord(latest) : null }, stale,
  };
}

function requestBody(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new VideoAudioReviewError(422, "听音审核请求无效");
  return value as Record<string, unknown>;
}

function appendReview(database: DatabaseSync, input: {
  projectId: string; videoId: string; snapshotId: unknown; artifactId: unknown;
  action: VideoAudioReviewAction; notes: unknown; durationDecision: unknown; confirmedFullPlayback?: unknown;
}, now = Date.now()) {
  const snapshotId = requiredId(input.snapshotId, "配音快照 ID");
  const artifactId = requiredId(input.artifactId, "音频产物 ID");
  const state = getVideoTtsState(database, input.projectId, input.videoId);
  if (!state?.artifact || state.snapshot.id !== snapshotId || state.artifact.id !== artifactId) {
    throw new VideoAudioReviewError(409, "配音或音频身份已变化，请刷新后重试");
  }
  if (state.stale) throw new VideoAudioReviewError(409, "当前方案或旁白已失效，不能审核旧音频");
  validateCues(state.snapshot, state.artifact);
  const ratio = state.artifact.deviationRatio;
  let durationDecision: VideoAudioDurationDecision;
  if (input.action === "approve") {
    if (input.confirmedFullPlayback !== true) throw new VideoAudioReviewError(409, "请完整试听并确认后再批准");
    const expected = ratio > 0.1 ? "accept_actual" : "within_target";
    if (input.durationDecision !== expected) {
      throw new VideoAudioReviewError(409, ratio > 0.1 ? "实际时长偏差超过 10%，请先明确接受实际时长" : "时长在目标范围内，请使用正常时长决策");
    }
    durationDecision = expected;
  } else if (input.durationDecision !== "reprocess") {
    throw new VideoAudioReviewError(422, "需要重新生成时必须选择重新处理");
  } else durationDecision = "reprocess";
  const note = reviewNotes(input.notes);
  database.exec("BEGIN IMMEDIATE");
  try {
    const revision = ((database.prepare(
      "SELECT MAX(revision) AS revision FROM video_audio_review_events WHERE video_id = ?",
    ).get(input.videoId) as { revision: number | null }).revision ?? 0) + 1;
    database.prepare(
      `INSERT INTO video_audio_review_events (id,project_id,video_id,revision,snapshot_id,snapshot_hash,artifact_id,
       action,notes,duration_decision,script_revision_id,script_content_hash,provider_id,model_id,voice_id,rate,
       language,audio_hash,cues_hash,srt_hash,ass_hash,deviation_ratio,created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(`vare_${randomUUID()}`, input.projectId, input.videoId, revision, state.snapshot.id, state.snapshot.snapshotHash,
      state.artifact.id, input.action, note, durationDecision, state.snapshot.scriptRevisionId,
      state.snapshot.scriptContentHash, state.snapshot.providerId, state.snapshot.modelId, state.snapshot.voiceId,
      state.snapshot.rate, state.snapshot.language, state.artifact.audio.hash, state.artifact.cuesHash,
      state.artifact.subtitles.srt.hash, state.artifact.subtitles.ass.hash, ratio, now);
    database.exec("COMMIT");
  } catch (error) {
    try { database.exec("ROLLBACK"); } catch { /* 保留原始写入错误。 */ }
    throw error;
  }
  return getVideoAudioReview(database, input.projectId, input.videoId);
}

export function saveVideoAudioReview(database: DatabaseSync, projectId: string, videoId: string, value: unknown, now = Date.now()) {
  const input = requestBody(value);
  if (Object.keys(input).some((key) => !["snapshotId", "artifactId", "action", "notes", "durationDecision"].includes(key)) ||
      input.action !== "needs_regeneration") throw new VideoAudioReviewError(422, "听音审核字段无效");
  return appendReview(database, { projectId, videoId, snapshotId: input.snapshotId, artifactId: input.artifactId,
    action: "needs_regeneration", notes: input.notes, durationDecision: input.durationDecision }, now);
}

export function approveVideoAudio(database: DatabaseSync, projectId: string, videoId: string, value: unknown, now = Date.now()) {
  const input = requestBody(value);
  if (Object.keys(input).some((key) => !["snapshotId", "artifactId", "confirmedFullPlayback", "notes", "durationDecision"].includes(key))) {
    throw new VideoAudioReviewError(422, "音频批准字段无效");
  }
  return appendReview(database, { projectId, videoId, snapshotId: input.snapshotId, artifactId: input.artifactId,
    action: "approve", notes: input.notes, durationDecision: input.durationDecision,
    confirmedFullPlayback: input.confirmedFullPlayback }, now);
}
