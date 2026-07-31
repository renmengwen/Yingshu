import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { buildApp } from "./app.js";
import {
  EMPTY_BOOK_PROMPT_PROFILE,
  getBookPromptProfileRevision,
  saveBookPromptProfile,
} from "./book-prompt-profile-store.js";
import { openDatabase } from "./database.js";

test("本书专属提示词按书隔离、幂等保存并保留不可变历史版本", async () => {
  const dataRoot = await mkdtemp(join(tmpdir(), "narralume-book-prompt-"));
  const connection = openDatabase(dataRoot);
  try {
    connection.database.prepare(
      `INSERT INTO books (id,title,original_file_path,original_file_hash,encoding,import_status)
       VALUES (?,?,'books/source.txt',?,'utf-8','ready')`,
    ).run("book-a", "甲", "a");
    connection.database.prepare(
      `INSERT INTO books (id,title,original_file_path,original_file_hash,encoding,import_status)
       VALUES (?,?,'books/source.txt',?,'utf-8','ready')`,
    ).run("book-b", "乙", "b");

    const first = saveBookPromptProfile(connection.database, "book-a", {
      ...EMPTY_BOOK_PROMPT_PROFILE,
      sharedInstructions: "  全书共同要求\r\n第二行  ",
      storyBibleInstructions: "全书世界观要求",
    }, 10);
    const same = saveBookPromptProfile(connection.database, "book-a", {
      ...EMPTY_BOOK_PROMPT_PROFILE,
      sharedInstructions: "全书共同要求\n第二行",
      storyBibleInstructions: "全书世界观要求",
    }, 11);
    const second = saveBookPromptProfile(connection.database, "book-a", {
      ...EMPTY_BOOK_PROMPT_PROFILE,
      sharedInstructions: "新版",
    }, 12);

    assert.equal(first.revision, 1);
    assert.equal(same.revision, 1);
    assert.equal(second.revision, 2);
    assert.equal(getBookPromptProfileRevision(connection.database, "book-a", 1)?.sharedInstructions,
      "全书共同要求\n第二行");
    assert.equal(getBookPromptProfileRevision(connection.database, "book-b", 1), undefined);
    assert.throws(() => saveBookPromptProfile(connection.database, "book-a", {
      ...EMPTY_BOOK_PROMPT_PROFILE, unknown: "不能进入冻结身份",
    } as never), /字段集合无效/u);
    assert.throws(() => connection.database.prepare(
      "UPDATE book_prompt_profiles SET shared_instructions='篡改' WHERE book_id='book-a' AND revision=1",
    ).run(), /immutable/u);
  } finally {
    connection.close();
    await rm(dataRoot, { recursive: true, force: true });
  }
});

test("旧书籍提示词档案仍可独立保存且全局入口不展示书籍产品文案", async () => {
  const dataRoot = await mkdtemp(join(tmpdir(), "narralume-book-prompt-api-"));
  const setup = openDatabase(dataRoot);
  setup.database.prepare(
    `INSERT INTO books (id,title,original_file_path,original_file_hash,encoding,import_status)
     VALUES ('book','书','books/source.txt','hash','utf-8','ready')`,
  ).run();
  setup.close();
  const app = buildApp({ dataRoot, logger: false });
  try {
    const products = await app.inject({ method: "GET", url: "/api/product-prompts" });
    assert.equal(products.statusCode, 200);
    assert.deepEqual(products.json().settings, {
      scriptInstructions: "", visualInstructions: "", updatedAt: 0,
    });

    const initial = await app.inject({ method: "GET", url: "/api/books/book/prompt-profile" });
    assert.equal(initial.statusCode, 200);
    assert.equal(initial.json().profile.revision, 0);

    const saved = await app.inject({
      method: "PUT",
      url: "/api/books/book/prompt-profile",
      payload: { ...EMPTY_BOOK_PROMPT_PROFILE, storyBibleInstructions: "突出专有名词" },
    });
    assert.equal(saved.statusCode, 200);
    assert.equal(saved.json().profile.revision, 1);
    assert.equal(saved.json().profile.storyBibleInstructions, "突出专有名词");

    const missing = await app.inject({ method: "GET", url: "/api/books/missing/prompt-profile" });
    assert.equal(missing.statusCode, 404);
  } finally {
    await app.close();
    await rm(dataRoot, { recursive: true, force: true });
  }
});
