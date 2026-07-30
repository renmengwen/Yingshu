import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

import { buildApp } from "../app.js";
import {
  CHAPTER_EVENTS_JOB_TYPE,
  createChapterEventsJobHandler,
} from "../chapter-events-job.js";
import type { ChapterEventInput } from "../chapter-event-store.js";
import { openDatabase } from "../database.js";
import { createJob, getJob, requestJobCancellation } from "../job-store.js";
import { JobWorker } from "../job-worker.js";

const SOURCE_URL = "https://www.gutenberg.org/cache/epub/24264/pg24264.txt";
const SOURCE_SHA256 = "ff1526996bf4b81807651921a85e5c1c0f1d1d123c9fa4553057ba6a3ec72011";
const RECOVERY_JOB_ID = "job_p2_real_chapter_recovery";
const CANCEL_JOB_ID = "job_p2_real_chapter_cancel";

interface ChapterRow {
  id: string;
  chapter_index: number;
  byte_start: number;
  byte_end: number;
}

interface ChapterTask {
  chapterId: string;
  events: ChapterEventInput[];
}

function hash(bytes: Buffer) {
  return createHash("sha256").update(bytes).digest("hex");
}

function evidence(source: Buffer, chapter: ChapterRow, phrase: string) {
  const needle = Buffer.from(phrase, "utf8");
  const chapterBytes = source.subarray(chapter.byte_start, chapter.byte_end);
  const first = chapterBytes.indexOf(needle);
  assert(first >= 0, `第 ${chapter.chapter_index} 章缺少冻结证据：${phrase}`);
  assert.equal(chapterBytes.indexOf(needle, first + 1), -1, `冻结证据在章节内不唯一：${phrase}`);
  const byteStart = chapter.byte_start + first;
  return { byteStart, byteEnd: byteStart + needle.length };
}

function chapterTasks(source: Buffer, chapters: ChapterRow[]): ChapterTask[] {
  const requiredChapter = (index: number) => {
    const chapter = chapters.find((item) => item.chapter_index === index);
    assert(chapter, `真实输入缺少 chapter_index=${index}`);
    return chapter;
  };
  const first = requiredChapter(1);
  const second = requiredChapter(2);
  const third = requiredChapter(3);
  return [
    {
      chapterId: first.id,
      events: [
        {
          type: "character",
          payload: { name: "甄士隱" },
          sources: [evidence(source, first, "甄士隱夢幻識通靈")],
        },
        {
          type: "prop",
          payload: { name: "頑石" },
          sources: [evidence(source, first, "頑石三万六千五百零一塊")],
        },
      ],
    },
    {
      chapterId: second.id,
      events: [
        {
          type: "causality",
          payload: { cause: "偶然一顧", effect: "弄出這段事來" },
          sources: [evidence(source, second, "因偶然一顧，便弄出這段事來")],
        },
        {
          type: "suspense",
          payload: { question: "目下興衰如何" },
          sources: [evidence(source, second, "欲知目下興衰兆，須問旁觀冷眼人")],
        },
      ],
    },
    {
      chapterId: third.id,
      events: [
        {
          type: "revelation",
          payload: { fact: "黛玉依傍外祖母及舅氏姊妹" },
          sources: [evidence(source, third, "今依傍外祖母及舅氏姊妹去")],
        },
        {
          type: "location",
          payload: { name: "榮國府" },
          sources: [evidence(source, third, "方是榮國府了")],
        },
      ],
    },
  ];
}

async function runWorkerChild(dataRoot: string, mode: "crash" | "recover") {
  const connection = openDatabase(dataRoot);
  const handler = createChapterEventsJobHandler(connection.database, dataRoot, {
    afterCheckpoint(_chapterId, completedChapters) {
      if (mode === "crash" && completedChapters === 2) process.exit(91);
    },
  });
  const worker = new JobWorker(connection.database, { [CHAPTER_EVENTS_JOB_TYPE]: handler }, {
    workerId: `p2-real-${mode}`,
    leaseMs: 500,
    heartbeatMs: 100,
    retryDelayMs: 0,
  });
  try {
    assert.equal(await worker.runOne(), true, "子进程必须领取真实章节任务");
  } finally {
    connection.close();
  }
}

function spawnWorker(dataRoot: string, mode: "crash" | "recover") {
  const script = fileURLToPath(import.meta.url);
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(process.execPath, [...process.execArgv, script], {
      env: {
        ...process.env,
        YINGSHU_P2_REAL_CHILD: mode,
        YINGSHU_P2_REAL_DATA_ROOT: dataRoot,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let spawnError: Error | undefined;
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, 20_000);
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.once("error", (error) => { spawnError = error; });
    child.once("close", (code) => {
      clearTimeout(timeout);
      const output = {
        code,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
      };
      if (spawnError) reject(spawnError);
      else if (timedOut) reject(new Error(`真实章节 ${mode} 子进程超时\n${output.stderr}`));
      else resolve(output);
    });
  });
}

async function downloadSource(path: string) {
  const response = await fetch(SOURCE_URL);
  assert(response.ok && response.body, `真实原文下载失败：HTTP ${response.status}`);
  await pipeline(
    Readable.fromWeb(response.body as import("node:stream/web").ReadableStream),
    createWriteStream(path, { flush: true }),
  );
}

const childMode = process.env.YINGSHU_P2_REAL_CHILD as "crash" | "recover" | undefined;
const childDataRoot = process.env.YINGSHU_P2_REAL_DATA_ROOT;

if (childMode) {
  assert(childDataRoot, "子进程缺少真实章节数据根");
  await runWorkerChild(childDataRoot, childMode);
} else {
  const root = await mkdtemp(join(tmpdir(), "narralume-p2-real-"));
  const dataRoot = join(root, "data");
  const sourcePath = process.env.YINGSHU_LONG_TEXT_PATH ?? join(root, "pg24264.txt");
  let app: ReturnType<typeof buildApp> | undefined;
  try {
    if (!process.env.YINGSHU_LONG_TEXT_PATH) await downloadSource(sourcePath);
    const source = await readFile(sourcePath);
    assert.equal(source.length, 2_663_455, "真实原文大小与冻结值不一致");
    assert.equal(hash(source), SOURCE_SHA256, "真实原文 SHA-256 与冻结值不一致");

    app = buildApp({ dataRoot, logger: false });
    const imported = await app.inject({
      method: "POST",
      url: "/api/books/import",
      headers: { "content-type": "text/plain", "x-file-name": encodeURIComponent("红楼梦.txt") },
      payload: createReadStream(sourcePath),
    });
    assert.equal(imported.statusCode, 201, `真实原文导入失败：${imported.body}`);
    const bookId = imported.json().book.id as string;
    await app.close();
    app = undefined;

    const setup = openDatabase(dataRoot);
    let tasks: ChapterTask[];
    try {
      const chapters = setup.database.prepare(
        "SELECT id, chapter_index, byte_start, byte_end FROM chapters WHERE book_id = ? ORDER BY chapter_index",
      ).all(bookId) as unknown as ChapterRow[];
      tasks = chapterTasks(source, chapters);
      createJob(setup.database, {
        id: RECOVERY_JOB_ID,
        type: CHAPTER_EVENTS_JOB_TYPE,
        payload: { bookId, chapters: tasks },
        maxAttempts: 2,
      });
    } finally {
      setup.close();
    }

    const crashed = await spawnWorker(dataRoot, "crash");
    assert.equal(crashed.code, 91, `首个真实 Worker 应硬退出：${crashed.stderr}`);

    const partial = openDatabase(dataRoot);
    let leaseExpiresAt: number;
    try {
      const job = getJob(partial.database, RECOVERY_JOB_ID);
      assert.equal(job?.status, "running");
      assert.equal(job?.attempts, 1);
      assert(job?.leaseExpiresAt, "崩溃任务必须保留真实租约");
      leaseExpiresAt = job.leaseExpiresAt;
      assert.equal(partial.database.prepare(
        "SELECT COUNT(*) AS count FROM job_checkpoints WHERE job_id = ?",
      ).get(RECOVERY_JOB_ID)?.count, 2);
      const counts = tasks.map((task) => partial.database.prepare(
        "SELECT COUNT(*) AS count FROM chapter_events WHERE chapter_id = ?",
      ).get(task.chapterId)?.count);
      assert.deepEqual(counts, [2, 2, 0], "硬退出前必须只提交前两章事件");
    } finally {
      partial.close();
    }

    await new Promise((resolve) => setTimeout(resolve, Math.max(0, leaseExpiresAt - Date.now()) + 50));
    const recovered = await spawnWorker(dataRoot, "recover");
    assert.equal(recovered.code, 0, `恢复 Worker 失败：${recovered.stderr}`);

    const completed = openDatabase(dataRoot);
    try {
      const job = getJob<Record<string, unknown>, { processed: number; reused: number; chapters: number }>(
        completed.database,
        RECOVERY_JOB_ID,
      );
      assert.equal(job?.status, "succeeded");
      assert.equal(job?.attempts, 2);
      assert.deepEqual(job?.result, { processed: 1, reused: 2, chapters: 3 });
      assert.equal(completed.database.prepare("SELECT COUNT(*) AS count FROM chapter_events").get()?.count, 6);
      assert.equal(completed.database.prepare(
        "SELECT COUNT(*) AS count FROM job_checkpoints WHERE job_id = ?",
      ).get(RECOVERY_JOB_ID)?.count, 3);
      assert.equal(completed.database.prepare(
        "SELECT COUNT(*) AS count FROM (SELECT id FROM chapter_events GROUP BY id HAVING COUNT(*) > 1)",
      ).get()?.count, 0);

      const beforeCancel = JSON.stringify(completed.database.prepare(
        "SELECT id, event_index, event_type, payload_json FROM chapter_events WHERE chapter_id = ? ORDER BY event_index, id",
      ).all(tasks[2]!.chapterId));
      createJob(completed.database, {
        id: CANCEL_JOB_ID,
        type: CHAPTER_EVENTS_JOB_TYPE,
        payload: { bookId, chapters: [tasks[2]] },
        maxAttempts: 1,
      });
      const cancellingHandler = createChapterEventsJobHandler(completed.database, dataRoot, {
        beforeCommit() { requestJobCancellation(completed.database, CANCEL_JOB_ID); },
      });
      const cancellingWorker = new JobWorker(
        completed.database,
        { [CHAPTER_EVENTS_JOB_TYPE]: cancellingHandler },
        { workerId: "p2-real-cancel", leaseMs: 1_000, heartbeatMs: 100 },
      );
      assert.equal(await cancellingWorker.runOne(), true);
      assert.equal(getJob(completed.database, CANCEL_JOB_ID)?.status, "cancelled");
      assert.equal(completed.database.prepare(
        "SELECT COUNT(*) AS count FROM job_checkpoints WHERE job_id = ?",
      ).get(CANCEL_JOB_ID)?.count, 0);
      const afterCancel = JSON.stringify(completed.database.prepare(
        "SELECT id, event_index, event_type, payload_json FROM chapter_events WHERE chapter_id = ? ORDER BY event_index, id",
      ).all(tasks[2]!.chapterId));
      assert.equal(afterCancel, beforeCancel, "取消任务不得改变目标章节事件");
    } finally {
      completed.close();
    }

    app = buildApp({ dataRoot, logger: false });
    const types = new Set<string>();
    const ids = new Set<string>();
    for (const task of tasks) {
      let offset = 0;
      for (;;) {
        const response: { statusCode: number; body: string; json(): any } = await app.inject({
          method: "GET",
          url: `/api/books/${bookId}/chapters/${task.chapterId}/events?limit=1&offset=${offset}`,
        });
        assert.equal(response.statusCode, 200, `重启后事件查询失败：${response.body}`);
        const page = response.json();
        for (const event of page.items) {
          assert(!ids.has(event.id), `事件 ID 重复：${event.id}`);
          ids.add(event.id);
          types.add(event.type);
          for (const item of event.sources) {
            assert.equal(hash(source.subarray(item.byteStart, item.byteEnd)), item.sourceHash);
          }
        }
        offset += page.items.length;
        if (offset >= page.total) break;
      }
      assert.equal(offset, 2, "每个冻结章节必须包含两个事件");
    }
    assert.equal(ids.size, 6);
    assert.deepEqual([...types].sort(), [
      "causality", "character", "location", "prop", "revelation", "suspense",
    ]);

    process.stdout.write(`${JSON.stringify({
      ok: true,
      source_bytes: source.length,
      source_sha256: hash(source),
      crash_exit_code: crashed.code,
      recovered_result: { processed: 1, reused: 2, chapters: 3 },
      attempts: 2,
      cancelled_checkpoints: 0,
      restarted_events: ids.size,
      event_types: [...types].sort(),
    }, null, 2)}\n`);
  } finally {
    if (app) await app.close();
    await rm(root, { recursive: true, force: true });
  }
}
