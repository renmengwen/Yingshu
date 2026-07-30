import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import test from "node:test";

import { importBookText } from "./book-import.js";
import { indexBookChapters } from "./chapter-index.js";
import { openDatabase } from "./database.js";

test("UTF-8 BOM 原文生成稳定章节 ID、原始字节偏移并保留重复编号", async () => {
  const dataRoot = await mkdtemp(join(tmpdir(), "narralume-chapters-utf8-"));
  const connection = openDatabase(dataRoot);
  const first = Buffer.from("第1章 起点\n甲\n", "utf8");
  const second = Buffer.from("第1章 重逢\n乙", "utf8");
  const content = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), first, second]);

  try {
    const imported = await importBookText({
      stream: Readable.from(content),
      fileName: "utf8.txt",
      database: connection.database,
      dataRoot,
    });
    const firstIndex = await indexBookChapters({ book: imported.book, database: connection.database, dataRoot });
    const firstIds = firstIndex.chapters.map((chapter) => chapter.id);
    const secondIndex = await indexBookChapters({ book: imported.book, database: connection.database, dataRoot });

    assert.equal(firstIndex.encoding, "UTF-8");
    assert.deepEqual(firstIndex.chapters.map((chapter) => chapter.chapter_number), ["1", "1"]);
    assert.deepEqual(firstIndex.chapters.map((chapter) => chapter.byte_start), [3, 3 + first.length]);
    assert.deepEqual(firstIndex.chapters.map((chapter) => chapter.byte_end), [3 + first.length, content.length]);
    assert.deepEqual(secondIndex.chapters.map((chapter) => chapter.id), firstIds);
  } finally {
    connection.close();
    await rm(dataRoot, { recursive: true, force: true });
  }
});

test("GBK/CP936 文本按 GB18030 超集解码并索引", async () => {
  const dataRoot = await mkdtemp(join(tmpdir(), "narralume-chapters-gbk-"));
  const connection = openDatabase(dataRoot);
  const first = Buffer.from("b5dad2bbd5c220c6f0b5e30ac4dac8dd0a953282360a", "hex");
  const second = Buffer.from("b5dad2bbd5c220d6d8b8b40abaf3cec4", "hex");
  const content = Buffer.concat([first, second]);

  try {
    const imported = await importBookText({
      stream: Readable.from(content),
      fileName: "gbk.txt",
      database: connection.database,
      dataRoot,
    });
    const indexed = await indexBookChapters({ book: imported.book, database: connection.database, dataRoot });

    assert.equal(indexed.encoding, "GB18030");
    assert.deepEqual(indexed.chapters.map((chapter) => chapter.title), ["第一章 起点", "第一章 重复"]);
    assert.deepEqual(indexed.chapters.map((chapter) => chapter.byte_start), [0, first.length]);
    assert.equal(indexed.chapters[0]?.char_count, [...new TextDecoder("gb18030").decode(first)].length);
  } finally {
    connection.close();
    await rm(dataRoot, { recursive: true, force: true });
  }
});

test("编码判定覆盖完整文件且不受 64 KiB 字符边界影响", async () => {
  const dataRoot = await mkdtemp(join(tmpdir(), "narralume-chapters-boundary-"));
  const connection = openDatabase(dataRoot);
  const utf8 = Buffer.concat([Buffer.alloc(65534, 0x41), Buffer.from("中\n第1章 结尾", "utf8")]);
  const gbk = Buffer.concat([
    Buffer.alloc(65536, 0x41),
    Buffer.from([0x0a]),
    Buffer.from("b5dad2bbd5c220c6f0b5e3", "hex"),
  ]);

  try {
    for (const [fileName, content, expected] of [
      ["boundary-utf8.txt", utf8, "UTF-8"],
      ["ascii-prefix-gbk.txt", gbk, "GB18030"],
    ] as const) {
      const imported = await importBookText({
        stream: Readable.from(content),
        fileName,
        database: connection.database,
        dataRoot,
      });
      const indexed = await indexBookChapters({ book: imported.book, database: connection.database, dataRoot });
      assert.equal(indexed.encoding, expected);
    }
  } finally {
    connection.close();
    await rm(dataRoot, { recursive: true, force: true });
  }
});

test("超长单行被有界拒绝", async () => {
  const dataRoot = await mkdtemp(join(tmpdir(), "narralume-chapters-line-limit-"));
  const connection = openDatabase(dataRoot);

  try {
    const imported = await importBookText({
      stream: Readable.from(Buffer.alloc(1024 * 1024 + 1, 0x41)),
      fileName: "long-line.txt",
      database: connection.database,
      dataRoot,
    });
    await assert.rejects(
      indexBookChapters({ book: imported.book, database: connection.database, dataRoot }),
      /单行不能超过 1048576 字节/,
    );
  } finally {
    connection.close();
    await rm(dataRoot, { recursive: true, force: true });
  }
});
