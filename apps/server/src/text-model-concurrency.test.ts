import assert from "node:assert/strict";
import test from "node:test";

import { TextModelConcurrencyGate } from "./text-model-concurrency.js";

test("文本模型闸门限制全局并发并在任务完成后释放 permit", async () => {
  const gate = new TextModelConcurrencyGate(2);
  let active = 0;
  let maximum = 0;
  let releaseTasks!: () => void;
  const wait = new Promise<void>((resolve) => { releaseTasks = resolve; });
  const tasks = Array.from({ length: 5 }, () => gate.run(undefined, async () => {
    active += 1;
    maximum = Math.max(maximum, active);
    await wait;
    active -= 1;
  }));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(gate.active, 2);
  assert.equal(gate.pending, 3);
  releaseTasks();
  await Promise.all(tasks);
  assert.equal(maximum, 2);
  assert.equal(gate.active, 0);
  assert.equal(gate.pending, 0);
});

test("排队期间取消不会获得或泄漏 permit，也不会执行请求", async () => {
  const gate = new TextModelConcurrencyGate(1);
  const release = await gate.acquire();
  const controller = new AbortController();
  let called = false;
  const queued = gate.run(controller.signal, async () => { called = true; });
  controller.abort();
  await assert.rejects(queued, { name: "AbortError" });
  assert.equal(called, false);
  assert.equal(gate.active, 1);
  assert.equal(gate.pending, 0);
  release();
  assert.equal(gate.active, 0);
});
