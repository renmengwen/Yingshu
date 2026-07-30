import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import Fastify from "fastify";

import { createBookStoryBible, invalidateBookStoryBible } from "./book-story-bible-store.js";
import { openDatabase } from "./database.js";
import { registerSeriesPipelineStoryBibleRoutes } from "./series-pipeline-story-bible-routes.js";

function content(eventId: string, chapterId: string) {
  const source = { sourceEventIds: [eventId] };
  return {
    characters: [{ canonicalName: "林舟", aliases: ["小舟"], identities: [{ text: "调查员", ...source }], motivations: [], stateChanges: [{ state: "发现入口", chapterIds: [chapterId], ...source }], ...source }],
    relationships: [{ subject: "林舟", object: "沈岚", relation: "同伴", chapterIds: [chapterId], ...source }],
    locations: [{ name: "旧站", aliases: [], detail: "封闭车站", ...source }],
    organizations: [{ name: "档案局", aliases: [], detail: "调查组织", ...source }],
    items: [{ name: "铜钥匙", aliases: [], detail: "开启侧门", ...source }],
    concepts: [{ name: "回声层", aliases: [], detail: "重复声音的区域", ...source }],
    timeline: [{ summary: "林舟进入旧站", chapterIds: [chapterId], ...source }],
    flashbacks: [{ summary: "旧站曾经停运", startChapterId: chapterId, endChapterId: chapterId, ...source }],
    plotThreads: [{ kind: "suspense", setup: "侧门后有回声", revealCondition: null, resolution: null, chapterIds: [chapterId], ...source }],
    confusingFacts: [{ statement: "车站时间异常", clarification: "原因未明", ...source }],
    spoilerRestrictions: [{ information: "侧门真相", forbiddenUntil: chapterId, ...source }],
    properNouns: [{ term: "回声层", pronunciation: "huí shēng céng", aliases: [], ...source }],
  };
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "narralume-worldview-read-"));
  const connection = openDatabase(root);
  const db = connection.database;
  db.prepare(`INSERT INTO books
    (id,title,original_file_path,original_file_hash,encoding,import_status)
    VALUES ('book','书','books/book/source.txt',?,'UTF-8','ready')`).run("a".repeat(64));
  db.prepare(`INSERT INTO chapters
    (id,book_id,chapter_index,title,byte_start,byte_end,char_count,content_hash)
    VALUES ('chapter','book',0,'开端',0,10,10,?)`).run("b".repeat(64));
  db.prepare(`INSERT INTO chapter_events
    (id,chapter_id,event_index,occurrence,event_type,payload_json,created_at)
    VALUES ('event','chapter',0,0,'revelation','{}',1)`).run();
  db.prepare(`INSERT INTO chapter_event_sources
    (event_id,source_index,source_byte_start,source_byte_end,source_hash)
    VALUES ('event',0,0,5,?)`).run("c".repeat(64));
  const insertSeries = db.prepare("INSERT INTO series_projects (id,book_id,title,created_at,updated_at) VALUES (?, 'book', ?, 1, 1)");
  for (const id of ["ready", "building", "failed", "damaged", "invalidated", "replacement"]) insertSeries.run(`series_${id}`, `系列 ${id}`);
  const current = createBookStoryBible(db, {
    bookId: "book", scope: "final", sourceStartChapterId: "chapter", sourceEndChapterId: "chapter",
    sourceEventIds: ["event"], providerId: "provider", model: "model", content: content("event", "chapter"),
  }, { now: 10 });
  const historical = createBookStoryBible(db, {
    bookId: "book", scope: "final", sourceStartChapterId: "chapter", sourceEndChapterId: "chapter",
    sourceEventIds: ["event"], providerId: "other", model: "other", content: content("event", "chapter"),
  }, { forceRebuild: true, now: 11 });
  invalidateBookStoryBible(db, historical.id, 12);
  const replaced = createBookStoryBible(db, {
    bookId: "book", scope: "final", sourceStartChapterId: "chapter", sourceEndChapterId: "chapter",
    sourceEventIds: ["event"], providerId: "replaced", model: "old", content: content("event", "chapter"),
  }, { forceRebuild: true, now: 13 });
  const replacement = createBookStoryBible(db, {
    bookId: "book", scope: "final", sourceStartChapterId: "chapter", sourceEndChapterId: "chapter",
    sourceEventIds: ["event"], providerId: "replacement", model: "new", content: content("event", "chapter"),
  }, { forceRebuild: true, now: 14 });
  const insertRun = db.prepare(`INSERT INTO series_pipeline_runs
    (id,series_project_id,status,episode_count,target_duration_seconds,source_start_chapter_id,source_end_chapter_id,
     config_hash,story_bible_id,failure_code,failure_message,created_at,updated_at)
    VALUES (?, ?, ?, 1, 60, 'chapter', 'chapter', ?, ?, ?, ?, 1, 1)`);
  insertRun.run("ready", "series_ready", "awaiting_review", "d".repeat(64), current.id, null, null);
  insertRun.run("building", "series_building", "building_story_bible", "e".repeat(64), null, null, null);
  insertRun.run("failed", "series_failed", "failed", "f".repeat(64), null, "provider_failed", "供应商失败");
  insertRun.run("damaged", "series_damaged", "awaiting_review", "1".repeat(64), "missing", null, null);
  insertRun.run("invalidated", "series_invalidated", "awaiting_review", "2".repeat(64), historical.id, null, null);
  insertRun.run("replaced", "series_replacement", "completed", "3".repeat(64), replaced.id, null, null);
  insertRun.run("replacement", "series_replacement", "awaiting_review", "4".repeat(64), replacement.id, null, null);
  const app = Fastify({ logger: false });
  await app.register(registerSeriesPipelineStoryBibleRoutes, { database: db });
  return { root, connection, app, current, historical, replaced, replacement };
}

test("GET 只按当前 run 身份读取 final 全书世界观", async () => {
  const current = await fixture();
  try {
    const response = await current.app.inject({ method: "GET", url: `/api/pipeline-runs/ready/full-book-worldview?bibleId=${current.historical.id}` });
    assert.equal(response.statusCode, 200, response.body);
    const body = response.json();
    assert.equal(body.worldview.metadata.revision, current.current.revision);
    assert.equal(body.worldview.metadata.provider, "provider");
    assert.deepEqual(Object.keys(body.worldview.content).sort(), [
      "characters", "concepts", "confusingFacts", "flashbacks", "items", "locations", "organizations",
      "plotThreads", "properNouns", "relationships", "spoilerRestrictions", "timeline",
    ]);
    assert.doesNotMatch(response.body, new RegExp(current.historical.id));
  } finally {
    await current.app.close();
    current.connection.close();
    await rm(current.root, { recursive: true, force: true });
  }
});

test("GET 区分未完成、失败、失效与身份损坏且不产生写入", async () => {
  const current = await fixture();
  try {
    const readChanges = () => (current.connection.database.prepare("SELECT total_changes() AS total").get() as { total: number }).total;
    const before = readChanges();
    for (const [runId, code, state] of [
      ["building", "full_book_worldview_building", "building"],
      ["failed", "full_book_worldview_failed", "failed"],
      ["invalidated", "full_book_worldview_invalidated", "invalidated"],
      ["damaged", "full_book_worldview_identity_damaged", "damaged"],
    ]) {
      const response = await current.app.inject({ method: "GET", url: `/api/pipeline-runs/${runId}/full-book-worldview` });
      assert.equal(response.statusCode, 409, response.body);
      assert.equal(response.json().code, code);
      assert.equal(response.json().state, state);
    }
    const missing = await current.app.inject({ method: "GET", url: "/api/pipeline-runs/missing/full-book-worldview" });
    assert.equal(missing.statusCode, 404);
    assert.equal(readChanges(), before);
  } finally {
    await current.app.close();
    current.connection.close();
    await rm(current.root, { recursive: true, force: true });
  }
});

test("GET 拒绝未显式失效但已被新 run 替换的 final 全书世界观", async () => {
  const current = await fixture();
  try {
    assert.equal(current.replaced.invalidatedAt, null);
    const oldResponse = await current.app.inject({
      method: "GET", url: "/api/pipeline-runs/replaced/full-book-worldview",
    });
    assert.equal(oldResponse.statusCode, 409, oldResponse.body);
    assert.equal(oldResponse.json().code, "full_book_worldview_non_current");
    assert.equal(oldResponse.json().state, "invalidated");

    const newResponse = await current.app.inject({
      method: "GET", url: "/api/pipeline-runs/replacement/full-book-worldview",
    });
    assert.equal(newResponse.statusCode, 200, newResponse.body);
    assert.equal(newResponse.json().worldview.metadata.provider, "replacement");
  } finally {
    await current.app.close();
    current.connection.close();
    await rm(current.root, { recursive: true, force: true });
  }
});
