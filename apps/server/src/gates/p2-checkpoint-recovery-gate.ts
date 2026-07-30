import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

import { openDatabase } from "../database.js";
import { createJob, getJob } from "../job-store.js";
import { JobWorker } from "../job-worker.js";

const JOB_ID = "job_checkpoint_recovery";
const JOB_TYPE = "checkpoint_probe";
const STAGE = "scope-result";
const SCOPES = ["scope_a", "scope_b", "scope_c"] as const;

function inputHash(scopeKey: string) {
  return createHash("sha256").update(`narralume-p2-02\0${scopeKey}`).digest("hex");
}

async function runChild(dataRoot: string, crashAfterSecondScope: boolean) {
  const connection = openDatabase(dataRoot);
  const workerId = crashAfterSecondScope ? "worker_before_crash" : "worker_after_restart";
  const worker = new JobWorker(connection.database, {
    [JOB_TYPE]: async (context) => {
      for (const [index, scopeKey] of SCOPES.entries()) {
        if (context.getCheckpoint(STAGE, scopeKey)?.inputHash === inputHash(scopeKey)) continue;
        context.commitCheckpoint(STAGE, scopeKey, inputHash(scopeKey), (transaction) => {
          transaction.run(
            `INSERT INTO checkpoint_gate_results (scope_key, input_hash, writer_id, value)
             VALUES (?, ?, ?, ?)`,
            scopeKey,
            inputHash(scopeKey),
            workerId,
            `结果-${scopeKey}`,
          );
        });
        if (crashAfterSecondScope && index === 1) process.exit(91);
      }
      return { completedScopes: SCOPES.length };
    },
  }, {
    workerId,
    leaseMs: 500,
    heartbeatMs: 100,
    retryDelayMs: 0,
  });

  try {
    assert.equal(await worker.runOne(), true, "子进程必须领取恢复任务");
    process.stdout.write(`${JSON.stringify({ ok: true, workerId })}\n`);
  } finally {
    connection.close();
  }
}

function spawnChild(dataRoot: string, mode: "crash" | "recover") {
  const script = fileURLToPath(import.meta.url);
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(process.execPath, [...process.execArgv, script], {
      env: {
        ...process.env,
        YINGSHU_P2_CHECKPOINT_CHILD: mode,
        YINGSHU_P2_CHECKPOINT_DATA_ROOT: dataRoot,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let spawnError: Error | undefined;
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, 15_000);
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.once("error", (error) => { spawnError = error; });
    child.once("close", (code) => {
      clearTimeout(timeout);
      const output = {
        code,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
      };
      if (spawnError) reject(spawnError);
      else if (timedOut) reject(new Error(
        `checkpoint ${mode} 子进程 15 秒内未退出\nstdout: ${output.stdout}\nstderr: ${output.stderr}`,
      ));
      else resolve(output);
    });
  });
}

const childMode = process.env.YINGSHU_P2_CHECKPOINT_CHILD;
const childDataRoot = process.env.YINGSHU_P2_CHECKPOINT_DATA_ROOT;

if (childMode) {
  assert(childDataRoot, "子进程缺少 checkpoint 数据根");
  await runChild(childDataRoot, childMode === "crash");
} else {
  const dataRoot = await mkdtemp(join(tmpdir(), "narralume-p2-02-gate-"));
  try {
    const initial = openDatabase(dataRoot);
    try {
      initial.database.exec(`
        CREATE TABLE checkpoint_gate_results (
          scope_key TEXT PRIMARY KEY,
          input_hash TEXT NOT NULL,
          writer_id TEXT NOT NULL,
          value TEXT NOT NULL
        ) STRICT;
      `);
      createJob(initial.database, {
        id: JOB_ID,
        type: JOB_TYPE,
        payload: { scopes: SCOPES },
        maxAttempts: 2,
      });
    } finally {
      initial.close();
    }

    const crashed = await spawnChild(dataRoot, "crash");
    assert.equal(crashed.code, 91, `首次子进程应故障退出：${crashed.stderr}`);

    const afterCrash = openDatabase(dataRoot);
    let partialRows: unknown[];
    let leaseExpiresAt: number;
    try {
      partialRows = afterCrash.database.prepare(
        "SELECT scope_key, input_hash, writer_id, value FROM checkpoint_gate_results ORDER BY scope_key",
      ).all();
      const interruptedJob = getJob(afterCrash.database, JOB_ID);
      assert.equal(interruptedJob?.status, "running");
      assert.equal(interruptedJob?.attempts, 1);
      assert(interruptedJob?.leaseExpiresAt, "故障任务必须保留租约到期时间");
      leaseExpiresAt = interruptedJob.leaseExpiresAt;
      assert.equal(partialRows.length, 2, "故障前必须只原子提交前两个范围");
      assert.equal(
        afterCrash.database.prepare("SELECT COUNT(*) AS count FROM job_checkpoints").get()?.count,
        2,
      );
    } finally {
      afterCrash.close();
    }

    await new Promise((resolve) => setTimeout(resolve, Math.max(0, leaseExpiresAt - Date.now()) + 50));
    const recovered = await spawnChild(dataRoot, "recover");
    assert.equal(recovered.code, 0, `恢复子进程失败：${recovered.stderr}`);

    const completed = openDatabase(dataRoot);
    let finalStatus: string | undefined;
    let finalAttempts: number | undefined;
    try {
      const finalJob = getJob(completed.database, JOB_ID);
      const finalRows = completed.database.prepare(
        "SELECT scope_key, input_hash, writer_id, value FROM checkpoint_gate_results ORDER BY scope_key",
      ).all();
      assert.equal(finalJob?.status, "succeeded");
      assert.equal(finalJob?.attempts, 2);
      assert.equal(finalRows.length, 3);
      assert.deepEqual(finalRows.slice(0, 2), partialRows, "已完成范围不得被恢复进程重复写入");
      assert.equal((finalRows[2] as { writer_id: string }).writer_id, "worker_after_restart");
      assert.equal(completed.database.prepare("SELECT COUNT(*) AS count FROM job_checkpoints").get()?.count, 3);
      finalStatus = finalJob.status;
      finalAttempts = finalJob.attempts;
    } finally {
      completed.close();
    }

    process.stdout.write(`${JSON.stringify({
      ok: true,
      crash_exit_code: crashed.code,
      first_attempt_committed_scopes: 2,
      recovered_scopes: 1,
      final_status: finalStatus,
      attempts: finalAttempts,
      duplicate_results: 0,
    }, null, 2)}\n`);
  } finally {
    await rm(dataRoot, { recursive: true, force: true });
  }
}
