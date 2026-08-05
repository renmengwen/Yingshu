import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { openDatabase } from "./database.js";

function dropVideoPlanTables(database: DatabaseSync) {
  database.exec(`
    DROP TABLE video_douyin_analysis_selection_events;
    DROP TABLE video_douyin_analysis_selections;
    DROP TABLE video_douyin_analysis_jobs;
    DROP TABLE video_douyin_analysis_snapshots;
    DROP TABLE video_final_videos;
    DROP TABLE video_render_chunks;
    DROP TABLE video_render_runs;
    DROP TABLE video_visual_review_events;
    DROP TABLE video_visual_segments;
    DROP TABLE video_visual_timelines;
    DROP TABLE video_audio_review_events;
    DROP TABLE video_tts_cues;
    DROP TABLE video_tts_artifacts;
    DROP TABLE video_tts_jobs;
    DROP TABLE video_tts_snapshots;
    DROP TABLE video_image_approval_events;
    DROP TABLE video_image_candidates;
    DROP TABLE video_image_batch_items;
    DROP TABLE video_image_batches;
    DROP TABLE video_plan_approvals;
    DROP TABLE video_visual_revisions;
    DROP TABLE video_script_revisions;
    DROP TABLE video_plan_sources;
    DROP TABLE video_plan_jobs;
    DROP TABLE video_plan_snapshots;
  `);
}

function downgradeCurrentDatabaseFromV18(database: DatabaseSync) {
  dropVideoPlanTables(database);
  database.exec(`
    DROP TABLE global_prompt_settings;
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
    DELETE FROM schema_migrations WHERE version >= 18;
  `);
}

test("数据库迁移可重复执行并在重启后保留书库数据", async () => {
  const dataRoot = await mkdtemp(join(tmpdir(), "narralume-database-"));

  try {
    const first = openDatabase(dataRoot);
    first.database
      .prepare(
        `INSERT INTO books (
          id, title, original_file_path, original_file_hash, encoding, import_status
        ) VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run("book_sha256", "测试书", "books/book_sha256/source.txt", "sha256", "UTF-8", "ready");
    first.database
      .prepare(
        `INSERT INTO chapters (
          id, book_id, chapter_index, title, byte_start, byte_end, char_count, content_hash
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run("chapter_1", "book_sha256", 0, "第一章", 0, 12, 6, "chapter_hash");
    assert.throws(
      () =>
        first.database
          .prepare(
            `INSERT INTO chapters (
              id, book_id, chapter_index, title, byte_start, byte_end, char_count, content_hash
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run("chapter_duplicate", "book_sha256", 0, "重复章", 12, 20, 4, "duplicate_hash"),
      /UNIQUE constraint failed/,
    );
    assert.throws(
      () =>
        first.database
          .prepare(
            `INSERT INTO chapters (
              id, book_id, chapter_index, title, byte_start, byte_end, char_count, content_hash
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run("chapter_invalid_range", "book_sha256", 1, "无效范围", 20, 12, 4, "bad_hash"),
      /CHECK constraint failed/,
    );
    first.database.prepare(
      `INSERT INTO chapter_events (
         id, chapter_id, event_index, occurrence, event_type, payload_json, created_at
       ) VALUES ('event_1', 'chapter_1', 0, 0, 'character', '{"name":"人物"}', 1)`,
    ).run();
    first.database.prepare(
      `INSERT INTO chapter_event_sources (
         event_id, source_index, source_byte_start, source_byte_end, source_hash
       ) VALUES ('event_1', 0, 0, 3, ?)`,
    ).run("a".repeat(64));
    assert.throws(
      () => first.database.prepare(
        `INSERT INTO chapter_events (
           id, chapter_id, event_index, occurrence, event_type, payload_json, created_at
         ) VALUES ('event_bad', 'chapter_1', 1, 0, 'unknown', '{}', 1)`,
      ).run(),
      /CHECK constraint failed/,
    );
    assert.throws(
      () => first.database.prepare(
        `INSERT INTO chapter_event_sources (
           event_id, source_index, source_byte_start, source_byte_end, source_hash
         ) VALUES ('event_1', 1, 3, 4, 'ABC')`,
      ).run(),
      /CHECK constraint failed/,
    );
    first.close();

    const reopened = openDatabase(dataRoot);
    const book = reopened.database.prepare("SELECT id, title FROM books").get();
    const migration = reopened.database
      .prepare("SELECT version FROM schema_migrations ORDER BY version DESC LIMIT 1")
      .get();
    reopened.database.prepare("DELETE FROM books WHERE id = ?").run("book_sha256");
    const chapterCount = reopened.database.prepare("SELECT COUNT(*) AS count FROM chapters").get();
    const eventCount = reopened.database.prepare("SELECT COUNT(*) AS count FROM chapter_events").get();
    const sourceCount = reopened.database.prepare("SELECT COUNT(*) AS count FROM chapter_event_sources").get();
    reopened.close();

    assert.equal(book?.id, "book_sha256");
    assert.equal(book?.title, "测试书");
    assert.equal(migration?.version, 26);
    assert.equal(chapterCount?.count, 0);
    assert.equal(eventCount?.count, 0);
    assert.equal(sourceCount?.count, 0);
    assert.equal((await readFile(join(dataRoot, "yingshu.sqlite3"))).length > 0, true);
  } finally {
    await rm(dataRoot, { recursive: true, force: true });
  }
});

test("v20 项目视频原地升级 v21 后获得输入草稿默认值和全局设置", async () => {
  const dataRoot = await mkdtemp(join(tmpdir(), "yingshu-database-v20-input-"));
  try {
    const current = openDatabase(dataRoot);
    current.database.prepare(
      "INSERT INTO projects (id, name, created_at, updated_at) VALUES ('project', '项目', 1, 1)",
    ).run();
    current.database.prepare(
      `INSERT INTO videos (id, project_id, title, status, created_at, updated_at)
       VALUES ('video', 'project', '视频', 'draft', 2, 2)`,
    ).run();
    dropVideoPlanTables(current.database);
    current.database.exec(`
      DROP TABLE global_prompt_settings;
      ALTER TABLE videos DROP COLUMN visual_instructions;
      ALTER TABLE videos DROP COLUMN script_instructions;
      ALTER TABLE videos DROP COLUMN web_enabled;
      ALTER TABLE videos DROP COLUMN visual_density;
      ALTER TABLE videos DROP COLUMN target_duration_seconds;
      ALTER TABLE videos DROP COLUMN reference_role;
      ALTER TABLE videos DROP COLUMN reference_text;
      ALTER TABLE videos DROP COLUMN body;
      ALTER TABLE videos DROP COLUMN topic;
      ALTER TABLE videos DROP COLUMN input_mode;
      ALTER TABLE projects DROP COLUMN visual_instructions;
      ALTER TABLE projects DROP COLUMN script_instructions;
      DELETE FROM schema_migrations WHERE version >= 21;
    `);
    current.close();

    const upgraded = openDatabase(dataRoot);
    try {
      const video = upgraded.database.prepare(
        `SELECT input_mode, topic, body, reference_role, target_duration_seconds, visual_density, web_enabled
         FROM videos WHERE id = 'video'`,
      ).get();
      assert.deepEqual({ ...video }, {
        input_mode: "topic", topic: "", body: "", reference_role: "style_only",
        target_duration_seconds: 180, visual_density: "standard", web_enabled: 1,
      });
      assert.deepEqual({ ...upgraded.database.prepare(
        "SELECT script_instructions, visual_instructions, updated_at FROM global_prompt_settings WHERE id = 1",
      ).get() }, { script_instructions: "", visual_instructions: "", updated_at: 0 });
      assert.equal(upgraded.database.prepare("SELECT MAX(version) AS version FROM schema_migrations")
        .get()?.version, 26);
    } finally {
      upgraded.close();
    }
  } finally {
    await rm(dataRoot, { recursive: true, force: true });
  }
});

test("v21 视频原地升级 v22 后保留全部输入列并获得严格计划状态", async () => {
  const dataRoot = await mkdtemp(join(tmpdir(), "yingshu-database-v21-plan-"));
  try {
    const current = openDatabase(dataRoot);
    current.database.prepare(
      "INSERT INTO projects (id, name, created_at, updated_at) VALUES ('project', '项目', 1, 1)",
    ).run();
    current.database.prepare(`INSERT INTO videos (
      id, project_id, title, status, created_at, updated_at, input_mode, topic, body,
      reference_text, reference_role, target_duration_seconds, visual_density, web_enabled,
      script_instructions, visual_instructions
    ) VALUES ('video', 'project', '视频', 'draft', 2, 3, 'body', '主题', '正文',
      '参考', 'content_source', 600, 'compact', 0, '旁白要求', '画面要求')`).run();
    dropVideoPlanTables(current.database);
    current.database.exec(`
      ALTER TABLE videos RENAME TO videos_v22_current;
      CREATE TABLE videos (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        title TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 100),
        status TEXT NOT NULL CHECK (status = 'draft'),
        created_at INTEGER NOT NULL CHECK (created_at >= 0),
        updated_at INTEGER NOT NULL CHECK (updated_at >= created_at),
        input_mode TEXT NOT NULL DEFAULT 'topic' CHECK (input_mode IN ('topic', 'body')),
        topic TEXT NOT NULL DEFAULT '' CHECK (length(topic) <= 200),
        body TEXT NOT NULL DEFAULT '' CHECK (length(CAST(body AS BLOB)) <= 131072),
        reference_text TEXT NOT NULL DEFAULT '' CHECK (length(CAST(reference_text AS BLOB)) <= 65536),
        reference_role TEXT NOT NULL DEFAULT 'style_only' CHECK (reference_role IN ('style_only', 'content_source')),
        target_duration_seconds INTEGER NOT NULL DEFAULT 180 CHECK (target_duration_seconds BETWEEN 60 AND 600),
        visual_density TEXT NOT NULL DEFAULT 'standard' CHECK (visual_density IN ('relaxed', 'standard', 'compact')),
        web_enabled INTEGER NOT NULL DEFAULT 1 CHECK (web_enabled IN (0, 1)),
        script_instructions TEXT NOT NULL DEFAULT '' CHECK (length(script_instructions) <= 20000),
        visual_instructions TEXT NOT NULL DEFAULT '' CHECK (length(visual_instructions) <= 20000)
      ) STRICT;
      INSERT INTO videos SELECT * FROM videos_v22_current;
      DROP TABLE videos_v22_current;
      CREATE INDEX videos_project_order ON videos(project_id, updated_at DESC, id);
      DELETE FROM schema_migrations WHERE version >= 22;
    `);
    current.close();

    const upgraded = openDatabase(dataRoot);
    try {
      assert.deepEqual({ ...upgraded.database.prepare(
        `SELECT input_mode, topic, body, reference_text, reference_role, target_duration_seconds,
                visual_density, web_enabled, script_instructions, visual_instructions
         FROM videos WHERE id = 'video'`,
      ).get() }, {
        input_mode: "body", topic: "主题", body: "正文", reference_text: "参考",
        reference_role: "content_source", target_duration_seconds: 600, visual_density: "compact",
        web_enabled: 0, script_instructions: "旁白要求", visual_instructions: "画面要求",
      });
      upgraded.database.prepare("UPDATE videos SET status = 'awaiting_review' WHERE id = 'video'").run();
      upgraded.database.prepare("UPDATE videos SET status = 'rendering' WHERE id = 'video'").run();
      upgraded.database.prepare("UPDATE videos SET status = 'completed' WHERE id = 'video'").run();
      assert.throws(() => upgraded.database.prepare("UPDATE videos SET status = 'published' WHERE id = 'video'").run(),
        /CHECK constraint failed/);
      assert.equal(upgraded.database.prepare("SELECT MAX(version) AS version FROM schema_migrations").get()?.version, 26);
    } finally { upgraded.close(); }
  } finally { await rm(dataRoot, { recursive: true, force: true }); }
});

test("v22 计划表约束冻结身份、追加 revision 并随视频完整级联", async () => {
  const dataRoot = await mkdtemp(join(tmpdir(), "yingshu-database-v22-contract-"));
  const connection = openDatabase(dataRoot);
  const database = connection.database;
  const hash = "a".repeat(64);
  try {
    database.exec(`
      INSERT INTO projects (id, name, created_at, updated_at) VALUES ('project', '项目', 1, 1);
      INSERT INTO projects (id, name, created_at, updated_at) VALUES ('other', '其他项目', 1, 1);
      INSERT INTO videos (id, project_id, title, status, created_at, updated_at)
        VALUES ('video', 'project', '视频', 'draft', 1, 1);
      INSERT INTO videos (id, project_id, title, status, created_at, updated_at)
        VALUES ('other_video', 'other', '其他视频', 'draft', 1, 1);
    `);
    database.prepare(`INSERT INTO video_plan_snapshots (
      id, video_id, idempotency_key, input_json, prompt_json, model_json, system_contract_version,
      web_capability, canonical_json, snapshot_hash, created_at
    ) VALUES ('snapshot', 'video', 'request-1', '{}', '{}', '{}', 'v1', 'disabled', '{}', ?, 2)`).run(hash);
    database.prepare(
      "INSERT INTO jobs (id, type, payload_json, status, run_after, created_at, updated_at) VALUES ('job', 'video_plan', '{}', 'queued', 2, 2, 2)",
    ).run();
    database.prepare(
      "INSERT INTO video_plan_jobs (job_id, video_id, snapshot_id, created_at) VALUES ('job', 'video', 'snapshot', 2)",
    ).run();
    database.prepare(`INSERT INTO video_plan_sources (
      id, video_id, snapshot_id, source_index, query, provider, tool, retrieved_at, url, title,
      usage_summary, audit_excerpt, content_hash, status, created_at
    ) VALUES ('source', 'video', 'snapshot', 0, '查询', 'provider', 'search', 3,
      'https://example.com', '来源', '摘要', '审计', ?, 'succeeded', 3)`).run(hash);
    database.prepare(`INSERT INTO video_script_revisions (
      id, video_id, snapshot_id, revision, content_json, content_hash, provider_id, model_id,
      prompt_version, prompt_hash, created_at
    ) VALUES ('script', 'video', 'snapshot', 1, '{}', ?, 'provider', 'model', 'v1', ?, 4)`).run(hash, hash);
    database.prepare(`INSERT INTO video_visual_revisions (
      id, video_id, snapshot_id, script_revision_id, script_content_hash, revision,
      content_json, content_hash, created_at
    ) VALUES ('visual', 'video', 'snapshot', 'script', ?, 1, '{}', ?, 5)`).run(hash, hash);
    database.prepare(`INSERT INTO video_plan_approvals (
      id, video_id, snapshot_id, revision, script_revision_id, visual_revision_id,
      script_content_hash, visual_content_hash, created_at
    ) VALUES ('approval', 'video', 'snapshot', 1, 'script', 'visual', ?, ?, 6)`).run(hash, hash);

    assert.throws(
      () => database.prepare("UPDATE video_plan_snapshots SET input_json = '{\"changed\":true}' WHERE id = 'snapshot'").run(),
      /video plan snapshot is immutable/,
    );
    database.prepare("UPDATE video_plan_snapshots SET invalidated_at = 7 WHERE id = 'snapshot'").run();
    assert.throws(
      () => database.prepare("UPDATE video_plan_snapshots SET invalidated_at = 8 WHERE id = 'snapshot'").run(),
      /video plan snapshot is immutable/,
    );
    assert.throws(() => database.prepare("DELETE FROM video_plan_snapshots WHERE id = 'snapshot'").run(), /immutable/);
    assert.throws(
      () => database.prepare("UPDATE video_script_revisions SET content_json = '{}' WHERE id = 'script'").run(),
      /append-only/,
    );
    assert.throws(() => database.prepare("DELETE FROM video_plan_approvals WHERE id = 'approval'").run(), /append-only/);
    assert.throws(
      () => database.prepare(`INSERT INTO video_plan_sources (
        id, video_id, snapshot_id, source_index, query, provider, tool, retrieved_at, url, title,
        usage_summary, audit_excerpt, content_hash, status, created_at
      ) VALUES ('cross', 'other_video', 'snapshot', 1, '查询', 'provider', 'search', 3,
        'https://example.com/2', '来源', '', '', ?, 'succeeded', 3)`).run(hash),
      /FOREIGN KEY constraint failed/,
    );
    assert.throws(
      () => database.prepare("UPDATE video_plan_sources SET content_hash = 'ABC' WHERE id = 'source'").run(),
      /CHECK constraint failed/,
    );

    database.prepare("DELETE FROM projects WHERE id = 'project'").run();
    for (const table of [
      "videos", "video_plan_snapshots", "video_plan_jobs", "video_plan_sources",
      "video_script_revisions", "video_visual_revisions", "video_plan_approvals",
    ]) {
      assert.equal(database.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE ${table === "videos" ? "id" : "video_id"} = 'video'`).get()?.count, 0);
    }
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM jobs WHERE id = 'job'").get()?.count, 1);
    assert.equal(database.prepare("PRAGMA foreign_key_check").all().length, 0);
  } finally {
    connection.close();
    await rm(dataRoot, { recursive: true, force: true });
  }
});

test("初始化失败会关闭 SQLite 文件", async () => {
  const dataRoot = await mkdtemp(join(tmpdir(), "narralume-database-invalid-"));
  const databasePath = join(dataRoot, "yingshu.sqlite3");

  try {
    const malformed = new DatabaseSync(databasePath);
    malformed.exec("CREATE TABLE schema_migrations (bad_column INTEGER) STRICT");
    malformed.close();

    assert.throws(() => openDatabase(dataRoot), /no such column: version/);
    await rm(databasePath);
  } finally {
    await rm(dataRoot, { recursive: true, force: true });
  }
});

test("v23 图片表冻结生成身份并以追加事件记录审核", async () => {
  const dataRoot = await mkdtemp(join(tmpdir(), "yingshu-database-v23-images-"));
  const connection = openDatabase(dataRoot);
  const db = connection.database;
  const hash = "a".repeat(64);
  const fileHash = "b".repeat(64);
  try {
    db.exec(`
      INSERT INTO projects (id, name, created_at, updated_at) VALUES ('project', '项目', 1, 1);
      INSERT INTO projects (id, name, created_at, updated_at) VALUES ('other', '其他', 1, 1);
      INSERT INTO videos (id, project_id, title, status, created_at, updated_at)
        VALUES ('video', 'project', '视频', 'awaiting_review', 1, 1);
    `);
    db.prepare(`INSERT INTO video_plan_snapshots (
      id, video_id, idempotency_key, input_json, prompt_json, model_json, system_contract_version,
      web_capability, canonical_json, snapshot_hash, created_at
    ) VALUES ('snapshot', 'video', 'plan-request', '{}', '{}', '{}', 'v1', 'disabled', '{}', ?, 2)`).run(hash);
    db.prepare(`INSERT INTO video_script_revisions (
      id, video_id, snapshot_id, revision, content_json, content_hash, provider_id, model_id,
      prompt_version, prompt_hash, created_at
    ) VALUES ('script', 'video', 'snapshot', 1, '{}', ?, 'provider', 'model', 'v1', ?, 3)`).run(hash, hash);
    db.prepare(`INSERT INTO video_visual_revisions (
      id, video_id, snapshot_id, script_revision_id, script_content_hash, revision,
      content_json, content_hash, created_at
    ) VALUES ('visual-revision', 'video', 'snapshot', 'script', ?, 1, '{}', ?, 4)`).run(hash, hash);
    db.prepare(`INSERT INTO video_image_batches (
      id, project_id, video_id, plan_snapshot_id, plan_snapshot_hash, script_revision_id,
      script_content_hash, visual_revision_id, visual_content_hash, mode, idempotency_key,
      provider_id, model_id, planned_count, created_at
    ) VALUES ('batch', 'project', 'video', 'snapshot', ?, 'script', ?, 'visual-revision', ?,
      'batch', 'image-request', 'provider', 'model', 1, 5)`).run(hash, hash, hash);
    db.prepare("INSERT INTO jobs (id, type, payload_json, status, run_after, created_at, updated_at) VALUES ('image-job', 'video_image', '{}', 'queued', 5, 5, 5)").run();
    db.prepare(`INSERT INTO video_image_batch_items (
      batch_id, video_id, visual_id, job_id, request_identity, status, created_at, updated_at
    ) VALUES ('batch', 'video', 'scene-1', 'image-job', 'scene-request-1', 'queued', 5, 5)`).run();
    assert.throws(() => db.prepare(`INSERT INTO video_image_batch_items (
      batch_id, video_id, visual_id, request_identity, status, created_at, updated_at
    ) VALUES ('batch', 'video', 'scene-1', 'scene-request-2', 'queued', 5, 5)`).run(), /UNIQUE constraint failed/);
    db.prepare(`INSERT INTO video_image_candidates (
      id, project_id, video_id, plan_snapshot_id, plan_snapshot_hash, script_revision_id,
      script_content_hash, visual_revision_id, visual_content_hash, visual_id, prompt,
      negative_prompt, style_snapshot_json, prompt_hash, provider_id, model_id, params_json,
      request_identity, job_id, attempt, checkpoint_scope, provider_request_id, status,
      origin, relative_path, mime, bytes, width, height, file_hash, created_at
    ) VALUES ('candidate', 'project', 'video', 'snapshot', ?, 'script', ?, 'visual-revision', ?,
      'scene-1', '完整提示词', '', '{}', ?, 'provider', 'model', '{}', 'candidate-request',
      'image-job', 1, 'scene-1', 'safe-id', 'succeeded', 'generated',
      'videos/video/images/b.png', 'image/png', 68, 1, 1, ?, 6)`).run(hash, hash, hash, hash, fileHash);
    assert.throws(() => db.prepare("UPDATE video_image_candidates SET prompt = 'changed' WHERE id = 'candidate'").run(), /immutable/);
    assert.throws(() => db.prepare(`INSERT INTO video_image_candidates (
      id, project_id, video_id, plan_snapshot_id, plan_snapshot_hash, script_revision_id,
      script_content_hash, visual_revision_id, visual_content_hash, visual_id, prompt,
      negative_prompt, style_snapshot_json, prompt_hash, provider_id, model_id, params_json,
      request_identity, attempt, checkpoint_scope, status, error_category, error_summary,
      origin, relative_path, mime, bytes, width, height, file_hash, created_at
    ) VALUES ('bad-failure', 'project', 'video', 'snapshot', ?, 'script', ?, 'visual-revision', ?,
      'scene-1', '提示词', '', '{}', ?, 'provider', 'model', '{}', 'failed-request', 1,
      'scene-1', 'failed', 'temporary', '可重试', 'generated', 'unsafe.png', 'image/png',
      1, 1, 1, ?, 7)`).run(hash, hash, hash, hash, fileHash), /CHECK constraint failed/);
    db.prepare(`INSERT INTO video_image_approval_events (
      id, project_id, video_id, gate_revision, visual_id, candidate_id, plan_snapshot_id,
      plan_snapshot_hash, script_revision_id, script_content_hash, visual_revision_id,
      visual_content_hash, prompt_hash, candidate_hash, created_at
    ) VALUES ('approval-1', 'project', 'video', 1, 'scene-1', 'candidate', 'snapshot', ?,
      'script', ?, 'visual-revision', ?, ?, ?, 8)`).run(hash, hash, hash, hash, fileHash);
    assert.throws(() => db.prepare("UPDATE video_image_approval_events SET gate_revision = 2 WHERE id = 'approval-1'").run(), /append-only/);
    db.prepare("UPDATE videos SET status = 'producing_media' WHERE id = 'video'").run();
    db.prepare("UPDATE videos SET status = 'awaiting_media_review' WHERE id = 'video'").run();
    assert.throws(() => db.prepare("UPDATE videos SET status = 'synthesizing_audio' WHERE id = 'video'").run(), /CHECK constraint failed/);
    db.prepare("DELETE FROM projects WHERE id = 'project'").run();
    for (const table of ["video_image_batches", "video_image_batch_items", "video_image_candidates", "video_image_approval_events"]) {
      assert.equal(db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get()?.count, 0);
    }
    assert.equal(db.prepare("PRAGMA foreign_key_check").all().length, 0);
  } finally {
    connection.close();
    await rm(dataRoot, { recursive: true, force: true });
  }
});

test("未来迁移版本或版本断层会失败关闭", async () => {
  for (const mode of ["future", "gap"] as const) {
    const dataRoot = await mkdtemp(join(tmpdir(), `narralume-database-${mode}-`));
    const databasePath = join(dataRoot, "yingshu.sqlite3");
    try {
      openDatabase(dataRoot).close();
      const malformed = new DatabaseSync(databasePath);
      if (mode === "future") malformed.prepare("INSERT INTO schema_migrations (version) VALUES (27)").run();
      else malformed.prepare("DELETE FROM schema_migrations WHERE version = 1").run();
      malformed.close();

      assert.throws(() => openDatabase(dataRoot), /数据库迁移版本不兼容/);
      await rm(databasePath);
    } finally {
      await rm(dataRoot, { recursive: true, force: true });
    }
  }
});

test("v25 建立 Video 视觉审核与最终渲染严格表，并扩展成片状态", async () => {
  const dataRoot = await mkdtemp(join(tmpdir(), "yingshu-database-v25-visual-render-"));
  const connection = openDatabase(dataRoot);
  try {
    const expected = [
      "video_final_videos", "video_render_chunks", "video_render_runs", "video_visual_review_events",
      "video_visual_segments", "video_visual_timelines",
    ];
    const tables = connection.database.prepare(
      `SELECT name FROM sqlite_master WHERE type='table' AND name IN (${expected.map(() => "?").join(",")}) ORDER BY name`,
    ).all(...expected) as Array<{ name: string }>;
    assert.deepEqual(tables.map((table) => table.name), expected);
    const chunkSchema = connection.database.prepare(
      "SELECT sql FROM sqlite_master WHERE type='table' AND name='video_render_chunks'",
    ).get()?.sql as string;
    assert.match(chunkSchema, /UNIQUE \(run_id, identity_hash\)/u);
    assert.doesNotMatch(chunkSchema, /UNIQUE \(identity_hash\)/u);
    const triggers = connection.database.prepare(
      "SELECT name FROM sqlite_master WHERE type='trigger' AND name LIKE 'video_visual_%' ORDER BY name",
    ).all() as Array<{ name: string }>;
    assert.deepEqual(triggers.map((trigger) => trigger.name), [
      "video_visual_reviews_immutable", "video_visual_reviews_no_delete", "video_visual_revisions_immutable",
      "video_visual_revisions_no_delete", "video_visual_segments_immutable", "video_visual_segments_no_delete",
      "video_visual_timelines_immutable", "video_visual_timelines_no_delete",
    ]);
    connection.database.prepare("INSERT INTO projects (id,name,created_at,updated_at) VALUES ('p25','项目',1,1)").run();
    connection.database.prepare(
      "INSERT INTO videos (id,project_id,title,status,created_at,updated_at) VALUES ('v25','p25','视频','rendering',1,1)",
    ).run();
    connection.database.prepare("UPDATE videos SET status='completed',updated_at=2 WHERE id='v25'").run();
    assert.equal(connection.database.prepare("SELECT status FROM videos WHERE id='v25'").get()?.status, "completed");
    assert.equal(connection.database.prepare("PRAGMA foreign_key_check").all().length, 0);
  } finally { connection.close(); await rm(dataRoot, { recursive: true, force: true }); }
});

test("既有 migration v2 数据库可原地升级 checkpoint、章节事件与分集表", async () => {
  const dataRoot = await mkdtemp(join(tmpdir(), "narralume-database-v2-upgrade-"));
  try {
    const current = openDatabase(dataRoot);
    downgradeCurrentDatabaseFromV18(current.database);
    current.database.exec("DROP TABLE book_story_bibles; DROP TABLE series_pipeline_jobs; DROP TABLE series_pipeline_runs");
    current.database.exec("DROP TABLE render_chunks; DROP TABLE visual_segment_assets; DROP TABLE visual_segments");
    current.database.exec("DROP TABLE asset_candidate_review_events; DROP TABLE asset_candidates; DROP TABLE asset_aliases; DROP TABLE assets");
    current.database.exec("DROP TABLE subtitle_cues; DROP TABLE audio_segments");
    current.database.exec("DROP TABLE script_approval_events");
    current.database.exec("DROP TABLE script_version_sources");
    current.database.exec("DROP TABLE script_versions");
    current.database.exec("DROP TABLE episode_sources");
    current.database.exec("DROP TABLE episodes");
    current.database.exec("DROP TABLE series_projects");
    current.database.exec("DROP TABLE chapter_event_sources");
    current.database.exec("DROP TABLE chapter_events");
    current.database.exec("DROP TABLE job_checkpoints");
    current.database.prepare("DELETE FROM schema_migrations WHERE version >= 3").run();
    current.close();

    const upgraded = openDatabase(dataRoot);
    const migration = upgraded.database
      .prepare("SELECT MAX(version) AS version FROM schema_migrations")
      .get();
    const checkpointTable = upgraded.database
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'job_checkpoints'")
      .get();
    const eventTable = upgraded.database
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'chapter_events'")
      .get();
    assert.equal(migration?.version, 26);
    assert.equal(checkpointTable?.name, "job_checkpoints");
    assert.equal(eventTable?.name, "chapter_events");
    upgraded.close();
  } finally {
    await rm(dataRoot, { recursive: true, force: true });
  }
});

test("既有 migration v5 数据库可升级批准事件且删除分集会完整级联", async () => {
  const dataRoot = await mkdtemp(join(tmpdir(), "narralume-database-v5-upgrade-"));
  try {
    const current = openDatabase(dataRoot);
    downgradeCurrentDatabaseFromV18(current.database);
    current.database.exec("DROP TABLE book_story_bibles; DROP TABLE series_pipeline_jobs; DROP TABLE series_pipeline_runs");
    current.database.exec("DROP TABLE render_chunks; DROP TABLE visual_segment_assets; DROP TABLE visual_segments");
    current.database.exec("DROP TABLE asset_candidate_review_events; DROP TABLE asset_candidates; DROP TABLE asset_aliases; DROP TABLE assets");
    current.database.exec("DROP TABLE subtitle_cues; DROP TABLE audio_segments");
    current.database.exec("DROP TABLE script_approval_events; DROP TABLE script_version_sources; DROP TABLE script_versions");
    current.database.exec("ALTER TABLE job_checkpoints DROP COLUMN output_json");
    current.database.prepare("DELETE FROM schema_migrations WHERE version >= 6").run();
    current.database.prepare(
      `INSERT INTO books (
         id, title, original_file_path, original_file_hash, encoding, import_status
       ) VALUES ('book_v5', '旧书', 'books/book_v5/source.txt', ?, 'UTF-8', 'ready')`,
    ).run("c".repeat(64));
    current.database.prepare(
      `INSERT INTO series_projects (id, book_id, title, created_at, updated_at)
       VALUES ('series_v5', 'book_v5', '系列', 1, 1)`,
    ).run();
    current.database.prepare(
      `INSERT INTO episodes (
         id, series_project_id, episode_index, title, story_arc,
         target_duration_seconds, created_at, updated_at
       ) VALUES ('episode_v5', 'series_v5', 1, '第一集', '开端', 180, 1, 1)`,
    ).run();
    current.close();

    const upgraded = openDatabase(dataRoot);
    assert.equal(
      upgraded.database.prepare("SELECT MAX(version) AS version FROM schema_migrations").get()?.version,
      26,
    );
    upgraded.database.prepare(
      `INSERT INTO script_versions (
         id, episode_id, kind, version, content_json, content_hash, created_at
       ) VALUES ('script_v5', 'episode_v5', 'faithful', 1, '{}', ?, 1)`,
    ).run("d".repeat(64));
    upgraded.database.prepare(
      `INSERT INTO script_version_sources (
         script_version_id, segment_index, source_index, episode_source_index,
         chapter_id, source_event_id, source_byte_start, source_byte_end, source_hash
       ) VALUES ('script_v5', 0, 0, 0, 'chapter', 'event', 0, 1, ?)`,
    ).run("e".repeat(64));
    upgraded.database.prepare(
      `INSERT INTO script_approval_events (
         id, episode_id, revision, action, script_version_id, created_at
       ) VALUES ('approval_v5', 'episode_v5', 1, 'approve', 'script_v5', 1)`,
    ).run();
    upgraded.database.prepare("DELETE FROM episodes WHERE id = 'episode_v5'").run();
    assert.equal(upgraded.database.prepare("SELECT COUNT(*) AS count FROM script_versions").get()?.count, 0);
    assert.equal(upgraded.database.prepare("SELECT COUNT(*) AS count FROM script_version_sources").get()?.count, 0);
    assert.equal(upgraded.database.prepare("SELECT COUNT(*) AS count FROM script_approval_events").get()?.count, 0);
    upgraded.close();
  } finally {
    await rm(dataRoot, { recursive: true, force: true });
  }
});

test("既有 migration v7 数据库可升级音频段与字幕并约束不可变历史", async () => {
  const dataRoot = await mkdtemp(join(tmpdir(), "narralume-database-v7-upgrade-"));
  try {
    const current = openDatabase(dataRoot);
    downgradeCurrentDatabaseFromV18(current.database);
    current.database.exec("DROP TABLE book_story_bibles; DROP TABLE series_pipeline_jobs; DROP TABLE series_pipeline_runs");
    current.database.exec("DROP TABLE render_chunks; DROP TABLE visual_segment_assets; DROP TABLE visual_segments");
    current.database.exec("DROP TABLE asset_candidate_review_events; DROP TABLE asset_candidates; DROP TABLE asset_aliases; DROP TABLE assets");
    current.database.exec("DROP TABLE subtitle_cues; DROP TABLE audio_segments");
    current.database.exec("ALTER TABLE job_checkpoints DROP COLUMN output_json");
    current.database.prepare("DELETE FROM schema_migrations WHERE version >= 8").run();
    current.database.prepare(
      `INSERT INTO books (
         id, title, original_file_path, original_file_hash, encoding, import_status
       ) VALUES ('book_v7', '旧书', 'books/book_v7/source.txt', ?, 'UTF-8', 'ready')`,
    ).run("1".repeat(64));
    current.database.prepare(
      `INSERT INTO series_projects (id, book_id, title, created_at, updated_at)
       VALUES ('series_v7', 'book_v7', '系列', 1, 1)`,
    ).run();
    current.database.prepare(
      `INSERT INTO episodes (
         id, series_project_id, episode_index, title, story_arc,
         target_duration_seconds, created_at, updated_at
       ) VALUES ('episode_v7', 'series_v7', 1, '第一集', '开端', 180, 1, 1)`,
    ).run();
    current.database.prepare(
      `INSERT INTO script_versions (
         id, episode_id, kind, version, content_json, content_hash, created_at
       ) VALUES ('script_v7', 'episode_v7', 'packaged', 1, '{}', ?, 1)`,
    ).run("2".repeat(64));
    current.close();

    const upgraded = openDatabase(dataRoot);
    assert.equal(
      upgraded.database.prepare("SELECT MAX(version) AS version FROM schema_migrations").get()?.version,
      26,
    );
    const audioTables = upgraded.database
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'audio_%' ORDER BY name")
      .all() as Array<{ name: string }>;
    assert.deepEqual(audioTables.map((table) => table.name), ["audio_segments"]);

    const insertSegment = upgraded.database.prepare(
      `INSERT INTO audio_segments (
         timeline_hash, segment_index, episode_id, script_version_id, text,
         provider_id, voice, rate, input_hash, relative_path, file_hash,
         bytes, duration_ms, created_at
       ) VALUES (?, ?, 'episode_v7', 'script_v7', ?, 'system-speech', 'Huihui', ?, ?, ?, ?, ?, ?, 1)`,
    );
    const runSegment = (overrides: {
      timelineHash?: string;
      segmentIndex?: number;
      text?: string;
      rate?: number;
      inputHash?: string;
      relativePath?: string;
      fileHash?: string;
      bytes?: number;
      durationMs?: number;
    } = {}) => insertSegment.run(
      overrides.timelineHash ?? "3".repeat(64),
      overrides.segmentIndex ?? 0,
      overrides.text ?? "第一段旁白",
      overrides.rate ?? 0,
      overrides.inputHash ?? "4".repeat(64),
      overrides.relativePath ?? "episodes/episode_v7/audio/segment.wav",
      overrides.fileHash ?? "5".repeat(64),
      overrides.bytes ?? 1024,
      overrides.durationMs ?? 1200,
    );

    runSegment();
    for (const invalid of [
      { timelineHash: "ABC" },
      { segmentIndex: 1, text: "" },
      { segmentIndex: 1, rate: 11 },
      { segmentIndex: 1, bytes: 0 },
      { segmentIndex: 1, durationMs: 0 },
    ]) {
      assert.throws(() => runSegment(invalid), /CHECK constraint failed/);
    }

    upgraded.database.prepare(
      `INSERT INTO subtitle_cues (
         timeline_hash, cue_index, segment_index, episode_id, script_version_id,
         start_ms, end_ms, text
       ) VALUES (?, 0, 0, 'episode_v7', 'script_v7', 0, 1200, '第一段旁白')`,
    ).run("3".repeat(64));
    assert.throws(
      () => upgraded.database.prepare(
        `INSERT INTO subtitle_cues (
           timeline_hash, cue_index, segment_index, episode_id, script_version_id,
           start_ms, end_ms, text
         ) VALUES (?, 1, 99, 'episode_v7', 'script_v7', 1200, 1300, '不存在的段')`,
      ).run("3".repeat(64)),
      /FOREIGN KEY constraint failed/,
    );

    upgraded.database.prepare("DELETE FROM episodes WHERE id = 'episode_v7'").run();
    assert.equal(upgraded.database.prepare("SELECT COUNT(*) AS count FROM audio_segments").get()?.count, 0);
    assert.equal(upgraded.database.prepare("SELECT COUNT(*) AS count FROM subtitle_cues").get()?.count, 0);
    upgraded.close();
  } finally {
    await rm(dataRoot, { recursive: true, force: true });
  }
});

test("既有 migration v4 数据库可升级 v5 且删除书籍会级联分集数据", async () => {
  const dataRoot = await mkdtemp(join(tmpdir(), "narralume-database-v4-upgrade-"));
  try {
    const current = openDatabase(dataRoot);
    downgradeCurrentDatabaseFromV18(current.database);
    current.database.exec("DROP TABLE book_story_bibles; DROP TABLE series_pipeline_jobs; DROP TABLE series_pipeline_runs");
    current.database.exec("DROP TABLE render_chunks; DROP TABLE visual_segment_assets; DROP TABLE visual_segments");
    current.database.exec("DROP TABLE asset_candidate_review_events; DROP TABLE asset_candidates; DROP TABLE asset_aliases; DROP TABLE assets");
    current.database.exec("DROP TABLE subtitle_cues; DROP TABLE audio_segments");
    current.database.exec("DROP TABLE script_approval_events; DROP TABLE script_version_sources; DROP TABLE script_versions");
    current.database.exec("DROP TABLE episode_sources; DROP TABLE episodes; DROP TABLE series_projects");
    current.database.exec("ALTER TABLE job_checkpoints DROP COLUMN output_json");
    current.database.prepare("DELETE FROM schema_migrations WHERE version >= 5").run();
    current.database.prepare(
      `INSERT INTO books (
         id, title, original_file_path, original_file_hash, encoding, import_status
       ) VALUES ('book_v4', '旧书', 'books/book_v4/source.txt', ?, 'UTF-8', 'ready')`,
    ).run("b".repeat(64));
    current.close();

    const upgraded = openDatabase(dataRoot);
    assert.equal(
      upgraded.database.prepare("SELECT MAX(version) AS version FROM schema_migrations").get()?.version,
      26,
    );
    upgraded.database.prepare(
      `INSERT INTO series_projects (id, book_id, title, created_at, updated_at)
       VALUES ('series_v4', 'book_v4', '系列', 1, 1)`,
    ).run();
    upgraded.database.prepare(
      `INSERT INTO chapters (
         id, book_id, chapter_index, title, byte_start, byte_end, char_count, content_hash
       ) VALUES ('chapter_v4', 'book_v4', 0, '第一章', 0, 1, 1, 'hash')`,
    ).run();
    upgraded.database.prepare(
      `INSERT INTO episodes (
         id, series_project_id, episode_index, title, story_arc,
         target_duration_seconds, created_at, updated_at
       ) VALUES ('episode_v4', 'series_v4', 1, '第一集', '开端', 180, 1, 1)`,
    ).run();
    upgraded.database.prepare(
      `INSERT INTO episode_sources (
         episode_id, source_index, chapter_id, source_event_id,
         source_byte_start, source_byte_end, source_hash
       ) VALUES ('episode_v4', 0, 'chapter_v4', 'event_snapshot', 0, 1, ?)`,
    ).run("a".repeat(64));
    upgraded.database.prepare("DELETE FROM books WHERE id = 'book_v4'").run();
    assert.equal(upgraded.database.prepare("SELECT COUNT(*) AS count FROM series_projects").get()?.count, 0);
    assert.equal(upgraded.database.prepare("SELECT COUNT(*) AS count FROM episodes").get()?.count, 0);
    assert.equal(upgraded.database.prepare("SELECT COUNT(*) AS count FROM episode_sources").get()?.count, 0);
    upgraded.close();
  } finally {
    await rm(dataRoot, { recursive: true, force: true });
  }
});

test("既有 migration v8 数据库可升级资产合同并保持关系约束", async () => {
  const dataRoot = await mkdtemp(join(tmpdir(), "narralume-database-v8-upgrade-"));
  try {
    const current = openDatabase(dataRoot);
    downgradeCurrentDatabaseFromV18(current.database);
    current.database.exec("DROP TABLE book_story_bibles; DROP TABLE series_pipeline_jobs; DROP TABLE series_pipeline_runs");
    current.database.exec("DROP TABLE render_chunks; DROP TABLE visual_segment_assets; DROP TABLE visual_segments");
    current.database.exec("DROP TABLE asset_candidate_review_events; DROP TABLE asset_candidates; DROP TABLE asset_aliases; DROP TABLE assets");
    current.database.exec("ALTER TABLE job_checkpoints DROP COLUMN output_json");
    current.database.prepare("DELETE FROM schema_migrations WHERE version >= 9").run();
    current.database.prepare(
      `INSERT INTO books (
         id, title, original_file_path, original_file_hash, encoding, import_status
       ) VALUES ('book_assets', '资产测试', 'books/book_assets/source.txt', ?, 'UTF-8', 'ready')`,
    ).run("6".repeat(64));
    current.database.prepare(
      `INSERT INTO series_projects (id, book_id, title, created_at, updated_at)
       VALUES ('series_assets', 'book_assets', '系列一', 1, 1),
              ('series_other', 'book_assets', '系列二', 1, 1)`,
    ).run();
    current.close();

    const upgraded = openDatabase(dataRoot);
    assert.equal(
      upgraded.database.prepare("SELECT MAX(version) AS version FROM schema_migrations").get()?.version,
      26,
    );
    const tables = upgraded.database.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('assets', 'asset_aliases') ORDER BY name",
    ).all() as Array<{ name: string }>;
    assert.deepEqual(tables.map((table) => table.name), ["asset_aliases", "assets"]);

    const insertAsset = upgraded.database.prepare(
      `INSERT INTO assets (
         id, series_project_id, asset_type, asset_role, canonical_name, normalized_name,
         parent_asset_id, state_label, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)`,
    );
    insertAsset.run(
      "asset_master", "series_assets", "character", "master", "林黛玉", "林黛玉", null, null,
    );
    insertAsset.run(
      "asset_state", "series_assets", "character", "state", "林黛玉·病中", "林黛玉·病中",
      "asset_master", "病中",
    );

    for (const invalid of [
      ["bad_type", "series_assets", "sound", "master", "声音", "声音", null, null],
      ["bad_master", "series_assets", "character", "master", "错误主资产", "错误主资产", "asset_master", null],
      ["bad_state", "series_assets", "character", "state", "错误状态", "错误状态", null, "病中"],
      ["bad_self", "series_assets", "character", "state", "自指", "自指", "bad_self", "自指"],
      ["bad_series", "series_other", "character", "state", "跨系列", "跨系列", "asset_master", "病中"],
      ["bad_type_parent", "series_assets", "scene", "state", "跨类型", "跨类型", "asset_master", "夜景"],
    ] as const) {
      assert.throws(
        () => insertAsset.run(...invalid),
        /(CHECK|FOREIGN KEY) constraint failed|state asset parent must be master/,
      );
    }
    assert.throws(
      () => insertAsset.run(
        "bad_nested_state", "series_assets", "character", "state", "状态套状态", "状态套状态",
        "asset_state", "二级状态",
      ),
      /state asset parent must be master/,
    );
    insertAsset.run(
      "asset_master_2", "series_assets", "character", "master", "薛宝钗", "薛宝钗", null, null,
    );
    assert.throws(
      () => upgraded.database.prepare(
        `UPDATE assets
         SET asset_role = 'state', parent_asset_id = 'asset_state', state_label = '错误嵌套'
         WHERE id = 'asset_master_2'`,
      ).run(),
      /state asset parent must be master/,
    );
    assert.throws(
      () => upgraded.database.prepare(
        `UPDATE assets
         SET asset_role = 'state', parent_asset_id = 'asset_master_2', state_label = '错误降级'
         WHERE id = 'asset_master'`,
      ).run(),
      /master asset with state children cannot change hierarchy/,
    );
    upgraded.database.prepare(
      "UPDATE assets SET description = '允许更新描述' WHERE id = 'asset_master'",
    ).run();
    assert.equal(
      upgraded.database.prepare("SELECT description FROM assets WHERE id = 'asset_master'").get()?.description,
      "允许更新描述",
    );

    const insertAlias = upgraded.database.prepare(
      `INSERT INTO asset_aliases (
         series_project_id, asset_id, alias, normalized_alias, is_primary, created_at
       ) VALUES (?, ?, ?, ?, ?, 1)`,
    );
    insertAlias.run("series_assets", "asset_master", "林黛玉", "林黛玉", 1);
    insertAlias.run("series_assets", "asset_master", "黛玉", "黛玉", 0);
    assert.throws(
      () => insertAlias.run("series_assets", "asset_state", "黛玉", "黛玉", 0),
      /UNIQUE constraint failed/,
    );
    assert.throws(
      () => insertAlias.run("series_assets", "asset_master", "林姑娘", "林姑娘", 1),
      /UNIQUE constraint failed/,
    );
    assert.throws(
      () => insertAlias.run("series_assets", "asset_master", "无效", "无效", 2),
      /CHECK constraint failed/,
    );
    assert.throws(
      () => upgraded.database.prepare("DELETE FROM assets WHERE id = 'asset_master'").run(),
      /FOREIGN KEY constraint failed/,
    );

    upgraded.database.prepare(
      `INSERT INTO asset_candidates (
         id, asset_id, source_kind, source_identity_hash, source_json, file_hash,
         mime, width, height, bytes, relative_path, created_at
       ) VALUES ('candidate_v10', 'asset_master', 'upload', ?, '{"kind":"upload","originalName":"a.png"}', ?,
         'image/png', 32, 32, 100, 'assets/candidates/aa/aa.png', 1)`,
    ).run("7".repeat(64), "8".repeat(64));
    upgraded.database.prepare(
      `INSERT INTO asset_candidate_review_events (candidate_id, revision, action, note, created_at)
       VALUES ('candidate_v10', 1, 'approve', NULL, 1)`,
    ).run();
    assert.throws(
      () => upgraded.database.prepare(
        `INSERT INTO asset_candidates (
           id, asset_id, source_kind, source_identity_hash, source_json, file_hash,
           mime, width, height, bytes, relative_path, created_at
         ) VALUES ('candidate_bad', 'asset_master', 'upload', ?, '{}', ?,
           'image/gif', 32, 32, 100, 'bad.gif', 1)`,
      ).run("9".repeat(64), "a".repeat(64)),
      /CHECK constraint failed/,
    );

    upgraded.close();
    const reopened = openDatabase(dataRoot);
    assert.equal(reopened.database.prepare("SELECT COUNT(*) AS count FROM assets").get()?.count, 3);
    assert.equal(reopened.database.prepare("SELECT COUNT(*) AS count FROM asset_aliases").get()?.count, 2);
    assert.equal(reopened.database.prepare("SELECT COUNT(*) AS count FROM asset_candidates").get()?.count, 1);
    assert.equal(reopened.database.prepare("SELECT COUNT(*) AS count FROM asset_candidate_review_events").get()?.count, 1);
    reopened.database.prepare("DELETE FROM series_projects WHERE id = 'series_assets'").run();
    assert.equal(reopened.database.prepare("SELECT COUNT(*) AS count FROM assets").get()?.count, 0);
    assert.equal(reopened.database.prepare("SELECT COUNT(*) AS count FROM asset_aliases").get()?.count, 0);
    assert.equal(reopened.database.prepare("SELECT COUNT(*) AS count FROM asset_candidates").get()?.count, 0);
    assert.equal(reopened.database.prepare("SELECT COUNT(*) AS count FROM asset_candidate_review_events").get()?.count, 0);
    reopened.close();
  } finally {
    await rm(dataRoot, { recursive: true, force: true });
  }
});

test("既有 migration v10 数据库可升级视觉段与显式资产关系", async () => {
  const dataRoot = await mkdtemp(join(tmpdir(), "narralume-database-v10-upgrade-"));
  try {
    const current = openDatabase(dataRoot);
    downgradeCurrentDatabaseFromV18(current.database);
    current.database.exec("DROP TABLE book_story_bibles; DROP TABLE series_pipeline_jobs; DROP TABLE series_pipeline_runs");
    current.database.exec("DROP TABLE render_chunks; DROP TABLE visual_segment_assets; DROP TABLE visual_segments");
    current.database.exec("DROP INDEX asset_candidates_id_asset");
    current.database.exec("ALTER TABLE job_checkpoints DROP COLUMN output_json");
    current.database.prepare("DELETE FROM schema_migrations WHERE version >= 11").run();
    current.close();

    const upgraded = openDatabase(dataRoot);
    assert.equal(
      upgraded.database.prepare("SELECT MAX(version) AS version FROM schema_migrations").get()?.version,
      26,
    );
    const tables = upgraded.database.prepare(
      `SELECT name FROM sqlite_master
       WHERE type = 'table' AND name IN ('visual_segments', 'visual_segment_assets') ORDER BY name`,
    ).all() as Array<{ name: string }>;
    assert.deepEqual(tables.map((table) => table.name), ["visual_segment_assets", "visual_segments"]);
    const triggers = upgraded.database.prepare(
      `SELECT name FROM sqlite_master
       WHERE type = 'trigger' AND name LIKE 'visual_segment_assets_same_series%' ORDER BY name`,
    ).all() as Array<{ name: string }>;
    assert.deepEqual(triggers.map((trigger) => trigger.name), [
      "visual_segment_assets_same_series",
      "visual_segment_assets_same_series_on_update",
    ]);
    upgraded.close();
  } finally {
    await rm(dataRoot, { recursive: true, force: true });
  }
});

test("既有 migration v11 数据库保留数据升级 render_chunks 并执行完整约束", async () => {
  const dataRoot = await mkdtemp(join(tmpdir(), "narralume-database-v11-upgrade-"));
  try {
    const current = openDatabase(dataRoot);
    downgradeCurrentDatabaseFromV18(current.database);
    current.database.exec("DROP TABLE book_story_bibles; DROP TABLE series_pipeline_jobs; DROP TABLE series_pipeline_runs");
    current.database.prepare(
      `INSERT INTO books (id, title, original_file_path, original_file_hash, encoding, import_status)
       VALUES ('book_v11', '旧数据', 'books/book_v11/source.txt', ?, 'UTF-8', 'ready')`,
    ).run("1".repeat(64));
    current.database.prepare(
      "INSERT INTO series_projects (id, book_id, title, created_at, updated_at) VALUES ('series_v11', 'book_v11', '系列', 1, 1)",
    ).run();
    current.database.prepare(
      `INSERT INTO episodes (id, series_project_id, episode_index, title, story_arc,
         target_duration_seconds, created_at, updated_at)
       VALUES ('episode_v11', 'series_v11', 1, '第一集', '故事弧', 180, 1, 1)`,
    ).run();
    current.database.prepare(
      `INSERT INTO script_versions (id, episode_id, kind, version, content_json, content_hash, created_at)
       VALUES ('script_v11', 'episode_v11', 'packaged', 1, '{}', ?, 1)`,
    ).run("2".repeat(64));
    current.database.exec("DROP TABLE render_chunks");
    current.database.exec("ALTER TABLE job_checkpoints DROP COLUMN output_json");
    current.database.prepare("DELETE FROM schema_migrations WHERE version >= 12").run();
    current.close();

    const upgraded = openDatabase(dataRoot);
    const database = upgraded.database;
    assert.equal(database.prepare("SELECT MAX(version) AS version FROM schema_migrations").get()?.version, 26);
    assert.equal(database.prepare("SELECT title FROM books WHERE id = 'book_v11'").get()?.title, "旧数据");
    assert.equal(database.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='render_chunks'").get()?.name, "render_chunks");
    const insert = database.prepare(
      `INSERT INTO render_chunks (render_hash, episode_id, timeline_hash, chunk_index,
         script_version_id, approval_revision, start_ms, end_ms, relative_path,
         file_hash, bytes, duration_ms, created_at)
       VALUES (?, ?, ?, ?, 'script_v11', 1, ?, ?, ?, ?, 10, ?, 1)`,
    );
    const timeline = "3".repeat(64);
    insert.run("4".repeat(64), "episode_v11", timeline, 0, 0, 60_000, "episodes/episode_v11/renders/chunks/44/4.mp4", "5".repeat(64), 60_000);
    insert.run("6".repeat(64), "episode_v11", timeline, 1, 60_000, 240_000, "episodes/episode_v11/renders/chunks/66/6.mp4", "7".repeat(64), 180_000);
    assert.throws(
      () => insert.run("bad", "episode_v11", timeline, 2, 240_000, 300_000, "bad.mp4", "8".repeat(64), 60_000),
      /CHECK constraint failed/,
    );
    assert.throws(
      () => insert.run("8".repeat(64), "episode_v11", timeline, 2, 240_000, 299_999, "bad.mp4", "9".repeat(64), 59_999),
      /CHECK constraint failed/,
    );
    assert.throws(
      () => insert.run("8".repeat(64), "episode_v11", timeline, 2, 240_000, 420_001, "bad.mp4", "9".repeat(64), 180_001),
      /CHECK constraint failed/,
    );
    assert.throws(
      () => insert.run("8".repeat(64), "episode_v11", timeline, 2, 240_000, 300_000, "bad.mp4", "BAD", 60_000),
      /CHECK constraint failed/,
    );
    assert.throws(
      () => insert.run("8".repeat(64), "missing_episode", timeline, 2, 240_000, 300_000, "bad.mp4", "9".repeat(64), 60_000),
      /FOREIGN KEY constraint failed/,
    );
    assert.throws(
      () => insert.run("8".repeat(64), "episode_v11", timeline, 0, 240_000, 300_000, "duplicate.mp4", "9".repeat(64), 60_000),
      /UNIQUE constraint failed/,
    );
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM render_chunks").get()?.count, 2);
    database.prepare("DELETE FROM episodes WHERE id = 'episode_v11'").run();
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM render_chunks").get()?.count, 0);
    upgraded.close();
  } finally {
    await rm(dataRoot, { recursive: true, force: true });
  }
});

test("既有 migration v12 数据库升级时保留 Episode 与全部下游外键", async () => {
  const dataRoot = await mkdtemp(join(tmpdir(), "narralume-database-v12-upgrade-"));
  const path = join(dataRoot, "yingshu.sqlite3");
  try {
    const current = openDatabase(dataRoot);
    downgradeCurrentDatabaseFromV18(current.database);
    const db = current.database;
    db.prepare(`INSERT INTO books (id,title,original_file_path,original_file_hash,encoding,import_status)
      VALUES ('book_v12','书','books/book/source.txt','hash','UTF-8','ready')`).run();
    db.prepare("INSERT INTO series_projects (id,book_id,title,created_at,updated_at) VALUES ('series_v12','book_v12','系列',1,1)").run();
    db.prepare(`INSERT INTO episodes (id,series_project_id,episode_index,title,story_arc,target_duration_seconds,created_at,updated_at)
      VALUES ('episode_v12','series_v12',1,'第一集','弧',240,1,1)`).run();
    db.prepare(`INSERT INTO script_versions (id,episode_id,kind,version,content_json,content_hash,created_at)
      VALUES ('script_v12','episode_v12','packaged',1,'{}',?,1)`).run("a".repeat(64));
    db.prepare(`INSERT INTO script_approval_events (id,episode_id,revision,action,script_version_id,created_at)
      VALUES ('approval_v12','episode_v12',1,'approve','script_v12',1)`).run();
    current.close();

    const old = new DatabaseSync(path);
    old.exec(`PRAGMA foreign_keys=OFF;
      DROP TRIGGER visual_segment_assets_same_series;
      DROP TRIGGER visual_segment_assets_same_series_on_update;
      CREATE TABLE episodes_old (
        id TEXT PRIMARY KEY, series_project_id TEXT NOT NULL REFERENCES series_projects(id) ON DELETE CASCADE,
        episode_index INTEGER NOT NULL CHECK (episode_index >= 1), title TEXT NOT NULL CHECK(length(title)>0),
        story_arc TEXT NOT NULL CHECK(length(story_arc)>0),
        target_duration_seconds INTEGER NOT NULL CHECK(target_duration_seconds BETWEEN 180 AND 300),
        recap TEXT, next_hook TEXT, created_at INTEGER NOT NULL CHECK(created_at>=0),
        updated_at INTEGER NOT NULL CHECK(updated_at>=0), UNIQUE(series_project_id,episode_index)
      ) STRICT;
      INSERT INTO episodes_old SELECT * FROM episodes;
      DROP TABLE episodes;
      ALTER TABLE episodes_old RENAME TO episodes;
      CREATE TRIGGER visual_segment_assets_same_series BEFORE INSERT ON visual_segment_assets BEGIN
        SELECT RAISE(ABORT, 'visual segment asset must belong to episode series') WHERE NOT EXISTS (
          SELECT 1 FROM visual_segments segment JOIN episodes episode ON episode.id=segment.episode_id
          JOIN assets asset ON asset.id=NEW.asset_id WHERE segment.id=NEW.visual_segment_id
          AND asset.series_project_id=episode.series_project_id);
      END;
      CREATE TRIGGER visual_segment_assets_same_series_on_update BEFORE UPDATE ON visual_segment_assets BEGIN
        SELECT RAISE(ABORT, 'visual segment asset must belong to episode series') WHERE NOT EXISTS (
          SELECT 1 FROM visual_segments segment JOIN episodes episode ON episode.id=segment.episode_id
          JOIN assets asset ON asset.id=NEW.asset_id WHERE segment.id=NEW.visual_segment_id
          AND asset.series_project_id=episode.series_project_id);
      END;
      DROP TABLE book_story_bibles;
      DROP TABLE series_pipeline_jobs;
      DROP TABLE series_pipeline_runs;
      ALTER TABLE job_checkpoints DROP COLUMN output_json;
      DELETE FROM schema_migrations WHERE version>=13;
      PRAGMA foreign_keys=ON;`);
    old.close();

    const upgraded = openDatabase(dataRoot);
    const database = upgraded.database;
    assert.equal(database.prepare("SELECT target_duration_seconds FROM episodes WHERE id='episode_v12'").get()?.target_duration_seconds, 240);
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM script_versions WHERE episode_id='episode_v12'").get()?.count, 1);
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM script_approval_events WHERE episode_id='episode_v12'").get()?.count, 1);
    assert.equal(database.prepare("PRAGMA foreign_key_check").all().length, 0);
    database.prepare("UPDATE episodes SET target_duration_seconds=1200 WHERE id='episode_v12'").run();
    assert.throws(() => database.prepare("UPDATE episodes SET target_duration_seconds=59 WHERE id='episode_v12'").run(), /CHECK constraint failed/);
    assert.throws(() => database.prepare("UPDATE episodes SET target_duration_seconds=3601 WHERE id='episode_v12'").run(), /CHECK constraint failed/);
    database.prepare("DELETE FROM episodes WHERE id='episode_v12'").run();
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM script_versions").get()?.count, 0);
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM script_approval_events").get()?.count, 0);
    upgraded.close();
  } finally { await rm(dataRoot, { recursive: true, force: true }); }
});

test("既有 migration v13 数据库升级流水线表并执行 active、约束和外键", async () => {
  const dataRoot = await mkdtemp(join(tmpdir(), "narralume-database-v13-upgrade-"));
  try {
    const current = openDatabase(dataRoot);
    downgradeCurrentDatabaseFromV18(current.database);
    const database = current.database;
    database.prepare(`INSERT INTO books (id,title,original_file_path,original_file_hash,encoding,import_status)
      VALUES ('book_pipeline','书','books/book/source.txt',?,'UTF-8','ready')`).run("a".repeat(64));
    database.prepare(`INSERT INTO chapters
      (id,book_id,chapter_index,title,byte_start,byte_end,char_count,content_hash)
      VALUES ('chapter_1','book_pipeline',0,'第一章',0,1,1,?)`).run("b".repeat(64));
    database.prepare("INSERT INTO series_projects (id,book_id,title,created_at,updated_at) VALUES ('series_pipeline','book_pipeline','系列',1,1)").run();
    database.exec("DROP TABLE book_story_bibles; DROP TABLE series_pipeline_jobs; DROP TABLE series_pipeline_runs; ALTER TABLE job_checkpoints DROP COLUMN output_json; DELETE FROM schema_migrations WHERE version>=14");
    current.close();

    const upgraded = openDatabase(dataRoot);
    const db = upgraded.database;
    assert.equal(db.prepare("SELECT MAX(version) AS version FROM schema_migrations").get()?.version, 26);
    const insert = db.prepare(`INSERT INTO series_pipeline_runs
      (id,series_project_id,status,episode_count,target_duration_seconds,source_start_chapter_id,
       source_end_chapter_id,config_hash,created_at,updated_at)
      VALUES (?,?,'configured',10,1200,'chapter_1','chapter_1',?,1,1)`);
    insert.run("run_1", "series_pipeline", "c".repeat(64));
    const legacyConfig = db.prepare(
      "SELECT chapter_batch_size, chapter_concurrency FROM series_pipeline_runs WHERE id='run_1'",
    ).get() as { chapter_batch_size: number; chapter_concurrency: number };
    assert.equal(legacyConfig.chapter_batch_size, 1);
    assert.equal(legacyConfig.chapter_concurrency, 1);
    assert.throws(() => insert.run("run_2", "series_pipeline", "d".repeat(64)), /UNIQUE constraint failed/);
    assert.throws(
      () => db.prepare(`INSERT INTO series_pipeline_runs
        (id,series_project_id,status,episode_count,target_duration_seconds,source_start_chapter_id,
         source_end_chapter_id,config_hash,created_at,updated_at)
        VALUES ('bad_count','series_pipeline','cancelled',0,1200,'chapter_1','chapter_1',?,1,1)`).run("e".repeat(64)),
      /CHECK constraint failed/,
    );
    db.prepare("INSERT INTO jobs (id,type,payload_json,status,run_after,created_at,updated_at) VALUES ('job_1','chapter_events_analyze','{}','queued',1,1,1)").run();
    db.prepare(`INSERT INTO series_pipeline_jobs (run_id,stage,subject_type,subject_id,job_id,created_at)
      VALUES ('run_1','chapter_analysis','chapter','chapter_1','job_1',1)`).run();
    assert.throws(
      () => db.prepare(`INSERT INTO series_pipeline_jobs (run_id,stage,subject_type,subject_id,job_id,created_at)
        VALUES ('run_1','chapter_analysis','chapter','chapter_missing','job_missing',1)`).run(),
      /FOREIGN KEY constraint failed/,
    );
    db.prepare("DELETE FROM series_projects WHERE id='series_pipeline'").run();
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM series_pipeline_runs").get()?.count, 0);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM series_pipeline_jobs").get()?.count, 0);
    upgraded.close();
  } finally { await rm(dataRoot, { recursive: true, force: true }); }
});
