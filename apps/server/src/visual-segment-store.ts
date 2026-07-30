import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

const HASH = /^[0-9a-f]{64}$/u;
const MOTIONS = ["none", "pan-left", "pan-right", "zoom-in", "zoom-out"] as const;

export type VisualMotionKind = typeof MOTIONS[number];

export interface VisualSegmentAssetInput {
  assetId: string;
  selectedCandidateId?: string;
}

export interface PutVisualSegmentInput {
  timelineHash: string;
  cueStartIndex: number;
  cueEndIndex: number;
  motionKind: VisualMotionKind;
  motionAmountPpm: number;
  fadeMs: number;
  expectedRevision: number;
  assets: VisualSegmentAssetInput[];
}

export interface VisualSegmentAssetRecord {
  assetId: string;
  selectedCandidateId: string | null;
  candidateReviewRevision: number | null;
}

export interface VisualSegmentRecord {
  id: string;
  episodeId: string;
  segmentIndex: number;
  scriptVersionId: string;
  approvalRevision: number;
  timelineHash: string;
  cueStartIndex: number;
  cueEndIndex: number;
  startMs: number;
  endMs: number;
  motionKind: VisualMotionKind;
  motionAmountPpm: number;
  fadeMs: number;
  revision: number;
  assets: VisualSegmentAssetRecord[];
  productionReady: boolean;
}

interface SegmentRow {
  id: string;
  episode_id: string;
  segment_index: number;
  script_version_id: string;
  approval_revision: number;
  timeline_hash: string;
  cue_start_index: number;
  cue_end_index: number;
  start_ms: number;
  end_ms: number;
  motion_kind: VisualMotionKind;
  motion_amount_ppm: number;
  fade_ms: number;
  revision: number;
  created_at: number;
}

interface CueRow {
  cue_index: number;
  start_ms: number;
  end_ms: number;
  script_version_id: string;
}

export class VisualSegmentStoreError extends Error {
  constructor(readonly statusCode: number, message: string) { super(message); }
}

function id(value: unknown, label: string) {
  if (typeof value !== "string" || !value.trim()) throw new VisualSegmentStoreError(400, `${label}不能为空`);
  return value.trim();
}

function integer(value: unknown, label: string, minimum: number, maximum = Number.MAX_SAFE_INTEGER) {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw new VisualSegmentStoreError(400, `${label}无效`);
  }
  return value as number;
}

function timelineCues(database: DatabaseSync, episodeId: string, timelineHash: string) {
  const cues = database.prepare(
    `SELECT cue_index, start_ms, end_ms, script_version_id
     FROM subtitle_cues WHERE episode_id = ? AND timeline_hash = ? ORDER BY cue_index`,
  ).all(episodeId, timelineHash) as unknown as CueRow[];
  if (cues.length === 0) throw new VisualSegmentStoreError(409, "音频时间轴不存在");
  for (let index = 0; index < cues.length; index += 1) {
    const cue = cues[index]!;
    if (cue.cue_index !== index || cue.start_ms < 0 || cue.end_ms <= cue.start_ms ||
        (index > 0 && cue.start_ms < cues[index - 1]!.end_ms)) {
      throw new VisualSegmentStoreError(409, "音频时间轴不连续");
    }
  }
  return cues;
}

function currentApproval(database: DatabaseSync, episodeId: string) {
  const row = database.prepare(
    `SELECT revision, action, script_version_id
     FROM script_approval_events WHERE episode_id = ? ORDER BY revision DESC LIMIT 1`,
  ).get(episodeId) as { revision: number; action: "approve" | "withdraw"; script_version_id: string } | undefined;
  if (!row || row.action !== "approve") throw new VisualSegmentStoreError(409, "当前分集没有已批准的成片旁白稿");
  return row;
}

function segmentAssets(database: DatabaseSync, segmentId: string) {
  return database.prepare(
    `SELECT asset_id AS assetId, selected_candidate_id AS selectedCandidateId,
            candidate_review_revision AS candidateReviewRevision
     FROM visual_segment_assets WHERE visual_segment_id = ? ORDER BY asset_index`,
  ).all(segmentId) as unknown as VisualSegmentAssetRecord[];
}

function selectedCandidateIsCurrent(database: DatabaseSync, asset: VisualSegmentAssetRecord) {
  if (!asset.selectedCandidateId || asset.candidateReviewRevision === null) return false;
  const review = database.prepare(
    `SELECT revision, action FROM asset_candidate_review_events
     WHERE candidate_id = ? AND action IN ('approve', 'reject') ORDER BY revision DESC LIMIT 1`,
  ).get(asset.selectedCandidateId) as { revision: number; action: "approve" | "reject" } | undefined;
  return review?.action === "approve" && review.revision === asset.candidateReviewRevision;
}

function assetRelationshipIsCurrent(
  database: DatabaseSync,
  segmentId: string,
  asset: VisualSegmentAssetRecord,
) {
  const row = database.prepare(
    `SELECT 1
     FROM visual_segments segment
     JOIN episodes episode ON episode.id = segment.episode_id
     JOIN assets linked_asset ON linked_asset.id = ?
     WHERE segment.id = ?
       AND linked_asset.series_project_id = episode.series_project_id
       AND (? IS NULL OR EXISTS (
         SELECT 1 FROM asset_candidates candidate
         WHERE candidate.id = ? AND candidate.asset_id = linked_asset.id
       ))`,
  ).get(asset.assetId, segmentId, asset.selectedCandidateId, asset.selectedCandidateId);
  return row !== undefined;
}

function result(database: DatabaseSync, row: SegmentRow, approval?: ReturnType<typeof currentApproval>) {
  const assets = segmentAssets(database, row.id);
  let current = approval;
  if (!current) {
    try { current = currentApproval(database, row.episode_id); } catch { current = undefined; }
  }
  const timeline = database.prepare(
    `SELECT COUNT(*) AS count, MIN(start_ms) AS start_ms, MAX(end_ms) AS end_ms,
            COUNT(DISTINCT script_version_id) AS script_count, MIN(script_version_id) AS script_version_id
     FROM subtitle_cues WHERE episode_id = ? AND timeline_hash = ?
       AND cue_index BETWEEN ? AND ?`,
  ).get(row.episode_id, row.timeline_hash, row.cue_start_index, row.cue_end_index) as {
    count: number; start_ms: number | null; end_ms: number | null; script_count: number; script_version_id: string | null;
  };
  const productionReady = current?.revision === row.approval_revision &&
    current.script_version_id === row.script_version_id &&
    timeline.count === row.cue_end_index - row.cue_start_index + 1 &&
    timeline.start_ms === row.start_ms && timeline.end_ms === row.end_ms &&
    timeline.script_count === 1 && timeline.script_version_id === row.script_version_id &&
    assets.filter((asset) => asset.selectedCandidateId !== null).length === 1 &&
    assets.every((asset) => assetRelationshipIsCurrent(database, row.id, asset)) &&
    assets.every((asset) => asset.selectedCandidateId === null || selectedCandidateIsCurrent(database, asset));
  return {
    id: row.id,
    episodeId: row.episode_id,
    segmentIndex: row.segment_index,
    scriptVersionId: row.script_version_id,
    approvalRevision: row.approval_revision,
    timelineHash: row.timeline_hash,
    cueStartIndex: row.cue_start_index,
    cueEndIndex: row.cue_end_index,
    startMs: row.start_ms,
    endMs: row.end_ms,
    motionKind: row.motion_kind,
    motionAmountPpm: row.motion_amount_ppm,
    fadeMs: row.fade_ms,
    revision: row.revision,
    assets,
    productionReady,
  } satisfies VisualSegmentRecord;
}

function samePlan(row: SegmentRow, input: PutVisualSegmentInput, assets: VisualSegmentAssetRecord[]) {
  return row.cue_start_index === input.cueStartIndex && row.cue_end_index === input.cueEndIndex &&
    row.motion_kind === input.motionKind && row.motion_amount_ppm === input.motionAmountPpm &&
    row.fade_ms === input.fadeMs && assets.length === input.assets.length &&
    assets.every((asset, index) => asset.assetId === input.assets[index]!.assetId &&
      asset.selectedCandidateId === (input.assets[index]!.selectedCandidateId ?? null));
}

export function putVisualSegment(
  database: DatabaseSync,
  episodeIdValue: string,
  segmentIndexValue: number,
  input: PutVisualSegmentInput,
  now = Date.now(),
): VisualSegmentRecord {
  const episodeId = id(episodeIdValue, "分集 ID");
  const segmentIndex = integer(segmentIndexValue, "视觉段序号", 0);
  const timelineHash = typeof input.timelineHash === "string" ? input.timelineHash.toLowerCase() : "";
  if (!HASH.test(timelineHash)) throw new VisualSegmentStoreError(400, "时间轴哈希无效");
  const cueStartIndex = integer(input.cueStartIndex, "起始字幕序号", 0);
  const cueEndIndex = integer(input.cueEndIndex, "结束字幕序号", cueStartIndex);
  if (!MOTIONS.includes(input.motionKind)) throw new VisualSegmentStoreError(400, "运镜类型无效");
  const motionAmountPpm = integer(input.motionAmountPpm, "运镜幅度", 0, 1_000_000);
  if (input.motionKind === "none" && motionAmountPpm !== 0) throw new VisualSegmentStoreError(400, "静态画面不能设置运镜幅度");
  const fadeMs = integer(input.fadeMs, "淡入淡出时长", 0, 10_000);
  const expectedRevision = integer(input.expectedRevision, "视觉段版本号", 0);
  if (!Array.isArray(input.assets) || input.assets.length === 0) {
    throw new VisualSegmentStoreError(400, "视觉段必须显式关联资产");
  }
  const assets = input.assets.map((asset) => ({
    assetId: id(asset?.assetId, "资产 ID"),
    selectedCandidateId: asset?.selectedCandidateId === undefined
      ? undefined
      : id(asset.selectedCandidateId, "候选图 ID"),
  }));
  if (new Set(assets.map((asset) => asset.assetId)).size !== assets.length) {
    throw new VisualSegmentStoreError(400, "视觉段不能重复关联同一资产");
  }
  if (assets.filter((asset) => asset.selectedCandidateId !== undefined).length !== 1) {
    throw new VisualSegmentStoreError(400, "视觉段必须且只能选择一张候选图");
  }

  database.exec("BEGIN IMMEDIATE");
  try {
    const episode = database.prepare("SELECT series_project_id FROM episodes WHERE id = ?").get(episodeId) as
      { series_project_id: string } | undefined;
    if (!episode) throw new VisualSegmentStoreError(404, "分集不存在");
    const approval = currentApproval(database, episodeId);
    const cues = timelineCues(database, episodeId, timelineHash);
    if (cues[0]!.script_version_id !== approval.script_version_id ||
        cues.some((cue) => cue.script_version_id !== approval.script_version_id)) {
      throw new VisualSegmentStoreError(409, "时间轴与当前批准稿不一致");
    }
    const firstCue = cues[cueStartIndex];
    const lastCue = cues[cueEndIndex];
    if (!firstCue || !lastCue) throw new VisualSegmentStoreError(400, "字幕闭区间超出时间轴");
    const startMs = firstCue.start_ms;
    const endMs = lastCue.end_ms;
    if (fadeMs * 2 > endMs - startMs) throw new VisualSegmentStoreError(400, "淡入淡出时长超过视觉段时长");

    const segmentId = `visual_${createHash("sha256")
      .update(`visual-segment-v1\0${episodeId}\0${timelineHash}\0${segmentIndex}`)
      .digest("hex")}`;
    const existing = database.prepare("SELECT * FROM visual_segments WHERE id = ?").get(segmentId) as SegmentRow | undefined;
    const existingAssets = existing ? segmentAssets(database, segmentId) : [];
    if (existing && existing.script_version_id === approval.script_version_id &&
        existing.approval_revision === approval.revision &&
        existingAssets.every((asset) => asset.selectedCandidateId === null || selectedCandidateIsCurrent(database, asset)) &&
        samePlan(existing, input, existingAssets)) {
      database.exec("COMMIT");
      return result(database, existing, approval);
    }
    const currentRevision = existing?.revision ?? 0;
    if (currentRevision !== expectedRevision) {
      throw new VisualSegmentStoreError(409, `视觉段已变化，请按 revision=${currentRevision} 重试`);
    }
    const overlap = database.prepare(
      `SELECT segment_index FROM visual_segments
       WHERE episode_id = ? AND timeline_hash = ? AND id <> ?
         AND cue_start_index <= ? AND cue_end_index >= ? LIMIT 1`,
    ).get(episodeId, timelineHash, segmentId, cueEndIndex, cueStartIndex);
    if (overlap) throw new VisualSegmentStoreError(409, "视觉段字幕区间重叠");

    const storedAssets = assets.map((asset) => {
      const assetRow = database.prepare("SELECT series_project_id FROM assets WHERE id = ?").get(asset.assetId) as
        { series_project_id: string } | undefined;
      if (!assetRow) throw new VisualSegmentStoreError(404, "关联资产不存在");
      if (assetRow.series_project_id !== episode.series_project_id) {
        throw new VisualSegmentStoreError(409, "关联资产与分集不属于同一系列");
      }
      if (!asset.selectedCandidateId) return { ...asset, selectedCandidateId: null, candidateReviewRevision: null };
      const candidate = database.prepare(
        `SELECT c.asset_id, review.revision, review.action
         FROM asset_candidates c
         LEFT JOIN asset_candidate_review_events review ON review.candidate_id = c.id
           AND review.revision = (
             SELECT MAX(revision) FROM asset_candidate_review_events
             WHERE candidate_id = c.id AND action IN ('approve', 'reject')
           )
         WHERE c.id = ?`,
      ).get(asset.selectedCandidateId) as { asset_id: string; revision: number | null; action: string | null } | undefined;
      if (!candidate || candidate.asset_id !== asset.assetId) {
        throw new VisualSegmentStoreError(409, "候选图不属于关联资产");
      }
      if (candidate.action !== "approve" || candidate.revision === null) {
        throw new VisualSegmentStoreError(409, "只能选择当前已批准的候选图");
      }
      return { ...asset, selectedCandidateId: asset.selectedCandidateId, candidateReviewRevision: candidate.revision };
    });

    const revision = currentRevision + 1;
    database.prepare(
      `INSERT INTO visual_segments (
         id, episode_id, segment_index, script_version_id, approval_revision, timeline_hash,
         cue_start_index, cue_end_index, start_ms, end_ms, motion_kind, motion_amount_ppm,
         fade_ms, revision, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         script_version_id = excluded.script_version_id,
         approval_revision = excluded.approval_revision,
         cue_start_index = excluded.cue_start_index,
         cue_end_index = excluded.cue_end_index,
         start_ms = excluded.start_ms,
         end_ms = excluded.end_ms,
         motion_kind = excluded.motion_kind,
         motion_amount_ppm = excluded.motion_amount_ppm,
         fade_ms = excluded.fade_ms,
         revision = excluded.revision,
         updated_at = excluded.updated_at`,
    ).run(
      segmentId, episodeId, segmentIndex, approval.script_version_id, approval.revision, timelineHash,
      cueStartIndex, cueEndIndex, startMs, endMs, input.motionKind, motionAmountPpm,
      fadeMs, revision, existing?.created_at ?? now, now,
    );
    database.prepare("DELETE FROM visual_segment_assets WHERE visual_segment_id = ?").run(segmentId);
    const insert = database.prepare(
      `INSERT INTO visual_segment_assets (
         visual_segment_id, asset_index, asset_id, selected_candidate_id, candidate_review_revision
       ) VALUES (?, ?, ?, ?, ?)`,
    );
    storedAssets.forEach((asset, index) => insert.run(
      segmentId, index, asset.assetId, asset.selectedCandidateId, asset.candidateReviewRevision,
    ));
    database.exec("COMMIT");
    const row = database.prepare("SELECT * FROM visual_segments WHERE id = ?").get(segmentId) as unknown as SegmentRow;
    return result(database, row, approval);
  } catch (error) {
    try { database.exec("ROLLBACK"); } catch { /* 保留原始错误。 */ }
    throw error;
  }
}

export function listVisualSegments(
  database: DatabaseSync,
  episodeIdValue: string,
  timelineHashValue: string,
): VisualSegmentRecord[] {
  const episodeId = id(episodeIdValue, "分集 ID");
  const timelineHash = typeof timelineHashValue === "string" ? timelineHashValue.toLowerCase() : "";
  if (!HASH.test(timelineHash)) throw new VisualSegmentStoreError(400, "时间轴哈希无效");
  return (database.prepare(
    `SELECT * FROM visual_segments WHERE episode_id = ? AND timeline_hash = ? ORDER BY segment_index`,
  ).all(episodeId, timelineHash) as unknown as SegmentRow[]).map((row) => result(database, row));
}

export function assertVisualPlanReady(
  database: DatabaseSync,
  episodeIdValue: string,
  timelineHashValue: string,
): VisualSegmentRecord[] {
  const episodeId = id(episodeIdValue, "分集 ID");
  const timelineHash = typeof timelineHashValue === "string" ? timelineHashValue.toLowerCase() : "";
  if (!HASH.test(timelineHash)) throw new VisualSegmentStoreError(400, "时间轴哈希无效");
  const approval = currentApproval(database, episodeId);
  const cues = timelineCues(database, episodeId, timelineHash);
  if (cues.some((cue) => cue.script_version_id !== approval.script_version_id)) {
    throw new VisualSegmentStoreError(409, "时间轴与当前批准稿不一致");
  }
  const segments = listVisualSegments(database, episodeId, timelineHash);
  if (segments.length === 0 || segments[0]!.segmentIndex !== 0 || segments[0]!.cueStartIndex !== 0) {
    throw new VisualSegmentStoreError(409, "视觉计划没有从时间轴起点开始");
  }
  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index]!;
    if (segment.segmentIndex !== index || (index > 0 && segment.cueStartIndex !== segments[index - 1]!.cueEndIndex + 1)) {
      throw new VisualSegmentStoreError(409, "视觉计划存在空洞或重叠");
    }
    if (!segment.productionReady) throw new VisualSegmentStoreError(409, "视觉计划包含已失效的稿件、时间轴或候选图");
  }
  if (segments[segments.length - 1]!.cueEndIndex !== cues.length - 1) {
    throw new VisualSegmentStoreError(409, "视觉计划没有覆盖时间轴末尾");
  }
  const timeline = database.prepare(
    "SELECT SUM(duration_ms) AS duration_ms FROM audio_segments WHERE episode_id = ? AND timeline_hash = ?",
  ).get(episodeId, timelineHash) as { duration_ms: number };
  const openingMs = Math.min(timeline.duration_ms, 15_000);
  const openingCueCount = cues.filter((cue) => cue.start_ms < openingMs).length;
  const openingMin = Math.min(openingCueCount, Math.max(1, Math.ceil(openingMs / 5_000)));
  const openingMax = Math.min(openingCueCount, Math.max(openingMin, Math.ceil(openingMs / 3_750)));
  const openingSegments = segments.filter((segment) => segment.startMs < openingMs && segment.endMs > 0);
  if (openingSegments.length < openingMin || openingSegments.length > openingMax) {
    throw new VisualSegmentStoreError(409, `开头画面变化应为 ${openingMin}～${openingMax} 段`);
  }
  const openingCandidates = openingSegments.map((segment) =>
    segment.assets.find((asset) => asset.selectedCandidateId !== null)!.selectedCandidateId!);
  if (new Set(openingCandidates).size !== openingCandidates.length) {
    throw new VisualSegmentStoreError(409, "开头视觉段必须选择互不相同的当前已批准候选图");
  }
  return segments;
}
