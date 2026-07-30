import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { commitCheckpoint, getCheckpoint } from "./checkpoint-store.js";
import { openDatabase } from "./database.js";
import { claimNextJob, createJob, requestJobCancellation } from "./job-store.js";

const INPUT_HASH_1 = "a".repeat(64);
const INPUT_HASH_2 = "b".repeat(64);

async function withDatabase(run: (dataRoot: string) => void | Promise<void>) {
  const dataRoot = await mkdtemp(join(tmpdir(), "narralume-checkpoint-"));
  try {
    await run(dataRoot);
  } finally {
    await rm(dataRoot, { recursive: true, force: true });
  }
}

function runningJob(database: ReturnType<typeof openDatabase>["database"], now = 1_000) {
  createJob(database, { id: "job_1", type: "test", payload: {} }, now);
  assert.ok(claimNextJob(database, "worker_1", 10_000, now));
}

test("检查点与 writer 写入在同一事务提交，并在重启后保留", async () => {
  await withDatabase((dataRoot) => {
    const first = openDatabase(dataRoot);
    runningJob(first.database);
    first.database.exec("CREATE TABLE generated_results (value TEXT NOT NULL) STRICT");

    const result = commitCheckpoint(first.database, {
      jobId: "job_1", stage: "events", scopeKey: "chapter_1", inputHash: INPUT_HASH_1,
      workerId: "worker_1", now: 2_000,
    }, (transaction) => {
      transaction.run("INSERT INTO generated_results (value) VALUES (?)", "完成");
    });
    assert.equal(result.created, true);
    assert.equal(result.checkpoint.completedAt, 2_000);
    first.close();

    const reopened = openDatabase(dataRoot);
    assert.equal(getCheckpoint(reopened.database, {
      jobId: "job_1", stage: "events", scopeKey: "chapter_1",
    })?.inputHash, INPUT_HASH_1);
    assert.equal(reopened.database.prepare("SELECT value FROM generated_results").get()?.value, "完成");
    reopened.close();
  });
});

test("检查点可耐久保存已验证输出，旧 marker 可原子升级但不可覆盖", async () => {
  await withDatabase((dataRoot) => {
    const opened = openDatabase(dataRoot);
    runningJob(opened.database);
    const input = {
      jobId: "job_1", stage: "plan", scopeKey: "interval_1", inputHash: INPUT_HASH_1,
      workerId: "worker_1", now: 2_000,
    };
    commitCheckpoint(opened.database, input, () => undefined);
    assert.equal(getCheckpoint(opened.database, input)?.output, undefined);

    const upgraded = commitCheckpoint(opened.database, { ...input, now: 3_000, output: { episodes: [1] } },
      () => undefined);
    assert.equal(upgraded.replaced, true);
    assert.deepEqual(getCheckpoint(opened.database, input)?.output, { episodes: [1] });
    assert.throws(() => commitCheckpoint(opened.database,
      { ...input, now: 4_000, output: { episodes: [2] } }, () => undefined), /持久输出冲突/);
    opened.close();

    const reopened = openDatabase(dataRoot);
    assert.deepEqual(getCheckpoint(reopened.database, input)?.output, { episodes: [1] });
    reopened.close();
  });
});

test("相同输入幂等跳过，输入变化原子替换 checkpoint 与领域结果", async () => {
  await withDatabase((dataRoot) => {
    const opened = openDatabase(dataRoot);
    runningJob(opened.database);
    opened.database.exec("CREATE TABLE generated_results (id TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT");
    let calls = 0;
    const input = {
      jobId: "job_1", stage: "events", scopeKey: "chapter_1", inputHash: INPUT_HASH_1,
      workerId: "worker_1", now: 2_000,
    };
    commitCheckpoint(opened.database, input, (transaction) => {
      calls += 1;
      transaction.run("INSERT INTO generated_results (id, value) VALUES ('result', '旧结果')");
    });
    const reused = commitCheckpoint(opened.database, { ...input, now: 3_000 }, () => { calls += 1; });

    assert.equal(reused.created, false);
    assert.equal(reused.replaced, false);
    assert.equal(calls, 1);
    const replaced = commitCheckpoint(opened.database, {
      ...input, inputHash: INPUT_HASH_2, now: 4_000,
    }, (transaction) => {
      calls += 1;
      transaction.run("UPDATE generated_results SET value = '新结果' WHERE id = 'result'");
    });
    assert.equal(replaced.created, false);
    assert.equal(replaced.replaced, true);
    assert.equal(replaced.checkpoint.inputHash, INPUT_HASH_2);
    assert.equal(opened.database.prepare("SELECT value FROM generated_results").get()?.value, "新结果");
    assert.equal(calls, 2);

    assert.throws(() => commitCheckpoint(opened.database, {
      ...input, inputHash: INPUT_HASH_1, now: 5_000,
    }, (transaction) => {
      transaction.run("UPDATE generated_results SET value = '不应保留' WHERE id = 'result'");
      throw new Error("替换失败");
    }), /替换失败/);
    assert.equal(getCheckpoint(opened.database, input)?.inputHash, INPUT_HASH_2);
    assert.equal(opened.database.prepare("SELECT value FROM generated_results").get()?.value, "新结果");
    opened.close();
  });
});

test("writer 抛错会回滚结果和检查点", async () => {
  await withDatabase((dataRoot) => {
    const opened = openDatabase(dataRoot);
    runningJob(opened.database);
    opened.database.exec("CREATE TABLE generated_results (value TEXT NOT NULL) STRICT");

    assert.throws(() => commitCheckpoint(opened.database, {
      jobId: "job_1", stage: "events", scopeKey: "chapter_1", inputHash: INPUT_HASH_1,
      workerId: "worker_1", now: 2_000,
    }, (transaction) => {
      transaction.run("INSERT INTO generated_results (value) VALUES (?)", "不应保留");
      throw new Error("生成失败");
    }), /生成失败/);
    assert.equal(opened.database.prepare("SELECT COUNT(*) AS count FROM generated_results").get()?.count, 0);
    assert.equal(getCheckpoint(opened.database, {
      jobId: "job_1", stage: "events", scopeKey: "chapter_1",
    }), undefined);
    opened.close();
  });
});

test("writer 不能注入事务控制、DDL 或多语句", async () => {
  await withDatabase((dataRoot) => {
    const opened = openDatabase(dataRoot);
    runningJob(opened.database);
    opened.database.exec("CREATE TABLE generated_results (value TEXT NOT NULL) STRICT");

    for (const [index, forbiddenSql] of [
      "COMMIT",
      "ROLLBACK",
      "SAVEPOINT nested",
      "CREATE TABLE escaped (value TEXT)",
      "PRAGMA foreign_keys = OFF",
      "ATTACH DATABASE ':memory:' AS escaped",
      "INSERT INTO generated_results (value) VALUES ('逃逸'); COMMIT",
    ].entries()) {
      assert.throws(() => commitCheckpoint(opened.database, {
        jobId: "job_1", stage: "forbidden", scopeKey: String(index), inputHash: INPUT_HASH_1,
        workerId: "worker_1", now: 2_000 + index,
      }, (transaction) => {
        transaction.run("INSERT INTO generated_results (value) VALUES ('不应执行')");
        transaction.run(forbiddenSql);
      }), /只允许单条 INSERT、UPDATE 或 DELETE/);
    }

    assert.equal(opened.database.prepare("SELECT COUNT(*) AS count FROM generated_results").get()?.count, 0);
    assert.equal(opened.database.prepare("SELECT COUNT(*) AS count FROM job_checkpoints").get()?.count, 0);
    opened.database.prepare("INSERT INTO generated_results (value) VALUES ('连接仍可用')").run();
    assert.equal(opened.database.prepare("SELECT COUNT(*) AS count FROM generated_results").get()?.count, 1);
    opened.close();
  });
});

test("异步 writer 与非 SHA-256 输入会在执行前拒绝", async () => {
  await withDatabase(async (dataRoot) => {
    const opened = openDatabase(dataRoot);
    runningJob(opened.database);
    opened.database.exec("CREATE TABLE generated_results (value TEXT NOT NULL) STRICT");
    assert.throws(() => commitCheckpoint(opened.database, {
      jobId: "job_1", stage: "events", scopeKey: "bad_hash", inputHash: "not-a-hash",
      workerId: "worker_1", now: 2_000,
    }, () => {}), /必须是 SHA-256/);
    let lateWriteRejected = false;
    const promiseWriter = ((transaction: { run(sql: string): void }) => Promise.resolve().then(() => {
      try {
        transaction.run("INSERT INTO generated_results (value) VALUES ('泄漏')");
      } catch {
        lateWriteRejected = true;
      }
    })) as unknown as Parameters<typeof commitCheckpoint>[2];
    if (false) {
      const rejectedPromiseWriter: Parameters<typeof commitCheckpoint>[2] =
        // @ts-expect-error 普通函数返回 Promise 也不得满足同步 writer 合同。
        () => Promise.resolve();
      void rejectedPromiseWriter;
    }
    assert.throws(() => commitCheckpoint(opened.database, {
      jobId: "job_1", stage: "events", scopeKey: "async", inputHash: INPUT_HASH_1,
      workerId: "worker_1", now: 2_000,
    }, promiseWriter), /writer 必须同步完成/);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(lateWriteRejected, true);
    assert.equal(getCheckpoint(opened.database, {
      jobId: "job_1", stage: "events", scopeKey: "async",
    }), undefined);
    assert.equal(opened.database.prepare("SELECT COUNT(*) AS count FROM generated_results").get()?.count, 0);
    opened.close();
  });
});

test("过期或不匹配的 Worker 租约不能创建检查点", async () => {
  await withDatabase((dataRoot) => {
    const opened = openDatabase(dataRoot);
    runningJob(opened.database);
    let called = false;

    for (const [workerId, now] of [["stale_worker", 2_000], ["worker_1", 11_000]] as const) {
      assert.throws(() => commitCheckpoint(opened.database, {
        jobId: "job_1", stage: "events", scopeKey: workerId, inputHash: INPUT_HASH_1, workerId, now,
      }, () => { called = true; }), /任务租约无效.*已过期/);
    }
    assert.equal(called, false);
    opened.close();
  });
});

test("已请求取消的运行中任务不能提交检查点或领域结果", async () => {
  await withDatabase((dataRoot) => {
    const opened = openDatabase(dataRoot);
    runningJob(opened.database);
    opened.database.exec("CREATE TABLE generated_results (value TEXT NOT NULL) STRICT");
    requestJobCancellation(opened.database, "job_1", 1_500);

    assert.throws(() => commitCheckpoint(opened.database, {
      jobId: "job_1", stage: "events", scopeKey: "cancelled", inputHash: INPUT_HASH_1,
      workerId: "worker_1", now: 2_000,
    }, (transaction) => {
      transaction.run("INSERT INTO generated_results (value) VALUES ('不应保留')");
    }), /已请求取消/);
    assert.equal(opened.database.prepare("SELECT COUNT(*) AS count FROM generated_results").get()?.count, 0);
    opened.close();
  });
});

test("删除任务会级联删除其检查点", async () => {
  await withDatabase((dataRoot) => {
    const opened = openDatabase(dataRoot);
    runningJob(opened.database);
    commitCheckpoint(opened.database, {
      jobId: "job_1", stage: "events", scopeKey: "chapter_1", inputHash: INPUT_HASH_1,
      workerId: "worker_1", now: 2_000,
    }, () => {});

    opened.database.prepare("DELETE FROM jobs WHERE id = ?").run("job_1");
    assert.equal(opened.database.prepare("SELECT COUNT(*) AS count FROM job_checkpoints").get()?.count, 0);
    opened.close();
  });
});
