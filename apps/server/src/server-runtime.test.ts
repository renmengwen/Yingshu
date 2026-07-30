import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { buildApp } from "./app.js";
import { listenAndCloseOnFailure } from "./server-runtime.js";

test("监听失败会停止 Worker 并关闭 SQLite", async () => {
  const dataRoot = await mkdtemp(join(tmpdir(), "narralume-listen-failure-"));
  const blocker = createServer();
  await new Promise<void>((resolve, reject) => {
    blocker.once("error", reject);
    blocker.listen(0, "127.0.0.1", resolve);
  });
  const address = blocker.address();
  assert.ok(address && typeof address === "object");
  const app = buildApp({
    dataRoot,
    logger: false,
    jobHandlers: { hold: async () => ({}) },
    jobPollMs: 10_000,
  });

  try {
    assert.equal(await listenAndCloseOnFailure(app, { port: address.port, host: "127.0.0.1" }), false);
    await rm(dataRoot, { recursive: true, force: true });
  } finally {
    blocker.close();
    await app.close();
    await rm(dataRoot, { recursive: true, force: true });
  }
});
