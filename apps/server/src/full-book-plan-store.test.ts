import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { openDatabase } from "./database.js";
import { createSeriesProject } from "./episode-store.js";
import { freezeFullBookPlan, FullBookPlanStoreError } from "./full-book-plan-store.js";
import type { FullBookPlanOptions } from "./full-book-plan-contract.js";

function seed(database: ReturnType<typeof openDatabase>["database"]) {
  database.prepare(
    `INSERT INTO books (id, title, original_file_path, original_file_hash, encoding, import_status)
     VALUES ('book', '全书', 'books/book/source.txt', ?, 'UTF-8', 'ready')`,
  ).run("a".repeat(64));
  for (let index = 0; index < 3; index += 1) {
    const chapterId = `chapter_${index}`;
    const eventId = `event_${index}`;
    database.prepare(
      `INSERT INTO chapters (id, book_id, chapter_index, title, byte_start, byte_end, char_count, content_hash)
       VALUES (?, 'book', ?, ?, ?, ?, 10, ?)`,
    ).run(chapterId, index, `第${index + 1}章`, index * 10, index * 10 + 10, String(index).repeat(64));
    database.prepare(
      `INSERT INTO chapter_events (id, chapter_id, event_index, occurrence, event_type, payload_json, created_at)
       VALUES (?, ?, 0, 0, 'causality', '{}', 1)`,
    ).run(eventId, chapterId);
    database.prepare(
      `INSERT INTO chapter_event_sources (event_id, source_index, source_byte_start, source_byte_end, source_hash)
       VALUES (?, 0, ?, ?, ?)`,
    ).run(eventId, index * 10, index * 10 + 10, String(index).repeat(64));
  }
  return createSeriesProject(database, { id: "series", bookId: "book", title: "系列" }, 1);
}

function options(): FullBookPlanOptions {
  return {
    startChapterIndex: 0,
    endChapterIndex: 2,
    episodeCount: 2,
    allowedSourceEvents: new Map([
      ["event_0", { chapterId: "chapter_0", chapterIndex: 0, byteRanges: [{ byteStart: 0, byteEnd: 10 }] }],
      ["event_1", { chapterId: "chapter_1", chapterIndex: 1, byteRanges: [{ byteStart: 10, byteEnd: 20 }] }],
      ["event_2", { chapterId: "chapter_2", chapterIndex: 2, byteRanges: [{ byteStart: 20, byteEnd: 30 }] }],
    ]),
  };
}

function plan(title = "第一集") {
  return { episodes: [
    { index: 1, title, storyArc: "开端", sourceEventIds: ["event_0", "event_1"], recap: null, nextHook: "继续" },
    { index: 2, title: "第二集", storyArc: "收束", sourceEventIds: ["event_2"], recap: "前情", nextHook: null },
  ] };
}

test("原子冻结恰好 N 集、完整连续来源且同计划幂等并可重启读取", async () => {
  const root = await mkdtemp(join(tmpdir(), "narralume-full-plan-"));
  let connection: ReturnType<typeof openDatabase> | undefined;
  try {
    connection = openDatabase(root);
    seed(connection.database);
    const first = freezeFullBookPlan(connection.database, {
      seriesProjectId: "series", plan: plan(), options: options(), targetDurationSeconds: 240,
    }, 10);
    const second = freezeFullBookPlan(connection.database, {
      seriesProjectId: "series", plan: plan(), options: options(), targetDurationSeconds: 240,
    }, 20);
    assert.equal(first.planHash, second.planHash);
    assert.equal(connection.database.prepare("SELECT COUNT(*) AS total FROM episodes").get()!.total, 2);
    const sources = connection.database.prepare(
      `SELECT episodes.episode_index, episode_sources.source_event_id
       FROM episodes JOIN episode_sources ON episode_sources.episode_id = episodes.id
       ORDER BY episodes.episode_index, episode_sources.source_index`,
    ).all() as unknown as Array<{ episode_index: number; source_event_id: string }>;
    assert.deepEqual(sources.map((row) => [row.episode_index, row.source_event_id]), [
      [1, "event_0"], [1, "event_1"], [2, "event_2"],
    ]);
    assert.equal(connection.database.prepare("SELECT COUNT(*) AS total FROM script_approval_events").get()!.total, 0);
    connection.close();
    connection = openDatabase(root);
    assert.equal(connection.database.prepare("SELECT target_duration_seconds FROM episodes WHERE episode_index = 2").get()!.target_duration_seconds, 240);
    connection.close();
    connection = undefined;
  } finally {
    connection?.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("第二集写入失败时第一集和来源整体回滚", async () => {
  const root = await mkdtemp(join(tmpdir(), "narralume-full-plan-"));
  const connection = openDatabase(root);
  try {
    seed(connection.database);
    connection.database.exec(
      `CREATE TEMP TRIGGER fail_second_episode BEFORE INSERT ON episodes
       WHEN NEW.episode_index = 2 BEGIN SELECT RAISE(ABORT, 'second episode failure'); END`,
    );
    assert.throws(() => freezeFullBookPlan(connection.database, {
      seriesProjectId: "series", plan: plan(), options: options(), targetDurationSeconds: 240,
    }), /second episode failure/);
    assert.equal(connection.database.prepare("SELECT COUNT(*) AS total FROM episodes").get()!.total, 0);
    assert.equal(connection.database.prepare("SELECT COUNT(*) AS total FROM episode_sources").get()!.total, 0);
  } finally {
    connection.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("安全空态可替换，但已有稿件证据的冲突计划返回 409 且不自动批准", async () => {
  const root = await mkdtemp(join(tmpdir(), "narralume-full-plan-"));
  const connection = openDatabase(root);
  try {
    seed(connection.database);
    freezeFullBookPlan(connection.database, {
      seriesProjectId: "series", plan: plan(), options: options(), targetDurationSeconds: 240,
    }, 10);
    freezeFullBookPlan(connection.database, {
      seriesProjectId: "series", plan: plan("安全替换"), options: options(), targetDurationSeconds: 240,
    }, 20);
    const episode = connection.database.prepare("SELECT id FROM episodes WHERE episode_index = 1").get() as { id: string };
    const contentHash = createHash("sha256").update("{}").digest("hex");
    connection.database.prepare(
      `INSERT INTO script_versions (id, episode_id, kind, version, content_json, content_hash, created_at)
       VALUES ('script', ?, 'faithful', 1, '{}', ?, 30)`,
    ).run(episode.id, contentHash);
    assert.throws(() => freezeFullBookPlan(connection.database, {
      seriesProjectId: "series", plan: plan("禁止覆盖"), options: options(), targetDurationSeconds: 240,
    }, 40), (error: unknown) => error instanceof FullBookPlanStoreError && error.statusCode === 409);
    assert.equal(connection.database.prepare("SELECT title FROM episodes WHERE episode_index = 1").get()!.title, "安全替换");
    assert.equal(connection.database.prepare("SELECT COUNT(*) AS total FROM script_approval_events").get()!.total, 0);
  } finally {
    connection.close();
    await rm(root, { recursive: true, force: true });
  }
});
