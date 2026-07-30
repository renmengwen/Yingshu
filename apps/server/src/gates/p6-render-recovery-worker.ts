import assert from "node:assert/strict";

import { openDatabase } from "../database.js";
import { getJob } from "../job-store.js";
import { JobWorker } from "../job-worker.js";
import { createRenderChunksJobHandler, RENDER_CHUNKS_JOB_TYPE } from "../render-chunk-job.js";

const [dataRoot, expectedJobId] = process.argv.slice(2);
assert.ok(dataRoot && expectedJobId, "恢复门禁 Worker 参数缺失");

const connection = openDatabase(dataRoot);
try {
  const worker = new JobWorker(connection.database, {
    [RENDER_CHUNKS_JOB_TYPE]: createRenderChunksJobHandler(connection.database, dataRoot),
  }, { workerId: `p6-recovery-crash-${process.pid}`, leaseMs: 2_000, heartbeatMs: 500 });
  assert.equal(await worker.runOne(), true);
  const claimed = getJob(connection.database, expectedJobId);
  assert.ok(claimed && claimed.attempts >= 1 && claimed.status !== "queued", "恢复门禁 Worker 未领取目标任务");
} finally {
  connection.close();
}
