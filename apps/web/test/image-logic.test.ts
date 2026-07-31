import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToString } from "react-dom/server";

import { candidateIdentity, currentImageCandidates, historicalImageCandidates, imageBatchSummary, imageWorkspaceCounts, type VideoImageCandidate, type VideoImageWorkspace } from "../src/projects/image-logic.ts";
import { VisualImageReviewRow } from "../src/projects/VisualImageReviewRow.tsx";

const candidate = (override: Partial<VideoImageCandidate> = {}): VideoImageCandidate => ({
  id: "candidate_1", visualId: "visual_1", origin: "generation", previewUrl: "/api/media/candidate_1",
  prompt: "暖中性剪辑工作台", negativePrompt: "文字", styleSnapshot: { tone: "暖中性" }, providerId: "fixture",
  modelId: "fixture-image", params: { size: "1080x1920", aspectRatio: "9:16", seed: 42 }, createdAt: 1,
  width: 1080, height: 1920, bytes: 1024, fileHash: "a".repeat(64), currentCompatible: true, approved: false,
  planSnapshotId: "snapshot_1", planSnapshotHash: "b".repeat(64), scriptRevisionId: "script_1",
  scriptContentHash: "c".repeat(64), visualRevisionId: "visual_revision_1", visualContentHash: "d".repeat(64),
  promptHash: "e".repeat(64), requestIdentity: "request_1", batchId: "batch_1", idempotencyKey: "key_1",
  jobId: "job_1", attempt: 1, checkpointScope: "visual_1", mime: "image/png", relativePath: "assets/a.png",
  ...override,
});

const workspace: VideoImageWorkspace = {
  productionAllowed: true, blockedReason: null, provider: { id: "fixture", model: "fixture-image" }, feeEstimate: null,
  summary: { visualTotal: 3, currentCandidateCount: 1, coveredVisualCount: 1, missingCount: 2, plannedPerVisual: 1 },
  gate: { revision: 2, status: "pending", approvedCount: 0, total: 3 },
  batch: { id: "batch_1", status: "partial", counts: { queued: 0, running: 0, succeeded: 1, failed: 1, cancelled: 1, total: 3 } },
  visuals: [],
};

test("图片摘要直接使用服务端冻结计数且不伪造百分比或费用", () => {
  assert.deepEqual(imageWorkspaceCounts(workspace), { total: 3, candidates: 1, covered: 1, missing: 2 });
  assert.equal(imageBatchSummary(workspace.batch), "部分完成：排队 0，生成中 0，成功 1，失败 1，已中断 1。");
});

test("当前与历史候选严格按兼容身份隔离", () => {
  const visual = { id: "visual_1", order: 0, paragraphId: "paragraph_1", narrationSummary: "旁白", description: "画面", prompt: "prompt", negativePrompt: "", generationState: null, candidates: [candidate(), candidate({ id: "candidate_old", currentCompatible: false })] };
  assert.deepEqual(currentImageCandidates(visual).map(({ id }) => id), ["candidate_1"]);
  assert.deepEqual(historicalImageCandidates(visual).map(({ id }) => id), ["candidate_old"]);
  assert.equal(candidateIdentity(candidate()), "fixture · fixture-image · 1080x1920 · seed 42");
  assert.equal(candidateIdentity(candidate({ origin: "upload", originalName: "本地图.png" })), "本地上传 · 本地图.png");
});

test("画面审核行呈现语义图片、完整身份、当前批准与历史隔离", () => {
  const html = renderToString(createElement(VisualImageReviewRow, {
    visual: { id: "visual_1", order: 0, paragraphId: "paragraph_1", narrationSummary: "夜色里整理素材", description: "暖色剪辑工作台", prompt: "editorial workspace", negativePrompt: "文字", generationState: { status: "failed", errorSummary: "服务暂时不可用" }, candidates: [candidate(), candidate({ id: "candidate_old", currentCompatible: false })] },
    productionAllowed: true, busyAction: null,
    onGenerate: () => undefined, onUpload: () => undefined, onApprove: () => undefined,
  }));
  assert.match(html, /夜色里整理素材/);
  assert.match(html, /alt="画面 01：暖色剪辑工作台；候选 1，生成，待审核"/);
  assert.match(html, /查看完整生成身份/);
  assert.match(html, /方案快照/);
  assert.match(html, /生成失败.*服务暂时不可用/);
  assert.match(html, /选择并批准/);
  assert.match(html, /历史 \/ 已失效候选/);
  assert.match(html, /min-h-11/);
});
