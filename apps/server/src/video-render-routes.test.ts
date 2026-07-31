import assert from "node:assert/strict";
import test from "node:test";

import { parseVideoRange } from "./video-render-routes.js";

test("最终视频 Range 支持播放器常用范围并严格拒绝越界", () => {
  assert.equal(parseVideoRange(undefined, 1_000), null);
  assert.deepEqual(parseVideoRange("bytes=100-199", 1_000), { start: 100, end: 199 });
  assert.deepEqual(parseVideoRange("bytes=900-", 1_000), { start: 900, end: 999 });
  assert.deepEqual(parseVideoRange("bytes=-100", 1_000), { start: 900, end: 999 });
  assert.deepEqual(parseVideoRange("bytes=900-2000", 1_000), { start: 900, end: 999 });
  assert.throws(() => parseVideoRange("bytes=1000-", 1_000), /超出文件范围/u);
  assert.throws(() => parseVideoRange("bytes=0-1,4-5", 1_000), /Range 请求无效/u);
});
