import assert from "node:assert/strict";
import test from "node:test";

import { videoImageRequestIdentity, type VideoImagePermit } from "./video-image-contract.js";

test("图片 Job 身份绑定完整批准版本、Prompt、模型和显式幂等键", () => {
  const permit: VideoImagePermit = {
    projectId: "project", videoId: "video", planSnapshotId: "snapshot", planSnapshotHash: "a".repeat(64),
    scriptRevisionId: "script", scriptContentHash: "b".repeat(64), visualRevisionId: "visual-revision",
    visualContentHash: "c".repeat(64), visualId: "visual", prompt: "蓝天", negativePrompt: "水印",
    styleSnapshot: { purpose: "科普" }, promptHash: "d".repeat(64),
  };
  const first = videoImageRequestIdentity(permit, "provider", "model", "click-1");
  assert.equal(first, videoImageRequestIdentity(permit, "provider", "model", "click-1"));
  assert.notEqual(first, videoImageRequestIdentity({ ...permit, prompt: "晚霞" }, "provider", "model", "click-1"));
  assert.notEqual(first, videoImageRequestIdentity(permit, "provider", "model", "click-2"));
});
