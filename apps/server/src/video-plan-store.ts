import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

import { getJob, requestJobCancellation, type JobRecord } from "./job-store.js";
import { getVideo, ProjectVideoStoreError } from "./project-video-store.js";
import { cancelActiveVideoImageJobs } from "./video-image-invalidation.js";
import {
  canonical, type FrozenVideoPlanSnapshot, parseEditedParagraphs, parseVisualItems, planObject, planText,
  scriptPrompt, sha256, VideoPlanError, type VideoPlanModelSnapshot, type VideoPlanStatus,
  type VideoScriptContent, type VideoScriptRevision, type VideoVisualContent, type VideoVisualRevision,
  VIDEO_PLAN_PROMPT_VERSION, VIDEO_PLAN_SYSTEM_CONTRACT_VERSION, VIDEO_PLAN_WEB_CAPABILITY,
} from "./video-plan-contract.js";

interface SnapshotRow {
  id: string; video_id: string; input_json: string; prompt_json: string; model_json: string;
  system_contract_version: string; web_capability: string; canonical_json: string;
  snapshot_hash: string; created_at: number; invalidated_at: number | null;
}
interface ScriptRow {
  id: string; video_id: string; snapshot_id: string; revision: number; content_json: string;
  content_hash: string; provider_id: string; model_id: string; prompt_version: string;
  prompt_hash: string; created_at: number;
}
interface VisualRow {
  id: string; video_id: string; snapshot_id: string; script_revision_id: string;
  script_content_hash: string; revision: number; content_json: string; content_hash: string; created_at: number;
}

function snapshotFromRow(row: SnapshotRow): FrozenVideoPlanSnapshot {
  return {
    id: row.id, videoId: row.video_id, input: JSON.parse(row.input_json) as FrozenVideoPlanSnapshot["input"],
    prompts: JSON.parse(row.prompt_json) as FrozenVideoPlanSnapshot["prompts"], model: JSON.parse(row.model_json) as VideoPlanModelSnapshot,
    systemContractVersion: row.system_contract_version as typeof VIDEO_PLAN_SYSTEM_CONTRACT_VERSION,
    webCapability: row.web_capability as typeof VIDEO_PLAN_WEB_CAPABILITY, canonicalJson: row.canonical_json,
    snapshotHash: row.snapshot_hash, createdAt: row.created_at, invalidatedAt: row.invalidated_at,
  };
}

function scriptRecord(row: ScriptRow): VideoScriptRevision {
  return { id: row.id, revision: row.revision, ...(JSON.parse(row.content_json) as VideoScriptContent),
    contentHash: row.content_hash, createdAt: row.created_at };
}

function visualRecord(row: VisualRow): VideoVisualRevision {
  return { id: row.id, revision: row.revision, scriptRevisionId: row.script_revision_id,
    scriptContentHash: row.script_content_hash, contentHash: row.content_hash, createdAt: row.created_at,
    ...(JSON.parse(row.content_json) as VideoVisualContent) };
}

export function getVideoPlanSnapshot(database: DatabaseSync, snapshotId: string) {
  const row = database.prepare("SELECT * FROM video_plan_snapshots WHERE id = ?").get(snapshotId) as SnapshotRow | undefined;
  if (!row) throw new VideoPlanError(404, "生成快照不存在");
  return snapshotFromRow(row);
}

export function latestVideoScript(database: DatabaseSync, videoId: string, snapshotId: string) {
  const row = database.prepare(
    "SELECT * FROM video_script_revisions WHERE video_id = ? AND snapshot_id = ? ORDER BY revision DESC LIMIT 1",
  ).get(videoId, snapshotId) as ScriptRow | undefined;
  return row ? scriptRecord(row) : null;
}

export function latestVideoVisual(database: DatabaseSync, videoId: string, snapshotId: string) {
  const row = database.prepare(
    "SELECT * FROM video_visual_revisions WHERE video_id = ? AND snapshot_id = ? ORDER BY revision DESC LIMIT 1",
  ).get(videoId, snapshotId) as VisualRow | undefined;
  return row ? visualRecord(row) : null;
}

export function isLatestValidVideoPlanSnapshot(database: DatabaseSync, videoId: string, snapshotId: string) {
  const row = database.prepare(
    "SELECT id,invalidated_at FROM video_plan_snapshots WHERE video_id = ? ORDER BY created_at DESC,id DESC LIMIT 1",
  ).get(videoId) as { id: string; invalidated_at: number | null } | undefined;
  return row?.id === snapshotId && row.invalidated_at === null;
}

export function requireVideoPlanSnapshot(database: DatabaseSync, projectId: string, videoId: string, snapshotId: unknown) {
  getVideo(database, projectId, videoId);
  const id = planText(snapshotId, "生成快照 ID", 100);
  const snapshot = getVideoPlanSnapshot(database, id);
  if (snapshot.videoId !== videoId) throw new VideoPlanError(404, "生成快照不存在或不属于当前视频");
  if (snapshot.invalidatedAt !== null) throw new VideoPlanError(409, "当前方案已因上游输入变化而失效，请重新生成");
  return snapshot;
}

export function nextVideoScriptRevision(database: DatabaseSync, videoId: string) {
  return ((database.prepare("SELECT MAX(revision) AS revision FROM video_script_revisions WHERE video_id = ?")
    .get(videoId) as { revision: number | null }).revision ?? 0) + 1;
}

export function nextVideoVisualRevision(database: DatabaseSync, videoId: string) {
  return ((database.prepare("SELECT MAX(revision) AS revision FROM video_visual_revisions WHERE video_id = ?")
    .get(videoId) as { revision: number | null }).revision ?? 0) + 1;
}

export function getVideoPlan(database: DatabaseSync, projectId: string, videoId: string) {
  getVideo(database, projectId, videoId);
  const row = database.prepare(
    "SELECT * FROM video_plan_snapshots WHERE video_id = ? ORDER BY created_at DESC, id DESC LIMIT 1",
  ).get(videoId) as SnapshotRow | undefined;
  if (!row) return null;
  const snapshot = snapshotFromRow(row);
  const script = latestVideoScript(database, videoId, snapshot.id);
  const visual = latestVideoVisual(database, videoId, snapshot.id);
  // 对外 plan 合同要求旁白与画面成组出现；执行中的局部产物仍保留在 revision 表供 checkpoint 恢复。
  if (!script || !visual) return null;
  const approvalRow = database.prepare(
    "SELECT * FROM video_plan_approvals WHERE video_id = ? AND snapshot_id = ? ORDER BY revision DESC LIMIT 1",
  ).get(videoId, snapshot.id) as { revision: number; script_revision_id: string; visual_revision_id: string;
    script_content_hash: string; visual_content_hash: string; created_at: number } | undefined;
  const valid = !!approvalRow && snapshot.invalidatedAt === null && approvalRow.script_revision_id === script?.id &&
    approvalRow.visual_revision_id === visual?.id && approvalRow.script_content_hash === script?.contentHash &&
    approvalRow.visual_content_hash === visual?.contentHash;
  return {
    snapshotId: snapshot.id, snapshotHash: snapshot.snapshotHash, webEnabled: snapshot.input.webEnabled,
    createdAt: snapshot.createdAt, stale: snapshot.invalidatedAt !== null, script, visual,
    approval: approvalRow ? { revision: approvalRow.revision, createdAt: approvalRow.created_at, valid } : null,
  };
}

export function getVideoPlanSources(database: DatabaseSync, projectId: string, videoId: string) {
  const plan = getVideoPlan(database, projectId, videoId);
  if (!plan) return { webEnabled: false, items: [] };
  const items = database.prepare(
    `SELECT id,source_index AS sourceIndex,query,provider,tool,retrieved_at AS retrievedAt,url,title,
     usage_summary AS usageSummary,status,failure_summary AS failureSummary
     FROM video_plan_sources WHERE video_id = ? AND snapshot_id = ? ORDER BY source_index,id`,
  ).all(videoId, plan.snapshotId);
  return { webEnabled: plan.webEnabled, items };
}

export function getVideoPlanJob(database: DatabaseSync, projectId: string, videoId: string) {
  getVideo(database, projectId, videoId);
  const row = database.prepare(
    `SELECT jobs.id FROM video_plan_jobs map JOIN jobs ON jobs.id = map.job_id
     WHERE map.video_id = ? ORDER BY map.created_at DESC, jobs.id DESC LIMIT 1`,
  ).get(videoId) as { id: string } | undefined;
  return row ? getJob(database, row.id) ?? null : null;
}

export function cancelVideoPlanJob(database: DatabaseSync, projectId: string, videoId: string, now = Date.now()) {
  const job = getVideoPlanJob(database, projectId, videoId);
  if (!job) throw new VideoPlanError(404, "方案任务不存在");
  const cancelled = requestJobCancellation(database, job.id, now)!;
  if (cancelled.status === "cancelled") database.prepare("UPDATE videos SET status = 'cancelled', updated_at = ? WHERE id = ?")
    .run(now, videoId);
  return cancelled;
}

export function saveVideoScriptRevision(database: DatabaseSync, projectId: string, videoId: string, raw: unknown, now = Date.now()) {
  const input = planObject(raw, "旁白修订");
  const fields = ["snapshotId", "baseRevision", "title", "summary", "paragraphs"];
  if (Object.keys(input).some((key) => !fields.includes(key)) || fields.some((key) => !(key in input))) {
    throw new VideoPlanError(422, "旁白修订字段无效");
  }
  const snapshot = requireVideoPlanSnapshot(database, projectId, videoId, input.snapshotId);
  const current = latestVideoScript(database, videoId, snapshot.id);
  if (!current) throw new VideoPlanError(409, "当前还没有可编辑的旁白方案");
  if (input.baseRevision !== current.revision) throw new VideoPlanError(409, "旁白方案已更新，请刷新后重试");
  const paragraphs = parseEditedParagraphs(input.paragraphs, current);
  const narration = paragraphs.map((item) => item.text).join("\n\n");
  const estimatedCharacters = [...narration.replace(/\s+/gu, "")].length;
  // 只持久化内容字段，避免把 revision/id/hash 等记录元数据混进 content_json。
  const content: VideoScriptContent = {
    title: planText(input.title, "标题建议", 100), summary: planText(input.summary, "内容摘要", 2_000), narration,
    estimatedCharacters, estimatedDurationSeconds: Math.round(estimatedCharacters / 3.5), paragraphs,
    sourceSummary: current.sourceSummary, risks: current.risks,
  };
  const id = `vsr_${randomUUID()}`;
  database.prepare(
    `INSERT INTO video_script_revisions (id,video_id,snapshot_id,revision,content_json,content_hash,
     provider_id,model_id,prompt_version,prompt_hash,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(id, videoId, snapshot.id, nextVideoScriptRevision(database, videoId), JSON.stringify(content), sha256(canonical(content)),
    snapshot.model.providerId, snapshot.model.modelId, VIDEO_PLAN_PROMPT_VERSION, sha256(scriptPrompt(snapshot)), now);
  cancelActiveVideoImageJobs(database, videoId, now);
  return getVideoPlan(database, projectId, videoId);
}

export function saveVideoVisualRevision(database: DatabaseSync, projectId: string, videoId: string, raw: unknown, now = Date.now()) {
  const input = planObject(raw, "画面修订");
  const fields = ["snapshotId", "baseRevision", "scriptRevisionId", "visuals"];
  if (Object.keys(input).some((key) => !fields.includes(key)) || fields.some((key) => !(key in input))) {
    throw new VideoPlanError(422, "画面修订字段无效");
  }
  const snapshot = requireVideoPlanSnapshot(database, projectId, videoId, input.snapshotId);
  const current = latestVideoVisual(database, videoId, snapshot.id);
  const script = latestVideoScript(database, videoId, snapshot.id);
  if (!current || !script) throw new VideoPlanError(409, "当前还没有可编辑的画面方案");
  if (input.baseRevision !== current.revision || input.scriptRevisionId !== script.id) {
    throw new VideoPlanError(409, "旁白或画面方案已更新，请刷新后重试");
  }
  const content = parseVisualItems(input.visuals, snapshot, script, true);
  database.prepare(
    `INSERT INTO video_visual_revisions (id,video_id,snapshot_id,script_revision_id,script_content_hash,
     revision,content_json,content_hash,created_at) VALUES (?,?,?,?,?,?,?,?,?)`,
  ).run(`vvr_${randomUUID()}`, videoId, snapshot.id, script.id, script.contentHash, nextVideoVisualRevision(database, videoId),
    JSON.stringify(content), sha256(canonical(content)), now);
  cancelActiveVideoImageJobs(database, videoId, now);
  return getVideoPlan(database, projectId, videoId);
}

export function approveVideoPlan(database: DatabaseSync, projectId: string, videoId: string, raw: unknown, now = Date.now()) {
  const input = planObject(raw, "方案批准");
  const fields = ["snapshotId", "scriptRevisionId", "visualRevisionId"];
  if (Object.keys(input).some((key) => !fields.includes(key)) || fields.some((key) => !(key in input))) {
    throw new VideoPlanError(422, "方案批准字段无效");
  }
  const snapshot = requireVideoPlanSnapshot(database, projectId, videoId, input.snapshotId);
  const script = latestVideoScript(database, videoId, snapshot.id);
  const visual = latestVideoVisual(database, videoId, snapshot.id);
  if (!script || !visual || input.scriptRevisionId !== script.id || input.visualRevisionId !== visual.id ||
      visual.scriptRevisionId !== script.id || visual.scriptContentHash !== script.contentHash) {
    throw new VideoPlanError(409, "旁白与画面方案不是同一组兼容版本，请刷新或重新保存画面方案");
  }
  const revision = ((database.prepare(
    "SELECT MAX(revision) AS revision FROM video_plan_approvals WHERE video_id = ?",
  ).get(videoId) as { revision: number | null }).revision ?? 0) + 1;
  database.prepare(
    `INSERT INTO video_plan_approvals (id,video_id,snapshot_id,revision,script_revision_id,visual_revision_id,
     script_content_hash,visual_content_hash,created_at) VALUES (?,?,?,?,?,?,?,?,?)`,
  ).run(`vpa_${randomUUID()}`, videoId, snapshot.id, revision, script.id, visual.id, script.contentHash, visual.contentHash, now);
  return getVideoPlan(database, projectId, videoId);
}

export function videoPlanJobSummary(job: JobRecord | null) {
  return job && { id: job.id, status: job.status, errorMessage: job.errorMessage, updatedAt: job.updatedAt };
}

export function videoStatus(database: DatabaseSync, projectId: string, videoId: string) {
  try { return getVideo(database, projectId, videoId).status as VideoPlanStatus; }
  catch (error) { if (error instanceof ProjectVideoStoreError) throw error; throw error; }
}
