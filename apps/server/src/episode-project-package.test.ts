import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { openDatabase } from "./database.js";
import { createEpisodeProjectPackage } from "./episode-project-package.js";
import { FINAL_VIDEO_MANIFEST_VERSION, type FinalVideoManifest } from "./final-video.js";
import { restoreProjectPackage } from "./project-package.js";
import { loadRenderPlanSnapshot, RENDER_CONTRACT } from "./render-chunk-job.js";
import { changeScriptApproval } from "./script-approval-store.js";
import { createScriptVersion } from "./script-version-store.js";

const TIMELINE = "a".repeat(64);
const OLD_TIMELINE = "b".repeat(64);
const hash = (content: string | Buffer) => createHash("sha256").update(content).digest("hex");

async function put(root: string, relativePath: string, content: string) {
  const path = join(root, ...relativePath.split("/"));
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content);
  return { relativePath, bytes: Buffer.byteLength(content), fileHash: hash(content) };
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "narralume-episode-package-test-"));
  const dataRoot = join(root, "data");
  const connection = openDatabase(dataRoot);
  const db = connection.database;
  const original = await put(dataRoot, "books/book/source.txt", "target original");
  const foreignOriginal = await put(dataRoot, "books/foreign/source.txt", "foreign original");
  db.prepare("INSERT INTO books (id,title,original_file_path,original_file_hash,encoding,import_status) VALUES (?,?,?,?, 'UTF-8','ready')")
    .run("book", "目标书", original.relativePath, original.fileHash);
  db.prepare("INSERT INTO books (id,title,original_file_path,original_file_hash,encoding,import_status) VALUES (?,?,?,?, 'UTF-8','ready')")
    .run("foreign-book", "外部书", foreignOriginal.relativePath, foreignOriginal.fileHash);
  db.prepare(`INSERT INTO chapters (id,book_id,chapter_index,title,byte_start,byte_end,char_count,content_hash)
    VALUES ('chapter','book',0,'第一章',0,?,10,?)`).run(original.bytes, original.fileHash);
  db.prepare(`INSERT INTO chapters (id,book_id,chapter_index,title,byte_start,byte_end,char_count,content_hash)
    VALUES ('foreign-chapter','foreign-book',0,'外部章',0,?,10,?)`).run(foreignOriginal.bytes, foreignOriginal.fileHash);
  db.prepare(`INSERT INTO chapter_events (id,chapter_id,event_index,occurrence,event_type,payload_json,created_at)
    VALUES ('event','chapter',0,0,'revelation','{"summary":"event"}',1)`).run();
  db.prepare(`INSERT INTO chapter_event_sources (event_id,source_index,source_byte_start,source_byte_end,source_hash)
    VALUES ('event',0,0,?,?)`).run(original.bytes, original.fileHash);
  db.prepare("INSERT INTO series_projects (id,book_id,title,created_at,updated_at) VALUES ('series','book','目标系列',1,1)").run();
  db.prepare("INSERT INTO series_projects (id,book_id,title,created_at,updated_at) VALUES ('foreign-series','foreign-book','外部系列',1,1)").run();
  db.prepare(`INSERT INTO episodes (id,series_project_id,episode_index,title,story_arc,target_duration_seconds,created_at,updated_at)
    VALUES ('episode','series',1,'目标集','主线',180,1,1),('sibling','series',2,'同系列集','支线',180,1,1),
      ('foreign-episode','foreign-series',1,'外部集','外部',180,1,1)`).run();
  db.prepare(`INSERT INTO episode_sources (episode_id,source_index,chapter_id,source_event_id,source_byte_start,source_byte_end,source_hash)
    VALUES ('episode',0,'chapter','event',0,?,?)`).run(original.bytes, original.fileHash);
  db.prepare(`INSERT INTO jobs (id,type,payload_json,status,run_after,created_at,updated_at)
    VALUES ('pipeline-job','test','{}','queued',1,1,1)`).run();
  db.prepare(`INSERT INTO book_story_bibles (id,book_id,scope,source_start_chapter_id,source_end_chapter_id,
    source_event_ids_json,source_events_hash,parent_bible_ids_json,input_hash,contract_version,revision,provider_id,model,job_id,
    content_json,content_hash,created_at)
    VALUES ('bible','book','interval','chapter','chapter','["event"]',?,'[]',?,'v1',1,'provider','model','pipeline-job','{}',?,1)`)
    .run("7".repeat(64), "8".repeat(64), hash("{}"));
  db.prepare(`INSERT INTO series_pipeline_runs (id,series_project_id,status,episode_count,target_duration_seconds,
    source_start_chapter_id,source_end_chapter_id,config_hash,story_bible_id,created_at,updated_at)
    VALUES ('run','series','configured',2,180,'chapter','chapter',?,'bible',1,1)`).run("9".repeat(64));
  db.prepare(`INSERT INTO series_pipeline_jobs (run_id,stage,subject_type,subject_id,job_id,created_at)
    VALUES ('run','story_bible','bible_chunk','bible','pipeline-job',1)`).run();
  const faithful = createScriptVersion(db, "episode", {
    kind: "faithful", paragraphs: [{ text: "忠实稿", sourceIndexes: [0] }],
  }, 1);
  const packaged = createScriptVersion(db, "episode", {
    kind: "packaged", parentVersionId: faithful.id, paragraphs: [{ text: "包装稿", sourceIndexes: [0] }],
  }, 1);
  changeScriptApproval(db, "episode", { action: "approve", expectedRevision: 0, scriptVersionId: packaged.id }, 1);

  db.prepare(`INSERT INTO assets (id,series_project_id,asset_type,asset_role,canonical_name,normalized_name,created_at)
    VALUES ('asset','series','scene','master','当前场景','当前场景',1),('old-asset','series','scene','master','旧场景','旧场景',1)`).run();
  const image = await put(dataRoot, "assets/candidates/current.png", "current image");
  const oldImage = await put(dataRoot, "assets/candidates/old.png", "old image");
  db.prepare(`INSERT INTO asset_candidates (id,asset_id,source_kind,source_identity_hash,source_json,file_hash,mime,width,height,bytes,relative_path,created_at)
    VALUES ('candidate','asset','upload',?,'{}',?,'image/png',1080,1920,?,?,1),
      ('old-candidate','old-asset','upload',?,'{}',?,'image/png',1080,1920,?,?,1)`).run(
    "3".repeat(64), image.fileHash, image.bytes, image.relativePath,
    "4".repeat(64), oldImage.fileHash, oldImage.bytes, oldImage.relativePath,
  );
  db.prepare("INSERT INTO asset_candidate_review_events (candidate_id,revision,action,created_at) VALUES ('candidate',1,'approve',1),('old-candidate',1,'approve',1)").run();

  const audio = await put(dataRoot, "episodes/episode/audio/current.wav", "audio");
  const oldAudio = await put(dataRoot, "episodes/episode/audio/old.wav", "old audio");
  db.prepare(`INSERT INTO audio_segments (timeline_hash,segment_index,episode_id,script_version_id,text,provider_id,voice,rate,input_hash,relative_path,file_hash,bytes,duration_ms,created_at)
    VALUES (?,0,'episode',?,'旁白','test','voice',0,?,?,?, ?,60000,1),
      (?,0,'episode',?,'旧旁白','test','voice',0,?,?,?, ?,60000,1)`).run(
    TIMELINE, packaged.id, "5".repeat(64), audio.relativePath, audio.fileHash, audio.bytes,
    OLD_TIMELINE, packaged.id, "6".repeat(64), oldAudio.relativePath, oldAudio.fileHash, oldAudio.bytes,
  );
  db.prepare(`INSERT INTO subtitle_cues (timeline_hash,cue_index,segment_index,episode_id,script_version_id,start_ms,end_ms,text)
    VALUES (?,0,0,'episode',?,0,60000,'旁白'),(?,0,0,'episode',?,0,60000,'旧旁白')`)
    .run(TIMELINE, packaged.id, OLD_TIMELINE, packaged.id);
  db.prepare(`INSERT INTO visual_segments (id,episode_id,segment_index,script_version_id,approval_revision,timeline_hash,cue_start_index,cue_end_index,start_ms,end_ms,motion_kind,motion_amount_ppm,fade_ms,revision,created_at,updated_at)
    VALUES ('visual','episode',0,?,1,?,0,0,0,60000,'none',0,0,1,1,1),
      ('old-visual','episode',0,?,1,?,0,0,0,60000,'none',0,0,1,1,1)`).run(packaged.id, TIMELINE, packaged.id, OLD_TIMELINE);
  db.prepare(`INSERT INTO visual_segment_assets (visual_segment_id,asset_index,asset_id,selected_candidate_id,candidate_review_revision)
    VALUES ('visual',0,'asset','candidate',1),('old-visual',0,'old-asset','old-candidate',1)`).run();
  await put(dataRoot, `episodes/episode/audio/${TIMELINE}.srt`, "srt");
  await put(dataRoot, `episodes/episode/audio/${TIMELINE}.ass`, "ass");
  const planned = loadRenderPlanSnapshot(db, "episode", TIMELINE).chunks[0]!;
  const chunkPath = `episodes/episode/renders/chunks/${planned.renderHash.slice(0, 2)}/${planned.renderHash}.mp4`;
  const chunk = await put(dataRoot, chunkPath, "chunk");
  db.prepare(`INSERT INTO render_chunks (render_hash,episode_id,timeline_hash,chunk_index,script_version_id,approval_revision,start_ms,end_ms,relative_path,file_hash,bytes,duration_ms,created_at)
    VALUES (?,'episode',?,0,?,1,0,60000,?,?,?,60000,1)`).run(
    planned.renderHash, TIMELINE, packaged.id, chunk.relativePath, chunk.fileHash, chunk.bytes,
  );
  const identity = {
    version: FINAL_VIDEO_MANIFEST_VERSION, contract: RENDER_CONTRACT, episodeId: "episode", scriptVersionId: packaged.id,
    approvalRevision: 1, timelineHash: TIMELINE,
    chunks: [{ index: 0, startMs: 0, endMs: 60000, renderHash: planned.renderHash,
      fileHash: chunk.fileHash, bytes: chunk.bytes, durationMs: 60000 }],
  };
  const exportHash = hash(JSON.stringify(identity));
  const exportDirectory = `episodes/episode/exports/${exportHash.slice(0, 2)}/${exportHash}`;
  const video = await put(dataRoot, `${exportDirectory}/video.mp4`, "video");
  const manifest: FinalVideoManifest = {
    ...identity, exportHash, chunks: [{ ...identity.chunks[0]!, relativePath: chunk.relativePath }],
    finalVideo: { relativePath: video.relativePath, fileHash: video.fileHash, bytes: video.bytes, durationMs: 60000,
      streams: { video: "h264:1080x1920:25:yuv420p", audio: "aac" } },
  };
  await put(dataRoot, `${exportDirectory}/manifest.json`, `${JSON.stringify(manifest, null, 2)}\n`);
  return { root, dataRoot, connection, exportHash, original };
}

test("从多系列多分集数据根创建并恢复当前分集受控项目包", async () => {
  const current = await fixture();
  try {
    const before = {
      books: current.connection.database.prepare("SELECT COUNT(*) count FROM books").get(),
      episodes: current.connection.database.prepare("SELECT COUNT(*) count FROM episodes").get(),
      candidates: current.connection.database.prepare("SELECT COUNT(*) count FROM asset_candidates").get(),
      original: await readFile(join(current.dataRoot, current.original.relativePath)),
    };
    const packagePath = join(current.root, "package");
    await createEpisodeProjectPackage(current.connection.database, current.dataRoot, {
      packagePath, episodeId: "episode", timelineHash: TIMELINE, finalExportHash: current.exportHash,
    });
    const restored = join(current.root, "restored");
    await restoreProjectPackage(packagePath, restored);
    const database = new DatabaseSync(join(restored, "yingshu.sqlite3"), { readOnly: true });
    try {
      assert.deepEqual(database.prepare("SELECT id FROM books").all().map((row) => ({ ...row })), [{ id: "book" }]);
      assert.deepEqual(database.prepare("SELECT id FROM series_projects").all().map((row) => ({ ...row })), [{ id: "series" }]);
      assert.deepEqual(database.prepare("SELECT id FROM episodes").all().map((row) => ({ ...row })), [{ id: "episode" }]);
      assert.deepEqual(database.prepare("SELECT timeline_hash FROM audio_segments").all().map((row) => ({ ...row })), [{ timeline_hash: TIMELINE }]);
      assert.deepEqual(database.prepare("SELECT id FROM asset_candidates").all().map((row) => ({ ...row })), [{ id: "candidate" }]);
      assert.equal((database.prepare("SELECT COUNT(*) count FROM jobs").get() as { count: number }).count, 0);
      assert.equal((database.prepare("SELECT COUNT(*) count FROM series_pipeline_runs").get() as { count: number }).count, 0);
      assert.equal((database.prepare("SELECT job_id FROM book_story_bibles WHERE id='bible'").get() as { job_id: null }).job_id, null);
      assert.equal((database.prepare("PRAGMA foreign_key_check").all()).length, 0);
    } finally { database.close(); }
    assert.equal(await readFile(join(restored, "assets/candidates/old.png")).then(() => true, () => false), false);
    assert.deepEqual(current.connection.database.prepare("SELECT COUNT(*) count FROM books").get(), before.books);
    assert.deepEqual(current.connection.database.prepare("SELECT COUNT(*) count FROM episodes").get(), before.episodes);
    assert.deepEqual(current.connection.database.prepare("SELECT COUNT(*) count FROM asset_candidates").get(), before.candidates);
    assert.equal((current.connection.database.prepare("SELECT COUNT(*) count FROM jobs").get() as { count: number }).count, 1);
    assert.equal((current.connection.database.prepare("SELECT COUNT(*) count FROM series_pipeline_runs").get() as { count: number }).count, 1);
    assert.equal((current.connection.database.prepare("SELECT job_id FROM book_story_bibles WHERE id='bible'").get() as { job_id: string }).job_id, "pipeline-job");
    assert.deepEqual(await readFile(join(current.dataRoot, current.original.relativePath)), before.original);

    const beforeTemps = new Set((await readdir(tmpdir())).filter((name) => name.startsWith("narralume-episode-package-")));
    await assert.rejects(createEpisodeProjectPackage(current.connection.database, current.dataRoot, {
      packagePath: join(current.root, "failed-package"), episodeId: "episode", timelineHash: TIMELINE,
      finalExportHash: "f".repeat(64),
    }));
    const leaked = (await readdir(tmpdir())).filter((name) => name.startsWith("narralume-episode-package-") && !beforeTemps.has(name));
    assert.deepEqual(leaked, []);
  } finally {
    current.connection.close();
    await rm(current.root, { recursive: true, force: true });
  }
});
