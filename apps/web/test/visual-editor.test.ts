import assert from "node:assert/strict";
import test from "node:test";

import type { TtsTimeline } from "../src/production/types.ts";
import { conflictRevision, nextVisualDraft, visualDraft, visualPlanStatus, visualSegmentPayload } from "../src/production/visual/visual-editor.ts";
import type { VisualAsset, VisualSegment } from "../src/production/visual/types.ts";

const HASH = "a".repeat(64);
const timeline = { timelineHash: HASH, durationMs: 3000, cues: [0, 1, 2].map((index) => ({ index, segmentIndex: index, startMs: index * 1000, endMs: (index + 1) * 1000, text: `cue ${index}` })) } as TtsTimeline;
const segment = (index: number, ready = true, candidateId = `candidate_${index}`): VisualSegment => ({
  id: `visual_${index}`, episodeId: "episode", segmentIndex: index, timelineHash: HASH,
  cueStartIndex: index, cueEndIndex: index, startMs: index * 1000, endMs: (index + 1) * 1000,
  motionKind: "none", motionAmountPpm: 0, fadeMs: 300, revision: 2, productionReady: ready,
  assets: [{ assetId: "asset", selectedCandidateId: candidateId, candidateReviewRevision: 1 }],
});

test("视觉段草稿从服务端 revision 恢复且新段只取第一个未覆盖 cue", () => {
  assert.equal(visualDraft(segment(0)).expectedRevision, 2);
  assert.deepEqual(nextVisualDraft(timeline, [segment(0), segment(2)]), {
    segmentIndex: 1, cueStartIndex: 1, cueEndIndex: 1, motionKind: "none", motionAmountPpm: 0,
    fadeMs: 300, expectedRevision: 0, assetIds: [], selectedAssetId: "", selectedCandidateId: "",
  });
  assert.equal(nextVisualDraft(timeline, [])?.cueEndIndex, 2);
});

test("visual draft prefers an approved asset candidate matched by cue text", () => {
  const assets: VisualAsset[] = [
    { id: "asset_scene", type: "scene", role: "master", name: "墓道", parentAssetId: null, stateLabel: null, description: null, aliases: ["甬道"], candidates: [{ id: "candidate_scene", assetId: "asset_scene", source: { kind: "upload" }, width: 900, height: 1600, bytes: 1, reviewRevision: 1, reviewStatus: "approved" }] },
    { id: "asset_person", type: "character", role: "master", name: "吴邪", parentAssetId: null, stateLabel: null, description: null, aliases: [], candidates: [{ id: "candidate_person", assetId: "asset_person", source: { kind: "upload" }, width: 900, height: 1600, bytes: 1, reviewRevision: 1, reviewStatus: "approved" }] },
  ];
  const draft = nextVisualDraft({ ...timeline, cues: [{ ...timeline.cues[0]!, text: "我跟着吴邪走进墓道" }] }, [], assets);
  assert.equal(draft?.selectedAssetId, "asset_scene");
  assert.equal(draft?.selectedCandidateId, "candidate_scene");
});

test("视觉段提交只允许一张已选候选并保留其他显式资产", () => {
  assert.deepEqual(visualSegmentPayload(HASH, {
    segmentIndex: 0, cueStartIndex: 0, cueEndIndex: 1, motionKind: "pan-left", motionAmountPpm: 12000,
    fadeMs: 300, expectedRevision: 3, assetIds: ["asset_a", "asset_b", "asset_a"],
    selectedAssetId: "asset_b", selectedCandidateId: "candidate_b",
  }).assets, [{ assetId: "asset_a" }, { assetId: "asset_b", selectedCandidateId: "candidate_b" }]);
  assert.throws(() => visualSegmentPayload(HASH, {
    segmentIndex: 0, cueStartIndex: 0, cueEndIndex: 0, motionKind: "none", motionAmountPpm: 0,
    fadeMs: 0, expectedRevision: 0, assetIds: ["asset_a"], selectedAssetId: "asset_a", selectedCandidateId: "",
  }), /已批准候选图/);
});

test("视觉计划不再用 8 至 15 个固定段数做导出门禁", () => {
  const three = [segment(0), segment(1), segment(2)];
  const shortPlan = [{ ...segment(0), cueEndIndex: 2, endMs: 3_000 }];
  assert.equal(visualPlanStatus(timeline, shortPlan).productionReady, true);
  assert.equal(visualPlanStatus(timeline, shortPlan.map((item) => ({ ...item, productionReady: false }))).productionReady, false);
  assert.equal(visualPlanStatus({ ...timeline, cues: [...timeline.cues, { index: 3, segmentIndex: 3, startMs: 3000, endMs: 4000, text: "cue 3" }] }, three).continuous, false);

  const longTimeline = { ...timeline, durationMs: 90000, cues: Array.from({ length: 18 }, (_, index) => ({ index, segmentIndex: index, startMs: index * 3750, endMs: (index + 1) * 3750, text: `cue ${index}` })) } as TtsTimeline;
  const eighteen = Array.from({ length: 18 }, (_, index) => ({ ...segment(index), startMs: index * 3750, endMs: (index + 1) * 3750 }));
  const longStatus = visualPlanStatus(longTimeline, eighteen);
  assert.equal(longStatus.productionReady, true);
  assert.equal(longStatus.suggestion.targetCount, 18);
  assert.equal(longStatus.suggestion.openingMin, 3);
  assert.equal(longStatus.suggestion.openingMax, 4);
});

test("视觉计划把开头段数和不同候选图纳入生产就绪门禁", () => {
  const openingTimeline = {
    ...timeline,
    durationMs: 15_000,
    cues: Array.from({ length: 5 }, (_, index) => ({
      index, segmentIndex: index, startMs: index * 3_000, endMs: (index + 1) * 3_000, text: `cue ${index}`,
    })),
  } as TtsTimeline;
  const openingSegment = (index: number, candidateId = `candidate_${index}`) => ({
    ...segment(index, true, candidateId), startMs: index * 3_000, endMs: (index + 1) * 3_000,
  });
  assert.equal(visualPlanStatus(openingTimeline, [
    { ...openingSegment(0), cueEndIndex: 2, endMs: 9_000 },
    { ...openingSegment(1), cueStartIndex: 3, cueEndIndex: 4, startMs: 9_000, endMs: 15_000 },
  ]).productionReady, false);
  assert.equal(visualPlanStatus(openingTimeline, Array.from({ length: 5 }, (_, index) => openingSegment(index))).productionReady, false);
  assert.equal(visualPlanStatus(openingTimeline, [0, 1, 2].map((index) => openingSegment(index, "same"))
    .map((item, index) => index === 2 ? { ...item, cueEndIndex: 4, endMs: 15_000 } : item)).productionReady, false);
  assert.equal(visualPlanStatus(openingTimeline, [
    openingSegment(0), openingSegment(1), { ...openingSegment(2), cueEndIndex: 4, endMs: 15_000 },
  ]).productionReady, true);
  assert.equal(visualPlanStatus(timeline, [
    { ...segment(0), cueEndIndex: 2, endMs: 3_000 },
  ]).productionReady, true);
});

test("冲突响应可刷新 expectedRevision 且不改草稿字段", () => {
  assert.equal(conflictRevision("视觉段已变化，请按 revision=12 重试"), 12);
  assert.equal(conflictRevision("字幕区间重叠"), undefined);
});
