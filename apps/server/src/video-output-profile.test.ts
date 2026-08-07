import assert from "node:assert/strict";
import test from "node:test";

import {
  getImageOutputProfile,
  getVideoOutputProfile,
  parseAspectRatio,
} from "./video-output-profile.js";

test("输出画幅保持 9:16 兼容默认并提供完整 16:9 视频与图片规格", () => {
  assert.equal(parseAspectRatio(undefined), "9:16");
  assert.equal(parseAspectRatio("16:9"), "16:9");
  assert.deepEqual(getVideoOutputProfile("9:16"), { aspectRatio: "9:16", width: 1080, height: 1920 });
  assert.deepEqual(getVideoOutputProfile("16:9"), { aspectRatio: "16:9", width: 1920, height: 1080 });
  assert.deepEqual(getImageOutputProfile("16:9"), {
    aspectRatio: "16:9",
    width: 2848,
    height: 1600,
    size: "2848x1600",
  });
  assert.throws(() => parseAspectRatio("1:1"), /aspectRatio invalid/u);
});
