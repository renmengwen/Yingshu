import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { link, mkdir, mkdtemp, readFile, readdir, rename, rm, stat, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { openDatabase } from "./database.js";
import { FINAL_VIDEO_MANIFEST_VERSION, type FinalVideoManifest } from "./final-video.js";
import {
  createProjectPackage,
  RESTORABLE_PROJECT_SCHEMA_VERSIONS,
  restoreProjectPackage,
  type ProjectPackageManifest,
} from "./project-package.js";
import { loadRenderPlanSnapshot, RENDER_CONTRACT } from "./render-chunk-job.js";
import { changeScriptApproval } from "./script-approval-store.js";
import {
  createScriptVersion,
  createStandalonePackagedScriptVersion,
  validateStoredScriptVersion,
} from "./script-version-store.js";

const TIMELINE = "a".repeat(64);
const hash = (content: string | Buffer) => createHash("sha256").update(content).digest("hex");

test("项目包恢复兼容版本是显式持久合同", () => {
  assert.deepEqual(RESTORABLE_PROJECT_SCHEMA_VERSIONS, [13, 14, 15, 16, 17, 18, 19, 20]);
});

async function put(root: string, relativePath: string, content: string | Buffer) {
  const path = join(root, ...relativePath.split("/"));
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content);
  return { path, relativePath, content: Buffer.from(content), bytes: Buffer.byteLength(content), fileHash: hash(content) };
}

async function fixture(scriptContractVersion: 5 | 6 = 5) {
  const root = await mkdtemp(join(tmpdir(), "narralume-package-test-"));
  const dataRoot = join(root, "data");
  const connection = openDatabase(dataRoot);
  const db = connection.database;
  const original = await put(dataRoot, "books/book/source.txt", "真实原文");
  db.prepare("INSERT INTO books (id,title,original_file_path,original_file_hash,encoding,import_status) VALUES ('book','书',?,?, 'UTF-8','ready')")
    .run(original.relativePath, original.fileHash);
  db.prepare(`INSERT INTO chapters (id,book_id,chapter_index,title,byte_start,byte_end,char_count,content_hash)
    VALUES ('chapter','book',0,'第一章',0,?,4,?)`).run(original.bytes, original.fileHash);
  db.prepare(`INSERT INTO chapter_events (id,chapter_id,event_index,occurrence,event_type,payload_json,created_at)
    VALUES ('event','chapter',0,0,'revelation','{"summary":"发现真实线索"}',1)`).run();
  db.prepare(`INSERT INTO chapter_event_sources (event_id,source_index,source_byte_start,source_byte_end,source_hash)
    VALUES ('event',0,0,?,?)`).run(original.bytes, original.fileHash);
  db.prepare("INSERT INTO series_projects (id,book_id,title,created_at,updated_at) VALUES ('series','book','系列',1,1)").run();
  db.prepare("INSERT INTO episodes (id,series_project_id,episode_index,title,story_arc,target_duration_seconds,created_at,updated_at) VALUES ('episode','series',1,'集','弧',180,1,1)").run();
  db.prepare(`INSERT INTO episode_sources (episode_id,source_index,chapter_id,source_event_id,source_byte_start,source_byte_end,source_hash)
    VALUES ('episode',0,'chapter','event',0,?,?)`).run(original.bytes, original.fileHash);
  const faithful = scriptContractVersion === 5 ? createScriptVersion(db, "episode", {
    kind: "faithful", paragraphs: [{ text: "忠实旁白", sourceIndexes: [0] }],
  }, 1) : undefined;
  const packaged = scriptContractVersion === 5
    ? createScriptVersion(db, "episode", {
      kind: "packaged", parentVersionId: faithful!.id, paragraphs: [{ text: "包装旁白", sourceIndexes: [0] }],
    }, 1)
    : createStandalonePackagedScriptVersion(db, "episode", [
      { text: "成片旁白", sourceIndexes: [0] },
    ], () => undefined, 1);
  changeScriptApproval(db, "episode", { action: "approve", expectedRevision: 0, scriptVersionId: packaged.id }, 1);
  db.prepare("INSERT INTO assets (id,series_project_id,asset_type,asset_role,canonical_name,normalized_name,created_at) VALUES ('asset','series','scene','master','场景','场景',1)").run();
  const image = await put(dataRoot, "assets/candidates/aa/image.png", "image");
  db.prepare(`INSERT INTO asset_candidates (id,asset_id,source_kind,source_identity_hash,source_json,file_hash,mime,width,height,bytes,relative_path,created_at)
    VALUES ('candidate','asset','upload',?,'{}',?,'image/png',1080,1920,?,?,1)`)
    .run("3".repeat(64), image.fileHash, image.bytes, image.relativePath);
  db.prepare("INSERT INTO asset_candidate_review_events (candidate_id,revision,action,created_at) VALUES ('candidate',1,'approve',1)").run();
  const audio = await put(dataRoot, "episodes/episode/audio/segments/audio.wav", "audio");
  db.prepare(`INSERT INTO audio_segments (timeline_hash,segment_index,episode_id,script_version_id,text,provider_id,voice,rate,input_hash,relative_path,file_hash,bytes,duration_ms,created_at)
    VALUES (?,0,'episode',?,'旁白','test','voice',0,?,?,?, ?,60000,1)`)
    .run(TIMELINE, packaged.id, "4".repeat(64), audio.relativePath, audio.fileHash, audio.bytes);
  db.prepare("INSERT INTO subtitle_cues (timeline_hash,cue_index,segment_index,episode_id,script_version_id,start_ms,end_ms,text) VALUES (?,0,0,'episode',?,0,60000,'旁白')").run(TIMELINE, packaged.id);
  db.prepare(`INSERT INTO visual_segments (id,episode_id,segment_index,script_version_id,approval_revision,timeline_hash,cue_start_index,cue_end_index,start_ms,end_ms,motion_kind,motion_amount_ppm,fade_ms,revision,created_at,updated_at)
    VALUES ('visual','episode',0,?,1,?,0,0,0,60000,'none',0,0,1,1,1)`).run(packaged.id, TIMELINE);
  db.prepare("INSERT INTO visual_segment_assets (visual_segment_id,asset_index,asset_id,selected_candidate_id,candidate_review_revision) VALUES ('visual',0,'asset','candidate',1)").run();
  await put(dataRoot, `episodes/episode/audio/${TIMELINE}.srt`, "1\n00:00:00,000 --> 00:01:00,000\n旁白\n");
  await put(dataRoot, `episodes/episode/audio/${TIMELINE}.ass`, "[Script Info]\nPlayResX: 1080\nPlayResY: 1920\n");
  const planned = loadRenderPlanSnapshot(db, "episode", TIMELINE).chunks[0]!;
  const chunkRelativePath = `episodes/episode/renders/chunks/${planned.renderHash.slice(0, 2)}/${planned.renderHash}.mp4`;
  const chunk = await put(dataRoot, chunkRelativePath, "chunk");
  db.prepare(`INSERT INTO render_chunks (render_hash,episode_id,timeline_hash,chunk_index,script_version_id,approval_revision,start_ms,end_ms,relative_path,file_hash,bytes,duration_ms,created_at)
    VALUES (?,'episode',?,0,?,1,0,60000,?,?,?,60000,1)`)
    .run(planned.renderHash, TIMELINE, packaged.id, chunk.relativePath, chunk.fileHash, chunk.bytes);
  const identity = {
    version: FINAL_VIDEO_MANIFEST_VERSION, contract: RENDER_CONTRACT, episodeId: "episode", scriptVersionId: packaged.id,
    approvalRevision: 1, timelineHash: TIMELINE,
    chunks: [{ index: 0, startMs: 0, endMs: 60000, renderHash: planned.renderHash,
      fileHash: chunk.fileHash, bytes: chunk.bytes, durationMs: 60000 }],
  };
  const exportHash = hash(JSON.stringify(identity));
  const exportDirectory = `episodes/episode/exports/${exportHash.slice(0, 2)}/${exportHash}`;
  const video = await put(dataRoot, `${exportDirectory}/video.mp4`, "video");
  const finalManifest: FinalVideoManifest = {
    ...identity, exportHash,
    chunks: [{ ...identity.chunks[0]!, relativePath: chunk.relativePath }],
    finalVideo: { relativePath: video.relativePath, fileHash: video.fileHash, bytes: video.bytes, durationMs: 60000,
      streams: { video: "h264:1080x1920:25:yuv420p", audio: "aac" } },
  };
  const finalManifestRelativePath = `${exportDirectory}/manifest.json`;
  await put(dataRoot, finalManifestRelativePath, `${JSON.stringify(finalManifest, null, 2)}\n`);
  return { root, dataRoot, connection, finalManifestRelativePath, faithfulScriptId: faithful?.id, packagedScriptId: packaged.id };
}

async function cleanup(value: Awaited<ReturnType<typeof fixture>>) {
  value.connection.close();
  await rm(value.root, { recursive: true, force: true });
}

async function mutateManifest(packagePath: string, mutate: (manifest: any) => void) {
  const path = join(packagePath, "manifest.json");
  const manifest = JSON.parse(await readFile(path, "utf8"));
  mutate(manifest);
  const { packageHash: _old, ...identity } = manifest;
  manifest.packageHash = hash(JSON.stringify(identity));
  await writeFile(path, `${JSON.stringify(manifest, null, 2)}\n`);
}

function downgradeDatabaseToV14(database: DatabaseSync) {
  database.exec(`
    DROP TABLE videos;
    DROP TABLE projects;
    DROP TABLE book_prompt_profiles;
    ALTER TABLE series_pipeline_runs DROP COLUMN book_prompt_profile_hash;
    ALTER TABLE series_pipeline_runs DROP COLUMN book_prompt_profile_revision;
    ALTER TABLE series_pipeline_runs DROP COLUMN product_prompt_version;
    ALTER TABLE series_pipeline_runs DROP COLUMN script_contract_version;
    ALTER TABLE series_pipeline_runs DROP COLUMN episode_ranges_json;
    ALTER TABLE series_pipeline_runs DROP COLUMN planning_contract_version;
    ALTER TABLE script_versions DROP COLUMN script_contract_version;
    DROP TABLE book_story_bibles;
    ALTER TABLE series_pipeline_runs DROP COLUMN chapter_concurrency;
    ALTER TABLE series_pipeline_runs DROP COLUMN chapter_batch_size;
    ALTER TABLE job_checkpoints DROP COLUMN output_json;
    DELETE FROM schema_migrations WHERE version>=15;
  `);
}

function downgradeDatabaseToV13(database: DatabaseSync) {
  database.exec(`
    DROP TABLE videos;
    DROP TABLE projects;
    DROP TABLE book_prompt_profiles;
    ALTER TABLE script_versions DROP COLUMN script_contract_version;
    DROP TABLE book_story_bibles;
    DROP TABLE series_pipeline_jobs;
    DROP TABLE series_pipeline_runs;
    ALTER TABLE job_checkpoints DROP COLUMN output_json;
    DELETE FROM schema_migrations WHERE version>=14;
  `);
}

function downgradeDatabaseToV17(database: DatabaseSync) {
  database.exec(`
    DROP TABLE videos;
    DROP TABLE projects;
    DROP TABLE book_prompt_profiles;
    ALTER TABLE series_pipeline_runs DROP COLUMN book_prompt_profile_hash;
    ALTER TABLE series_pipeline_runs DROP COLUMN book_prompt_profile_revision;
    ALTER TABLE series_pipeline_runs DROP COLUMN product_prompt_version;
    ALTER TABLE series_pipeline_runs DROP COLUMN script_contract_version;
    ALTER TABLE series_pipeline_runs DROP COLUMN episode_ranges_json;
    ALTER TABLE series_pipeline_runs DROP COLUMN planning_contract_version;
    ALTER TABLE script_versions DROP COLUMN script_contract_version;
    DELETE FROM schema_migrations WHERE version>=18;
  `);
}

async function refreshPackagedDatabaseIdentity(packagePath: string) {
  const databaseContent = await readFile(join(packagePath, "payload", "yingshu.sqlite3"));
  await mutateManifest(packagePath, (manifest: ProjectPackageManifest) => {
    const databaseFile = manifest.files.find((file) => file.path === "yingshu.sqlite3");
    assert.ok(databaseFile);
    databaseFile.bytes = databaseContent.length;
    databaseFile.sha256 = hash(databaseContent);
  });
}

async function createHistoricalV14Package(
  current: Awaited<ReturnType<typeof fixture>>,
  packagePath: string,
  mutate?: (database: DatabaseSync) => void,
) {
  await createProjectPackage(current.connection.database, current.dataRoot,
    { packagePath, finalManifestRelativePath: current.finalManifestRelativePath });
  const database = new DatabaseSync(join(packagePath, "payload", "yingshu.sqlite3"));
  try {
    downgradeDatabaseToV14(database);
    mutate?.(database);
  } finally { database.close(); }
  await refreshPackagedDatabaseIdentity(packagePath);
}

async function createHistoricalV17Package(
  current: Awaited<ReturnType<typeof fixture>>,
  packagePath: string,
) {
  await createProjectPackage(current.connection.database, current.dataRoot,
    { packagePath, finalManifestRelativePath: current.finalManifestRelativePath });
  const database = new DatabaseSync(join(packagePath, "payload", "yingshu.sqlite3"));
  try { downgradeDatabaseToV17(database); } finally { database.close(); }
  await refreshPackagedDatabaseIdentity(packagePath);
}

async function createHistoricalV13Package(
  current: Awaited<ReturnType<typeof fixture>>,
  packagePath: string,
  mutate?: (database: DatabaseSync) => void,
) {
  await createProjectPackage(current.connection.database, current.dataRoot,
    { packagePath, finalManifestRelativePath: current.finalManifestRelativePath });
  const database = new DatabaseSync(join(packagePath, "payload", "yingshu.sqlite3"));
  try {
    downgradeDatabaseToV13(database);
    database.prepare("UPDATE visual_segments SET motion_kind = 'zoom-in', motion_amount_ppm = 1").run();
    mutate?.(database);
  } finally { database.close(); }
  await refreshPackagedDatabaseIdentity(packagePath);
}

test("创建 WAL 一致项目包并恢复到不存在的数据根", async () => {
  const current = await fixture();
  try {
    current.connection.database.prepare(`INSERT INTO jobs (id,type,payload_json,status,run_after,created_at,updated_at)
      VALUES ('wal-latest','test','{}','queued',1,1,1)`).run();
    const packagePath = join(current.root, "project-package");
    const first = await createProjectPackage(current.connection.database, current.dataRoot,
      { packagePath, finalManifestRelativePath: current.finalManifestRelativePath });
    assert.equal(first.manifest.version, "narralume-project-package-v1");
    assert.deepEqual(first.manifest.files, [...first.manifest.files].sort((a, b) => a.path.localeCompare(b.path, "en")));
    assert.equal(JSON.stringify(first.manifest).includes(current.dataRoot), false);
    for (const forbidden of ["mtime", "generatedAt", "machine", "randomUUID"]) {
      assert.equal(JSON.stringify(first.manifest).includes(forbidden), false);
    }
    const restored = join(current.root, "restored");
    await restoreProjectPackage(packagePath, restored);
    const restoredDb = new DatabaseSync(join(restored, "yingshu.sqlite3"), { readOnly: true });
    try {
      assert.equal((restoredDb.prepare("SELECT status FROM jobs WHERE id='wal-latest'").get() as { status: string }).status, "queued");
      assert.equal((restoredDb.prepare("PRAGMA integrity_check").get() as { integrity_check: string }).integrity_check, "ok");
    } finally { restoredDb.close(); }
    assert.equal(await readFile(join(restored, "books", "book", "source.txt"), "utf8"), "真实原文");
    const second = await createProjectPackage(current.connection.database, current.dataRoot,
      { packagePath: join(current.root, "project-package-2"), finalManifestRelativePath: current.finalManifestRelativePath });
    assert.equal(second.manifest.packageHash, first.manifest.packageHash, "相同输入的包身份与排序必须稳定");
  } finally { await cleanup(current); }
});

test("合法 v14 项目包在私有 staging 升级到当前版本并保留完整产品数据", async () => {
  const current = await fixture();
  try {
    const packagePath = join(current.root, "project-package-v14");
    await createHistoricalV14Package(current, packagePath);
    const originalPackagedDatabaseHash = hash(await readFile(join(packagePath, "payload", "yingshu.sqlite3")));

    const restored = join(current.root, "restored-current");
    await restoreProjectPackage(packagePath, restored);
    assert.equal(hash(await readFile(join(packagePath, "payload", "yingshu.sqlite3"))), originalPackagedDatabaseHash,
      "恢复不得迁移或改写原项目包 payload");
    const originalDatabase = new DatabaseSync(join(packagePath, "payload", "yingshu.sqlite3"), { readOnly: true });
    try { assert.equal(originalDatabase.prepare("SELECT MAX(version) AS version FROM schema_migrations").get()?.version, 14); }
    finally { originalDatabase.close(); }
    const restoredDatabase = new DatabaseSync(join(restored, "yingshu.sqlite3"), { readOnly: true });
    try {
      assert.deepEqual(
        (restoredDatabase.prepare("SELECT version FROM schema_migrations ORDER BY version").all() as Array<{ version: number }>).map((row) => row.version),
        Array.from({ length: 20 }, (_, index) => index + 1),
      );
      for (const [table, count] of Object.entries({
        episodes: 1, episode_sources: 1, script_versions: 2, script_version_sources: 2,
        script_approval_events: 1, audio_segments: 1, subtitle_cues: 1,
        visual_segments: 1, visual_segment_assets: 1, assets: 1, asset_candidates: 1,
        asset_candidate_review_events: 1, render_chunks: 1,
      })) {
        assert.equal(restoredDatabase.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get()?.count, count, table);
      }
      assert.equal(restoredDatabase.prepare("PRAGMA foreign_key_check").all().length, 0);
      assert.equal(restoredDatabase.prepare("PRAGMA integrity_check").get()?.integrity_check, "ok");
      assert.equal(restoredDatabase.prepare("SELECT target_duration_seconds FROM episodes WHERE id='episode'").get()?.target_duration_seconds, 180);
      assert.equal(restoredDatabase.prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='book_story_bibles'",
      ).get()?.name, "book_story_bibles");
    } finally { restoredDatabase.close(); }
    const manifest = JSON.parse(await readFile(join(packagePath, "manifest.json"), "utf8")) as ProjectPackageManifest;
    assert.equal(await readFile(join(restored, manifest.project.finalManifestPath), "utf8"),
      await readFile(join(packagePath, "payload", manifest.project.finalManifestPath), "utf8"));
    assert.equal(await readFile(join(restored, "episodes", "episode", "exports", manifest.project.finalExportHash.slice(0, 2),
      manifest.project.finalExportHash, "video.mp4"), "utf8"), "video");
  } finally { await cleanup(current); }
});

test("合法 v13 封存项目包恢复时升级到 v18", async () => {
  const current = await fixture();
  try {
    const packagePath = join(current.root, "project-package-v13");
    await createHistoricalV13Package(current, packagePath);
    const restored = join(current.root, "restored-v13-to-v18");
    await restoreProjectPackage(packagePath, restored);
    const database = new DatabaseSync(join(restored, "yingshu.sqlite3"), { readOnly: true });
    try {
      assert.equal(database.prepare("SELECT MAX(version) AS version FROM schema_migrations").get()?.version, 20);
      assert.equal(database.prepare("PRAGMA integrity_check").get()?.integrity_check, "ok");
    } finally { database.close(); }
  } finally { await cleanup(current); }
});

test("v6 单一成片旁白项目包可创建、恢复并保持 standalone 合同", async () => {
  const current = await fixture(6);
  try {
    const packagePath = join(current.root, "project-package-v6");
    await createProjectPackage(current.connection.database, current.dataRoot,
      { packagePath, finalManifestRelativePath: current.finalManifestRelativePath });
    const restored = join(current.root, "restored-v6");
    await restoreProjectPackage(packagePath, restored);
    const database = new DatabaseSync(join(restored, "yingshu.sqlite3"), { readOnly: true });
    try {
      const script = validateStoredScriptVersion(database, current.packagedScriptId);
      assert.equal(script.script_contract_version, 6);
      assert.equal(script.kind, "packaged");
      assert.equal(script.parent_version_id, null);
      assert.equal(database.prepare(
        "SELECT COUNT(*) AS count FROM script_versions WHERE episode_id = 'episode'",
      ).get()?.count, 1);
    } finally { database.close(); }
  } finally { await cleanup(current); }
});

test("合法 v17 项目包恢复时补齐 v18 合同列", async () => {
  const current = await fixture();
  try {
    const packagePath = join(current.root, "project-package-v17");
    await createHistoricalV17Package(current, packagePath);
    const restored = join(current.root, "restored-v17-to-v18");
    await restoreProjectPackage(packagePath, restored);
    const database = new DatabaseSync(join(restored, "yingshu.sqlite3"), { readOnly: true });
    try {
      assert.equal(database.prepare("SELECT MAX(version) AS version FROM schema_migrations").get()?.version, 20);
      assert.equal(database.prepare(
        "SELECT script_contract_version FROM script_versions WHERE id = ?",
      ).get(current.packagedScriptId)?.script_contract_version, 5);
      assert.equal(database.prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='book_prompt_profiles'",
      ).get()?.name, "book_prompt_profiles");
    } finally { database.close(); }
  } finally { await cleanup(current); }
});

test("历史 v13 封存模式拒绝批准或持久分片身份漂移，v14/v18 要求当前渲染算法", async (t) => {
  for (const kind of ["approval", "chunk"] as const) await t.test(`v13 ${kind}`, async () => {
    const current = await fixture();
    try {
      const packagePath = join(current.root, `package-v13-${kind}`);
      await createHistoricalV13Package(current, packagePath, (database) => {
        if (kind === "approval") database.prepare(
          `INSERT INTO script_approval_events (id,episode_id,revision,action,script_version_id,created_at)
           VALUES ('approval_withdraw','episode',2,'withdraw',?,2)`,
        ).run(current.packagedScriptId);
        else database.prepare("UPDATE render_chunks SET approval_revision = 2").run();
      });
      await assert.rejects(
        restoreProjectPackage(packagePath, join(current.root, `restored-${kind}`)),
        kind === "approval" ? /历史最终清单不是封存时最新批准的成片旁白稿/ : /最终清单分片与当前数据库不一致/,
      );
    } finally { await cleanup(current); }
  });

  await t.test("v14 render plan drift", async () => {
    const current = await fixture();
    try {
      const packagePath = join(current.root, "package-v14-drift");
      await createHistoricalV14Package(current, packagePath, (database) => {
        database.prepare("UPDATE visual_segments SET motion_kind = 'zoom-in', motion_amount_ppm = 1").run();
      });
      await assert.rejects(
        restoreProjectPackage(packagePath, join(current.root, "restored-v14-drift")),
        /最终清单不是当前批准稿与渲染计划/,
      );
    } finally { await cleanup(current); }
  });

  await t.test("v18 render plan drift", async () => {
    const current = await fixture();
    try {
      const packagePath = join(current.root, "package-v18-drift");
      await createProjectPackage(current.connection.database, current.dataRoot,
        { packagePath, finalManifestRelativePath: current.finalManifestRelativePath });
      const database = new DatabaseSync(join(packagePath, "payload", "yingshu.sqlite3"));
      try { database.prepare("UPDATE visual_segments SET motion_kind = 'zoom-in', motion_amount_ppm = 1").run(); }
      finally { database.close(); }
      await refreshPackagedDatabaseIdentity(packagePath);
      await assert.rejects(
        restoreProjectPackage(packagePath, join(current.root, "restored-v18-drift")),
        /最终清单不是当前批准稿与渲染计划/,
      );
    } finally { await cleanup(current); }
  });
});

test("历史 v13 sealed restore 拒绝稿件、批准和分片时长的同步伪造", async (t) => {
  const cases = [
    ["noncanonical-content", (database: DatabaseSync, current: Awaited<ReturnType<typeof fixture>>) =>
      database.prepare("UPDATE script_versions SET content_json = content_json || ' ' WHERE id = ?").run(current.packagedScriptId), /稿件/],
    ["deterministic-script-id", (database: DatabaseSync, current: Awaited<ReturnType<typeof fixture>>) =>
      database.prepare("UPDATE script_versions SET version = 7 WHERE id = ?").run(current.packagedScriptId), /稿件/],
    ["packaged-parent", (database: DatabaseSync, current: Awaited<ReturnType<typeof fixture>>) =>
      database.prepare("UPDATE script_versions SET parent_version_id = NULL WHERE id = ?").run(current.packagedScriptId), /成片旁白稿/],
    ["frozen-sources", (database: DatabaseSync, current: Awaited<ReturnType<typeof fixture>>) =>
      database.prepare("UPDATE script_version_sources SET source_hash = ? WHERE script_version_id = ?")
        .run("0".repeat(64), current.packagedScriptId), /冻结来源/],
    ["approval-id", (database: DatabaseSync) =>
      database.prepare("UPDATE script_approval_events SET id = 'approval_forged'").run(), /最新批准的成片旁白稿/],
    ["chunk-duration", (database: DatabaseSync) =>
      database.prepare("UPDATE render_chunks SET duration_ms = duration_ms - 1").run(), /分片与当前数据库不一致/],
  ] as const;
  for (const [name, mutate, message] of cases) await t.test(name, async () => {
    const current = await fixture();
    try {
      const packagePath = join(current.root, `package-v13-forged-${name}`);
      await createHistoricalV13Package(current, packagePath, (database) => mutate(database, current));
      await assert.rejects(restoreProjectPackage(packagePath, join(current.root, `restored-${name}`)), message);
    } finally { await cleanup(current); }
  });
});

test("项目包创建仍严格要求 v18，恢复拒绝未来或有缺口的迁移历史", async (t) => {
  await t.test("创建拒绝 v14", async () => {
    const current = await fixture();
    try {
      downgradeDatabaseToV14(current.connection.database);
      await assert.rejects(createProjectPackage(current.connection.database, current.dataRoot,
        { packagePath: join(current.root, "package-v14-create"), finalManifestRelativePath: current.finalManifestRelativePath }),
      /迁移版本不兼容/);
    } finally { await cleanup(current); }
  });
  for (const kind of ["future", "gap"] as const) await t.test(kind, async () => {
    const current = await fixture();
    try {
      const packagePath = join(current.root, `package-${kind}`);
      await createProjectPackage(current.connection.database, current.dataRoot,
        { packagePath, finalManifestRelativePath: current.finalManifestRelativePath });
      const database = new DatabaseSync(join(packagePath, "payload", "yingshu.sqlite3"));
      try {
        if (kind === "future") database.prepare("INSERT INTO schema_migrations (version) VALUES (21)").run();
        else database.prepare("DELETE FROM schema_migrations WHERE version=13").run();
      } finally { database.close(); }
      await refreshPackagedDatabaseIdentity(packagePath);
      await assert.rejects(restoreProjectPackage(packagePath, join(current.root, `restored-${kind}`)), /迁移版本不兼容/);
    } finally { await cleanup(current); }
  });
});

test("恢复拒绝不安全、重复、缺失、额外和被篡改的 payload", async (t) => {
  const cases: Array<[string, (packagePath: string) => Promise<void>]> = [
    ["dotdot", async (path) => mutateManifest(path, (value) => { value.files[0].path = "../escape"; })],
    ["反斜杠", async (path) => mutateManifest(path, (value) => { value.files[0].path = "bad\\path"; })],
    ["Windows ADS", async (path) => mutateManifest(path, (value) => { value.files[0].path = "safe:stream"; })],
    ["设备名", async (path) => mutateManifest(path, (value) => { value.files[0].path = "CON"; })],
    ["大小写重复", async (path) => mutateManifest(path, (value) => { value.files.push({ ...value.files[0], path: value.files[0].path.toUpperCase() }); })],
    ["缺失", async (path) => rm(join(path, "payload", "books", "book", "source.txt"))],
    ["额外", async (path) => writeFile(join(path, "payload", "extra.txt"), "extra")],
    ["bytes/hash", async (path) => writeFile(join(path, "payload", "books", "book", "source.txt"), "tampered")],
  ];
  for (const [name, mutate] of cases) await t.test(name, async () => {
    const current = await fixture();
    try {
      const packagePath = join(current.root, "package");
      await createProjectPackage(current.connection.database, current.dataRoot,
        { packagePath, finalManifestRelativePath: current.finalManifestRelativePath });
      await mutate(packagePath);
      const target = join(current.root, "target");
      await assert.rejects(restoreProjectPackage(packagePath, target));
      await assert.rejects(readFile(target));
    } finally { await cleanup(current); }
  });
});

test("恢复拒绝数据库、最终清单和 payload 一同伪造的非规范分片路径", async () => {
  const current = await fixture();
  try {
    const packagePath = join(current.root, "package");
    await createProjectPackage(current.connection.database, current.dataRoot,
      { packagePath, finalManifestRelativePath: current.finalManifestRelativePath });
    const manifestPath = join(packagePath, "manifest.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as ProjectPackageManifest;
    const payload = join(packagePath, "payload");
    const chunkFile = manifest.files.find((file) => file.roles.includes("render-chunk"));
    assert.ok(chunkFile);
    const forgedChunkPath = `episodes/${manifest.project.episodeId}/renders/chunks/forged/chunk.mp4`;

    const databasePath = join(payload, "yingshu.sqlite3");
    const database = new DatabaseSync(databasePath);
    try { database.prepare("UPDATE render_chunks SET relative_path = ?").run(forgedChunkPath); }
    finally { database.close(); }

    const finalManifestPath = join(payload, ...manifest.project.finalManifestPath.split("/"));
    const finalManifest = JSON.parse(await readFile(finalManifestPath, "utf8")) as FinalVideoManifest;
    const finalChunk = finalManifest.chunks[0];
    assert.ok(finalChunk);
    finalChunk.relativePath = forgedChunkPath;
    await writeFile(finalManifestPath, `${JSON.stringify(finalManifest, null, 2)}\n`);

    const forgedChunkFile = join(payload, ...forgedChunkPath.split("/"));
    await mkdir(dirname(forgedChunkFile), { recursive: true });
    await rename(join(payload, ...chunkFile.path.split("/")), forgedChunkFile);
    chunkFile.path = forgedChunkPath;
    for (const file of manifest.files) {
      const content = await readFile(join(payload, ...file.path.split("/")));
      file.bytes = content.length;
      file.sha256 = hash(content);
    }
    const { packageHash: _old, ...identity } = manifest;
    manifest.packageHash = hash(JSON.stringify(identity));
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

    const target = join(current.root, "target");
    await assert.rejects(restoreProjectPackage(packagePath, target), /最终视频清单文件身份无效/);
    await assert.rejects(stat(target), (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT");
  } finally { await cleanup(current); }
});

test("链接、Junction 或硬链接不能进入项目包", async (t) => {
  await t.test("硬链接", async () => {
    const current = await fixture();
    try {
      await link(join(current.dataRoot, "books", "book", "source.txt"), join(current.root, "source-link.txt"));
      await assert.rejects(createProjectPackage(current.connection.database, current.dataRoot,
        { packagePath: join(current.root, "package"), finalManifestRelativePath: current.finalManifestRelativePath }), /普通独占文件/);
    } finally { await cleanup(current); }
  });
  await t.test("符号链接或 Junction", async (context) => {
    const current = await fixture();
    try {
      const source = join(current.dataRoot, "books", "book", "source.txt");
      await rm(source);
      try { await symlink(join(current.root, "outside.txt"), source, "file"); } catch (error) {
        context.skip(`当前平台不能创建符号链接：${(error as Error).message}`); return;
      }
      await assert.rejects(createProjectPackage(current.connection.database, current.dataRoot,
        { packagePath: join(current.root, "package"), finalManifestRelativePath: current.finalManifestRelativePath }));
    } finally { await cleanup(current); }
  });
  await t.test("父目录 Junction", async (context) => {
    const current = await fixture();
    const bookDirectory = join(current.dataRoot, "books", "book");
    let linked = false;
    try {
      const outside = join(current.root, "outside-book");
      await mkdir(outside);
      await writeFile(join(outside, "source.txt"), "真实原文");
      await rm(bookDirectory, { recursive: true });
      try { await symlink(outside, bookDirectory, "junction"); linked = true; } catch (error) {
        context.skip(`当前平台不能创建 Junction：${(error as Error).message}`); return;
      }
      await assert.rejects(createProjectPackage(current.connection.database, current.dataRoot,
        { packagePath: join(current.root, "package"), finalManifestRelativePath: current.finalManifestRelativePath }), /父目录/);
    } finally {
      if (linked) await unlink(bookDirectory);
      await cleanup(current);
    }
  });
});

test("首版拒绝混有第二个系列项目的数据根", async () => {
  const current = await fixture();
  try {
    current.connection.database.prepare("INSERT INTO series_projects (id,book_id,title,created_at,updated_at) VALUES ('other','book','其他项目',2,2)").run();
    await assert.rejects(createProjectPackage(current.connection.database, current.dataRoot,
      { packagePath: join(current.root, "package"), finalManifestRelativePath: current.finalManifestRelativePath }), /恰好一个系列项目/);
  } finally { await cleanup(current); }
});

test("首版唯一分集合同拒绝其他 file-backed 数据库行", async (t) => {
  await t.test("第二个分集", async () => {
    const current = await fixture();
    try {
      current.connection.database.prepare("INSERT INTO episodes (id,series_project_id,episode_index,title,story_arc,target_duration_seconds,created_at,updated_at) VALUES ('episode2','series',2,'第二集','弧',180,2,2)").run();
      await assert.rejects(createProjectPackage(current.connection.database, current.dataRoot,
        { packagePath: join(current.root, "package"), finalManifestRelativePath: current.finalManifestRelativePath }), /恰好一个目标分集/);
    } finally { await cleanup(current); }
  });
  await t.test("旧音频、未选候选和旧分片", async () => {
    for (const kind of ["audio", "candidate", "chunk"] as const) {
      const current = await fixture();
      try {
        if (kind === "audio") current.connection.database.prepare(`INSERT INTO audio_segments
          (timeline_hash,segment_index,episode_id,script_version_id,text,provider_id,voice,rate,input_hash,relative_path,file_hash,bytes,duration_ms,created_at)
          VALUES (?,0,'episode',?,'旧音频','test','voice',0,?,'old.wav',?,1,60000,2)`)
          .run("b".repeat(64), current.packagedScriptId, "c".repeat(64), "d".repeat(64));
        if (kind === "candidate") current.connection.database.prepare(`INSERT INTO asset_candidates
          (id,asset_id,source_kind,source_identity_hash,source_json,file_hash,mime,width,height,bytes,relative_path,created_at)
          VALUES ('unused','asset','upload',?,'{}',?,'image/png',1080,1920,1,'unused.png',2)`)
          .run("e".repeat(64), "f".repeat(64));
        if (kind === "chunk") current.connection.database.prepare(`INSERT INTO render_chunks
          (render_hash,episode_id,timeline_hash,chunk_index,script_version_id,approval_revision,start_ms,end_ms,relative_path,file_hash,bytes,duration_ms,created_at)
          VALUES (?,'episode',?,9,?,1,60000,120000,'old.mp4',?,1,60000,2)`)
          .run("b".repeat(64), TIMELINE, current.packagedScriptId, "c".repeat(64));
        await assert.rejects(createProjectPackage(current.connection.database, current.dataRoot,
          { packagePath: join(current.root, `package-${kind}`), finalManifestRelativePath: current.finalManifestRelativePath }),
        /之外的(?:音频|候选图片|分片)/);
      } finally { await cleanup(current); }
    }
  });
});

test("创建与恢复拒绝相同、祖先、后代及 Junction 映射的目录", async (t) => {
  const current = await fixture();
  try {
    for (const packagePath of [current.dataRoot, join(current.dataRoot, "package"), current.root]) {
      await assert.rejects(createProjectPackage(current.connection.database, current.dataRoot,
        { packagePath, finalManifestRelativePath: current.finalManifestRelativePath }), /互为父子目录/);
    }
    const packagePath = join(current.root, "package-ok");
    await createProjectPackage(current.connection.database, current.dataRoot,
      { packagePath, finalManifestRelativePath: current.finalManifestRelativePath });
    for (const target of [packagePath, join(packagePath, "restored"), current.root]) {
      await assert.rejects(restoreProjectPackage(packagePath, target), /互为父子目录/);
    }
    await t.test("真实父路径穿过 Junction", async (context) => {
      const junction = join(current.root, "data-link");
      let linked = false;
      try {
        try { await symlink(current.dataRoot, junction, "junction"); linked = true; } catch (error) {
          context.skip(`当前平台不能创建 Junction：${(error as Error).message}`); return;
        }
        await assert.rejects(createProjectPackage(current.connection.database, current.dataRoot,
          { packagePath: join(junction, "nested-package"), finalManifestRelativePath: current.finalManifestRelativePath }), /互为父子目录/);
      } finally { if (linked) await unlink(junction); }
    });
  } finally { await cleanup(current); }
});

test("发布写入、同步或 rename 失败不泄漏且覆盖失败恢复旧包", async (t) => {
  await t.test("写入阶段失败", async () => {
    const current = await fixture();
    try {
      await assert.rejects(createProjectPackage(current.connection.database, current.dataRoot,
        { packagePath: join(current.root, "package"), finalManifestRelativePath: current.finalManifestRelativePath },
        { afterCopy: async () => { throw new Error("write-fault"); } }), /write-fault/);
      assert.deepEqual((await readdir(current.root)).filter((name) => name.includes(".tmp") || name.endsWith(".backup")), []);
    } finally { await cleanup(current); }
  });
  await t.test("同步失败", async () => {
    const current = await fixture();
    try {
      await assert.rejects(createProjectPackage(current.connection.database, current.dataRoot,
        { packagePath: join(current.root, "package"), finalManifestRelativePath: current.finalManifestRelativePath },
        { syncDirectory: async () => { throw new Error("sync-fault"); } }), /sync-fault/);
      assert.deepEqual((await readdir(current.root)).filter((name) => name.includes(".tmp") || name.endsWith(".backup")), []);
    } finally { await cleanup(current); }
  });
  await t.test("覆盖 rename 失败", async () => {
    const current = await fixture();
    try {
      const packagePath = join(current.root, "package");
      await mkdir(packagePath);
      await writeFile(join(packagePath, "old.txt"), "old");
      await assert.rejects(createProjectPackage(current.connection.database, current.dataRoot,
        { packagePath, finalManifestRelativePath: current.finalManifestRelativePath }, {
          rename: async (source, target) => {
            if (String(source).includes(".tmp") && target === packagePath) throw new Error("rename-fault");
            await rename(source, target);
          },
        }), /rename-fault/);
      assert.equal(await readFile(join(packagePath, "old.txt"), "utf8"), "old");
      assert.deepEqual((await readdir(current.root)).filter((name) => name.includes(".tmp") || name.endsWith(".backup")), []);
    } finally { await cleanup(current); }
  });
  await t.test("旧 backup 部分删除失败不回滚已提交的新包", async () => {
    const current = await fixture();
    try {
      const packagePath = join(current.root, "package");
      await mkdir(packagePath);
      await writeFile(join(packagePath, "old-a.txt"), "old-a");
      await writeFile(join(packagePath, "old-b.txt"), "old-b");
      await assert.rejects(createProjectPackage(current.connection.database, current.dataRoot,
        { packagePath, finalManifestRelativePath: current.finalManifestRelativePath }, {
          remove: async (path, options) => {
            if (String(path).endsWith(".backup")) {
              await rm(join(String(path), "old-a.txt"));
              throw new Error("partial-rm-fault");
            }
            await rm(path, options);
          },
        }), /已发布/);
      assert.equal(JSON.parse(await readFile(join(packagePath, "manifest.json"), "utf8")).version, "narralume-project-package-v1");
      await assert.rejects(readFile(join(packagePath, "old-b.txt")));
      assert.equal(await readFile(`${packagePath}.backup/old-b.txt`, "utf8"), "old-b");
    } finally { await cleanup(current); }
  });
  await t.test("提交后的父目录 sync 失败不回滚新包", async () => {
    const current = await fixture();
    try {
      const packagePath = join(current.root, "package");
      await mkdir(packagePath);
      await writeFile(join(packagePath, "old.txt"), "old");
      let syncCalls = 0;
      await assert.rejects(createProjectPackage(current.connection.database, current.dataRoot,
        { packagePath, finalManifestRelativePath: current.finalManifestRelativePath }, {
          syncDirectory: async () => { syncCalls += 1; if (syncCalls === 4) throw new Error("post-commit-sync-fault"); },
        }), /已发布/);
      assert.equal(JSON.parse(await readFile(join(packagePath, "manifest.json"), "utf8")).version, "narralume-project-package-v1");
      await assert.rejects(readFile(join(packagePath, "old.txt")));
    } finally { await cleanup(current); }
  });
});

test("恢复拒绝已存在目标，发布失败也不创建半成品目标", async () => {
  const current = await fixture();
  try {
    const packagePath = join(current.root, "package");
    await createProjectPackage(current.connection.database, current.dataRoot,
      { packagePath, finalManifestRelativePath: current.finalManifestRelativePath });
    const existing = join(current.root, "existing");
    await mkdir(existing);
    await assert.rejects(restoreProjectPackage(packagePath, existing), /完全不存在/);
    const target = join(current.root, "target");
    await assert.rejects(restoreProjectPackage(packagePath, target, {
      rename: async () => { throw new Error("restore-rename-fault"); },
    }), /restore-rename-fault/);
    await assert.rejects(readFile(target));
    assert.deepEqual((await readdir(current.root)).filter((name) => name.includes(".tmp") || name.endsWith(".backup")), []);
  } finally { await cleanup(current); }
});

test("恢复复制完成后不再重开不可信 payload", async () => {
  const current = await fixture();
  try {
    const packagePath = join(current.root, "package");
    await createProjectPackage(current.connection.database, current.dataRoot,
      { packagePath, finalManifestRelativePath: current.finalManifestRelativePath });
    const target = join(current.root, "restored");
    await restoreProjectPackage(packagePath, target, {
      afterPayloadCopied: async () => { await rm(join(packagePath, "payload"), { recursive: true }); },
    });
    const database = new DatabaseSync(join(target, "yingshu.sqlite3"), { readOnly: true });
    try { assert.equal((database.prepare("SELECT COUNT(*) AS count FROM episodes").get() as { count: number }).count, 1); }
    finally { database.close(); }
  } finally { await cleanup(current); }
});

test("恢复发布并发目标使用 no-replace 且保留竞争者字节", async () => {
  const current = await fixture();
  try {
    const packagePath = join(current.root, "package");
    await createProjectPackage(current.connection.database, current.dataRoot,
      { packagePath, finalManifestRelativePath: current.finalManifestRelativePath });
    const target = join(current.root, "concurrent-target");
    await assert.rejects(restoreProjectPackage(packagePath, target, {
      rename: async (source, destination) => {
        await mkdir(destination);
        await writeFile(join(String(destination), "competitor.txt"), "competitor");
        await rename(source, destination);
      },
    }), /并发目标/);
    assert.equal(await readFile(join(target, "competitor.txt"), "utf8"), "competitor");
    await assert.rejects(readFile(join(target, "yingshu.sqlite3")));
  } finally { await cleanup(current); }
});

test("Windows 空目录并发目标也不会被 rename 覆盖", async (t) => {
  if (process.platform !== "win32") { t.skip("生产 no-replace 合同当前明确只支持 Windows"); return; }
  const current = await fixture();
  try {
    const packagePath = join(current.root, "package");
    await createProjectPackage(current.connection.database, current.dataRoot,
      { packagePath, finalManifestRelativePath: current.finalManifestRelativePath });
    const target = join(current.root, "empty-concurrent-target");
    let competitorIno: bigint | undefined;
    await assert.rejects(restoreProjectPackage(packagePath, target, {
      rename: async (source, destination) => {
        await mkdir(destination);
        competitorIno = (await stat(destination, { bigint: true })).ino;
        await rename(source, destination);
      },
    }), /并发目标/);
    assert.equal((await stat(target, { bigint: true })).ino, competitorIno);
    assert.deepEqual(await readdir(target), []);
  } finally { await cleanup(current); }
});

test("目标探测只把 ENOENT 当作不存在", async () => {
  const current = await fixture();
  try {
    const packagePath = join(current.root, "package");
    await createProjectPackage(current.connection.database, current.dataRoot,
      { packagePath, finalManifestRelativePath: current.finalManifestRelativePath });
    const parentFile = join(current.root, "not-a-directory");
    await writeFile(parentFile, "file");
    await assert.rejects(restoreProjectPackage(packagePath, join(parentFile, "target")),
      (error: unknown) => Boolean((error as NodeJS.ErrnoException).code && (error as NodeJS.ErrnoException).code !== "ENOENT"));
    assert.equal(await readFile(parentFile, "utf8"), "file");
  } finally { await cleanup(current); }
});
