import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { openDatabase } from "./database.js";
import {
  cancelRunningJob,
  claimNextJob,
  createJob,
  failJob,
  getJob,
  renewJobLease,
  requestJobCancellation,
  succeedJob,
  updateJobProgress,
} from "./job-store.js";

test("任务先持久化，按优先级租用并在重启后保留状态", async () => {
  const dataRoot = await mkdtemp(join(tmpdir(), "narralume-jobs-persist-"));
  try {
    const first = openDatabase(dataRoot);
    createJob(first.database, { id: "job_low", type: "test", payload: { value: 1 }, priority: 1 }, 1000);
    createJob(first.database, { id: "job_high", type: "test", payload: { value: 2 }, priority: 10 }, 1000);
    const claimed = claimNextJob(first.database, "worker-a", 500, 1000);
    assert.equal(claimed?.id, "job_high");
    assert.equal(claimed?.attempts, 1);
    assert.equal(claimed?.leaseExpiresAt, 1500);
    assert.equal(updateJobProgress(first.database, "job_high", "worker-a", 0.4, 1100), true);
    assert.equal(renewJobLease(first.database, "job_high", "worker-a", 500, 1200), true);
    first.close();

    const reopened = openDatabase(dataRoot);
    const persisted = getJob<{ value: number }>(reopened.database, "job_high");
    assert.equal(persisted?.status, "running");
    assert.equal(persisted?.payload.value, 2);
    assert.equal(persisted?.progress, 0.4);
    assert.equal(persisted?.leaseExpiresAt, 1700);
    assert.equal(succeedJob(reopened.database, "job_high", "worker-a", { ok: true }, 1300), true);
    assert.deepEqual(getJob(reopened.database, "job_high")?.result, { ok: true });
    reopened.close();
  } finally {
    await rm(dataRoot, { recursive: true, force: true });
  }
});

test("Worker 只领取已注册类型且创建参数有安全边界", async () => {
  const dataRoot = await mkdtemp(join(tmpdir(), "narralume-jobs-types-"));
  const connection = openDatabase(dataRoot);
  try {
    createJob(connection.database, { id: "job_unknown", type: "unknown", payload: {}, priority: 100 }, 1000);
    createJob(connection.database, { id: "job_supported", type: "supported", payload: {}, priority: 1 }, 1000);
    const claimed = claimNextJob(connection.database, "worker", 500, 1000, ["supported"]);
    assert.equal(claimed?.id, "job_supported");
    assert.equal(getJob(connection.database, "job_unknown")?.status, "queued");
    assert.throws(
      () => createJob(connection.database, { type: "supported", payload: {}, maxAttempts: 11 }),
      /最大尝试次数必须在 1～10 之间/,
    );
  } finally {
    connection.close();
    await rm(dataRoot, { recursive: true, force: true });
  }
});

test("过期租约可回收且旧 Worker 不能提交结果", async () => {
  const dataRoot = await mkdtemp(join(tmpdir(), "narralume-jobs-lease-"));
  const connection = openDatabase(dataRoot);
  try {
    createJob(connection.database, { id: "job_reclaim", type: "test", payload: null }, 1000);
    assert.equal(claimNextJob(connection.database, "worker-old", 100, 1000)?.attempts, 1);
    const reclaimed = claimNextJob(connection.database, "worker-new", 100, 1101);
    assert.equal(reclaimed?.id, "job_reclaim");
    assert.equal(reclaimed?.attempts, 2);
    assert.equal(succeedJob(connection.database, "job_reclaim", "worker-old", {}, 1150), false);
    assert.equal(succeedJob(connection.database, "job_reclaim", "worker-new", { owner: "new" }, 1150), true);
  } finally {
    connection.close();
    await rm(dataRoot, { recursive: true, force: true });
  }
});

test("失败按最大次数重试并保留可观察错误", async () => {
  const dataRoot = await mkdtemp(join(tmpdir(), "narralume-jobs-retry-"));
  const connection = openDatabase(dataRoot);
  try {
    createJob(connection.database, { id: "job_retry", type: "test", payload: {}, maxAttempts: 2 }, 1000);
    claimNextJob(connection.database, "worker", 500, 1000);
    assert.equal(failJob(connection.database, "job_retry", "worker", "temporary", "第一次失败", 200, 1100), true);
    const waiting = getJob(connection.database, "job_retry");
    assert.equal(waiting?.status, "queued");
    assert.equal(waiting?.progress, 0);
    assert.equal(waiting?.runAfter, 1300);
    assert.equal(waiting?.errorMessage, "第一次失败");
    assert.equal(claimNextJob(connection.database, "worker", 500, 1299), undefined);
    assert.equal(claimNextJob(connection.database, "worker", 500, 1300)?.attempts, 2);
    assert.equal(failJob(connection.database, "job_retry", "worker", "fatal", "第二次失败", 0, 1400), true);
    const failed = getJob(connection.database, "job_retry");
    assert.equal(failed?.status, "failed");
    assert.equal(failed?.errorCode, "fatal");
    assert.equal(failed?.finishedAt, 1400);
  } finally {
    connection.close();
    await rm(dataRoot, { recursive: true, force: true });
  }
});

test("过期租约按取消、重试与尝试耗尽分别收敛", async () => {
  const dataRoot = await mkdtemp(join(tmpdir(), "narralume-jobs-expired-"));
  const connection = openDatabase(dataRoot);
  try {
    createJob(connection.database, { id: "job_cancel_expired", type: "test", payload: {} }, 1000);
    claimNextJob(connection.database, "worker-old", 100, 1000);
    updateJobProgress(connection.database, "job_cancel_expired", "worker-old", 0.7, 1050);
    requestJobCancellation(connection.database, "job_cancel_expired", 1060);

    createJob(connection.database, { id: "job_retry_expired", type: "test", payload: {}, maxAttempts: 2 }, 1000);
    claimNextJob(connection.database, "worker-old", 100, 1000);
    updateJobProgress(connection.database, "job_retry_expired", "worker-old", 0.6, 1050);

    createJob(connection.database, { id: "job_failed_expired", type: "test", payload: {}, maxAttempts: 1 }, 1000);
    claimNextJob(connection.database, "worker-old", 100, 1000);

    const reclaimed = claimNextJob(connection.database, "worker-new", 100, 1101);
    assert.equal(reclaimed?.id, "job_retry_expired");
    assert.equal(reclaimed?.attempts, 2);
    assert.equal(reclaimed?.progress, 0);
    assert.equal(getJob(connection.database, "job_cancel_expired")?.status, "cancelled");
    const failed = getJob(connection.database, "job_failed_expired");
    assert.equal(failed?.status, "failed");
    assert.equal(failed?.errorCode, "lease_expired");
    assert.equal(failed?.finishedAt, 1101);
  } finally {
    connection.close();
    await rm(dataRoot, { recursive: true, force: true });
  }
});

test("排队取消立即终止，运行中取消由租约所有者确认", async () => {
  const dataRoot = await mkdtemp(join(tmpdir(), "narralume-jobs-cancel-"));
  const connection = openDatabase(dataRoot);
  try {
    createJob(connection.database, { id: "job_queued", type: "test", payload: {} }, 1000);
    assert.equal(requestJobCancellation(connection.database, "job_queued", 1050)?.status, "cancelled");
    assert.equal(claimNextJob(connection.database, "worker", 500, 1100), undefined);

    createJob(connection.database, { id: "job_running", type: "test", payload: {} }, 1200);
    claimNextJob(connection.database, "worker", 500, 1200);
    const requested = requestJobCancellation(connection.database, "job_running", 1250);
    assert.equal(requested?.status, "running");
    assert.equal(requested?.cancelRequested, true);
    assert.equal(succeedJob(connection.database, "job_running", "worker", {}, 1300), false);
    assert.equal(cancelRunningJob(connection.database, "job_running", "worker", 1300), true);
    assert.equal(getJob(connection.database, "job_running")?.status, "cancelled");
  } finally {
    connection.close();
    await rm(dataRoot, { recursive: true, force: true });
  }
});
