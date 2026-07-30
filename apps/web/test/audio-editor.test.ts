import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { mergeProductionWorkspaceLocation, productionWorkspaceFromSearch, productionWorkspacePath, usesChapterWorkspaceStatus } from "../src/production-logic.ts";
import {
  completedTtsTimelineHash, listeningIdentityKey, listeningReviewPayload, listeningReviewUrl,
  parseListeningReviewWorkspace,
} from "../src/production/audio/audio-editor.ts";

const HASH = "a".repeat(64);
const OTHER_HASH = "b".repeat(64);

function listeningResponse(timelineHash = HASH) {
  return { ok: true, workspace: {
    identity: {
      episodeId: "episode/1", scriptVersionId: "script_1", contentHash: HASH, approvalRevision: 2,
      timelineHash, providerId: "edge", voice: "zh-CN-YunjianNeural", rate: 1,
      storyBibleId: "bible_1", storyBibleContentHash: HASH, properNounsHash: HASH, representativeHash: HASH,
    },
    segments: Array.from({ length: 9 }, (_, index) => ({ index, text: index === 6 ? "张起灵走进墓道" : `片段 ${index + 1}`, durationMs: 1000 + index })),
    requiredSegmentIndexes: [0, 2, 4, 6, 8],
    requiredProperNouns: [{ term: "张起灵", pronunciation: "zhāng qǐ líng", matchedText: "张起灵", segmentIndex: 6 }],
    latestReview: null,
  } };
}

test("语音时间轴 URL 只恢复 64 位小写 sha256", () => {
  const hash = "a".repeat(64);
  const path = productionWorkspacePath({ bookId: "book_1", seriesId: "series_1", stage: "audio", episodeIndex: 2, timelineHash: hash });
  assert.equal(productionWorkspaceFromSearch(path)?.timelineHash, hash);
  assert.equal(productionWorkspaceFromSearch(`${path.slice(0, -1)}A`)?.timelineHash, undefined);
  assert.equal(mergeProductionWorkspaceLocation({ stage: "audio", timelineHash: hash }, { timelineHash: undefined }).timelineHash, undefined);
});

test("语音任务结果必须匹配类型、终态、分集与时间轴身份", () => {
  const hash = "b".repeat(64);
  const job = { id: "job_1", type: "tts_timeline", status: "succeeded" as const, progress: 1, attempts: 1,
    maxAttempts: 3, cancelRequested: false, errorMessage: null, result: { episodeId: "episode_1", timelineHash: hash } };
  assert.equal(completedTtsTimelineHash(job, "episode_1"), hash);
  assert.equal(completedTtsTimelineHash({ ...job, status: "running" }, "episode_1"), undefined);
  assert.equal(completedTtsTimelineHash(job, "episode_2"), undefined);
  assert.equal(completedTtsTimelineHash({ ...job, result: { episodeId: "episode_1", timelineHash: "bad" } }, "episode_1"), undefined);
});

test("章节后台恢复只允许覆盖依赖章节的阶段文案", () => {
  assert.equal(usesChapterWorkspaceStatus("events"), true);
  assert.equal(usesChapterWorkspaceStatus("episode"), true);
  assert.equal(usesChapterWorkspaceStatus("audio"), false);
  assert.equal(usesChapterWorkspaceStatus("scripts"), false);
});

test("人工听审解析服务端动态代表段、专名与当前精确身份", () => {
  const workspace = parseListeningReviewWorkspace(listeningResponse(), { episodeId: "episode/1", timelineHash: HASH });
  assert.deepEqual(workspace.requiredSegmentIndexes, [0, 2, 4, 6, 8]);
  assert.deepEqual(workspace.requiredProperNouns[0], {
    term: "张起灵", pronunciation: "zhāng qǐ líng", matchedText: "张起灵", segmentIndex: 6,
  });
  assert.equal(listeningReviewUrl("episode/1", HASH), `/api/episodes/episode%2F1/tts-timelines/${HASH}/listening-review`);
});

test("人工听审只提交显式核对项，approve 与 reject 不携带冻结身份", () => {
  assert.deepEqual(listeningReviewPayload("approve", new Set([8, 0]), new Set(["张起灵"]), "  读音正确  "), {
    action: "approve", checkedSegmentIndexes: [0, 8], checkedProperNouns: ["张起灵"], notes: "读音正确",
  });
  assert.deepEqual(listeningReviewPayload("reject", [], [], ""), {
    action: "reject", checkedSegmentIndexes: [], checkedProperNouns: [], notes: null,
  });
});

test("时间轴或当前身份变化时拒绝旧听审响应", () => {
  assert.throws(() => parseListeningReviewWorkspace(listeningResponse(HASH), {
    episodeId: "episode/1", timelineHash: OTHER_HASH,
  }), /不属于当前分集或时间轴/);
  const first = parseListeningReviewWorkspace(listeningResponse(HASH), { episodeId: "episode/1", timelineHash: HASH });
  const changed = listeningResponse(HASH);
  changed.workspace.identity.approvalRevision = 3;
  const second = parseListeningReviewWorkspace(changed, { episodeId: "episode/1", timelineHash: HASH });
  assert.notEqual(listeningIdentityKey(first.identity), listeningIdentityKey(second.identity));
});

test("AudioStage 听审控件保持 44px、防重复且播放不自动核对或批准", () => {
  const stage = readFileSync(new URL("../src/production/audio/AudioStage.tsx", import.meta.url), "utf8");
  const hook = readFileSync(new URL("../src/production/audio/use-audio-workspace.ts", import.meta.url), "utf8");
  assert.match(stage, /逐项试听并显式勾选/);
  assert.match(stage, /min-h-11/);
  assert.doesNotMatch(stage, /onEnded=/);
  assert.match(hook, /if \(reviewing\.current \|\| jobActive \|\| !listeningWorkspace\) return/);
  assert.match(hook, /listeningIdentity\.current !== expectedIdentity/);
  assert.match(hook, /listeningRequest\.current !== request/);
});
