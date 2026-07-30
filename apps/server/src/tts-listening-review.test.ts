import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { canonicalBookStoryBibleJson, type BookStoryBibleContent } from "./book-story-bible-contract.js";
import { addAssetAliases, createAsset } from "./asset-store.js";
import { openDatabase } from "./database.js";
import { getJob } from "./job-store.js";
import { JobWorker } from "./job-worker.js";
import {
  createTtsListeningReviewJobHandler, enqueueTtsListeningReview, getTtsListeningReviewWorkspace,
  representativeSegmentIndexes, TTS_LISTENING_REVIEW_JOB_TYPE,
} from "./tts-listening-review.js";

const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const TIMELINE = "a".repeat(64);

type Noun = { term: string; pronunciation: string; aliases: string[] };
interface FixtureOptions {
  withoutBible?: boolean;
  finalNouns?: Noun[];
  parentNouns?: Noun[];
  parentState?: "valid" | "missing" | "invalid";
  unrelatedNouns?: Noun[];
}

function bibleJson(nouns: Noun[]) {
  const content: BookStoryBibleContent = {
    characters: [], relationships: [], locations: [], organizations: [], items: [], concepts: [], timeline: [],
    flashbacks: [], plotThreads: [], spoilerRestrictions: [],
    confusingFacts: [{ statement: "事实", clarification: "说明", sourceEventIds: ["event"] }],
    properNouns: nouns.map((noun) => ({ ...noun, sourceEventIds: ["event"] })),
  };
  return canonicalBookStoryBibleJson(content);
}

async function fixture(
  texts = ["开头", "张起灵来到墓道", "中段", "吴邪发现线索", "结尾"],
  options: FixtureOptions = {},
) {
  const root = await mkdtemp(join(tmpdir(), "narralume-listening-"));
  const connection = openDatabase(root);
  const db = connection.database;
  db.prepare(`INSERT INTO books (id,title,original_file_path,original_file_hash,encoding,import_status)
    VALUES ('book','书','book.txt',?,'utf-8','ready')`).run("1".repeat(64));
  db.prepare(`INSERT INTO chapters (id,book_id,chapter_index,title,byte_start,byte_end,char_count,content_hash)
    VALUES ('chapter','book',0,'章',0,1,1,?)`).run("2".repeat(64));
  db.prepare("INSERT INTO series_projects (id,book_id,title,created_at,updated_at) VALUES ('series','book','系列',1,1)").run();
  db.prepare(`INSERT INTO episodes (id,series_project_id,episode_index,title,story_arc,target_duration_seconds,created_at,updated_at)
    VALUES ('episode','series',1,'一','弧',240,1,1)`).run();
  const contentJson = JSON.stringify({ paragraphs: [{ text: "稿", sourceIndexes: [0] }] });
  db.prepare(`INSERT INTO script_versions (id,episode_id,kind,version,parent_version_id,content_json,content_hash,created_at)
    VALUES ('script','episode','packaged',1,NULL,?,?,1)`).run(contentJson, hash(contentJson));
  db.prepare(`INSERT INTO script_approval_events (id,episode_id,revision,action,script_version_id,created_at)
    VALUES ('approval','episode',1,'approve','script',1)`).run();
  const finalNouns = options.finalNouns ?? [
    { term: "张起灵", pronunciation: "zhāng qǐ líng", aliases: ["小哥"] },
    { term: "吴邪", pronunciation: "wú xié", aliases: [] },
    { term: "未出现", pronunciation: "wèi chū xiàn", aliases: [] },
  ];
  const sourceEventsHash = "3".repeat(64);
  const insertBible = (id: string, scope: "interval" | "final", nouns: Noun[], parents: Array<{ id: string; contentHash: string }>, revision = 1) => {
    const content = bibleJson(nouns);
    db.prepare(`INSERT INTO book_story_bibles
      (id,book_id,scope,source_start_chapter_id,source_end_chapter_id,source_event_ids_json,source_events_hash,
       parent_bible_ids_json,input_hash,contract_version,revision,provider_id,model,content_json,content_hash,created_at)
      VALUES (?,'book',?,'chapter','chapter','["event"]',?,?,?,'book-story-bible-v1',?,'provider','model',?,?,1)`)
      .run(id, scope, sourceEventsHash, JSON.stringify(parents),
        hash(JSON.stringify({ sourceEventsHash, parents })), revision, content, hash(content));
    return { id, contentHash: hash(content) };
  };
  let frozenParents: Array<{ id: string; contentHash: string }> = [];
  if (options.parentNouns) {
    const snapshot = { id: "interval", contentHash: hash(bibleJson(options.parentNouns)) };
    frozenParents = [snapshot];
    if (options.parentState !== "missing") insertBible("interval", "interval", options.parentNouns, []);
  }
  if (options.unrelatedNouns) insertBible("old-interval", "interval", options.unrelatedNouns, [], 2);
  if (!options.withoutBible) insertBible("bible", "final", finalNouns, frozenParents);
  if (options.parentState === "invalid") {
    db.prepare("UPDATE book_story_bibles SET invalidated_at = 2 WHERE id = 'interval'").run();
  }
  db.prepare(`INSERT INTO series_pipeline_runs
    (id,series_project_id,status,episode_count,target_duration_seconds,source_start_chapter_id,source_end_chapter_id,
     config_hash,story_bible_id,created_at,updated_at)
    VALUES ('run','series','completed',1,240,'chapter','chapter',?,?,1,1)`).run(
      "5".repeat(64), options.withoutBible ? null : "bible",
    );
  texts.forEach((text, index) => db.prepare(`INSERT INTO audio_segments
    (timeline_hash,segment_index,episode_id,script_version_id,text,provider_id,voice,rate,input_hash,relative_path,file_hash,bytes,duration_ms,created_at)
    VALUES (?,?, 'episode','script',?,'edge','voice',1,?,?,?,10,1000,1)`)
    .run(TIMELINE, index, text, String(index).padStart(64, "0"), `segment-${index}.wav`, String(index + 1).padStart(64, "0")));
  return { root, connection };
}

test("代表段支持任意数量并去重", () => {
  assert.deepEqual(representativeSegmentIndexes(1), [0]);
  assert.deepEqual(representativeSegmentIndexes(2), [0, 1]);
  assert.deepEqual(representativeSegmentIndexes(6), [0, 1, 2, 3, 5]);
});

test("绕过全书世界观时从资产别名确定性生成专名核对项", async () => {
  const { root, connection } = await fixture(undefined, { withoutBible: true });
  try {
    const asset = createAsset(connection.database, "series", { type: "character", name: "张起灵" });
    addAssetAliases(connection.database, asset.id, ["小哥"]);
    const workspace = getTtsListeningReviewWorkspace(connection.database, "episode", TIMELINE);
    assert.deepEqual(workspace.requiredProperNouns, [{
      term: "张起灵", pronunciation: "请人工确认", matchedText: "张起灵", segmentIndex: 1,
    }]);
    assert.equal(workspace.identity.storyBibleId, null);
    assert.match(workspace.identity.storyBibleContentHash, /^[0-9a-f]{64}$/u);
    assert.deepEqual(workspace.requiredSegmentIndexes, [0, 1, 2, 3, 4]);
  } finally { connection.close(); await rm(root, { recursive: true, force: true }); }
});

test("专名命中加入首个片段，批准必须覆盖全部必听项", async () => {
  const { root, connection } = await fixture();
  try {
    const workspace = getTtsListeningReviewWorkspace(connection.database, "episode", TIMELINE);
    assert.deepEqual(workspace.requiredProperNouns.map(({ term, segmentIndex }) => ({ term, segmentIndex })), [
      { term: "吴邪", segmentIndex: 3 }, { term: "张起灵", segmentIndex: 1 },
    ]);
    assert.throws(() => enqueueTtsListeningReview(connection.database, {
      episodeId: "episode", timelineHash: TIMELINE, action: "approve", checkedSegmentIndexes: [0], checkedProperNouns: [],
    }), /全部代表段和专名/);
    const job = enqueueTtsListeningReview(connection.database, {
      episodeId: "episode", timelineHash: TIMELINE, action: "approve",
      checkedSegmentIndexes: workspace.requiredSegmentIndexes,
      checkedProperNouns: workspace.requiredProperNouns.map((item) => item.term),
    });
    const worker = new JobWorker(connection.database, { [TTS_LISTENING_REVIEW_JOB_TYPE]: createTtsListeningReviewJobHandler(connection.database) },
      { workerId: "reviewer", leaseMs: 5_000, heartbeatMs: 100 });
    assert.equal(await worker.runOne(), true);
    assert.equal(getJob(connection.database, job.id)?.status, "succeeded");
    assert.equal(getTtsListeningReviewWorkspace(connection.database, "episode", TIMELINE).latestReview?.action, "approve");
  } finally { connection.close(); await rm(root, { recursive: true, force: true }); }
});

test("执行前身份漂移会拒绝，旧成功也不匹配新身份", async () => {
  const { root, connection } = await fixture();
  try {
    const workspace = getTtsListeningReviewWorkspace(connection.database, "episode", TIMELINE);
    const first = enqueueTtsListeningReview(connection.database, {
      episodeId: "episode", timelineHash: TIMELINE, action: "approve",
      checkedSegmentIndexes: workspace.requiredSegmentIndexes,
      checkedProperNouns: workspace.requiredProperNouns.map((item) => item.term),
    });
    const handler = createTtsListeningReviewJobHandler(connection.database);
    const worker = () => new JobWorker(connection.database, { [TTS_LISTENING_REVIEW_JOB_TYPE]: handler },
      { workerId: `worker-${Math.random()}`, leaseMs: 5_000, heartbeatMs: 100 });
    assert.equal(await worker().runOne(), true);
    assert.equal(getJob(connection.database, first.id)?.status, "succeeded");
    connection.database.prepare("UPDATE audio_segments SET voice='new-voice' WHERE timeline_hash=?").run(TIMELINE);
    assert.equal(getTtsListeningReviewWorkspace(connection.database, "episode", TIMELINE).latestReview, null);
    const stale = enqueueTtsListeningReview(connection.database, {
      episodeId: "episode", timelineHash: TIMELINE, action: "reject", checkedSegmentIndexes: [], checkedProperNouns: [], notes: "不通过",
    });
    connection.database.prepare("UPDATE audio_segments SET rate=2 WHERE timeline_hash=?").run(TIMELINE);
    assert.equal(await worker().runOne(), true);
    assert.equal(getJob(connection.database, stale.id)?.status, "failed");
  } finally { connection.close(); await rm(root, { recursive: true, force: true }); }
});

test("拒绝无需伪装为批准覆盖", async () => {
  const { root, connection } = await fixture(["只有一段"]);
  try {
    const job = enqueueTtsListeningReview(connection.database, {
      episodeId: "episode", timelineHash: TIMELINE, action: "reject", checkedSegmentIndexes: [], checkedProperNouns: [],
    });
    const worker = new JobWorker(connection.database, { [TTS_LISTENING_REVIEW_JOB_TYPE]: createTtsListeningReviewJobHandler(connection.database) },
      { workerId: "rejecter", leaseMs: 5_000, heartbeatMs: 100 });
    assert.equal(await worker.runOne(), true);
    assert.equal(getJob(connection.database, job.id)?.result && (getJob(connection.database, job.id)!.result as { action: string }).action, "reject");
  } finally { connection.close(); await rm(root, { recursive: true, force: true }); }
});

test("final 为空时纳入冻结 interval 专名并忽略无关旧层", async () => {
  const { root, connection } = await fixture(["开头", "项云峰来到潘家园", "结尾"], {
    finalNouns: [],
    parentNouns: [{ term: "项云峰", pronunciation: "xiàng yún fēng", aliases: [] }],
    unrelatedNouns: [{ term: "潘家园", pronunciation: "pān jiā yuán", aliases: [] }],
  });
  try {
    const workspace = getTtsListeningReviewWorkspace(connection.database, "episode", TIMELINE);
    assert.deepEqual(workspace.requiredProperNouns.map((item) => item.term), ["项云峰"]);
  } finally { connection.close(); await rm(root, { recursive: true, force: true }); }
});

test("final 与冻结 interval 的相同专名稳定去重", async () => {
  const noun = { term: "项云峰", pronunciation: "xiàng yún fēng", aliases: ["云峰"] };
  const { root, connection } = await fixture(["项云峰"], { finalNouns: [noun], parentNouns: [noun] });
  try {
    const workspace = getTtsListeningReviewWorkspace(connection.database, "episode", TIMELINE);
    assert.deepEqual(workspace.requiredProperNouns.map((item) => item.term), ["项云峰"]);
  } finally { connection.close(); await rm(root, { recursive: true, force: true }); }
});

test("冻结 interval 缺失或失效时拒绝听审工作区", async () => {
  for (const parentState of ["missing", "invalid"] as const) {
    const { root, connection } = await fixture(["项云峰"], {
      finalNouns: [], parentNouns: [{ term: "项云峰", pronunciation: "xiàng yún fēng", aliases: [] }], parentState,
    });
    try {
      assert.throws(
        () => getTtsListeningReviewWorkspace(connection.database, "episode", TIMELINE),
        /冻结父层合同无效/,
      );
    } finally { connection.close(); await rm(root, { recursive: true, force: true }); }
  }
});

test("properNounsHash 随冻结 interval 专名变化", async () => {
  const first = await fixture(["项云峰"], {
    finalNouns: [], parentNouns: [{ term: "项云峰", pronunciation: "xiàng yún fēng", aliases: [] }],
  });
  const second = await fixture(["项云峰"], {
    finalNouns: [], parentNouns: [{ term: "项云峰", pronunciation: "xiàng yún fēng 2", aliases: [] }],
  });
  try {
    assert.notEqual(
      getTtsListeningReviewWorkspace(first.connection.database, "episode", TIMELINE).identity.properNounsHash,
      getTtsListeningReviewWorkspace(second.connection.database, "episode", TIMELINE).identity.properNounsHash,
    );
  } finally {
    first.connection.close(); second.connection.close();
    await rm(first.root, { recursive: true, force: true });
    await rm(second.root, { recursive: true, force: true });
  }
});
