import assert from "node:assert/strict";
import test from "node:test";

import { withDataFileMutationLock } from "./data-file-mutation-lock.js";

test("同一数据根的文件发布与清理严格串行，其他数据根不受阻塞", async () => {
  const order: string[] = [];
  let releaseFirst!: () => void;
  const first = withDataFileMutationLock("root-a", async () => {
    order.push("first-start");
    await new Promise<void>((resolve) => { releaseFirst = resolve; });
    order.push("first-end");
  });
  await Promise.resolve();
  const second = withDataFileMutationLock("root-a", async () => { order.push("second"); });
  const other = withDataFileMutationLock("root-b", async () => { order.push("other"); });
  await other;
  assert.deepEqual(order, ["first-start", "other"]);
  releaseFirst();
  await Promise.all([first, second]);
  assert.deepEqual(order, ["first-start", "other", "first-end", "second"]);
});
