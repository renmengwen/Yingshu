import assert from "node:assert/strict";
import test from "node:test";

import {
  storyBibleReductionGroups,
  storyBibleReductionKey,
  storyBibleStepTotal,
} from "./book-story-bible-reduction.js";

test("故事圣经按十路分层归并并计算真实步骤", () => {
  assert.deepEqual(storyBibleReductionGroups(Array.from({ length: 23 }, (_, index) => index)).map((group) => group.length), [10, 10, 3]);
  assert.equal(storyBibleStepTotal(10), 11);
  assert.equal(storyBibleStepTotal(11), 13);
  assert.equal(storyBibleStepTotal(90), 100);
  assert.equal(storyBibleStepTotal(1000), 1111);
  assert.equal(storyBibleReductionKey([{ id: "a", contentHash: "1".repeat(64) }]),
    storyBibleReductionKey([{ id: "a", contentHash: "1".repeat(64) }]));
  assert.notEqual(storyBibleReductionKey([{ id: "a", contentHash: "1".repeat(64) }]),
    storyBibleReductionKey([{ id: "a", contentHash: "2".repeat(64) }]));
});
