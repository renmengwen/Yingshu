import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createElement } from "react";
import { renderToString } from "react-dom/server";

import { candidateIdentity, currentImageCandidates, historicalImageCandidates, imageBatchSummary, imageWorkspaceCounts, type VideoImageCandidate, type VideoImageVisual, type VideoImageWorkspace } from "../src/projects/image-logic.ts";
import { VideoImageReviewList } from "../src/projects/VideoImageReviewList.tsx";
import { DEFAULT_PAGE_SIZE, PAGE_SIZE_OPTIONS, paginate } from "../src/projects/video-plan-review/logic.ts";

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");

const candidate = (override: Partial<VideoImageCandidate> = {}): VideoImageCandidate => ({
  id: "candidate_1", visualId: "visual_1", origin: "generation", previewUrl: "/api/media/candidate_1",
  prompt: "暖中性剪辑工作台", negativePrompt: "文字", styleSnapshot: { tone: "暖中性" }, providerId: "fixture",
  modelId: "fixture-image", params: { size: "1080x1920", aspectRatio: "9:16", seed: 42 }, createdAt: 1,
  width: 1080, height: 1920, bytes: 1024, fileHash: "a".repeat(64), currentCompatible: true, approved: false,
  planSnapshotId: "snapshot_1", planSnapshotHash: "b".repeat(64), scriptRevisionId: "script_1",
  scriptContentHash: "c".repeat(64), visualRevisionId: "visual_revision_1", visualContentHash: "d".repeat(64),
  promptHash: "e".repeat(64), requestIdentity: "request_1", batchId: "batch_1", idempotencyKey: "key_1",
  jobId: "job_1", attempt: 1, checkpointScope: "visual_1", providerRequestId: "provider_request_1", mime: "image/png", relativePath: "assets/a.png",
  ...override,
});

const visual = (order: number, override: Partial<VideoImageVisual> = {}): VideoImageVisual => ({
  id: `visual_${order + 1}`,
  order,
  paragraphId: `paragraph_${order + 1}`,
  narrationSummary: `旁白摘要 ${order + 1}`,
  description: `完整中文描述 ${order + 1}`,
  prompt: `final prompt ${order + 1}`,
  negativePrompt: `negative prompt ${order + 1}`,
  generationState: null,
  candidates: [],
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
  const row = visual(0, { candidates: [candidate(), candidate({ id: "candidate_old", currentCompatible: false })] });
  assert.deepEqual(currentImageCandidates(row).map(({ id }) => id), ["candidate_1"]);
  assert.deepEqual(historicalImageCandidates(row).map(({ id }) => id), ["candidate_old"]);
  assert.equal(candidateIdentity(candidate()), "fixture · fixture-image · 1080x1920 · seed 42");
  assert.equal(candidateIdentity(candidate({ origin: "upload", originalName: "本地图.png" })), "本地上传 · 本地图.png");
});

test("配图分页复用默认 10/20 合同并在数据减少时夹紧页码", () => {
  const rows = Array.from({ length: 21 }, (_, index) => index);
  assert.equal(DEFAULT_PAGE_SIZE, 10);
  assert.deepEqual(PAGE_SIZE_OPTIONS, [10, 20]);
  assert.deepEqual(paginate(rows, 2), { items: rows.slice(10, 20), page: 2, pageSize: 10, totalPages: 3, totalItems: 21 });
  assert.deepEqual(paginate(rows, 2, 20).items, [20]);
  assert.equal(paginate(rows.slice(0, 8), 3).page, 1);
  assert.equal(paginate([], 99).page, 1);
});

test("配图记录首屏提供桌面语义表格、移动紧凑列表和可扫描状态操作", () => {
  const rows = Array.from({ length: 12 }, (_, index) => visual(index));
  rows[0] = visual(0, {
    generationState: { status: "failed", errorSummary: "服务暂时不可用" },
    candidates: [candidate({ approved: true }), candidate({ id: "candidate_old", currentCompatible: false })],
  });
  const html = renderToString(createElement(VideoImageReviewList, {
    visuals: rows,
    productionAllowed: true,
    busyAction: null,
    onGenerate: () => undefined,
    onUpload: () => undefined,
    onApprove: () => undefined,
  }));

  assert.match(html, /<table\b/u);
  assert.match(html, /<caption[^>]*>[^<]*配图/u);
  for (const heading of ["画面", "旁白摘要", "生成状态", "候选", "当前批准图", "修订状态", "操作"]) assert.match(html, new RegExp(`>${heading}<`, "u"));
  assert.match(html, /class="hidden[^"]*md:block/u);
  assert.match(html, /class="[^"]*md:hidden/u);
  assert.match(html, /旁白摘要 1/u);
  assert.match(html, /生成失败/u);
  assert.match(html, /服务暂时不可用/u);
  assert.match(html, /已批准/u);
  assert.match(html, /存在 (?:<!-- -->)?1(?:<!-- -->)? 个历史已失效候选/u);
  assert.match(html, /查看候选/u);
  assert.match(html, /alt="[^"]*画面 01[^"]*缩略图[^"]*"/u);
  assert.doesNotMatch(html, /旁白摘要 11/u);
});

test("大量配图仍只渲染上一页、页码摘要和下一页三个常数分页控件", () => {
  const html = renderToString(createElement(VideoImageReviewList, {
    visuals: Array.from({ length: 1_000 }, (_, index) => visual(index)),
    productionAllowed: true,
    busyAction: null,
    onGenerate: () => undefined,
    onUpload: () => undefined,
    onApprove: () => undefined,
  }));
  assert.equal(html.match(/>上一页</gu)?.length, 1);
  assert.equal(html.match(/>下一页</gu)?.length, 1);
  assert.match(html, /aria-current="page">1(?:<!-- -->)? \/ (?:<!-- -->)?100</u);
  assert.match(html, /aria-label="配图记录分页"/u);
});

test("候选详情保留完整上下文、显式计费确认且选择不等于批准", () => {
  const source = read("../src/projects/VisualImageReviewRow.tsx");
  for (const text of ["候选图片", "完整中文描述", "当前画面最终 Prompt", "当前画面负面 Prompt", "放大查看", "选择一个候选", "批准所选图片", "重新生成当前画面", "上传图片"]) assert.match(source, new RegExp(text, "u"));
  assert.match(source, /此操作会创建可能计费的持久图片任务/u);
  assert.match(source, /新候选不会自动批准/u);
  assert.match(source, /选择只保留在当前弹框[^\n]*批准所选图片/u);
  assert.match(source, /setSelectedId\(candidate\.id\)/u);
  assert.match(source, /onApprove\(selected\.id\)/u);
  assert.match(source, /onOpenAutoFocus/u);
  assert.match(source, /onCloseAutoFocus/u);
  assert.match(source, /放弃未提交的候选选择/u);
});

test("候选冻结身份展示自身 Prompt、文件哈希与上游请求且不冒充当前画面 Prompt", () => {
  const source = read("../src/projects/VisualImageReviewRow.tsx");
  assert.equal(candidate().providerRequestId, "provider_request_1");
  assert.match(source, /候选冻结 Prompt[\s\S]*?candidate\.prompt/u);
  assert.match(source, /候选冻结负面 Prompt[\s\S]*?candidate\.negativePrompt/u);
  assert.match(source, /文件哈希[\s\S]*?candidate\.fileHash/u);
  assert.match(source, /candidate\.providerRequestId \?[^\n]*上游请求[^\n]*candidate\.providerRequestId/u);
  assert.match(source, /当前画面最终 Prompt[\s\S]*?visual\.prompt/u);
  assert.match(source, /当前画面负面 Prompt[\s\S]*?visual\.negativePrompt/u);
});

test("两个隐藏上传入口保留原生语义、单层焦点代理、禁用与重复选文件清值", () => {
  for (const path of ["../src/projects/VisualImageReviewRow.tsx", "../src/production/assets/CandidatePanel.tsx"]) {
    const source = read(path);
    assert.match(source, /<label\b[^>]*focus-ring-proxy[\s\S]*?<input\b[^>]*className="sr-only"[^>]*type="file"/u, `${path} 应由可见 label 代理隐藏文件输入`);
    assert.match(source, /accept="image\/png,image\/jpeg,image\/webp"/u, `${path} 应限制图片 MIME`);
    assert.match(source, /<input\b[^>]*type="file"[^>]*disabled=/u, `${path} 应把禁用状态传给原生输入`);
    assert.match(source, /event\.currentTarget\.value = "";/u, `${path} 应清值以允许重复选择同一文件`);
    assert.doesNotMatch(source, /focus-within/u, `${path} 不应叠加父容器焦点框`);
  }
});
