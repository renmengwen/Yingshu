import assert from "node:assert/strict";
import test from "node:test";

import { restoredCreativeInputMode } from "../src/projects/input-logic.ts";
import type { VideoInputDraft } from "../src/projects/types.ts";

const input: VideoInputDraft = {
  inputMode: "topic",
  topic: "主题",
  body: "",
  referenceText: "",
  referenceRole: "style_only",
  targetDurationSeconds: 120,
  visualDensity: "standard",
  aspectRatio: "9:16",
  webEnabled: true,
  scriptInstructions: "",
  visualInstructions: "",
  updatedAt: 1,
};

test("输入页根据当前有效抖音选择恢复创作方式", () => {
  assert.equal(restoredCreativeInputMode(input, {
    douyin: { snapshotId: "snapshot_d", updatedAt: 10 },
    douyinSnapshotId: "snapshot_d",
  }), "douyin");
});

test("无效或不存在的来源选择不会覆盖主题/正文入口", () => {
  assert.equal(restoredCreativeInputMode(input, {
    douyin: { snapshotId: "snapshot_d", updatedAt: 10 },
    douyinSnapshotId: "snapshot_old",
  }), "topic");
  assert.equal(restoredCreativeInputMode({ ...input, inputMode: "body" }, {}), "body");
});

test("抖音与知乎同时存在时恢复最近保存的来源方式", () => {
  assert.equal(restoredCreativeInputMode(input, {
    douyin: { snapshotId: "snapshot_d", updatedAt: 10 },
    douyinSnapshotId: "snapshot_d",
    zhihu: { snapshotId: "snapshot_z", updatedAt: 20 },
    zhihuSnapshotId: "snapshot_z",
  }), "zhihu");
});
