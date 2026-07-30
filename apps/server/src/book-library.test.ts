import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import {
  BookLibraryError, cleanupPendingBookDeletions, deleteBook, deleteChapter, readChapterText,
} from "./book-library.js";
import { withDataFileMutationLock } from "./data-file-mutation-lock.js";
import { openDatabase } from "./database.js";

test("原文读取覆盖 GB18030 非零切片、短读关闭、严格解码与路径边界", async () => {
  const dataRoot = await mkdtemp(join(tmpdir(), "narralume-library-"));
  const connection = openDatabase(dataRoot);

  function insertBook(id: string, relativePath: string, encoding: string) {
    connection.database.prepare(
      `INSERT INTO books (id, title, original_file_path, original_file_hash, encoding, import_status)
       VALUES (?, ?, ?, ?, ?, 'ready')`,
    ).run(id, id, relativePath, `hash_${id}`, encoding);
  }

  function insertChapter(id: string, bookId: string, byteStart: number, byteEnd: number) {
    connection.database.prepare(
      `INSERT INTO chapters (
         id, book_id, chapter_index, title, byte_start, byte_end, char_count, content_hash
       ) VALUES (?, ?, 0, '第一章', ?, ?, 0, ?)`,
    ).run(id, bookId, byteStart, byteEnd, `hash_${id}`);
  }

  try {
    const prefix = Buffer.from("ignored\n", "ascii");
    const gb18030Chapter = Buffer.from([
      0xb5, 0xda, 0xd2, 0xbb, 0xd5, 0xc2, 0x0a,
      0xd5, 0xfd, 0xce, 0xc4, 0xc4, 0xda, 0xc8, 0xdd,
    ]);
    const gbPath = join(dataRoot, "books", "gb", "source.txt");
    await mkdir(dirname(gbPath), { recursive: true });
    await writeFile(gbPath, Buffer.concat([prefix, gb18030Chapter]));
    insertBook("book_gb", "books/gb/source.txt", "GB18030");
    insertChapter("chapter_gb", "book_gb", prefix.length, prefix.length + gb18030Chapter.length);

    assert.equal(
      await readChapterText(connection.database, dataRoot, "book_gb", "chapter_gb"),
      "第一章\n正文内容",
    );

    await writeFile(gbPath, prefix);
    await assert.rejects(
      readChapterText(connection.database, dataRoot, "book_gb", "chapter_gb"),
      (error: unknown) => error instanceof BookLibraryError && error.message === "原文文件不完整",
    );
    const renamedGbPath = `${gbPath}.closed`;
    await rename(gbPath, renamedGbPath);

    const invalidPath = join(dataRoot, "books", "invalid", "source.txt");
    await mkdir(dirname(invalidPath), { recursive: true });
    await writeFile(invalidPath, Buffer.from([0x81]));
    insertBook("book_invalid", "books/invalid/source.txt", "UTF-8");
    insertChapter("chapter_invalid", "book_invalid", 0, 1);
    await assert.rejects(
      readChapterText(connection.database, dataRoot, "book_invalid", "chapter_invalid"),
      (error: unknown) => error instanceof BookLibraryError && error.message === "原文编码无效",
    );
    await rename(invalidPath, `${invalidPath}.closed`);

    insertBook("book_escape", "../outside.txt", "UTF-8");
    insertChapter("chapter_escape", "book_escape", 0, 1);
    await assert.rejects(
      readChapterText(connection.database, dataRoot, "book_escape", "chapter_escape"),
      (error: unknown) => error instanceof BookLibraryError && error.message === "原文路径无效",
    );
  } finally {
    connection.close();
    await rm(dataRoot, { recursive: true, force: true });
  }
});

test("删除章节清理事件和分析任务、保留原文索引身份，并拒绝破坏分集证据", async () => {
  const dataRoot = await mkdtemp(join(tmpdir(), "narralume-library-delete-"));
  const connection = openDatabase(dataRoot);
  const database = connection.database;
  try {
    database.prepare(
      `INSERT INTO books (id, title, original_file_path, original_file_hash, encoding, import_status)
       VALUES ('book', '书', 'books/book/source.txt', 'hash', 'UTF-8', 'ready')`,
    ).run();
    const insertChapter = database.prepare(
      `INSERT INTO chapters (id, book_id, chapter_index, title, byte_start, byte_end, char_count, content_hash)
       VALUES (?, 'book', ?, ?, ?, ?, 1, ?)`,
    );
    insertChapter.run("chapter_0", 0, "正文", 0, 1, "hash_0");
    insertChapter.run("chapter_1", 1, "第一章", 1, 2, "hash_1");
    database.prepare(
      `INSERT INTO chapter_events (id, chapter_id, event_index, occurrence, event_type, payload_json, created_at)
       VALUES ('event_0', 'chapter_0', 0, 0, 'character', '{}', 1)`,
    ).run();
    database.prepare(
      `INSERT INTO jobs (id, type, payload_json, status, run_after, created_at, updated_at)
       VALUES ('job_0', 'chapter_events_analyze', ?, 'succeeded', 1, 1, 1)`,
    ).run(JSON.stringify({ bookId: "book", chapterId: "chapter_0" }));
    database.prepare(
      `INSERT INTO jobs (id, type, payload_json, status, result_json, run_after, created_at, updated_at)
       VALUES ('job_recommend', 'episode_sources_recommend', ?, 'succeeded', ?, 1, 1, 1)`,
    ).run(
      JSON.stringify({ bookId: "book", startChapterId: "chapter_0" }),
      JSON.stringify({ chapterIds: ["chapter_0"], eventIds: ["event_0"] }),
    );
    database.prepare(
      `INSERT INTO jobs (id, type, payload_json, status, run_after, created_at, updated_at)
       VALUES ('job_active', 'episode_sources_recommend', ?, 'queued', 1, 1, 1)`,
    ).run(JSON.stringify({ startChapterId: "chapter_0" }));

    assert.throws(
      () => deleteChapter(database, "book", "chapter_0"),
      (error: unknown) => error instanceof BookLibraryError && error.statusCode === 409,
    );
    database.prepare("DELETE FROM jobs WHERE id = 'job_active'").run();
    assert.deepEqual(deleteChapter(database, "book", "chapter_0"), { id: "chapter_0", title: "正文" });
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM chapter_events WHERE id = 'event_0'").get()?.count, 0);
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM jobs WHERE id = 'job_0'").get()?.count, 0);
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM jobs WHERE id = 'job_recommend'").get()?.count, 0);
    assert.equal(database.prepare("SELECT chapter_index FROM chapters WHERE id = 'chapter_1'").get()?.chapter_index, 1);

    database.prepare(
      `INSERT INTO series_projects (id, book_id, title, created_at, updated_at)
       VALUES ('series', 'book', '系列', 1, 1)`,
    ).run();
    database.prepare(
      `INSERT INTO episodes (id, series_project_id, episode_index, title, story_arc, target_duration_seconds, created_at, updated_at)
       VALUES ('episode', 'series', 1, '第一集', '故事弧', 1200, 1, 1)`,
    ).run();
    database.prepare(
      `INSERT INTO episode_sources (episode_id, source_index, chapter_id, source_event_id, source_byte_start, source_byte_end, source_hash)
       VALUES ('episode', 0, 'chapter_1', 'event_1', 1, 2, ?)`,
    ).run("a".repeat(64));
    assert.throws(
      () => deleteChapter(database, "book", "chapter_1"),
      (error: unknown) => error instanceof BookLibraryError && error.statusCode === 409,
    );
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM chapters WHERE id = 'chapter_1'").get()?.count, 1);
  } finally {
    connection.close();
    await rm(dataRoot, { recursive: true, force: true });
  }
});

test("删除小说清理全部项目与关联任务，并保留其他小说共享的候选文件", async () => {
  const dataRoot = await mkdtemp(join(tmpdir(), "narralume-book-delete-"));
  const connection = openDatabase(dataRoot);
  const database = connection.database;
  const bookDirectory = join(dataRoot, "books", "book");
  const episodeDirectory = join(dataRoot, "episodes", "episode");
  const uniqueHash = "2".repeat(64);
  const sharedHash = "4".repeat(64);
  const uniqueRelativePath = `assets/candidates/22/${uniqueHash}.png`;
  const sharedRelativePath = `assets/candidates/44/${sharedHash}.png`;
  const uniqueCandidate = join(dataRoot, uniqueRelativePath);
  const sharedCandidate = join(dataRoot, sharedRelativePath);
  try {
    await mkdir(bookDirectory, { recursive: true });
    await mkdir(episodeDirectory, { recursive: true });
    await mkdir(dirname(uniqueCandidate), { recursive: true });
    await mkdir(dirname(sharedCandidate), { recursive: true });
    await writeFile(join(bookDirectory, "source.txt"), "测试小说");
    await writeFile(join(episodeDirectory, "audio.wav"), "audio");
    await writeFile(uniqueCandidate, "unique");
    await writeFile(sharedCandidate, "shared");

    const insertBook = database.prepare(
      `INSERT INTO books (id, title, original_file_path, original_file_hash, encoding, import_status)
       VALUES (?, ?, ?, ?, 'UTF-8', 'ready')`,
    );
    insertBook.run("book", "测试小说", "books/book/source.txt", "book_hash");
    insertBook.run("other_book", "保留小说", "books/other_book/source.txt", "other_hash");
    database.prepare(
      `INSERT INTO chapters (id, book_id, chapter_index, title, byte_start, byte_end, char_count, content_hash)
       VALUES ('chapter', 'book', 0, '第一章', 0, 1, 1, 'chapter_hash')`,
    ).run();
    database.prepare(
      `INSERT INTO series_projects (id, book_id, title, created_at, updated_at) VALUES
       ('series', 'book', '测试系列', 1, 1), ('other_series', 'other_book', '保留系列', 1, 1)`,
    ).run();
    database.prepare(
      `INSERT INTO episodes (id, series_project_id, episode_index, title, story_arc, target_duration_seconds, created_at, updated_at)
       VALUES ('episode', 'series', 1, '第一集', '故事弧', 1200, 1, 1)`,
    ).run();
    database.prepare(
      `INSERT INTO assets (id, series_project_id, asset_type, asset_role, canonical_name, normalized_name, created_at) VALUES
       ('asset_unique', 'series', 'scene', 'master', '独占资产', '独占资产', 1),
       ('asset_shared', 'series', 'scene', 'master', '共享资产', '共享资产', 1),
       ('other_asset', 'other_series', 'scene', 'master', '保留资产', '保留资产', 1)`,
    ).run();
    const insertCandidate = database.prepare(
      `INSERT INTO asset_candidates (
         id, asset_id, source_kind, source_identity_hash, source_json, file_hash,
         mime, width, height, bytes, relative_path, created_at
       ) VALUES (?, ?, 'upload', ?, '{}', ?, 'image/png', 32, 32, 1, ?, 1)`,
    );
    insertCandidate.run("candidate_unique", "asset_unique", "1".repeat(64), uniqueHash, uniqueRelativePath);
    insertCandidate.run("candidate_shared", "asset_shared", "3".repeat(64), sharedHash, sharedRelativePath);
    insertCandidate.run("other_candidate", "other_asset", "5".repeat(64), sharedHash, sharedRelativePath);
    const insertJob = database.prepare(
      `INSERT INTO jobs (id, type, payload_json, status, run_after, created_at, updated_at)
       VALUES (?, 'test', ?, ?, 1, 1, 1)`,
    );
    insertJob.run("job_running", JSON.stringify({ episodeId: "episode" }), "queued");
    insertJob.run("job_queued", JSON.stringify({ candidateId: "candidate_unique" }), "queued");
    insertJob.run("job_other", JSON.stringify({ seriesId: "other_series" }), "succeeded");
    database.prepare(
      `INSERT INTO series_pipeline_runs (
         id, series_project_id, status, episode_count, target_duration_seconds,
         source_start_chapter_id, source_end_chapter_id, config_hash, created_at, updated_at
       ) VALUES ('pipeline', 'series', 'configured', 1, 180, 'chapter', 'chapter', ?, 1, 1)`,
    ).run("6".repeat(64));
    database.prepare(
      `INSERT INTO series_pipeline_jobs (run_id, stage, subject_type, subject_id, job_id, created_at)
       VALUES ('pipeline', 'chapter_analysis', 'chapter', 'chapter', 'job_queued', 1)`,
    ).run();
    database.prepare(
      `INSERT INTO book_story_bibles (
         id, book_id, scope, source_start_chapter_id, source_end_chapter_id,
         source_event_ids_json, source_events_hash, parent_bible_ids_json, input_hash,
         contract_version, revision, provider_id, model, job_id, content_json, content_hash, created_at
       ) VALUES (
         'bible', 'book', 'interval', 'chapter', 'chapter', '["event"]', ?, '[]', ?,
         'test', 1, 'provider', 'model', 'job_queued', '{}', ?, 1
       )`,
    ).run("7".repeat(64), "8".repeat(64), "9".repeat(64));
    database.prepare(
      "UPDATE jobs SET status = 'running', lease_owner = 'worker', lease_expires_at = 999999 WHERE id = 'job_running'",
    ).run();

    await assert.rejects(
      deleteBook(database, dataRoot, "book"),
      (error: unknown) => error instanceof BookLibraryError && error.statusCode === 409,
    );
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM books WHERE id = 'book'").get()?.count, 1);
    assert.equal(await readFile(join(bookDirectory, "source.txt"), "utf8"), "测试小说");

    database.prepare(
      "UPDATE jobs SET status = 'cancelled', lease_owner = NULL, lease_expires_at = NULL WHERE id = 'job_running'",
    ).run();
    database.prepare(
      "UPDATE asset_candidates SET relative_path = 'config/models.json' WHERE id = 'candidate_unique'",
    ).run();
    await assert.rejects(
      deleteBook(database, dataRoot, "book"),
      (error: unknown) => error instanceof BookLibraryError && error.statusCode === 500,
    );
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM books WHERE id = 'book'").get()?.count, 1);
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM books WHERE id = 'other_book'").get()?.count, 1);
    database.prepare("UPDATE asset_candidates SET relative_path = ? WHERE id = 'candidate_unique'").run(uniqueRelativePath);
    assert.deepEqual(await deleteBook(database, dataRoot, "book"), {
      id: "book", title: "测试小说", fileCleanupComplete: true,
    });
    for (const table of ["books", "chapters", "series_projects", "episodes", "assets", "asset_candidates"]) {
      assert.equal(database.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE id IN (
        'book', 'chapter', 'series', 'episode', 'asset_unique', 'asset_shared', 'candidate_unique', 'candidate_shared'
      )`).get()?.count, 0, table);
    }
    for (const table of ["series_pipeline_runs", "series_pipeline_jobs", "book_story_bibles"]) {
      assert.equal(database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get()?.count, 0, table);
    }
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM jobs WHERE id IN ('job_running', 'job_queued')").get()?.count, 0);
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM books WHERE id = 'other_book'").get()?.count, 1);
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM asset_candidates WHERE id = 'other_candidate'").get()?.count, 1);
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM jobs WHERE id = 'job_other'").get()?.count, 1);
    await assert.rejects(readFile(join(bookDirectory, "source.txt")));
    await assert.rejects(readFile(join(episodeDirectory, "audio.wav")));
    await assert.rejects(readFile(uniqueCandidate));
    assert.equal(await readFile(sharedCandidate, "utf8"), "shared");
  } finally {
    connection.close();
    await rm(dataRoot, { recursive: true, force: true });
  }
});

test("未完成的整书文件清理会保留耐久清单并可在启动时重试", async () => {
  const dataRoot = await mkdtemp(join(tmpdir(), "narralume-book-delete-retry-"));
  const connection = openDatabase(dataRoot);
  const bookDirectory = join(dataRoot, "books", "deleted_book");
  const manifestDirectory = join(dataRoot, ".trash", "book-deletions");
  const manifestPath = join(manifestDirectory, "abc123.json");
  try {
    await mkdir(bookDirectory, { recursive: true });
    await mkdir(manifestDirectory, { recursive: true });
    await writeFile(join(bookDirectory, "source.txt"), "待清理");
    await writeFile(manifestPath, JSON.stringify({
      version: 1, bookId: "deleted_book", paths: ["books/deleted_book"],
    }));

    const failed = await cleanupPendingBookDeletions(
      connection.database,
      dataRoot,
      (async () => { throw new Error("模拟 Windows 文件占用"); }) as typeof rm,
    );
    assert.deepEqual(failed, { completed: 0, pending: 1 });
    assert.equal(await readFile(join(bookDirectory, "source.txt"), "utf8"), "待清理");
    assert.equal(JSON.parse(await readFile(manifestPath, "utf8")).bookId, "deleted_book");

    assert.deepEqual(await cleanupPendingBookDeletions(connection.database, dataRoot), { completed: 1, pending: 0 });
    await assert.rejects(readFile(join(bookDirectory, "source.txt")));
    await assert.rejects(readFile(manifestPath));
  } finally {
    connection.close();
    await rm(dataRoot, { recursive: true, force: true });
  }
});

test("整书清理等待并发候选发布登记完成后保留新引用文件", async () => {
  const dataRoot = await mkdtemp(join(tmpdir(), "narralume-book-delete-race-"));
  const connection = openDatabase(dataRoot);
  const database = connection.database;
  const fileHash = "9".repeat(64);
  const relativePath = `assets/candidates/99/${fileHash}.png`;
  const candidatePath = join(dataRoot, relativePath);
  const manifestDirectory = join(dataRoot, ".trash", "book-deletions");
  try {
    database.prepare(
      `INSERT INTO books (id, title, original_file_path, original_file_hash, encoding, import_status)
       VALUES ('other_book', '保留小说', 'books/other_book/source.txt', 'other_hash', 'UTF-8', 'ready')`,
    ).run();
    database.prepare(
      `INSERT INTO series_projects (id, book_id, title, created_at, updated_at)
       VALUES ('other_series', 'other_book', '保留系列', 1, 1)`,
    ).run();
    database.prepare(
      `INSERT INTO assets (id, series_project_id, asset_type, asset_role, canonical_name, normalized_name, created_at)
       VALUES ('other_asset', 'other_series', 'scene', 'master', '保留资产', '保留资产', 1)`,
    ).run();
    await mkdir(dirname(candidatePath), { recursive: true });
    await mkdir(manifestDirectory, { recursive: true });
    await writeFile(join(manifestDirectory, "def456.json"), JSON.stringify({
      version: 1, bookId: "deleted_book", paths: [relativePath],
    }));

    let finishPublishing!: () => void;
    let published!: () => void;
    const publishingStarted = new Promise<void>((resolve) => { published = resolve; });
    const publisher = withDataFileMutationLock(dataRoot, async () => {
      await writeFile(candidatePath, "new candidate");
      published();
      await new Promise<void>((resolve) => { finishPublishing = resolve; });
      database.prepare(
        `INSERT INTO asset_candidates (
           id, asset_id, source_kind, source_identity_hash, source_json, file_hash,
           mime, width, height, bytes, relative_path, created_at
         ) VALUES ('new_candidate', 'other_asset', 'upload', ?, '{}', ?, 'image/png', 32, 32, 13, ?, 1)`,
      ).run("8".repeat(64), fileHash, relativePath);
    });
    await publishingStarted;
    const cleanup = cleanupPendingBookDeletions(database, dataRoot);
    await Promise.resolve();
    finishPublishing();
    await publisher;

    assert.deepEqual(await cleanup, { completed: 0, pending: 1 });
    assert.equal(await readFile(candidatePath, "utf8"), "new candidate");
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM asset_candidates WHERE id = 'new_candidate'").get()?.count, 1);
  } finally {
    connection.close();
    await rm(dataRoot, { recursive: true, force: true });
  }
});
