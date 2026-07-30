import assert from "node:assert/strict";
import test from "node:test";

import {
  BOOK_STORY_BIBLE_PROMPT_VERSION,
  BookStoryBibleJobContractError,
  buildStoryBibleFinalRequest,
  buildStoryBibleIntervalRequests,
  parseStoryBibleFinalResponse,
  parseStoryBibleIntervalResponse,
  planStoryBibleRebuild,
  type StoryBibleBuildLimits,
  type StoryBibleChapterInput,
} from "./book-story-bible-job.js";

const limits: StoryBibleBuildLimits = {
  maxChaptersPerInterval: 2,
  maxEventsPerInterval: 2,
  maxInputBytesPerInterval: 1_000,
  maxFinalIntervals: 10,
  maxFinalInputBytes: 100_000,
};

function chapters(): StoryBibleChapterInput[] {
  return [0, 1, 2, 3].map((chapterIndex) => ({
    chapterId: `chapter_${chapterIndex}`,
    chapterIndex,
    sourceEvents: [{ id: `event_${chapterIndex}`, contentHash: `${chapterIndex}`.repeat(64), inputBytes: 100 }],
  }));
}

function content(sourceEventId: string) {
  return {
    characters: [], relationships: [], locations: [], organizations: [], items: [], concepts: [],
    timeline: [{ summary: "已验证事件", chapterIds: ["chapter_0"], sourceEventIds: [sourceEventId] }],
    flashbacks: [], plotThreads: [], confusingFacts: [], spoilerRestrictions: [], properNouns: [],
  };
}

test("切换 provider/model 不改变区间或最终复用 identity", () => {
  const first = buildStoryBibleIntervalRequests("book_a", chapters(), { providerId: "p1", model: "m1" }, limits);
  const switched = buildStoryBibleIntervalRequests("book_a", chapters(), { providerId: "p2", model: "m2" }, limits);
  assert.equal(first.length, 2);
  assert.deepEqual(first.map(({ identityHash }) => identityHash), switched.map(({ identityHash }) => identityHash));
  assert.notDeepEqual(first.map(({ provenance }) => provenance), switched.map(({ provenance }) => provenance));
  assert.equal(BOOK_STORY_BIBLE_PROMPT_VERSION, "book-story-bible-prompt-v2");
  assert.equal(first[0]!.identity.promptVersion, BOOK_STORY_BIBLE_PROMPT_VERSION);
  const verifiedA = first.map((request) => parseStoryBibleIntervalResponse(request, content(request.sourceEventIds[0]!)));
  const verifiedB = switched.map((request) => parseStoryBibleIntervalResponse(request, content(request.sourceEventIds[0]!)));
  const finalA = buildStoryBibleFinalRequest("book_a", verifiedA, { providerId: "p1", model: "m1" }, limits);
  const finalB = buildStoryBibleFinalRequest("book_a", verifiedB, { providerId: "p2", model: "m2" }, limits);
  assert.equal(finalA.identity.promptVersion, BOOK_STORY_BIBLE_PROMPT_VERSION);
  assert.equal(finalA.identityHash, finalB.identityHash);
});

test("事件变化只失效命中区间和最终层，模型变化不失效，force 创建新版本意图", () => {
  const requests = buildStoryBibleIntervalRequests("book_a", chapters(), { providerId: "p", model: "m" }, limits);
  assert.deepEqual(planStoryBibleRebuild(requests, new Set(["event_2"])), {
    intervalIdentityHashes: [requests[1]!.identityHash], rebuildFinal: true, forceNewVersion: false,
  });
  assert.deepEqual(planStoryBibleRebuild(requests, new Set()), {
    intervalIdentityHashes: [], rebuildFinal: false, forceNewVersion: false,
  });
  assert.deepEqual(planStoryBibleRebuild(requests, new Set(), { force: true }), {
    intervalIdentityHashes: requests.map(({ identityHash }) => identityHash), rebuildFinal: true, forceNewVersion: true,
  });
});

test("拒绝伪造来源和超限输入，单区间仍须经过独立 final 层", () => {
  const requests = buildStoryBibleIntervalRequests("book_a", chapters(), { providerId: "p", model: "m" }, limits);
  assert.throws(() => parseStoryBibleIntervalResponse(requests[0]!, content("event_forged")), /未获准事件/);

  const oversized = chapters();
  oversized[0]!.sourceEvents[0]!.inputBytes = 1_001;
  assert.throws(
    () => buildStoryBibleIntervalRequests("book_a", oversized, { providerId: "p", model: "m" }, limits),
    /单章事件超过.*上限/,
  );

  const one = buildStoryBibleIntervalRequests(
    "book_a", chapters().slice(0, 1), { providerId: "p", model: "m" }, limits,
  );
  const verified = one.map((request) => parseStoryBibleIntervalResponse(request, content(request.sourceEventIds[0]!)));
  const finalRequest = buildStoryBibleFinalRequest("book_a", verified, { providerId: "p", model: "m" }, limits);
  assert.equal(finalRequest.kind, "final");
  assert.equal(finalRequest.intervals.length, 1);
  assert.notEqual(finalRequest.identityHash, one[0]!.identityHash);
  assert.doesNotThrow(() => parseStoryBibleFinalResponse(finalRequest, content("event_0")));
});

test("拒绝不连续章节、篡改区间内容和最终聚合超限", () => {
  const discontinuous = chapters();
  discontinuous[2]!.chapterIndex = 4;
  assert.throws(
    () => buildStoryBibleIntervalRequests("book_a", discontinuous, { providerId: "p", model: "m" }, limits),
    /连续序号/,
  );
  const requests = buildStoryBibleIntervalRequests("book_a", chapters(), { providerId: "p", model: "m" }, limits);
  const verified = requests.map((request) => parseStoryBibleIntervalResponse(request, content(request.sourceEventIds[0]!)));
  verified[0]!.content.timeline[0]!.summary = "被篡改";
  assert.throws(
    () => buildStoryBibleFinalRequest("book_a", verified, { providerId: "p", model: "m" }, limits),
    /已验证的区间/,
  );
  const strict = { ...limits, maxFinalInputBytes: 1 };
  const clean = requests.map((request) => parseStoryBibleIntervalResponse(request, content(request.sourceEventIds[0]!)));
  assert.throws(() => buildStoryBibleFinalRequest("book_a", clean, { providerId: "p", model: "m" }, strict), /输入字节超限/);
});

test("最终响应只能引用已验证区间来源并拒绝被篡改的上游内容", () => {
  const requests = buildStoryBibleIntervalRequests("book_a", chapters(), { providerId: "p", model: "m" }, limits);
  const verified = requests.map((request) => parseStoryBibleIntervalResponse(request, content(request.sourceEventIds[0]!)));
  const finalRequest = buildStoryBibleFinalRequest("book_a", verified, { providerId: "p", model: "m" }, limits);
  assert.doesNotThrow(() => parseStoryBibleFinalResponse(finalRequest, content("event_0")));
  assert.throws(() => parseStoryBibleFinalResponse(finalRequest, content("event_forged")), /未获准事件/);
  finalRequest.intervals[0]!.content.timeline[0]!.summary = "排队后被篡改";
  assert.throws(() => parseStoryBibleFinalResponse(finalRequest, content("event_0")), /区间内容无效/);
});

test("错误类型保持稳定", () => {
  assert.throws(
    () => buildStoryBibleIntervalRequests("bad id", chapters(), { providerId: "p", model: "m" }, limits),
    BookStoryBibleJobContractError,
  );
});
