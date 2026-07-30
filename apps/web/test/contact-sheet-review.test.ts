import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  contactSheetReviewPayload,
  contactSheetReviewUrl,
  isCurrentContactSheetReviewOperation,
  parseContactSheetReviewWorkspace,
} from "../src/production/visual/contact-sheet-review";

const H1 = "1".repeat(64);
const H2 = "2".repeat(64);
const H3 = "3".repeat(64);
const H4 = "4".repeat(64);
const identity = {
  contract: "contact-sheet-review-v1",
  episodeId: "episode_1",
  scriptVersionId: "script_1",
  approvalRevision: 2,
  timelineHash: H1,
  visualPlanHash: H2,
  jsonHash: H3,
  htmlHash: H4,
};
const contactSheet = {
  episodeId: "episode_1",
  timelineHash: H1,
  directoryPath: "contact-sheets/episode_1",
  jsonPath: "contact-sheets/episode_1/contact-sheet.json",
  htmlPath: "contact-sheets/episode_1/contact-sheet.html",
  jsonHash: H3,
  htmlHash: H4,
};

function response(latestReview: unknown = null) {
  return {
    ok: true,
    workspace: {
      identity,
      identityHash: H2,
      contactSheet,
      latestReview,
      hasStaleReview: false,
    },
  };
}

test("联系表审核工作区严格恢复当前身份和显式审核", () => {
  const latestReview = {
    contract: "contact-sheet-review-v1",
    identity,
    identityHash: H2,
    action: "approve",
    notes: "已核对开头节奏",
    jobId: "job_review_1",
  };
  const parsed = parseContactSheetReviewWorkspace(response(latestReview), { episodeId: "episode_1", timelineHash: H1 });
  assert.equal(parsed.identityHash, H2);
  assert.equal(parsed.contactSheet.jsonHash, H3);
  assert.equal(parsed.latestReview?.action, "approve");
});

test("联系表审核解析拒绝错路由、错哈希、错合同和错动作", () => {
  assert.throws(() => parseContactSheetReviewWorkspace(response(), { episodeId: "episode_2", timelineHash: H1 }), /不属于当前分集/u);
  assert.throws(() => parseContactSheetReviewWorkspace({ ...response(), workspace: { ...response().workspace, identityHash: "bad" } }, { episodeId: "episode_1", timelineHash: H1 }), /身份哈希无效/u);
  assert.throws(() => parseContactSheetReviewWorkspace(response({ contract: "wrong", identity, identityHash: H2, action: "approve", notes: null, jobId: "job_1" }), { episodeId: "episode_1", timelineHash: H1 }), /最新联系表审核记录无效/u);
  assert.throws(() => parseContactSheetReviewWorkspace(response({ contract: "contact-sheet-review-v1", identity, identityHash: H2, action: "skip", notes: null, jobId: "job_1" }), { episodeId: "episode_1", timelineHash: H1 }), /最新联系表审核记录无效/u);
  assert.throws(() => parseContactSheetReviewWorkspace({ ...response(), extra: true }, { episodeId: "episode_1", timelineHash: H1 }), /字段无效/u);
});

test("联系表审核请求只提交动作、并发身份和规范化备注", () => {
  assert.equal(contactSheetReviewUrl("episode /1", H1), `/api/episodes/episode%20%2F1/contact-sheet/review?timelineHash=${H1}`);
  assert.deepEqual(contactSheetReviewPayload("reject", H2, "  需返修  "), {
    action: "reject",
    expectedIdentityHash: H2,
    notes: "需返修",
  });
  assert.deepEqual(contactSheetReviewPayload("approve", H2, "  "), {
    action: "approve",
    expectedIdentityHash: H2,
    notes: null,
  });
  assert.throws(() => contactSheetReviewPayload("skip" as "approve", H2, ""), /动作无效/u);
  assert.throws(() => contactSheetReviewPayload("reject", H2, "x".repeat(2001)), /不能超过/u);
});

test("VisualStage 复用中央 Job、显式确认且预览不会自动批准", () => {
  const stage = readFileSync(new URL("../src/production/visual/VisualStage.tsx", import.meta.url), "utf8");
  const workspace = readFileSync(new URL("../src/ProductionWorkspace.tsx", import.meta.url), "utf8");
  assert.match(workspace, /<VisualStage[^>]+jobActive=\{jobActive\}[^>]+currentJob=\{currentJob\}[^>]+onJobCreated=\{trackJob\}/u);
  assert.match(stage, /我已查看本集全部画面，并核对开头节奏与字幕覆盖/u);
  assert.match(stage, /导出、预览和逐图批准都不会自动通过整集审核/u);
  assert.match(stage, /min-h-11/u);
  assert.match(stage, /aria-live="polite"/u);
  assert.match(stage, /submitContactSheetReview\("approve"\)/u);
  assert.match(stage, /submitContactSheetReview\("reject"\)/u);
});

test("旧审核 Job 终态和延迟 POST 不能写回新路由或新身份", () => {
  assert.equal(isCurrentContactSheetReviewOperation(
    { epoch: 4, identityHash: H1 }, { epoch: 4, identityHash: H1 },
  ), true);
  assert.equal(isCurrentContactSheetReviewOperation(
    { epoch: 4, identityHash: H1 }, { epoch: 5, identityHash: H1 },
  ), false);
  assert.equal(isCurrentContactSheetReviewOperation(
    { epoch: 4, identityHash: H1 }, { epoch: 4, identityHash: H2 },
  ), false);
  const hook = readFileSync(new URL("../src/production/visual/use-visual-workspace.ts", import.meta.url), "utf8");
  assert.match(hook, /reviewJob\.current = undefined; reviewIdentityHash\.current = ""/u);
  assert.match(hook, /currentJob\.status === "cancelled"/u);
  assert.match(hook, /finally \{[\s\S]*isCurrentContactSheetReviewOperation\(expectedOperation/u);
});
