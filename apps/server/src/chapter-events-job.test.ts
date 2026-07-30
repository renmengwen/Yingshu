import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { buildApp } from "./app.js";
import {
  CHAPTER_ANALYSIS_IDLE_TIMEOUT_MS,
  CHAPTER_ANALYSIS_TOTAL_TIMEOUT_MS,
  CHAPTER_ANALYSIS_TIMEOUT_MS,
  CHAPTER_EVENTS_ANALYZE_JOB_TYPE,
  CHAPTER_EVENTS_JOB_TYPE,
} from "./chapter-events-job.js";
import { openDatabase } from "./database.js";
import { createJob } from "./job-store.js";

const textProvider = {
  baseUrl: "https://unused.example/v1",
  apiKey: "unused",
  model: "test-text",
  providerId: "test-provider",
};

test("章节分析使用首活动、空闲三分钟与十五分钟总时限", () => {
  assert.equal(CHAPTER_ANALYSIS_TIMEOUT_MS, 180_000);
  assert.equal(CHAPTER_ANALYSIS_IDLE_TIMEOUT_MS, 180_000);
  assert.equal(CHAPTER_ANALYSIS_TOTAL_TIMEOUT_MS, 900_000);
});

async function waitForJob(app: ReturnType<typeof buildApp>, jobId: string) {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    const response = await app.inject({ method: "GET", url: `/api/jobs/${jobId}` });
    const job = response.json().job;
    if (["succeeded", "failed", "cancelled"].includes(job.status)) return job;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("等待章节事件任务完成超时");
}

test("默认章节事件任务先持久化再原子保存事件", async () => {
  const dataRoot = await mkdtemp(join(tmpdir(), "narralume-chapter-events-job-"));
  const app = buildApp({
    dataRoot,
    logger: false,
    jobPollMs: 5,
    jobWorker: { workerId: "chapter-events-test", leaseMs: 1_000, heartbeatMs: 100 },
  });
  const source = Buffer.from("第一章\n宝玉来到大观园。", "utf8");
  try {
    const imported = await app.inject({
      method: "POST",
      url: "/api/books/import",
      headers: { "content-type": "text/plain" },
      payload: source,
    });
    const bookId = imported.json().book.id as string;
    const chapters = await app.inject({ method: "GET", url: `/api/books/${bookId}/chapters` });
    const chapterId = chapters.json().items[0].id as string;
    const evidence = Buffer.from("宝玉", "utf8");
    const byteStart = source.indexOf(evidence);
    const created = await app.inject({
      method: "POST",
      url: "/api/jobs",
      payload: {
        type: CHAPTER_EVENTS_JOB_TYPE,
        payload: {
          bookId,
          chapters: [{
            chapterId,
            events: [{
              type: "character",
              payload: { name: "宝玉" },
              sources: [{ byteStart, byteEnd: byteStart + evidence.length }],
            }],
          }],
        },
      },
    });
    assert.equal(created.statusCode, 201);
    const job = await waitForJob(app, created.json().job.id as string);
    assert.equal(job.status, "succeeded");
    assert.deepEqual(job.result, { processed: 1, reused: 0, chapters: 1 });
    const events = await app.inject({
      method: "GET",
      url: `/api/books/${bookId}/chapters/${chapterId}/events`,
    });
    assert.equal(events.statusCode, 200);
    assert.equal(events.json().total, 1);
    assert.equal(events.json().items[0].type, "character");
  } finally {
    await app.close();
    await rm(dataRoot, { recursive: true, force: true });
  }
});

test("自动分析任务复用冻结身份且空结果不清空人工事件", async () => {
  const dataRoot = await mkdtemp(join(tmpdir(), "narralume-chapter-analysis-empty-"));
  const app = buildApp({
    dataRoot,
    logger: false,
    chapterTextProvider: textProvider,
    chapterAnalyzer: async () => [],
    jobPollMs: 5,
    jobWorker: { workerId: "chapter-analysis-empty", leaseMs: 1_000, heartbeatMs: 100 },
  });
  const source = Buffer.from("第一章\n吴邪进入墓道。", "utf8");
  try {
    const imported = await app.inject({ method: "POST", url: "/api/books/import", headers: { "content-type": "text/plain" }, payload: source });
    const bookId = imported.json().book.id as string;
    const chapters = await app.inject({ method: "GET", url: `/api/books/${bookId}/chapters` });
    const chapterId = chapters.json().items[0].id as string;
    const evidence = Buffer.from("吴邪", "utf8");
    const byteStart = source.indexOf(evidence);
    const manual = await app.inject({
      method: "PUT",
      url: `/api/books/${bookId}/chapters/${chapterId}/events`,
      payload: { events: [{ type: "character", payload: { name: "吴邪" }, sources: [{ byteStart, byteEnd: byteStart + evidence.length }] }] },
    });
    assert.equal(manual.statusCode, 200);

    const request = { type: CHAPTER_EVENTS_ANALYZE_JOB_TYPE, payload: { bookId, chapterId } };
    const created = await app.inject({ method: "POST", url: "/api/jobs", payload: request });
    assert.equal(created.statusCode, 201);
    const reused = await app.inject({ method: "POST", url: "/api/jobs", payload: request });
    assert.equal(reused.statusCode, 200);
    assert.equal(reused.json().job.id, created.json().job.id);
    const job = await waitForJob(app, created.json().job.id as string);
    assert.equal(job.status, "succeeded");
    assert.deepEqual(job.result, { analyzed: 0, preserved: true });
    const oldStatus = await app.inject({ method: "POST", url: "/api/jobs", payload: request });
    assert.equal(oldStatus.json().job.status, "succeeded");
    const events = await app.inject({ method: "GET", url: `/api/books/${bookId}/chapters/${chapterId}/events` });
    assert.equal(events.json().total, 1);
    assert.equal(events.json().items[0].payload.name, "吴邪");
  } finally {
    await app.close();
    await rm(dataRoot, { recursive: true, force: true });
  }
});

test("运行中的自动分析任务响应持久取消请求", async () => {
  const dataRoot = await mkdtemp(join(tmpdir(), "narralume-chapter-analysis-cancel-"));
  const app = buildApp({
    dataRoot,
    logger: false,
    chapterTextProvider: textProvider,
    chapterAnalyzer: ({ signal }) => new Promise((_resolve, reject) => {
      signal!.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
    }),
    jobPollMs: 5,
    jobWorker: { workerId: "chapter-analysis-cancel", leaseMs: 1_000, heartbeatMs: 100 },
  });
  const source = Buffer.from("第一章\n吴邪进入墓道。", "utf8");
  try {
    const imported = await app.inject({ method: "POST", url: "/api/books/import", headers: { "content-type": "text/plain" }, payload: source });
    const bookId = imported.json().book.id as string;
    const chapters = await app.inject({ method: "GET", url: `/api/books/${bookId}/chapters` });
    const chapterId = chapters.json().items[0].id as string;
    const created = await app.inject({ method: "POST", url: "/api/jobs", payload: { type: CHAPTER_EVENTS_ANALYZE_JOB_TYPE, payload: { bookId, chapterId } } });
    const jobId = created.json().job.id as string;
    const deadline = Date.now() + 1_000;
    while (Date.now() < deadline) {
      const current = await app.inject({ method: "GET", url: `/api/jobs/${jobId}` });
      if (current.json().job.status === "running") break;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    const cancelled = await app.inject({ method: "POST", url: `/api/jobs/${jobId}/cancel` });
    assert.equal(cancelled.statusCode, 200);
    assert.equal((await waitForJob(app, jobId)).status, "cancelled");
  } finally {
    await app.close();
    await rm(dataRoot, { recursive: true, force: true });
  }
});

test("自动分析复用身份不包含 provider 和 model 且保留首次执行溯源", async () => {
  const dataRoot = await mkdtemp(join(tmpdir(), "narralume-chapter-analysis-provenance-"));
  const source = Buffer.from("第一章\n甲进入庭院。", "utf8");
  const firstProvider = { ...textProvider, providerId: "provider-a", model: "model-a" };
  const secondProvider = { ...textProvider, providerId: "provider-b", model: "model-b" };
  let firstApp = buildApp({
    dataRoot,
    logger: false,
    chapterTextProvider: firstProvider,
    chapterAnalyzer: async ({ atoms }) => [{
      type: "character",
      payload: { name: "甲" },
      sources: [{ byteStart: atoms[0]!.byteStart, byteEnd: atoms[0]!.byteEnd }],
    }],
    jobPollMs: 5,
  });
  try {
    const imported = await firstApp.inject({
      method: "POST", url: "/api/books/import", headers: { "content-type": "text/plain" }, payload: source,
    });
    const bookId = imported.json().book.id as string;
    const chapters = await firstApp.inject({ method: "GET", url: `/api/books/${bookId}/chapters` });
    const chapterId = chapters.json().items[0].id as string;
    const seed = openDatabase(dataRoot);
    const contentHash = (seed.database.prepare("SELECT content_hash FROM chapters WHERE id = ?").get(chapterId) as { content_hash: string }).content_hash;
    const oldIdentity = {
      bookId,
      chapterId,
      contentHash,
      analysisContractVersion: "chapter-events-analysis-v1",
      promptContractVersion: "chapter-events-prompt-v1",
      parserContractVersion: "chapter-events-parser-v1",
    };
    const oldRequestHash = createHash("sha256").update(JSON.stringify(oldIdentity)).digest("hex");
    const oldJob = createJob(seed.database, {
      id: `job_chapter_analyze_${oldRequestHash}`,
      type: CHAPTER_EVENTS_ANALYZE_JOB_TYPE,
      payload: { ...oldIdentity, providerId: firstProvider.providerId, model: firstProvider.model, requestHash: oldRequestHash },
      runAfter: Number.MAX_SAFE_INTEGER,
    });
    seed.close();
    const created = await firstApp.inject({
      method: "POST", url: "/api/jobs",
      payload: { type: CHAPTER_EVENTS_ANALYZE_JOB_TYPE, payload: { bookId, chapterId } },
    });
    assert.equal(created.statusCode, 201);
    assert.notEqual(created.json().job.id, oldJob.id);
    const firstJob = await waitForJob(firstApp, created.json().job.id as string);
    assert.equal(firstJob.status, "succeeded");
    assert.equal(firstJob.payload.providerId, "provider-a");
    assert.equal(firstJob.payload.model, "model-a");
    assert.equal(firstJob.payload.analysisContractVersion, "chapter-events-analysis-v1");
    assert.equal(firstJob.payload.promptContractVersion, "chapter-events-prompt-v2");
    assert.equal(firstJob.payload.parserContractVersion, "chapter-events-parser-v1");
    const persisted = openDatabase(dataRoot);
    persisted.database.prepare("UPDATE jobs SET max_attempts=3 WHERE id=?").run(firstJob.id);
    persisted.close();
    await firstApp.close();

    const secondApp = buildApp({
      dataRoot,
      logger: false,
      chapterTextProvider: secondProvider,
      chapterAnalyzer: async () => { throw new Error("复用成功任务时不应重新分析"); },
      jobPollMs: 5,
    });
    firstApp = secondApp;
    const reused = await secondApp.inject({
      method: "POST", url: "/api/jobs",
      payload: { type: CHAPTER_EVENTS_ANALYZE_JOB_TYPE, payload: { bookId, chapterId } },
    });
    assert.equal(reused.statusCode, 200);
    assert.equal(reused.json().job.id, firstJob.id);
    assert.equal(reused.json().job.payload.providerId, "provider-a");
    assert.equal(reused.json().job.payload.model, "model-a");
    assert.equal(reused.json().job.maxAttempts, 3);
  } finally {
    await firstApp.close();
    await rm(dataRoot, { recursive: true, force: true });
  }
});
