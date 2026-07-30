import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  createBookStoryBible,
  findBookStoryBibleForJob,
  getBookStoryBible,
  invalidateBookStoryBible,
} from "./book-story-bible-store.js";
import { openDatabase } from "./database.js";

function content(eventId: string, chapterId: string) {
  return {
    characters: [], relationships: [], locations: [], organizations: [], items: [], concepts: [],
    timeline: [{ summary: "主角得到线索", chapterIds: [chapterId], sourceEventIds: [eventId] }],
    flashbacks: [], plotThreads: [], confusingFacts: [], spoilerRestrictions: [], properNouns: [],
  };
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "narralume-bible-store-"));
  const connection = openDatabase(root);
  const db = connection.database;
  db.prepare(`INSERT INTO books
    (id,title,original_file_path,original_file_hash,encoding,import_status)
    VALUES ('book','书','books/book/source.txt',?,'UTF-8','ready')`).run("a".repeat(64));
  db.prepare(`INSERT INTO jobs (id,type,payload_json,status,run_after,created_at,updated_at)
    VALUES ('job_bible','book_story_bible_build','{}','succeeded',1,1,1)`).run();
  for (const [id, index] of [["chapter_1", 0], ["chapter_2", 1], ["chapter_3", 2]] as const) {
    db.prepare(`INSERT INTO chapters
      (id,book_id,chapter_index,title,byte_start,byte_end,char_count,content_hash)
      VALUES (?,'book',?,?,?, ?,10,?)`).run(id, index, id, index * 10, index * 10 + 10, `${index}`.repeat(64));
    db.prepare(`INSERT INTO chapter_events
      (id,chapter_id,event_index,occurrence,event_type,payload_json,created_at)
      VALUES (?,?,0,0,'revelation',?,1)`).run(`event_${index + 1}`, id, JSON.stringify({ summary: `线索${index + 1}` }));
    db.prepare(`INSERT INTO chapter_event_sources
      (event_id,source_index,source_byte_start,source_byte_end,source_hash)
      VALUES (?,0,?,?,?)`).run(`event_${index + 1}`, index * 10, index * 10 + 5, `${index + 3}`.repeat(64));
  }
  return { root, connection };
}

test("同一输入复用最新有效版本且 provider/model 不参与 identity", async () => {
  const current = await fixture();
  try {
    const base = {
      bookId: "book", scope: "interval" as const, sourceStartChapterId: "chapter_1",
      sourceEndChapterId: "chapter_2", sourceEventIds: ["event_2", "event_1"],
      providerId: "provider-a", model: "model-a", jobId: "job_bible",
      content: content("event_1", "chapter_1"),
    };
    const first = createBookStoryBible(current.connection.database, base, { now: 10 });
    const reused = createBookStoryBible(current.connection.database,
      { ...base, providerId: "provider-b", model: "model-b" }, { now: 20 });
    assert.equal(reused.id, first.id);
    assert.equal(reused.providerId, "provider-a");
    assert.equal(reused.revision, 1);
    assert.match(reused.sourceEventsHash, /^[0-9a-f]{64}$/u);
    assert.deepEqual(reused.sourceEventIds, ["event_1", "event_2"]);
    assert.equal(findBookStoryBibleForJob(current.connection.database, {
      jobId: "job_bible", bookId: "book", scope: "interval",
      sourceStartChapterId: "chapter_1", sourceEndChapterId: "chapter_2",
      sourceEventIds: ["event_2", "event_1"],
    })?.id, first.id);
    assert.equal(findBookStoryBibleForJob(current.connection.database, {
      jobId: "other_job", bookId: "book", scope: "interval",
      sourceStartChapterId: "chapter_1", sourceEndChapterId: "chapter_2",
      sourceEventIds: ["event_1", "event_2"],
    }), undefined);
  } finally {
    current.connection.close();
    await rm(current.root, { recursive: true, force: true });
  }
});

test("显式重建追加版本、失效后普通读取复用最新有效版本并在重启后保留", async () => {
  const current = await fixture();
  try {
    const input = {
      bookId: "book", scope: "final" as const, sourceStartChapterId: "chapter_1",
      sourceEndChapterId: "chapter_3", sourceEventIds: ["event_1", "event_2", "event_3"],
      providerId: "provider", model: "model", content: content("event_3", "chapter_3"),
    };
    const first = createBookStoryBible(current.connection.database, input, { now: 10 });
    const rebuilt = createBookStoryBible(current.connection.database, input, { forceRebuild: true, now: 20 });
    assert.notEqual(rebuilt.id, first.id);
    assert.equal(rebuilt.revision, 2);
    invalidateBookStoryBible(current.connection.database, rebuilt.id, 30);
    assert.equal(createBookStoryBible(current.connection.database, input, { now: 40 }).id, first.id);
    current.connection.close();
    const reopened = openDatabase(current.root);
    try {
      assert.equal(getBookStoryBible(reopened.database, first.id).contentHash, first.contentHash);
      assert.equal(getBookStoryBible(reopened.database, rebuilt.id).invalidatedAt, 30);
      assert.equal(reopened.database.prepare("SELECT COUNT(*) AS count FROM book_story_bibles").get()?.count, 2);
    } finally { reopened.close(); }
  } finally {
    try { current.connection.close(); } catch { /* 已关闭。 */ }
    await rm(current.root, { recursive: true, force: true });
  }
});

test("相同事件的不同父层输入不复用且各自维护 revision", async () => {
  const current = await fixture();
  try {
    const interval = createBookStoryBible(current.connection.database, {
      bookId: "book", scope: "interval", sourceStartChapterId: "chapter_1", sourceEndChapterId: "chapter_2",
      sourceEventIds: ["event_1", "event_2"], providerId: "p", model: "m",
      content: content("event_1", "chapter_1"),
    });
    const rebuiltInterval = createBookStoryBible(current.connection.database, {
      bookId: "book", scope: "interval", sourceStartChapterId: "chapter_1", sourceEndChapterId: "chapter_2",
      sourceEventIds: ["event_1", "event_2"], providerId: "p2", model: "m2",
      content: content("event_1", "chapter_1"),
    }, { forceRebuild: true });
    const finalInput = {
      bookId: "book", scope: "final" as const, sourceStartChapterId: "chapter_1", sourceEndChapterId: "chapter_3",
      sourceEventIds: ["event_1", "event_2", "event_3"], parentBibleIds: [interval.id],
      providerId: "p", model: "m", content: content("event_3", "chapter_3"),
    };
    const firstFinal = createBookStoryBible(current.connection.database, finalInput);
    const secondFinal = createBookStoryBible(current.connection.database,
      { ...finalInput, parentBibleIds: [rebuiltInterval.id] });
    assert.notEqual(secondFinal.id, firstFinal.id);
    assert.notEqual(secondFinal.inputHash, firstFinal.inputHash);
    assert.equal(firstFinal.revision, 1);
    assert.equal(secondFinal.revision, 1);
    assert.equal(createBookStoryBible(current.connection.database, finalInput).id, firstFinal.id);
    invalidateBookStoryBible(current.connection.database, interval.id);
    assert.equal(getBookStoryBible(current.connection.database, firstFinal.id).id, firstFinal.id,
      "父版本失效后冻结的 final 仍须可读");
  } finally {
    current.connection.close();
    await rm(current.root, { recursive: true, force: true });
  }
});

test("章节事件变化或删除后历史 revision 仍按冻结字段可读", async () => {
  const current = await fixture();
  try {
    const database = current.connection.database;
    const stored = createBookStoryBible(database, {
      bookId: "book", scope: "interval", sourceStartChapterId: "chapter_1", sourceEndChapterId: "chapter_2",
      sourceEventIds: ["event_1", "event_2"], providerId: "p", model: "m",
      content: content("event_1", "chapter_1"),
    });
    database.prepare("UPDATE chapter_events SET payload_json = ? WHERE id = 'event_1'")
      .run('{"summary":"已变化"}');
    assert.equal(getBookStoryBible(database, stored.id).sourceEventsHash, stored.sourceEventsHash);
    database.prepare("DELETE FROM chapter_events WHERE id IN ('event_1','event_2')").run();
    assert.equal(getBookStoryBible(database, stored.id).contentHash, stored.contentHash);
  } finally {
    current.connection.close();
    await rm(current.root, { recursive: true, force: true });
  }
});

test("Store trust boundary 拒绝伪造事件、范围外章节与持久内容篡改", async () => {
  const current = await fixture();
  try {
    const db = current.connection.database;
    const input = {
      bookId: "book", scope: "interval" as const, sourceStartChapterId: "chapter_1",
      sourceEndChapterId: "chapter_2", sourceEventIds: ["event_1"], providerId: "p", model: "m",
      content: content("event_1", "chapter_1"),
    };
    assert.throws(() => createBookStoryBible(db, { ...input, sourceEventIds: ["missing"] }), /不存在/);
    assert.throws(() => createBookStoryBible(db, { ...input, sourceEventIds: ["event_3"] }), /范围外/);
    assert.throws(() => createBookStoryBible(db, { ...input, content: content("event_1", "chapter_3") }), /范围外/);
    const stored = createBookStoryBible(db, input);
    assert.throws(
      () => db.prepare("UPDATE book_story_bibles SET content_hash = ? WHERE id = ?").run("0".repeat(64), stored.id),
      /immutable/,
    );
    assert.equal(getBookStoryBible(db, stored.id).contentHash, stored.contentHash);
    assert.throws(() => db.prepare(`INSERT INTO book_story_bibles (
      id,book_id,scope,source_start_chapter_id,source_end_chapter_id,source_event_ids_json,
      source_events_hash,parent_bible_ids_json,input_hash,contract_version,revision,provider_id,model,
      content_json,content_hash,created_at) VALUES
      ('bad','book','agent','chapter_1','chapter_1','["event_1"]',?,'[]',?,'v',1,'p','m','{}',?,1)`).run(
      "1".repeat(64), "2".repeat(64), "3".repeat(64)), /CHECK constraint failed/);
  } finally {
    current.connection.close();
    await rm(current.root, { recursive: true, force: true });
  }
});
