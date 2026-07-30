import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import {
  listChapterEvents, prepareChapterEvents, queueChapterEventReplacement,
  replaceChapterEvents, type ChapterEventInput,
} from "./chapter-event-store.js";
import { commitCheckpoint } from "./checkpoint-store.js";
import { openDatabase } from "./database.js";
import { claimNextJob, createJob } from "./job-store.js";

async function fixture(prefix: string) {
  const dataRoot = await mkdtemp(join(tmpdir(), prefix));
  const connection = openDatabase(dataRoot);
  const text = "第一章\n宝玉走进大观园，拾起通灵宝玉。众人因此发现他的来历，留下新的悬念。";
  const bytes = Buffer.from(text, "utf8");
  const relativePath = "books/book_events/source.txt";
  const path = join(dataRoot, relativePath);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, bytes);
  const hash = createHash("sha256").update(bytes).digest("hex");
  connection.database.prepare(
    `INSERT INTO books (
       id, title, original_file_path, original_file_hash, encoding, import_status
     ) VALUES ('book_events', '测试书', ?, ?, 'UTF-8', 'ready')`,
  ).run(relativePath, hash);
  connection.database.prepare(
    `INSERT INTO chapters (
       id, book_id, chapter_index, title, byte_start, byte_end, char_count, content_hash
     ) VALUES ('chapter_events', 'book_events', 0, '第一章', 0, ?, ?, ?)`,
  ).run(bytes.length, [...text].length, hash);
  return { dataRoot, connection, path, bytes };
}

function source(bytes: Buffer, value: string) {
  const evidence = Buffer.from(value, "utf8");
  const byteStart = bytes.indexOf(evidence);
  assert.notEqual(byteStart, -1);
  return { byteStart, byteEnd: byteStart + evidence.length };
}

test("六类事件支持多段精确证据、稳定身份与分页查询", async () => {
  const context = await fixture("narralume-events-");
  try {
    const inputs: ChapterEventInput[] = [
      { type: "character", payload: { name: "宝玉" }, sources: [source(context.bytes, "宝玉")] },
      { type: "location", payload: { name: "大观园" }, sources: [source(context.bytes, "大观园")] },
      { type: "prop", payload: { name: "通灵宝玉" }, sources: [source(context.bytes, "通灵宝玉")] },
      {
        type: "causality", payload: { cause: "众人看到证据", effect: "发现来历" },
        sources: [source(context.bytes, "因此"), source(context.bytes, "发现他的来历")],
      },
      { type: "revelation", payload: { fact: "人物来历被揭示" }, sources: [source(context.bytes, "发现他的来历")] },
      { type: "suspense", payload: { question: "新的悬念是什么？" }, sources: [source(context.bytes, "新的悬念")] },
    ];
    const first = await replaceChapterEvents(
      context.connection.database, context.dataRoot, "book_events", "chapter_events", inputs,
    );
    assert.equal(first.length, 6);
    for (const [index, event] of first.entries()) {
      assert.equal(event.eventIndex, index);
      for (const evidence of event.sources) {
        const bytes = context.bytes.subarray(evidence.byteStart, evidence.byteEnd);
        assert.equal(evidence.sourceHash, createHash("sha256").update(bytes).digest("hex"));
        assert.equal(evidence.sourceText, bytes.toString("utf8"));
      }
    }

    const page = await listChapterEvents(
      context.connection.database, context.dataRoot, "book_events", "chapter_events", 2, 2,
    );
    assert.equal(page.total, 6);
    assert.deepEqual(page.items.map((event) => event.type), ["prop", "causality"]);
    assert.equal(page.items[1]?.sources.length, 2);

    const changed = inputs.map((event, index) => index === 0
      ? { ...event, payload: { name: "贾宝玉", detail: "摘要已修订" } }
      : event) as ChapterEventInput[];
    const second = await replaceChapterEvents(
      context.connection.database, context.dataRoot, "book_events", "chapter_events", changed,
    );
    assert.deepEqual(second.map((event) => event.id), first.map((event) => event.id));
    assert.deepEqual(second[0]?.payload, { name: "贾宝玉", detail: "摘要已修订" });
    const reordered = await prepareChapterEvents(
      context.connection.database, context.dataRoot, "book_events", "chapter_events", [...changed].reverse(),
    );
    assert.deepEqual(
      reordered.map((event) => event.id).sort(),
      second.map((event) => event.id).sort(),
    );
  } finally {
    context.connection.close();
    await rm(context.dataRoot, { recursive: true, force: true });
  }
});

test("GB18030 四字节字符只接受完整原始字节边界", async () => {
  const dataRoot = await mkdtemp(join(tmpdir(), "narralume-events-gb18030-"));
  const connection = openDatabase(dataRoot);
  const bytes = Buffer.from([
    0xb5, 0xda, 0xd2, 0xbb, 0xd5, 0xc2, 0x0a,
    0x95, 0x32, 0x82, 0x36,
  ]);
  const relativePath = "books/book_gb/source.txt";
  const path = join(dataRoot, relativePath);
  const hash = createHash("sha256").update(bytes).digest("hex");
  try {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, bytes);
    connection.database.prepare(
      `INSERT INTO books (
         id, title, original_file_path, original_file_hash, encoding, import_status
       ) VALUES ('book_gb', '测试书', ?, ?, 'GB18030', 'ready')`,
    ).run(relativePath, hash);
    connection.database.prepare(
      `INSERT INTO chapters (
         id, book_id, chapter_index, title, byte_start, byte_end, char_count, content_hash
       ) VALUES ('chapter_gb', 'book_gb', 0, '第一章', 0, ?, 5, ?)`,
    ).run(bytes.length, hash);
    const input: ChapterEventInput = {
      type: "revelation",
      payload: { fact: "出现非 BMP 字符" },
      sources: [{ byteStart: 7, byteEnd: 11 }],
    };
    const prepared = await prepareChapterEvents(
      connection.database, dataRoot, "book_gb", "chapter_gb", [input],
    );
    assert.equal(prepared[0]?.sources[0]?.sourceText, "𠀀");
    for (const invalid of [
      { byteStart: 8, byteEnd: 11 },
      { byteStart: 7, byteEnd: 8 },
      { byteStart: 7, byteEnd: 10 },
    ]) {
      await assert.rejects(
        prepareChapterEvents(
          connection.database, dataRoot, "book_gb", "chapter_gb",
          [{ ...input, sources: [invalid] }],
        ),
        /未对齐有效字符边界/,
      );
    }
  } finally {
    connection.close();
    await rm(dataRoot, { recursive: true, force: true });
  }
});

test("整章证据总量有界且超限不会写入事件", async () => {
  const dataRoot = await mkdtemp(join(tmpdir(), "narralume-events-budget-"));
  const connection = openDatabase(dataRoot);
  const bytes = Buffer.alloc(1024 * 1024, 0x61);
  const relativePath = "books/book_budget/source.txt";
  const path = join(dataRoot, relativePath);
  const hash = createHash("sha256").update(bytes).digest("hex");
  try {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, bytes);
    connection.database.prepare(
      `INSERT INTO books (
         id, title, original_file_path, original_file_hash, encoding, import_status
       ) VALUES ('book_budget', '预算测试', ?, ?, 'UTF-8', 'ready')`,
    ).run(relativePath, hash);
    connection.database.prepare(
      `INSERT INTO chapters (
         id, book_id, chapter_index, title, byte_start, byte_end, char_count, content_hash
       ) VALUES ('chapter_budget', 'book_budget', 0, '正文', 0, ?, ?, ?)`,
    ).run(bytes.length, bytes.length, hash);
    const inputs = Array.from({ length: 9 }, (_, occurrence): ChapterEventInput => ({
      type: "character",
      payload: { name: `人物 ${occurrence}` },
      occurrence,
      sources: [{ byteStart: 0, byteEnd: bytes.length }],
    }));
    await assert.rejects(
      prepareChapterEvents(connection.database, dataRoot, "book_budget", "chapter_budget", inputs),
      /每章原文证据总量不能超过 8388608 字节/,
    );
    assert.equal(connection.database.prepare("SELECT COUNT(*) AS count FROM chapter_events").get()?.count, 0);
  } finally {
    connection.close();
    await rm(dataRoot, { recursive: true, force: true });
  }
});

test("无效字符边界、原文漂移或写入故障均保留旧事件", async () => {
  const context = await fixture("narralume-events-rollback-");
  try {
    const valid: ChapterEventInput = {
      type: "character", payload: { name: "旧事件" }, sources: [source(context.bytes, "宝玉")],
    };
    await replaceChapterEvents(
      context.connection.database, context.dataRoot, "book_events", "chapter_events", [valid],
    );
    await assert.rejects(
      replaceChapterEvents(
        context.connection.database, context.dataRoot, "book_events", "chapter_events",
        [{ ...valid, sources: [{ byteStart: 1, byteEnd: 2 }] }],
      ),
      /未对齐有效字符边界/,
    );

    context.connection.database.exec(`
      CREATE TRIGGER reject_event BEFORE INSERT ON chapter_events
      WHEN NEW.payload_json LIKE '%触发失败%'
      BEGIN SELECT RAISE(ABORT, 'fault injection'); END;
    `);
    await assert.rejects(
      replaceChapterEvents(
        context.connection.database, context.dataRoot, "book_events", "chapter_events",
        [{ ...valid, payload: { name: "触发失败" } }],
      ),
      /fault injection/,
    );
    let saved = await listChapterEvents(
      context.connection.database, context.dataRoot, "book_events", "chapter_events", 10, 0,
    );
    assert.equal(saved.total, 1);
    assert.deepEqual(saved.items[0]?.payload, { name: "旧事件" });

    const changedBytes = Buffer.from(context.bytes);
    changedBytes[changedBytes.length - 1] = 0x21;
    await writeFile(context.path, changedBytes);
    await assert.rejects(
      prepareChapterEvents(
        context.connection.database, context.dataRoot, "book_events", "chapter_events", [valid],
      ),
      /原文内容已变化，请重新索引/,
    );
    await assert.rejects(
      listChapterEvents(
        context.connection.database, context.dataRoot, "book_events", "chapter_events", 10, 0,
      ),
      /原文内容已变化，请重新索引/,
    );
  } finally {
    context.connection.close();
    await rm(context.dataRoot, { recursive: true, force: true });
  }
});

test("事件与证据通过检查点受限事务原子提交且相同输入幂等跳过", async () => {
  const context = await fixture("narralume-events-checkpoint-");
  try {
    const input: ChapterEventInput = {
      type: "character", payload: { name: "检查点事件" }, sources: [source(context.bytes, "宝玉")],
    };
    const prepared = await prepareChapterEvents(
      context.connection.database, context.dataRoot, "book_events", "chapter_events", [input],
    );
    createJob(context.connection.database, { id: "job_events", type: "chapter-events", payload: {} }, 1_000);
    claimNextJob(context.connection.database, "worker-events", 10_000, 1_000);
    const inputHash = createHash("sha256").update("chapter-events-input").digest("hex");
    const first = commitCheckpoint(
      context.connection.database,
      { jobId: "job_events", stage: "chapter-events", scopeKey: "chapter_events", inputHash,
        workerId: "worker-events", now: 2_000 },
      (transaction) => {
        queueChapterEventReplacement(transaction, "chapter_events", prepared, 2_000);
        return undefined;
      },
    );
    let secondWriterCalled = false;
    const second = commitCheckpoint(
      context.connection.database,
      { jobId: "job_events", stage: "chapter-events", scopeKey: "chapter_events", inputHash,
        workerId: "worker-events", now: 3_000 },
      () => { secondWriterCalled = true; return undefined; },
    );
    assert.equal(first.created, true);
    assert.equal(second.created, false);
    assert.equal(secondWriterCalled, false);
    assert.equal(
      (await listChapterEvents(
        context.connection.database, context.dataRoot, "book_events", "chapter_events", 10, 0,
      )).total,
      1,
    );
    assert.equal(
      context.connection.database.prepare("SELECT COUNT(*) AS count FROM chapter_event_sources").get()?.count,
      1,
    );
  } finally {
    context.connection.close();
    await rm(context.dataRoot, { recursive: true, force: true });
  }
});

test("受限事务拒绝把准备好的事件写入另一章节", async () => {
  const context = await fixture("narralume-events-chapter-guard-");
  try {
    const prepared = await prepareChapterEvents(
      context.connection.database,
      context.dataRoot,
      "book_events",
      "chapter_events",
      [{ type: "character", payload: { name: "宝玉" }, sources: [source(context.bytes, "宝玉")] }],
    );
    let operations = 0;
    assert.throws(
      () => queueChapterEventReplacement(
        { run() { operations += 1; } },
        "chapter_other",
        prepared,
      ),
      /章节事件与目标章节不一致/,
    );
    assert.equal(operations, 0);
  } finally {
    context.connection.close();
    await rm(context.dataRoot, { recursive: true, force: true });
  }
});
