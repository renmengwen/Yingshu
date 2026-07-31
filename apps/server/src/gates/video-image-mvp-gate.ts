import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createServer, type Server } from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildApp } from "../app.js";
import type { ChapterTextModelConfig } from "../chapter-event-analyzer.js";
import type { GenerateVideoPlan } from "../video-plan-service.js";

const HOST = "127.0.0.1";
const PORT = 3102;
const FIXTURE_PORT = 3103;
const BASE_URL = `http://${HOST}:${PORT}`;
const serve = process.argv.includes("--serve");
const startedAt = Date.now();

const textProvider: ChapterTextModelConfig = {
  baseUrl: "https://example.invalid/v1",
  apiKey: "fixture-only",
  model: "fixture-text",
  providerId: "fixture-text",
  protocol: "openai-response",
};
const imageProvider = {
  baseUrl: `http://${HOST}:${FIXTURE_PORT}/v1`,
  apiKey: "fixture-only",
  model: "fixture-image",
  providerId: "fixture-image",
};

const input = (topic: string) => ({
  inputMode: "topic",
  topic,
  body: "",
  referenceText: "只参考清楚、平实的表达方式",
  referenceRole: "style_only",
  targetDurationSeconds: 60,
  visualDensity: "standard",
  webEnabled: false,
  scriptInstructions: "避免机械重复",
  visualInstructions: "使用竖屏科普画面",
});

function scriptOutput(topic: string) {
  const count = topic.includes("取消") ? 3 : 2;
  return {
    title: topic,
    summary: "本地隔离图片阶段验收方案",
    narration: Array.from({ length: count }, (_, index) =>
      `第${index + 1}个段落用于验证图片候选生产、失败恢复与人工审核。这里补充足够的旁白内容，确保方案合同通过真实结构校验。`,
    ).join("\n\n"),
    paragraphs: Array.from({ length: count }, (_, index) => ({
      text: `第${index + 1}个段落用于验证图片候选生产、失败恢复与人工审核。这里补充足够的旁白内容，确保方案合同通过真实结构校验。`,
    })),
    sourceSummary: [],
    risks: [],
  };
}

function visualOutput(prompt: string) {
  const paragraphIds = [...new Set([...prompt.matchAll(/paragraph_[0-9a-f]{20}/gu)].map((match) => match[0]))];
  assert.ok(paragraphIds.length >= 2);
  const slow = prompt.includes("取消慢批次");
  return { visuals: paragraphIds.map((paragraphId, index) => ({
    paragraphId,
    purpose: `验证画面 ${index + 1}`,
    description: `第 ${index + 1} 个真实图片候选验收画面`,
    prompt: slow ? `fixture-slow-${index + 1}` : index === 0 ? "fixture-success" : "fixture-flaky",
    negativePrompt: "readable text, watermark",
    suggestedDurationSeconds: 20,
    weight: 1,
  })) };
}

const generator: GenerateVideoPlan = async ({ stage, prompt }) =>
  stage === "script" ? scriptOutput(prompt.includes("取消慢批次") ? "取消慢批次" : "图片成功失败重试") : visualOutput(prompt);

async function jsonRequest(path: string, init?: RequestInit, expectedStatus = 200) {
  const response = await fetch(`${BASE_URL}${path}`, {
    ...init,
    headers: init?.body && !(init.body instanceof Uint8Array)
      ? { "content-type": "application/json", ...init.headers }
      : init?.headers,
  });
  const body = await response.json();
  assert.equal(response.status, expectedStatus, `${init?.method ?? "GET"} ${path}: ${JSON.stringify(body)}`);
  return body as Record<string, any>;
}

async function createProjectAndVideo(projectName: string, videoTitle: string) {
  const project = (await jsonRequest("/api/projects", {
    method: "POST", body: JSON.stringify({ name: projectName }),
  }, 201)).project as { id: string };
  const video = (await jsonRequest(`/api/projects/${project.id}/videos`, {
    method: "POST", body: JSON.stringify({ title: videoTitle }),
  }, 201)).video as { id: string };
  return { project, video, base: `/api/projects/${project.id}/videos/${video.id}` };
}

async function waitForPlan(base: string) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const value = await jsonRequest(`${base}/plan-job`);
    if (value.job?.status === "succeeded") return value;
    if (value.job && ["failed", "cancelled"].includes(value.job.status)) {
      assert.fail(`方案 Job 异常结束：${JSON.stringify(value.job)}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.fail("等待方案 Job 超时");
}

async function prepareApprovedVideo(projectName: string, title: string, topic: string) {
  const value = await createProjectAndVideo(projectName, title);
  await jsonRequest(`${value.base}/input`, { method: "PUT", body: JSON.stringify(input(topic)) });
  await jsonRequest(`${value.base}/plan-jobs`, {
    method: "POST", body: JSON.stringify({ idempotencyKey: `plan-${videoKey(title)}` }),
  });
  await waitForPlan(value.base);
  const plan = (await jsonRequest(`${value.base}/plan`)).plan;
  await jsonRequest(`${value.base}/approve`, {
    method: "POST",
    body: JSON.stringify({
      snapshotId: plan.snapshotId,
      scriptRevisionId: plan.script.id,
      visualRevisionId: plan.visual.id,
    }),
  });
  return { ...value, plan };
}

function videoKey(value: string) {
  return Buffer.from(value).toString("base64url").slice(0, 32);
}

async function waitForBatch(base: string, batchId: string) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const batch = (await jsonRequest(`${base}/image-batches/current`)).batch;
    assert.equal(batch?.id, batchId);
    if (batch.complete) return batch;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.fail(`等待图片批次 ${batchId} 超时`);
}

async function waitForRunning(base: string, batchId: string) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const batch = (await jsonRequest(`${base}/image-batches/current`)).batch;
    if (batch?.id === batchId && batch.counts.running > 0) return batch;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.fail(`图片批次 ${batchId} 未进入 running`);
}

function createFixtureServer(pngBase64: string, calls: Map<string, number>) {
  return createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { prompt?: string };
    const prompt = body.prompt ?? "";
    calls.set(prompt, (calls.get(prompt) ?? 0) + 1);
    if (prompt === "fixture-flaky" && calls.get(prompt)! <= 2) {
      response.writeHead(503).end();
      return;
    }
    if (prompt.startsWith("fixture-slow")) await new Promise((resolve) => setTimeout(resolve, 2_000));
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ data: [{ b64_json: pngBase64, revised_prompt: prompt }] }));
  });
}

async function listen(server: Server, port: number) {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, HOST, resolve);
  });
}

async function close(server: Server | undefined) {
  if (!server) return;
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

const dataRoot = await mkdtemp(join(tmpdir(), "yingshu-video-image-mvp-gate-"));
const fixturePath = join(dataRoot, "fixture.png");
let app: ReturnType<typeof buildApp> | undefined;
let fixtureServer: Server | undefined;

try {
  const ffmpeg = spawnSync("ffmpeg", ["-loglevel", "error", "-f", "lavfi", "-i", "color=c=blue:s=64x96:d=0.04",
    "-frames:v", "1", "-y", fixturePath], { windowsHide: true });
  assert.equal(ffmpeg.status, 0, ffmpeg.stderr.toString());
  const fixtureBytes = await readFile(fixturePath);
  const fixtureCalls = new Map<string, number>();
  fixtureServer = createFixtureServer(fixtureBytes.toString("base64"), fixtureCalls);
  await listen(fixtureServer, FIXTURE_PORT);

  const build = (workerId: string) => buildApp({
    dataRoot,
    logger: false,
    chapterTextProvider: textProvider,
    videoPlanGenerator: generator,
    imageProvider,
    jobPollMs: 10,
    pipelinePollMs: 60_000,
    jobWorker: { workerId, retryDelayMs: 0 },
  });
  app = build("video-image-mvp-gate");
  await app.listen({ host: HOST, port: PORT });
  assert.equal((await jsonRequest("/api/health")).service, "yingshu");

  const unapproved = await createProjectAndVideo("未批准门禁项目", "未批准视频");
  await jsonRequest(`${unapproved.base}/input`, { method: "PUT", body: JSON.stringify(input("未批准图片门禁")) });
  const unapprovedPlanJob = await jsonRequest(`${unapproved.base}/plan-jobs`, {
    method: "POST", body: JSON.stringify({ idempotencyKey: "unapproved-plan" }),
  });
  assert.ok(unapprovedPlanJob.job);
  await waitForPlan(unapproved.base);
  const unapprovedPlan = (await jsonRequest(`${unapproved.base}/plan`)).plan;
  const unapprovedVisual = unapprovedPlan.visual.visuals[0].id as string;
  await jsonRequest(`${unapproved.base}/image-batches`, {
    method: "POST", body: JSON.stringify({ idempotencyKey: "blocked-batch" }),
  }, 409);
  await jsonRequest(`${unapproved.base}/visuals/${unapprovedVisual}/image-candidates/upload`, {
    method: "POST",
    headers: { "content-type": "application/octet-stream", "x-file-name": "fixture.png" },
    body: fixtureBytes as unknown as BodyInit,
  }, 409);
  await jsonRequest(`${unapproved.base}/visuals/${unapprovedVisual}/image-approval`, {
    method: "PUT", body: JSON.stringify({ candidateId: "missing", expectedGateRevision: 0 }),
  }, 409);

  const owner = await prepareApprovedVideo("图片候选验收项目", "图片候选视频", "图片成功失败重试");
  const outsider = await createProjectAndVideo("跨项目访问者", "其他视频");
  const foreignBase = `/api/projects/${outsider.project.id}/videos/${owner.video.id}`;
  await jsonRequest(`${foreignBase}/images/workspace`, undefined, 404);
  const before = (await jsonRequest(`${owner.base}/images/workspace`)).workspace;
  assert.equal(before.productionAllowed, true);
  assert.equal(before.summary.visualTotal, 2);
  assert.equal(before.summary.currentCandidateCount, 0);
  assert.equal(before.summary.missingCount, 2);
  assert.equal(before.summary.plannedPerVisual, 1);

  const firstResponse = await jsonRequest(`${owner.base}/image-batches`, {
    method: "POST", body: JSON.stringify({ idempotencyKey: "initial-missing", mode: "missing" }),
  }, 201);
  const duplicate = await jsonRequest(`${owner.base}/image-batches`, {
    method: "POST", body: JSON.stringify({ idempotencyKey: "initial-missing", mode: "missing" }),
  });
  assert.equal(duplicate.batch.id, firstResponse.batch.id);
  const firstBatch = await waitForBatch(owner.base, firstResponse.batch.id);
  assert.deepEqual(firstBatch.counts, { queued: 0, running: 0, succeeded: 1, failed: 1, cancelled: 0 });
  assert.equal(fixtureCalls.get("fixture-success"), 1);
  assert.equal(fixtureCalls.get("fixture-flaky"), 2);

  const retryResponse = await jsonRequest(`${owner.base}/image-batches`, {
    method: "POST", body: JSON.stringify({ idempotencyKey: "retry-failed", mode: "retry_failed" }),
  }, 201);
  const retryBatch = await waitForBatch(owner.base, retryResponse.batch.id);
  assert.deepEqual(retryBatch.counts, { queued: 0, running: 0, succeeded: 1, failed: 0, cancelled: 0 });
  assert.equal(fixtureCalls.get("fixture-success"), 1, "局部重试不得重复成功画面");
  assert.equal(fixtureCalls.get("fixture-flaky"), 3);

  const workspaceAfterRetry = (await jsonRequest(`${owner.base}/images/workspace`)).workspace;
  assert.equal(workspaceAfterRetry.summary.currentCandidateCount, 2);
  const firstVisual = workspaceAfterRetry.visuals[0];
  await jsonRequest(`${owner.base}/visuals/${firstVisual.id}/image-candidates/upload`, {
    method: "POST",
    headers: { "content-type": "application/octet-stream", "x-file-name": encodeURIComponent("本地蓝图.png") },
    body: fixtureBytes as unknown as BodyInit,
  }, 201);
  await jsonRequest(`${owner.base}/visuals/${firstVisual.id}/image-candidates/upload`, {
    method: "POST",
    headers: { "content-type": "application/octet-stream", "x-file-name": "fake.png" },
    body: Buffer.from("not-an-image") as unknown as BodyInit,
  }, 400);

  let review = (await jsonRequest(`${owner.base}/images/workspace`)).workspace;
  assert.equal(review.visuals[0].candidates.length, 2);
  assert.equal(review.visuals[0].candidates.some((candidate: any) => candidate.origin === "upload"), true);
  for (const visual of review.visuals) {
    const candidate = visual.candidates.find((item: any) => item.currentCompatible);
    assert.ok(candidate);
    await jsonRequest(`${owner.base}/visuals/${visual.id}/image-approval`, {
      method: "PUT",
      body: JSON.stringify({ candidateId: candidate.id, expectedGateRevision: review.gate.revision }),
    });
    review = (await jsonRequest(`${owner.base}/images/workspace`)).workspace;
  }
  assert.equal(review.gate.status, "complete");
  assert.equal(review.gate.approvedCount, 2);

  const refreshed = (await jsonRequest(`${owner.base}/images/workspace`)).workspace;
  assert.deepEqual(refreshed.visuals.map((visual: any) => visual.candidates.map((candidate: any) => candidate.id)),
    review.visuals.map((visual: any) => visual.candidates.map((candidate: any) => candidate.id)));

  const slow = await prepareApprovedVideo("取消验收项目", "取消慢批次视频", "取消慢批次");
  const slowCreated = await jsonRequest(`${slow.base}/image-batches`, {
    method: "POST", body: JSON.stringify({ idempotencyKey: "slow-cancel", mode: "missing" }),
  }, 201);
  await waitForRunning(slow.base, slowCreated.batch.id);
  await jsonRequest(`${slow.base}/image-batches/${slowCreated.batch.id}/cancel`, { method: "POST" });
  const cancelled = await waitForBatch(slow.base, slowCreated.batch.id);
  assert.deepEqual(cancelled.counts, { queued: 0, running: 0, succeeded: 0, failed: 0, cancelled: 3 });
  const callsAtCancel = [...fixtureCalls.values()].reduce((sum, value) => sum + value, 0);
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.equal([...fixtureCalls.values()].reduce((sum, value) => sum + value, 0), callsAtCancel,
    "取消后不得派发后续 visual");

  await app.close();
  app = undefined;
  app = build("video-image-mvp-gate-restarted");
  await app.listen({ host: HOST, port: PORT });
  const recovered = (await jsonRequest(`${owner.base}/images/workspace`)).workspace;
  assert.equal(recovered.gate.status, "complete");
  assert.equal(recovered.gate.approvedCount, 2);
  assert.equal((await jsonRequest(`${owner.base}/image-batches/current`)).batch.id, retryResponse.batch.id);

  const output = {
    ok: true,
    gate: "video-image-mvp-phase-c",
    mode: serve ? "serve" : "automatic",
    listen: `${HOST}:${PORT}`,
    fixture_listen: `${HOST}:${FIXTURE_PORT}`,
    projectId: owner.project.id,
    videoId: owner.video.id,
    dataRoot,
    no_approval_rejections: 3,
    cross_project_rejections: 1,
    initial_counts: firstBatch.counts,
    retry_counts: retryBatch.counts,
    cancellation_counts: cancelled.counts,
    generated_candidates: recovered.visuals.reduce((sum: number, visual: any) =>
      sum + visual.candidates.filter((candidate: any) => candidate.origin === "generation").length, 0),
    uploaded_candidates: recovered.visuals.reduce((sum: number, visual: any) =>
      sum + visual.candidates.filter((candidate: any) => candidate.origin === "upload").length, 0),
    gate_status: recovered.gate.status,
    gate_revision: recovered.gate.revision,
    approved_visuals: recovered.gate.approvedCount,
    idempotent_batch: duplicate.batch.id === firstResponse.batch.id,
    successful_visual_not_repeated: fixtureCalls.get("fixture-success") === 1,
    bad_upload_rejected: true,
    refresh_recovery: true,
    restart_recovery: true,
    external_provider_calls: 0,
    local_fixture_calls: Object.fromEntries(fixtureCalls),
    local_fixture_call_total: [...fixtureCalls.values()].reduce((sum, value) => sum + value, 0),
    elapsed_ms: Date.now() - startedAt,
  };
  process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
  if (serve) await new Promise<void>((resolve) => {
    process.once("SIGINT", resolve);
    process.once("SIGTERM", resolve);
  });
} finally {
  if (app) await app.close();
  await close(fixtureServer);
  assert.ok(dataRoot.startsWith(join(tmpdir(), "yingshu-video-image-mvp-gate-")));
  await rm(dataRoot, { recursive: true, force: true });
}
