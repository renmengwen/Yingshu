import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

import { getVideo } from "./project-video-store.js";
import { canonical, sha256, type VideoVisualItem } from "./video-plan-contract.js";
import { getVideoPlan } from "./video-plan-store.js";
import { getVideoAudioReview } from "./video-audio-review.js";
import { getVideoImageWorkspace } from "./video-image-store.js";
import { getVideoTtsState, type VideoTtsCue } from "./video-tts-store.js";

export type VideoVisualMotionKind = "still" | "zoom_in" | "zoom_out" | "pan_left" | "pan_right";

export interface VideoVisualTimelineSegment {
  id: string;
  stableSegmentId: string;
  segmentIndex: number;
  cueStartIndex: number;
  cueEndIndex: number;
  cueStartHash: string;
  cueEndHash: string;
  startMs: number;
  endMs: number;
  visualId: string;
  candidateId: string;
  candidateHash: string;
  candidateRelativePath: string;
  motionKind: VideoVisualMotionKind;
  motionAmountPpm: number;
  fadeInMs: number;
  fadeOutMs: number;
  segmentHash: string;
}

export interface VideoVisualTimeline {
  id: string;
  projectId: string;
  videoId: string;
  revision: number;
  identityHash: string;
  planSnapshotId: string;
  planSnapshotHash: string;
  scriptRevisionId: string;
  scriptContentHash: string;
  visualRevisionId: string;
  visualContentHash: string;
  imageGateRevision: number;
  ttsSnapshotId: string;
  ttsSnapshotHash: string;
  ttsArtifactId: string;
  audioHash: string;
  cuesHash: string;
  srtHash: string;
  assHash: string;
  audioDurationMs: number;
  timelineHash: string;
  createdAt: number;
  segments: VideoVisualTimelineSegment[];
  stale: boolean;
}

interface TimelineRow {
  id: string; project_id: string; video_id: string; revision: number; identity_hash: string;
  plan_snapshot_id: string; plan_snapshot_hash: string; script_revision_id: string; script_content_hash: string;
  visual_revision_id: string; visual_content_hash: string; image_gate_revision: number;
  tts_snapshot_id: string; tts_snapshot_hash: string; tts_artifact_id: string; audio_hash: string;
  cues_hash: string; srt_hash: string; ass_hash: string; audio_duration_ms: number; timeline_hash: string; created_at: number;
}

interface SegmentRow {
  id: string; stable_segment_id: string; segment_index: number; cue_start_index: number; cue_end_index: number;
  cue_start_hash: string; cue_end_hash: string; start_ms: number; end_ms: number; visual_id: string;
  candidate_id: string; candidate_hash: string; candidate_relative_path: string; motion_kind: VideoVisualMotionKind;
  motion_amount_ppm: number; fade_in_ms: number; fade_out_ms: number; segment_hash: string;
}

export class VideoVisualTimelineError extends Error {
  constructor(readonly statusCode: number, message: string) { super(message); }
}

function currentInputs(database: DatabaseSync, projectId: string, videoId: string) {
  getVideo(database, projectId, videoId);
  const plan = getVideoPlan(database, projectId, videoId);
  if (!plan || plan.stale || !plan.approval?.valid) {
    throw new VideoVisualTimelineError(409, "请先批准当前旁白与画面方案");
  }
  const image = getVideoImageWorkspace(database, projectId, videoId);
  if (!image.gateComplete || image.visualCount !== plan.visual.visuals.length) {
    throw new VideoVisualTimelineError(409, "请先为每个当前画面批准且仅批准一张有效图片");
  }
  const audioReview = getVideoAudioReview(database, projectId, videoId);
  const tts = getVideoTtsState(database, projectId, videoId);
  if (!audioReview.audioGate.complete || audioReview.stale || !tts?.artifact || tts.stale) {
    throw new VideoVisualTimelineError(409, "请先完成当前真实配音的听音审核");
  }
  const candidates = new Map(image.candidates.filter((item) => item.currentCompatible)
    .map((item) => [item.id, item]));
  const approved = new Map(image.approvals.map((item) => [item.visualId, item]));
  const bindings = plan.visual.visuals.map((visual) => {
    const approval = approved.get(visual.id);
    const candidate = approval ? candidates.get(approval.candidateId) : undefined;
    if (!candidate?.fileHash || !candidate.relativePath || candidate.visualId !== visual.id) {
      throw new VideoVisualTimelineError(409, "当前图片审核包含失效或缺少受控文件身份的候选图");
    }
    return { visual, candidateId: candidate.id, candidateHash: candidate.fileHash, relativePath: candidate.relativePath };
  });
  return { plan, image, snapshot: tts.snapshot, artifact: tts.artifact, bindings };
}

function cueRange(cues: VideoTtsCue[], startMs: number, endMs: number) {
  let first = cues.findIndex((cue) => cue.endMs > startMs);
  if (first < 0) first = cues.length - 1;
  let last = cues.length - 1;
  while (last >= 0 && cues[last]!.startMs >= endMs) last -= 1;
  if (last < first) last = first;
  return { first: cues[first]!, last: cues[last]! };
}

function splitDuration(startMs: number, endMs: number, visuals: VideoVisualItem[]) {
  const duration = endMs - startMs;
  if (duration < visuals.length) throw new VideoVisualTimelineError(409, "旁白段落过短，无法为每个正式画面分配正时长");
  const weight = visuals.reduce((sum, visual) => sum + visual.weight, 0);
  let cursor = startMs;
  return visuals.map((visual, index) => {
    const end = index === visuals.length - 1
      ? endMs
      : Math.max(cursor + 1, Math.min(endMs - (visuals.length - index - 1),
        startMs + Math.round(duration * visuals.slice(0, index + 1).reduce((sum, item) => sum + item.weight, 0) / weight)));
    const range = { visual, startMs: cursor, endMs: end };
    cursor = end;
    return range;
  });
}

function automaticSegments(input: ReturnType<typeof currentInputs>): Omit<VideoVisualTimelineSegment, "id" | "segmentHash">[] {
  const { plan, artifact, bindings } = input;
  const byParagraph = new Map(plan.script.paragraphs.map((paragraph) => [paragraph.id, {
    paragraph,
    cues: artifact.cues.filter((cue) => cue.paragraphId === paragraph.id),
    visuals: bindings.filter((binding) => binding.visual.paragraphId === paragraph.id),
  }]));
  if ([...byParagraph.values()].some((item) => !item.cues.length || !item.visuals.length)) {
    throw new VideoVisualTimelineError(409, "旁白 cue 与正式画面没有完整的段落语义覆盖");
  }
  let segmentIndex = 0;
  let paragraphStart = 0;
  const segments: Omit<VideoVisualTimelineSegment, "id" | "segmentHash">[] = [];
  for (const [paragraphIndex, paragraph] of plan.script.paragraphs.entries()) {
    const item = byParagraph.get(paragraph.id)!;
    const paragraphEnd = paragraphIndex === plan.script.paragraphs.length - 1
      ? artifact.audio.durationMs : item.cues.at(-1)!.endMs;
    for (const allocation of splitDuration(paragraphStart, paragraphEnd, item.visuals.map((entry) => entry.visual))) {
      const binding = item.visuals.find((entry) => entry.visual.id === allocation.visual.id)!;
      const cue = cueRange(artifact.cues, allocation.startMs, allocation.endMs);
      const motionKind: VideoVisualMotionKind = segmentIndex % 3 === 0 ? "zoom_in" : segmentIndex % 3 === 1 ? "pan_left" : "zoom_out";
      segments.push({
        stableSegmentId: `segment_${sha256(`${input.plan.script.id}\0${allocation.visual.id}`).slice(0, 24)}`,
        segmentIndex, cueStartIndex: cue.first.index, cueEndIndex: cue.last.index,
        cueStartHash: cue.first.hash, cueEndHash: cue.last.hash, startMs: allocation.startMs, endMs: allocation.endMs,
        visualId: allocation.visual.id, candidateId: binding.candidateId, candidateHash: binding.candidateHash,
        candidateRelativePath: binding.relativePath, motionKind, motionAmountPpm: 80_000, fadeInMs: 250, fadeOutMs: 250,
      });
      segmentIndex += 1;
    }
    paragraphStart = paragraphEnd;
  }
  return segments;
}

function segmentHash(segment: Omit<VideoVisualTimelineSegment, "id" | "segmentHash">) {
  return sha256(canonical(segment));
}

function frozenIdentity(input: ReturnType<typeof currentInputs>, segments: Array<Omit<VideoVisualTimelineSegment, "id" | "segmentHash">>) {
  return {
    planSnapshotId: input.plan.snapshotId, planSnapshotHash: input.plan.snapshotHash,
    scriptRevisionId: input.plan.script.id, scriptContentHash: input.plan.script.contentHash,
    visualRevisionId: input.plan.visual.id, visualContentHash: input.plan.visual.contentHash,
    imageGateRevision: input.image.gateRevision, ttsSnapshotId: input.snapshot.id,
    ttsSnapshotHash: input.snapshot.snapshotHash, ttsArtifactId: input.artifact.id,
    audioHash: input.artifact.audio.hash, cuesHash: input.artifact.cuesHash,
    srtHash: input.artifact.subtitles.srt.hash, assHash: input.artifact.subtitles.ass.hash,
    audioDurationMs: input.artifact.audio.durationMs,
    segments: segments.map((segment) => ({ stableSegmentId: segment.stableSegmentId, startMs: segment.startMs,
      endMs: segment.endMs, visualId: segment.visualId, candidateId: segment.candidateId,
      candidateHash: segment.candidateHash, motionKind: segment.motionKind, motionAmountPpm: segment.motionAmountPpm,
      fadeInMs: segment.fadeInMs, fadeOutMs: segment.fadeOutMs })),
  };
}

function segmentRecord(row: SegmentRow): VideoVisualTimelineSegment {
  return {
    id: row.id, stableSegmentId: row.stable_segment_id, segmentIndex: row.segment_index,
    cueStartIndex: row.cue_start_index, cueEndIndex: row.cue_end_index, cueStartHash: row.cue_start_hash,
    cueEndHash: row.cue_end_hash, startMs: row.start_ms, endMs: row.end_ms, visualId: row.visual_id,
    candidateId: row.candidate_id, candidateHash: row.candidate_hash, candidateRelativePath: row.candidate_relative_path,
    motionKind: row.motion_kind, motionAmountPpm: row.motion_amount_ppm, fadeInMs: row.fade_in_ms,
    fadeOutMs: row.fade_out_ms, segmentHash: row.segment_hash,
  };
}

function rowRecord(database: DatabaseSync, row: TimelineRow, stale: boolean): VideoVisualTimeline {
  const segments = (database.prepare(
    "SELECT * FROM video_visual_segments WHERE timeline_id=? ORDER BY segment_index",
  ).all(row.id) as unknown as SegmentRow[]).map(segmentRecord);
  return {
    id: row.id, projectId: row.project_id, videoId: row.video_id, revision: row.revision,
    identityHash: row.identity_hash, planSnapshotId: row.plan_snapshot_id, planSnapshotHash: row.plan_snapshot_hash,
    scriptRevisionId: row.script_revision_id, scriptContentHash: row.script_content_hash,
    visualRevisionId: row.visual_revision_id, visualContentHash: row.visual_content_hash,
    imageGateRevision: row.image_gate_revision, ttsSnapshotId: row.tts_snapshot_id,
    ttsSnapshotHash: row.tts_snapshot_hash, ttsArtifactId: row.tts_artifact_id, audioHash: row.audio_hash,
    cuesHash: row.cues_hash, srtHash: row.srt_hash, assHash: row.ass_hash, audioDurationMs: row.audio_duration_ms,
    timelineHash: row.timeline_hash, createdAt: row.created_at, segments, stale,
  };
}

function validateContinuity(segments: VideoVisualTimelineSegment[], durationMs: number) {
  if (!segments.length || segments[0]!.startMs !== 0 || segments.at(-1)!.endMs !== durationMs ||
      segments.some((segment, index) => segment.segmentIndex !== index || segment.endMs <= segment.startMs ||
        (index > 0 && segment.startMs !== segments[index - 1]!.endMs))) {
    throw new VideoVisualTimelineError(409, "视觉时间轴存在空洞、重叠或反向区间");
  }
}

export function getCurrentVideoVisualTimeline(database: DatabaseSync, projectId: string, videoId: string) {
  getVideo(database, projectId, videoId);
  const row = database.prepare(
    "SELECT * FROM video_visual_timelines WHERE project_id=? AND video_id=? ORDER BY revision DESC LIMIT 1",
  ).get(projectId, videoId) as unknown as TimelineRow | undefined;
  if (!row) return null;
  let stale = true;
  try {
    const current = currentInputs(database, projectId, videoId);
    const record = rowRecord(database, row, false);
    stale = sha256(canonical(frozenIdentity(current, record.segments))) !== row.identity_hash;
  } catch { stale = true; }
  return rowRecord(database, row, stale);
}

function persistTimeline(database: DatabaseSync, projectId: string, videoId: string,
  input: ReturnType<typeof currentInputs>, rawSegments: Array<Omit<VideoVisualTimelineSegment, "id" | "segmentHash">>, now: number) {
  const identityHash = sha256(canonical(frozenIdentity(input, rawSegments)));
  const existing = database.prepare(
    "SELECT * FROM video_visual_timelines WHERE video_id=? AND identity_hash=?",
  ).get(videoId, identityHash) as unknown as TimelineRow | undefined;
  if (existing) return rowRecord(database, existing, false);
  const revision = ((database.prepare("SELECT MAX(revision) AS revision FROM video_visual_timelines WHERE video_id=?")
    .get(videoId) as { revision: number | null }).revision ?? 0) + 1;
  const timelineId = `vvt_${randomUUID()}`;
  const segments = rawSegments.map((segment) => ({ ...segment, id: `vvs_${randomUUID()}`, segmentHash: segmentHash(segment) }));
  const timelineHash = sha256(canonical({ identityHash, segments: segments.map((segment) => segment.segmentHash) }));
  database.prepare(
    `INSERT INTO video_visual_timelines
     (id,project_id,video_id,revision,identity_hash,plan_snapshot_id,plan_snapshot_hash,script_revision_id,
      script_content_hash,visual_revision_id,visual_content_hash,image_gate_revision,tts_snapshot_id,tts_snapshot_hash,
      tts_artifact_id,audio_hash,cues_hash,srt_hash,ass_hash,audio_duration_ms,timeline_hash,created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(timelineId, projectId, videoId, revision, identityHash, input.plan.snapshotId, input.plan.snapshotHash,
    input.plan.script.id, input.plan.script.contentHash, input.plan.visual.id, input.plan.visual.contentHash,
    input.image.gateRevision, input.snapshot.id, input.snapshot.snapshotHash, input.artifact.id, input.artifact.audio.hash,
    input.artifact.cuesHash, input.artifact.subtitles.srt.hash, input.artifact.subtitles.ass.hash,
    input.artifact.audio.durationMs, timelineHash, now);
  const insert = database.prepare(
    `INSERT INTO video_visual_segments
     (id,stable_segment_id,project_id,timeline_id,video_id,segment_index,cue_start_index,cue_end_index,cue_start_hash,
      cue_end_hash,start_ms,end_ms,visual_id,candidate_id,candidate_hash,candidate_relative_path,motion_kind,
      motion_amount_ppm,fade_in_ms,fade_out_ms,segment_hash,created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  );
  for (const segment of segments) insert.run(segment.id, segment.stableSegmentId, projectId, timelineId, videoId,
    segment.segmentIndex, segment.cueStartIndex, segment.cueEndIndex, segment.cueStartHash, segment.cueEndHash,
    segment.startMs, segment.endMs, segment.visualId, segment.candidateId, segment.candidateHash,
    segment.candidateRelativePath, segment.motionKind, segment.motionAmountPpm, segment.fadeInMs, segment.fadeOutMs,
    segment.segmentHash, now);
  return rowRecord(database, database.prepare("SELECT * FROM video_visual_timelines WHERE id=?")
    .get(timelineId) as unknown as TimelineRow, false);
}

export function createVideoVisualTimeline(database: DatabaseSync, projectId: string, videoId: string, now = Date.now()) {
  const input = currentInputs(database, projectId, videoId);
  const segments = automaticSegments(input);
  database.exec("BEGIN IMMEDIATE");
  try {
    const result = persistTimeline(database, projectId, videoId, input, segments, now);
    database.exec("COMMIT");
    return result;
  } catch (error) {
    try { database.exec("ROLLBACK"); } catch { /* 保留原始写入错误。 */ }
    throw error;
  }
}

export function updateVideoVisualSegment(database: DatabaseSync, projectId: string, videoId: string,
  timelineId: string, segmentIndex: number, value: unknown, now = Date.now()) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new VideoVisualTimelineError(422, "运镜调整无效");
  const body = value as Record<string, unknown>;
  if (Object.keys(body).some((key) => !["motionKind", "motionAmountPpm", "fadeInMs", "fadeOutMs"].includes(key)) ||
      !["still", "zoom_in", "zoom_out", "pan_left", "pan_right"].includes(String(body.motionKind)) ||
      !Number.isInteger(body.motionAmountPpm) || (body.motionAmountPpm as number) < 0 || (body.motionAmountPpm as number) > 500_000 ||
      !Number.isInteger(body.fadeInMs) || (body.fadeInMs as number) < 0 || (body.fadeInMs as number) > 5_000 ||
      body.fadeOutMs !== body.fadeInMs) {
    throw new VideoVisualTimelineError(422, "运镜幅度或淡入淡出参数无效");
  }
  if (body.motionKind === "still" && body.motionAmountPpm !== 0) {
    throw new VideoVisualTimelineError(422, "静态画面不能设置运镜幅度");
  }
  const current = assertCurrentVideoVisualTimelineReady(database, projectId, videoId);
  if (current.id !== timelineId || !Number.isSafeInteger(segmentIndex) || !current.segments[segmentIndex]) {
    throw new VideoVisualTimelineError(409, "画面时间轴已变化，请刷新后重试");
  }
  const input = currentInputs(database, projectId, videoId);
  const segments = current.segments.map(({ id: _id, segmentHash: _hash, ...segment }, index) => index === segmentIndex ? {
    ...segment, motionKind: body.motionKind as VideoVisualMotionKind, motionAmountPpm: body.motionAmountPpm as number,
    fadeInMs: body.fadeInMs as number, fadeOutMs: body.fadeInMs as number,
  } : segment);
  database.exec("BEGIN IMMEDIATE");
  try {
    const result = persistTimeline(database, projectId, videoId, input, segments, now);
    database.exec("COMMIT");
    return result;
  } catch (error) {
    try { database.exec("ROLLBACK"); } catch { /* 保留原始写入错误。 */ }
    throw error;
  }
}

export function assertCurrentVideoVisualTimelineReady(database: DatabaseSync, projectId: string, videoId: string) {
  const timeline = getCurrentVideoVisualTimeline(database, projectId, videoId);
  if (!timeline) throw new VideoVisualTimelineError(409, "请先创建正式画面时间轴");
  if (timeline.stale) throw new VideoVisualTimelineError(409, "画面时间轴已因上游变化失效，请重新创建");
  validateContinuity(timeline.segments, timeline.audioDurationMs);
  if (new Set(timeline.segments.map((segment) => segment.visualId)).size === 0 ||
      timeline.segments.some((segment) => !segment.candidateId || !segment.candidateHash)) {
    throw new VideoVisualTimelineError(409, "画面时间轴缺少当前批准图片");
  }
  return timeline;
}
