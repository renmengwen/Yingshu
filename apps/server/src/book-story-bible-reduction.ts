import { createHash } from "node:crypto";

export const STORY_BIBLE_REDUCTION_FAN_IN = 10;
export const STORY_BIBLE_REDUCTION_VERSION = "book-story-bible-reduction-v1";

export function storyBibleReductionGroups<T>(items: readonly T[]) {
  const groups: T[][] = [];
  for (let index = 0; index < items.length; index += STORY_BIBLE_REDUCTION_FAN_IN) {
    groups.push(items.slice(index, index + STORY_BIBLE_REDUCTION_FAN_IN));
  }
  return groups;
}

export function storyBibleStepTotal(intervals: number) {
  let width = intervals;
  let total = intervals + 1;
  while (width > STORY_BIBLE_REDUCTION_FAN_IN) {
    const remainder = width % STORY_BIBLE_REDUCTION_FAN_IN;
    total += Math.floor(width / STORY_BIBLE_REDUCTION_FAN_IN) + (remainder > 1 ? 1 : 0);
    width = Math.ceil(width / STORY_BIBLE_REDUCTION_FAN_IN);
  }
  return total;
}

export function storyBibleReductionKey(parents: readonly { id: string; contentHash: string }[]) {
  return createHash("sha256").update(JSON.stringify({
    version: STORY_BIBLE_REDUCTION_VERSION,
    parents: parents.map(({ id, contentHash }) => ({ id, contentHash })),
  })).digest("hex");
}
