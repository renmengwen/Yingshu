import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

import {
  buildChapterEvidenceAtoms,
  MAX_CHAPTER_BATCH_INPUT_BYTES,
  type ChapterTextModelConfig,
} from "./chapter-event-analyzer.js";
import {
  chapterEventsAnalysisJobMatchesChapter,
  chapterEventsAnalysisJobIsLegacyBatch,
  chapterEventsAnalysisJobMatchesSingleChapter,
  convergeSingleChapterAnalysisJob,
  enqueueChapterEventsAnalysisJob,
  type ChapterAnalysisPromptSnapshot,
} from "./chapter-events-job.js";
import {
  enqueueEpisodeScriptGenerationJob,
  EPISODE_SCRIPT_GENERATION_JOB_TYPE,
  EPISODE_SCRIPT_GENERATION_LEGACY_CONTRACT_VERSION,
  EPISODE_SCRIPT_GENERATION_V6_CONTRACT_VERSION,
  type EpisodeScriptGenerationRequest,
  type ScriptHandoff,
} from "./episode-script-generation-job.js";
import { getJob } from "./job-store.js";
import { createJob } from "./job-store.js";
import {
  BOOK_STORY_BIBLE_JOB_CONTRACT_VERSION,
  buildStoryBibleIntervalRequests,
  type StoryBibleBuildLimits,
  type StoryBibleChapterInput,
} from "./book-story-bible-job.js";
import {
  BOOK_STORY_BIBLE_JOB_TYPE,
  storyBibleJobRequestHash,
  type BookStoryBibleJobPayload,
} from "./book-story-bible-job-handler.js";
import {
  FULL_BOOK_PLAN_JOB_CONTRACT_VERSION,
  buildFullBookPlanIntervalRequests,
  fullBookPlanIntervalModelInput,
  type FullBookPlanBuildLimits,
  type FullBookPlanChapterInput,
} from "./full-book-plan-job.js";
import {
  EPISODE_PLAN_JOB_TYPE,
  FULL_BOOK_PLAN_JOB_TYPE,
  fullBookPlanJobRequestHash,
  type FullBookPlanJobPayload,
} from "./full-book-plan-job-handler.js";
import { freezeFullBookPlan } from "./full-book-plan-store.js";
import { canonicalFullBookPlanJson, parseFullBookPlan } from "./full-book-plan-contract.js";
import { validateStoredScriptVersion } from "./script-version-store.js";
import { bookPromptInstructions, getBookPromptProfileRevision } from "./book-prompt-profile-store.js";
import { PRODUCT_PROMPT_SET_VERSION, PRODUCT_PROMPT_VERSIONS } from "./product-prompts.js";
import {
  cancelSeriesPipelineRun,
  clearBypassedModelPlanningJobs,
  convergeMappedSingleChapterAnalysisJobs,
  createSeriesPipelineRun,
  finishChapterAnalysis,
  finishEpisodePlan,
  finishStoryBible,
  failEmptyChapterAnalysisJobs,
  getCurrentSeriesPipelineRun,
  getMappedChapterJobs,
  getMappedEpisodePlanJob,
  getMappedLocalEpisodePlanJobs,
  getMappedStoryBibleJob,
  getMappedScriptJobs,
  getSeriesPipelineRun,
  listPipelineChapters,
  listRunnableSeriesPipelineRuns,
  mapSeriesPipelineJob,
  mapSeriesPipelineBatchJob,
  mapSeriesPipelineEpisodePlanJob,
  mapSeriesPipelineLocalEpisodePlanJob,
  mapSeriesPipelineStoryBibleJob,
  mapSeriesPipelineScriptJob,
  pauseSeriesPipelineRun,
  parkLegacyChapterAnalysisJobs,
  previewSeriesPipelineEpisodeRanges,
  retainStaleChapterAnalysisJobs,
  resumeSeriesPipelineRun,
  retrySeriesPipelineRun,
  seriesPipelineView,
  setSeriesPipelineFailure,
  setSeriesPipelineStatus,
  type CreateSeriesPipelineRunInput,
} from "./series-pipeline-store.js";

export interface SeriesPipelineServiceOptions {
  database: DatabaseSync;
  dataRoot: string;
  resolveChapterTextProvider(): Promise<ChapterTextModelConfig | null>;
  scriptGenerationDefaults?: Pick<EpisodeScriptGenerationRequest,
    "voice" | "rate" | "charactersPerSecond" | "narrationOccupancy" | "calibration">;
}

export function fullBookPlanBuildLimits(
  chapters: readonly FullBookPlanChapterInput[],
  episodeCount: number,
): FullBookPlanBuildLimits {
  if (!chapters.length || !Number.isSafeInteger(episodeCount) || episodeCount < 1) {
    throw new Error("全书规划动态分区参数无效");
  }
  const maxChaptersPerInterval = Math.ceil(chapters.length / episodeCount);
  let maxEventsPerInterval = 0;
  let maxInputBytesPerInterval = 0;
  for (let index = 0; index < chapters.length; index += maxChaptersPerInterval) {
    const group = chapters.slice(index, index + maxChaptersPerInterval);
    maxEventsPerInterval = Math.max(maxEventsPerInterval,
      group.reduce((total, chapter) => total + chapter.sourceEvents.length, 0));
    maxInputBytesPerInterval = Math.max(maxInputBytesPerInterval,
      group.reduce((total, chapter) => total + chapter.sourceEvents.reduce(
        (sum, event) => sum + event.inputBytes, 0), 0));
  }
  return {
    maxChaptersPerInterval,
    maxEventsPerInterval,
    maxInputBytesPerInterval,
    maxFinalIntervals: episodeCount,
    maxFinalInputBytes: 5_000_000,
  };
}

export class SeriesPipelineService {
  constructor(private readonly options: SeriesPipelineServiceOptions) {}

  async create(input: CreateSeriesPipelineRunInput) {
    if (!await this.options.resolveChapterTextProvider()) {
      throw Object.assign(new Error("Narralume 文本模型尚未配置"), { statusCode: 409 });
    }
    return this.view(createSeriesPipelineRun(this.options.database, input));
  }

  preview(input: Pick<CreateSeriesPipelineRunInput,
    "seriesProjectId" | "sourceStartChapterId" | "sourceEndChapterId" | "episodeCount">) {
    return previewSeriesPipelineEpisodeRanges(this.options.database, input);
  }

  current(seriesProjectId: string) {
    const run = getCurrentSeriesPipelineRun(this.options.database, seriesProjectId);
    return run ? this.view(run) : undefined;
  }

  get(id: string) {
    const run = getSeriesPipelineRun(this.options.database, id);
    return run ? this.view(run) : undefined;
  }

  pause(id: string) { return this.view(pauseSeriesPipelineRun(this.options.database, id)); }
  resume(id: string) { return this.view(resumeSeriesPipelineRun(this.options.database, id)); }
  cancel(id: string) { return this.view(cancelSeriesPipelineRun(this.options.database, id)); }
  retry(id: string) { return this.view(retrySeriesPipelineRun(this.options.database, id)); }

  convergeChapterAnalysisJobsBeforeWorkerStart() {
    convergeMappedSingleChapterAnalysisJobs(this.options.database);
  }

  private view(run: NonNullable<ReturnType<typeof getSeriesPipelineRun>>) {
    return seriesPipelineView(this.options.database, run);
  }

  async reconcile() {
    for (const candidate of listRunnableSeriesPipelineRuns(this.options.database)) {
      try {
        let run = candidate;
        if (run.status === "configured") {
          run = setSeriesPipelineStatus(this.options.database, run.id, "configured", "analyzing_chapters") ?? run;
        }
        if (run.status === "generating_scripts") {
          await this.reconcileScripts(run);
          continue;
        }
        if (run.status === "checking_coverage") {
          this.reconcileCoverage(run);
          continue;
        }
        if (["planning_episodes", "validating_plan", "freezing_plan"].includes(run.status)) {
          await this.reconcileEpisodePlan(run);
          continue;
        }
        if (run.status === "building_story_bible") {
          await this.reconcileStoryBible(run);
          continue;
        }
        if (run.status !== "analyzing_chapters") continue;

        const chapters = listPipelineChapters(this.options.database, run);
        const bookId = this.bookId(run.seriesProjectId);
        let chapterPrompt: ChapterAnalysisPromptSnapshot | undefined;
        if (run.planningContractVersion === 2) {
          const profile = run.bookPromptProfileRevision
            ? getBookPromptProfileRevision(this.options.database, bookId, run.bookPromptProfileRevision)
            : undefined;
          if (!profile || profile.profileHash !== run.bookPromptProfileHash ||
              run.productPromptVersion !== PRODUCT_PROMPT_SET_VERSION) {
            throw new Error("章节分析缺少有效的冻结提示词身份");
          }
          chapterPrompt = {
            productVersion: PRODUCT_PROMPT_VERSIONS.chapterAnalysis,
            profileRevision: profile.revision,
            profileHash: profile.profileHash,
            instructions: bookPromptInstructions(profile, "chapterAnalysisInstructions"),
          };
        }
        const allMappings = getMappedChapterJobs(this.options.database, run.id);
        const chapterById = new Map(chapters.map((chapter) => [chapter.id, chapter]));
        const currentJobIds = new Set<string>();
        for (const jobId of new Set(allMappings.map((mapping) => mapping.job_id))) {
          const mappedChapters = allMappings.filter((mapping) => mapping.job_id === jobId).map((mapping) => {
            const chapter = chapterById.get(mapping.subject_id);
            return chapter ? { chapterId: chapter.id, contentHash: chapter.contentHash } : undefined;
          });
          const mappedChapter = mappedChapters.length === 1 ? mappedChapters[0] : undefined;
          const mappedJob = getJob(this.options.database, jobId);
          if (mappedChapter && chapterEventsAnalysisJobMatchesSingleChapter(
            mappedJob, bookId,
            mappedChapter.chapterId, mappedChapter.contentHash, chapterPrompt,
          )) {
            currentJobIds.add(jobId);
            convergeSingleChapterAnalysisJob(this.options.database, jobId);
          }
        }
        const mappings = allMappings.filter((mapping) => currentJobIds.has(mapping.job_id));
        const staleMappings = allMappings.filter((mapping) => !currentJobIds.has(mapping.job_id));
        const staleChapterIds = new Set<string>();
        const reusableStaleMappings: Array<{ chapterId: string; jobId: string }> = [];
        for (const mapping of staleMappings) {
          const chapter = chapterById.get(mapping.subject_id);
          const job = getJob(this.options.database, mapping.job_id);
          const checkpoint = this.options.database.prepare(
            `SELECT 1 FROM job_checkpoints
             WHERE job_id = ? AND stage = 'chapter-events-analyze' AND scope_key = ?`,
          ).get(mapping.job_id, mapping.subject_id);
          const reusable = Boolean(chapter?.hasEvents && checkpoint && chapterEventsAnalysisJobMatchesChapter(
            job, bookId, chapter.id, chapter.contentHash, chapterPrompt,
          ));
          if (reusable) reusableStaleMappings.push({ chapterId: mapping.subject_id, jobId: mapping.job_id });
          else staleChapterIds.add(mapping.subject_id);
        }
        const reusableStale = new Set(reusableStaleMappings.map((mapping) => `${mapping.chapterId}\0${mapping.jobId}`));
        const legacyIncomplete = staleMappings.some((mapping) => {
          const job = getJob(this.options.database, mapping.job_id);
          return chapterEventsAnalysisJobIsLegacyBatch(job) &&
            !reusableStale.has(`${mapping.subject_id}\0${mapping.job_id}`) &&
            (!job!.cancelRequested || job!.status === "running");
        });
        if (legacyIncomplete) {
          parkLegacyChapterAnalysisJobs(
            this.options.database,
            run.id,
            staleMappings.filter((mapping) => chapterEventsAnalysisJobIsLegacyBatch(
              getJob(this.options.database, mapping.job_id),
            )).map((mapping) => mapping.job_id),
          );
          setSeriesPipelineFailure(
            this.options.database,
            run.id,
            "legacy_chapter_analysis_retry_required",
            "旧版多章分析未完成，请显式重试失败章节",
          );
          continue;
        }
        const { blockingJobIds } = retainStaleChapterAnalysisJobs(
          this.options.database,
          run.id,
          staleMappings.map((mapping) => mapping.job_id),
          reusableStaleMappings,
        );
        const blockingStaleJobIds = new Set(blockingJobIds);
        failEmptyChapterAnalysisJobs(this.options.database, run.id, [...new Set(mappings.map((mapping) => mapping.job_id))]);
        const mappedJobs = mappings.map((mapping) => ({ mapping, job: getJob(this.options.database, mapping.job_id) }));
        const parked = mappedJobs.find((item) =>
          item.job?.status === "queued" && item.job.runAfter === Number.MAX_SAFE_INTEGER,
        );
        if (parked) {
          mapSeriesPipelineBatchJob(
            this.options.database,
            run.id,
            mappings.filter((mapping) => mapping.job_id === parked.mapping.job_id).map((mapping) => mapping.subject_id),
            parked.mapping.job_id,
          );
        }
        const completedChapterIds = new Set(chapters.filter((chapter) => {
          if (!chapter.hasEvents || staleChapterIds.has(chapter.id)) return false;
          const mapped = mappedJobs.find((item) => item.mapping.subject_id === chapter.id);
          return !mapped || mapped.job?.status === "succeeded";
        }).map((chapter) => chapter.id));
        const relevantJobs = mappedJobs.filter((item) => !completedChapterIds.has(item.mapping.subject_id));
        const failed = relevantJobs.find((item) => item.job?.status === "failed" || item.job?.status === "cancelled");
        if (failed) {
          setSeriesPipelineFailure(
            this.options.database, run.id,
            failed.job!.status === "cancelled" ? "job_cancelled" : failed.job!.errorCode ?? "chapter_analysis_failed",
            failed.job!.status === "cancelled" ? "章节分析已中断，请重试该章节" : "章节分析失败，请重试该章节",
          );
        }
        const mappedSubjects = new Set(mappings.map((mapping) => mapping.subject_id));
        for (const mapping of staleMappings) {
          if (blockingStaleJobIds.has(mapping.job_id)) mappedSubjects.add(mapping.subject_id);
        }
        const pending = chapters.filter((chapter) =>
          !completedChapterIds.has(chapter.id) && !mappedSubjects.has(chapter.id));
        if (!pending.length) {
          const incomplete = relevantJobs.some((item) => item.job?.status !== "succeeded");
          if (!incomplete && chapters.every((chapter) => completedChapterIds.has(chapter.id))) {
            finishChapterAnalysis(this.options.database, run);
          }
          continue;
        }

        const provider = await this.options.resolveChapterTextProvider();
        if (!provider) {
          setSeriesPipelineFailure(this.options.database, run.id, "text_provider_unavailable", "Narralume 文本模型配置不可用");
          continue;
        }
        const activeJobs = new Set(relevantJobs.filter((item) =>
          item.job?.status === "queued" || item.job?.status === "running",
        ).map((item) => item.mapping.job_id));
        for (const jobId of blockingStaleJobIds) activeJobs.add(jobId);
        let slots = Math.max(0, run.chapterConcurrency - activeJobs.size);
        for (const chapter of pending) {
          if (slots === 0) break;
          const result = await enqueueChapterEventsAnalysisJob(
            this.options.database,
            this.options.dataRoot,
            provider,
            { payload: { bookId, chapterId: chapter.id }, maxAttempts: 1, runAfter: Number.MAX_SAFE_INTEGER },
            () => getSeriesPipelineRun(this.options.database, run.id)?.status === "analyzing_chapters",
            chapterPrompt,
          );
          if (!mapSeriesPipelineJob(
            this.options.database,
            run.id,
            chapter.id,
            result.job.id,
            Date.now(),
            staleMappings.filter((mapping) => mapping.subject_id === chapter.id).map((mapping) => mapping.job_id),
          )) break;
          if (result.job.status === "queued" || result.job.status === "running") slots -= 1;
        }
      } catch (error) {
        if (getSeriesPipelineRun(this.options.database, candidate.id)?.status === "paused") continue;
        if (candidate.status === "checking_coverage") {
          this.failCoverage(candidate.id, "script_coverage_check_failed", "覆盖复核执行失败，请检查冻结分集、任务映射和稿件数据");
          continue;
        }
        setSeriesPipelineFailure(
          this.options.database,
          candidate.id,
          "pipeline_reconcile_failed",
          "流水线协调失败，请检查章节、模型配置或本地数据",
        );
      }
    }
  }

  private async reconcileStoryBible(run: NonNullable<ReturnType<typeof getSeriesPipelineRun>>) {
    if (run.planningContractVersion === 2) {
      clearBypassedModelPlanningJobs(this.options.database, run.id);
      return;
    }
    const provider = await this.options.resolveChapterTextProvider();
    if (!provider) {
      setSeriesPipelineFailure(this.options.database, run.id, "text_provider_unavailable", "Narralume 文本模型配置不可用");
      return;
    }
    const bookId = this.bookId(run.seriesProjectId);
    const chapters = this.storyBibleInputs(run);
    const limits: StoryBibleBuildLimits = {
      maxChaptersPerInterval: 20, maxEventsPerInterval: 500, maxInputBytesPerInterval: 1_000_000,
      maxFinalIntervals: 1000, maxFinalInputBytes: 5_000_000,
    };
    const intervals = buildStoryBibleIntervalRequests(bookId, chapters, {
      providerId: provider.providerId, model: provider.model,
    }, limits);
    const base: Omit<BookStoryBibleJobPayload, "providerId" | "model" | "requestHash"> = {
      contractVersion: BOOK_STORY_BIBLE_JOB_CONTRACT_VERSION,
      bookId, intervals, limits, forceRebuild: false,
    };
    const requestHash = storyBibleJobRequestHash(base);
    const mapping = getMappedStoryBibleJob(this.options.database, run.id);
    const job = mapping?.subject_id === requestHash ? getJob(this.options.database, mapping.job_id) : undefined;
    if (job?.status === "failed" || job?.status === "cancelled") {
      setSeriesPipelineFailure(this.options.database, run.id,
        job.status === "cancelled" ? "job_cancelled" : job.errorCode ?? "story_bible_failed",
        job.status === "cancelled" ? "全书世界观生成已中断，请重试" : "全书世界观生成失败，请重试");
      return;
    }
    if (job?.status === "queued") {
      if (job.runAfter === Number.MAX_SAFE_INTEGER) {
        mapSeriesPipelineStoryBibleJob(this.options.database, run.id, requestHash, job.id);
      }
      return;
    }
    if (job?.status === "running") return;
    if (job?.status === "succeeded") {
      const storyBibleId = (job.result as { storyBibleId?: unknown } | null)?.storyBibleId;
      if (typeof storyBibleId !== "string" || !storyBibleId) {
        this.failInvalidStoryBibleJob(job.id, "全书世界观任务缺少最终版本 ID");
        return;
      }
      const bible = this.options.database.prepare(
        "SELECT id FROM book_story_bibles WHERE id = ? AND book_id = ? AND scope = 'final'",
      ).get(storyBibleId, bookId);
      if (!bible) {
        this.failInvalidStoryBibleJob(job.id, "全书世界观任务最终版本不存在");
        return;
      }
      finishStoryBible(this.options.database, run.id, storyBibleId);
      return;
    }

    const payload: BookStoryBibleJobPayload = {
      ...base, providerId: provider.providerId, model: provider.model, requestHash,
    };
    const id = `job_story_bible_${requestHash}`;
    let queued = getJob(this.options.database, id);
    if (!queued) {
      try {
        queued = createJob(this.options.database, {
          id, type: BOOK_STORY_BIBLE_JOB_TYPE, payload, maxAttempts: 3, runAfter: Number.MAX_SAFE_INTEGER,
        });
      }
      catch (error) {
        queued = getJob(this.options.database, id);
        if (!queued) throw error;
      }
    }
    if (queued.type !== BOOK_STORY_BIBLE_JOB_TYPE ||
        (queued.payload as { requestHash?: unknown }).requestHash !== requestHash) {
      throw new Error("全书世界观任务 identity 冲突");
    }
    mapSeriesPipelineStoryBibleJob(this.options.database, run.id, requestHash, queued.id);
  }

  private failInvalidStoryBibleJob(jobId: string, message: string) {
    const now = Date.now();
    this.options.database.prepare(
      `UPDATE jobs SET status = 'failed', progress = 0, error_code = 'story_bible_result_invalid',
         error_message = ?, finished_at = ?, updated_at = ? WHERE id = ? AND status = 'succeeded'`,
    ).run(message, now, now, jobId);
  }

  private async reconcileEpisodePlan(run: NonNullable<ReturnType<typeof getSeriesPipelineRun>>) {
    if (run.planningContractVersion === 2) {
      this.reconcileDeterministicEpisodePlan(run);
      return;
    }
    const provider = await this.options.resolveChapterTextProvider();
    if (!provider) {
      setSeriesPipelineFailure(this.options.database, run.id, "text_provider_unavailable", "Narralume 文本模型配置不可用");
      return;
    }
    const bookId = this.bookId(run.seriesProjectId);
    const bible = run.storyBibleId ? this.options.database.prepare(
      `SELECT id, content_hash FROM book_story_bibles
       WHERE id = ? AND book_id = ? AND scope = 'final' AND invalidated_at IS NULL`,
    ).get(run.storyBibleId, bookId) as { id: string; content_hash: string } | undefined : undefined;
    if (!bible) throw new Error("全书规划缺少当前全书世界观");
    const chapters = this.fullBookPlanInputs(run);
    const limits = fullBookPlanBuildLimits(chapters, run.episodeCount);
    const intervals = buildFullBookPlanIntervalRequests(
      bookId, { id: bible.id, contentHash: bible.content_hash }, chapters, run.episodeCount,
      { providerId: provider.providerId, model: provider.model }, limits,
    );
    const oversized = intervals.find((interval) => Buffer.byteLength(
      JSON.stringify(fullBookPlanIntervalModelInput(interval)), "utf8",
    ) > MAX_CHAPTER_BATCH_INPUT_BYTES);
    if (oversized) throw new Error(`全书规划区间 ${oversized.identityHash} 的模型输入超过 512 KiB 安全上限`);
    const base: Omit<FullBookPlanJobPayload, "providerId" | "model" | "requestHash"> = {
      contractVersion: FULL_BOOK_PLAN_JOB_CONTRACT_VERSION,
      bookId, storyBible: { id: bible.id, contentHash: bible.content_hash },
      episodeCount: run.episodeCount, intervals, limits,
    };
    const requestHash = fullBookPlanJobRequestHash(base);
    const pipelineIdentity = createHash("sha256").update(`${requestHash}:${run.configHash}`).digest("hex");
    const mapping = getMappedEpisodePlanJob(this.options.database, run.id);
    const job = mapping?.subject_id === pipelineIdentity ? getJob(this.options.database, mapping.job_id) : undefined;
    if (job && job.status !== "failed" && job.status !== "cancelled" && run.failureCode) {
      setSeriesPipelineStatus(this.options.database, run.id, run.status, run.status);
    }
    if (job?.status === "failed" || job?.status === "cancelled") {
      setSeriesPipelineFailure(this.options.database, run.id,
        job.status === "cancelled" ? "job_cancelled" : job.errorCode ?? "episode_plan_failed",
        job.status === "cancelled" ? "全书规划已中断，请重试" : "全书规划失败，请重试");
      return;
    }
    if (job?.status === "queued") {
      if (job.runAfter === Number.MAX_SAFE_INTEGER) {
        mapSeriesPipelineEpisodePlanJob(this.options.database, run.id, pipelineIdentity, job.id);
      }
      return;
    }
    if (job?.status === "running") return;
    if (job?.status === "succeeded") {
      const result = job.result as { plan?: unknown; planHash?: unknown } | null;
      if (!result || typeof result.planHash !== "string") {
        this.failInvalidPlanJob(job.id, "全书规划任务缺少有效结果");
        return;
      }
      if (run.status === "planning_episodes") {
        setSeriesPipelineStatus(this.options.database, run.id, "planning_episodes", "validating_plan");
      }
      const sourceEvents = intervals.flatMap((interval) => interval.sourceEvents);
      const planOptions = {
        startChapterIndex: chapters[0]!.chapterIndex,
        endChapterIndex: chapters.at(-1)!.chapterIndex,
        episodeCount: run.episodeCount,
        allowedSourceEvents: new Map(sourceEvents.map(({ id, chapterId, chapterIndex, byteRanges }) =>
          [id, { chapterId, chapterIndex, byteRanges }])),
        intervalQuotas: intervals.map(({ identity }) => ({
          startChapterIndex: identity.startChapterIndex,
          endChapterIndex: identity.endChapterIndex,
          episodeCount: identity.episodeCount,
        })),
      };
      const verifiedPlan = parseFullBookPlan(result.plan, planOptions);
      const verifiedHash = createHash("sha256").update(canonicalFullBookPlanJson(verifiedPlan)).digest("hex");
      if (verifiedHash !== result.planHash) {
        this.failInvalidPlanJob(job.id, "全书规划结果 hash 不一致");
        return;
      }
      if (getSeriesPipelineRun(this.options.database, run.id)?.status === "validating_plan") {
        setSeriesPipelineStatus(this.options.database, run.id, "validating_plan", "freezing_plan");
      }
      const frozen = freezeFullBookPlan(this.options.database, {
        seriesProjectId: run.seriesProjectId,
        plan: verifiedPlan,
        options: planOptions,
        targetDurationSeconds: run.targetDurationSeconds,
      });
      if (frozen.planHash !== verifiedHash) throw new Error("全书规划冻结 hash 不一致");
      finishEpisodePlan(this.options.database, run.id, frozen.planHash);
      return;
    }
    const payload: FullBookPlanJobPayload = {
      ...base, providerId: provider.providerId, model: provider.model, requestHash,
    };
    const id = `job_full_book_plan_${requestHash}`;
    let queued = getJob(this.options.database, id);
    if (!queued) {
      try {
        queued = createJob(this.options.database, {
          id, type: FULL_BOOK_PLAN_JOB_TYPE, payload, maxAttempts: 3, runAfter: Number.MAX_SAFE_INTEGER,
        });
      } catch (error) {
        queued = getJob(this.options.database, id);
        if (!queued) throw error;
      }
    }
    if (queued.type !== FULL_BOOK_PLAN_JOB_TYPE ||
        (queued.payload as { requestHash?: unknown }).requestHash !== requestHash) {
      throw new Error("全书规划任务 identity 冲突");
    }
    mapSeriesPipelineEpisodePlanJob(this.options.database, run.id, pipelineIdentity, queued.id);
  }

  private reconcileDeterministicEpisodePlan(run: NonNullable<ReturnType<typeof getSeriesPipelineRun>>) {
    if (!run.episodeRanges || run.episodeRanges.length !== run.episodeCount) {
      throw new Error("分集来源冻结缺少已确认的章节范围");
    }
    clearBypassedModelPlanningJobs(this.options.database, run.id);
    const chapters = this.fullBookPlanInputs(run);
    const sourceEvents = chapters.flatMap((chapter) => chapter.sourceEvents);
    const planOptions = {
      startChapterIndex: chapters[0]!.chapterIndex,
      endChapterIndex: chapters.at(-1)!.chapterIndex,
      episodeCount: run.episodeCount,
      allowedSourceEvents: new Map(sourceEvents.map(({ id, chapterId, chapterIndex, byteRanges }) =>
        [id, { chapterId, chapterIndex, byteRanges }])),
      intervalQuotas: run.episodeRanges.map((range) => ({
        startChapterIndex: range.startChapterIndex,
        endChapterIndex: range.endChapterIndex,
        episodeCount: 1,
      })),
    };
    const plan = parseFullBookPlan({
      episodes: run.episodeRanges.map((range) => {
        const selected = chapters.filter((chapter) => chapter.chapterIndex >= range.startChapterIndex &&
          chapter.chapterIndex <= range.endChapterIndex);
        return {
          index: range.episodeIndex,
          title: `第 ${range.episodeIndex} 集`,
          storyArc: `忠实讲述第 ${range.startChapterIndex + 1} 至 ${range.endChapterIndex + 1} 章的已确认来源事件。`,
          sourceEventIds: selected.flatMap((chapter) => chapter.sourceEvents.map((event) => event.id)),
          recap: null,
          nextHook: null,
        };
      }),
    }, planOptions);
    const planHash = createHash("sha256").update(canonicalFullBookPlanJson(plan)).digest("hex");
    if (getSeriesPipelineRun(this.options.database, run.id)?.status === "planning_episodes") {
      setSeriesPipelineStatus(this.options.database, run.id, "planning_episodes", "validating_plan");
    }
    if (getSeriesPipelineRun(this.options.database, run.id)?.status === "validating_plan") {
      setSeriesPipelineStatus(this.options.database, run.id, "validating_plan", "freezing_plan");
    }
    const frozen = freezeFullBookPlan(this.options.database, {
      seriesProjectId: run.seriesProjectId,
      plan,
      options: planOptions,
      targetDurationSeconds: run.targetDurationSeconds,
    });
    if (frozen.planHash !== planHash) throw new Error("分集来源冻结 hash 不一致");
    finishEpisodePlan(this.options.database, run.id, frozen.planHash);
  }

  private async reconcileLocalEpisodePlans(
    run: NonNullable<ReturnType<typeof getSeriesPipelineRun>>,
    provider: ChapterTextModelConfig,
  ) {
    if (!run.episodeRanges || run.episodeRanges.length !== run.episodeCount) {
      throw new Error("逐集局部规划缺少已确认的章节范围");
    }
    const bookId = this.bookId(run.seriesProjectId);
    if (run.productPromptVersion !== PRODUCT_PROMPT_SET_VERSION || !run.bookPromptProfileRevision ||
        !run.bookPromptProfileHash) throw new Error("逐集局部规划缺少冻结提示词身份");
    const profile = getBookPromptProfileRevision(this.options.database, bookId, run.bookPromptProfileRevision);
    if (!profile || profile.profileHash !== run.bookPromptProfileHash) {
      throw new Error("逐集局部规划冻结的本书提示词版本不存在或已损坏");
    }
    const bible = run.storyBibleId ? this.options.database.prepare(
      `SELECT id, content_hash FROM book_story_bibles
       WHERE id = ? AND book_id = ? AND scope = 'final' AND invalidated_at IS NULL`,
    ).get(run.storyBibleId, bookId) as { id: string; content_hash: string } | undefined : undefined;
    if (!bible) throw new Error("逐集局部规划缺少当前全书世界观");

    const allChapters = this.fullBookPlanInputs(run);
    const mapped = new Map(getMappedLocalEpisodePlanJobs(this.options.database, run.id)
      .map((mapping) => [mapping.subject_id, mapping.job_id]));
    const localEpisodes: Array<ReturnType<typeof parseFullBookPlan>["episodes"][number] | undefined> =
      new Array(run.episodeCount);
    let waiting = false;

    for (const range of run.episodeRanges) {
      const chapters = allChapters.filter((chapter) => chapter.chapterIndex >= range.startChapterIndex &&
        chapter.chapterIndex <= range.endChapterIndex);
      if (!chapters.length || chapters[0]!.chapterId !== range.startChapterId ||
          chapters.at(-1)!.chapterId !== range.endChapterId) {
        throw new Error(`第 ${range.episodeIndex} 集确认范围与当前章节不一致`);
      }
      const limits = fullBookPlanBuildLimits(chapters, 1);
      const intervals = buildFullBookPlanIntervalRequests(
        bookId, { id: bible.id, contentHash: bible.content_hash }, chapters, 1,
        { providerId: provider.providerId, model: provider.model }, limits,
      );
      if (intervals.length !== 1 || Buffer.byteLength(JSON.stringify(fullBookPlanIntervalModelInput(intervals[0]!)), "utf8") >
          MAX_CHAPTER_BATCH_INPUT_BYTES) {
        throw new Error(`第 ${range.episodeIndex} 集局部规划输入超过 512 KiB 安全上限`);
      }
      const base: Omit<FullBookPlanJobPayload, "providerId" | "model" | "requestHash"> = {
        contractVersion: FULL_BOOK_PLAN_JOB_CONTRACT_VERSION,
        bookId,
        storyBible: { id: bible.id, contentHash: bible.content_hash },
        episodeCount: 1,
        intervals,
        limits,
        prompt: {
          productVersion: PRODUCT_PROMPT_VERSIONS.episodePlanning,
          profileRevision: profile.revision,
          profileHash: profile.profileHash,
          instructions: bookPromptInstructions(profile, "episodePlanningInstructions"),
        },
      };
      const hash = fullBookPlanJobRequestHash(base);
      const subjectId = `${String(range.episodeIndex).padStart(4, "0")}:${hash}`;
      let job = mapped.get(subjectId) ? getJob(this.options.database, mapped.get(subjectId)!) : undefined;
      if (!job) {
        const payload: FullBookPlanJobPayload = {
          ...base, providerId: provider.providerId, model: provider.model, requestHash: hash,
        };
        const id = `job_episode_plan_${hash}`;
        job = getJob(this.options.database, id);
        if (!job) {
          try {
            job = createJob(this.options.database, {
              id, type: EPISODE_PLAN_JOB_TYPE, payload, maxAttempts: 3, runAfter: Number.MAX_SAFE_INTEGER,
            });
          } catch (error) {
            job = getJob(this.options.database, id);
            if (!job) throw error;
          }
        }
        if (job.type !== EPISODE_PLAN_JOB_TYPE ||
            (job.payload as { requestHash?: unknown }).requestHash !== hash) {
          throw new Error("逐集局部规划任务 identity 冲突");
        }
        mapSeriesPipelineLocalEpisodePlanJob(this.options.database, run.id, subjectId, job.id);
      }
      if (job.status === "failed" || job.status === "cancelled") {
        setSeriesPipelineFailure(this.options.database, run.id,
          job.status === "cancelled" ? "job_cancelled" : job.errorCode ?? "episode_plan_failed",
          `第 ${range.episodeIndex} 集局部规划${job.status === "cancelled" ? "已中断" : "失败"}，请重试`);
        return;
      }
      if (job.status !== "succeeded") {
        waiting = true;
        continue;
      }
      const result = job.result as { plan?: unknown; planHash?: unknown } | null;
      if (!result || typeof result.planHash !== "string") {
        this.failInvalidPlanJob(job.id, `第 ${range.episodeIndex} 集局部规划缺少有效结果`);
        return;
      }
      const request = intervals[0]!;
      const local = parseFullBookPlan(result.plan, {
        startChapterIndex: range.startChapterIndex,
        endChapterIndex: range.endChapterIndex,
        episodeCount: 1,
        allowedSourceEvents: new Map(request.sourceEvents.map(({ id, chapterId, chapterIndex, byteRanges }) =>
          [id, { chapterId, chapterIndex, byteRanges }])),
        intervalQuotas: [{
          startChapterIndex: range.startChapterIndex,
          endChapterIndex: range.endChapterIndex,
          episodeCount: 1,
        }],
      });
      const localHash = createHash("sha256").update(canonicalFullBookPlanJson(local)).digest("hex");
      if (localHash !== result.planHash) {
        this.failInvalidPlanJob(job.id, `第 ${range.episodeIndex} 集局部规划结果 hash 不一致`);
        return;
      }
      localEpisodes[range.episodeIndex - 1] = { ...local.episodes[0]!, index: range.episodeIndex };
    }
    if (waiting || localEpisodes.some((episode) => !episode)) return;
    if (run.status === "planning_episodes") {
      setSeriesPipelineStatus(this.options.database, run.id, "planning_episodes", "validating_plan");
    }
    const sourceEvents = allChapters.flatMap((chapter) => chapter.sourceEvents);
    const planOptions = {
      startChapterIndex: allChapters[0]!.chapterIndex,
      endChapterIndex: allChapters.at(-1)!.chapterIndex,
      episodeCount: run.episodeCount,
      allowedSourceEvents: new Map(sourceEvents.map(({ id, chapterId, chapterIndex, byteRanges }) =>
        [id, { chapterId, chapterIndex, byteRanges }])),
      intervalQuotas: run.episodeRanges.map((range) => ({
        startChapterIndex: range.startChapterIndex,
        endChapterIndex: range.endChapterIndex,
        episodeCount: 1,
      })),
    };
    const verifiedPlan = parseFullBookPlan({ episodes: localEpisodes }, planOptions);
    const verifiedHash = createHash("sha256").update(canonicalFullBookPlanJson(verifiedPlan)).digest("hex");
    if (getSeriesPipelineRun(this.options.database, run.id)?.status === "validating_plan") {
      setSeriesPipelineStatus(this.options.database, run.id, "validating_plan", "freezing_plan");
    }
    const frozen = freezeFullBookPlan(this.options.database, {
      seriesProjectId: run.seriesProjectId,
      plan: verifiedPlan,
      options: planOptions,
      targetDurationSeconds: run.targetDurationSeconds,
    });
    if (frozen.planHash !== verifiedHash) throw new Error("逐集局部规划冻结 hash 不一致");
    finishEpisodePlan(this.options.database, run.id, frozen.planHash);
  }

  private failInvalidPlanJob(jobId: string, message: string) {
    const now = Date.now();
    this.options.database.prepare(
      `UPDATE jobs SET status = 'failed', progress = 0, error_code = 'episode_plan_result_invalid',
         error_message = ?, finished_at = ?, updated_at = ? WHERE id = ? AND status = 'succeeded'`,
    ).run(message, now, now, jobId);
  }

  private fullBookPlanInputs(run: NonNullable<ReturnType<typeof getSeriesPipelineRun>>): FullBookPlanChapterInput[] {
    return listPipelineChapters(this.options.database, run).map((chapter) => {
      const rows = this.options.database.prepare(
        `SELECT event.id, event.event_index, event.occurrence, event.event_type, event.payload_json,
                source.source_index, source.source_byte_start, source.source_byte_end, source.source_hash
         FROM chapter_events event
         JOIN chapter_event_sources source ON source.event_id = event.id
         WHERE event.chapter_id = ? ORDER BY event.event_index, event.id, source.source_index`,
      ).all(chapter.id) as unknown as Array<Record<string, unknown> & {
        id: string; event_type: string; payload_json: string; source_byte_start: number; source_byte_end: number;
      }>;
      const byId = new Map<string, typeof rows>();
      for (const row of rows) byId.set(row.id, [...(byId.get(row.id) ?? []), row]);
      return {
        chapterId: chapter.id,
        chapterIndex: chapter.index,
        sourceEvents: [...byId].map(([id, eventRows]) => {
          const json = JSON.stringify(eventRows);
          const event = eventRows[0]!;
          return {
            id, chapterId: chapter.id, chapterIndex: chapter.index,
            eventType: event.event_type,
            payload: JSON.parse(event.payload_json) as unknown,
            byteRanges: eventRows.map((row) => ({ byteStart: row.source_byte_start, byteEnd: row.source_byte_end })),
            contentHash: createHash("sha256").update(json).digest("hex"),
            inputBytes: Buffer.byteLength(json),
          };
        }).sort((left, right) =>
          left.byteRanges.reduce((start, range) => Math.min(start, range.byteStart), Number.MAX_SAFE_INTEGER) -
          right.byteRanges.reduce((start, range) => Math.min(start, range.byteStart), Number.MAX_SAFE_INTEGER)),
      };
    });
  }

  private storyBibleInputs(run: NonNullable<ReturnType<typeof getSeriesPipelineRun>>): StoryBibleChapterInput[] {
    const chapters = listPipelineChapters(this.options.database, run);
    return chapters.map((chapter) => {
      const events = this.options.database.prepare(
        `SELECT event.id, event.event_index, event.occurrence, event.event_type, event.payload_json,
                source.source_index, source.source_byte_start, source.source_byte_end, source.source_hash
         FROM chapter_events event
         LEFT JOIN chapter_event_sources source ON source.event_id = event.id
         WHERE event.chapter_id = ? ORDER BY event.event_index, event.id, source.source_index`,
      ).all(chapter.id) as unknown as Array<Record<string, unknown> & { id: string }>;
      const byId = new Map<string, Array<Record<string, unknown>>>();
      for (const event of events) byId.set(event.id, [...(byId.get(event.id) ?? []), event]);
      return {
        chapterId: chapter.id, chapterIndex: chapter.index,
        sourceEvents: [...byId].map(([id, rows]) => {
          const json = JSON.stringify(rows);
          return { id, contentHash: createHash("sha256").update(json).digest("hex"), inputBytes: Buffer.byteLength(json) };
        }),
      };
    });
  }

  private async reconcileScripts(run: NonNullable<ReturnType<typeof getSeriesPipelineRun>>) {
    const episodes = this.options.database.prepare(
      "SELECT id, episode_index FROM episodes WHERE series_project_id = ? ORDER BY episode_index",
    ).all(run.seriesProjectId) as unknown as Array<{ id: string; episode_index: number }>;
    if (episodes.length !== run.episodeCount || episodes.some((episode, index) => episode.episode_index !== index + 1)) {
      throw new Error("冻结分集与全书计划不一致");
    }
    const provider = await this.options.resolveChapterTextProvider();
    if (!provider) {
      setSeriesPipelineFailure(this.options.database, run.id, "text_provider_unavailable", "Narralume 文本模型配置不可用");
      return;
    }
    const defaults = this.options.scriptGenerationDefaults ?? {
      voice: "Microsoft Huihui Desktop", rate: 0, charactersPerSecond: 4.5,
      narrationOccupancy: 0.8, calibration: { identity: "provisional" as const },
    };
    const profile = run.scriptContractVersion === 6 && run.bookPromptProfileRevision
      ? getBookPromptProfileRevision(this.options.database, this.bookId(run.seriesProjectId),
        run.bookPromptProfileRevision)
      : undefined;
    if (run.scriptContractVersion === 6 && (!profile || profile.profileHash !== run.bookPromptProfileHash ||
        run.productPromptVersion !== PRODUCT_PROMPT_SET_VERSION)) {
      throw new Error("成片旁白 v6 缺少有效的冻结提示词身份");
    }
    let previousHandoff: ScriptHandoff | null = null;
    for (const episode of episodes) {
      const queued = await enqueueEpisodeScriptGenerationJob(this.options.database, this.options.dataRoot, provider, {
        payload: {
          seriesId: run.seriesProjectId,
          episodeIndex: episode.episode_index,
          ...defaults,
          previousScriptHandoff: previousHandoff,
        },
        maxAttempts: 3,
      }, () => getSeriesPipelineRun(this.options.database, run.id)?.status === "generating_scripts", {
        version: run.scriptContractVersion,
        ...(profile ? { prompt: {
          skeletonProductVersion: PRODUCT_PROMPT_VERSIONS.episodeSkeleton,
          beatProductVersion: PRODUCT_PROMPT_VERSIONS.finishedNarrationBeat,
          profileRevision: profile.revision,
          profileHash: profile.profileHash,
          instructions: bookPromptInstructions(profile, "narrationInstructions"),
        } } : {}),
      });
      if (getSeriesPipelineRun(this.options.database, run.id)?.status !== "generating_scripts") return;
      mapSeriesPipelineScriptJob(this.options.database, run.id, episode.id, queued.job.id);
      const job = queued.job;
      if (job?.status === "failed" || job?.status === "cancelled") {
        setSeriesPipelineFailure(this.options.database, run.id,
          job.status === "cancelled" ? "job_cancelled" : job.errorCode ?? "script_generation_failed",
          `第 ${episode.episode_index} 集稿件生成失败，请从本集重试`);
        return;
      }
      if (job?.status === "queued" || job?.status === "running") return;
      if (job?.status === "succeeded") {
        previousHandoff = this.scriptHandoff(job);
        continue;
      }
      return;
    }
    setSeriesPipelineStatus(this.options.database, run.id, "generating_scripts", "checking_coverage");
  }

  private reconcileCoverage(run: NonNullable<ReturnType<typeof getSeriesPipelineRun>>) {
    const episodes = this.options.database.prepare(
      "SELECT id, episode_index FROM episodes WHERE series_project_id = ? ORDER BY episode_index",
    ).all(run.seriesProjectId) as unknown as Array<{ id: string; episode_index: number }>;
    if (episodes.length !== run.episodeCount || episodes.some((episode, index) => episode.episode_index !== index + 1)) {
      this.failCoverage(run.id, "script_coverage_episode_invalid", "覆盖复核失败：冻结分集数量或连续序号与全书计划不一致");
      return;
    }

    const mappings = getMappedScriptJobs(this.options.database, run.id);
    const byEpisode = new Map(mappings.map((mapping) => [mapping.subject_id, mapping.job_id]));
    if (mappings.length !== episodes.length || episodes.some((episode) => !byEpisode.has(episode.id))) {
      this.failCoverage(run.id, "script_coverage_mapping_missing", "覆盖复核失败：存在分集缺少当前稿件任务映射");
      return;
    }

    const versionIds = new Set<string>();
    let expectedVersionCount = 0;
    for (const episode of episodes) {
      const source = this.options.database.prepare(
        `SELECT COUNT(*) AS total, COUNT(DISTINCT source_index) AS distinct_total,
                MIN(source_index) AS first_index, MAX(source_index) AS last_index
         FROM episode_sources WHERE episode_id = ?`,
      ).get(episode.id) as { total: number; distinct_total: number; first_index: number | null; last_index: number | null };
      if (source.total < 1 || source.distinct_total !== source.total || source.first_index !== 0 ||
          source.last_index !== source.total - 1) {
        this.failCoverage(run.id, "script_coverage_sources_invalid", `覆盖复核失败：第 ${episode.episode_index} 集冻结来源缺失或序号不连续`);
        return;
      }

      const job = getJob(this.options.database, byEpisode.get(episode.id)!);
      if (!job || job.type !== EPISODE_SCRIPT_GENERATION_JOB_TYPE || job.status !== "succeeded") {
        this.failCoverage(run.id, "script_coverage_job_invalid", `覆盖复核失败：第 ${episode.episode_index} 集当前稿件任务未成功`);
        return;
      }
      const jobContractVersion = (job.payload as { contractVersion?: unknown } | null)?.contractVersion;
      if (jobContractVersion !== run.scriptContractVersion) {
        this.failCoverage(run.id, "script_coverage_contract_mismatch",
          `覆盖复核失败：第 ${episode.episode_index} 集稿件任务合同版本与当前流水线不一致`);
        return;
      }
      if (jobContractVersion === EPISODE_SCRIPT_GENERATION_V6_CONTRACT_VERSION) {
        const result = job.result as { packagedVersionId?: unknown; finishedNarrationVersionId?: unknown } | null;
        if (typeof result?.packagedVersionId !== "string" ||
            result.finishedNarrationVersionId !== result.packagedVersionId) {
          this.failCoverage(run.id, "script_coverage_result_invalid",
            `覆盖复核失败：第 ${episode.episode_index} 集任务缺少成片旁白版本身份`);
          return;
        }
        const packaged = this.options.database.prepare(
          "SELECT episode_id, kind, parent_version_id FROM script_versions WHERE id = ?",
        ).get(result.packagedVersionId) as { episode_id: string; kind: string; parent_version_id: string | null } | undefined;
        if (!packaged || packaged.episode_id !== episode.id || packaged.kind !== "packaged" ||
            packaged.parent_version_id !== null) {
          this.failCoverage(run.id, "script_coverage_parent_invalid",
            `覆盖复核失败：第 ${episode.episode_index} 集 standalone 成片旁白缺失或父链无效`);
          return;
        }
        try { validateStoredScriptVersion(this.options.database, result.packagedVersionId); }
        catch {
          this.failCoverage(run.id, "script_coverage_version_invalid",
            `覆盖复核失败：第 ${episode.episode_index} 集成片旁白内容或来源快照损坏`);
          return;
        }
        const covered = Number(this.options.database.prepare(
          "SELECT COUNT(DISTINCT episode_source_index) AS total FROM script_version_sources WHERE script_version_id = ?",
        ).get(result.packagedVersionId)?.total);
        if (covered !== source.total) {
          this.failCoverage(run.id, "script_coverage_incomplete",
            `覆盖复核失败：第 ${episode.episode_index} 集成片旁白未覆盖全部冻结来源`);
          return;
        }
        versionIds.add(result.packagedVersionId);
        expectedVersionCount += 1;
        continue;
      }
      if (jobContractVersion !== EPISODE_SCRIPT_GENERATION_LEGACY_CONTRACT_VERSION) {
        this.failCoverage(run.id, "script_coverage_contract_invalid",
          `覆盖复核失败：第 ${episode.episode_index} 集稿件任务合同版本无效`);
        return;
      }
      expectedVersionCount += 2;
      const result = job.result as { faithfulVersionId?: unknown; packagedVersionId?: unknown } | null;
      if (typeof result?.faithfulVersionId !== "string" || typeof result.packagedVersionId !== "string") {
        this.failCoverage(run.id, "script_coverage_result_invalid", `覆盖复核失败：第 ${episode.episode_index} 集任务缺少双稿版本身份`);
        return;
      }
      const faithful = this.options.database.prepare(
        "SELECT episode_id, kind, parent_version_id FROM script_versions WHERE id = ?",
      ).get(result.faithfulVersionId) as { episode_id: string; kind: string; parent_version_id: string | null } | undefined;
      const packaged = this.options.database.prepare(
        "SELECT episode_id, kind, parent_version_id FROM script_versions WHERE id = ?",
      ).get(result.packagedVersionId) as { episode_id: string; kind: string; parent_version_id: string | null } | undefined;
      if (!faithful || faithful.episode_id !== episode.id || faithful.kind !== "faithful" || faithful.parent_version_id ||
          !packaged || packaged.episode_id !== episode.id || packaged.kind !== "packaged" ||
          packaged.parent_version_id !== result.faithfulVersionId) {
        this.failCoverage(run.id, "script_coverage_parent_invalid", `覆盖复核失败：第 ${episode.episode_index} 集双稿缺失或父链无效`);
        return;
      }
      try {
        validateStoredScriptVersion(this.options.database, result.faithfulVersionId);
        validateStoredScriptVersion(this.options.database, result.packagedVersionId);
      } catch {
        this.failCoverage(run.id, "script_coverage_version_invalid", `覆盖复核失败：第 ${episode.episode_index} 集稿件内容或来源快照损坏`);
        return;
      }
      for (const versionId of [result.faithfulVersionId, result.packagedVersionId]) {
        const covered = Number(this.options.database.prepare(
          "SELECT COUNT(DISTINCT episode_source_index) AS total FROM script_version_sources WHERE script_version_id = ?",
        ).get(versionId)?.total);
        if (covered !== source.total) {
          this.failCoverage(run.id, "script_coverage_incomplete", `覆盖复核失败：第 ${episode.episode_index} 集稿件未覆盖全部冻结来源`);
          return;
        }
        versionIds.add(versionId);
      }
    }
    if (versionIds.size !== expectedVersionCount) {
      this.failCoverage(run.id, "script_coverage_total_invalid", "覆盖复核失败：稿件覆盖总数与各任务合同不一致");
      return;
    }
    setSeriesPipelineStatus(this.options.database, run.id, "checking_coverage", "awaiting_review");
  }

  private failCoverage(runId: string, code: string, message: string) {
    const failed = setSeriesPipelineStatus(this.options.database, runId, "checking_coverage", "failed");
    if (failed?.status === "failed") setSeriesPipelineFailure(this.options.database, runId, code, message);
  }

  private scriptHandoff(job: NonNullable<ReturnType<typeof getJob>>): ScriptHandoff {
    const handoff = (job.result as { scriptHandoff?: unknown } | null)?.scriptHandoff;
    if (!handoff || typeof handoff !== "object" || Array.isArray(handoff)) throw new Error("上一集稿件缺少连续性交接");
    const value = handoff as ScriptHandoff;
    if (typeof value.summary !== "string" || !value.summary || value.summary.length > 800 ||
        !Array.isArray(value.continuityNotes) || value.continuityNotes.length > 12 ||
        value.continuityNotes.some((note) => typeof note !== "string" || !note || note.length > 240)) {
      throw new Error("上一集稿件连续性交接无效");
    }
    return { summary: value.summary, continuityNotes: [...value.continuityNotes] };
  }

  private bookId(seriesProjectId: string) {
    const row = this.options.database.prepare("SELECT book_id FROM series_projects WHERE id = ?")
      .get(seriesProjectId) as { book_id: string } | undefined;
    if (!row) throw new Error("系列项目不存在");
    return row.book_id;
  }
}

export class SeriesPipelineWorker {
  #loop: Promise<void> | undefined;
  #stopRequested = false;
  #wake: (() => void) | undefined;

  constructor(
    private readonly service: SeriesPipelineService,
    private readonly onError: (error: unknown) => void = () => undefined,
  ) {}

  start(pollMs = 100) {
    if (!Number.isSafeInteger(pollMs) || pollMs < 1) throw new Error("流水线轮询间隔无效");
    if (this.#loop) throw new Error("流水线 Worker 已启动");
    this.service.convergeChapterAnalysisJobsBeforeWorkerStart();
    this.#stopRequested = false;
    this.#loop = (async () => {
      while (!this.#stopRequested) {
        try { await this.service.reconcile(); } catch (error) { this.onError(error); }
        if (!this.#stopRequested) {
          await new Promise<void>((resolve) => {
            const timer = setTimeout(resolve, pollMs);
            this.#wake = () => { clearTimeout(timer); resolve(); };
          });
          this.#wake = undefined;
        }
      }
    })().finally(() => { this.#wake = undefined; this.#loop = undefined; });
  }

  poke() { this.#wake?.(); }

  async stop() {
    this.#stopRequested = true;
    this.#wake?.();
    await this.#loop;
  }
}
