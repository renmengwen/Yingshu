import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

import { EPISODE_DURATION_POLICY } from "./episode-policy.js";
import { EpisodeStoreError, replaceEpisode, type EpisodeInput } from "./episode-store.js";
import {
  canonicalFullBookPlanJson,
  parseFullBookPlan,
  type FullBookPlanOptions,
} from "./full-book-plan-contract.js";

interface EpisodeRow {
  id: string;
  episode_index: number;
  title: string;
  story_arc: string;
  target_duration_seconds: number;
  recap: string | null;
  next_hook: string | null;
}

interface SourceRow {
  chapter_id: string;
  source_event_id: string;
  source_byte_start: number;
  source_byte_end: number;
  source_hash: string;
}

export interface FreezeFullBookPlanInput {
  seriesProjectId: string;
  plan: unknown;
  options: FullBookPlanOptions;
  targetDurationSeconds: number;
}

export class FullBookPlanStoreError extends Error {
  constructor(readonly statusCode: number, message: string) { super(message); }
}

function expectedSources(database: DatabaseSync, sourceEventIds: readonly string[]) {
  const result: SourceRow[] = [];
  const statement = database.prepare(
    `SELECT chapters.id AS chapter_id, chapter_events.id AS source_event_id,
            chapter_event_sources.source_byte_start, chapter_event_sources.source_byte_end,
            chapter_event_sources.source_hash
     FROM chapter_events
     JOIN chapters ON chapters.id = chapter_events.chapter_id
     JOIN chapter_event_sources ON chapter_event_sources.event_id = chapter_events.id
     WHERE chapter_events.id = ? ORDER BY chapter_event_sources.source_index`,
  );
  for (const id of sourceEventIds) result.push(...statement.all(id) as unknown as SourceRow[]);
  return result;
}

function sourcesMatch(database: DatabaseSync, episodeId: string, expected: readonly SourceRow[]) {
  const stored = database.prepare(
    `SELECT chapter_id, source_event_id, source_byte_start, source_byte_end, source_hash
     FROM episode_sources WHERE episode_id = ? ORDER BY source_index`,
  ).all(episodeId) as unknown as SourceRow[];
  return stored.length === expected.length && stored.every((row, index) => {
    const next = expected[index]!;
    return row.chapter_id === next.chapter_id && row.source_event_id === next.source_event_id &&
      row.source_byte_start === next.source_byte_start && row.source_byte_end === next.source_byte_end &&
      row.source_hash === next.source_hash;
  });
}

function hasDownstreamEvidence(database: DatabaseSync, episodeId: string) {
  return Boolean(database.prepare("SELECT 1 FROM script_versions WHERE episode_id = ? LIMIT 1").get(episodeId));
}

function assertSourceSnapshot(database: DatabaseSync, sourceEventId: string, options: FullBookPlanOptions) {
  const expected = options.allowedSourceEvents.get(sourceEventId)!;
  const rows = database.prepare(
    `SELECT chapters.id AS chapter_id, chapters.chapter_index,
            chapter_event_sources.source_byte_start, chapter_event_sources.source_byte_end
     FROM chapter_events
     JOIN chapters ON chapters.id = chapter_events.chapter_id
     JOIN chapter_event_sources ON chapter_event_sources.event_id = chapter_events.id
     WHERE chapter_events.id = ? ORDER BY chapter_event_sources.source_index`,
  ).all(sourceEventId) as unknown as Array<{
    chapter_id: string; chapter_index: number; source_byte_start: number; source_byte_end: number;
  }>;
  if (rows.length !== expected.byteRanges.length || rows.some((row, index) =>
    row.chapter_id !== expected.chapterId || row.chapter_index !== expected.chapterIndex ||
    row.source_byte_start !== expected.byteRanges[index]!.byteStart ||
    row.source_byte_end !== expected.byteRanges[index]!.byteEnd)) {
    throw new FullBookPlanStoreError(409, `来源事件 ${sourceEventId} 已变化，请重新规划`);
  }
}

export function freezeFullBookPlan(database: DatabaseSync, input: FreezeFullBookPlanInput, now = Date.now()) {
  if (!Number.isSafeInteger(input.targetDurationSeconds) ||
      input.targetDurationSeconds < EPISODE_DURATION_POLICY.minimumSeconds ||
      input.targetDurationSeconds > EPISODE_DURATION_POLICY.maximumSeconds) {
    throw new FullBookPlanStoreError(400, "目标时长不符合分集时长策略");
  }
  const plan = parseFullBookPlan(input.plan, input.options);
  const planHash = createHash("sha256").update(canonicalFullBookPlanJson(plan)).digest("hex");
  if (!database.prepare("SELECT id FROM series_projects WHERE id = ?").get(input.seriesProjectId)) {
    throw new FullBookPlanStoreError(404, "系列项目不存在");
  }
  const planned = plan.episodes.map((episode): EpisodeInput => ({
    ...episode,
    targetDurationSeconds: input.targetDurationSeconds,
  }));

  database.exec("BEGIN IMMEDIATE");
  try {
    for (const sourceEventId of new Set(planned.flatMap((episode) => episode.sourceEventIds))) {
      assertSourceSnapshot(database, sourceEventId, input.options);
    }
    const existing = database.prepare(
      `SELECT id, episode_index, title, story_arc, target_duration_seconds, recap, next_hook
       FROM episodes WHERE series_project_id = ? ORDER BY episode_index`,
    ).all(input.seriesProjectId) as unknown as EpisodeRow[];
    const byIndex = new Map(existing.map((row) => [row.episode_index, row]));
    for (const episode of planned) {
      const row = byIndex.get(episode.index);
      if (!row) continue;
      const unchanged = row.title === episode.title && row.story_arc === episode.storyArc &&
        row.target_duration_seconds === episode.targetDurationSeconds && row.recap === episode.recap &&
        row.next_hook === episode.nextHook &&
        sourcesMatch(database, row.id, expectedSources(database, episode.sourceEventIds));
      if (!unchanged && hasDownstreamEvidence(database, row.id)) {
        throw new FullBookPlanStoreError(409, `第 ${episode.index} 集已有稿件或生产证据，不能覆盖`);
      }
    }
    for (const row of existing) {
      if (row.episode_index > planned.length && hasDownstreamEvidence(database, row.id)) {
        throw new FullBookPlanStoreError(409, `第 ${row.episode_index} 集已有稿件或生产证据，不能删除`);
      }
    }
    for (const episode of planned) replaceEpisode(database, input.seriesProjectId, episode, now);
    database.prepare(
      "DELETE FROM episodes WHERE series_project_id = ? AND episode_index > ?",
    ).run(input.seriesProjectId, planned.length);
    const count = database.prepare(
      "SELECT COUNT(*) AS total FROM episodes WHERE series_project_id = ?",
    ).get(input.seriesProjectId) as { total: number };
    if (count.total !== planned.length) throw new FullBookPlanStoreError(500, "全书分集冻结数量不完整");
    database.exec("COMMIT");
  } catch (error) {
    try { database.exec("ROLLBACK"); } catch { /* 保留原始冻结错误。 */ }
    if (error instanceof EpisodeStoreError) {
      throw new FullBookPlanStoreError(error.statusCode, error.message);
    }
    throw error;
  }
  return { plan, planHash, episodes: planned.length };
}
