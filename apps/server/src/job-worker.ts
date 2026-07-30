import type { DatabaseSync } from "node:sqlite";

import {
  commitCheckpoint,
  getCheckpoint,
  type CheckpointRecord,
  type CheckpointTransaction,
} from "./checkpoint-store.js";
import {
  cancelRunningJob,
  claimNextJob,
  failJob,
  getJob,
  renewJobLease,
  succeedJob,
  updateJobProgress,
  type JobRecord,
} from "./job-store.js";
import { writeTextModelDiagnostic } from "./text-model-diagnostics.js";
import { TextModelCallError, TextModelStreamError } from "./text-model-stream.js";

export class JobCancelledError extends Error {
  constructor() {
    super("任务已取消");
  }
}

export interface JobExecutionContext {
  job: JobRecord;
  reportProgress(progress: number): void;
  isCancellationRequested(): boolean;
  throwIfCancellationRequested(): void;
  getCheckpoint(stage: string, scopeKey: string): CheckpointRecord | undefined;
  commitCheckpoint(
    stage: string,
    scopeKey: string,
    inputHash: string,
    writer: (transaction: CheckpointTransaction) => undefined,
    output?: unknown,
  ): { checkpoint: CheckpointRecord; created: boolean; replaced: boolean };
}

export type JobHandler = (context: JobExecutionContext) => Promise<unknown>;

export interface JobWorkerOptions {
  workerId: string;
  leaseMs?: number;
  heartbeatMs?: number;
  retryDelayMs?: number;
  onError?: (error: unknown) => void;
  textModelDiagnosticsRoot?: string;
}

function textModelError(value: unknown) {
  const seen = new Set<unknown>();
  let current = value;
  for (let depth = 0; depth < 8 && current && !seen.has(current); depth += 1) {
    if (current instanceof TextModelCallError || current instanceof TextModelStreamError) return current;
    seen.add(current);
    current = current instanceof Error ? current.cause : undefined;
  }
  return undefined;
}

function diagnosticErrorIdentity(value: unknown) {
  const seen = new Set<unknown>();
  let current = value;
  let root = value instanceof Error ? value : new Error(String(value));
  let code: string | null = null;
  for (let depth = 0; depth < 8 && current && !seen.has(current); depth += 1) {
    seen.add(current);
    if (current instanceof Error) root = current;
    const candidate = (current as { code?: unknown }).code;
    if (code === null && typeof candidate === "string") code = candidate;
    current = current instanceof Error ? current.cause : undefined;
  }
  return { name: root.name, code };
}

function frozenModel(payload: unknown) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return { providerId: "unknown", model: "unknown" };
  const value = payload as { providerId?: unknown; model?: unknown };
  return {
    providerId: typeof value.providerId === "string" ? value.providerId : "unknown",
    model: typeof value.model === "string" ? value.model : "unknown",
  };
}

export class JobWorker {
  readonly workerId: string;
  readonly leaseMs: number;
  readonly heartbeatMs: number;
  readonly retryDelayMs: number;
  readonly onError: (error: unknown) => void;
  readonly textModelDiagnosticsRoot: string | undefined;
  #active = false;
  #stopRequested = false;
  #loop: Promise<void> | undefined;
  #wakePoll: (() => void) | undefined;
  readonly #jobTypes: readonly string[];

  constructor(
    private readonly database: DatabaseSync,
    private readonly handlers: Readonly<Record<string, JobHandler>>,
    options: JobWorkerOptions,
  ) {
    this.workerId = options.workerId.trim();
    this.leaseMs = options.leaseMs ?? 30_000;
    this.heartbeatMs = options.heartbeatMs ?? Math.max(1_000, Math.floor(this.leaseMs / 3));
    this.retryDelayMs = options.retryDelayMs ?? 1_000;
    this.onError = options.onError ?? (() => undefined);
    this.textModelDiagnosticsRoot = options.textModelDiagnosticsRoot;
    this.#jobTypes = Object.keys(handlers);
    if (!this.workerId) throw new Error("Worker ID 不能为空");
    if (!Number.isSafeInteger(this.leaseMs) || !Number.isSafeInteger(this.heartbeatMs) ||
        this.leaseMs < 1 || this.heartbeatMs < 1 || this.heartbeatMs >= this.leaseMs) {
      throw new Error("Worker 租约或续租间隔无效");
    }
    if (!Number.isSafeInteger(this.retryDelayMs) || this.retryDelayMs < 0) {
      throw new Error("Worker 重试间隔无效");
    }
  }

  async runOne() {
    if (this.#active) return false;
    this.#active = true;
    let heartbeat: ReturnType<typeof setInterval> | undefined;
    let leaseLost = false;
    try {
      const job = claimNextJob(this.database, this.workerId, this.leaseMs, Date.now(), this.#jobTypes);
      if (!job) return false;
      const handler = this.handlers[job.type];
      if (!handler) {
        failJob(this.database, job.id, this.workerId, "handler_missing", `没有任务处理器：${job.type}`, 0);
        return true;
      }

      heartbeat = setInterval(() => {
        try {
          if (!renewJobLease(this.database, job.id, this.workerId, this.leaseMs)) leaseLost = true;
        } catch (error) {
          leaseLost = true;
          this.onError(error);
        }
      }, this.heartbeatMs);

      const context: JobExecutionContext = {
        job,
        reportProgress: (progress) => {
          if (leaseLost || !updateJobProgress(this.database, job.id, this.workerId, progress)) {
            throw new Error("任务租约已失效，不能更新进度");
          }
        },
        isCancellationRequested: () => getJob(this.database, job.id)?.cancelRequested ?? true,
        throwIfCancellationRequested() {
          if (this.isCancellationRequested()) throw new JobCancelledError();
        },
        getCheckpoint: (stage, scopeKey) => getCheckpoint(this.database, {
          jobId: job.id,
          stage,
          scopeKey,
        }),
        commitCheckpoint: (stage, scopeKey, inputHash, writer, output) => commitCheckpoint(this.database, {
          jobId: job.id,
          stage,
          scopeKey,
          inputHash,
          workerId: this.workerId,
          output,
        }, writer),
      };

      try {
        const result = await handler(context);
        if (leaseLost) throw new Error("任务租约已失效，不能提交结果");
        if (context.isCancellationRequested()) cancelRunningJob(this.database, job.id, this.workerId);
        else succeedJob(this.database, job.id, this.workerId, result);
      } catch (error) {
        const current = getJob(this.database, job.id);
        if (error instanceof JobCancelledError || current?.cancelRequested) {
          cancelRunningJob(this.database, job.id, this.workerId);
        } else {
          failJob(
            this.database,
            job.id,
            this.workerId,
            "handler_failed",
            error instanceof Error ? error.message : String(error),
            this.retryDelayMs,
          );
          if (this.textModelDiagnosticsRoot) {
            const diagnostic = textModelError(error);
            const stream = diagnostic instanceof TextModelCallError
              ? diagnostic.evidence
              : diagnostic === undefined ? undefined : {
                statistics: diagnostic.statistics,
                partialText: diagnostic.partialText,
                partialTextTruncated: diagnostic.partialTextTruncated,
              };
            const model = frozenModel(job.payload);
            const identity = diagnosticErrorIdentity(error);
            try {
              await writeTextModelDiagnostic({
                dataRoot: this.textModelDiagnosticsRoot,
                jobId: job.id,
                attempt: job.attempts,
                stage: diagnostic instanceof TextModelCallError ? diagnostic.stage : job.type,
                providerId: model.providerId,
                model: model.model,
                protocol: stream?.statistics?.protocol ?? "unknown",
                error: {
                  name: identity.name,
                  message: error instanceof Error ? error.message : String(error),
                  code: identity.code,
                },
                statistics: stream?.statistics,
                partialText: stream?.partialText,
                partialTextTruncated: stream?.partialTextTruncated,
              });
            } catch (diagnosticError) {
              try { this.onError(diagnosticError); } catch { /* 诊断失败不得覆盖原 Job 错误。 */ }
            }
          }
        }
      }
      return true;
    } finally {
      if (heartbeat) clearInterval(heartbeat);
      this.#active = false;
    }
  }

  start(pollMs = 250) {
    if (!Number.isSafeInteger(pollMs) || pollMs < 1) throw new Error("Worker 轮询间隔无效");
    if (this.#loop) throw new Error("Worker 已启动");
    this.#stopRequested = false;
    this.#loop = (async () => {
      while (!this.#stopRequested) {
        let handled = false;
        try {
          handled = await this.runOne();
        } catch (error) {
          this.onError(error);
        }
        if (!handled && !this.#stopRequested) {
          await new Promise<void>((resolve) => {
            const timer = setTimeout(resolve, pollMs);
            this.#wakePoll = () => {
              clearTimeout(timer);
              resolve();
            };
          });
          this.#wakePoll = undefined;
        }
      }
    })().finally(() => {
      this.#wakePoll = undefined;
      this.#loop = undefined;
    });
  }

  async stop() {
    this.#stopRequested = true;
    this.#wakePoll?.();
    await this.#loop;
  }
}
