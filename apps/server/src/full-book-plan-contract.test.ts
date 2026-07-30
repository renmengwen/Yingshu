import assert from "node:assert/strict";
import test from "node:test";

import {
  FULL_BOOK_PLAN_CONTRACT_VERSION,
  canonicalFullBookPlanJson,
  parseFullBookPlan,
  type FullBookPlanOptions,
} from "./full-book-plan-contract.js";

function options(): FullBookPlanOptions {
  return {
    startChapterIndex: 1,
    endChapterIndex: 4,
    episodeCount: 3,
    allowedSourceEvents: new Map([
      ["event_1", { chapterId: "chapter_1", chapterIndex: 1, byteRanges: [{ byteStart: 0, byteEnd: 10 }] }],
      ["event_2a", { chapterId: "chapter_2", chapterIndex: 2, byteRanges: [{ byteStart: 10, byteEnd: 20 }] }],
      ["event_2b", { chapterId: "chapter_2", chapterIndex: 2, byteRanges: [{ byteStart: 20, byteEnd: 30 }] }],
      ["event_3", { chapterId: "chapter_3", chapterIndex: 3, byteRanges: [{ byteStart: 30, byteEnd: 40 }] }],
      ["event_4", { chapterId: "chapter_4", chapterIndex: 4, byteRanges: [{ byteStart: 40, byteEnd: 50 }] }],
    ]),
  };
}

function validPlan() {
  return {
    episodes: [
      { index: 1, title: " 起程 ", storyArc: "进入谜局", sourceEventIds: ["event_1", "event_2a"], recap: null, nextHook: "危险逼近" },
      { index: 2, title: "深入", storyArc: "发现线索", sourceEventIds: ["event_2b", "event_3"], recap: "承接谜局", nextHook: null },
      { index: 3, title: "揭晓", storyArc: "阶段收束", sourceEventIds: ["event_4"], recap: null, nextHook: null },
    ],
  };
}

test("严格解析恰好 N 集并稳定规范化边界章节共享计划", () => {
  const parsed = parseFullBookPlan(validPlan(), options());
  assert.equal(FULL_BOOK_PLAN_CONTRACT_VERSION, "full-book-plan-v1");
  assert.equal(parsed.episodes[0]?.title, "起程");
  const canonical = canonicalFullBookPlanJson(parsed);
  assert.equal(canonical, canonicalFullBookPlanJson(JSON.parse(canonical)));
  assert.deepEqual(JSON.parse(canonical), parsed);
});

test("拒绝集数、序号、未知字段、空集、伪造和重复来源", () => {
  const short = validPlan();
  short.episodes.pop();
  assert.throws(() => parseFullBookPlan(short, options()), /恰好包含 3 集/);

  const wrongIndex = validPlan();
  wrongIndex.episodes[1]!.index = 4;
  assert.throws(() => parseFullBookPlan(wrongIndex, options()), /episodes\[1\]\.index/);

  const unknown = validPlan() as ReturnType<typeof validPlan> & { provider?: string };
  unknown.provider = "x";
  assert.throws(() => parseFullBookPlan(unknown, options()), /未知字段.*provider/);

  const empty = validPlan();
  empty.episodes[0]!.sourceEventIds = [];
  assert.throws(() => parseFullBookPlan(empty, options()), /必须包含 1～100000 项/);

  const forged = validPlan();
  forged.episodes[0]!.sourceEventIds[0] = "event_missing";
  assert.throws(() => parseFullBookPlan(forged, options()), /未获准事件/);

  const duplicate = validPlan();
  duplicate.episodes[1]!.sourceEventIds[0] = "event_2a";
  assert.throws(() => parseFullBookPlan(duplicate, options()), /不能跨集或在同集重复/);
});

test("拒绝来源倒序、章节缺口和集内不连续，但允许不同语义事件引用重叠原文", () => {
  const reversed = validPlan();
  reversed.episodes[0]!.sourceEventIds.reverse();
  assert.throws(() => parseFullBookPlan(reversed, options()), /按原文顺序/);

  const gap = validPlan();
  gap.episodes[1]!.sourceEventIds = ["event_2b"];
  assert.throws(() => parseFullBookPlan(gap, options()), /未覆盖章节 3/);

  const discontinuous = validPlan();
  discontinuous.episodes[0]!.sourceEventIds = ["event_1", "event_3"];
  discontinuous.episodes[1]!.sourceEventIds = ["event_2a", "event_2b"];
  assert.throws(() => parseFullBookPlan(discontinuous, options()), /来源章节必须连续|按原文顺序/);

  const overlapOptions = options();
  const overlapEvents = new Map(overlapOptions.allowedSourceEvents);
  overlapOptions.allowedSourceEvents = overlapEvents;
  overlapEvents.set("event_2b", {
    chapterId: "chapter_2", chapterIndex: 2, byteRanges: [{ byteStart: 19, byteEnd: 30 }],
  });
  assert.equal(parseFullBookPlan(validPlan(), overlapOptions).episodes[0]!.title, "起程");
});

test("校验区间配额总和、连续范围和每区间明细数量", () => {
  const validOptions = options();
  validOptions.intervalQuotas = [
    { startChapterIndex: 1, endChapterIndex: 3, episodeCount: 2 },
    { startChapterIndex: 4, endChapterIndex: 4, episodeCount: 1 },
  ];
  assert.equal(parseFullBookPlan(validPlan(), validOptions).episodes.length, 3);

  const wrongTotal = options();
  wrongTotal.intervalQuotas = [
    { startChapterIndex: 1, endChapterIndex: 2, episodeCount: 1 },
    { startChapterIndex: 3, endChapterIndex: 4, episodeCount: 1 },
  ];
  assert.throws(() => parseFullBookPlan(validPlan(), wrongTotal), /配额总和必须等于 3/);

  const wrongDetails = options();
  wrongDetails.intervalQuotas = [
    { startChapterIndex: 1, endChapterIndex: 2, episodeCount: 2 },
    { startChapterIndex: 3, endChapterIndex: 4, episodeCount: 1 },
  ];
  assert.throws(() => parseFullBookPlan(validPlan(), wrongDetails), /实际明细为|不能跨越区间/);
});

test("拒绝非普通对象和无效服务端 allowlist", () => {
  assert.throws(() => parseFullBookPlan(new Date(), options()), /普通对象/);
  const invalid = options();
  const invalidEvents = new Map(invalid.allowedSourceEvents);
  invalid.allowedSourceEvents = invalidEvents;
  invalidEvents.set("event_bad", {
    chapterId: "chapter_2", chapterIndex: 2, byteRanges: [{ byteStart: 30, byteEnd: 30 }],
  });
  assert.throws(() => parseFullBookPlan(validPlan(), invalid), /byteEnd/);
});
