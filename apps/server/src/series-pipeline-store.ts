import { createHash, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

import { storyBibleStepTotal } from "./book-story-bible-reduction.js";

import { EPISODE_DURATION_POLICY } from "./episode-policy.js";
import {
  chapterEventsAnalysisJobMatchesChapter,
  chapterEventsAnalysisJobMatchesChapters,
  chapterEventsAnalysisJobIsLegacyBatch,
  chapterEventsAnalysisJobIsSingleChapter,
  chapterEventsAnalysisJobMatchesSingleChapter,
  convergeSingleChapterAnalysisJob,
  type ChapterAnalysisPromptSnapshot,
} from "./chapter-events-job.js";
import { getJob, requestJobCancellation, type JobRecord } from "./job-store.js";
import {
  bookPromptInstructions,
  getBookPromptProfileRevision,
  getOrCreateBookPromptProfile,
} from "./book-prompt-profile-store.js";
import { PRODUCT_PROMPT_SET_VERSION, PRODUCT_PROMPT_VERSIONS } from "./product-prompts.js";
import {
  allocateEpisodeChapterRanges,
  validateConfirmedEpisodeChapterRanges,
  type EpisodeChapterRange,
} from "./episode-range-allocation.js";

export type SeriesPipelineStatus =
  | "configured" | "analyzing_chapters" | "building_story_bible" | "planning_episodes"
  | "validating_plan" | "freezing_plan" | "generating_scripts" | "checking_coverage"
  | "awaiting_review" | "paused" | "failed" | "cancelled" | "completed";

interface RunRow {
  id: string; series_project_id: string; status: SeriesPipelineStatus; resume_status: SeriesPipelineStatus | null;
  episode_count: number; target_duration_seconds: number; source_start_chapter_id: string;
  source_end_chapter_id: string; chapter_batch_size: number; chapter_concurrency: number;
  planning_contract_version: number; episode_ranges_json: string | null; script_contract_version: number;
  product_prompt_version: string | null; book_prompt_profile_revision: number | null;
  book_prompt_profile_hash: string | null;
  config_hash: string; chapter_events_hash: string | null;
  story_bible_id: string | null; plan_hash: string | null; failure_code: string | null;
  failure_message: string | null; created_at: number; updated_at: number;
}

export interface SeriesPipelineRun {
  id: string; seriesProjectId: string; status: SeriesPipelineStatus; resumeStatus: SeriesPipelineStatus | null;
  episodeCount: number; targetDurationSeconds: number; sourceStartChapterId: string;
  sourceEndChapterId: string; chapterBatchSize: number; chapterConcurrency: number;
  planningContractVersion: 1 | 2; episodeRanges: EpisodeChapterRange[] | null; scriptContractVersion: 5 | 6;
  productPromptVersion: string | null; bookPromptProfileRevision: number | null; bookPromptProfileHash: string | null;
  configHash: string; chapterEventsHash: string | null;
  storyBibleId: string | null; planHash: string | null; failureCode: string | null;
  failureMessage: string | null; createdAt: number; updatedAt: number;
}

export interface CreateSeriesPipelineRunInput {
  seriesProjectId: string; episodeCount: number; targetDurationSeconds: number;
  sourceStartChapterId: string; sourceEndChapterId: string;
  chapterBatchSize?: number; chapterConcurrency?: number;
  episodeRanges?: Array<{ episodeIndex: number; startChapterId: string; endChapterId: string }>;
}

export interface PipelineChapter {
  id: string; index: number; characterCount: number; contentHash: string; hasEvents: boolean;
}

export class SeriesPipelineError extends Error {
  constructor(readonly statusCode: number, message: string) { super(message); }
}

function runRecord(row: RunRow): SeriesPipelineRun {
  return {
    id: row.id, seriesProjectId: row.series_project_id, status: row.status, resumeStatus: row.resume_status,
    episodeCount: row.episode_count, targetDurationSeconds: row.target_duration_seconds,
    sourceStartChapterId: row.source_start_chapter_id, sourceEndChapterId: row.source_end_chapter_id,
    chapterBatchSize: row.chapter_batch_size, chapterConcurrency: row.chapter_concurrency,
    planningContractVersion: row.planning_contract_version as 1 | 2,
    episodeRanges: row.episode_ranges_json ? JSON.parse(row.episode_ranges_json) as EpisodeChapterRange[] : null,
    scriptContractVersion: row.script_contract_version as 5 | 6,
    productPromptVersion: row.product_prompt_version,
    bookPromptProfileRevision: row.book_prompt_profile_revision,
    bookPromptProfileHash: row.book_prompt_profile_hash,
    configHash: row.config_hash, chapterEventsHash: row.chapter_events_hash, storyBibleId: row.story_bible_id,
    planHash: row.plan_hash, failureCode: row.failure_code, failureMessage: row.failure_message,
    createdAt: row.created_at, updatedAt: row.updated_at,
  };
}

function currentJob(
  stage: string,
  subjectType: string,
  subjectId: string,
  job: JobRecord,
) {
  return {
    stage,
    subjectType,
    subjectId,
    jobId: job.id,
    jobStatus: job.status,
    jobProgress: job.progress,
    jobAttempts: job.attempts,
    jobMaxAttempts: job.maxAttempts,
  };
}

function runRow(database: DatabaseSync, id: string) {
  return database.prepare("SELECT * FROM series_pipeline_runs WHERE id = ?").get(id) as RunRow | undefined;
}

export function getSeriesPipelineRun(database: DatabaseSync, id: string) {
  const row = runRow(database, id);
  return row ? runRecord(row) : undefined;
}

export function getCurrentSeriesPipelineRun(database: DatabaseSync, seriesProjectId: string) {
  const row = database.prepare(
    `SELECT * FROM series_pipeline_runs
     WHERE series_project_id = ? AND status NOT IN ('cancelled', 'completed')
     ORDER BY created_at DESC, id DESC LIMIT 1`,
  ).get(seriesProjectId) as RunRow | undefined;
  return row ? runRecord(row) : undefined;
}

function safeId(value: unknown, label: string) {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{1,200}$/.test(value)) {
    throw new SeriesPipelineError(400, `${label}无效`);
  }
  return value;
}

function safeInteger(value: unknown, minimum: number, maximum: number, label: string) {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new SeriesPipelineError(400, `${label}必须是 ${minimum}～${maximum} 之间的整数`);
  }
  return value;
}

function rangeRows(database: DatabaseSync, seriesProjectId: string, startId: string, endId: string) {
  const project = database.prepare("SELECT book_id FROM series_projects WHERE id = ?")
    .get(seriesProjectId) as { book_id: string } | undefined;
  if (!project) throw new SeriesPipelineError(404, "系列项目不存在");
  const bounds = database.prepare(
    `SELECT id, chapter_index FROM chapters WHERE book_id = ? AND id IN (?, ?) ORDER BY chapter_index`,
  ).all(project.book_id, startId, endId) as Array<{ id: string; chapter_index: number }>;
  if (bounds.length !== (startId === endId ? 1 : 2) || bounds[0]?.id !== startId || bounds.at(-1)?.id !== endId) {
    throw new SeriesPipelineError(400, "起止章节必须属于系列原著且顺序正确");
  }
  const rows = database.prepare(
    `SELECT id, chapter_index, char_count, content_hash,
            EXISTS(SELECT 1 FROM chapter_events event WHERE event.chapter_id = chapters.id) AS has_events
     FROM chapters WHERE book_id = ? AND chapter_index BETWEEN ? AND ? ORDER BY chapter_index`,
  ).all(project.book_id, bounds[0]!.chapter_index, bounds.at(-1)!.chapter_index) as Array<{
    id: string; chapter_index: number; char_count: number; content_hash: string; has_events: number;
  }>;
  if (!rows.length || rows.some((row, index) => index > 0 && row.chapter_index !== rows[index - 1]!.chapter_index + 1)) {
    throw new SeriesPipelineError(409, "改写范围内章节索引不连续");
  }
  return rows;
}

export function createSeriesPipelineRun(
  database: DatabaseSync,
  input: CreateSeriesPipelineRunInput,
  now = Date.now(),
) {
  const seriesProjectId = safeId(input.seriesProjectId, "系列 ID");
  const sourceStartChapterId = safeId(input.sourceStartChapterId, "起始章节 ID");
  const sourceEndChapterId = safeId(input.sourceEndChapterId, "结束章节 ID");
  const episodeCount = safeInteger(input.episodeCount, 1, 1000, "总集数");
  const targetDurationSeconds = safeInteger(
    input.targetDurationSeconds,
    EPISODE_DURATION_POLICY.minimumSeconds,
    EPISODE_DURATION_POLICY.maximumSeconds,
    "单集时长",
  );
  const chapterBatchSize = safeInteger(input.chapterBatchSize ?? 1, 1, 1, "每批章节数");
  const chapterConcurrency = safeInteger(input.chapterConcurrency ?? 8, 1, 8, "章节分析并发数");
  if ((targetDurationSeconds - EPISODE_DURATION_POLICY.minimumSeconds) % EPISODE_DURATION_POLICY.stepSeconds !== 0) {
    throw new SeriesPipelineError(400, `单集时长必须按 ${EPISODE_DURATION_POLICY.stepSeconds} 秒递增`);
  }
  const chapters = rangeRows(database, seriesProjectId, sourceStartChapterId, sourceEndChapterId).map((row) => ({
    chapterId: row.id, chapterIndex: row.chapter_index, characterCount: row.char_count,
  }));
  let episodeRanges: EpisodeChapterRange[] | null = null;
  if (input.episodeRanges !== undefined) {
    if (!Array.isArray(input.episodeRanges) || input.episodeRanges.length !== episodeCount) {
      throw new SeriesPipelineError(400, "开始付费分析前必须确认全部分集章节范围");
    }
    try {
      episodeRanges = validateConfirmedEpisodeChapterRanges(chapters, input.episodeRanges);
    } catch (error) {
      throw new SeriesPipelineError(400, error instanceof Error ? error.message : "确认的分集范围无效");
    }
  }
  const book = database.prepare("SELECT book_id FROM series_projects WHERE id = ?")
    .get(seriesProjectId) as { book_id: string };
  const profile = episodeRanges ? getOrCreateBookPromptProfile(database, book.book_id, now) : null;
  const configHash = createHash("sha256").update(JSON.stringify(episodeRanges ? {
    contract: "series-pipeline-v3",
    seriesProjectId, episodeCount, targetDurationSeconds,
    sourceStartChapterId, sourceEndChapterId, chapterBatchSize, chapterConcurrency, episodeRanges,
    productPromptVersion: PRODUCT_PROMPT_SET_VERSION,
    bookPromptProfileRevision: profile!.revision,
    bookPromptProfileHash: profile!.profileHash,
  } : {
    contract: "series-pipeline-v2",
    seriesProjectId, episodeCount, targetDurationSeconds,
    sourceStartChapterId, sourceEndChapterId, chapterBatchSize, chapterConcurrency,
  })).digest("hex");
  const id = `pipeline_${randomUUID()}`;
  try {
    database.prepare(
      `INSERT INTO series_pipeline_runs (
         id, series_project_id, status, episode_count, target_duration_seconds,
         source_start_chapter_id, source_end_chapter_id, chapter_batch_size, chapter_concurrency,
         planning_contract_version, episode_ranges_json, script_contract_version,
         product_prompt_version, book_prompt_profile_revision, book_prompt_profile_hash,
         config_hash, created_at, updated_at
       ) VALUES (?, ?, 'configured', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(id, seriesProjectId, episodeCount, targetDurationSeconds, sourceStartChapterId, sourceEndChapterId,
      chapterBatchSize, chapterConcurrency, episodeRanges ? 2 : 1,
      episodeRanges ? JSON.stringify(episodeRanges) : null, episodeRanges ? 6 : 5,
      episodeRanges ? PRODUCT_PROMPT_SET_VERSION : null, profile?.revision ?? null, profile?.profileHash ?? null,
      configHash, now, now);
  } catch (error) {
    if (String(error).includes("series_pipeline_runs.series_project_id")) {
      throw new SeriesPipelineError(409, "该系列已有未结束的全本流水线");
    }
    throw error;
  }
  return getSeriesPipelineRun(database, id)!;
}

export function listPipelineChapters(database: DatabaseSync, run: SeriesPipelineRun): PipelineChapter[] {
  return rangeRows(database, run.seriesProjectId, run.sourceStartChapterId, run.sourceEndChapterId).map((row) => ({
    id: row.id, index: row.chapter_index, characterCount: row.char_count,
    contentHash: row.content_hash, hasEvents: row.has_events === 1,
  }));
}

export function previewSeriesPipelineEpisodeRanges(database: DatabaseSync, input: {
  seriesProjectId: string; sourceStartChapterId: string; sourceEndChapterId: string; episodeCount: number;
}) {
  const seriesProjectId = safeId(input.seriesProjectId, "系列 ID");
  const sourceStartChapterId = safeId(input.sourceStartChapterId, "起始章节 ID");
  const sourceEndChapterId = safeId(input.sourceEndChapterId, "结束章节 ID");
  const episodeCount = safeInteger(input.episodeCount, 1, 1000, "总集数");
  const chapters = rangeRows(database, seriesProjectId, sourceStartChapterId, sourceEndChapterId).map((row) => ({
    chapterId: row.id, chapterIndex: row.chapter_index, characterCount: row.char_count,
  }));
  try {
    return allocateEpisodeChapterRanges(chapters, episodeCount);
  } catch (error) {
    throw new SeriesPipelineError(400, error instanceof Error ? error.message : "无法生成分集范围预览");
  }
}

export function listRunnableSeriesPipelineRuns(database: DatabaseSync) {
  return (database.prepare(
    "SELECT * FROM series_pipeline_runs WHERE status IN ('configured', 'analyzing_chapters', 'building_story_bible', 'planning_episodes', 'validating_plan', 'freezing_plan', 'generating_scripts', 'checking_coverage') ORDER BY created_at, id",
  ).all() as unknown as RunRow[]).map(runRecord);
}

export function getMappedEpisodePlanJob(database: DatabaseSync, runId: string) {
  return database.prepare(
    `SELECT mapping.subject_id, mapping.job_id FROM series_pipeline_jobs mapping
     WHERE mapping.run_id = ? AND mapping.stage = 'episode_plan' AND mapping.subject_type = 'plan' LIMIT 1`,
  ).get(runId) as { subject_id: string; job_id: string } | undefined;
}

export function getMappedLocalEpisodePlanJobs(database: DatabaseSync, runId: string) {
  return database.prepare(
    `SELECT mapping.subject_id, mapping.job_id FROM series_pipeline_jobs mapping
     WHERE mapping.run_id = ? AND mapping.stage = 'episode_plan' AND mapping.subject_type = 'episode'
     ORDER BY mapping.subject_id`,
  ).all(runId) as Array<{ subject_id: string; job_id: string }>;
}

export function mapSeriesPipelineLocalEpisodePlanJob(
  database: DatabaseSync, runId: string, subjectId: string, jobId: string, now = Date.now(),
) {
  return immediateTransaction(database, () => {
    const active = database.prepare(
      "SELECT 1 FROM series_pipeline_runs WHERE id = ? AND status IN ('planning_episodes', 'validating_plan', 'freezing_plan')",
    ).get(runId);
    if (!active) return false;
    const episodePrefix = subjectId.split(":", 1)[0];
    database.prepare(
      `DELETE FROM series_pipeline_jobs
       WHERE run_id = ? AND stage = 'episode_plan' AND subject_type = 'episode'
         AND subject_id LIKE ? AND subject_id <> ?`,
    ).run(runId, `${episodePrefix}:%`, subjectId);
    database.prepare(
      `INSERT INTO series_pipeline_jobs (run_id, stage, subject_type, subject_id, job_id, created_at)
       VALUES (?, 'episode_plan', 'episode', ?, ?, ?)
       ON CONFLICT(run_id, stage, subject_type, subject_id) DO UPDATE SET job_id=excluded.job_id, created_at=excluded.created_at`,
    ).run(runId, subjectId, jobId, now);
    database.prepare(
      `UPDATE jobs SET run_after = ?, updated_at = ?
       WHERE id = ? AND status = 'queued' AND run_after = ?`,
    ).run(now, now, jobId, PAUSED_JOB_RUN_AFTER);
    database.prepare(
      "UPDATE series_pipeline_runs SET failure_code = NULL, failure_message = NULL, updated_at = ? WHERE id = ?",
    ).run(now, runId);
    return true;
  });
}

export function mapSeriesPipelineEpisodePlanJob(
  database: DatabaseSync, runId: string, subjectId: string, jobId: string, now = Date.now(),
) {
  return immediateTransaction(database, () => {
    const active = database.prepare(
      "SELECT 1 FROM series_pipeline_runs WHERE id = ? AND status IN ('planning_episodes', 'validating_plan', 'freezing_plan')",
    ).get(runId);
    if (!active) return false;
    database.prepare("DELETE FROM series_pipeline_jobs WHERE run_id = ? AND stage = 'episode_plan'").run(runId);
    database.prepare(
      `INSERT INTO series_pipeline_jobs (run_id, stage, subject_type, subject_id, job_id, created_at)
       VALUES (?, 'episode_plan', 'plan', ?, ?, ?)
       ON CONFLICT(run_id, stage, subject_type, subject_id) DO NOTHING`,
    ).run(runId, subjectId, jobId, now);
    database.prepare(
      `UPDATE jobs SET run_after = ?, updated_at = ?
       WHERE id = ? AND status = 'queued' AND run_after = ?
         AND EXISTS (
           SELECT 1 FROM series_pipeline_jobs mapping
           JOIN series_pipeline_runs run ON run.id = mapping.run_id
           WHERE mapping.job_id = jobs.id
             AND run.status NOT IN ('paused', 'cancelled', 'completed')
         )`,
    ).run(now, now, jobId, PAUSED_JOB_RUN_AFTER);
    database.prepare(
      "UPDATE series_pipeline_runs SET failure_code = NULL, failure_message = NULL, updated_at = ? WHERE id = ?",
    ).run(now, runId);
    return true;
  });
}

export function finishEpisodePlan(
  database: DatabaseSync, runId: string, planHash: string, now = Date.now(),
) {
  database.prepare(
    `UPDATE series_pipeline_runs SET status = 'generating_scripts', plan_hash = ?,
       failure_code = NULL, failure_message = NULL, updated_at = ?
     WHERE id = ? AND status = 'freezing_plan'`,
  ).run(planHash, now, runId);
  return getSeriesPipelineRun(database, runId);
}

export function getMappedStoryBibleJob(database: DatabaseSync, runId: string) {
  const row = database.prepare(
    `SELECT mapping.subject_id, mapping.job_id FROM series_pipeline_jobs mapping
     WHERE mapping.run_id = ? AND mapping.stage = 'story_bible' LIMIT 1`,
  ).get(runId) as { subject_id: string; job_id: string } | undefined;
  return row;
}

export function mapSeriesPipelineStoryBibleJob(
  database: DatabaseSync, runId: string, subjectId: string, jobId: string, now = Date.now(),
) {
  return immediateTransaction(database, () => {
    const active = database.prepare(
      "SELECT 1 FROM series_pipeline_runs WHERE id = ? AND status = 'building_story_bible'",
    ).get(runId);
    if (!active) return false;
    database.prepare(
      "DELETE FROM series_pipeline_jobs WHERE run_id = ? AND stage = 'story_bible'",
    ).run(runId);
    database.prepare(
      `INSERT INTO series_pipeline_jobs (run_id, stage, subject_type, subject_id, job_id, created_at)
       VALUES (?, 'story_bible', 'bible_chunk', ?, ?, ?)
       ON CONFLICT(run_id, stage, subject_type, subject_id) DO NOTHING`,
    ).run(runId, subjectId, jobId, now);
    database.prepare(
      `UPDATE jobs SET run_after = ?, updated_at = ?
       WHERE id = ? AND status = 'queued' AND run_after = ?
         AND EXISTS (
           SELECT 1 FROM series_pipeline_jobs mapping
           JOIN series_pipeline_runs run ON run.id = mapping.run_id
           WHERE mapping.job_id = jobs.id
             AND run.status NOT IN ('paused', 'cancelled', 'completed')
         )`,
    ).run(now, now, jobId, PAUSED_JOB_RUN_AFTER);
    return true;
  });
}

export function finishStoryBible(
  database: DatabaseSync, runId: string, storyBibleId: string, now = Date.now(),
) {
  database.prepare(
    `UPDATE series_pipeline_runs SET status = 'planning_episodes', story_bible_id = ?,
       failure_code = NULL, failure_message = NULL, updated_at = ?
     WHERE id = ? AND status = 'building_story_bible'`,
  ).run(storyBibleId, now, runId);
  return getSeriesPipelineRun(database, runId);
}

export function setSeriesPipelineStatus(
  database: DatabaseSync,
  id: string,
  expected: SeriesPipelineStatus,
  status: SeriesPipelineStatus,
  now = Date.now(),
) {
  database.prepare(
    `UPDATE series_pipeline_runs SET status = ?, resume_status = NULL, failure_code = NULL,
       failure_message = NULL, updated_at = ? WHERE id = ? AND status = ?`,
  ).run(status, now, id, expected);
  return getSeriesPipelineRun(database, id);
}

export function mapSeriesPipelineJob(
  database: DatabaseSync,
  runId: string,
  chapterId: string,
  jobId: string,
  now = Date.now(),
  replaceStaleJobIds: readonly string[] = [],
) {
  return mapSeriesPipelineBatchJob(database, runId, [chapterId], jobId, now, replaceStaleJobIds);
}

function frozenChapterPromptIdentity(database: DatabaseSync, run: SeriesPipelineRun, bookId: string) {
  if (run.planningContractVersion !== 2) {
    return { valid: true, prompt: undefined as ChapterAnalysisPromptSnapshot | undefined };
  }
  if (!run.bookPromptProfileRevision || run.productPromptVersion !== PRODUCT_PROMPT_SET_VERSION) {
    return { valid: false, prompt: undefined };
  }
  const profile = getBookPromptProfileRevision(database, bookId, run.bookPromptProfileRevision);
  if (!profile || profile.profileHash !== run.bookPromptProfileHash) {
    return { valid: false, prompt: undefined };
  }
  return {
    valid: true,
    prompt: {
      productVersion: PRODUCT_PROMPT_VERSIONS.chapterAnalysis,
      profileRevision: profile.revision,
      profileHash: profile.profileHash,
      instructions: bookPromptInstructions(profile, "chapterAnalysisInstructions"),
    } satisfies ChapterAnalysisPromptSnapshot,
  };
}

export function mapSeriesPipelineBatchJob(
  database: DatabaseSync,
  runId: string,
  chapterIds: readonly string[],
  jobId: string,
  now = Date.now(),
  replaceStaleJobIds: readonly string[] = [],
) {
  if (!chapterIds.length || new Set(chapterIds).size !== chapterIds.length) return false;
  const replaceable = new Set(replaceStaleJobIds);
  return immediateTransaction(database, () => {
    const active = database.prepare(
      "SELECT 1 FROM series_pipeline_runs WHERE id = ? AND status = 'analyzing_chapters'",
    ).get(runId);
    if (!active) return false;
    for (const chapterId of chapterIds) {
      const previous = database.prepare(
        `SELECT mapping.job_id, job.status FROM series_pipeline_jobs mapping
         JOIN jobs job ON job.id = mapping.job_id
         WHERE mapping.run_id = ? AND mapping.stage = 'chapter_analysis'
           AND mapping.subject_type = 'chapter' AND mapping.subject_id = ?`,
      ).get(runId, chapterId) as { job_id: string; status: JobRecord["status"] } | undefined;
      if (previous && previous.job_id !== jobId &&
          (previous.status === "queued" || previous.status === "running") &&
          !replaceable.has(previous.job_id)) {
        if (!hasOtherActiveOwner(database, previous.job_id, runId)) {
          requestJobCancellation(database, previous.job_id, now);
        }
        return false;
      }
    }
    for (const chapterId of chapterIds) {
      database.prepare(
        `DELETE FROM series_pipeline_jobs
         WHERE run_id = ? AND stage = 'chapter_analysis' AND subject_type = 'chapter' AND subject_id = ?`,
      ).run(runId, chapterId);
      database.prepare(
        `INSERT INTO series_pipeline_jobs (run_id, stage, subject_type, subject_id, job_id, created_at)
         VALUES (?, 'chapter_analysis', 'chapter', ?, ?, ?)
         ON CONFLICT(run_id, stage, subject_type, subject_id) DO NOTHING`,
      ).run(runId, chapterId, jobId, now);
    }
    database.prepare(
      `UPDATE jobs SET run_after = ?, updated_at = ?
       WHERE id = ? AND status = 'queued' AND run_after = ?
         AND EXISTS (
           SELECT 1 FROM series_pipeline_jobs mapping
           JOIN series_pipeline_runs run ON run.id = mapping.run_id
           WHERE mapping.job_id = jobs.id
             AND run.status NOT IN ('paused', 'cancelled', 'completed')
         )`,
    ).run(now, now, jobId, PAUSED_JOB_RUN_AFTER);
    return true;
  });
}

export function getMappedChapterJobs(database: DatabaseSync, runId: string) {
  return database.prepare(
    `SELECT mapping.subject_id, mapping.job_id FROM series_pipeline_jobs mapping
     WHERE mapping.run_id = ? AND mapping.stage = 'chapter_analysis' ORDER BY mapping.created_at, mapping.subject_id`,
  ).all(runId) as unknown as Array<{ subject_id: string; job_id: string }>;
}

export function retainStaleChapterAnalysisJobs(
  database: DatabaseSync,
  runId: string,
  jobIds: readonly string[],
  reusableMappings: readonly { chapterId: string; jobId: string }[] = [],
  now = Date.now(),
) {
  if (!jobIds.length && !reusableMappings.length) return { blockingJobIds: [] as string[] };
  return immediateTransaction(database, () => {
    const blockingJobIds: string[] = [];
    for (const jobId of new Set(jobIds)) {
      if (!hasOtherActiveOwner(database, jobId, runId)) {
        const job = requestJobCancellation(database, jobId, now);
        if (job?.status === "running") blockingJobIds.push(jobId);
      }
    }
    for (const mapping of reusableMappings) {
      database.prepare(
        `DELETE FROM series_pipeline_jobs
         WHERE run_id = ? AND stage = 'chapter_analysis' AND subject_id = ? AND job_id = ?`,
      ).run(runId, mapping.chapterId, mapping.jobId);
    }
    return { blockingJobIds };
  });
}

export function getMappedScriptJobs(database: DatabaseSync, runId: string) {
  return database.prepare(
    `SELECT mapping.subject_id, mapping.job_id FROM series_pipeline_jobs mapping
     JOIN episodes episode ON episode.id = mapping.subject_id
     WHERE mapping.run_id = ? AND mapping.stage = 'script_generation'
     ORDER BY episode.episode_index`,
  ).all(runId) as unknown as Array<{ subject_id: string; job_id: string }>;
}

export function mapSeriesPipelineScriptJob(
  database: DatabaseSync,
  runId: string,
  episodeId: string,
  jobId: string,
  now = Date.now(),
) {
  database.prepare(
    `INSERT INTO series_pipeline_jobs (run_id, stage, subject_type, subject_id, job_id, created_at)
     VALUES (?, 'script_generation', 'episode', ?, ?, ?)
     ON CONFLICT(run_id, stage, subject_type, subject_id) DO UPDATE SET
       job_id = excluded.job_id,
       created_at = excluded.created_at
     WHERE series_pipeline_jobs.job_id <> excluded.job_id`,
  ).run(runId, episodeId, jobId, now);
}

export function failEmptyChapterAnalysisJobs(
  database: DatabaseSync, runId: string, currentJobIds: readonly string[], now = Date.now(),
) {
  if (!currentJobIds.length) return;
  database.prepare(
    `UPDATE jobs SET status = 'failed', progress = 0, error_code = 'chapter_events_empty',
       error_message = '章节分析未生成可持久事件', finished_at = ?, updated_at = ?
       WHERE status = 'succeeded' AND id IN (${currentJobIds.map(() => "?").join(",")}) AND id IN (
       SELECT mapping.job_id FROM series_pipeline_jobs mapping
       WHERE mapping.run_id = ? AND mapping.stage = 'chapter_analysis'
         AND NOT EXISTS (SELECT 1 FROM chapter_events event WHERE event.chapter_id = mapping.subject_id)
     )`,
  ).run(now, now, ...currentJobIds, runId);
}

export function finishChapterAnalysis(database: DatabaseSync, run: SeriesPipelineRun, now = Date.now()) {
  const chapters = listPipelineChapters(database, run);
  const eventRows = database.prepare(
    `SELECT event.id, event.chapter_id, event.event_index, event.event_type, event.payload_json,
            source.source_index, source.source_byte_start, source.source_byte_end, source.source_hash
     FROM chapter_events event
     LEFT JOIN chapter_event_sources source ON source.event_id = event.id
     WHERE event.chapter_id IN (${chapters.map(() => "?").join(",")})
     ORDER BY event.chapter_id, event.event_index, source.source_index`,
  ).all(...chapters.map((chapter) => chapter.id));
  const hash = createHash("sha256").update(JSON.stringify({
    contract: "chapter-events-collection-v1",
    chapters: chapters.map(({ id, index, contentHash }) => ({ id, index, contentHash })), events: eventRows,
  })).digest("hex");
  database.prepare(
    `UPDATE series_pipeline_runs SET status = ?, chapter_events_hash = ?,
       failure_code = NULL, failure_message = NULL, updated_at = ?
     WHERE id = ? AND status = 'analyzing_chapters'`,
  ).run(run.planningContractVersion === 2 ? "planning_episodes" : "building_story_bible", hash, now, run.id);
  return getSeriesPipelineRun(database, run.id)!;
}

export function setSeriesPipelineFailure(database: DatabaseSync, id: string, code: string, message: string, now = Date.now()) {
  const safeCode = code.replace(/[^a-z0-9_-]/gi, "_").slice(0, 128) || "pipeline_failed";
  const safeMessage = message.replace(/[\r\n\t]+/g, " ").slice(0, 2000) || "流水线执行失败";
  database.prepare(
    "UPDATE series_pipeline_runs SET failure_code = ?, failure_message = ?, updated_at = ? WHERE id = ?",
  ).run(safeCode, safeMessage, now, id);
}

const PAUSED_JOB_RUN_AFTER = Number.MAX_SAFE_INTEGER;

function immediateTransaction<T>(database: DatabaseSync, operation: () => T): T {
  database.exec("BEGIN IMMEDIATE");
  try {
    const result = operation();
    database.exec("COMMIT");
    return result;
  } catch (error) {
    try { database.exec("ROLLBACK"); } catch { /* 保留原始事务错误。 */ }
    throw error;
  }
}

function mappedJobs(database: DatabaseSync, runId: string) {
  return database.prepare(
    `SELECT DISTINCT job.id, job.status, job.run_after FROM jobs job
     JOIN series_pipeline_jobs mapping ON mapping.job_id = job.id
     WHERE mapping.run_id = ? ORDER BY job.id`,
  ).all(runId) as unknown as Array<{ id: string; status: JobRecord["status"]; run_after: number }>;
}

function hasOtherActiveOwner(database: DatabaseSync, jobId: string, runId: string) {
  return Boolean(database.prepare(
    `SELECT 1 FROM series_pipeline_jobs mapping
     JOIN series_pipeline_runs run ON run.id = mapping.run_id
     WHERE mapping.job_id = ? AND mapping.run_id <> ?
       AND run.status NOT IN ('paused', 'cancelled', 'completed') LIMIT 1`,
  ).get(jobId, runId));
}

function hasOtherRetainedOwner(database: DatabaseSync, jobId: string, runId: string) {
  return Boolean(database.prepare(
    `SELECT 1 FROM series_pipeline_jobs mapping
     JOIN series_pipeline_runs run ON run.id = mapping.run_id
     WHERE mapping.job_id = ? AND mapping.run_id <> ?
       AND run.status NOT IN ('cancelled', 'completed') LIMIT 1`,
  ).get(jobId, runId));
}

function detachBypassedModelPlanningJobs(database: DatabaseSync, runId: string, now: number) {
  const run = getSeriesPipelineRun(database, runId);
  if (!run || run.planningContractVersion !== 2) return run;
  const jobIds = database.prepare(
    `SELECT DISTINCT job_id FROM series_pipeline_jobs
     WHERE run_id = ? AND stage IN ('story_bible', 'episode_plan')`,
  ).all(runId) as unknown as Array<{ job_id: string }>;
  for (const { job_id: jobId } of jobIds) {
    const job = getJob(database, jobId);
    const shared = hasOtherRetainedOwner(database, jobId, runId);
    database.prepare(
      `DELETE FROM series_pipeline_jobs
       WHERE run_id = ? AND stage IN ('story_bible', 'episode_plan') AND job_id = ?`,
    ).run(runId, jobId);
    if (job && (job.status === "queued" || job.status === "running") && !shared) {
      requestJobCancellation(database, jobId, now);
    }
  }
  database.prepare(
    `UPDATE series_pipeline_runs SET status = 'planning_episodes', story_bible_id = NULL,
       failure_code = NULL, failure_message = NULL, updated_at = ?
     WHERE id = ? AND status = 'building_story_bible'`,
  ).run(now, runId);
  database.prepare(
    `UPDATE series_pipeline_runs SET resume_status = 'planning_episodes', story_bible_id = NULL,
       failure_code = NULL, failure_message = NULL, updated_at = ?
     WHERE id = ? AND status = 'paused' AND resume_status = 'building_story_bible'`,
  ).run(now, runId);
  return getSeriesPipelineRun(database, runId);
}

export function clearBypassedModelPlanningJobs(database: DatabaseSync, runId: string, now = Date.now()) {
  return immediateTransaction(database, () => detachBypassedModelPlanningJobs(database, runId, now));
}

export function convergeMappedSingleChapterAnalysisJobs(database: DatabaseSync) {
  const jobIds = database.prepare(
    `SELECT DISTINCT job_id FROM series_pipeline_jobs
     WHERE stage = 'chapter_analysis' AND subject_type = 'chapter'`,
  ).all() as unknown as Array<{ job_id: string }>;
  for (const { job_id: jobId } of jobIds) {
    const job = getJob(database, jobId);
    if (!chapterEventsAnalysisJobIsSingleChapter(job) ||
        !job || !["queued", "running"].includes(job.status) ||
        (job.status === "queued" && job.runAfter === PAUSED_JOB_RUN_AFTER)) continue;
    const mappings = database.prepare(
      `SELECT run_id, subject_id FROM series_pipeline_jobs
       WHERE job_id = ? AND stage = 'chapter_analysis' AND subject_type = 'chapter'`,
    ).all(jobId) as unknown as Array<{ run_id: string; subject_id: string }>;
    let currentOwner = false;
    for (const runId of new Set(mappings.map((mapping) => mapping.run_id))) {
      try {
        const runMappings = mappings.filter((mapping) => mapping.run_id === runId);
        if (runMappings.length !== 1) continue;
        const run = getSeriesPipelineRun(database, runId);
        if (!run || !["configured", "analyzing_chapters"].includes(run.status)) continue;
        const book = database.prepare(
          "SELECT book_id FROM series_projects WHERE id = ?",
        ).get(run.seriesProjectId) as { book_id: string } | undefined;
        if (!book) continue;
        const chapterPrompt = frozenChapterPromptIdentity(database, run, book.book_id);
        if (!chapterPrompt.valid) continue;
        const chapter = listPipelineChapters(database, run)
          .find((item) => item.id === runMappings[0]!.subject_id);
        if (chapter && chapterEventsAnalysisJobMatchesSingleChapter(
          job, book.book_id, chapter.id, chapter.contentHash, chapterPrompt.prompt,
        )) {
          currentOwner = true;
          break;
        }
      } catch {
        // 坏历史 Run 不能阻断启动，也不能证明该 Job 可以继续执行。
      }
    }
    if (currentOwner) {
      convergeSingleChapterAnalysisJob(database, jobId);
    } else if (job.status === "queued") {
      database.prepare(
        "UPDATE jobs SET run_after = ?, updated_at = ? WHERE id = ? AND status = 'queued' AND run_after <> ?",
      ).run(PAUSED_JOB_RUN_AFTER, Date.now(), jobId, PAUSED_JOB_RUN_AFTER);
    }
  }
}

export function parkLegacyChapterAnalysisJobs(
  database: DatabaseSync,
  runId: string,
  jobIds: readonly string[],
  now = Date.now(),
) {
  if (!jobIds.length) return;
  immediateTransaction(database, () => {
    for (const jobId of new Set(jobIds)) {
      const job = getJob(database, jobId);
      if (!job || !chapterEventsAnalysisJobIsLegacyBatch(job) || job.status !== "queued" ||
          hasOtherActiveOwner(database, jobId, runId)) continue;
      database.prepare(
        "UPDATE jobs SET run_after = ?, updated_at = ? WHERE id = ? AND status = 'queued'",
      ).run(PAUSED_JOB_RUN_AFTER, now, jobId);
    }
  });
}

function detachLegacyChapterAnalysisJobs(database: DatabaseSync, runId: string, now: number) {
  const jobIds = [...new Set(getMappedChapterJobs(database, runId).map((mapping) => mapping.job_id))];
  for (const jobId of jobIds) {
    const job = getJob(database, jobId);
    if (!chapterEventsAnalysisJobIsLegacyBatch(job)) continue;
    const shared = hasOtherActiveOwner(database, jobId, runId);
    if (job!.status === "running" && !shared) {
      requestJobCancellation(database, jobId, now);
      continue;
    }
    database.prepare(
      `DELETE FROM series_pipeline_jobs
       WHERE run_id = ? AND stage = 'chapter_analysis' AND job_id = ?`,
    ).run(runId, jobId);
    if ((job!.status === "queued" || job!.status === "running") && !shared) {
      requestJobCancellation(database, jobId, now);
    }
  }
}

export function pauseSeriesPipelineRun(database: DatabaseSync, id: string, now = Date.now()) {
  return immediateTransaction(database, () => {
    const run = getSeriesPipelineRun(database, id);
    if (!run) throw new SeriesPipelineError(404, "全本流水线不存在");
    if (run.status === "paused") return run;
    if (run.status === "cancelled" || run.status === "completed") {
      throw new SeriesPipelineError(409, "已结束的流水线不能暂停");
    }
    database.prepare(
      "UPDATE series_pipeline_runs SET status = 'paused', resume_status = ?, updated_at = ? WHERE id = ?",
    ).run(run.status, now, id);
    for (const job of mappedJobs(database, id)) {
      if (job.status === "queued" && !hasOtherActiveOwner(database, job.id, id)) {
        database.prepare("UPDATE jobs SET run_after = ?, updated_at = ? WHERE id = ? AND status = 'queued'")
          .run(PAUSED_JOB_RUN_AFTER, now, job.id);
      } else if (job.status === "running" && !hasOtherActiveOwner(database, job.id, id)) {
        database.prepare("UPDATE jobs SET run_after = ?, updated_at = ? WHERE id = ? AND status = 'running'")
          .run(PAUSED_JOB_RUN_AFTER, now, job.id);
        requestJobCancellation(database, job.id, now);
      }
    }
    return getSeriesPipelineRun(database, id)!;
  });
}

export function resumeSeriesPipelineRun(database: DatabaseSync, id: string, now = Date.now()) {
  return immediateTransaction(database, () => {
    let run = getSeriesPipelineRun(database, id);
    if (!run) throw new SeriesPipelineError(404, "全本流水线不存在");
    if (run.status !== "paused") return run;
    run = detachBypassedModelPlanningJobs(database, id, now)!;
    const stopping = database.prepare(
      `SELECT 1 FROM jobs job JOIN series_pipeline_jobs mapping ON mapping.job_id = job.id
       WHERE mapping.run_id = ? AND job.status = 'running' AND job.cancel_requested = 1
         AND job.run_after = ? LIMIT 1`,
    ).get(id, PAUSED_JOB_RUN_AFTER);
    if (stopping) throw new SeriesPipelineError(409, "当前任务正在停止，请稍后再继续");
    detachLegacyChapterAnalysisJobs(database, id, now);
    database.prepare(
      `UPDATE jobs SET status = 'queued', progress = 0, attempts = 0, cancel_requested = 0,
         lease_owner = NULL, lease_expires_at = NULL, result_json = NULL,
         error_code = NULL, error_message = NULL, started_at = NULL, finished_at = NULL, updated_at = ?
       WHERE status = 'cancelled' AND run_after = ? AND id IN (
         SELECT job_id FROM series_pipeline_jobs WHERE run_id = ?
       )`,
    ).run(now, PAUSED_JOB_RUN_AFTER, id);
    database.prepare(
      "UPDATE series_pipeline_runs SET status = resume_status, resume_status = NULL, updated_at = ? WHERE id = ? AND status = 'paused'",
    ).run(now, id);
    database.prepare(
      `UPDATE jobs SET run_after = ?, updated_at = ?
       WHERE status = 'queued' AND run_after = ? AND id IN (
         SELECT job_id FROM series_pipeline_jobs
         WHERE run_id = ? AND stage NOT IN ('story_bible', 'chapter_analysis')
       )`,
    ).run(now, now, PAUSED_JOB_RUN_AFTER, id);
    return getSeriesPipelineRun(database, id)!;
  });
}

export function cancelSeriesPipelineRun(database: DatabaseSync, id: string, now = Date.now()) {
  return immediateTransaction(database, () => {
    const run = getSeriesPipelineRun(database, id);
    if (!run) throw new SeriesPipelineError(404, "全本流水线不存在");
    if (run.status === "cancelled" || run.status === "completed") return run;
    database.prepare(
      `UPDATE series_pipeline_runs SET status = 'cancelled', resume_status = NULL,
         failure_code = NULL, failure_message = NULL, updated_at = ? WHERE id = ?`,
    ).run(now, id);
    for (const job of mappedJobs(database, id)) {
      if ((job.status === "queued" || job.status === "running") && !hasOtherActiveOwner(database, job.id, id)) {
        requestJobCancellation(database, job.id, now);
      }
    }
    return getSeriesPipelineRun(database, id)!;
  });
}

export function retrySeriesPipelineRun(database: DatabaseSync, id: string, now = Date.now()) {
  return immediateTransaction(database, () => {
    let run = getSeriesPipelineRun(database, id);
    if (!run) throw new SeriesPipelineError(404, "全本流水线不存在");
    if (run.status === "completed") return run;
    const cancelledStage = run.status === "cancelled" ? database.prepare(
      `SELECT mapping.stage FROM series_pipeline_jobs mapping
       WHERE mapping.run_id = ?
       ORDER BY mapping.created_at DESC LIMIT 1`,
    ).get(id) as { stage: string } | undefined : undefined;
    run = detachBypassedModelPlanningJobs(database, id, now)!;
    const book = database.prepare(
      "SELECT book_id FROM series_projects WHERE id = ?",
    ).get(run.seriesProjectId) as { book_id: string } | undefined;
    const chapterPrompt = book ? frozenChapterPromptIdentity(database, run, book.book_id) : { valid: false, prompt: undefined };
    detachLegacyChapterAnalysisJobs(database, id, now);
    for (const job of mappedJobs(database, id)) {
      if (job.status !== "failed" && job.status !== "cancelled") continue;
      const chapters = database.prepare(
        `SELECT chapter.id, chapter.content_hash, series.book_id
         FROM series_pipeline_jobs mapping
         JOIN chapters chapter ON chapter.id = mapping.subject_id
         JOIN series_pipeline_runs run ON run.id = mapping.run_id
         JOIN series_projects series ON series.id = run.series_project_id
         WHERE mapping.run_id = ? AND mapping.stage = 'chapter_analysis' AND mapping.job_id = ?`,
      ).all(id, job.id) as unknown as Array<{ id: string; content_hash: string; book_id: string }>;
      const currentJob = getJob(database, job.id);
      if (chapters.length && (!chapterPrompt.valid || chapters.some((chapter) =>
        chapter.book_id !== book?.book_id || !chapterEventsAnalysisJobMatchesChapter(
          currentJob, chapter.book_id, chapter.id, chapter.content_hash, chapterPrompt.prompt,
        )))) continue;
      if (chapters.length) {
        database.prepare("UPDATE jobs SET max_attempts = 1 WHERE id = ? AND status <> 'succeeded'").run(job.id);
      }
      const runAfter = run.status === "paused" && !hasOtherActiveOwner(database, job.id, id)
        ? PAUSED_JOB_RUN_AFTER
        : now;
      database.prepare(
        `UPDATE jobs SET status = 'queued', progress = 0, attempts = 0, run_after = ?, cancel_requested = 0,
           lease_owner = NULL, lease_expires_at = NULL, result_json = NULL, error_code = NULL, error_message = NULL,
           started_at = NULL, finished_at = NULL, updated_at = ?
         WHERE id = ? AND status IN ('failed', 'cancelled')`,
      ).run(runAfter, now, job.id);
    }
    database.prepare(
      `UPDATE series_pipeline_runs SET status = CASE WHEN status = 'cancelled' THEN ? ELSE status END,
         resume_status = CASE WHEN status = 'cancelled' THEN NULL ELSE resume_status END,
         failure_code = NULL, failure_message = NULL, updated_at = ? WHERE id = ?`,
    ).run(cancelledStage?.stage === "script_generation" ? "generating_scripts"
      : run.planningContractVersion === 2 && (cancelledStage?.stage === "story_bible" || cancelledStage?.stage === "episode_plan")
        ? "planning_episodes"
      : cancelledStage?.stage === "episode_plan" ? "planning_episodes"
      : cancelledStage?.stage === "story_bible" ? "building_story_bible" : "analyzing_chapters", now, id);
    return getSeriesPipelineRun(database, id)!;
  });
}

export function seriesPipelineView(database: DatabaseSync, run: SeriesPipelineRun) {
  const chapters = listPipelineChapters(database, run);
  const book = database.prepare(
    "SELECT book_id FROM series_projects WHERE id = ?",
  ).get(run.seriesProjectId) as { book_id: string } | undefined;
  const allMappings = getMappedChapterJobs(database, run.id);
  const chapterPrompt = book
    ? frozenChapterPromptIdentity(database, run, book.book_id)
    : { valid: false, prompt: undefined };
  const currentJobIds = new Set<string>();
  if (book && chapterPrompt.valid) {
    for (const jobId of new Set(allMappings.map((mapping) => mapping.job_id))) {
      const mappedChapters = allMappings.filter((mapping) => mapping.job_id === jobId).map((mapping) => {
        const chapter = chapters.find((item) => item.id === mapping.subject_id);
        return chapter ? { chapterId: chapter.id, contentHash: chapter.contentHash } : undefined;
      });
      if (mappedChapters.every(Boolean) && chapterEventsAnalysisJobMatchesChapters(
        getJob(database, jobId), book.book_id, mappedChapters as Array<{ chapterId: string; contentHash: string }>,
        chapterPrompt.prompt,
      )) currentJobIds.add(jobId);
    }
  }
  const blockingStaleJobIds = new Set(allMappings.map((mapping) => mapping.job_id).filter((jobId) =>
    !currentJobIds.has(jobId) && getJob(database, jobId)?.status === "running" &&
    !hasOtherActiveOwner(database, jobId, run.id),
  ));
  const currentMappings = allMappings.filter((mapping) =>
    currentJobIds.has(mapping.job_id) || blockingStaleJobIds.has(mapping.job_id),
  );
  const staleChapterIds = new Set(allMappings.filter(
    (mapping) => !currentMappings.includes(mapping),
  ).map((mapping) => mapping.subject_id));
  const jobs = currentMappings.map((mapping) => ({
    chapterId: mapping.subject_id, job: getJob(database, mapping.job_id),
  })).filter((item): item is { chapterId: string; job: JobRecord } => Boolean(item.job));
  const mapped = new Set(jobs.map((item) => item.chapterId));
  const completedChapterIds = new Set(chapters.filter((chapter) => {
    if (!chapter.hasEvents || staleChapterIds.has(chapter.id)) return false;
    const job = jobs.find((item) => item.chapterId === chapter.id)?.job;
    return !job || job.status === "succeeded" || Boolean(database.prepare(
      `SELECT 1 FROM job_checkpoints
       WHERE job_id = ? AND stage = 'chapter-events-analyze' AND scope_key = ?`,
    ).get(job.id, chapter.id));
  }).map((chapter) => chapter.id));
  const completed = completedChapterIds.size;
  const relevantJobs = jobs.filter((item) => !completedChapterIds.has(item.chapterId));
  const failures = relevantJobs.filter((item) => item.job.status === "failed" || item.job.status === "cancelled").map((item) => ({
    stage: "chapter_analysis", subjectType: "chapter", subjectId: item.chapterId,
    jobId: item.job.id,
    code: item.job.status === "cancelled" ? "job_cancelled" : item.job.errorCode,
    message: item.job.status === "cancelled" ? "章节分析已中断，请重试该章节" : "章节分析失败，请重试该章节",
    canRetry: true,
  }));
  const scriptJobs = getMappedScriptJobs(database, run.id).map((mapping) => ({
    episodeId: mapping.subject_id, job: getJob(database, mapping.job_id),
  })).filter((item): item is { episodeId: string; job: JobRecord } => Boolean(item.job));
  const scriptFailures = scriptJobs.filter((item) => item.job.status === "failed" || item.job.status === "cancelled").map((item) => ({
    stage: "script_generation", subjectType: "episode", subjectId: item.episodeId,
    jobId: item.job.id,
    code: item.job.status === "cancelled" ? "job_cancelled" : item.job.errorCode,
    message: item.job.status === "cancelled" ? "本集稿件生成已中断，请从本集重试" : "本集稿件生成失败，请从本集重试",
    canRetry: true,
  }));
  const current = relevantJobs.find((item) => item.job.status === "running" ||
    (item.job.status === "queued" && item.job.runAfter !== PAUSED_JOB_RUN_AFTER));
  const currentScript = scriptJobs.find((item) => item.job.status === "running" || item.job.status === "queued");
  const storyMapping = getMappedStoryBibleJob(database, run.id);
  const storyJob = storyMapping ? getJob(database, storyMapping.job_id) : undefined;
  const storyIntervals = storyJob?.payload && typeof storyJob.payload === "object" &&
    Array.isArray((storyJob.payload as { intervals?: unknown }).intervals)
    ? (storyJob.payload as { intervals: unknown[] }).intervals.length : undefined;
  const storyTotal = storyIntervals === undefined ? undefined : storyBibleStepTotal(storyIntervals);
  const storyCheckpointCount = storyJob ? Number(database.prepare(
    `SELECT COUNT(*) AS total FROM job_checkpoints
     WHERE job_id = ? AND stage IN ('book-story-bible-interval', 'book-story-bible-reduction', 'book-story-bible-final')`,
  ).get(storyJob.id)?.total ?? 0) : 0;
  const storySteps = storyJob && storyTotal !== undefined ? {
    completed: Math.min(storyTotal, Math.max(0, storyCheckpointCount)),
    total: storyTotal,
  } : null;
  const storyFailure = storyJob && (storyJob.status === "failed" || storyJob.status === "cancelled") ? [{
    stage: "story_bible", subjectType: "bible_chunk", subjectId: storyMapping!.subject_id,
    jobId: storyJob.id, code: storyJob.status === "cancelled" ? "job_cancelled" : storyJob.errorCode,
    message: storyJob.status === "cancelled" ? "全书世界观构建已中断，请重试"
      : storyJob.errorMessage ?? "全书世界观构建失败，请重试",
    canRetry: true,
  }] : [];
  const planMapping = getMappedEpisodePlanJob(database, run.id);
  const planJob = planMapping ? getJob(database, planMapping.job_id) : undefined;
  const localPlanJobs = getMappedLocalEpisodePlanJobs(database, run.id).map((mapping) => ({
    mapping, job: getJob(database, mapping.job_id),
  })).filter((item): item is { mapping: { subject_id: string; job_id: string }; job: JobRecord } => Boolean(item.job));
  const currentLocalPlan = localPlanJobs.find((item) => item.job.status === "queued" || item.job.status === "running");
  const planFailure = planJob && (planJob.status === "failed" || planJob.status === "cancelled") ? [{
    stage: "episode_plan", subjectType: "plan", subjectId: planMapping!.subject_id,
    jobId: planJob.id, code: planJob.status === "cancelled" ? "job_cancelled" : planJob.errorCode,
    message: `${run.planningContractVersion === 2 ? "逐集局部规划" : "全书规划"}${
      planJob.status === "cancelled" ? "已中断，请重试" : "失败，请重试"}`,
    canRetry: true,
  }] : [];
  const localPlanFailures = localPlanJobs.filter((item) => item.job.status === "failed" ||
    item.job.status === "cancelled").map((item) => ({
    stage: "episode_plan", subjectType: "episode", subjectId: item.mapping.subject_id,
    jobId: item.job.id, code: item.job.status === "cancelled" ? "job_cancelled" : item.job.errorCode,
    message: item.job.status === "cancelled" ? "逐集局部规划已中断，请重试" : "逐集局部规划失败，请重试",
    canRetry: true,
  }));
  const stopping = run.status === "paused" && Boolean(database.prepare(
    `SELECT 1 FROM jobs job JOIN series_pipeline_jobs mapping ON mapping.job_id = job.id
     WHERE mapping.run_id = ? AND job.status = 'running' AND job.cancel_requested = 1
       AND job.run_after = ? LIMIT 1`,
  ).get(run.id, PAUSED_JOB_RUN_AFTER));
  const active = Boolean(current || currentScript || currentLocalPlan ||
    (storyJob && (storyJob.status === "queued" || storyJob.status === "running")) ||
    (planJob && (planJob.status === "queued" || planJob.status === "running")));
  const failureCount = failures.length + storyFailure.length + planFailure.length + localPlanFailures.length +
    scriptFailures.length;
  const status = !active && (failureCount > 0 || run.failureCode) &&
    !["paused", "cancelled", "completed"].includes(run.status)
    ? "failed"
    : run.status;
  return {
    ...run,
    status,
    progress: {
      chapterAnalysis: {
        completed, total: chapters.length,
        reused: chapters.filter((chapter) => completedChapterIds.has(chapter.id) && !mapped.has(chapter.id)).length,
        queued: relevantJobs.filter((item) =>
          item.job.status === "queued" && item.job.runAfter !== PAUSED_JOB_RUN_AFTER).length,
        running: relevantJobs.filter((item) => item.job.status === "running").length,
        failed: failures.length,
      },
      storyBible: run.planningContractVersion === 2
        ? { completed: 0, total: 0, steps: null }
        : { completed: run.storyBibleId ? 1 : 0, total: 1, steps: storySteps },
      episodePlan: {
        completed: run.planHash ? run.episodeCount
          : Math.min(run.episodeCount, localPlanJobs.filter((item) => item.job.status === "succeeded").length),
        total: run.episodeCount,
      },
      scripts: {
        completed: scriptJobs.filter((item) => item.job.status === "succeeded").reduce((total, item) =>
          total + ((item.job.payload as { contractVersion?: unknown } | null)?.contractVersion === 6 ? 1 : 2), 0),
        total: run.episodeCount * (run.scriptContractVersion === 6 ? 1 : 2),
      },
    },
    current: current ? currentJob("chapter_analysis", "chapter", current.chapterId, current.job)
      : storyJob && (storyJob.status === "queued" || storyJob.status === "running")
        ? currentJob("story_bible", "bible_chunk", storyMapping!.subject_id, storyJob)
      : planJob && (planJob.status === "queued" || planJob.status === "running")
        ? currentJob("episode_plan", "plan", planMapping!.subject_id, planJob)
      : currentLocalPlan
        ? currentJob("episode_plan", "episode", currentLocalPlan.mapping.subject_id, currentLocalPlan.job)
      : currentScript ? currentJob("script_generation", "episode", currentScript.episodeId, currentScript.job)
      : null,
    failures: [...failures, ...storyFailure, ...planFailure, ...localPlanFailures, ...scriptFailures],
    actions: {
      canPause: active && !["paused", "cancelled", "completed"].includes(run.status),
      canResume: run.status === "paused" && !stopping,
      canCancel: !["cancelled", "completed"].includes(run.status),
      canRetry: failureCount > 0 || Boolean(run.failureCode),
    },
  };
}

export function assertSeriesPipelineAllowsChapterEventMutation(
  database: DatabaseSync,
  bookId: string,
  chapterId: string,
  options: { allowPausedPipelineJobs?: boolean } = {},
) {
  const conflict = database.prepare(
    `SELECT run.id FROM series_pipeline_runs run
     JOIN series_projects series ON series.id = run.series_project_id
     JOIN chapters target ON target.id = ? AND target.book_id = series.book_id
     JOIN chapters start ON start.id = run.source_start_chapter_id
     JOIN chapters finish ON finish.id = run.source_end_chapter_id
     WHERE series.book_id = ? AND target.chapter_index BETWEEN start.chapter_index AND finish.chapter_index
       AND (
         run.status NOT IN ('paused', 'cancelled', 'completed')
         OR (? = 0 AND run.status IN ('paused', 'cancelled') AND EXISTS (
           SELECT 1 FROM series_pipeline_jobs mapping
           JOIN jobs job ON job.id = mapping.job_id
           WHERE mapping.run_id = run.id AND mapping.stage = 'chapter_analysis'
             AND mapping.subject_id = target.id AND job.status IN ('queued', 'running')
         ))
       ) LIMIT 1`,
  ).get(chapterId, bookId, options.allowPausedPipelineJobs ? 1 : 0);
  if (conflict) throw new SeriesPipelineError(409, "全本流水线运行期间章节事件只读，请先暂停流水线");
}
