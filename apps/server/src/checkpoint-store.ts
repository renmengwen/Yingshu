import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import { types } from "node:util";

interface CheckpointRow {
  job_id: string;
  stage: string;
  scope_key: string;
  input_hash: string;
  completed_at: number;
  output_json: string | null;
}

export interface CheckpointKey {
  jobId: string;
  stage: string;
  scopeKey: string;
}

export interface CommitCheckpointInput extends CheckpointKey {
  inputHash: string;
  workerId: string;
  now?: number;
  output?: unknown;
}

export interface CheckpointRecord {
  jobId: string;
  stage: string;
  scopeKey: string;
  inputHash: string;
  completedAt: number;
  output?: unknown;
}

export interface CheckpointTransaction {
  run(sql: string, ...parameters: SQLInputValue[]): void;
}

function required(value: string, name: string) {
  const normalized = value.trim();
  if (!normalized) throw new Error(`${name}不能为空`);
  return normalized;
}

function normalizeKey(input: CheckpointKey) {
  return {
    jobId: required(input.jobId, "任务 ID"),
    stage: required(input.stage, "检查点阶段"),
    scopeKey: required(input.scopeKey, "检查点范围"),
  };
}

function record(row: CheckpointRow): CheckpointRecord {
  return {
    jobId: row.job_id,
    stage: row.stage,
    scopeKey: row.scope_key,
    inputHash: row.input_hash,
    completedAt: row.completed_at,
    output: row.output_json === null ? undefined : JSON.parse(row.output_json) as unknown,
  };
}

function domainDml(sql: string) {
  const trimmed = sql.trim();
  const statement = trimmed.endsWith(";") ? trimmed.slice(0, -1).trimEnd() : trimmed;
  if (!statement || statement.includes(";") || !/^(?:INSERT\b|UPDATE\b|DELETE\s+FROM\b)/i.test(statement)) {
    throw new Error("检查点 writer 只允许单条 INSERT、UPDATE 或 DELETE 领域写入");
  }
  return statement;
}

export function getCheckpoint(database: DatabaseSync, input: CheckpointKey) {
  const key = normalizeKey(input);
  const row = database.prepare(
    `SELECT job_id, stage, scope_key, input_hash, completed_at, output_json
     FROM job_checkpoints WHERE job_id = ? AND stage = ? AND scope_key = ?`,
  ).get(key.jobId, key.stage, key.scopeKey) as CheckpointRow | undefined;
  return row ? record(row) : undefined;
}

export function commitCheckpoint(
  database: DatabaseSync,
  input: CommitCheckpointInput,
  writer: (transaction: CheckpointTransaction) => undefined,
): { checkpoint: CheckpointRecord; created: boolean; replaced: boolean } {
  const key = normalizeKey(input);
  const inputHash = required(input.inputHash, "检查点输入哈希").toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(inputHash)) throw new Error("检查点输入哈希必须是 SHA-256");
  const workerId = required(input.workerId, "Worker ID");
  const now = input.now ?? Date.now();
  if (!Number.isSafeInteger(now) || now < 0) throw new Error("检查点完成时间无效");
  if (types.isAsyncFunction(writer)) throw new Error("检查点 writer 必须同步完成");
  const outputJson = input.output === undefined ? undefined : JSON.stringify(input.output);
  if (input.output !== undefined && outputJson === undefined) throw new Error("检查点输出必须是有限 JSON");
  if (outputJson !== undefined && Buffer.byteLength(outputJson, "utf8") > 1024 * 1024) {
    throw new Error("检查点输出超过 1 MiB 上限");
  }

  database.exec("BEGIN IMMEDIATE");
  try {
    const lease = database.prepare(
      `SELECT 1 FROM jobs
       WHERE id = ? AND status = 'running' AND lease_owner = ? AND lease_expires_at > ?
         AND cancel_requested = 0`,
    ).get(key.jobId, workerId, now);
    if (!lease) throw new Error("任务租约无效、已过期或已请求取消，不能提交检查点");

    const existing = getCheckpoint(database, key);
    if (existing?.inputHash === inputHash && outputJson === undefined) {
      database.exec("COMMIT");
      return { checkpoint: existing, created: false, replaced: false };
    }
    if (existing?.inputHash === inputHash && existing.output !== undefined) {
      if (JSON.stringify(existing.output) !== outputJson) throw new Error("同一检查点身份的持久输出冲突");
      database.exec("COMMIT");
      return { checkpoint: existing, created: false, replaced: false };
    }

    const operations: Array<{ sql: string; parameters: SQLInputValue[] }> = [];
    let acceptingOperations = true;
    const transaction: CheckpointTransaction = {
      run(sql, ...parameters) {
        if (!acceptingOperations) throw new Error("检查点 writer 已结束，不能继续写入");
        operations.push({ sql: domainDml(sql), parameters });
      },
    };
    let writerResult: unknown;
    try {
      writerResult = writer(transaction) as unknown;
    } finally {
      acceptingOperations = false;
    }
    if (writerResult && typeof (writerResult as { then?: unknown }).then === "function") {
      throw new Error("检查点 writer 必须同步完成");
    }
    for (const operation of operations) {
      database.prepare(operation.sql).run(...operation.parameters);
    }
    if (existing) {
      database.prepare(
        `UPDATE job_checkpoints SET input_hash = ?, completed_at = ?, output_json = ?
         WHERE job_id = ? AND stage = ? AND scope_key = ?`,
      ).run(inputHash, now, outputJson ?? null, key.jobId, key.stage, key.scopeKey);
    } else {
      database.prepare(
        `INSERT INTO job_checkpoints (job_id, stage, scope_key, input_hash, completed_at, output_json)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).run(key.jobId, key.stage, key.scopeKey, inputHash, now, outputJson ?? null);
    }
    const checkpoint = getCheckpoint(database, key)!;
    database.exec("COMMIT");
    return { checkpoint, created: !existing, replaced: Boolean(existing) };
  } catch (error) {
    try {
      database.exec("ROLLBACK");
    } catch {
      // 保留原始事务错误。
    }
    throw error;
  }
}
