import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import type { ChapterTextModelConfig } from "./chapter-event-analyzer.js";
import { BOOK_STORY_BIBLE_JOB_TYPE, createBookStoryBibleJobHandler } from "./book-story-bible-job-handler.js";
import { createBookStoryBible } from "./book-story-bible-store.js";
import {
  chapterEventsBatchAnalysisJobIdentity,
  chapterEventsAnalysisJobIdentity,
  createChapterEventsAnalysisJobHandler,
  CHAPTER_EVENTS_ANALYZE_JOB_TYPE,
  CHAPTER_EVENTS_MANUAL_RETRY_REQUIRED,
} from "./chapter-events-job.js";
import { openDatabase } from "./database.js";
import {
  createEpisodeScriptGenerationJobHandler,
  EPISODE_SCRIPT_GENERATION_JOB_TYPE,
  EPISODE_SCRIPT_GENERATION_V6_CONTRACT_VERSION,
  type GenerateEpisodeScript,
} from "./episode-script-generation-job.js";
import { createJob, getJob } from "./job-store.js";
import { canonicalFullBookPlanJson } from "./full-book-plan-contract.js";
import { buildFullBookPlanIntervalRequests } from "./full-book-plan-job.js";
import {
  EPISODE_PLAN_JOB_TYPE,
  FULL_BOOK_PLAN_JOB_TYPE,
  createFullBookPlanJobHandler,
} from "./full-book-plan-job-handler.js";
import { JobWorker } from "./job-worker.js";
import { fullBookPlanBuildLimits, SeriesPipelineService, SeriesPipelineWorker } from "./series-pipeline-service.js";
import { createScriptVersionPair, createStandalonePackagedScriptVersion } from "./script-version-store.js";
import {
  assertSeriesPipelineAllowsChapterEventMutation,
  createSeriesPipelineRun,
  getMappedChapterJobs,
  getMappedEpisodePlanJob,
  getMappedLocalEpisodePlanJobs,
  getMappedScriptJobs,
  getMappedStoryBibleJob,
  getSeriesPipelineRun,
  mapSeriesPipelineJob,
  mapSeriesPipelineEpisodePlanJob,
  mapSeriesPipelineStoryBibleJob,
  mapSeriesPipelineScriptJob,
  pauseSeriesPipelineRun,
  resumeSeriesPipelineRun,
  cancelSeriesPipelineRun,
  retrySeriesPipelineRun,
  seriesPipelineView,
  SeriesPipelineError,
  setSeriesPipelineFailure,
  setSeriesPipelineStatus,
} from "./series-pipeline-store.js";

const provider: ChapterTextModelConfig = {
  baseUrl: "http://local.invalid", apiKey: "test", model: "test-model", providerId: "test-provider",
};

function textForBudget(characterBudget: number, prefix = "稿") {
  return `${prefix}${"文".repeat(Math.max(0, characterBudget - [...prefix].length))}`;
}

test("全书规划按目标集数动态合并长篇章节且保持有界输入", () => {
  const chapters = Array.from({ length: 1_794 }, (_, chapterIndex) => ({
    chapterId: `chapter_${chapterIndex}`,
    chapterIndex,
    sourceEvents: [{
      id: `event_${chapterIndex}`,
      eventType: "revelation",
      payload: { summary: `第 ${chapterIndex} 章事件` },
      chapterId: `chapter_${chapterIndex}`,
      chapterIndex,
      byteRanges: [{ byteStart: chapterIndex * 10, byteEnd: chapterIndex * 10 + 9 }],
      contentHash: createHash("sha256").update(String(chapterIndex)).digest("hex"),
      inputBytes: 100,
    }],
  }));
  const limits = fullBookPlanBuildLimits(chapters, 20);
  assert.deepEqual(limits, {
    maxChaptersPerInterval: 90,
    maxEventsPerInterval: 90,
    maxInputBytesPerInterval: 9_000,
    maxFinalIntervals: 20,
    maxFinalInputBytes: 5_000_000,
  });
  const intervals = buildFullBookPlanIntervalRequests(
    "book_a", { id: "bible_a", contentHash: "1".repeat(64) }, chapters, 20,
    { providerId: provider.providerId, model: provider.model }, limits,
  );
  assert.equal(intervals.length, 20);
  assert.equal(intervals.reduce((total, interval) => total + interval.identity.episodeCount, 0), 20);
});

async function seed(dataRoot: string, suffix = "a", existing?: ReturnType<typeof openDatabase>) {
  const first = Buffer.from(`${suffix}甲在庭院出现。`, "utf8");
  const second = Buffer.from(`${suffix}乙在书房出现。`, "utf8");
  const source = Buffer.concat([first, second]);
  const relativePath = `books/book_${suffix}/source.txt`;
  const path = join(dataRoot, relativePath);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, source);
  const connection = existing ?? openDatabase(dataRoot);
  const database = connection.database;
  database.prepare(`INSERT INTO books
    (id,title,original_file_path,original_file_hash,encoding,import_status)
    VALUES (?,?,?,?,?,'ready')`).run(
    `book_${suffix}`, `书_${suffix}`, relativePath, createHash("sha256").update(source).digest("hex"), "UTF-8",
  );
  const insert = database.prepare(`INSERT INTO chapters
    (id,book_id,chapter_index,title,byte_start,byte_end,char_count,content_hash)
    VALUES (?,?,?,?,?,?,?,?)`);
  insert.run(`chapter_${suffix}_1`, `book_${suffix}`, 0, "第一章", 0, first.length, 7,
    createHash("sha256").update(first).digest("hex"));
  insert.run(`chapter_${suffix}_2`, `book_${suffix}`, 1, "第二章", first.length, source.length, 7,
    createHash("sha256").update(second).digest("hex"));
  database.prepare("INSERT INTO series_projects (id,book_id,title,created_at,updated_at) VALUES (?,?,?,?,?)")
    .run(`series_${suffix}`, `book_${suffix}`, `系列_${suffix}`, 1, 1);
  return connection;
}

function input(suffix = "a") {
  return {
    seriesProjectId: `series_${suffix}`, episodeCount: 10, targetDurationSeconds: 1200,
    sourceStartChapterId: `chapter_${suffix}_1`, sourceEndChapterId: `chapter_${suffix}_2`,
  };
}

async function seedMany(dataRoot: string, suffix: string, parts: readonly Buffer[]) {
  const source = Buffer.concat(parts);
  const relativePath = `books/book_${suffix}/source.txt`;
  await mkdir(dirname(join(dataRoot, relativePath)), { recursive: true });
  await writeFile(join(dataRoot, relativePath), source);
  const connection = openDatabase(dataRoot);
  const database = connection.database;
  database.prepare(`INSERT INTO books
    (id,title,original_file_path,original_file_hash,encoding,import_status)
    VALUES (?,?,?,?,?,'ready')`).run(
    `book_${suffix}`, "书", relativePath, createHash("sha256").update(source).digest("hex"), "UTF-8",
  );
  const insert = database.prepare(`INSERT INTO chapters
    (id,book_id,chapter_index,title,byte_start,byte_end,char_count,content_hash)
    VALUES (?,?,?,?,?,?,?,?)`);
  let offset = 0;
  parts.forEach((part, index) => {
    insert.run(`chapter_${suffix}_${index + 1}`, `book_${suffix}`, index, `第${index + 1}章`, offset,
      offset + part.length, part.length, createHash("sha256").update(part).digest("hex"));
    offset += part.length;
  });
  database.prepare("INSERT INTO series_projects (id,book_id,title,created_at,updated_at) VALUES (?,?,?,?,?)")
    .run(`series_${suffix}`, `book_${suffix}`, "系列", 1, 1);
  return connection;
}

async function coverageFixture(dataRoot: string, contractVersion: 5 | 6 = 5) {
  const connection = await seed(dataRoot);
  const database = connection.database;
  const run = createSeriesPipelineRun(database, { ...input(), episodeCount: 2 });
  if (contractVersion === 6) {
    database.prepare("UPDATE series_pipeline_runs SET script_contract_version = 6 WHERE id = ?").run(run.id);
  }
  setSeriesPipelineStatus(database, run.id, "configured", "checking_coverage");
  const versions = [] as Array<{ episodeId: string; faithfulId: string; packagedId: string }>;
  for (const index of [1, 2]) {
    const episodeId = `coverage_episode_${index}`;
    const chapterId = `chapter_a_${index}`;
    const eventId = `coverage_event_${index}`;
    const chapter = database.prepare(
      "SELECT byte_start,byte_end,content_hash FROM chapters WHERE id = ?",
    ).get(chapterId) as { byte_start: number; byte_end: number; content_hash: string };
    database.prepare(`INSERT INTO chapter_events
      (id,chapter_id,event_index,occurrence,event_type,payload_json,created_at)
      VALUES (?,?,0,0,'revelation',?,1)`).run(eventId, chapterId, JSON.stringify({ fact: `事实${index}` }));
    database.prepare(`INSERT INTO episodes
      (id,series_project_id,episode_index,title,story_arc,target_duration_seconds,recap,next_hook,created_at,updated_at)
      VALUES (?,'series_a',?,?,?,1200,NULL,NULL,1,1)`).run(episodeId, index, `第${index}集`, `故事弧${index}`);
    database.prepare(`INSERT INTO episode_sources
      (episode_id,source_index,chapter_id,source_event_id,source_byte_start,source_byte_end,source_hash)
      VALUES (?,0,?,?,?,?,?)`).run(
      episodeId, chapterId, eventId, chapter.byte_start, chapter.byte_end, chapter.content_hash,
    );
    const pair = createScriptVersionPair(database, episodeId, {
      faithfulParagraphs: [{ text: `忠实稿${index}`, sourceIndexes: [0] }],
      packagedParagraphs: [{ text: `包装稿${index}`, sourceIndexes: [0] }],
    }, () => undefined);
    const job = createJob(database, {
      id: `coverage_job_${index}`, type: EPISODE_SCRIPT_GENERATION_JOB_TYPE,
      payload: { contractVersion: 5 }, maxAttempts: 1,
    });
    database.prepare(
      "UPDATE jobs SET status='succeeded',progress=1,result_json=?,finished_at=1,updated_at=1 WHERE id=?",
    ).run(JSON.stringify({ faithfulVersionId: pair.faithful.id, packagedVersionId: pair.packaged.id }), job.id);
    mapSeriesPipelineScriptJob(database, run.id, episodeId, job.id);
    versions.push({ episodeId, faithfulId: pair.faithful.id, packagedId: pair.packaged.id });
  }
  return { connection, runId: run.id, versions };
}

test("checking_coverage 接受 v6 单稿并按每集一稿计数，且不自动批准", async () => {
  const dataRoot = await mkdtemp(join(tmpdir(), "narralume-pipeline-coverage-v6-"));
  const fixture = await coverageFixture(dataRoot, EPISODE_SCRIPT_GENERATION_V6_CONTRACT_VERSION);
  try {
    const database = fixture.connection.database;
    for (const [index, version] of fixture.versions.entries()) {
      const packaged = createStandalonePackagedScriptVersion(database, version.episodeId, [
        { text: `成片旁白${index + 1}`, sourceIndexes: [0] },
      ], () => undefined);
      const job = createJob(database, {
        id: `coverage_v6_job_${index + 1}`, type: EPISODE_SCRIPT_GENERATION_JOB_TYPE,
        payload: { contractVersion: EPISODE_SCRIPT_GENERATION_V6_CONTRACT_VERSION }, maxAttempts: 1,
      });
      database.prepare(
        "UPDATE jobs SET status='succeeded',progress=1,result_json=?,finished_at=1,updated_at=1 WHERE id=?",
      ).run(JSON.stringify({
        packagedVersionId: packaged.id, finishedNarrationVersionId: packaged.id,
      }), job.id);
      mapSeriesPipelineScriptJob(database, fixture.runId, version.episodeId, job.id);
    }
    const service = new SeriesPipelineService({ database, dataRoot, resolveChapterTextProvider: async () => provider });
    assert.deepEqual(service.get(fixture.runId)!.progress.scripts, { completed: 2, total: 2 });
    await service.reconcile();
    assert.equal(service.get(fixture.runId)!.status, "awaiting_review");
    assert.equal(database.prepare("SELECT COUNT(*) AS total FROM script_approval_events").get()!.total, 0);
  } finally {
    fixture.connection.close();
    await rm(dataRoot, { recursive: true, force: true });
  }
});

test("checking_coverage 拒绝流水线与稿件任务合同版本不一致", async (t) => {
  for (const item of [
    { name: "v6 流水线拒绝 v5 任务", runVersion: 6 as const, jobVersion: 5 as const },
    { name: "v5 流水线拒绝 v6 任务", runVersion: 5 as const, jobVersion: 6 as const },
  ]) await t.test(item.name, async () => {
    const dataRoot = await mkdtemp(join(tmpdir(), "narralume-pipeline-coverage-contract-"));
    const fixture = await coverageFixture(dataRoot, item.runVersion);
    try {
      const database = fixture.connection.database;
      database.prepare(
        `UPDATE jobs SET payload_json = ? WHERE id IN (
           SELECT job_id FROM series_pipeline_jobs WHERE run_id = ? AND stage = 'script_generation'
         )`,
      ).run(JSON.stringify({ contractVersion: item.jobVersion }), fixture.runId);
      const service = new SeriesPipelineService({ database, dataRoot, resolveChapterTextProvider: async () => provider });
      await service.reconcile();
      const failed = service.get(fixture.runId)!;
      assert.equal(failed.status, "failed");
      assert.equal(failed.failureCode, "script_coverage_contract_mismatch");
      assert.equal(failed.failureMessage, "覆盖复核失败：第 1 集稿件任务合同版本与当前流水线不一致");
      assert.equal(database.prepare("SELECT COUNT(*) AS total FROM script_approval_events").get()?.total, 0);
    } finally {
      fixture.connection.close();
      await rm(dataRoot, { recursive: true, force: true });
    }
  });
});

test("checking_coverage 冷重启后进入 awaiting_review 且幂等保持零批准", async () => {
  const dataRoot = await mkdtemp(join(tmpdir(), "narralume-pipeline-coverage-ready-"));
  let fixture = await coverageFixture(dataRoot);
  fixture.connection.close();
  const connection = openDatabase(dataRoot);
  try {
    const service = new SeriesPipelineService({
      database: connection.database, dataRoot, resolveChapterTextProvider: async () => provider,
    });
    await service.reconcile();
    assert.equal(service.get(fixture.runId)!.status, "awaiting_review");
    assert.equal(service.get(fixture.runId)!.failureCode, null);
    assert.equal(connection.database.prepare("SELECT COUNT(*) AS total FROM script_approval_events").get()?.total, 0);
    await service.reconcile();
    assert.equal(service.get(fixture.runId)!.status, "awaiting_review");
    assert.equal(connection.database.prepare("SELECT COUNT(*) AS total FROM script_approval_events").get()?.total, 0);
  } finally {
    connection.close();
    await rm(dataRoot, { recursive: true, force: true });
  }
});

test("checking_coverage 对缺分集、缺映射、缺稿件和坏父链进入可诊断 failed", async (t) => {
  const cases: Array<{
    name: string;
    code: string;
    corrupt(database: ReturnType<typeof openDatabase>["database"], versions: Awaited<ReturnType<typeof coverageFixture>>["versions"]): void;
  }> = [
    {
      name: "缺分集", code: "script_coverage_episode_invalid",
      corrupt: (database, versions) => { database.prepare("DELETE FROM episodes WHERE id = ?").run(versions[1]!.episodeId); },
    },
    {
      name: "缺映射", code: "script_coverage_mapping_missing",
      corrupt: (database, versions) => {
        database.prepare("DELETE FROM series_pipeline_jobs WHERE stage='script_generation' AND subject_id=?")
          .run(versions[1]!.episodeId);
      },
    },
    {
      name: "缺稿件", code: "script_coverage_parent_invalid",
      corrupt: (database, versions) => { database.prepare("DELETE FROM script_versions WHERE id = ?").run(versions[1]!.packagedId); },
    },
    {
      name: "坏父链", code: "script_coverage_parent_invalid",
      corrupt: (database, versions) => {
        database.prepare("UPDATE script_versions SET parent_version_id = NULL WHERE id = ?").run(versions[1]!.packagedId);
      },
    },
  ];
  for (const item of cases) await t.test(item.name, async () => {
    const dataRoot = await mkdtemp(join(tmpdir(), "narralume-pipeline-coverage-invalid-"));
    const fixture = await coverageFixture(dataRoot);
    try {
      const database = fixture.connection.database;
      item.corrupt(database, fixture.versions);
      const service = new SeriesPipelineService({ database, dataRoot, resolveChapterTextProvider: async () => provider });
      await service.reconcile();
      const failed = service.get(fixture.runId)!;
      assert.equal(failed.status, "failed");
      assert.equal(failed.failureCode, item.code);
      assert.match(failed.failureMessage ?? "", /覆盖复核失败/u);
      await service.reconcile();
      assert.deepEqual({
        status: service.get(fixture.runId)!.status,
        code: service.get(fixture.runId)!.failureCode,
        message: service.get(fixture.runId)!.failureMessage,
      }, { status: "failed", code: failed.failureCode, message: failed.failureMessage });
      assert.equal(database.prepare("SELECT COUNT(*) AS total FROM script_approval_events").get()?.total, 0);
    } finally {
      fixture.connection.close();
      await rm(dataRoot, { recursive: true, force: true });
    }
  });
});

test("流水线创建校验连续范围、拒绝重复 active，并隔离另一本书", async () => {
  const dataRoot = await mkdtemp(join(tmpdir(), "narralume-pipeline-create-"));
  const connection = await seed(dataRoot, "a");
  try {
    await seed(dataRoot, "b", connection);
    const database = connection.database;
    const runA = createSeriesPipelineRun(database, input("a"));
    const createdB = createSeriesPipelineRun(database, { ...input("b"), chapterConcurrency: 8 });
    database.prepare("UPDATE series_pipeline_runs SET chapter_batch_size=10,chapter_concurrency=50 WHERE id=?")
      .run(createdB.id);
    const runB = getSeriesPipelineRun(database, createdB.id)!;
    assert.equal(runA.status, "configured");
    assert.equal(runA.chapterBatchSize, 1);
    assert.equal(runA.chapterConcurrency, 8);
    assert.equal(runA.configHash, createHash("sha256").update(JSON.stringify({
      contract: "series-pipeline-v2", seriesProjectId: "series_a", episodeCount: 10,
      targetDurationSeconds: 1200, sourceStartChapterId: "chapter_a_1", sourceEndChapterId: "chapter_a_2",
      chapterBatchSize: 1, chapterConcurrency: 8,
    })).digest("hex"));
    assert.equal(runB.seriesProjectId, "series_b");
    assert.equal(runB.chapterConcurrency, 50);
    assert.throws(() => createSeriesPipelineRun(database, input("a")), (error: unknown) =>
      error instanceof SeriesPipelineError && error.statusCode === 409);
    assert.throws(() => createSeriesPipelineRun(database, { ...input("b"), episodeCount: 0 }), /总集数/);
    assert.throws(() => createSeriesPipelineRun(database, { ...input("b"), chapterBatchSize: 2 }), /每批章节数/);
    assert.throws(() => createSeriesPipelineRun(database, { ...input("b"), chapterConcurrency: 9 }), /章节分析并发数/);
    assert.throws(() => createSeriesPipelineRun(database, {
      ...input("b"), sourceStartChapterId: "chapter_b_2", sourceEndChapterId: "chapter_b_1",
    }), /顺序正确/);
  } finally {
    connection.close();
    await rm(dataRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  }
});

test("pause、resume、cancel、retry 幂等且章节事件仅在暂停时可修改", async () => {
  const dataRoot = await mkdtemp(join(tmpdir(), "narralume-pipeline-control-"));
  const connection = await seed(dataRoot);
  try {
    const database = connection.database;
    const run = createSeriesPipelineRun(database, input());
    assert.throws(
      () => assertSeriesPipelineAllowsChapterEventMutation(database, "book_a", "chapter_a_1"),
      (error: unknown) => error instanceof SeriesPipelineError && error.statusCode === 409,
    );
    assert.equal(pauseSeriesPipelineRun(database, run.id).status, "paused");
    assert.equal(pauseSeriesPipelineRun(database, run.id).status, "paused");
    assert.doesNotThrow(() => assertSeriesPipelineAllowsChapterEventMutation(database, "book_a", "chapter_a_1"));
    assert.equal(resumeSeriesPipelineRun(database, run.id).status, "configured");
    assert.equal(resumeSeriesPipelineRun(database, run.id).status, "configured");
    assert.equal(retrySeriesPipelineRun(database, run.id).status, "configured");
    assert.equal(cancelSeriesPipelineRun(database, run.id).status, "cancelled");
    assert.equal(cancelSeriesPipelineRun(database, run.id).status, "cancelled");
  } finally { connection.close(); await rm(dataRoot, { recursive: true, force: true }); }
});

test("planning contract v2 不调用世界观或局部规划模型并确定性冻结全部来源事件", async () => {
  const dataRoot = await mkdtemp(join(tmpdir(), "narralume-pipeline-local-plan-"));
  const connection = await seed(dataRoot);
  try {
    const database = connection.database;
    for (const index of [1, 2]) {
      const chapter = database.prepare(
        "SELECT byte_start,byte_end,content_hash FROM chapters WHERE id=?",
      ).get(`chapter_a_${index}`) as { byte_start: number; byte_end: number; content_hash: string };
      for (const eventIndex of [0, 1]) {
        const eventId = `event_local_${index}_${eventIndex}`;
        database.prepare(`INSERT INTO chapter_events
          (id,chapter_id,event_index,occurrence,event_type,payload_json,created_at)
          VALUES (?,?,?,?,?,?,1)`).run(
          eventId, `chapter_a_${index}`, eventIndex, 0, eventIndex ? "location" : "revelation",
          JSON.stringify({ summary: `event ${index}.${eventIndex}` }),
        );
        database.prepare(`INSERT INTO chapter_event_sources
          (event_id,source_index,source_byte_start,source_byte_end,source_hash) VALUES (?,0,?,?,?)`)
          .run(eventId, chapter.byte_start + (eventIndex ? 0 : 2),
            chapter.byte_start + (eventIndex ? 1 : 3), chapter.content_hash);
      }
    }
    const run = createSeriesPipelineRun(database, {
      ...input(), episodeCount: 2, targetDurationSeconds: 240,
      episodeRanges: [
        { episodeIndex: 1, startChapterId: "chapter_a_1", endChapterId: "chapter_a_1" },
        { episodeIndex: 2, startChapterId: "chapter_a_2", endChapterId: "chapter_a_2" },
      ],
    });
    database.prepare("UPDATE series_pipeline_runs SET status='building_story_bible' WHERE id=?").run(run.id);
    const legacyStoryJob = createJob(database, {
      id: "job_legacy_story_bible", type: BOOK_STORY_BIBLE_JOB_TYPE, payload: {}, maxAttempts: 3,
    });
    mapSeriesPipelineStoryBibleJob(database, run.id, "legacy-story", legacyStoryJob.id);
    database.prepare(
      `UPDATE jobs SET status='failed',attempts=3,error_code='stream_invalid',
         error_message='模型流式响应无效',finished_at=1 WHERE id=?`,
    ).run(legacyStoryJob.id);
    let providerCalls = 0;
    const service = new SeriesPipelineService({
      database, dataRoot, resolveChapterTextProvider: async () => { providerCalls += 1; return null; },
    });
    assert.equal(service.retry(run.id).status, "planning_episodes");
    assert.equal(getJob(database, legacyStoryJob.id)!.status, "failed");
    assert.equal(getMappedStoryBibleJob(database, run.id), undefined);
    await service.reconcile();
    assert.equal(providerCalls, 0);
    assert.deepEqual(getMappedLocalEpisodePlanJobs(database, run.id), []);
    assert.equal(getMappedEpisodePlanJob(database, run.id), undefined);
    const completed = service.get(run.id)!;
    assert.equal(completed.status, "generating_scripts");
    assert.equal(completed.progress.episodePlan.completed, 2);
    assert.deepEqual(completed.progress.storyBible, { completed: 0, total: 0, steps: null });
    assert.equal(database.prepare("SELECT COUNT(*) AS total FROM episodes").get()!.total, 2);
    assert.deepEqual(database.prepare(
      "SELECT episode_index,title FROM episodes ORDER BY episode_index",
    ).all().map((row) => ({ ...row })), [
      { episode_index: 1, title: "第 1 集" },
      { episode_index: 2, title: "第 2 集" },
    ]);
    assert.deepEqual(database.prepare(
      `SELECT episode.episode_index, source.source_event_id
       FROM episodes episode JOIN episode_sources source ON source.episode_id = episode.id
       ORDER BY episode.episode_index, source.source_index`,
    ).all().map((row) => ({ ...row })), [
      { episode_index: 1, source_event_id: "event_local_1_1" },
      { episode_index: 1, source_event_id: "event_local_1_0" },
      { episode_index: 2, source_event_id: "event_local_2_1" },
      { episode_index: 2, source_event_id: "event_local_2_0" },
    ]);
  } finally { connection.close(); await rm(dataRoot, { recursive: true, force: true }); }
});

test("章节分析复用成功章、暂停不派发、失败局部重试并在重启后进入 building_story_bible", async () => {
  const dataRoot = await mkdtemp(join(tmpdir(), "narralume-pipeline-worker-"));
  let connection = await seed(dataRoot);
  let failSecond = true;
  try {
    const database = connection.database;
    database.prepare(`INSERT INTO chapter_events
      (id,chapter_id,event_index,occurrence,event_type,payload_json,created_at)
      VALUES ('event_existing','chapter_a_1',0,0,'character','{"name":"甲"}',1)`).run();
    const service = new SeriesPipelineService({
      database, dataRoot, resolveChapterTextProvider: async () => provider,
    });
    const created = await service.create(input());
    await service.reconcile();
    const mappings = getMappedChapterJobs(database, created.id);
    assert.deepEqual(mappings.map((mapping) => mapping.subject_id), ["chapter_a_2"]);
    const queuedJobId = mappings[0]!.job_id;
    const paused = service.pause(created.id);
    await service.reconcile();
    const worker = new JobWorker(database, {
      [CHAPTER_EVENTS_ANALYZE_JOB_TYPE]: createChapterEventsAnalysisJobHandler(
        database,
        dataRoot,
        provider,
        async ({ chapterId, atoms }) => {
          if (chapterId === "chapter_a_2" && failSecond) throw new Error("临时模型失败，secret=不得回传完整响应");
          return [{
            type: "character" as const,
            payload: { name: chapterId },
            sources: [{ byteStart: atoms[0]!.byteStart, byteEnd: atoms[0]!.byteEnd }],
          }];
        },
      ),
    }, { workerId: "pipeline-test", leaseMs: 10_000, heartbeatMs: 1_000, retryDelayMs: 0 });
    assert.equal(database.prepare("SELECT run_after FROM jobs WHERE id=?").get(queuedJobId)?.run_after, Number.MAX_SAFE_INTEGER);
    assert.equal(await worker.runOne(), false);
    assert.equal(paused.progress.chapterAnalysis.queued, 0);
    service.resume(created.id);
    await service.reconcile();
    assert.notEqual(database.prepare("SELECT run_after FROM jobs WHERE id=?").get(queuedJobId)?.run_after, Number.MAX_SAFE_INTEGER);
    await worker.runOne(); await worker.runOne(); await worker.runOne();
    await service.reconcile();
    const failed = service.get(created.id)!;
    assert.equal(failed.progress.chapterAnalysis.failed, 1);
    assert.equal(failed.progress.chapterAnalysis.completed, 1);
    assert.equal(failed.failures[0]!.subjectId, "chapter_a_2");
    assert.equal(failed.failures[0]!.message!.length < 2000, true);
    assert.equal(service.retry(created.id).progress.chapterAnalysis.failed, 0);
    assert.equal(service.retry(created.id).progress.chapterAnalysis.failed, 0);
    failSecond = false;
    await worker.runOne();

    connection.close();
    connection = openDatabase(dataRoot);
    const restartedDatabase = connection.database;
    const restarted = new SeriesPipelineService({
      database: restartedDatabase, dataRoot, resolveChapterTextProvider: async () => provider,
    });
    await restarted.reconcile();
    const completed = restarted.get(created.id)!;
    assert.equal(completed.status, "building_story_bible");
    assert.equal(completed.progress.chapterAnalysis.completed, 2);
    assert.equal(completed.progress.chapterAnalysis.reused, 1);
    assert.match(getSeriesPipelineRun(restartedDatabase, created.id)!.chapterEventsHash!, /^[0-9a-f]{64}$/);
    assert.equal(getMappedChapterJobs(restartedDatabase, created.id).length, 1);
    assert.equal(restartedDatabase.prepare("SELECT status FROM jobs WHERE id=?").get(queuedJobId)?.status, "succeeded");
    await restarted.reconcile();
    assert.equal(getMappedChapterJobs(restartedDatabase, created.id).length, 1);
  } finally { connection.close(); await rm(dataRoot, { recursive: true, force: true }); }
});

test("pause 请求中断独占 running Job，停止完成后 resume 重新排队", async () => {
  const dataRoot = await mkdtemp(join(tmpdir(), "narralume-pipeline-pause-running-"));
  const connection = await seed(dataRoot);
  try {
    const database = connection.database;
    const run = createSeriesPipelineRun(database, input());
    setSeriesPipelineStatus(database, run.id, "configured", "analyzing_chapters");
    const job = createJob(database, { id: "job_pause_running", type: CHAPTER_EVENTS_ANALYZE_JOB_TYPE, payload: {} });
    assert.equal(mapSeriesPipelineJob(database, run.id, "chapter_a_1", job.id), true);
    database.prepare(
      `UPDATE jobs SET status='running',attempts=1,lease_owner='pause-worker',lease_expires_at=? WHERE id=?`,
    ).run(Date.now() + 60_000, job.id);

    assert.equal(pauseSeriesPipelineRun(database, run.id).status, "paused");
    assert.deepEqual({ ...database.prepare(
      "SELECT status,cancel_requested,run_after FROM jobs WHERE id=?",
    ).get(job.id) }, { status: "running", cancel_requested: 1, run_after: Number.MAX_SAFE_INTEGER });
    assert.equal(seriesPipelineView(database, getSeriesPipelineRun(database, run.id)!).actions.canResume, false);
    assert.throws(() => resumeSeriesPipelineRun(database, run.id), /正在停止/);

    database.prepare(
      `UPDATE jobs SET status='cancelled',lease_owner=NULL,lease_expires_at=NULL,finished_at=? WHERE id=?`,
    ).run(Date.now(), job.id);
    assert.equal(seriesPipelineView(database, getSeriesPipelineRun(database, run.id)!).actions.canResume, true);
    assert.equal(resumeSeriesPipelineRun(database, run.id).status, "analyzing_chapters");
    assert.deepEqual({ ...database.prepare(
      "SELECT status,progress,attempts,cancel_requested,run_after FROM jobs WHERE id=?",
    ).get(job.id) }, {
      status: "queued", progress: 0, attempts: 0, cancel_requested: 0, run_after: Number.MAX_SAFE_INTEGER,
    });
  } finally { connection.close(); await rm(dataRoot, { recursive: true, force: true }); }
});

test("章节分析 rolling 窗口维持八个单章 Job 并在完成后立即补位", async () => {
  const dataRoot = await mkdtemp(join(tmpdir(), "narralume-pipeline-rolling-eight-"));
  const parts = Array.from({ length: 9 }, (_, index) => Buffer.from(`第${index + 1}章内容。`, "utf8"));
  const source = Buffer.concat(parts);
  const relativePath = "books/book_rolling/source.txt";
  await mkdir(dirname(join(dataRoot, relativePath)), { recursive: true });
  await writeFile(join(dataRoot, relativePath), source);
  const connection = openDatabase(dataRoot);
  try {
    const database = connection.database;
    database.prepare(`INSERT INTO books
      (id,title,original_file_path,original_file_hash,encoding,import_status)
      VALUES ('book_rolling','书',?,?, 'UTF-8','ready')`)
      .run(relativePath, createHash("sha256").update(source).digest("hex"));
    const insert = database.prepare(`INSERT INTO chapters
      (id,book_id,chapter_index,title,byte_start,byte_end,char_count,content_hash)
      VALUES (?,'book_rolling',?,?,?,?,?,?)`);
    let offset = 0;
    parts.forEach((part, index) => {
      insert.run(`chapter_rolling_${index + 1}`, index, `第${index + 1}章`, offset, offset + part.length, part.length,
        createHash("sha256").update(part).digest("hex"));
      offset += part.length;
    });
    database.prepare("INSERT INTO series_projects (id,book_id,title,created_at,updated_at) VALUES ('series_rolling','book_rolling','系列',1,1)").run();
    const service = new SeriesPipelineService({ database, dataRoot, resolveChapterTextProvider: async () => provider });
    const run = await service.create({
      seriesProjectId: "series_rolling", episodeCount: 10, targetDurationSeconds: 1200,
      sourceStartChapterId: "chapter_rolling_1", sourceEndChapterId: "chapter_rolling_9",
      chapterBatchSize: 1, chapterConcurrency: 8,
    });
    await service.reconcile();
    const initialJobs = [...new Set(getMappedChapterJobs(database, run.id).map((mapping) => mapping.job_id))]
      .map((jobId) => getJob(database, jobId)!);
    assert.equal(initialJobs.length, 8);
    assert.ok(initialJobs.every((job) => job.maxAttempts === 1 &&
      typeof (job.payload as { chapterId?: unknown }).chapterId === "string" &&
      !Array.isArray((job.payload as { chapters?: unknown }).chapters)));
    database.prepare("UPDATE jobs SET max_attempts=3 WHERE id=?").run(initialJobs[0]!.id);
    await service.reconcile();
    assert.equal(getJob(database, initialJobs[0]!.id)!.maxAttempts, 1);
    const worker = new JobWorker(database, {
      [CHAPTER_EVENTS_ANALYZE_JOB_TYPE]: createChapterEventsAnalysisJobHandler(
        database, dataRoot, provider,
        async ({ chapterId, atoms }) => [{
          type: "character", payload: { name: chapterId },
          sources: [{ byteStart: atoms[0]!.byteStart, byteEnd: atoms[0]!.byteEnd }],
        }],
      ),
    }, { workerId: "rolling-eight", leaseMs: 10_000, heartbeatMs: 1_000 });
    assert.equal(await worker.runOne(), true);
    await service.reconcile();
    const mapped = getMappedChapterJobs(database, run.id);
    assert.equal(mapped.length, 9);
    assert.equal(new Set(mapped.filter((mapping) => {
      const status = getJob(database, mapping.job_id)?.status;
      return status === "queued" || status === "running";
    }).map((mapping) => mapping.job_id)).size, 8);
  } finally { connection.close(); await rm(dataRoot, { recursive: true, force: true }); }
});

test("历史单章已耗尽旧重试次数时转为显式失败并允许滚动补位及正式重试", async () => {
  const dataRoot = await mkdtemp(join(tmpdir(), "narralume-pipeline-exhausted-queued-"));
  const connection = await seedMany(dataRoot, "exhausted_queued", [
    Buffer.from("甲进入石门。", "utf8"),
    Buffer.from("乙随后进入。", "utf8"),
  ]);
  try {
    const database = connection.database;
    const service = new SeriesPipelineService({ database, dataRoot, resolveChapterTextProvider: async () => provider });
    const run = await service.create({
      seriesProjectId: "series_exhausted_queued", episodeCount: 2, targetDurationSeconds: 1200,
      sourceStartChapterId: "chapter_exhausted_queued_1", sourceEndChapterId: "chapter_exhausted_queued_2",
      chapterBatchSize: 1, chapterConcurrency: 1,
    });
    await service.reconcile();
    const firstJobId = getMappedChapterJobs(database, run.id)[0]!.job_id;
    database.prepare("UPDATE jobs SET attempts=1,max_attempts=3 WHERE id=? AND status='queued'").run(firstJobId);

    await service.reconcile();
    const exhausted = getJob(database, firstJobId)!;
    assert.equal(exhausted.status, "failed");
    assert.equal(exhausted.maxAttempts, 1);
    assert.equal(exhausted.attempts, 1);
    assert.equal(exhausted.errorCode, CHAPTER_EVENTS_MANUAL_RETRY_REQUIRED);
    assert.equal(typeof exhausted.finishedAt, "number");
    const refillJobId = getMappedChapterJobs(database, run.id)
      .find((mapping) => mapping.subject_id === "chapter_exhausted_queued_2")!.job_id;
    assert.equal(getJob(database, refillJobId)!.status, "queued");

    const calls = new Map<string, number>();
    const worker = new JobWorker(database, {
      [CHAPTER_EVENTS_ANALYZE_JOB_TYPE]: createChapterEventsAnalysisJobHandler(
        database, dataRoot, provider,
        async ({ chapterId, atoms }) => {
          calls.set(chapterId, (calls.get(chapterId) ?? 0) + 1);
          return [{
            type: "character", payload: { name: chapterId },
            sources: [{ byteStart: atoms[0]!.byteStart, byteEnd: atoms[0]!.byteEnd }],
          }];
        },
      ),
    }, { workerId: "exhausted-queued", leaseMs: 10_000, heartbeatMs: 1_000 });
    assert.equal(await worker.runOne(), true);
    assert.equal(calls.has("chapter_exhausted_queued_1"), false);
    await service.reconcile();
    const failed = service.get(run.id)!;
    assert.equal(failed.status, "failed");
    assert.equal(failed.current, null);
    assert.equal(failed.actions.canRetry, true);
    assert.equal(failed.progress.chapterAnalysis.queued, 0);
    assert.equal(failed.progress.chapterAnalysis.completed, 1);
    assert.equal(failed.progress.chapterAnalysis.failed, 1);

    const retried = service.retry(run.id);
    const retryJob = getJob(database, firstJobId)!;
    assert.equal(retried.progress.chapterAnalysis.queued, 1);
    assert.equal(retryJob.status, "queued");
    assert.equal(retryJob.attempts, 0);
    assert.equal(retryJob.maxAttempts, 1);
    assert.equal(await worker.runOne(), true);
    assert.equal(calls.get("chapter_exhausted_queued_1"), 1);
    await service.reconcile();
    assert.equal(service.get(run.id)!.progress.chapterAnalysis.completed, 2);
  } finally { connection.close(); await rm(dataRoot, { recursive: true, force: true }); }
});

test("流水线启动在异步协调前全局收敛历史单章任务并阻止抢先付费请求", async () => {
  const dataRoot = await mkdtemp(join(tmpdir(), "narralume-pipeline-startup-barrier-"));
  const connection = await seed(dataRoot, "barrier_first");
  await seed(dataRoot, "barrier_second", connection);
  await seed(dataRoot, "barrier_stale", connection);
  let releaseProvider!: () => void;
  const providerBlocked = new Promise<void>((resolve) => { releaseProvider = resolve; });
  let providerEntered!: () => void;
  const providerStarted = new Promise<void>((resolve) => { providerEntered = resolve; });
  let pipelineError: unknown;
  let pipelineWorker: SeriesPipelineWorker | undefined;
  try {
    const database = connection.database;
    const firstRun = createSeriesPipelineRun(database, {
      ...input("barrier_first"), sourceEndChapterId: "chapter_barrier_first_1", chapterConcurrency: 1,
    }, 1);
    const secondRun = createSeriesPipelineRun(database, {
      ...input("barrier_second"), sourceEndChapterId: "chapter_barrier_second_1", chapterConcurrency: 1,
    }, 2);
    const staleRun = createSeriesPipelineRun(database, {
      ...input("barrier_stale"), sourceEndChapterId: "chapter_barrier_stale_1", chapterConcurrency: 1,
    }, 3);
    setSeriesPipelineStatus(database, firstRun.id, "configured", "analyzing_chapters");
    setSeriesPipelineStatus(database, secondRun.id, "configured", "analyzing_chapters");
    setSeriesPipelineStatus(database, staleRun.id, "configured", "analyzing_chapters");
    database.prepare(
      "UPDATE series_pipeline_runs SET planning_contract_version=2,product_prompt_version='stale' WHERE id=?",
    ).run(staleRun.id);
    const chapter = database.prepare(
      "SELECT content_hash FROM chapters WHERE id='chapter_barrier_second_1'",
    ).get() as { content_hash: string };
    const frozen = chapterEventsAnalysisJobIdentity(
      "book_barrier_second", "chapter_barrier_second_1", chapter.content_hash,
    );
    createJob(database, {
      id: frozen.jobId,
      type: CHAPTER_EVENTS_ANALYZE_JOB_TYPE,
      payload: {
        ...frozen.identity, providerId: provider.providerId, model: provider.model, requestHash: frozen.requestHash,
      },
      maxAttempts: 3,
      runAfter: 1,
    }, 2);
    database.prepare("UPDATE jobs SET attempts=1 WHERE id=?").run(frozen.jobId);
    mapSeriesPipelineJob(database, secondRun.id, "chapter_barrier_second_1", frozen.jobId, 2);
    const staleChapter = database.prepare(
      "SELECT content_hash FROM chapters WHERE id='chapter_barrier_stale_1'",
    ).get() as { content_hash: string };
    const staleFrozen = chapterEventsAnalysisJobIdentity(
      "book_barrier_stale", "chapter_barrier_stale_1", staleChapter.content_hash,
    );
    createJob(database, {
      id: staleFrozen.jobId,
      type: CHAPTER_EVENTS_ANALYZE_JOB_TYPE,
      payload: {
        ...staleFrozen.identity, providerId: provider.providerId, model: provider.model,
        requestHash: staleFrozen.requestHash,
      },
      maxAttempts: 3,
      runAfter: 1,
    }, 3);
    mapSeriesPipelineJob(database, staleRun.id, "chapter_barrier_stale_1", staleFrozen.jobId, 3);

    const service = new SeriesPipelineService({
      database,
      dataRoot,
      resolveChapterTextProvider: async () => {
        providerEntered();
        await providerBlocked;
        return provider;
      },
    });
    let modelCalls = 0;
    const chapterWorker = new JobWorker(database, {
      [CHAPTER_EVENTS_ANALYZE_JOB_TYPE]: async () => {
        modelCalls += 1;
        return {};
      },
    }, { workerId: "startup-barrier-chapter", leaseMs: 10_000, heartbeatMs: 1_000 });
    pipelineWorker = new SeriesPipelineWorker(service, (error) => { pipelineError = error; });

    pipelineWorker.start(60_000);
    await providerStarted;
    const converged = getJob(database, frozen.jobId)!;
    assert.equal(converged.status, "failed");
    assert.equal(converged.attempts, 1);
    assert.equal(converged.maxAttempts, 1);
    assert.equal(converged.errorCode, CHAPTER_EVENTS_MANUAL_RETRY_REQUIRED);
    const parkedStale = getJob(database, staleFrozen.jobId)!;
    assert.equal(parkedStale.status, "queued");
    assert.equal(parkedStale.maxAttempts, 3);
    assert.equal(parkedStale.runAfter, Number.MAX_SAFE_INTEGER);
    assert.equal(await chapterWorker.runOne(), false);
    assert.equal(modelCalls, 0);
    assert.equal(pipelineError, undefined);
  } finally {
    releaseProvider();
    await pipelineWorker?.stop();
    connection.close();
    await rm(dataRoot, { recursive: true, force: true });
  }
});

test("启动 barrier 隔离坏 Run 并继续收敛健康 owner 且 park 坏 owner 单章任务", async () => {
  const dataRoot = await mkdtemp(join(tmpdir(), "narralume-pipeline-bad-run-barrier-"));
  const connection = await seed(dataRoot, "barrier_healthy");
  await seed(dataRoot, "barrier_bad", connection);
  let pipelineWorker: SeriesPipelineWorker | undefined;
  try {
    const database = connection.database;
    const healthyRun = createSeriesPipelineRun(database, {
      ...input("barrier_healthy"), sourceEndChapterId: "chapter_barrier_healthy_1", chapterConcurrency: 1,
    }, 1);
    const badRun = createSeriesPipelineRun(database, {
      ...input("barrier_bad"), sourceEndChapterId: "chapter_barrier_bad_1", chapterConcurrency: 1,
    }, 2);
    setSeriesPipelineStatus(database, healthyRun.id, "configured", "analyzing_chapters");
    setSeriesPipelineStatus(database, badRun.id, "configured", "analyzing_chapters");
    const identities = ([
      ["barrier_healthy", healthyRun.id, 1],
      ["barrier_bad", badRun.id, 2],
    ] as const).map(([suffix, runId, now]) => {
      const chapterId = `chapter_${suffix}_1`;
      const chapter = database.prepare("SELECT content_hash FROM chapters WHERE id=?")
        .get(chapterId) as { content_hash: string };
      const frozen = chapterEventsAnalysisJobIdentity(`book_${suffix}`, chapterId, chapter.content_hash);
      createJob(database, {
        id: frozen.jobId, type: CHAPTER_EVENTS_ANALYZE_JOB_TYPE,
        payload: {
          ...frozen.identity, providerId: provider.providerId, model: provider.model, requestHash: frozen.requestHash,
        },
        maxAttempts: 3, runAfter: 1,
      }, now);
      mapSeriesPipelineJob(database, runId, chapterId, frozen.jobId, now);
      return frozen;
    });
    database.prepare("UPDATE jobs SET attempts=1 WHERE id=?").run(identities[0]!.jobId);
    database.prepare(
      "UPDATE series_pipeline_runs SET source_end_chapter_id='chapter_barrier_healthy_1' WHERE id=?",
    ).run(badRun.id);
    const service = new SeriesPipelineService({
      database, dataRoot, resolveChapterTextProvider: async () => provider,
    });
    let modelCalls = 0;
    const chapterWorker = new JobWorker(database, {
      [CHAPTER_EVENTS_ANALYZE_JOB_TYPE]: async () => { modelCalls += 1; return {}; },
    }, { workerId: "bad-run-barrier", leaseMs: 10_000, heartbeatMs: 1_000 });
    pipelineWorker = new SeriesPipelineWorker(service);

    assert.doesNotThrow(() => pipelineWorker!.start(60_000));
    assert.deepEqual({
      status: getJob(database, identities[0]!.jobId)!.status,
      maxAttempts: getJob(database, identities[0]!.jobId)!.maxAttempts,
    }, { status: "failed", maxAttempts: 1 });
    assert.deepEqual({
      status: getJob(database, identities[1]!.jobId)!.status,
      runAfter: getJob(database, identities[1]!.jobId)!.runAfter,
      maxAttempts: getJob(database, identities[1]!.jobId)!.maxAttempts,
    }, { status: "queued", runAfter: Number.MAX_SAFE_INTEGER, maxAttempts: 3 });
    assert.equal(await chapterWorker.runOne(), false);
    assert.equal(modelCalls, 0);
  } finally {
    await pipelineWorker?.stop();
    connection.close();
    await rm(dataRoot, { recursive: true, force: true });
  }
});

test("启动 barrier 以共享 current owner 为准且不改 terminal paused 与 legacy Job", async () => {
  const dataRoot = await mkdtemp(join(tmpdir(), "narralume-pipeline-owner-barrier-"));
  const connection = await seed(dataRoot, "barrier_shared");
  await seed(dataRoot, "barrier_terminal", connection);
  await seed(dataRoot, "barrier_paused", connection);
  await seed(dataRoot, "barrier_legacy", connection);
  try {
    const database = connection.database;
    database.prepare(
      "INSERT INTO series_projects (id,book_id,title,created_at,updated_at) VALUES ('series_barrier_shared_bad','book_barrier_shared','坏 owner',2,2)",
    ).run();
    const currentRun = createSeriesPipelineRun(database, {
      ...input("barrier_shared"), sourceEndChapterId: "chapter_barrier_shared_1", chapterConcurrency: 1,
    }, 1);
    const badOwnerRun = createSeriesPipelineRun(database, {
      ...input("barrier_shared"), seriesProjectId: "series_barrier_shared_bad",
      sourceEndChapterId: "chapter_barrier_shared_1", chapterConcurrency: 1,
    }, 2);
    setSeriesPipelineStatus(database, currentRun.id, "configured", "analyzing_chapters");
    setSeriesPipelineStatus(database, badOwnerRun.id, "configured", "analyzing_chapters");
    const sharedChapter = database.prepare(
      "SELECT content_hash FROM chapters WHERE id='chapter_barrier_shared_1'",
    ).get() as { content_hash: string };
    const shared = chapterEventsAnalysisJobIdentity(
      "book_barrier_shared", "chapter_barrier_shared_1", sharedChapter.content_hash,
    );
    createJob(database, {
      id: shared.jobId, type: CHAPTER_EVENTS_ANALYZE_JOB_TYPE,
      payload: { ...shared.identity, providerId: provider.providerId, model: provider.model, requestHash: shared.requestHash },
      maxAttempts: 3, runAfter: 1,
    }, 1);
    database.prepare("UPDATE jobs SET attempts=1 WHERE id=?").run(shared.jobId);
    mapSeriesPipelineJob(database, currentRun.id, "chapter_barrier_shared_1", shared.jobId, 1);
    mapSeriesPipelineJob(database, badOwnerRun.id, "chapter_barrier_shared_1", shared.jobId, 2);
    database.prepare(
      "UPDATE series_pipeline_runs SET source_end_chapter_id='chapter_barrier_terminal_1' WHERE id=?",
    ).run(badOwnerRun.id);

    const untouched: string[] = [];
    for (const [suffix, status, runAfter] of [
      ["barrier_terminal", "succeeded", 1],
      ["barrier_paused", "queued", Number.MAX_SAFE_INTEGER],
    ] as const) {
      const run = createSeriesPipelineRun(database, {
        ...input(suffix), sourceEndChapterId: `chapter_${suffix}_1`, chapterConcurrency: 1,
      });
      setSeriesPipelineStatus(database, run.id, "configured", "analyzing_chapters");
      if (suffix === "barrier_paused") {
        database.prepare(
          "UPDATE series_pipeline_runs SET status='paused',resume_status='analyzing_chapters' WHERE id=?",
        ).run(run.id);
      }
      const chapterId = `chapter_${suffix}_1`;
      const chapter = database.prepare("SELECT content_hash FROM chapters WHERE id=?")
        .get(chapterId) as { content_hash: string };
      const frozen = chapterEventsAnalysisJobIdentity(`book_${suffix}`, chapterId, chapter.content_hash);
      createJob(database, {
        id: frozen.jobId, type: CHAPTER_EVENTS_ANALYZE_JOB_TYPE,
        payload: {
          ...frozen.identity, providerId: provider.providerId, model: provider.model, requestHash: frozen.requestHash,
        },
        maxAttempts: 3, runAfter,
      });
      if (status === "succeeded") {
        database.prepare("UPDATE jobs SET status='succeeded',attempts=1,finished_at=1 WHERE id=?").run(frozen.jobId);
      }
      mapSeriesPipelineJob(database, run.id, chapterId, frozen.jobId);
      untouched.push(frozen.jobId);
    }
    const legacyRun = createSeriesPipelineRun(database, { ...input("barrier_legacy"), chapterConcurrency: 1 });
    setSeriesPipelineStatus(database, legacyRun.id, "configured", "analyzing_chapters");
    const legacyChapters = database.prepare(
      "SELECT id,content_hash FROM chapters WHERE book_id='book_barrier_legacy' ORDER BY chapter_index",
    ).all() as unknown as Array<{ id: string; content_hash: string }>;
    const legacy = chapterEventsBatchAnalysisJobIdentity(
      "book_barrier_legacy",
      legacyChapters.map((chapter) => ({ chapterId: chapter.id, contentHash: chapter.content_hash })),
    );
    createJob(database, {
      id: legacy.jobId, type: CHAPTER_EVENTS_ANALYZE_JOB_TYPE,
      payload: { ...legacy.identity, providerId: provider.providerId, model: provider.model, requestHash: legacy.requestHash },
      maxAttempts: 3, runAfter: 1,
    });
    for (const chapter of legacyChapters) mapSeriesPipelineJob(database, legacyRun.id, chapter.id, legacy.jobId);
    untouched.push(legacy.jobId);
    const before = new Map(untouched.map((jobId) => [jobId, getJob(database, jobId)]));

    const service = new SeriesPipelineService({
      database, dataRoot, resolveChapterTextProvider: async () => provider,
    });
    service.convergeChapterAnalysisJobsBeforeWorkerStart();

    assert.deepEqual({
      status: getJob(database, shared.jobId)!.status,
      maxAttempts: getJob(database, shared.jobId)!.maxAttempts,
      runAfter: getJob(database, shared.jobId)!.runAfter,
    }, { status: "failed", maxAttempts: 1, runAfter: 1 });
    for (const jobId of untouched) assert.deepEqual(getJob(database, jobId), before.get(jobId));
  } finally {
    connection.close();
    await rm(dataRoot, { recursive: true, force: true });
  }
});

test("旧多章 Job 重启后按章节投影并仅由显式控制迁移未完成映射", async () => {
  const dataRoot = await mkdtemp(join(tmpdir(), "narralume-pipeline-legacy-batches-"));
  const cases = ["succeeded", "failed", "partial", "queued", "running"] as const;
  let connection = await seed(dataRoot, cases[0]);
  try {
    for (const suffix of cases.slice(1)) await seed(dataRoot, suffix, connection);
    const database = connection.database;
    const service = new SeriesPipelineService({ database, dataRoot, resolveChapterTextProvider: async () => provider });
    const fixtures = new Map<typeof cases[number], { runId: string; jobId: string }>();
    for (const status of cases) {
      const run = createSeriesPipelineRun(database, { ...input(status), chapterBatchSize: 1, chapterConcurrency: 2 });
      database.prepare("UPDATE series_pipeline_runs SET chapter_batch_size=20 WHERE id=?").run(run.id);
      setSeriesPipelineStatus(database, run.id, "configured", "analyzing_chapters");
      const chapters = database.prepare(
        "SELECT id,content_hash FROM chapters WHERE book_id=? ORDER BY chapter_index",
      ).all(`book_${status}`) as unknown as Array<{ id: string; content_hash: string }>;
      const frozen = chapterEventsBatchAnalysisJobIdentity(`book_${status}`,
        chapters.map((chapter) => ({ chapterId: chapter.id, contentHash: chapter.content_hash })));
      createJob(database, {
        id: frozen.jobId,
        type: CHAPTER_EVENTS_ANALYZE_JOB_TYPE,
        payload: { ...frozen.identity, providerId: provider.providerId, model: provider.model, requestHash: frozen.requestHash },
        maxAttempts: 3,
      });
      for (const chapter of chapters) mapSeriesPipelineJob(database, run.id, chapter.id, frozen.jobId);
      if (status === "running") {
        database.prepare(`UPDATE jobs SET status='running',attempts=1,lease_owner='legacy-worker',lease_expires_at=?
          WHERE id=?`).run(Date.now() + 60_000, frozen.jobId);
      } else if (status !== "queued") {
        database.prepare(`UPDATE jobs SET status=?,attempts=1,error_code=?,error_message=?,finished_at=? WHERE id=?`)
          .run(status === "partial" ? "failed" : status, status === "succeeded" ? null : "legacy_failed",
            status === "succeeded" ? null : "旧多章失败", Date.now(), frozen.jobId);
      }
      const completed = status === "succeeded" ? chapters : status === "partial" ? chapters.slice(0, 1) : [];
      for (const chapter of completed) {
        database.prepare(`INSERT INTO chapter_events
          (id,chapter_id,event_index,occurrence,event_type,payload_json,created_at)
          VALUES (?,?,0,0,'revelation','{"fact":"旧版已完成"}',1)`).run(`event_${status}_${chapter.id}`, chapter.id);
        database.prepare(`INSERT INTO job_checkpoints (job_id,stage,scope_key,input_hash,completed_at)
          VALUES (?,'chapter-events-analyze',?, ?,1)`).run(frozen.jobId, chapter.id, "0".repeat(64));
      }
      fixtures.set(status, { runId: run.id, jobId: frozen.jobId });
    }
    const restored = new SeriesPipelineService({ database, dataRoot, resolveChapterTextProvider: async () => provider });

    assert.deepEqual(restored.get(fixtures.get("succeeded")!.runId)!.progress.chapterAnalysis,
      { completed: 2, total: 2, reused: 0, queued: 0, running: 0, failed: 0 });
    assert.equal(restored.get(fixtures.get("partial")!.runId)!.progress.chapterAnalysis.completed, 1);
    assert.equal(restored.get(fixtures.get("partial")!.runId)!.progress.chapterAnalysis.failed, 1);
    assert.equal(restored.get(fixtures.get("failed")!.runId)!.progress.chapterAnalysis.failed, 2);
    assert.equal(restored.get(fixtures.get("queued")!.runId)!.progress.chapterAnalysis.queued, 2);
    assert.equal(restored.get(fixtures.get("running")!.runId)!.progress.chapterAnalysis.running, 2);
    const failedView = restored.get(fixtures.get("failed")!.runId)!;
    assert.deepEqual(failedView.actions, { canPause: false, canResume: false, canCancel: true, canRetry: true });
    assert.equal(failedView.current, null);

    await restored.reconcile();
    assert.equal(restored.get(fixtures.get("succeeded")!.runId)!.status, "building_story_bible");
    const queuedLegacy = fixtures.get("queued")!;
    assert.equal(getJob(database, queuedLegacy.jobId)!.runAfter, Number.MAX_SAFE_INTEGER);
    assert.equal(restored.get(queuedLegacy.runId)!.status, "failed");
    assert.equal(restored.get(queuedLegacy.runId)!.current, null);
    assert.equal(restored.get(queuedLegacy.runId)!.progress.chapterAnalysis.queued, 0);
    assert.equal(restored.get(queuedLegacy.runId)!.actions.canPause, false);
    let legacyModelCalls = 0;
    const legacyWorker = new JobWorker(database, {
      [CHAPTER_EVENTS_ANALYZE_JOB_TYPE]: createChapterEventsAnalysisJobHandler(
        database, dataRoot, provider, async () => { legacyModelCalls += 1; return []; },
      ),
    }, { workerId: "legacy-batch-zero-cost", leaseMs: 10_000, heartbeatMs: 1_000 });
    assert.equal(await legacyWorker.runOne(), false);
    database.prepare("UPDATE jobs SET run_after=? WHERE id=?").run(Date.now(), queuedLegacy.jobId);
    assert.equal(await legacyWorker.runOne(), true);
    assert.equal(legacyModelCalls, 0);
    assert.equal(getJob(database, queuedLegacy.jobId)!.attempts, 1);
    await restored.reconcile();
    assert.equal(getJob(database, queuedLegacy.jobId)!.runAfter, Number.MAX_SAFE_INTEGER);
    assert.equal(await legacyWorker.runOne(), false);
    for (const status of cases.slice(1)) {
      const fixture = fixtures.get(status)!;
      assert.equal(getMappedChapterJobs(database, fixture.runId).length, 2);
      assert.equal(getJob(database, fixture.jobId)!.payload && typeof getJob(database, fixture.jobId)!.payload, "object");
      if (status === "queued") {
        restored.pause(fixture.runId);
        restored.resume(fixture.runId);
      } else if (status === "running") {
        restored.pause(fixture.runId);
        assert.equal(getJob(database, fixture.jobId)!.cancelRequested, true);
        database.prepare(`UPDATE jobs SET status='cancelled',lease_owner=NULL,lease_expires_at=NULL,finished_at=?
          WHERE id=?`).run(Date.now(), fixture.jobId);
        restored.resume(fixture.runId);
      } else {
        if (status === "failed") {
          assert.equal(restored.cancel(fixture.runId).status, "cancelled");
        }
        restored.retry(fixture.runId);
      }
      assert.equal(getMappedChapterJobs(database, fixture.runId).length, 0);
      assert.ok(getJob(database, fixture.jobId));
    }
    await restored.reconcile();
    assert.equal(getMappedChapterJobs(database, fixtures.get("partial")!.runId).length, 1);
    for (const status of ["failed", "queued", "running"] as const) {
      const mappings = getMappedChapterJobs(database, fixtures.get(status)!.runId);
      assert.equal(mappings.length, 2);
      assert.equal(new Set(mappings.map((mapping) => mapping.job_id)).size, 2);
      assert.ok(mappings.every((mapping) => getJob(database, mapping.job_id)!.maxAttempts === 1));
    }
  } finally { connection.close(); await rm(dataRoot, { recursive: true, force: true }); }
});

test("v2 冻结 Prompt identity 的失败 Job 按章投影真实 actions", async () => {
  const dataRoot = await mkdtemp(join(tmpdir(), "narralume-pipeline-v2-view-"));
  const connection = await seed(dataRoot, "v2_view");
  try {
    const database = connection.database;
    const service = new SeriesPipelineService({ database, dataRoot, resolveChapterTextProvider: async () => provider });
    const run = await service.create({
      ...input("v2_view"),
      episodeCount: 2,
      chapterConcurrency: 2,
      episodeRanges: [
        { episodeIndex: 1, startChapterId: "chapter_v2_view_1", endChapterId: "chapter_v2_view_1" },
        { episodeIndex: 2, startChapterId: "chapter_v2_view_2", endChapterId: "chapter_v2_view_2" },
      ],
    });
    await service.reconcile();
    const mappings = getMappedChapterJobs(database, run.id);
    assert.equal(mappings.length, 2);
    for (const mapping of mappings) {
      const job = getJob(database, mapping.job_id)!;
      const prompt = (job.payload as { prompt?: Record<string, unknown> }).prompt!;
      assert.deepEqual(Object.keys(prompt).sort(), ["instructions", "productVersion", "profileHash", "profileRevision"]);
      database.prepare(`UPDATE jobs SET status='failed',attempts=1,max_attempts=3,error_code='handler_failed',
        error_message='章节分析失败',finished_at=? WHERE id=?`).run(Date.now(), job.id);
    }
    await service.reconcile();
    const view = service.get(run.id)!;
    assert.equal(view.failureCode, "handler_failed");
    assert.deepEqual(view.progress.chapterAnalysis,
      { completed: 0, total: 2, reused: 0, queued: 0, running: 0, failed: 2 });
    assert.equal(view.current, null);
    assert.deepEqual(view.actions, { canPause: false, canResume: false, canCancel: true, canRetry: true });
    database.prepare("UPDATE series_pipeline_runs SET book_prompt_profile_hash=? WHERE id=?")
      .run("0".repeat(64), run.id);
    service.retry(run.id);
    assert.ok(mappings.every((mapping) => getJob(database, mapping.job_id)!.status === "failed"));
    database.prepare("UPDATE series_pipeline_runs SET book_prompt_profile_hash=? WHERE id=?")
      .run(run.bookPromptProfileHash, run.id);
    await service.reconcile();
    const retried = service.retry(run.id);
    assert.equal(retried.failureCode, null);
    for (const mapping of mappings) {
      const job = getJob(database, mapping.job_id)!;
      assert.equal(job.status, "queued");
      assert.equal(job.attempts, 0);
      assert.equal(job.maxAttempts, 1);
    }
    const worker = new JobWorker(database, {
      [CHAPTER_EVENTS_ANALYZE_JOB_TYPE]: createChapterEventsAnalysisJobHandler(
        database, dataRoot, provider,
        async ({ chapterId, atoms }) => [{
          type: "character", payload: { name: chapterId },
          sources: [{ byteStart: atoms[0]!.byteStart, byteEnd: atoms[0]!.byteEnd }],
        }],
      ),
    }, { workerId: "v2-view-retry", leaseMs: 10_000, heartbeatMs: 1_000 });
    assert.equal(await worker.runOne(), true);
    assert.equal(await worker.runOne(), true);
    await service.reconcile();
    assert.equal(service.get(run.id)!.status, "planning_episodes");
  } finally { connection.close(); await rm(dataRoot, { recursive: true, force: true }); }
});

test("旧 chapterBatchSize 不改变单章调度单位", async () => {
  const dataRoot = await mkdtemp(join(tmpdir(), "narralume-pipeline-dynamic-batch-"));
  const parts = Array.from({ length: 5 }, (_, index) => Buffer.from(
    Array.from({ length: 12 }, () => `${String.fromCharCode(0x7532 + index).repeat(3_000)}\n`).join(""),
    "utf8",
  ));
  const source = Buffer.concat(parts);
  const relativePath = "books/book_dynamic/source.txt";
  await mkdir(dirname(join(dataRoot, relativePath)), { recursive: true });
  await writeFile(join(dataRoot, relativePath), source);
  const connection = openDatabase(dataRoot);
  try {
    const database = connection.database;
    database.prepare(`INSERT INTO books
      (id,title,original_file_path,original_file_hash,encoding,import_status)
      VALUES ('book_dynamic','书',?,?, 'UTF-8','ready')`)
      .run(relativePath, createHash("sha256").update(source).digest("hex"));
    const insert = database.prepare(`INSERT INTO chapters
      (id,book_id,chapter_index,title,byte_start,byte_end,char_count,content_hash)
      VALUES (?,'book_dynamic',?,?,?,?,?,?)`);
    let offset = 0;
    parts.forEach((part, index) => {
      insert.run(`chapter_dynamic_${index + 1}`, index, `第${index + 1}章`, offset, offset + part.length, 36_000,
        createHash("sha256").update(part).digest("hex"));
      offset += part.length;
    });
    database.prepare("INSERT INTO series_projects (id,book_id,title,created_at,updated_at) VALUES ('series_dynamic','book_dynamic','系列',1,1)").run();
    const service = new SeriesPipelineService({ database, dataRoot, resolveChapterTextProvider: async () => provider });
    const run = await service.create({
      seriesProjectId: "series_dynamic", episodeCount: 10, targetDurationSeconds: 1200,
      sourceStartChapterId: "chapter_dynamic_1", sourceEndChapterId: "chapter_dynamic_5",
      chapterBatchSize: 1, chapterConcurrency: 1,
    });
    database.prepare("UPDATE series_pipeline_runs SET chapter_batch_size=5 WHERE id=?").run(run.id);
    await service.reconcile();
    const mappings = getMappedChapterJobs(database, run.id);
    assert.equal(mappings.length, 1);
    assert.equal(new Set(mappings.map((mapping) => mapping.job_id)).size, 1);
    assert.equal((getJob(database, mappings[0]!.job_id)!.payload as { chapterId: string }).chapterId,
      "chapter_dynamic_1");
  } finally { connection.close(); await rm(dataRoot, { recursive: true, force: true }); }
});

test("中间章节已复用时只为两侧缺失章节各建单章 Job", async () => {
  const dataRoot = await mkdtemp(join(tmpdir(), "narralume-pipeline-contiguous-gap-"));
  const connection = await seedMany(dataRoot, "gap", ["甲。", "乙。", "丙。"].map((text) => Buffer.from(text)));
  try {
    const database = connection.database;
    database.prepare(`INSERT INTO chapter_events
      (id,chapter_id,event_index,occurrence,event_type,payload_json,created_at)
      VALUES ('event_gap_middle','chapter_gap_2',0,0,'character','{"name":"乙"}',1)`).run();
    const service = new SeriesPipelineService({ database, dataRoot, resolveChapterTextProvider: async () => provider });
    const run = await service.create({
      seriesProjectId: "series_gap", episodeCount: 3, targetDurationSeconds: 1200,
      sourceStartChapterId: "chapter_gap_1", sourceEndChapterId: "chapter_gap_3",
      chapterBatchSize: 1, chapterConcurrency: 2,
    });
    await service.reconcile();
    const mappings = getMappedChapterJobs(database, run.id);
    assert.deepEqual(mappings.map((mapping) => mapping.subject_id), ["chapter_gap_1", "chapter_gap_3"]);
    assert.equal(new Set(mappings.map((mapping) => mapping.job_id)).size, 2);
  } finally { connection.close(); await rm(dataRoot, { recursive: true, force: true }); }
});

test("单章失败与 checkpoint 隔离且只由显式 retry 再次请求", async () => {
  const dataRoot = await mkdtemp(join(tmpdir(), "narralume-pipeline-checkpoint-drift-"));
  const connection = await seedMany(dataRoot, "drift", ["甲进入。", "乙进入。"].map((text) => Buffer.from(text)));
  try {
    const database = connection.database;
    const service = new SeriesPipelineService({ database, dataRoot, resolveChapterTextProvider: async () => provider });
    const run = await service.create({
      seriesProjectId: "series_drift", episodeCount: 2, targetDurationSeconds: 1200,
      sourceStartChapterId: "chapter_drift_1", sourceEndChapterId: "chapter_drift_2",
      chapterBatchSize: 1, chapterConcurrency: 2,
    });
    await service.reconcile();
    const jobs = new Map(getMappedChapterJobs(database, run.id).map((mapping) => [mapping.subject_id, mapping.job_id]));
    const calls = new Map<string, number>();
    const worker = new JobWorker(database, {
      [CHAPTER_EVENTS_ANALYZE_JOB_TYPE]: createChapterEventsAnalysisJobHandler(
        database, dataRoot, provider,
        async ({ chapterId, atoms }) => {
          const call = (calls.get(chapterId) ?? 0) + 1;
          calls.set(chapterId, call);
          return [{
            type: "character", payload: { name: `${chapterId}-${call}` },
            sources: [{ byteStart: atoms[0]!.byteStart, byteEnd: atoms[0]!.byteEnd }],
          }];
        },
      ),
    }, { workerId: "checkpoint-drift", leaseMs: 10_000, heartbeatMs: 1_000, retryDelayMs: 0 });
    database.exec(`CREATE TRIGGER fail_second_chapter BEFORE INSERT ON chapter_events
      WHEN NEW.chapter_id = 'chapter_drift_2'
      BEGIN SELECT RAISE(ABORT, '模拟第二章提交失败'); END`);
    assert.equal(await worker.runOne(), true);
    assert.equal(getJob(database, jobs.get("chapter_drift_1")!)!.status, "succeeded");
    assert.ok(database.prepare(`SELECT 1 FROM job_checkpoints
      WHERE job_id=? AND stage='chapter-events-analyze' AND scope_key='chapter_drift_1'`)
      .get(jobs.get("chapter_drift_1")!));
    assert.equal(await worker.runOne(), true);
    assert.equal(getJob(database, jobs.get("chapter_drift_2")!)!.status, "failed");
    await service.reconcile();
    const failed = service.get(run.id)!;
    assert.deepEqual(failed.progress.chapterAnalysis, {
      completed: 1, total: 2, reused: 0, queued: 0, running: 0, failed: 1,
    });
    assert.equal(failed.actions.canPause, false);
    assert.equal(failed.actions.canCancel, true);
    assert.equal(failed.actions.canRetry, true);
    assert.equal(failed.current, null);
    service.retry(run.id);
    assert.equal(getJob(database, jobs.get("chapter_drift_2")!)!.status, "queued");
    database.exec("DROP TRIGGER fail_second_chapter");
    assert.equal(await worker.runOne(), true);
    const payloads = database.prepare(
      "SELECT chapter_id,payload_json FROM chapter_events ORDER BY chapter_id",
    ).all() as unknown as Array<{ chapter_id: string; payload_json: string }>;
    assert.deepEqual(payloads.map((row) => JSON.parse(row.payload_json).name), [
      "chapter_drift_1-1", "chapter_drift_2-2",
    ]);
  } finally { connection.close(); await rm(dataRoot, { recursive: true, force: true }); }
});

test("单章失败不占滚动窗口且未映射章节继续安全补位", async () => {
  const dataRoot = await mkdtemp(join(tmpdir(), "narralume-pipeline-failed-refill-"));
  const connection = await seed(dataRoot, "failed_refill");
  try {
    const database = connection.database;
    const service = new SeriesPipelineService({ database, dataRoot, resolveChapterTextProvider: async () => provider });
    const run = await service.create({ ...input("failed_refill"), chapterConcurrency: 1 });
    await service.reconcile();
    const calls = new Map<string, number>();
    const worker = new JobWorker(database, {
      [CHAPTER_EVENTS_ANALYZE_JOB_TYPE]: createChapterEventsAnalysisJobHandler(
        database, dataRoot, provider,
        async ({ chapterId, atoms }) => {
          calls.set(chapterId, (calls.get(chapterId) ?? 0) + 1);
          if (chapterId === "chapter_failed_refill_1") throw new Error("第一章失败");
          return [{
            type: "character", payload: { name: chapterId },
            sources: [{ byteStart: atoms[0]!.byteStart, byteEnd: atoms[0]!.byteEnd }],
          }];
        },
      ),
    }, { workerId: "failed-refill", leaseMs: 10_000, heartbeatMs: 1_000 });
    assert.equal(await worker.runOne(), true);
    await service.reconcile();
    const refilling = service.get(run.id)!;
    assert.equal(refilling.status, "analyzing_chapters");
    assert.equal(refilling.progress.chapterAnalysis.failed, 1);
    assert.equal(refilling.progress.chapterAnalysis.queued, 1);
    assert.equal(refilling.actions.canPause, true);
    assert.equal(await worker.runOne(), true);
    await service.reconcile();
    const failed = service.get(run.id)!;
    assert.equal(failed.status, "failed");
    assert.equal(failed.progress.chapterAnalysis.completed, 1);
    assert.equal(failed.progress.chapterAnalysis.failed, 1);
    assert.equal(failed.current, null);
    assert.equal(failed.actions.canPause, false);
    assert.equal(calls.get("chapter_failed_refill_1"), 1);
    assert.equal(calls.get("chapter_failed_refill_2"), 1);
  } finally { connection.close(); await rm(dataRoot, { recursive: true, force: true }); }
});

test("未派发章节内容变化不影响在途单章且补位使用新身份", async () => {
  const dataRoot = await mkdtemp(join(tmpdir(), "narralume-pipeline-stale-batch-"));
  const first = Buffer.from("甲进入。", "utf8");
  const second = Buffer.from("乙进入。", "utf8");
  const connection = await seedMany(dataRoot, "stale_batch", [first, second]);
  try {
    const database = connection.database;
    const service = new SeriesPipelineService({ database, dataRoot, resolveChapterTextProvider: async () => provider });
    const run = await service.create({
      seriesProjectId: "series_stale_batch", episodeCount: 2, targetDurationSeconds: 1200,
      sourceStartChapterId: "chapter_stale_batch_1", sourceEndChapterId: "chapter_stale_batch_2",
      chapterBatchSize: 1, chapterConcurrency: 1,
    });
    await service.reconcile();
    const oldJobId = getMappedChapterJobs(database, run.id)[0]!.job_id;
    const changed = Buffer.from("丙进入。", "utf8");
    assert.equal(changed.length, second.length);
    await writeFile(join(dataRoot, "books/book_stale_batch/source.txt"), Buffer.concat([first, changed]));
    database.prepare("UPDATE chapters SET content_hash=? WHERE id='chapter_stale_batch_2'")
      .run(createHash("sha256").update(changed).digest("hex"));

    service.retry(run.id);
    await service.reconcile();
    assert.equal(getJob(database, oldJobId)!.status, "queued");
    const currentMappings = getMappedChapterJobs(database, run.id);
    assert.deepEqual(currentMappings.map((mapping) => mapping.subject_id), ["chapter_stale_batch_1"]);
    assert.equal(new Set(currentMappings.map((mapping) => mapping.job_id)).size, 1);
    const currentJobId = currentMappings[0]!.job_id;
    assert.equal(currentJobId, oldJobId);

    const worker = new JobWorker(database, {
      [CHAPTER_EVENTS_ANALYZE_JOB_TYPE]: createChapterEventsAnalysisJobHandler(
        database, dataRoot, provider,
        async ({ chapterId, atoms }) => [{
          type: "character", payload: { name: chapterId },
          sources: [{ byteStart: atoms[0]!.byteStart, byteEnd: atoms[0]!.byteEnd }],
        }],
      ),
    }, { workerId: "stale-batch", leaseMs: 10_000, heartbeatMs: 1_000 });
    assert.equal(await worker.runOne(), true);
    await service.reconcile();
    const next = getMappedChapterJobs(database, run.id).find((mapping) =>
      mapping.subject_id === "chapter_stale_batch_2")!;
    assert.notEqual(next.job_id, oldJobId);
    assert.equal(await worker.runOne(), true);
    await service.reconcile();
    assert.equal(service.get(run.id)!.status, "building_story_bible");
    assert.equal(service.get(run.id)!.progress.chapterAnalysis.completed, 2);
  } finally { connection.close(); await rm(dataRoot, { recursive: true, force: true }); }
});

test("共享单章成功后 provider 不可用不丢进度且后续补位保持原子", async () => {
  const dataRoot = await mkdtemp(join(tmpdir(), "narralume-pipeline-stale-provider-gap-"));
  const first = Buffer.from("甲发现。", "utf8");
  const second = Buffer.from("乙发现。", "utf8");
  const connection = await seedMany(dataRoot, "stale_provider", [first, second]);
  let providerAvailable = true;
  try {
    const database = connection.database;
    database.prepare("INSERT INTO series_projects (id,book_id,title,created_at,updated_at) VALUES ('series_stale_provider_other','book_stale_provider','另一系列',2,2)").run();
    const service = new SeriesPipelineService({
      database, dataRoot, resolveChapterTextProvider: async () => providerAvailable ? provider : null,
    });
    const base = {
      episodeCount: 2, targetDurationSeconds: 1200,
      sourceStartChapterId: "chapter_stale_provider_1", sourceEndChapterId: "chapter_stale_provider_2",
      chapterBatchSize: 1, chapterConcurrency: 1,
    };
    const firstRun = await service.create({ ...base, seriesProjectId: "series_stale_provider" });
    const secondRun = await service.create({ ...base, seriesProjectId: "series_stale_provider_other" });
    await service.reconcile();
    const oldJobId = getMappedChapterJobs(database, firstRun.id)[0]!.job_id;
    assert.equal(getMappedChapterJobs(database, secondRun.id)[0]!.job_id, oldJobId);
    const worker = new JobWorker(database, {
      [CHAPTER_EVENTS_ANALYZE_JOB_TYPE]: createChapterEventsAnalysisJobHandler(
        database, dataRoot, provider,
        async ({ chapterId, atoms }) => [{
          type: "character", payload: { name: chapterId },
          sources: [{ byteStart: atoms[0]!.byteStart, byteEnd: atoms[0]!.byteEnd }],
        }],
      ),
    }, { workerId: "stale-provider", leaseMs: 10_000, heartbeatMs: 1_000 });
    assert.equal(await worker.runOne(), true);
    assert.equal(getJob(database, oldJobId)!.status, "succeeded");

    const changed = Buffer.from("丙发现。", "utf8");
    assert.equal(changed.length, second.length);
    await writeFile(join(dataRoot, "books/book_stale_provider/source.txt"), Buffer.concat([first, changed]));
    database.prepare("UPDATE chapters SET content_hash=? WHERE id='chapter_stale_provider_2'")
      .run(createHash("sha256").update(changed).digest("hex"));
    providerAvailable = false;
    await service.reconcile();
    for (const run of [firstRun, secondRun]) {
      const current = service.get(run.id)!;
      assert.equal(current.status, "failed");
      assert.equal(current.failureCode, "text_provider_unavailable");
      assert.equal(current.progress.chapterAnalysis.completed, 1);
      assert.deepEqual(getMappedChapterJobs(database, run.id).map((mapping) => mapping.subject_id), [
        "chapter_stale_provider_1",
      ]);
      assert.equal(getMappedChapterJobs(database, run.id)[0]!.job_id, oldJobId);
    }
    assert.equal(getJob(database, oldJobId)!.cancelRequested, false);

    providerAvailable = true;
    service.retry(firstRun.id);
    service.retry(secondRun.id);
    database.exec(`CREATE TRIGGER fail_atomic_stale_replace BEFORE INSERT ON series_pipeline_jobs
      WHEN NEW.run_id = '${firstRun.id}' AND NEW.stage = 'chapter_analysis' AND NEW.job_id <> '${oldJobId}'
      BEGIN SELECT RAISE(ABORT, '模拟替代 mapping 写入失败'); END`);
    await service.reconcile();
    assert.equal(getMappedChapterJobs(database, firstRun.id)[0]!.job_id, oldJobId);
    database.exec("DROP TRIGGER fail_atomic_stale_replace");
    service.retry(firstRun.id);
    await service.reconcile();
    const replacementJobId = getMappedChapterJobs(database, firstRun.id).find((mapping) =>
      mapping.subject_id === "chapter_stale_provider_2")!.job_id;
    assert.notEqual(replacementJobId, oldJobId);
    assert.equal(getMappedChapterJobs(database, secondRun.id).find((mapping) =>
      mapping.subject_id === "chapter_stale_provider_2")!.job_id, replacementJobId);
    assert.equal(await worker.runOne(), true);
    await service.reconcile();
    assert.equal(service.get(firstRun.id)!.status, "building_story_bible");
    assert.equal(service.get(secondRun.id)!.status, "building_story_bible");
  } finally { connection.close(); await rm(dataRoot, { recursive: true, force: true }); }
});

test("concurrency 1 的独占 stale 单章 Job 终态前占槽且终态后才原子替换", async () => {
  const dataRoot = await mkdtemp(join(tmpdir(), "narralume-pipeline-stale-running-slot-"));
  const first = Buffer.from("甲追踪。", "utf8");
  const second = Buffer.from("乙追踪。", "utf8");
  const connection = await seedMany(dataRoot, "stale_running", [first, second]);
  try {
    const database = connection.database;
    const service = new SeriesPipelineService({ database, dataRoot, resolveChapterTextProvider: async () => provider });
    const run = await service.create({
      seriesProjectId: "series_stale_running", episodeCount: 2, targetDurationSeconds: 1200,
      sourceStartChapterId: "chapter_stale_running_1", sourceEndChapterId: "chapter_stale_running_2",
      chapterBatchSize: 1, chapterConcurrency: 1,
    });
    await service.reconcile();
    const oldJobId = getMappedChapterJobs(database, run.id)[0]!.job_id;
    let started!: () => void;
    const hasStarted = new Promise<void>((resolve) => { started = resolve; });
    const oldWorker = new JobWorker(database, {
      [CHAPTER_EVENTS_ANALYZE_JOB_TYPE]: createChapterEventsAnalysisJobHandler(
        database, dataRoot, provider,
        ({ signal }) => new Promise((_resolve, reject) => {
          started();
          signal!.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
        }),
      ),
    }, { workerId: "stale-running-old", leaseMs: 10_000, heartbeatMs: 1_000 });
    const running = oldWorker.runOne();
    await hasStarted;
    assert.equal(getJob(database, oldJobId)!.status, "running");

    const changed = Buffer.from("丙追踪。", "utf8");
    assert.equal(changed.length, second.length);
    await writeFile(join(dataRoot, "books/book_stale_running/source.txt"), Buffer.concat([changed, second]));
    database.prepare("UPDATE chapters SET content_hash=? WHERE id='chapter_stale_running_1'")
      .run(createHash("sha256").update(changed).digest("hex"));
    await service.reconcile();
    assert.equal(getMappedChapterJobs(database, run.id)[0]!.job_id, oldJobId);
    assert.equal(getJob(database, oldJobId)!.status, "running");
    assert.equal(getJob(database, oldJobId)!.cancelRequested, true);
    assert.equal(database.prepare(
      "SELECT COUNT(*) AS count FROM jobs WHERE type=? AND id<>? AND status='queued' AND run_after<=?",
    ).get(CHAPTER_EVENTS_ANALYZE_JOB_TYPE, oldJobId, Date.now())?.count, 0);
    assert.equal(service.get(run.id)!.progress.chapterAnalysis.running, 1);
    assert.equal(service.get(run.id)!.progress.chapterAnalysis.queued, 0);

    await running;
    assert.equal(getJob(database, oldJobId)!.status, "cancelled");
    await service.reconcile();
    const replacementMappings = getMappedChapterJobs(database, run.id);
    const replacementJobId = replacementMappings[0]!.job_id;
    assert.notEqual(replacementJobId, oldJobId);
    assert.equal(new Set(replacementMappings.map((mapping) => mapping.job_id)).size, 1);
    assert.notEqual(getJob(database, replacementJobId)!.runAfter, Number.MAX_SAFE_INTEGER);
    assert.equal(service.get(run.id)!.progress.chapterAnalysis.running, 0);
    assert.equal(service.get(run.id)!.progress.chapterAnalysis.queued, 1);
  } finally { connection.close(); await rm(dataRoot, { recursive: true, force: true }); }
});

test("共享 stale running 单章 Job 由其他 active owner 持有时当前 run 可替换且不误取消", async () => {
  const dataRoot = await mkdtemp(join(tmpdir(), "narralume-pipeline-shared-stale-running-"));
  const first = Buffer.from("甲守候。", "utf8");
  const second = Buffer.from("乙守候。", "utf8");
  const connection = await seedMany(dataRoot, "shared_stale", [first, second]);
  try {
    const database = connection.database;
    database.prepare("INSERT INTO series_projects (id,book_id,title,created_at,updated_at) VALUES ('series_shared_stale_other','book_shared_stale','另一系列',2,2)").run();
    const service = new SeriesPipelineService({ database, dataRoot, resolveChapterTextProvider: async () => provider });
    const base = {
      episodeCount: 2, targetDurationSeconds: 1200,
      sourceStartChapterId: "chapter_shared_stale_1", sourceEndChapterId: "chapter_shared_stale_2",
      chapterBatchSize: 1, chapterConcurrency: 1,
    };
    const currentRun = await service.create({ ...base, seriesProjectId: "series_shared_stale" });
    const ownerRun = await service.create({ ...base, seriesProjectId: "series_shared_stale_other" });
    await service.reconcile();
    const oldJobId = getMappedChapterJobs(database, currentRun.id)[0]!.job_id;
    assert.equal(getMappedChapterJobs(database, ownerRun.id)[0]!.job_id, oldJobId);
    database.prepare("UPDATE series_pipeline_runs SET status='awaiting_review' WHERE id=?").run(ownerRun.id);
    let started!: () => void;
    const hasStarted = new Promise<void>((resolve) => { started = resolve; });
    const worker = new JobWorker(database, {
      [CHAPTER_EVENTS_ANALYZE_JOB_TYPE]: createChapterEventsAnalysisJobHandler(
        database, dataRoot, provider,
        ({ signal }) => new Promise((_resolve, reject) => {
          started();
          signal!.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
        }),
      ),
    }, { workerId: "shared-stale-running", leaseMs: 10_000, heartbeatMs: 1_000 });
    const running = worker.runOne();
    await hasStarted;
    const changed = Buffer.from("丙守候。", "utf8");
    await writeFile(join(dataRoot, "books/book_shared_stale/source.txt"), Buffer.concat([changed, second]));
    database.prepare("UPDATE chapters SET content_hash=? WHERE id='chapter_shared_stale_1'")
      .run(createHash("sha256").update(changed).digest("hex"));

    await service.reconcile();
    assert.equal(getJob(database, oldJobId)!.status, "running");
    assert.equal(getJob(database, oldJobId)!.cancelRequested, false);
    assert.equal(getMappedChapterJobs(database, ownerRun.id)[0]!.job_id, oldJobId);
    assert.notEqual(getMappedChapterJobs(database, currentRun.id)[0]!.job_id, oldJobId);

    service.cancel(ownerRun.id);
    await running;
    assert.equal(getJob(database, oldJobId)!.status, "cancelled");
  } finally { connection.close(); await rm(dataRoot, { recursive: true, force: true }); }
});

test("章节协调按当前 v2 identity 原子替换旧 failed、succeeded、running 映射", async () => {
  const dataRoot = await mkdtemp(join(tmpdir(), "narralume-pipeline-stale-chapter-"));
  const connection = await seed(dataRoot, "a");
  try {
    await seed(dataRoot, "b", connection);
    await seed(dataRoot, "c", connection);
    const database = connection.database;
    const service = new SeriesPipelineService({ database, dataRoot, resolveChapterTextProvider: async () => provider });
    const cases = [
      { suffix: "a", status: "failed" },
      { suffix: "b", status: "succeeded" },
      { suffix: "c", status: "running" },
    ] as const;
    const oldJobs = new Map<string, string>();
    const statusByRun = new Map<string, typeof cases[number]["status"]>();
    for (const item of cases) {
      const run = await service.create({ ...input(item.suffix), sourceEndChapterId: `chapter_${item.suffix}_1` });
      setSeriesPipelineStatus(database, run.id, "configured", "analyzing_chapters");
      const chapter = database.prepare(
        "SELECT content_hash FROM chapters WHERE id = ?",
      ).get(`chapter_${item.suffix}_1`) as { content_hash: string };
      const oldIdentity = {
        bookId: `book_${item.suffix}`, chapterId: `chapter_${item.suffix}_1`, contentHash: chapter.content_hash,
        analysisContractVersion: "chapter-events-analysis-v1",
        promptContractVersion: "chapter-events-prompt-v1",
        parserContractVersion: "chapter-events-parser-v1",
      };
      const oldHash = createHash("sha256").update(JSON.stringify(oldIdentity)).digest("hex");
      const oldJobId = `job_chapter_analyze_${oldHash}`;
      createJob(database, {
        id: oldJobId, type: CHAPTER_EVENTS_ANALYZE_JOB_TYPE,
        payload: { ...oldIdentity, providerId: "old-provider", model: "old-model", requestHash: oldHash },
      });
      mapSeriesPipelineJob(database, run.id, `chapter_${item.suffix}_1`, oldJobId);
      if (item.status === "running") {
        database.prepare(
          "UPDATE jobs SET status='running',lease_owner='old-worker',lease_expires_at=? WHERE id=?",
        ).run(Date.now() + 60_000, oldJobId);
      } else {
        database.prepare(
          `UPDATE jobs SET status=?,error_code=?,error_message=?,finished_at=? WHERE id=?`,
        ).run(item.status, item.status === "failed" ? "old_failed" : null,
          item.status === "failed" ? "旧合同失败" : null, Date.now(), oldJobId);
      }
      if (item.status === "succeeded") {
        database.prepare(`INSERT INTO chapter_events
          (id,chapter_id,event_index,occurrence,event_type,payload_json,created_at)
          VALUES (?,?,0,0,'revelation','{"fact":"旧合同事件"}',1)`
        ).run(`event_old_${item.suffix}`, `chapter_${item.suffix}_1`);
      }
      oldJobs.set(run.id, oldJobId);
      statusByRun.set(run.id, item.status);
    }

    const failedRun = getSeriesPipelineRun(database, [...oldJobs.keys()][0]!)!;
    retrySeriesPipelineRun(database, failedRun.id);
    assert.equal(getJob(database, oldJobs.get(failedRun.id)!)!.status, "failed");

    await service.reconcile();
    for (const [runId, oldJobId] of oldJobs) {
      const mapping = getMappedChapterJobs(database, runId);
      assert.equal(mapping.length, 1);
      if (statusByRun.get(runId) === "running") {
        assert.equal(mapping[0]!.job_id, oldJobId);
        assert.equal(getJob(database, oldJobId)!.status, "running");
        assert.equal(getJob(database, oldJobId)!.cancelRequested, true);
        database.prepare(
          `UPDATE jobs SET status='cancelled',lease_owner=NULL,lease_expires_at=NULL,finished_at=? WHERE id=?`,
        ).run(Date.now(), oldJobId);
        continue;
      }
      assert.notEqual(mapping[0]!.job_id, oldJobId);
      assert.equal(getJob(database, mapping[0]!.job_id)!.status, "queued");
      assert.notEqual(getJob(database, mapping[0]!.job_id)!.runAfter, Number.MAX_SAFE_INTEGER);
    }
    await service.reconcile();
    const runningRunId = [...statusByRun].find(([, status]) => status === "running")![0];
    const runningReplacement = getMappedChapterJobs(database, runningRunId)[0]!.job_id;
    assert.notEqual(runningReplacement, oldJobs.get(runningRunId));
    assert.equal(getJob(database, runningReplacement)!.status, "queued");
    assert.notEqual(getJob(database, runningReplacement)!.runAfter, Number.MAX_SAFE_INTEGER);
    assert.equal(getJob(database, oldJobs.get([...oldJobs.keys()][0]!)!)!.status, "failed");
    assert.equal(getJob(database, oldJobs.get([...oldJobs.keys()][1]!)!)!.status, "succeeded");
    assert.equal(getJob(database, oldJobs.get([...oldJobs.keys()][2]!)!)!.status, "cancelled");
    assert.equal(service.get([...oldJobs.keys()][1]!)!.progress.chapterAnalysis.completed, 0);
  } finally { connection.close(); await rm(dataRoot, { recursive: true, force: true }); }
});

test("章节 parked Job 在 pause 或 cancel 先完成时不替换映射也不可 claim", async () => {
  const dataRoot = await mkdtemp(join(tmpdir(), "narralume-pipeline-chapter-map-race-"));
  const connection = await seed(dataRoot);
  try {
    const database = connection.database;
    for (const action of ["pause", "cancel"] as const) {
      const suffix = action === "pause" ? "pause" : "cancel";
      database.prepare(
        "INSERT INTO series_projects (id,book_id,title,created_at,updated_at) VALUES (?,?,?,?,?)",
      ).run(`series_${suffix}`, "book_a", suffix, Date.now(), Date.now());
      const run = createSeriesPipelineRun(database, {
        ...input(), seriesProjectId: `series_${suffix}`, sourceEndChapterId: "chapter_a_1",
      });
      setSeriesPipelineStatus(database, run.id, "configured", "analyzing_chapters");
      const chapter = database.prepare(
        "SELECT content_hash FROM chapters WHERE id='chapter_a_1'",
      ).get() as { content_hash: string };
      const current = chapterEventsAnalysisJobIdentity("book_a", "chapter_a_1", chapter.content_hash);
      if (!getJob(database, current.jobId)) {
        createJob(database, {
          id: current.jobId, type: CHAPTER_EVENTS_ANALYZE_JOB_TYPE,
          payload: { ...current.identity, providerId: provider.providerId, model: provider.model, requestHash: current.requestHash },
          runAfter: Number.MAX_SAFE_INTEGER,
        });
      } else {
        database.prepare("UPDATE jobs SET run_after=? WHERE id=? AND status='queued'")
          .run(Number.MAX_SAFE_INTEGER, current.jobId);
      }
      action === "pause" ? pauseSeriesPipelineRun(database, run.id) : cancelSeriesPipelineRun(database, run.id);
      assert.equal(mapSeriesPipelineJob(database, run.id, "chapter_a_1", current.jobId), false);
      assert.deepEqual(getMappedChapterJobs(database, run.id), []);
      assert.equal(getJob(database, current.jobId)!.runAfter, Number.MAX_SAFE_INTEGER);
    }
  } finally { connection.close(); await rm(dataRoot, { recursive: true, force: true }); }
});

test("空章节分析结果不计完成并投影 failed 可重试", async () => {
  const dataRoot = await mkdtemp(join(tmpdir(), "narralume-pipeline-empty-"));
  const connection = await seed(dataRoot);
  try {
    const database = connection.database;
    const service = new SeriesPipelineService({ database, dataRoot, resolveChapterTextProvider: async () => provider });
    const created = await service.create({
      ...input(), sourceEndChapterId: "chapter_a_1",
    });
    await service.reconcile();
    const worker = new JobWorker(database, {
      [CHAPTER_EVENTS_ANALYZE_JOB_TYPE]: createChapterEventsAnalysisJobHandler(
        database, dataRoot, provider, async () => [],
      ),
    }, { workerId: "pipeline-empty", leaseMs: 10_000, heartbeatMs: 1_000, retryDelayMs: 0 });
    await worker.runOne(); await worker.runOne(); await worker.runOne();
    await service.reconcile();
    const failed = service.get(created.id)!;
    assert.equal(failed.status, "failed");
    assert.equal(failed.progress.chapterAnalysis.completed, 0);
    assert.equal(failed.progress.chapterAnalysis.failed, 1);
    assert.equal(failed.failures[0]!.code, "handler_failed");
    assert.equal(service.retry(created.id).progress.chapterAnalysis.queued, 1);
  } finally { connection.close(); await rm(dataRoot, { recursive: true, force: true }); }
});

test("独占任务取消后显示已中断并可重试，重启协调后完成章节分析", async () => {
  const dataRoot = await mkdtemp(join(tmpdir(), "narralume-pipeline-cancel-retry-"));
  let connection = await seed(dataRoot);
  try {
    let database = connection.database;
    let service = new SeriesPipelineService({ database, dataRoot, resolveChapterTextProvider: async () => provider });
    const created = await service.create({ ...input(), sourceEndChapterId: "chapter_a_1" });
    await service.reconcile();
    const jobId = getMappedChapterJobs(database, created.id)[0]!.job_id;

    service.pause(created.id);
    assert.throws(
      () => assertSeriesPipelineAllowsChapterEventMutation(database, "book_a", "chapter_a_1"),
      (error: unknown) => error instanceof SeriesPipelineError && error.statusCode === 409,
    );
    service.resume(created.id);
    const cancelled = service.cancel(created.id);
    assert.equal(database.prepare("SELECT status FROM jobs WHERE id=?").get(jobId)?.status, "cancelled");
    assert.equal(cancelled.failures[0]!.message, "章节分析已中断，请重试该章节");
    assert.equal(cancelled.failures[0]!.canRetry, true);
    assert.equal(cancelled.actions.canRetry, true);
    assert.doesNotThrow(() => assertSeriesPipelineAllowsChapterEventMutation(database, "book_a", "chapter_a_1"));

    const retried = service.retry(created.id);
    assert.equal(retried.status, "analyzing_chapters");
    assert.equal(retried.progress.chapterAnalysis.queued, 1);
    const reset = database.prepare(
      "SELECT status,cancel_requested,finished_at,lease_owner,lease_expires_at,error_code,error_message FROM jobs WHERE id=?",
    ).get(jobId) as Record<string, unknown>;
    assert.deepEqual({ ...reset }, {
      status: "queued", cancel_requested: 0, finished_at: null, lease_owner: null,
      lease_expires_at: null, error_code: null, error_message: null,
    });

    const worker = new JobWorker(database, {
      [CHAPTER_EVENTS_ANALYZE_JOB_TYPE]: createChapterEventsAnalysisJobHandler(
        database, dataRoot, provider, async ({ chapterId, atoms }) => [{
          type: "character",
          payload: { name: chapterId },
          sources: [{ byteStart: atoms[0]!.byteStart, byteEnd: atoms[0]!.byteEnd }],
        }],
      ),
    }, { workerId: "pipeline-cancel-retry", leaseMs: 10_000, heartbeatMs: 1_000 });
    assert.equal(await worker.runOne(), true);
    connection.close();
    connection = openDatabase(dataRoot);
    database = connection.database;
    service = new SeriesPipelineService({ database, dataRoot, resolveChapterTextProvider: async () => provider });
    await service.reconcile();
    assert.equal(service.get(created.id)!.status, "building_story_bible");
  } finally { connection.close(); await rm(dataRoot, { recursive: true, force: true }); }
});

test("同书不同系列共享确定性 Job 时暂停取消互不改写 Job，retry 复用共享失败 Job", async () => {
  const dataRoot = await mkdtemp(join(tmpdir(), "narralume-pipeline-shared-job-"));
  const connection = await seed(dataRoot);
  try {
    const database = connection.database;
    database.prepare("INSERT INTO series_projects (id,book_id,title,created_at,updated_at) VALUES ('series_other','book_a','另一系列',2,2)").run();
    const service = new SeriesPipelineService({ database, dataRoot, resolveChapterTextProvider: async () => provider });
    const first = await service.create({ ...input(), sourceEndChapterId: "chapter_a_1" });
    const second = await service.create({ ...input(), seriesProjectId: "series_other", sourceEndChapterId: "chapter_a_1" });
    await service.reconcile();
    const firstJob = getMappedChapterJobs(database, first.id)[0]!.job_id;
    const secondJob = getMappedChapterJobs(database, second.id)[0]!.job_id;
    assert.equal(firstJob, secondJob);
    const snapshot = database.prepare(
      "SELECT status,run_after,max_attempts,cancel_requested FROM jobs WHERE id=?",
    ).get(firstJob);
    service.pause(first.id);
    assert.deepEqual(database.prepare(
      "SELECT status,run_after,max_attempts,cancel_requested FROM jobs WHERE id=?",
    ).get(firstJob), snapshot);
    service.cancel(first.id);
    assert.deepEqual(database.prepare(
      "SELECT status,run_after,max_attempts,cancel_requested FROM jobs WHERE id=?",
    ).get(firstJob), snapshot);
    database.prepare(
      "UPDATE jobs SET status='running',lease_owner='shared-worker',lease_expires_at=9999999999999 WHERE id=?",
    ).run(firstJob);
    service.pause(second.id);
    assert.throws(
      () => assertSeriesPipelineAllowsChapterEventMutation(database, "book_a", "chapter_a_1"),
      (error: unknown) => error instanceof SeriesPipelineError && error.statusCode === 409,
    );
    database.prepare(
      `UPDATE jobs SET status='failed',lease_owner=NULL,lease_expires_at=NULL,
       error_code='handler_failed',error_message='共享失败',finished_at=2 WHERE id=?`,
    ).run(firstJob);
    assert.doesNotThrow(() => assertSeriesPipelineAllowsChapterEventMutation(database, "book_a", "chapter_a_1"));
    service.retry(second.id);
    assert.throws(
      () => assertSeriesPipelineAllowsChapterEventMutation(database, "book_a", "chapter_a_1"),
      (error: unknown) => error instanceof SeriesPipelineError && error.statusCode === 409,
    );
    assert.equal(database.prepare("SELECT status FROM jobs WHERE id=?").get(firstJob)?.status, "queued");
    assert.equal(service.get(first.id)!.status, "cancelled");
    assert.equal(service.get(second.id)!.progress.chapterAnalysis.queued, 0);
  } finally { connection.close(); await rm(dataRoot, { recursive: true, force: true }); }
});

test("active run 后映射已暂停排队的共享 Job 时在同一控制顺序中唤醒", async () => {
  const dataRoot = await mkdtemp(join(tmpdir(), "narralume-pipeline-map-wake-"));
  const connection = await seed(dataRoot);
  try {
    const database = connection.database;
    database.prepare(
      "INSERT INTO series_projects (id,book_id,title,created_at,updated_at) VALUES ('series_other','book_a','另一系列',2,2)",
    ).run();
    const service = new SeriesPipelineService({ database, dataRoot, resolveChapterTextProvider: async () => provider });
    const pausedOwner = await service.create({ ...input(), sourceEndChapterId: "chapter_a_1" });
    await service.reconcile();
    const jobId = getMappedChapterJobs(database, pausedOwner.id)[0]!.job_id;
    service.pause(pausedOwner.id);
    assert.equal(database.prepare("SELECT run_after FROM jobs WHERE id=?").get(jobId)?.run_after, Number.MAX_SAFE_INTEGER);

    const activeOwner = await service.create({
      ...input(), seriesProjectId: "series_other", sourceEndChapterId: "chapter_a_1",
    });
    const beforeMap = Date.now();
    await service.reconcile();
    assert.equal(getMappedChapterJobs(database, activeOwner.id)[0]!.job_id, jobId);
    const awakened = database.prepare("SELECT status,run_after FROM jobs WHERE id=?").get(jobId) as {
      status: string; run_after: number;
    };
    assert.equal(awakened.status, "queued");
    assert.notEqual(awakened.run_after, Number.MAX_SAFE_INTEGER);
    assert.equal(awakened.run_after >= beforeMap && awakened.run_after <= Date.now(), true);
  } finally { connection.close(); await rm(dataRoot, { recursive: true, force: true }); }
});

test("paused retry 仅在存在其他 active owner 时允许 Worker claim", async () => {
  const dataRoot = await mkdtemp(join(tmpdir(), "narralume-pipeline-retry-ownership-"));
  const connection = await seed(dataRoot);
  try {
    const database = connection.database;
    database.prepare(
      "INSERT INTO series_projects (id,book_id,title,created_at,updated_at) VALUES ('series_other','book_a','另一系列',2,2)",
    ).run();
    const service = new SeriesPipelineService({ database, dataRoot, resolveChapterTextProvider: async () => provider });
    const first = await service.create({ ...input(), sourceEndChapterId: "chapter_a_1" });
    await service.reconcile();
    const jobId = getMappedChapterJobs(database, first.id)[0]!.job_id;
    database.prepare(
      "UPDATE jobs SET status='failed',error_code='test_failed',error_message='测试失败',finished_at=? WHERE id=?",
    ).run(Date.now(), jobId);
    service.pause(first.id);
    service.retry(first.id);
    assert.equal(database.prepare("SELECT run_after FROM jobs WHERE id=?").get(jobId)?.run_after, Number.MAX_SAFE_INTEGER);

    const worker = new JobWorker(database, {
      [CHAPTER_EVENTS_ANALYZE_JOB_TYPE]: createChapterEventsAnalysisJobHandler(
        database, dataRoot, provider, async ({ chapterId, atoms }) => [{
          type: "character",
          payload: { name: chapterId },
          sources: [{ byteStart: atoms[0]!.byteStart, byteEnd: atoms[0]!.byteEnd }],
        }],
      ),
    }, { workerId: "pipeline-retry-ownership", leaseMs: 10_000, heartbeatMs: 1_000 });
    assert.equal(await worker.runOne(), false);

    database.prepare(
      `UPDATE jobs SET status='failed',run_after=?,error_code='test_failed',error_message='再次失败',finished_at=?
       WHERE id=?`,
    ).run(Date.now(), Date.now(), jobId);
    const second = await service.create({
      ...input(), seriesProjectId: "series_other", sourceEndChapterId: "chapter_a_1",
    });
    await service.reconcile();
    assert.equal(getMappedChapterJobs(database, second.id)[0]!.job_id, jobId);
    service.retry(first.id);
    assert.notEqual(database.prepare("SELECT run_after FROM jobs WHERE id=?").get(jobId)?.run_after, Number.MAX_SAFE_INTEGER);
    assert.equal(await worker.runOne(), true);
  } finally { connection.close(); await rm(dataRoot, { recursive: true, force: true }); }
});

test("pause 和 cancel 任一 mapped Job 控制失败时完整回滚 run 与先前 Job", async () => {
  const dataRoot = await mkdtemp(join(tmpdir(), "narralume-pipeline-control-rollback-"));
  const connection = await seed(dataRoot);
  try {
    const database = connection.database;
    const service = new SeriesPipelineService({ database, dataRoot, resolveChapterTextProvider: async () => provider });
    const created = await service.create({ ...input(), chapterBatchSize: 1, chapterConcurrency: 2 });
    await service.reconcile();
    const mappedJobIds = [...new Set(getMappedChapterJobs(database, created.id).map((mapping) => mapping.job_id))];
    assert.equal(mappedJobIds.length, 2);
    const [firstJobId, secondJobId] = mappedJobIds as [string, string];

    database.exec(
      `CREATE TRIGGER fail_second_job_pause BEFORE UPDATE OF run_after ON jobs
       WHEN OLD.id = '${secondJobId}' AND NEW.run_after = ${Number.MAX_SAFE_INTEGER}
       BEGIN SELECT RAISE(ABORT, '模拟第二个 Job 暂停失败'); END`,
    );
    assert.throws(() => service.pause(created.id), /模拟第二个 Job 暂停失败/);
    assert.equal(getSeriesPipelineRun(database, created.id)!.status, "analyzing_chapters");
    assert.notEqual(database.prepare("SELECT run_after FROM jobs WHERE id=?").get(firstJobId)?.run_after, Number.MAX_SAFE_INTEGER);
    assert.notEqual(database.prepare("SELECT run_after FROM jobs WHERE id=?").get(secondJobId)?.run_after, Number.MAX_SAFE_INTEGER);
    database.exec("DROP TRIGGER fail_second_job_pause");

    database.exec(
      `CREATE TRIGGER fail_second_job_cancel BEFORE UPDATE OF status ON jobs
       WHEN OLD.id = '${secondJobId}' AND NEW.status = 'cancelled'
       BEGIN SELECT RAISE(ABORT, '模拟第二个 Job 取消失败'); END`,
    );
    assert.throws(() => service.cancel(created.id), /模拟第二个 Job 取消失败/);
    assert.equal(getSeriesPipelineRun(database, created.id)!.status, "analyzing_chapters");
    for (const jobId of [firstJobId, secondJobId]) {
      const job = database.prepare("SELECT status,cancel_requested FROM jobs WHERE id=?").get(jobId) as {
        status: string; cancel_requested: number;
      };
      assert.deepEqual({ ...job }, { status: "queued", cancel_requested: 0 });
    }
  } finally { connection.close(); await rm(dataRoot, { recursive: true, force: true }); }
});

test("脚本阶段严格串行消费上一集交接，失败局部重试且暂停重启不越序", async () => {
  const dataRoot = await mkdtemp(join(tmpdir(), "narralume-pipeline-scripts-"));
  let connection = await seed(dataRoot);
  let failSecond = true;
  try {
    let database = connection.database;
    database.prepare(`INSERT INTO chapter_events
      (id,chapter_id,event_index,occurrence,event_type,payload_json,created_at)
      VALUES ('event_script','chapter_a_1',0,0,'revelation','{"fact":"入口"}',1)`).run();
    for (const index of [1, 2, 3]) {
      database.prepare(`INSERT INTO episodes
        (id,series_project_id,episode_index,title,story_arc,target_duration_seconds,recap,next_hook,created_at,updated_at)
        VALUES (?,?,?,?,?,?,?,?,1,1)`).run(
        `episode_${index}`, "series_a", index, `第${index}集`, `故事弧${index}`, 1200,
        index === 1 ? null : "承接上集", `钩子${index}`,
      );
      const chapter = database.prepare(
        "SELECT byte_start,byte_end,content_hash FROM chapters WHERE id='chapter_a_1'",
      ).get() as { byte_start: number; byte_end: number; content_hash: string };
      database.prepare(`INSERT INTO episode_sources
        (episode_id,source_index,chapter_id,source_event_id,source_byte_start,source_byte_end,source_hash)
        VALUES (?,0,'chapter_a_1','event_script',?,?,?)`).run(
        `episode_${index}`, chapter.byte_start, chapter.byte_end, chapter.content_hash,
      );
    }
    const run = createSeriesPipelineRun(database, { ...input(), episodeCount: 3 });
    setSeriesPipelineStatus(database, run.id, "configured", "generating_scripts");
    const legacy = createJob(database, {
      id: "job_episode_scripts_legacy_v2",
      type: EPISODE_SCRIPT_GENERATION_JOB_TYPE,
      payload: { contractVersion: 2, seriesId: "series_a", episodeIndex: 1 },
      maxAttempts: 1,
    });
    database.prepare(
      "UPDATE jobs SET status = 'succeeded', progress = 1, result_json = '{}', finished_at = 1, updated_at = 1 WHERE id = ?",
    ).run(legacy.id);
    mapSeriesPipelineScriptJob(database, run.id, "episode_1", legacy.id);
    let service = new SeriesPipelineService({ database, dataRoot, resolveChapterTextProvider: async () => provider });
    const seenHandoffs: Array<{ episodeId: string; handoff: unknown }> = [];
    let generatingEpisodeId = "";
    const generate: GenerateEpisodeScript = async (stage) => {
      if (stage.stage === "skeleton") {
        generatingEpisodeId = stage.episode.id;
        seenHandoffs.push({ episodeId: stage.episode.id, handoff: stage.previousScriptHandoff });
        return { beats: [{ intent: stage.episode.storyArc, sourceIndexes: [0] }] };
      }
      if (stage.stage === "faithful") return { text: textForBudget(stage.characterBudget, stage.sources[0]!.sourceText) };
      if (failSecond && generatingEpisodeId === "episode_2") throw new Error("第二集暂时失败");
      return { paragraphs: stage.paragraphs.map((paragraph, index) => ({
        ...paragraph,
        text: index === 0 ? `旁${[...paragraph.text].slice(1).join("")}` : paragraph.text,
      })) };
    };
    let worker = new JobWorker(database, {
      [EPISODE_SCRIPT_GENERATION_JOB_TYPE]: createEpisodeScriptGenerationJobHandler(
        database, dataRoot, provider, generate,
      ),
    }, { workerId: "pipeline-scripts", leaseMs: 10_000, heartbeatMs: 1_000, retryDelayMs: 0 });

    await service.reconcile();
    assert.deepEqual(getMappedScriptJobs(database, run.id).map((item) => item.subject_id), ["episode_1"]);
    assert.notEqual(getMappedScriptJobs(database, run.id)[0]!.job_id, legacy.id);
    assert.equal(await worker.runOne(), true);
    await service.reconcile();
    assert.deepEqual(getMappedScriptJobs(database, run.id).map((item) => item.subject_id), ["episode_1", "episode_2"]);
    const secondJobId = getMappedScriptJobs(database, run.id)[1]!.job_id;
    const secondPayload = getJob(database, secondJobId)!.payload as { previousScriptHandoff?: unknown };
    assert.deepEqual(secondPayload.previousScriptHandoff, {
      summary: "故事弧1", continuityNotes: ["钩子1", "故事弧1"],
    });
    service.pause(run.id);
    assert.equal(await worker.runOne(), false);
    assert.equal(getMappedScriptJobs(database, run.id).length, 2);
    service.resume(run.id);
    const mappedBeforeCancel = getMappedScriptJobs(database, run.id);
    assert.equal(service.cancel(run.id).status, "cancelled");
    assert.equal(service.retry(run.id).status, "generating_scripts");
    assert.deepEqual(getMappedScriptJobs(database, run.id), mappedBeforeCancel);

    connection.close();
    connection = openDatabase(dataRoot);
    database = connection.database;
    service = new SeriesPipelineService({ database, dataRoot, resolveChapterTextProvider: async () => provider });
    await service.reconcile();
    assert.deepEqual(getMappedScriptJobs(database, run.id), mappedBeforeCancel);
    worker = new JobWorker(database, {
      [EPISODE_SCRIPT_GENERATION_JOB_TYPE]: createEpisodeScriptGenerationJobHandler(
        database, dataRoot, provider, generate,
      ),
    }, { workerId: "pipeline-scripts-restarted", leaseMs: 10_000, heartbeatMs: 1_000, retryDelayMs: 0 });
    await worker.runOne(); await worker.runOne(); await worker.runOne();
    await service.reconcile();
    assert.equal(service.get(run.id)!.progress.scripts.completed, 2);
    assert.equal(service.get(run.id)!.failures[0]!.subjectId, "episode_2");
    assert.deepEqual(getMappedScriptJobs(database, run.id).map((item) => item.subject_id), ["episode_1", "episode_2"]);
    assert.deepEqual(database.prepare(
      "SELECT episode_id,kind FROM script_versions ORDER BY episode_id,kind",
    ).all().map((row) => ({ ...row })), [
      { episode_id: "episode_1", kind: "faithful" },
      { episode_id: "episode_1", kind: "packaged" },
    ]);
    service.retry(run.id);
    failSecond = false;
    assert.equal(await worker.runOne(), true);
    await service.reconcile();
    assert.deepEqual(getMappedScriptJobs(database, run.id).map((item) => item.subject_id), [
      "episode_1", "episode_2", "episode_3",
    ]);
    const thirdJobId = getMappedScriptJobs(database, run.id)[2]!.job_id;
    const thirdPayload = getJob(database, thirdJobId)!.payload as { previousScriptHandoff?: unknown };
    assert.deepEqual(thirdPayload.previousScriptHandoff, {
      summary: "故事弧2", continuityNotes: ["钩子2", "故事弧2"],
    });
    assert.equal(await worker.runOne(), true);

    connection.close();
    connection = openDatabase(dataRoot);
    database = connection.database;
    service = new SeriesPipelineService({ database, dataRoot, resolveChapterTextProvider: async () => provider });
    await service.reconcile();
    assert.equal(service.get(run.id)!.status, "checking_coverage");
    assert.deepEqual(service.get(run.id)!.progress.scripts, { completed: 6, total: 6 });
    assert.deepEqual(seenHandoffs.find((item) => item.episodeId === "episode_1")?.handoff, null);
    assert.deepEqual(seenHandoffs.find((item) => item.episodeId === "episode_2")?.handoff,
      secondPayload.previousScriptHandoff);
    assert.deepEqual(seenHandoffs.find((item) => item.episodeId === "episode_3")?.handoff,
      thirdPayload.previousScriptHandoff);
    assert.deepEqual(database.prepare(
      `SELECT episode_id,kind,COUNT(*) AS total FROM script_versions
       GROUP BY episode_id,kind ORDER BY episode_id,kind`,
    ).all().map((row) => ({ ...row })), [
      { episode_id: "episode_1", kind: "faithful", total: 1 },
      { episode_id: "episode_1", kind: "packaged", total: 1 },
      { episode_id: "episode_2", kind: "faithful", total: 1 },
      { episode_id: "episode_2", kind: "packaged", total: 1 },
      { episode_id: "episode_3", kind: "faithful", total: 1 },
      { episode_id: "episode_3", kind: "packaged", total: 1 },
    ]);
    assert.equal(database.prepare("SELECT COUNT(*) AS total FROM script_approval_events").get()?.total, 0);
  } finally { connection.close(); await rm(dataRoot, { recursive: true, force: true }); }
});

test("故事圣经按事件 identity 复用模型切换，失败局部重试并在暂停重启后持久进入规划", async () => {
  const dataRoot = await mkdtemp(join(tmpdir(), "narralume-pipeline-bible-"));
  let connection = await seed(dataRoot);
  try {
    let database = connection.database;
    for (const index of [1, 2]) database.prepare(`INSERT INTO chapter_events
      (id,chapter_id,event_index,occurrence,event_type,payload_json,created_at)
      VALUES (?,?,?,?,?,?,1)`).run(
      `event_bible_${index}`, `chapter_a_${index}`, 0, 0, "revelation", JSON.stringify({ summary: `事件${index}` }),
    );
    const run = createSeriesPipelineRun(database, input());
    setSeriesPipelineStatus(database, run.id, "configured", "building_story_bible");
    let service = new SeriesPipelineService({ database, dataRoot, resolveChapterTextProvider: async () => provider });
    await service.reconcile();
    const mapping = getMappedStoryBibleJob(database, run.id)!;
    const firstJob = getJob(database, mapping.job_id)!;
    assert.equal(firstJob.type, BOOK_STORY_BIBLE_JOB_TYPE);
    assert.equal((firstJob.payload as { providerId: string }).providerId, provider.providerId);
    const storyStepTotal = (firstJob.payload as { intervals: unknown[] }).intervals.length + 1;
    database.prepare(`INSERT INTO job_checkpoints (job_id,stage,scope_key,input_hash,completed_at)
      VALUES (?,?,?,?,?)`).run(firstJob.id, "book-story-bible-interval", "1".repeat(64), "1".repeat(64), Date.now());
    assert.deepEqual(service.get(run.id)!.progress.storyBible.steps, { completed: 1, total: storyStepTotal });

    const switched = { ...provider, providerId: "provider-switched", model: "model-switched" };
    service = new SeriesPipelineService({ database, dataRoot, resolveChapterTextProvider: async () => switched });
    await service.reconcile();
    assert.equal(getMappedStoryBibleJob(database, run.id)!.job_id, mapping.job_id);

    service.pause(run.id);
    database.prepare("UPDATE chapter_events SET payload_json=? WHERE id='event_bible_1'")
      .run(JSON.stringify({ summary: "暂停后修正的事件" }));
    database.prepare(
      "UPDATE jobs SET status='succeeded',result_json=?,progress=1,finished_at=? WHERE id=?",
    ).run(JSON.stringify({ storyBibleId: "stale_bible" }), Date.now(), mapping.job_id);
    connection.close();
    connection = openDatabase(dataRoot);
    database = connection.database;
    service = new SeriesPipelineService({ database, dataRoot, resolveChapterTextProvider: async () => provider });
    assert.equal(service.resume(run.id).status, "building_story_bible");
    await service.reconcile();
    const remapped = getMappedStoryBibleJob(database, run.id)!;
    assert.notEqual(remapped.job_id, mapping.job_id);
    assert.equal(service.get(run.id)!.status, "building_story_bible");
    assert.equal(getJob(database, mapping.job_id)!.status, "succeeded");
    assert.equal(getJob(database, mapping.job_id)!.runAfter, Number.MAX_SAFE_INTEGER);
    assert.equal(database.prepare(
      "SELECT COUNT(*) AS total FROM series_pipeline_jobs WHERE run_id=? AND stage='story_bible'",
    ).get(run.id)?.total, 1);
    database.prepare(
      "UPDATE jobs SET status='failed',error_code='temporary',error_message='临时失败',finished_at=? WHERE id=?",
    ).run(Date.now(), remapped.job_id);
    await service.reconcile();
    assert.equal(service.get(run.id)!.failures[0]!.stage, "story_bible");
    assert.equal(service.get(run.id)!.failures[0]!.message, "临时失败");
    assert.equal(service.retry(run.id).status, "building_story_bible");

    const content = (sourceEventId: string, chapterId: string) => ({
      characters: [], relationships: [], locations: [], organizations: [], items: [], concepts: [],
      timeline: [{ summary: "已验证事件", chapterIds: [chapterId], sourceEventIds: [sourceEventId] }],
      flashbacks: [], plotThreads: [], confusingFacts: [], spoilerRestrictions: [], properNouns: [],
    });
    let call = 0;
    const responses = [content("event_bible_1", "chapter_a_1"), content("event_bible_1", "chapter_a_1")];
    const fetchImpl = (async () => new Response(JSON.stringify({
      output_text: JSON.stringify(responses[call++]),
    }), { status: 200, headers: { "content-type": "application/json" } })) as typeof fetch;
    const worker = new JobWorker(database, {
      [BOOK_STORY_BIBLE_JOB_TYPE]: createBookStoryBibleJobHandler(database, provider, { fetchImpl }),
    }, { workerId: "pipeline-bible", leaseMs: 10_000, heartbeatMs: 1_000, retryDelayMs: 0 });
    assert.equal(await worker.runOne(), true);
    await service.reconcile();
    const completed = service.get(run.id)!;
    assert.equal(completed.status, "planning_episodes");
    assert.match(completed.storyBibleId!, /^bible_/);
    assert.equal(completed.progress.storyBible.completed, 1);
    assert.equal(database.prepare("SELECT scope FROM book_story_bibles WHERE id=?")
      .get(completed.storyBibleId)?.scope, "final");
    assert.equal(getMappedStoryBibleJob(database, run.id)!.job_id, remapped.job_id);
  } finally { connection.close(); await rm(dataRoot, { recursive: true, force: true }); }
});

test("Story Bible parked Job 在 pause 或 cancel 先完成时不会映射或被 Worker claim", async () => {
  const dataRoot = await mkdtemp(join(tmpdir(), "narralume-pipeline-bible-race-"));
  const connection = await seed(dataRoot);
  try {
    const database = connection.database;
    const run = createSeriesPipelineRun(database, input());
    setSeriesPipelineStatus(database, run.id, "configured", "building_story_bible");
    const job = createJob(database, {
      id: "job_story_bible_parked", type: BOOK_STORY_BIBLE_JOB_TYPE, payload: {},
      runAfter: Number.MAX_SAFE_INTEGER,
    });
    pauseSeriesPipelineRun(database, run.id);
    assert.equal(mapSeriesPipelineStoryBibleJob(database, run.id, "1".repeat(64), job.id), false);
    assert.equal(getMappedStoryBibleJob(database, run.id), undefined);
    const worker = new JobWorker(database, {
      [BOOK_STORY_BIBLE_JOB_TYPE]: async () => ({ storyBibleId: "should_not_run" }),
    }, { workerId: "pipeline-bible-race", leaseMs: 10_000, heartbeatMs: 1_000 });
    assert.equal(await worker.runOne(), false);
    resumeSeriesPipelineRun(database, run.id);
    cancelSeriesPipelineRun(database, run.id);
    assert.equal(mapSeriesPipelineStoryBibleJob(database, run.id, "1".repeat(64), job.id), false);
    assert.equal(getJob(database, job.id)!.runAfter, Number.MAX_SAFE_INTEGER);
  } finally { connection.close(); await rm(dataRoot, { recursive: true, force: true }); }
});

test("全书规划以当前 identity parked 映射，旧结果不推进并原子冻结恰好 N 集", async () => {
  const dataRoot = await mkdtemp(join(tmpdir(), "narralume-pipeline-plan-"));
  const connection = await seed(dataRoot);
  try {
    const database = connection.database;
    for (const index of [1, 2]) {
      const eventId = `event_plan_${index}`;
      const start = index === 1 ? 0 : Buffer.byteLength("a甲在庭院出现。", "utf8");
      const end = start + 3;
      database.prepare(`INSERT INTO chapter_events
        (id,chapter_id,event_index,occurrence,event_type,payload_json,created_at)
        VALUES (?,?,?,?,?,?,1)`).run(
        eventId, `chapter_a_${index}`, 0, 0, "revelation", JSON.stringify({ summary: `事件${index}` }),
      );
      database.prepare(`INSERT INTO chapter_event_sources
        (event_id,source_index,source_byte_start,source_byte_end,source_hash) VALUES (?,0,?,?,?)`)
        .run(eventId, start, end, String(index).repeat(64));
    }
    const bibleContent = {
      characters: [], relationships: [], locations: [], organizations: [], items: [], concepts: [],
      timeline: [
        { summary: "事件1", chapterIds: ["chapter_a_1"], sourceEventIds: ["event_plan_1"] },
        { summary: "事件2", chapterIds: ["chapter_a_2"], sourceEventIds: ["event_plan_2"] },
      ],
      flashbacks: [], plotThreads: [], confusingFacts: [], spoilerRestrictions: [], properNouns: [],
    };
    const bible = createBookStoryBible(database, {
      bookId: "book_a", scope: "final", sourceStartChapterId: "chapter_a_1",
      sourceEndChapterId: "chapter_a_2", sourceEventIds: ["event_plan_1", "event_plan_2"],
      parentBibleIds: [], providerId: provider.providerId, model: provider.model, content: bibleContent,
    });
    const run = createSeriesPipelineRun(database, { ...input(), episodeCount: 2, targetDurationSeconds: 240 });
    setSeriesPipelineStatus(database, run.id, "configured", "building_story_bible");
    database.prepare(
      "UPDATE series_pipeline_runs SET status='planning_episodes',story_bible_id=? WHERE id=?",
    ).run(bible.id, run.id);
    setSeriesPipelineFailure(database, run.id, "pipeline_reconcile_failed", "旧协调错误");
    const service = new SeriesPipelineService({ database, dataRoot, resolveChapterTextProvider: async () => provider });
    await service.reconcile();
    const first = getMappedEpisodePlanJob(database, run.id)!;
    assert.equal(getJob(database, first.job_id)!.type, FULL_BOOK_PLAN_JOB_TYPE);
    assert.notEqual(getJob(database, first.job_id)!.runAfter, Number.MAX_SAFE_INTEGER);
    assert.equal(service.get(run.id)!.failureMessage, null);
    database.prepare("UPDATE jobs SET progress=0.25,attempts=1 WHERE id=?").run(first.job_id);
    const projected = service.get(run.id)!.current!;
    assert.equal(projected.jobStatus, "queued");
    assert.equal(projected.jobProgress, 0.25);
    assert.equal(projected.jobAttempts, 1);
    assert.equal(projected.jobMaxAttempts, 3);
    assert.equal(service.cancel(run.id).status, "cancelled");
    assert.equal(getJob(database, first.job_id)!.status, "cancelled");
    assert.equal(service.retry(run.id).status, "planning_episodes");
    assert.equal(getJob(database, first.job_id)!.status, "queued");

    service.pause(run.id);
    database.prepare("UPDATE chapter_events SET payload_json=? WHERE id='event_plan_1'")
      .run(JSON.stringify({ summary: "暂停后修正" }));
    const stalePlan = { episodes: [
      { index: 1, title: "旧一", storyArc: "旧", sourceEventIds: ["event_plan_1"], recap: null, nextHook: "旧" },
      { index: 2, title: "旧二", storyArc: "旧", sourceEventIds: ["event_plan_2"], recap: "旧", nextHook: null },
    ] };
    const staleHash = createHash("sha256").update(canonicalFullBookPlanJson(stalePlan)).digest("hex");
    database.prepare("UPDATE jobs SET status='succeeded',result_json=?,progress=1,finished_at=? WHERE id=?")
      .run(JSON.stringify({ plan: stalePlan, planHash: staleHash }), Date.now(), first.job_id);
    service.resume(run.id);
    await service.reconcile();
    const current = getMappedEpisodePlanJob(database, run.id)!;
    assert.notEqual(current.job_id, first.job_id);
    assert.equal(database.prepare("SELECT COUNT(*) AS total FROM episodes").get()!.total, 0);

    const plan = { episodes: [
      { index: 1, title: "第一集", storyArc: "开端", sourceEventIds: ["event_plan_1"], recap: null, nextHook: "继续" },
      { index: 2, title: "第二集", storyArc: "收束", sourceEventIds: ["event_plan_2"], recap: "前情", nextHook: null },
    ] };
    const planHash = createHash("sha256").update(canonicalFullBookPlanJson(plan)).digest("hex");
    database.prepare("UPDATE jobs SET status='succeeded',result_json=?,progress=1,finished_at=? WHERE id=?")
      .run(JSON.stringify({ plan, planHash }), Date.now(), current.job_id);
    setSeriesPipelineStatus(database, run.id, "planning_episodes", "validating_plan");
    setSeriesPipelineStatus(database, run.id, "validating_plan", "freezing_plan");
    const restarted = new SeriesPipelineService({ database, dataRoot, resolveChapterTextProvider: async () => provider });
    await restarted.reconcile();
    const completed = restarted.get(run.id)!;
    assert.equal(completed.status, "generating_scripts");
    assert.equal(completed.planHash, planHash);
    assert.equal(completed.progress.episodePlan.completed, 2);
    assert.equal(database.prepare("SELECT COUNT(*) AS total FROM episodes").get()!.total, 2);
    assert.equal(database.prepare("SELECT COUNT(*) AS total FROM script_approval_events").get()!.total, 0);
  } finally { connection.close(); await rm(dataRoot, { recursive: true, force: true }); }
});

test("全书规划 parked Job 在 pause 或 cancel 先完成时不会映射", async () => {
  const dataRoot = await mkdtemp(join(tmpdir(), "narralume-pipeline-plan-race-"));
  const connection = await seed(dataRoot);
  try {
    const database = connection.database;
    const run = createSeriesPipelineRun(database, { ...input(), episodeCount: 2 });
    setSeriesPipelineStatus(database, run.id, "configured", "planning_episodes");
    const job = createJob(database, {
      id: "job_plan_parked", type: FULL_BOOK_PLAN_JOB_TYPE, payload: {}, runAfter: Number.MAX_SAFE_INTEGER,
    });
    pauseSeriesPipelineRun(database, run.id);
    assert.equal(mapSeriesPipelineEpisodePlanJob(database, run.id, "1".repeat(64), job.id), false);
    resumeSeriesPipelineRun(database, run.id);
    cancelSeriesPipelineRun(database, run.id);
    assert.equal(mapSeriesPipelineEpisodePlanJob(database, run.id, "1".repeat(64), job.id), false);
    assert.equal(getMappedEpisodePlanJob(database, run.id), undefined);
    assert.equal(getJob(database, job.id)!.runAfter, Number.MAX_SAFE_INTEGER);
  } finally { connection.close(); await rm(dataRoot, { recursive: true, force: true }); }
});
