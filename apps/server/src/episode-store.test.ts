import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import { openDatabase } from "./database.js";
import {
  createSeriesProject, EpisodeStoreError, getEpisode, listEpisodes, listSeriesProjects, replaceEpisode,
} from "./episode-store.js";

async function fixture() {
  const dataRoot = await mkdtemp(join(tmpdir(), "narralume-episodes-"));
  const connection = openDatabase(dataRoot);
  const first = Buffer.from("第一章：宝玉初见黛玉。", "utf8");
  const second = Buffer.from("第二章：众人入住荣国府。", "utf8");
  const other = Buffer.from("别书章节：无关事件。", "utf8");
  const relativePath = "books/book_episode/source.txt";
  const otherRelativePath = "books/book_other/source.txt";
  await mkdir(dirname(join(dataRoot, relativePath)), { recursive: true });
  await mkdir(dirname(join(dataRoot, otherRelativePath)), { recursive: true });
  await writeFile(join(dataRoot, relativePath), Buffer.concat([first, second]));
  await writeFile(join(dataRoot, otherRelativePath), other);
  connection.database.prepare(
    `INSERT INTO books (
       id, title, original_file_path, original_file_hash, encoding, import_status
     ) VALUES (?, ?, ?, ?, 'UTF-8', 'ready')`,
  ).run("book_episode", "红楼梦", relativePath,
    createHash("sha256").update(Buffer.concat([first, second])).digest("hex"));
  connection.database.prepare(
    `INSERT INTO books (
       id, title, original_file_path, original_file_hash, encoding, import_status
     ) VALUES (?, ?, ?, ?, 'UTF-8', 'ready')`,
  ).run("book_other", "别书", otherRelativePath, createHash("sha256").update(other).digest("hex"));
  const chapters = [
    ["chapter_1", "book_episode", 0, "第一章", 0, first.length, first],
    ["chapter_2", "book_episode", 1, "第二章", first.length, first.length + second.length, second],
    ["chapter_other", "book_other", 0, "别章", 0, other.length, other],
  ] as const;
  for (const [id, bookId, index, title, start, end, bytes] of chapters) {
    connection.database.prepare(
      `INSERT INTO chapters (
         id, book_id, chapter_index, title, byte_start, byte_end, char_count, content_hash
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(id, bookId, index, title, start, end, bytes.toString("utf8").length,
      createHash("sha256").update(bytes).digest("hex"));
  }
  const evidence = [
    ["event_1", "chapter_1", 0, 0, first.indexOf(Buffer.from("宝玉")), Buffer.byteLength("宝玉")],
    ["event_2", "chapter_2", 0, first.length, second.indexOf(Buffer.from("荣国府")), Buffer.byteLength("荣国府")],
    ["event_other", "chapter_other", 0, 0, other.indexOf(Buffer.from("无关")), Buffer.byteLength("无关")],
  ] as const;
  for (const [eventId, chapterId, eventIndex, chapterStart, relativeStart, length] of evidence) {
    const start = chapterStart + relativeStart;
    const source = chapterId === "chapter_1" ? first : chapterId === "chapter_2" ? second : other;
    const sourceBytes = source.subarray(relativeStart, relativeStart + length);
    connection.database.prepare(
      `INSERT INTO chapter_events (
         id, chapter_id, event_index, occurrence, event_type, payload_json, created_at
       ) VALUES (?, ?, ?, 0, 'character', '{}', 1)`,
    ).run(eventId, chapterId, eventIndex);
    connection.database.prepare(
      `INSERT INTO chapter_event_sources (
         event_id, source_index, source_byte_start, source_byte_end, source_hash
       ) VALUES (?, 0, ?, ?, ?)`,
    ).run(eventId, start, start + length, createHash("sha256").update(sourceBytes).digest("hex"));
  }
  return { dataRoot, connection };
}

test("系列项目可创建并按书籍列出", async () => {
  const context = await fixture();
  try {
    const project = createSeriesProject(
      context.connection.database, { bookId: "book_episode", title: "红楼梦短剧" }, 10,
    );
    assert.equal(project.title, "红楼梦短剧");
    assert.deepEqual(listSeriesProjects(context.connection.database, "book_episode"), [project]);
  } finally {
    context.connection.close();
    await rm(context.dataRoot, { recursive: true, force: true });
  }
});

test("分集复制两章证据且相同序号幂等替换", async () => {
  const context = await fixture();
  try {
    const project = createSeriesProject(
      context.connection.database, { bookId: "book_episode", title: "红楼梦短剧" }, 10,
    );
    const input = {
      index: 1, title: "初入荣府", storyArc: "人物相遇并进入新环境",
      targetDurationSeconds: 240, recap: null, nextHook: "府中还有何人？",
      sourceEventIds: ["event_1", "event_2"],
    };
    assert.throws(
      () => replaceEpisode(context.connection.database, project.id, { ...input, index: 0 }, 20),
      /分集序号必须从 1 开始/,
    );
    const first = replaceEpisode(context.connection.database, project.id, input, 20);
    const second = replaceEpisode(
      context.connection.database, project.id, { ...input, title: "初入荣国府" }, 30,
    );
    assert.equal(second.id, first.id);
    assert.equal(context.connection.database.prepare("SELECT COUNT(*) AS count FROM episodes").get()?.count, 1);
    assert.equal(context.connection.database.prepare("SELECT COUNT(*) AS count FROM episode_sources").get()?.count, 2);
    const saved = await getEpisode(context.connection.database, context.dataRoot, project.id, 1);
    assert.equal(saved.title, "初入荣国府");
    assert.equal(saved.targetDurationSeconds, 240);
    assert.deepEqual(saved.sources.map((source) => source.chapterId), ["chapter_1", "chapter_2"]);
    assert.deepEqual(saved.sources.map((source) => source.sourceText), ["宝玉", "荣国府"]);
  } finally {
    context.connection.close();
    await rm(context.dataRoot, { recursive: true, force: true });
  }
});

test("分集支持可配置长时长并在最终保存边界拒绝跳章", async () => {
  const context = await fixture();
  try {
    const database = context.connection.database;
    const project = createSeriesProject(database, { bookId: "book_episode", title: "长篇" }, 10);
    assert.throws(() => replaceEpisode(database, project.id, {
      index: 1, title: "短", storyArc: "弧", targetDurationSeconds: 59, sourceEventIds: ["event_1"],
    }), /60 至 3600/);
    const long = replaceEpisode(database, project.id, {
      index: 1, title: "长", storyArc: "弧", targetDurationSeconds: 1200, sourceEventIds: ["event_1", "event_2"],
    });
    assert.equal(long.targetDurationSeconds, 1200);
    database.prepare(
      `INSERT INTO chapters (id, book_id, chapter_index, title, byte_start, byte_end, char_count, content_hash)
       VALUES ('chapter_gap', 'book_episode', 3, '第四章', 0, 3, 1, 'hash')`,
    ).run();
    database.prepare(
      `INSERT INTO chapter_events (id, chapter_id, event_index, occurrence, event_type, payload_json, created_at)
       VALUES ('event_gap', 'chapter_gap', 0, 0, 'revelation', '{"fact":"跳章"}', 1)`,
    ).run();
    database.prepare(
      `INSERT INTO chapter_event_sources (event_id, source_index, source_byte_start, source_byte_end, source_hash)
       VALUES ('event_gap', 0, 0, 3, ?)`,
    ).run(createHash("sha256").update(Buffer.from("第", "utf8")).digest("hex"));
    assert.throws(() => replaceEpisode(database, project.id, {
      index: 1, title: "跳章", storyArc: "弧", targetDurationSeconds: 1200,
      sourceEventIds: ["event_1", "event_gap"],
    }), /连续章节/);
  } finally {
    context.connection.close();
    await rm(context.dataRoot, { recursive: true, force: true });
  }
});

test("历史跳章分集即使同值 PUT 也会重新校验连续性，合法同值仍保持幂等", async () => {
  const context = await fixture();
  try {
    const database = context.connection.database;
    const project = createSeriesProject(database, { bookId: "book_episode", title: "历史连续性" }, 10);
    const input = {
      index: 1, title: "第一集", storyArc: "故事弧", targetDurationSeconds: 1200,
      recap: null, nextHook: null, sourceEventIds: ["event_1", "event_2"],
    };
    const created = replaceEpisode(database, project.id, input, 20);
    const legalSame = replaceEpisode(database, project.id, input, 30);
    assert.deepEqual(legalSame, created);
    database.prepare("UPDATE chapters SET chapter_index = 3 WHERE id = 'chapter_2'").run();
    assert.throws(() => replaceEpisode(database, project.id, input, 40), /连续章节范围/);
    assert.equal(database.prepare("SELECT updated_at FROM episodes WHERE id = ?").get(created.id)?.updated_at, 20);
  } finally {
    context.connection.close();
    await rm(context.dataRoot, { recursive: true, force: true });
  }
});

test("来源或时长变化会撤回旧批准，相同确认保持幂等", async () => {
  const context = await fixture();
  try {
    const database = context.connection.database;
    const project = createSeriesProject(database, { bookId: "book_episode", title: "批准" }, 10);
    const input = { index: 1, title: "第一集", storyArc: "弧", targetDurationSeconds: 240, sourceEventIds: ["event_1"] };
    const episode = replaceEpisode(database, project.id, input, 20);
    database.prepare(
      `INSERT INTO script_versions (id, episode_id, kind, version, content_json, content_hash, created_at)
       VALUES ('script_approved', ?, 'packaged', 1, '{}', ?, 20)`,
    ).run(episode.id, "a".repeat(64));
    database.prepare(
      `INSERT INTO script_approval_events (id, episode_id, revision, action, script_version_id, created_at)
       VALUES ('approval_1', ?, 1, 'approve', 'script_approved', 20)`,
    ).run(episode.id);
    replaceEpisode(database, project.id, input, 20);
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM script_approval_events").get()?.count, 1);
    replaceEpisode(database, project.id, { ...input, targetDurationSeconds: 1200 }, 20);
    const latest = database.prepare(
      "SELECT action, revision FROM script_approval_events WHERE episode_id = ? ORDER BY revision DESC LIMIT 1",
    ).get(episode.id);
    assert.equal(latest?.action, "withdraw");
    assert.equal(latest?.revision, 2);
  } finally {
    context.connection.close();
    await rm(context.dataRoot, { recursive: true, force: true });
  }
});

test("跨书事件在事务前被拒绝且旧分集保持不变", async () => {
  const context = await fixture();
  try {
    const project = createSeriesProject(
      context.connection.database, { bookId: "book_episode", title: "红楼梦短剧" }, 10,
    );
    replaceEpisode(context.connection.database, project.id, {
      index: 1, title: "旧标题", storyArc: "旧故事弧", targetDurationSeconds: 180,
      sourceEventIds: ["event_1"],
    }, 20);
    assert.throws(
      () => replaceEpisode(context.connection.database, project.id, {
        index: 1, title: "不应保存", storyArc: "错误故事弧", targetDurationSeconds: 200,
        sourceEventIds: ["event_1", "event_other"],
      }, 30),
      (error: unknown) => error instanceof EpisodeStoreError && error.statusCode === 409,
    );
    const saved = await getEpisode(context.connection.database, context.dataRoot, project.id, 1);
    assert.equal(saved.title, "旧标题");
    assert.deepEqual(saved.sources.map((source) => source.sourceEventId), ["event_1"]);
  } finally {
    context.connection.close();
    await rm(context.dataRoot, { recursive: true, force: true });
  }
});

test("分集列表按序号稳定返回并区分空系列与不存在系列", async () => {
  const context = await fixture();
  try {
    const database = context.connection.database;
    const project = createSeriesProject(database, { bookId: "book_episode", title: "列表" }, 10);
    assert.deepEqual(listEpisodes(database, project.id), []);
    replaceEpisode(database, project.id, {
      index: 2, title: "第二集", storyArc: "后续", targetDurationSeconds: 240,
      sourceEventIds: ["event_2"],
    }, 20);
    replaceEpisode(database, project.id, {
      index: 1, title: "第一集", storyArc: "开端", targetDurationSeconds: 240,
      sourceEventIds: ["event_1"],
    }, 30);
    assert.deepEqual(listEpisodes(database, project.id).map((episode) => episode.index), [1, 2]);
    assert.throws(
      () => listEpisodes(database, "missing"),
      (error: unknown) => error instanceof EpisodeStoreError && error.statusCode === 404,
    );
    assert.throws(
      () => listEpisodes(database, " "),
      (error: unknown) => error instanceof EpisodeStoreError && error.statusCode === 400,
    );
  } finally {
    context.connection.close();
    await rm(context.dataRoot, { recursive: true, force: true });
  }
});
