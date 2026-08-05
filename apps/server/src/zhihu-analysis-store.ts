import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

import { createJob, getJob, requestJobCancellation, type JobRecord } from "./job-store.js";
import { getVideo } from "./project-video-store.js";
import { cancelActiveVideoImageJobs } from "./video-image-invalidation.js";
import { canonicalZhihuJson, ZHIHU_ANALYSIS_JOB_TYPE, zhihuAnalysisConfigHash, zhihuSha256,
  type ZhihuAnalysisConfig, type ZhihuAnalysisReport, type ZhihuAnalysisSelectionInput,
  type ZhihuAnalysisStatus, type ZhihuCompleteness, type ZhihuUsageRole, ZhihuAnalysisContractError,
} from "./zhihu-analysis-contract.js";

interface SnapshotRow {
  id: string; video_id: string; question_id: string; answer_id: string; source_url: string;
  config_json: string; config_hash: string; evidence_hash: string | null; report_json: string | null;
  report_hash: string | null; status: ZhihuAnalysisStatus; completeness: ZhihuCompleteness;
  artifact_manifest_json: string | null; model_snapshot_json: string | null; prompt_version: string | null;
  created_at: number; completed_at: number | null; invalidated_at: number | null;
}

export interface ZhihuAnalysisSnapshot {
  id: string; videoId: string; questionId: string; answerId: string; sourceUrl: string;
  config: ZhihuAnalysisConfig; configHash: string; evidenceHash: string | null; report: ZhihuAnalysisReport | null;
  reportHash: string | null; status: ZhihuAnalysisStatus; completeness: ZhihuCompleteness;
  artifactManifest: Record<string, unknown> | null; modelSnapshot: Record<string, unknown> | null;
  promptVersion: string | null; createdAt: number; completedAt: number | null; invalidatedAt: number | null;
}

export interface ZhihuAnalysisSelection {
  videoId: string; snapshotId: string; usageRole: ZhihuUsageRole; creativeAngle: string;
  rightsConfirmed: boolean; updatedAt: number;
}

function snapshot(row: SnapshotRow): ZhihuAnalysisSnapshot {
  return { id: row.id, videoId: row.video_id, questionId: row.question_id, answerId: row.answer_id,
    sourceUrl: row.source_url, config: JSON.parse(row.config_json) as ZhihuAnalysisConfig, configHash: row.config_hash,
    evidenceHash: row.evidence_hash, report: row.report_json ? JSON.parse(row.report_json) as ZhihuAnalysisReport : null,
    reportHash: row.report_hash, status: row.status, completeness: row.completeness,
    artifactManifest: row.artifact_manifest_json ? JSON.parse(row.artifact_manifest_json) as Record<string, unknown> : null,
    modelSnapshot: row.model_snapshot_json ? JSON.parse(row.model_snapshot_json) as Record<string, unknown> : null,
    promptVersion: row.prompt_version, createdAt: row.created_at, completedAt: row.completed_at, invalidatedAt: row.invalidated_at };
}

function selection(row: { video_id: string; snapshot_id: string; usage_role: ZhihuUsageRole; creative_angle: string;
  rights_confirmed: number; updated_at: number }): ZhihuAnalysisSelection {
  return { videoId: row.video_id, snapshotId: row.snapshot_id, usageRole: row.usage_role,
    creativeAngle: row.creative_angle, rightsConfirmed: row.rights_confirmed === 1, updatedAt: row.updated_at };
}

function json(value: unknown, label: string) {
  const result = JSON.stringify(value);
  if (result === undefined) throw new ZhihuAnalysisContractError(400, `${label}必须可序列化为 JSON`);
  return result;
}

function requireSnapshot(database: DatabaseSync, videoId: string, snapshotId: string) {
  const row = database.prepare("SELECT * FROM video_zhihu_analysis_snapshots WHERE id=? AND video_id=?")
    .get(snapshotId, videoId) as SnapshotRow | undefined;
  if (!row) throw new ZhihuAnalysisContractError(404, "知乎分析快照不存在或不属于当前视频");
  return snapshot(row);
}

function activeMappedJobs(database: DatabaseSync, table: "video_plan_jobs" | "video_tts_jobs" | "video_render_runs", videoId: string) {
  const query = table === "video_render_runs"
    ? "SELECT job_id AS id FROM video_render_runs JOIN jobs ON jobs.id=video_render_runs.job_id WHERE video_id=? AND jobs.status IN ('queued','running')"
    : `SELECT map.job_id AS id FROM ${table} map JOIN jobs ON jobs.id=map.job_id WHERE map.video_id=? AND jobs.status IN ('queued','running')`;
  return database.prepare(query).all(videoId) as Array<{ id: string }>;
}

/** 选择变化会使依赖旧来源的全部生产产物失效；历史记录仍保留。 */
function invalidateZhihuDownstream(database: DatabaseSync, videoId: string, now: number) {
  database.prepare("UPDATE video_plan_snapshots SET invalidated_at=? WHERE video_id=? AND invalidated_at IS NULL").run(now, videoId);
  database.prepare("UPDATE video_tts_snapshots SET invalidated_at=? WHERE video_id=? AND invalidated_at IS NULL").run(now, videoId);
  for (const job of [...activeMappedJobs(database, "video_plan_jobs", videoId), ...activeMappedJobs(database, "video_tts_jobs", videoId),
    ...activeMappedJobs(database, "video_render_runs", videoId)]) requestJobCancellation(database, job.id, now);
  cancelActiveVideoImageJobs(database, videoId, now);
  database.prepare(`UPDATE video_render_runs SET status='cancelled',updated_at=? WHERE video_id=? AND status='queued'
    AND job_id IN (SELECT id FROM jobs WHERE status='cancelled')`).run(now, videoId);
  database.prepare(`UPDATE video_render_chunks SET status='cancelled',updated_at=? WHERE video_id=? AND status='queued'
    AND run_id IN (SELECT id FROM video_render_runs WHERE status='cancelled')`).run(now, videoId);
  database.prepare("UPDATE videos SET status='draft',updated_at=? WHERE id=?").run(now, videoId);
}

export function getZhihuAnalysisSnapshot(database: DatabaseSync, projectId: string, videoId: string, snapshotId: string) {
  getVideo(database, projectId, videoId); return requireSnapshot(database, videoId, snapshotId);
}

export function getCurrentZhihuAnalysisSnapshot(database: DatabaseSync, projectId: string, videoId: string) {
  getVideo(database, projectId, videoId);
  const row = database.prepare("SELECT * FROM video_zhihu_analysis_snapshots WHERE video_id=? ORDER BY created_at DESC,id DESC LIMIT 1")
    .get(videoId) as SnapshotRow | undefined;
  return row ? snapshot(row) : null;
}

export function getZhihuAnalysisSelection(database: DatabaseSync, projectId: string, videoId: string) {
  getVideo(database, projectId, videoId);
  const row = database.prepare("SELECT * FROM video_zhihu_analysis_selections WHERE video_id=?").get(videoId) as
    { video_id: string; snapshot_id: string; usage_role: ZhihuUsageRole; creative_angle: string; rights_confirmed: number; updated_at: number } | undefined;
  return row ? selection(row) : null;
}

export function getZhihuAnalysisJob(database: DatabaseSync, projectId: string, videoId: string) {
  getVideo(database, projectId, videoId);
  const row = database.prepare(`SELECT job_id AS id FROM video_zhihu_analysis_jobs WHERE video_id=?
    ORDER BY created_at DESC,job_id DESC LIMIT 1`).get(videoId) as { id: string } | undefined;
  return row ? getJob(database, row.id) ?? null : null;
}

export function enqueueZhihuAnalysis(database: DatabaseSync, input: {
  projectId: string; videoId: string; questionId: string; answerId: string; config: ZhihuAnalysisConfig;
  modelSnapshot?: Record<string, unknown> | null; promptVersion?: string | null; now?: number;
}) {
  const now = input.now ?? Date.now(); getVideo(database, input.projectId, input.videoId);
  if (!/^\d{1,32}$/u.test(input.questionId) || !/^\d{1,32}$/u.test(input.answerId)) {
    throw new ZhihuAnalysisContractError(400, "知乎问题或回答 ID 无效");
  }
  const configHash = zhihuAnalysisConfigHash(input.config);
  database.exec("BEGIN IMMEDIATE");
  try {
    const active = database.prepare(`SELECT jobs.id FROM video_zhihu_analysis_jobs map JOIN jobs ON jobs.id=map.job_id
      WHERE map.video_id=? AND jobs.status IN ('queued','running') LIMIT 1`).get(input.videoId);
    if (active) throw new ZhihuAnalysisContractError(409, "当前视频已有正在执行的知乎分析，请勿重复提交");
    const reusableRow = database.prepare(`SELECT * FROM video_zhihu_analysis_snapshots
      WHERE video_id=? AND answer_id=? AND config_hash=? AND invalidated_at IS NULL ORDER BY created_at DESC,id DESC LIMIT 1`)
      .get(input.videoId, input.answerId, configHash) as SnapshotRow | undefined;
    if (reusableRow?.status === "succeeded") { database.exec("COMMIT"); return { snapshot: snapshot(reusableRow), job: null, created: false, reusable: true }; }
    let target = reusableRow ? snapshot(reusableRow) : null;
    if (!target) {
      const previous = database.prepare("SELECT id FROM video_zhihu_analysis_snapshots WHERE video_id=? AND invalidated_at IS NULL LIMIT 1")
        .get(input.videoId);
      if (previous) {
        database.prepare("UPDATE video_zhihu_analysis_snapshots SET invalidated_at=? WHERE video_id=? AND invalidated_at IS NULL").run(now, input.videoId);
        invalidateZhihuDownstream(database, input.videoId, now);
      }
      const id = `zas_${randomUUID()}`;
      database.prepare(`INSERT INTO video_zhihu_analysis_snapshots
        (id,video_id,question_id,answer_id,source_url,config_json,config_hash,status,completeness,model_snapshot_json,prompt_version,created_at)
        VALUES (?,?,?,?,?,?,?,'queued','unavailable',?,?,?)`).run(id, input.videoId, input.questionId, input.answerId,
        input.config.sourceUrl, json(input.config, "知乎分析配置"), configHash,
        input.modelSnapshot ? json(input.modelSnapshot, "分析模型快照") : null, input.promptVersion ?? null, now);
      target = requireSnapshot(database, input.videoId, id);
    } else {
      database.prepare("UPDATE video_zhihu_analysis_snapshots SET status='queued',completed_at=NULL WHERE id=?").run(target.id);
      target = requireSnapshot(database, input.videoId, target.id);
    }
    const job = createJob(database, { type: ZHIHU_ANALYSIS_JOB_TYPE,
      payload: { projectId: input.projectId, videoId: input.videoId, snapshotId: target.id }, maxAttempts: 3 }, now);
    database.prepare("INSERT INTO video_zhihu_analysis_jobs (job_id,video_id,snapshot_id,created_at) VALUES (?,?,?,?)")
      .run(job.id, input.videoId, target.id, now);
    database.prepare("UPDATE videos SET status='preparing_sources',updated_at=? WHERE id=?").run(now, input.videoId);
    database.exec("COMMIT"); return { snapshot: target, job, created: true, reusable: false };
  } catch (error) { try { database.exec("ROLLBACK"); } catch { /* 保留原始事务错误。 */ } throw error; }
}

export function updateZhihuAnalysisSnapshot(database: DatabaseSync, input: {
  snapshotId: string; status: ZhihuAnalysisStatus; completeness: ZhihuCompleteness; evidenceHash?: string | null;
  report?: ZhihuAnalysisReport | null; artifactManifest?: Record<string, unknown> | null;
  modelSnapshot?: Record<string, unknown> | null; promptVersion?: string | null; completedAt?: number | null;
}) {
  const current = database.prepare("SELECT * FROM video_zhihu_analysis_snapshots WHERE id=?").get(input.snapshotId) as SnapshotRow | undefined;
  if (!current) throw new ZhihuAnalysisContractError(404, "知乎分析快照不存在");
  if (current.invalidated_at !== null) throw new ZhihuAnalysisContractError(409, "知乎分析快照已失效");
  const evidenceHash = input.evidenceHash === undefined ? current.evidence_hash : input.evidenceHash;
  if (evidenceHash !== null && !/^[0-9a-f]{64}$/u.test(evidenceHash)) throw new ZhihuAnalysisContractError(400, "证据 Hash 无效");
  const reportJson = input.report === undefined ? current.report_json : input.report === null ? null : json(input.report, "知乎分析报告");
  const reportHash = reportJson === null ? null : zhihuSha256(canonicalZhihuJson(JSON.parse(reportJson)));
  const manifestJson = input.artifactManifest === undefined ? current.artifact_manifest_json
    : input.artifactManifest === null ? null : json(input.artifactManifest, "分析产物清单");
  const modelSnapshotJson = input.modelSnapshot === undefined ? current.model_snapshot_json
    : input.modelSnapshot === null ? null : json(input.modelSnapshot, "分析模型快照");
  database.prepare(`UPDATE video_zhihu_analysis_snapshots SET status=?,completeness=?,evidence_hash=?,report_json=?,report_hash=?,
    artifact_manifest_json=?,model_snapshot_json=?,prompt_version=?,completed_at=? WHERE id=? AND invalidated_at IS NULL`).run(input.status, input.completeness,
    evidenceHash, reportJson, reportHash, manifestJson, modelSnapshotJson,
    input.promptVersion === undefined ? current.prompt_version : input.promptVersion,
    input.completedAt === undefined ? current.completed_at : input.completedAt, input.snapshotId);
  return requireSnapshot(database, current.video_id, input.snapshotId);
}

export function saveZhihuAnalysisSelection(database: DatabaseSync, input: {
  projectId: string; videoId: string; selection: ZhihuAnalysisSelectionInput; now?: number;
}) {
  const now = input.now ?? Date.now(); const video = getVideo(database, input.projectId, input.videoId);
  const target = requireSnapshot(database, input.videoId, input.selection.snapshotId);
  if (target.invalidatedAt !== null || !target.reportHash || !target.report) throw new ZhihuAnalysisContractError(409, "当前知乎分析快照不可用于创作");
  if (input.selection.acceptedMissingDimensions.some((dimension) => dimension === "comments"
    ? target.report!.evidence.commentsStatus !== "partial" : target.report!.availability[dimension].status === "available")) {
    throw new ZhihuAnalysisContractError(400, "只能接受当前确实缺失或部分可用的分析维度");
  }
  const required = input.selection.usageRole === "method_only" ? ["method"] as const
    : input.selection.usageRole === "topic_seed" ? ["topic"] as const : ["original"] as const;
  const blocked = required.filter((dimension) => target.report!.availability[dimension].status !== "available"
    && !input.selection.acceptedMissingDimensions.includes(dimension));
  if (blocked.length) throw new ZhihuAnalysisContractError(409, `使用方式缺少必要分析维度：${blocked.join("、")}`);
  if (input.selection.usageRole === "topic_seed") {
    const settings = database.prepare("SELECT web_enabled FROM videos WHERE id=?").get(input.videoId) as { web_enabled: number };
    if (settings.web_enabled !== 1) throw new ZhihuAnalysisContractError(409, "沿用知乎选题并重新研究需要开启联网查证");
  }
  database.exec("BEGIN IMMEDIATE");
  try {
    const existing = database.prepare("SELECT * FROM video_zhihu_analysis_selections WHERE video_id=?").get(input.videoId) as
      { snapshot_id: string; usage_role: ZhihuUsageRole; creative_angle: string } | undefined;
    const changed = !existing || existing.snapshot_id !== target.id || existing.usage_role !== input.selection.usageRole
      || existing.creative_angle !== input.selection.creativeAngle;
    if (changed) invalidateZhihuDownstream(database, input.videoId, now);
    const rightsConfirmed = input.selection.usageRole === "content_source" ? input.selection.rightsConfirmed : false;
    database.prepare(`INSERT INTO video_zhihu_analysis_selections
      (video_id,snapshot_id,usage_role,creative_angle,rights_confirmed,updated_at) VALUES (?,?,?,?,?,?)
      ON CONFLICT(video_id) DO UPDATE SET snapshot_id=excluded.snapshot_id,usage_role=excluded.usage_role,
      creative_angle=excluded.creative_angle,rights_confirmed=excluded.rights_confirmed,updated_at=excluded.updated_at`)
      .run(input.videoId, target.id, input.selection.usageRole, input.selection.creativeAngle, rightsConfirmed ? 1 : 0, now);
    if (input.selection.acceptedMissingDimensions.length) database.prepare(`INSERT INTO video_zhihu_analysis_selection_events
      (id,video_id,snapshot_id,event_type,missing_dimensions_json,report_hash,created_at) VALUES (?,?,?,'accept_partial',?,?,?)`)
      .run(`zae_${randomUUID()}`, input.videoId, target.id, json(input.selection.acceptedMissingDimensions, "接受的缺失项"), target.reportHash, now);
    if (rightsConfirmed) database.prepare(`INSERT INTO video_zhihu_analysis_selection_events
      (id,video_id,snapshot_id,event_type,missing_dimensions_json,report_hash,created_at) VALUES (?,?,?,'confirm_rights','[]',?,?)`)
      .run(`zae_${randomUUID()}`, input.videoId, target.id, target.reportHash, now);
    database.prepare("UPDATE projects SET updated_at=MAX(updated_at,?) WHERE id=?").run(now, video.projectId);
    database.exec("COMMIT"); return getZhihuAnalysisSelection(database, input.projectId, input.videoId)!;
  } catch (error) { try { database.exec("ROLLBACK"); } catch { /* 保留原始事务错误。 */ } throw error; }
}

export function cancelZhihuAnalysisJob(database: DatabaseSync, projectId: string, videoId: string, jobId: string, now = Date.now()) {
  getVideo(database, projectId, videoId);
  const mapping = database.prepare("SELECT snapshot_id FROM video_zhihu_analysis_jobs WHERE job_id=? AND video_id=?")
    .get(jobId, videoId) as { snapshot_id: string } | undefined;
  if (!mapping) throw new ZhihuAnalysisContractError(404, "知乎分析任务不存在");
  const job = requestJobCancellation(database, jobId, now) as JobRecord | undefined;
  if (job?.status === "cancelled") database.prepare(
    "UPDATE video_zhihu_analysis_snapshots SET status='cancelled',completed_at=? WHERE id=? AND status='queued'",
  ).run(now, mapping.snapshot_id);
  return job;
}
