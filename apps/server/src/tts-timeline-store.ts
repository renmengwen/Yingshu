import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { createHash } from "node:crypto";
import { resolve, sep } from "node:path";
import type { DatabaseSync } from "node:sqlite";

export class TtsTimelineStoreError extends Error {
  constructor(readonly statusCode: number, message: string) { super(message); }
}

interface SegmentRow {
  timeline_hash: string; segment_index: number; episode_id: string; script_version_id: string;
  text: string; provider_id: string; voice: string; rate: number; input_hash: string;
  relative_path: string; file_hash: string; bytes: number; duration_ms: number; created_at: number;
}

function timelineRows(database: DatabaseSync, episodeId: string, timelineHash: string) {
  return database.prepare(
    `SELECT timeline_hash, segment_index, episode_id, script_version_id, text, provider_id, voice, rate,
            input_hash, relative_path, file_hash, bytes, duration_ms, created_at
     FROM audio_segments WHERE episode_id = ? AND timeline_hash = ? ORDER BY segment_index`,
  ).all(episodeId, timelineHash) as unknown as SegmentRow[];
}

function resultReuseCount(database: DatabaseSync, episodeId: string, timelineHash: string) {
  const rows = database.prepare(
    `SELECT result_json FROM jobs WHERE type = 'tts_timeline' AND status = 'succeeded'
     AND result_json IS NOT NULL ORDER BY finished_at DESC, created_at DESC`,
  ).all() as unknown as Array<{ result_json: string }>;
  for (const row of rows) {
    try {
      const result = JSON.parse(row.result_json) as { episodeId?: unknown; timelineHash?: unknown; reusedSegments?: unknown };
      if (result.episodeId === episodeId && result.timelineHash === timelineHash &&
          Number.isSafeInteger(result.reusedSegments) && (result.reusedSegments as number) >= 0) {
        return result.reusedSegments as number;
      }
    } catch { /* 忽略旧任务的非标准结果。 */ }
  }
  return null;
}

function summary(database: DatabaseSync, rows: SegmentRow[]) {
  const first = rows[0]!;
  return {
    episodeId: first.episode_id,
    scriptVersionId: first.script_version_id,
    timelineHash: first.timeline_hash,
    providerId: first.provider_id,
    voice: first.voice,
    rate: first.rate,
    durationMs: rows.reduce((total, row) => total + row.duration_ms, 0),
    segmentCount: rows.length,
    cueCount: Number((database.prepare(
      "SELECT COUNT(*) AS count FROM subtitle_cues WHERE episode_id = ? AND timeline_hash = ?",
    ).get(first.episode_id, first.timeline_hash) as { count: number }).count),
    reusedSegments: resultReuseCount(database, first.episode_id, first.timeline_hash),
    createdAt: Math.max(...rows.map((row) => row.created_at)),
    srtIdentity: `${first.timeline_hash}.srt`,
    assIdentity: `${first.timeline_hash}.ass`,
  };
}

export function listTtsTimelines(database: DatabaseSync, episodeId: string) {
  const approval = database.prepare(
    `SELECT action, script_version_id FROM script_approval_events
     WHERE episode_id = ? ORDER BY revision DESC LIMIT 1`,
  ).get(episodeId) as { action: string; script_version_id: string } | undefined;
  if (!database.prepare("SELECT id FROM episodes WHERE id = ?").get(episodeId)) {
    throw new TtsTimelineStoreError(404, "分集不存在");
  }
  if (!approval || approval.action !== "approve") return [];
  const hashes = database.prepare(
    `SELECT timeline_hash, MAX(created_at) AS created_at FROM audio_segments
     WHERE episode_id = ? AND script_version_id = ? GROUP BY timeline_hash ORDER BY created_at DESC`,
  ).all(episodeId, approval.script_version_id) as unknown as Array<{ timeline_hash: string }>;
  return hashes.map((row) => summary(database, timelineRows(database, episodeId, row.timeline_hash)));
}

export function getTtsTimeline(database: DatabaseSync, episodeId: string, timelineHash: string) {
  if (!/^[0-9a-f]{64}$/.test(timelineHash)) throw new TtsTimelineStoreError(400, "语音时间轴哈希无效");
  const rows = timelineRows(database, episodeId, timelineHash);
  if (!rows.length) throw new TtsTimelineStoreError(404, "语音时间轴不存在");
  const cues = database.prepare(
    `SELECT cue_index, segment_index, start_ms, end_ms, text FROM subtitle_cues
     WHERE episode_id = ? AND timeline_hash = ? ORDER BY cue_index`,
  ).all(episodeId, timelineHash) as unknown as Array<{
    cue_index: number; segment_index: number; start_ms: number; end_ms: number; text: string;
  }>;
  return {
    ...summary(database, rows),
    segments: rows.map((row) => ({
      index: row.segment_index, text: row.text, inputHash: row.input_hash, fileHash: row.file_hash,
      bytes: row.bytes, durationMs: row.duration_ms,
    })),
    cues: cues.map((cue) => ({
      index: cue.cue_index, segmentIndex: cue.segment_index, startMs: cue.start_ms,
      endMs: cue.end_ms, text: cue.text,
    })),
  };
}

export async function readVerifiedTtsSegment(
  database: DatabaseSync, dataRoot: string, episodeId: string, timelineHash: string, segmentIndex: number,
) {
  if (!/^[0-9a-f]{64}$/.test(timelineHash) || !Number.isSafeInteger(segmentIndex) || segmentIndex < 0) {
    throw new TtsTimelineStoreError(400, "语音段参数无效");
  }
  const row = database.prepare(
    `SELECT relative_path, input_hash, file_hash, bytes FROM audio_segments
     WHERE episode_id = ? AND timeline_hash = ? AND segment_index = ?`,
  ).get(episodeId, timelineHash, segmentIndex) as {
    relative_path: string; input_hash: string; file_hash: string; bytes: number;
  } | undefined;
  if (!row) throw new TtsTimelineStoreError(404, "语音段不存在");
  const expected = `episodes/${episodeId}/audio/segments/${row.input_hash}.wav`;
  if (row.relative_path !== expected) throw new TtsTimelineStoreError(409, "语音段登记路径无效");
  const root = resolve(dataRoot);
  const path = resolve(root, ...row.relative_path.split("/"));
  if (!path.startsWith(`${root}${sep}`)) throw new TtsTimelineStoreError(409, "语音段路径越界");
  let file;
  try {
    file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const info = await file.stat();
    if (!info.isFile()) throw new TtsTimelineStoreError(409, "语音段不是普通文件");
    const bytes = await file.readFile();
    if (bytes.length !== row.bytes || createHash("sha256").update(bytes).digest("hex") !== row.file_hash) {
      throw new TtsTimelineStoreError(409, "语音段文件与登记信息不一致");
    }
    return bytes;
  } catch (error) {
    if (error instanceof TtsTimelineStoreError) throw error;
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new TtsTimelineStoreError(404, "语音段文件不存在");
    throw new TtsTimelineStoreError(409, "语音段文件无法安全读取");
  } finally {
    await file?.close();
  }
}
