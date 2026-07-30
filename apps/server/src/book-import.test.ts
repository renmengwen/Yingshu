import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import test from "node:test";

import { importBookText } from "./book-import.js";
import { openDatabase } from "./database.js";

test("TXT 按流落盘并按内容哈希幂等认领", async () => {
  const dataRoot = await mkdtemp(join(tmpdir(), "narralume-import-"));
  const connection = openDatabase(dataRoot);
  const content = Buffer.from("第一章 起点\n这是一段真实原文。", "utf8");

  try {
    const first = await importBookText({
      stream: Readable.from([content.subarray(0, 8), content.subarray(8)]),
      fileName: "../测试书.txt",
      database: connection.database,
      dataRoot,
    });
    const duplicate = await importBookText({
      stream: Readable.from(content),
      fileName: "另一个名字.txt",
      database: connection.database,
      dataRoot,
    });

    assert.equal(first.created, true);
    assert.equal(first.book.title, "测试书");
    assert.match(first.book.id, /^book_[a-f0-9]{64}$/);
    assert.equal(duplicate.created, false);
    assert.equal(duplicate.book.id, first.book.id);
    assert.deepEqual(await readFile(join(dataRoot, first.book.original_file_path)), content);
    assert.equal(connection.database.prepare("SELECT COUNT(*) AS count FROM books").get()?.count, 1);
  } finally {
    connection.close();
    await rm(dataRoot, { recursive: true, force: true });
  }
});

test("超限导入失败并清理临时文件", async () => {
  const dataRoot = await mkdtemp(join(tmpdir(), "narralume-import-limit-"));
  const connection = openDatabase(dataRoot);

  try {
    await assert.rejects(
      importBookText({
        stream: Readable.from([Buffer.alloc(6), Buffer.alloc(6)]),
        fileName: "大文件.txt",
        database: connection.database,
        dataRoot,
        maxBytes: 10,
      }),
      /不能超过 10 字节/,
    );
    assert.deepEqual(await readdir(join(dataRoot, ".imports")), []);
    assert.equal(connection.database.prepare("SELECT COUNT(*) AS count FROM books").get()?.count, 0);
  } finally {
    connection.close();
    await rm(dataRoot, { recursive: true, force: true });
  }
});

test("并发重复导入只认领一份内容", async () => {
  const dataRoot = await mkdtemp(join(tmpdir(), "narralume-import-concurrent-"));
  const connection = openDatabase(dataRoot);
  const content = Buffer.from("并发导入的同一段原文", "utf8");

  try {
    const results = await Promise.all(
      Array.from({ length: 8 }, (_, index) =>
        importBookText({
          stream: Readable.from(content),
          fileName: `并发-${index}.txt`,
          database: connection.database,
          dataRoot,
        }),
      ),
    );

    assert.equal(results.filter((result) => result.created).length, 1);
    assert.equal(new Set(results.map((result) => result.book.id)).size, 1);
    assert.equal(connection.database.prepare("SELECT COUNT(*) AS count FROM books").get()?.count, 1);
    assert.deepEqual(await readdir(join(dataRoot, ".imports")), []);
  } finally {
    connection.close();
    await rm(dataRoot, { recursive: true, force: true });
  }
});

test("完整写入后的文件系统失败仍清理临时原文", async () => {
  const dataRoot = await mkdtemp(join(tmpdir(), "narralume-import-cleanup-"));
  const connection = openDatabase(dataRoot);

  try {
    await writeFile(join(dataRoot, "books"), "阻止创建书籍目录");
    await assert.rejects(
      importBookText({
        stream: Readable.from("必须被清理的原文"),
        fileName: "失败.txt",
        database: connection.database,
        dataRoot,
      }),
      /EEXIST/,
    );
    assert.deepEqual(await readdir(join(dataRoot, ".imports")), []);
    assert.equal(connection.database.prepare("SELECT COUNT(*) AS count FROM books").get()?.count, 0);
  } finally {
    connection.close();
    await rm(dataRoot, { recursive: true, force: true });
  }
});
