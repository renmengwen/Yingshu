import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

export type JobStatus = "queued" | "running" | "succeeded" | "failed" | "cancelled";

interface JobRow {
  id: string;
  type: string;
  payload_json: string;
  status: JobStatus;
  priority: number;
  progress: number;
  attempts: number;
  max_attempts: number;
  run_after: number;
  lease_owner: string | null;
  lease_expires_at: number | null;
  cancel_requested: number;
  result_json: string | null;
  error_code: string | null;
  error_message: string | null;
  created_at: number;
  updated_at: number;
  started_at: number | null;
  finished_at: number | null;
}

export interface JobRecord<TPayload = unknown, TResult = unknown> {
  id: string;
  type: string;
  payload: TPayload;
  status: JobStatus;
  priority: number;
  progress: number;
  attempts: number;
  maxAttempts: number;
  runAfter: number;
  leaseOwner: string | null;
  leaseExpiresAt: number | null;
  cancelRequested: boolean;
  result: TResult | null;
  errorCode: string | null;
  errorMessage: string | null;
  createdAt: number;
  updatedAt: number;
  startedAt: number | null;
  finishedAt: number | null;
}

export interface CreateJobInput {
  id?: string;
  type: string;
  payload: unknown;
  priority?: number;
  maxAttempts?: number;
  runAfter?: number;
}

export const MAX_JOB_ATTEMPTS = 10;

function json(value: unknown) {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) throw new Error("任务数据必须可以序列化为 JSON");
  return serialized;
}

function record<TPayload = unknown, TResult = unknown>(row: JobRow): JobRecord<TPayload, TResult> {
  return {
    id: row.id,
    type: row.type,
    payload: JSON.parse(row.payload_json) as TPayload,
    status: row.status,
    priority: row.priority,
    progress: row.progress,
    attempts: row.attempts,
    maxAttempts: row.max_attempts,
    runAfter: row.run_after,
    leaseOwner: row.lease_owner,
    leaseExpiresAt: row.lease_expires_at,
    cancelRequested: row.cancel_requested === 1,
    result: row.result_json === null ? null : JSON.parse(row.result_json) as TResult,
    errorCode: row.error_code,
    errorMessage: row.error_message,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
  };
}

function row(database: DatabaseSync, id: string) {
  return database.prepare("SELECT * FROM jobs WHERE id = ?").get(id) as JobRow | undefined;
}

export function getJob<TPayload = unknown, TResult = unknown>(database: DatabaseSync, id: string) {
  const found = row(database, id);
  return found ? record<TPayload, TResult>(found) : undefined;
}

export function createJob(database: DatabaseSync, input: CreateJobInput, now = Date.now()) {
  const id = input.id ?? `job_${randomUUID()}`;
  const type = input.type.trim();
  const maxAttempts = input.maxAttempts ?? 3;
  const priority = input.priority ?? 0;
  const runAfter = input.runAfter ?? now;
  if (!type) throw new Error("任务类型不能为空");
  if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > MAX_JOB_ATTEMPTS) {
    throw new Error(`最大尝试次数必须在 1～${MAX_JOB_ATTEMPTS} 之间`);
  }
  if (!Number.isSafeInteger(priority)) throw new Error("任务优先级无效");
  if (!Number.isSafeInteger(runAfter)) throw new Error("任务执行时间无效");

  database.prepare(
    `INSERT INTO jobs (
       id, type, payload_json, status, priority, max_attempts, run_after, created_at, updated_at
     ) VALUES (?, ?, ?, 'queued', ?, ?, ?, ?, ?)`,
  ).run(id, type, json(input.payload), priority, maxAttempts, runAfter, now, now);
  return getJob(database, id)!;
}

export function claimNextJob(
  database: DatabaseSync,
  workerId: string,
  leaseMs: number,
  now = Date.now(),
  allowedTypes?: readonly string[],
) {
  if (!workerId.trim()) throw new Error("Worker ID 不能为空");
  if (!Number.isSafeInteger(leaseMs) || leaseMs < 1) throw new Error("租约时长无效");

  database.exec("BEGIN IMMEDIATE");
  try {
    database.prepare(
      `UPDATE jobs SET status = 'cancelled', lease_owner = NULL, lease_expires_at = NULL,
         finished_at = ?, updated_at = ?
       WHERE status = 'running' AND lease_expires_at <= ? AND cancel_requested = 1`,
    ).run(now, now, now);
    database.prepare(
      `UPDATE jobs SET status = 'queued', progress = 0, lease_owner = NULL, lease_expires_at = NULL,
         error_code = 'lease_expired', error_message = '任务租约过期，已重新排队', updated_at = ?
       WHERE status = 'running' AND lease_expires_at <= ? AND cancel_requested = 0 AND attempts < max_attempts`,
    ).run(now, now);
    database.prepare(
      `UPDATE jobs SET status = 'failed', lease_owner = NULL, lease_expires_at = NULL,
         error_code = 'lease_expired', error_message = '任务租约过期且已用完尝试次数', finished_at = ?, updated_at = ?
       WHERE status = 'running' AND lease_expires_at <= ? AND cancel_requested = 0 AND attempts >= max_attempts`,
    ).run(now, now, now);

    const normalizedTypes = allowedTypes?.map((type) => type.trim()).filter(Boolean);
    const typeFilter = normalizedTypes === undefined
      ? ""
      : normalizedTypes.length === 0
        ? " AND 0"
        : ` AND type IN (${normalizedTypes.map(() => "?").join(", ")})`;
    const ready = database.prepare(
      `SELECT id FROM jobs
       WHERE status = 'queued' AND cancel_requested = 0 AND attempts < max_attempts AND run_after <= ?
       ${typeFilter}
       ORDER BY priority DESC, created_at, id LIMIT 1`,
    ).get(now, ...(normalizedTypes ?? [])) as { id: string } | undefined;
    if (!ready) {
      database.exec("COMMIT");
      return undefined;
    }

    database.prepare(
      `UPDATE jobs SET status = 'running', progress = 0, attempts = attempts + 1, lease_owner = ?, lease_expires_at = ?,
         started_at = COALESCE(started_at, ?), updated_at = ?, error_code = NULL, error_message = NULL
       WHERE id = ? AND status = 'queued'`,
    ).run(workerId, now + leaseMs, now, now, ready.id);
    const claimed = row(database, ready.id);
    database.exec("COMMIT");
    return claimed ? record(claimed) : undefined;
  } catch (error) {
    try { database.exec("ROLLBACK"); } catch { /* 保留原始错误。 */ }
    throw error;
  }
}

export function renewJobLease(database: DatabaseSync, id: string, workerId: string, leaseMs: number, now = Date.now()) {
  const result = database.prepare(
    `UPDATE jobs SET lease_expires_at = ?, updated_at = ?
     WHERE id = ? AND status = 'running' AND lease_owner = ? AND lease_expires_at > ?`,
  ).run(now + leaseMs, now, id, workerId, now);
  return result.changes === 1;
}

export function updateJobProgress(database: DatabaseSync, id: string, workerId: string, progress: number, now = Date.now()) {
  if (!Number.isFinite(progress) || progress < 0 || progress > 1) throw new Error("任务进度无效");
  const result = database.prepare(
    `UPDATE jobs SET progress = ?, updated_at = ?
     WHERE id = ? AND status = 'running' AND lease_owner = ? AND lease_expires_at > ?`,
  ).run(progress, now, id, workerId, now);
  return result.changes === 1;
}

export function requestJobCancellation(database: DatabaseSync, id: string, now = Date.now()) {
  database.prepare(
    `UPDATE jobs SET status = 'cancelled', cancel_requested = 1, finished_at = ?, updated_at = ?
     WHERE id = ? AND status = 'queued'`,
  ).run(now, now, id);
  database.prepare(
    `UPDATE jobs SET cancel_requested = 1, updated_at = ? WHERE id = ? AND status = 'running'`,
  ).run(now, id);
  return getJob(database, id);
}

export function succeedJob(database: DatabaseSync, id: string, workerId: string, result: unknown, now = Date.now()) {
  const changed = database.prepare(
    `UPDATE jobs SET status = 'succeeded', progress = 1, result_json = ?, lease_owner = NULL,
       lease_expires_at = NULL, finished_at = ?, updated_at = ?
     WHERE id = ? AND status = 'running' AND lease_owner = ? AND lease_expires_at > ? AND cancel_requested = 0`,
  ).run(json(result), now, now, id, workerId, now).changes;
  return changed === 1;
}

export function cancelRunningJob(database: DatabaseSync, id: string, workerId: string, now = Date.now()) {
  const changed = database.prepare(
    `UPDATE jobs SET status = 'cancelled', lease_owner = NULL, lease_expires_at = NULL, finished_at = ?, updated_at = ?
     WHERE id = ? AND status = 'running' AND lease_owner = ? AND lease_expires_at > ? AND cancel_requested = 1`,
  ).run(now, now, id, workerId, now).changes;
  return changed === 1;
}

export function failJob(
  database: DatabaseSync,
  id: string,
  workerId: string,
  errorCode: string,
  errorMessage: string,
  retryDelayMs = 0,
  now = Date.now(),
) {
  database.exec("BEGIN IMMEDIATE");
  try {
    const current = row(database, id);
    if (!current || current.status !== "running" || current.lease_owner !== workerId ||
        current.lease_expires_at === null || current.lease_expires_at <= now) {
      database.exec("COMMIT");
      return false;
    }
    const retry = current.attempts < current.max_attempts && current.cancel_requested === 0;
    database.prepare(
      `UPDATE jobs SET status = ?, progress = ?, run_after = ?, lease_owner = NULL, lease_expires_at = NULL,
         error_code = ?, error_message = ?, finished_at = ?, updated_at = ? WHERE id = ?`,
    ).run(
      retry ? "queued" : current.cancel_requested ? "cancelled" : "failed",
      retry ? 0 : current.progress,
      now + Math.max(0, retryDelayMs),
      errorCode,
      errorMessage,
      retry ? null : now,
      now,
      id,
    );
    database.exec("COMMIT");
    return true;
  } catch (error) {
    try { database.exec("ROLLBACK"); } catch { /* 保留原始错误。 */ }
    throw error;
  }
}
