import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

export type ScriptApprovalAction = "approve" | "withdraw";
export type ProductionPurpose = "tts" | "image" | "video";

export interface ScriptApprovalInput {
  action: ScriptApprovalAction;
  expectedRevision: number;
  scriptVersionId?: string | null;
}

interface ApprovalRow {
  episode_id: string;
  revision: number;
  action: ScriptApprovalAction;
  script_version_id: string;
  created_at: number;
}

export class ScriptApprovalStoreError extends Error {
  constructor(readonly statusCode: number, message: string) { super(message); }
}

export function scriptApprovalEventId(input: {
  episodeId: string;
  revision: number;
  action: ScriptApprovalAction;
  scriptVersionId: string;
}) {
  return `approval_${createHash("sha256")
    .update(`script-approval-v1\0${input.episodeId}\0${input.revision}\0${input.action}\0${input.scriptVersionId}`)
    .digest("hex")}`;
}

function latestApprovalRow(database: DatabaseSync, episodeId: string) {
  return database.prepare(
    `SELECT episode_id, revision, action, script_version_id, created_at
     FROM script_approval_events WHERE episode_id = ? ORDER BY revision DESC LIMIT 1`,
  ).get(episodeId) as ApprovalRow | undefined;
}

function stateFromRow(episodeId: string, row?: ApprovalRow) {
  return {
    episodeId,
    status: row?.action === "approve"
      ? "approved" as const
      : row?.action === "withdraw"
        ? "withdrawn" as const
        : "unapproved" as const,
    revision: row?.revision ?? 0,
    scriptVersionId: row?.action === "approve" ? row.script_version_id : null,
    changedAt: row?.created_at ?? null,
  };
}

export function getScriptApproval(database: DatabaseSync, episodeId: string) {
  if (!database.prepare("SELECT id FROM episodes WHERE id = ?").get(episodeId)) {
    throw new ScriptApprovalStoreError(404, "分集不存在");
  }
  return stateFromRow(episodeId, latestApprovalRow(database, episodeId));
}

export function changeScriptApproval(
  database: DatabaseSync,
  episodeId: string,
  input: ScriptApprovalInput,
  now = Date.now(),
) {
  if (input.action !== "approve" && input.action !== "withdraw") {
    throw new ScriptApprovalStoreError(400, "批准操作无效");
  }
  if (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 0) {
    throw new ScriptApprovalStoreError(400, "批准版本号无效");
  }
  if (input.action === "approve" && (typeof input.scriptVersionId !== "string" || !input.scriptVersionId)) {
    throw new ScriptApprovalStoreError(400, "批准时必须指定成片旁白稿版本");
  }
  if (input.action === "withdraw" && input.scriptVersionId != null) {
    throw new ScriptApprovalStoreError(400, "撤回批准时不能指定稿件版本");
  }

  database.exec("BEGIN IMMEDIATE");
  try {
    if (!database.prepare("SELECT id FROM episodes WHERE id = ?").get(episodeId)) {
      throw new ScriptApprovalStoreError(404, "分集不存在");
    }
    const latest = latestApprovalRow(database, episodeId);
    const current = stateFromRow(episodeId, latest);
    if (current.revision !== input.expectedRevision) {
      throw new ScriptApprovalStoreError(409, `批准状态已变化，请按 revision=${current.revision} 重试`);
    }

    let scriptVersionId: string;
    if (input.action === "approve") {
      const script = database.prepare(
        "SELECT episode_id, kind FROM script_versions WHERE id = ?",
      ).get(input.scriptVersionId!) as { episode_id: string; kind: string } | undefined;
      if (!script || script.episode_id !== episodeId || script.kind !== "packaged") {
        throw new ScriptApprovalStoreError(409, "只能批准当前分集的成片旁白稿");
      }
      scriptVersionId = input.scriptVersionId!;
    } else {
      if (current.status !== "approved" || !current.scriptVersionId) {
        throw new ScriptApprovalStoreError(409, "当前没有可撤回的批准稿");
      }
      scriptVersionId = current.scriptVersionId;
    }

    const revision = current.revision + 1;
    const id = scriptApprovalEventId({ episodeId, revision, action: input.action, scriptVersionId });
    database.prepare(
      `INSERT INTO script_approval_events (
         id, episode_id, revision, action, script_version_id, created_at
       ) VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(id, episodeId, revision, input.action, scriptVersionId, now);
    database.exec("COMMIT");
    return getScriptApproval(database, episodeId);
  } catch (error) {
    try { database.exec("ROLLBACK"); } catch { /* 保留原始批准错误。 */ }
    throw error;
  }
}

export function withdrawScriptApprovalForEpisodeChange(database: DatabaseSync, episodeId: string, now = Date.now()) {
  const latest = latestApprovalRow(database, episodeId);
  if (latest?.action !== "approve") return false;
  const revision = latest.revision + 1;
  const id = scriptApprovalEventId({
    episodeId, revision, action: "withdraw", scriptVersionId: latest.script_version_id,
  });
  database.prepare(
    `INSERT INTO script_approval_events (
       id, episode_id, revision, action, script_version_id, created_at
     ) VALUES (?, ?, ?, 'withdraw', ?, ?)`,
  ).run(id, episodeId, revision, latest.script_version_id, now);
  return true;
}

export function requireApprovedScriptForProduction(
  database: DatabaseSync,
  episodeId: string,
  purpose: ProductionPurpose,
) {
  if (purpose !== "tts" && purpose !== "image" && purpose !== "video") {
    throw new ScriptApprovalStoreError(400, "生产类型无效");
  }
  const row = database.prepare(
    `SELECT approval.revision, approval.action, approval.script_version_id, script.kind, script.content_hash
     FROM script_approval_events approval
     JOIN script_versions script ON script.id = approval.script_version_id
     WHERE approval.episode_id = ? ORDER BY approval.revision DESC LIMIT 1`,
  ).get(episodeId) as {
    revision: number;
    action: ScriptApprovalAction;
    script_version_id: string;
    kind: string;
    content_hash: string;
  } | undefined;
  if (!row || row.action !== "approve" || row.kind !== "packaged") {
    const label = purpose === "tts" ? "语音" : purpose === "image" ? "图片" : "视频";
    throw new ScriptApprovalStoreError(409, `稿件未人工批准，不能开始${label}生产`);
  }
  return {
    episodeId,
    scriptVersionId: row.script_version_id,
    contentHash: row.content_hash,
    approvalRevision: row.revision,
  };
}
