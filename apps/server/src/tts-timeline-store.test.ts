import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

import { buildApp } from "./app.js";
import { openDatabase } from "./database.js";
import { getTtsTimeline, listTtsTimelines, readVerifiedTtsSegment } from "./tts-timeline-store.js";

const EPISODE = "episode_audio";
const SCRIPT = "script_audio";
const HASH = "a".repeat(64);
const NEWER_HASH = "b".repeat(64);

async function seed(dataRoot: string) {
  const connection = openDatabase(dataRoot);
  const db = connection.database;
  db.prepare("INSERT INTO books (id,title,original_file_path,original_file_hash,encoding,import_status) VALUES (?,?,?,?,?,?)")
    .run("book_audio", "测试书", "books/test.txt", "1".repeat(64), "utf-8", "ready");
  db.prepare("INSERT INTO series_projects (id,book_id,title,created_at,updated_at) VALUES (?,?,?,?,?)")
    .run("series_audio", "book_audio", "测试系列", 1, 1);
  db.prepare("INSERT INTO episodes (id,series_project_id,episode_index,title,story_arc,target_duration_seconds,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)")
    .run(EPISODE, "series_audio", 1, "第一集", "故事弧", 240, 1, 1);
  db.prepare("INSERT INTO script_versions (id,episode_id,kind,version,content_json,content_hash,created_at) VALUES (?,?,?,?,?,?,?)")
    .run(SCRIPT, EPISODE, "packaged", 1, "[]", "2".repeat(64), 1);
  db.prepare("INSERT INTO script_approval_events (id,episode_id,revision,action,script_version_id,created_at) VALUES (?,?,?,?,?,?)")
    .run("approval_audio", EPISODE, 1, "approve", SCRIPT, 2);

  const bytes = Buffer.from("RIFF-test-wave-bytes");
  const fileHash = createHash("sha256").update(bytes).digest("hex");
  const inputHash = "3".repeat(64);
  const relativePath = `episodes/${EPISODE}/audio/segments/${inputHash}.wav`;
  await mkdir(join(dataRoot, "episodes", EPISODE, "audio", "segments"), { recursive: true });
  await writeFile(join(dataRoot, ...relativePath.split("/")), bytes);
  const insertSegment = db.prepare(
    `INSERT INTO audio_segments (timeline_hash,segment_index,episode_id,script_version_id,text,provider_id,voice,rate,input_hash,relative_path,file_hash,bytes,duration_ms,created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  );
  insertSegment.run(HASH, 0, EPISODE, SCRIPT, "第一段", "windows-system-speech", "测试声音", 0, inputHash, relativePath, fileHash, bytes.length, 1200, 10);
  insertSegment.run(NEWER_HASH, 0, EPISODE, SCRIPT, "第一段", "windows-system-speech", "测试声音", 0, inputHash, relativePath, fileHash, bytes.length, 1200, 20);
  const insertCue = db.prepare("INSERT INTO subtitle_cues (timeline_hash,cue_index,segment_index,episode_id,script_version_id,start_ms,end_ms,text) VALUES (?,?,?,?,?,?,?,?)");
  insertCue.run(HASH, 0, 0, EPISODE, SCRIPT, 0, 1200, "第一段");
  insertCue.run(NEWER_HASH, 0, 0, EPISODE, SCRIPT, 0, 1200, "第一段");
  return { connection, bytes, relativePath };
}

test("语音时间轴按当前批准稿列出最新项并完整读取 cue", async () => {
  const dataRoot = await mkdtemp(join(tmpdir(), "narralume-audio-store-"));
  try {
    const { connection, bytes } = await seed(dataRoot);
    assert.deepEqual(listTtsTimelines(connection.database, EPISODE).map((item) => item.timelineHash), [NEWER_HASH, HASH]);
    const timeline = getTtsTimeline(connection.database, EPISODE, HASH);
    assert.equal(timeline.durationMs, 1200);
    assert.equal(timeline.cues[0]?.text, "第一段");
    assert.deepEqual(await readVerifiedTtsSegment(connection.database, dataRoot, EPISODE, HASH, 0), bytes);
    connection.close();
  } finally { await rm(dataRoot, { recursive: true, force: true }); }
});

test("语音 WAV 拒绝登记路径和完整字节哈希不一致", async () => {
  const dataRoot = await mkdtemp(join(tmpdir(), "narralume-audio-verify-"));
  try {
    const { connection, relativePath } = await seed(dataRoot);
    await writeFile(join(dataRoot, ...relativePath.split("/")), "tampered");
    await assert.rejects(readVerifiedTtsSegment(connection.database, dataRoot, EPISODE, HASH, 0), /登记信息不一致/);
    connection.database.prepare("UPDATE audio_segments SET relative_path = ? WHERE timeline_hash = ?").run("../outside.wav", HASH);
    await assert.rejects(readVerifiedTtsSegment(connection.database, dataRoot, EPISODE, HASH, 0), /登记路径无效/);
    connection.close();
  } finally { await rm(dataRoot, { recursive: true, force: true }); }
});

test("语音时间轴 API 返回持久数据和已校验 WAV", async () => {
  const dataRoot = await mkdtemp(join(tmpdir(), "narralume-audio-api-"));
  try {
    const { connection, bytes } = await seed(dataRoot);
    connection.close();
    const app = buildApp({ dataRoot, logger: false });
    const listed = await app.inject({ method: "GET", url: `/api/episodes/${EPISODE}/tts-timelines` });
    assert.equal(listed.statusCode, 200);
    assert.equal(listed.json().items[0].timelineHash, NEWER_HASH);
    const exact = await app.inject({ method: "GET", url: `/api/episodes/${EPISODE}/tts-timelines/${HASH}` });
    assert.equal(exact.statusCode, 200);
    const audio = await app.inject({ method: "GET", url: `/api/episodes/${EPISODE}/tts-timelines/${HASH}/audio/0` });
    assert.equal(audio.statusCode, 200);
    assert.equal(audio.headers["content-type"], "audio/wav");
    assert.deepEqual(audio.rawPayload, bytes);
    assert.equal((await app.inject({ method: "GET", url: `/api/episodes/${EPISODE}/tts-timelines/bad` })).statusCode, 400);
    await app.close();
  } finally { await rm(dataRoot, { recursive: true, force: true }); }
});
