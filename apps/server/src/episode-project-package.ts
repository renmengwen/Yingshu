import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { backup, DatabaseSync, type DatabaseSync as Database } from "node:sqlite";

import { withDataFileMutationLock } from "./data-file-mutation-lock.js";
import { createProjectPackage } from "./project-package.js";

const HASH = /^[0-9a-f]{64}$/u;

function pruneEpisodeSnapshot(database: Database, episodeId: string, timelineHash: string) {
  database.exec("PRAGMA foreign_keys = ON; BEGIN IMMEDIATE");
  try {
    const project = database.prepare(`
      SELECT episode.id, episode.series_project_id AS seriesProjectId, series.book_id AS bookId
      FROM episodes episode JOIN series_projects series ON series.id = episode.series_project_id
      WHERE episode.id = ?
    `).get(episodeId) as { id: string; seriesProjectId: string; bookId: string } | undefined;
    if (!project) throw new Error("目标分集不存在");

    const approval = database.prepare(`
      SELECT script_version_id AS scriptVersionId, action
      FROM script_approval_events WHERE episode_id = ? ORDER BY revision DESC LIMIT 1
    `).get(episodeId) as { scriptVersionId: string; action: string } | undefined;
    if (!approval || approval.action !== "approve") throw new Error("目标分集没有当前批准的成片旁白稿");

    database.exec(`
      CREATE TEMP TABLE keep_scripts (id TEXT PRIMARY KEY) WITHOUT ROWID;
      CREATE TEMP TABLE keep_assets (id TEXT PRIMARY KEY) WITHOUT ROWID;
      CREATE TEMP TABLE keep_candidates (id TEXT PRIMARY KEY) WITHOUT ROWID;
    `);
    database.prepare(`
      INSERT INTO keep_scripts
      WITH RECURSIVE kept(id) AS (
        SELECT ? UNION SELECT script.parent_version_id FROM script_versions script JOIN kept ON script.id = kept.id
        WHERE script.parent_version_id IS NOT NULL
      ) SELECT id FROM kept
    `).run(approval.scriptVersionId);

    database.prepare("DELETE FROM series_pipeline_runs").run();
    const bibleTrigger = database.prepare(
      "SELECT sql FROM sqlite_schema WHERE type = 'trigger' AND name = 'book_story_bibles_immutable'",
    ).get() as { sql: string } | undefined;
    if (!bibleTrigger?.sql) throw new Error("全书世界观不可变约束缺失");
    database.exec("DROP TRIGGER book_story_bibles_immutable");
    database.prepare("UPDATE book_story_bibles SET job_id = NULL WHERE job_id IS NOT NULL").run();
    database.exec(bibleTrigger.sql);
    database.prepare("DELETE FROM jobs").run();
    database.prepare("DELETE FROM series_projects WHERE id <> ?").run(project.seriesProjectId);
    database.prepare("DELETE FROM books WHERE id <> ?").run(project.bookId);
    database.prepare("DELETE FROM episodes WHERE id <> ?").run(episodeId);

    database.prepare("DELETE FROM visual_segments WHERE episode_id <> ? OR timeline_hash <> ?").run(episodeId, timelineHash);
    database.prepare("DELETE FROM render_chunks WHERE episode_id <> ? OR timeline_hash <> ?").run(episodeId, timelineHash);
    database.prepare("DELETE FROM audio_segments WHERE episode_id <> ? OR timeline_hash <> ?").run(episodeId, timelineHash);
    database.prepare(`
      DELETE FROM script_approval_events WHERE episode_id <> ? OR id <> (
        SELECT id FROM script_approval_events WHERE episode_id = ? ORDER BY revision DESC LIMIT 1
      )
    `).run(episodeId, episodeId);
    database.prepare("DELETE FROM script_versions WHERE id NOT IN (SELECT id FROM keep_scripts)").run();

    database.prepare(`
      INSERT INTO keep_candidates
      SELECT DISTINCT selected_candidate_id FROM visual_segment_assets WHERE selected_candidate_id IS NOT NULL
    `).run();
    database.prepare(`
      INSERT INTO keep_assets
      WITH RECURSIVE kept(id) AS (
        SELECT DISTINCT asset_id FROM visual_segment_assets
        UNION
        SELECT asset.parent_asset_id FROM assets asset JOIN kept ON asset.id = kept.id WHERE asset.parent_asset_id IS NOT NULL
      ) SELECT id FROM kept
    `).run();
    database.prepare("DELETE FROM asset_candidates WHERE id NOT IN (SELECT id FROM keep_candidates)").run();
    database.prepare("DELETE FROM assets WHERE id NOT IN (SELECT id FROM keep_assets)").run();

    const foreignKeys = database.prepare("PRAGMA foreign_key_check").all();
    const integrity = database.prepare("PRAGMA integrity_check").all() as Array<Record<string, unknown>>;
    if (foreignKeys.length || integrity.length !== 1 || Object.values(integrity[0] ?? {})[0] !== "ok") {
      throw new Error("分集项目快照数据库校验失败");
    }
    database.exec("COMMIT");
  } catch (error) {
    try { database.exec("ROLLBACK"); } catch { /* 保留原始错误。 */ }
    throw error;
  }
  database.exec("VACUUM");
}

export async function createEpisodeProjectPackage(
  sourceDatabase: Database,
  dataRootValue: string,
  input: { packagePath: string; episodeId: string; timelineHash: string; finalExportHash: string },
) {
  if (!input.episodeId || input.episodeId.length > 200 || /[\0-\x1f\x7f]/u.test(input.episodeId)) {
    throw new Error("分集标识无效");
  }
  if (!HASH.test(input.timelineHash)) throw new Error("时间轴标识无效");
  if (!HASH.test(input.finalExportHash)) throw new Error("最终导出标识无效");
  const dataRoot = resolve(dataRootValue);
  const finalManifestRelativePath = `episodes/${input.episodeId}/exports/${input.finalExportHash.slice(0, 2)}/${input.finalExportHash}/manifest.json`;

  return withDataFileMutationLock(dataRoot, async () => {
    const temporaryRoot = await mkdtemp(join(tmpdir(), "yingshu-video-package-"));
    const snapshotPath = join(temporaryRoot, "yingshu.sqlite3");
    let snapshot: DatabaseSync | undefined;
    try {
      await backup(sourceDatabase, snapshotPath);
      snapshot = new DatabaseSync(snapshotPath);
      pruneEpisodeSnapshot(snapshot, input.episodeId, input.timelineHash);
      return await createProjectPackage(snapshot, dataRoot, {
        packagePath: input.packagePath,
        finalManifestRelativePath,
      });
    } finally {
      try { snapshot?.close(); } finally { await rm(temporaryRoot, { recursive: true, force: true }); }
    }
  });
}
