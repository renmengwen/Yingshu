import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { ChapterTextModelConfig } from "./chapter-event-analyzer.js";
import { openDatabase } from "./database.js";
import {
  createOpenAiEpisodeRecommender,
  createEpisodeRecommendationJobHandler,
  enqueueEpisodeRecommendationJob,
  EPISODE_RECOMMENDATION_JOB_TYPE,
  type RecommendEpisodeSources,
} from "./episode-recommendation-job.js";
import { getJob, requestJobCancellation } from "./job-store.js";
import { JobWorker } from "./job-worker.js";
import { textModelConcurrencyGate } from "./text-model-concurrency.js";
import { TextModelCallError } from "./text-model-stream.js";

const config: ChapterTextModelConfig = {
  baseUrl: "https://example.invalid/v1",
  apiKey: "test",
  model: "test-model",
  providerId: "test-provider",
};

test("分集来源推荐显式请求流式输出并逐块读取 SSE", async (t) => {
  let gateRuns = 0;
  t.mock.method(textModelConcurrencyGate, "run", async (_signal: AbortSignal | undefined, task: () => Promise<unknown>) => {
    gateRuns += 1; return task();
  });
  const expected = {
    chapterIds: ["chapter_1"], eventIds: ["event_1"], estimatedCharacterCount: 1200, advice: "\u4fdd\u7559",
  } as const;
  let requestBody: { stream?: unknown } | undefined;
  const recommend = createOpenAiEpisodeRecommender(config, (async (_input, init) => {
    requestBody = JSON.parse(String(init?.body)) as { stream?: unknown };
    const delta = JSON.stringify({ type: "response.output_text.delta", delta: JSON.stringify(expected) });
    return new Response(`data: ${delta}\n\ndata: {"type":"response.completed"}\n\n`, {
      headers: { "content-type": "text/event-stream" },
    });
  }) as typeof fetch);

  assert.deepEqual(await recommend({
    targetDurationSeconds: 1200, endingPreference: null, chapters: [],
  }), expected);
  assert.equal(requestBody?.stream, true);
  assert.equal(gateRuns, 1);
});

test("选材推荐 JSON 错误携带生产阶段和有界模型证据", async () => {
  const recommend = createOpenAiEpisodeRecommender(config, (async () => {
    const delta = JSON.stringify({ type: "response.output_text.delta", delta: "not-json" });
    return new Response(`data: ${delta}\n\ndata: {"type":"response.completed"}\n\n`, {
      headers: { "content-type": "text/event-stream" },
    });
  }) as typeof fetch);
  let caught: unknown;
  try {
    await recommend({
      targetDurationSeconds: 1200,
      endingPreference: null,
      chapters: [],
      diagnosticStage: "episode-recommendation:series:1",
    });
  } catch (error) { caught = error; }

  assert.ok(caught instanceof TextModelCallError);
  assert.equal(caught.stage, "episode-recommendation:series:1");
  assert.equal(caught.evidence.partialText, "not-json");
  assert.equal(caught.evidence.statistics?.terminalReceived, true);
});

async function fixture(missingSecond = false) {
  const dataRoot = await mkdtemp(join(tmpdir(), "narralume-recommend-"));
  const connection = openDatabase(dataRoot);
  const db = connection.database;
  await mkdir(join(dataRoot, "books", "book"), { recursive: true });
  await writeFile(join(dataRoot, "books", "book", "source.txt"), "FULL_TEXT_SENTINEL_不得进入推荐模型", "utf8");
  db.prepare(
    `INSERT INTO books (id,title,original_file_path,original_file_hash,encoding,import_status)
     VALUES ('book','书','books/book/source.txt','hash','UTF-8','ready')`,
  ).run();
  db.prepare("INSERT INTO series_projects (id,book_id,title,created_at,updated_at) VALUES ('series','book','系列',1,1)").run();
  for (let index = 0; index < 3; index += 1) {
    db.prepare(
      `INSERT INTO chapters (id,book_id,chapter_index,title,byte_start,byte_end,char_count,content_hash)
       VALUES (?,?,?, ?,?,?,?,?)`,
    ).run(`chapter_${index + 1}`, "book", index, `第${index + 1}章`, index * 10, index * 10 + 9, 9, `hash_${index}`);
    if (!missingSecond || index !== 1) db.prepare(
      `INSERT INTO chapter_events (id,chapter_id,event_index,occurrence,event_type,payload_json,created_at)
       VALUES (?,?,0,0,'revelation',?,1)`,
    ).run(`event_${index + 1}`, `chapter_${index + 1}`, JSON.stringify({ fact: `事实${index + 1}` }));
  }
  return { dataRoot, connection };
}

async function run(missingSecond: boolean, recommend: RecommendEpisodeSources) {
  const context = await fixture(missingSecond);
  const queued = enqueueEpisodeRecommendationJob(context.connection.database, config, {
    seriesId: "series", episodeIndex: 1, startChapterId: "chapter_1",
    targetDurationSeconds: 1200, endingPreference: "悬念",
  }, { maxAttempts: 1 });
  const worker = new JobWorker(context.connection.database, {
    [EPISODE_RECOMMENDATION_JOB_TYPE]: createEpisodeRecommendationJobHandler(context.connection.database, config, recommend),
  }, { workerId: "test", leaseMs: 10_000, heartbeatMs: 1_000, retryDelayMs: 0 });
  await worker.runOne();
  return { ...context, job: getJob(context.connection.database, queued.job.id)! };
}

test("推荐任务只向模型发送逐章摘要并持久化连续真实事件", async () => {
  let received: Parameters<RecommendEpisodeSources>[0] | undefined;
  const context = await run(false, async (input) => {
    received = input;
    return { chapterIds: ["chapter_1", "chapter_2"], eventIds: ["event_1", "event_2"], estimatedCharacterCount: 4200, advice: "压缩" };
  });
  try {
    assert.equal(context.job.status, "succeeded");
    assert.equal(received?.diagnosticStage, "episode-recommendation:series:1");
    assert.deepEqual(received?.chapters.map((chapter) => Object.keys(chapter)), [
      ["id", "index", "title", "events"], ["id", "index", "title", "events"], ["id", "index", "title", "events"],
    ]);
    const serializedInput = JSON.stringify(received);
    for (const forbidden of ["sourceText", "byteStart", "byteEnd", "FULL_TEXT_SENTINEL_不得进入推荐模型"]) {
      assert.equal(serializedInput.includes(forbidden), false, `模型输入不得包含 ${forbidden}`);
    }
    assert.deepEqual((context.job.result as { chapterIds: string[]; eventIds: string[] }).chapterIds, ["chapter_1", "chapter_2"]);
    const resumed = enqueueEpisodeRecommendationJob(context.connection.database, config, {
      seriesId: "series", episodeIndex: 1, startChapterId: "chapter_1", targetDurationSeconds: 1200, endingPreference: "悬念",
    });
    assert.equal(resumed.created, false);
    assert.equal(resumed.job.id, context.job.id);
  } finally { context.connection.close(); await rm(context.dataRoot, { recursive: true, force: true }); }
});

test("缺少分析明确返回单章身份且只推荐已分析的连续前缀", async () => {
  let called = false;
  const context = await run(true, async () => {
    called = true;
    return { chapterIds: ["chapter_1"], eventIds: ["event_1"], estimatedCharacterCount: 800, advice: "保留" };
  });
  try {
    assert.equal(context.job.status, "succeeded");
    assert.equal(called, true);
    assert.deepEqual((context.job.result as { missingChapters: unknown[] }).missingChapters, [{ id: "chapter_2", title: "第2章" }]);
  } finally { context.connection.close(); await rm(context.dataRoot, { recursive: true, force: true }); }
});

test("推荐模型伪造章节或事件 ID 会在服务端失败", async () => {
  for (const proposed of [
    { chapterIds: ["chapter_1", "chapter_3"], eventIds: ["event_1"], estimatedCharacterCount: 1, advice: "保留" as const },
    { chapterIds: ["chapter_1"], eventIds: ["event_forged"], estimatedCharacterCount: 1, advice: "保留" as const },
  ]) {
    const context = await run(false, async () => proposed);
    try {
      assert.equal(context.job.status, "failed");
      assert.match(context.job.errorMessage ?? "", /伪造|越界|不连续/);
    } finally { context.connection.close(); await rm(context.dataRoot, { recursive: true, force: true }); }
  }
});

test("未指定起点时从上一 Episode 最后章节边界继续", async () => {
  const context = await fixture(false);
  try {
    const db = context.connection.database;
    db.prepare(`INSERT INTO episodes (id,series_project_id,episode_index,title,story_arc,target_duration_seconds,created_at,updated_at)
      VALUES ('episode_1','series',1,'第一集','弧',1200,1,1)`).run();
    db.prepare(`INSERT INTO episode_sources (episode_id,source_index,chapter_id,source_event_id,source_byte_start,source_byte_end,source_hash)
      VALUES ('episode_1',0,'chapter_1','event_1',0,1,?)`).run("a".repeat(64));
    const queued = enqueueEpisodeRecommendationJob(db, config, {
      seriesId: "series", episodeIndex: 2, targetDurationSeconds: 1200,
    });
    assert.deepEqual(
      (({ requestedStartChapterId, startChapterId }) => ({ requestedStartChapterId, startChapterId }))(
        queued.job.payload as { requestedStartChapterId: string | null; startChapterId: string },
      ),
      { requestedStartChapterId: null, startChapterId: "chapter_2" },
    );
    assert.throws(() => enqueueEpisodeRecommendationJob(db, config, {
      seriesId: "series", episodeIndex: 3, targetDurationSeconds: 1200,
    }), /上一集不存在/);
  } finally { context.connection.close(); await rm(context.dataRoot, { recursive: true, force: true }); }
});

test("隐式起点的首集、续集成功结果和缺分析结果都保留原始请求 identity", async (t) => {
  for (const scenario of ["first", "continuation", "needs-analysis"] as const) await t.test(scenario, async () => {
    const context = await fixture(false);
    try {
      const db = context.connection.database;
      const episodeIndex = scenario === "continuation" ? 2 : 1;
      const resolvedStart = scenario === "continuation" ? "chapter_2" : "chapter_1";
      if (scenario === "continuation") {
        db.prepare(`INSERT INTO episodes (id,series_project_id,episode_index,title,story_arc,target_duration_seconds,created_at,updated_at)
          VALUES ('episode_1','series',1,'第一集','弧',1200,1,1)`).run();
        db.prepare(`INSERT INTO episode_sources (episode_id,source_index,chapter_id,source_event_id,source_byte_start,source_byte_end,source_hash)
          VALUES ('episode_1',0,'chapter_1','event_1',0,1,?)`).run("a".repeat(64));
      }
      if (scenario === "needs-analysis") db.prepare("DELETE FROM chapter_events WHERE id = 'event_1'").run();
      const queued = enqueueEpisodeRecommendationJob(db, config, {
        seriesId: "series", episodeIndex, targetDurationSeconds: 1200,
      }, { maxAttempts: 1 });
      const payload = queued.job.payload as { requestedStartChapterId: string | null; startChapterId: string };
      assert.equal(payload.requestedStartChapterId, null);
      assert.equal(payload.startChapterId, resolvedStart);
      const worker = new JobWorker(db, {
        [EPISODE_RECOMMENDATION_JOB_TYPE]: createEpisodeRecommendationJobHandler(db, config, async () => ({
          chapterIds: [resolvedStart], eventIds: [scenario === "continuation" ? "event_2" : "event_1"],
          estimatedCharacterCount: 800, advice: "保留",
        })),
      }, { workerId: `implicit-${scenario}`, leaseMs: 10_000, heartbeatMs: 1_000, retryDelayMs: 0 });
      await worker.runOne();
      const completed = getJob(db, queued.job.id)!;
      assert.equal(completed.status, "succeeded");
      assert.equal((completed.result as { startChapterId: string }).startChapterId, resolvedStart);
      assert.equal((completed.result as { status: string }).status,
        scenario === "needs-analysis" ? "needs_analysis" : "recommended");
    } finally { context.connection.close(); await rm(context.dataRoot, { recursive: true, force: true }); }
  });
});

test("推荐任务可取消并落入持久终态", async () => {
  const context = await fixture(false);
  try {
    const queued = enqueueEpisodeRecommendationJob(context.connection.database, config, {
      seriesId: "series", episodeIndex: 1, startChapterId: "chapter_1", targetDurationSeconds: 1200,
    }, { maxAttempts: 1 });
    const handler = createEpisodeRecommendationJobHandler(context.connection.database, config, ({ signal }) =>
      new Promise((_resolve, reject) => signal?.addEventListener("abort", () => reject(signal.reason), { once: true })),
    );
    const worker = new JobWorker(context.connection.database, { [EPISODE_RECOMMENDATION_JOB_TYPE]: handler }, {
      workerId: "cancel", leaseMs: 10_000, heartbeatMs: 1_000,
    });
    const running = worker.runOne();
    while (getJob(context.connection.database, queued.job.id)?.status !== "running") {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    requestJobCancellation(context.connection.database, queued.job.id);
    await running;
    assert.equal(getJob(context.connection.database, queued.job.id)?.status, "cancelled");
  } finally { context.connection.close(); await rm(context.dataRoot, { recursive: true, force: true }); }
});
