import assert from "node:assert/strict";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildApp } from "../app.js";
import type { ChapterTextModelConfig } from "../chapter-event-analyzer.js";
import type { GenerateVideoPlan } from "../video-plan-service.js";

const HOST = "127.0.0.1";
const PORT = 3102;
const BASE_URL = `http://${HOST}:${PORT}`;
const startedAt = Date.now();
const serve = process.argv.includes("--serve");

const provider: ChapterTextModelConfig = {
  baseUrl: "https://example.invalid/v1",
  apiKey: "fixture-secret-never-persist",
  model: "fixture-model",
  providerId: "fixture-provider",
  protocol: "openai-response",
};

const input = (webEnabled: boolean, topic = "为什么天空是蓝色的") => ({
  inputMode: "topic",
  topic,
  body: "",
  referenceText: "只参考清楚、平实的表达方式",
  referenceRole: "style_only",
  targetDurationSeconds: 60,
  visualDensity: "standard",
  webEnabled,
  scriptInstructions: "避免机械重复",
  visualInstructions: "使用竖屏科普画面",
});

function scriptOutput() {
  const first = "天空呈现蓝色，核心原因是阳光进入大气层后，不同颜色的光会发生程度不同的散射。";
  const second = "蓝光波长较短，更容易被空气分子散向各个方向，因此我们从地面望去，会接收到更多蓝色散射光。太阳接近地平线时，光线穿过的大气路径更长，蓝光大量散开，留下的红橙色光更显眼，这也解释了日出日落常见的暖色。";
  return {
    title: "天空为什么是蓝色",
    summary: "用光的散射解释日常天空颜色。",
    narration: `${first}\n\n${second}`,
    paragraphs: [{ text: first }, { text: second }],
    sourceSummary: [],
    risks: ["这是面向大众的简化解释"],
  };
}

function visualOutput(prompt: string) {
  const paragraphIds = [...new Set(
    [...prompt.matchAll(/paragraph_[0-9a-f]{20}/gu)].map((match) => match[0]),
  )];
  assert.equal(paragraphIds.length, 2);
  return { visuals: paragraphIds.map((paragraphId, index) => ({
    paragraphId,
    purpose: index === 0 ? "建立概念" : "解释机制",
    description: index === 0 ? "阳光进入地球大气层的剖面示意" : "蓝色光线向各方向散射的科普示意",
    prompt: index === 0
      ? "vertical scientific illustration, sunlight entering atmosphere"
      : "vertical scientific illustration, blue light scattering",
    negativePrompt: "readable text, watermark",
    suggestedDurationSeconds: 30,
    weight: 1,
  })) };
}

async function jsonRequest(path: string, init?: RequestInit, expectedStatus = 200) {
  const response = await fetch(`${BASE_URL}${path}`, {
    ...init,
    headers: init?.body ? { "content-type": "application/json", ...init.headers } : init?.headers,
  });
  const body = await response.json();
  assert.equal(response.status, expectedStatus, `${init?.method ?? "GET"} ${path}: ${JSON.stringify(body)}`);
  return body;
}

async function createProjectAndVideo(projectName: string, videoTitle: string) {
  const project = (await jsonRequest("/api/projects", {
    method: "POST", body: JSON.stringify({ name: projectName }),
  }, 201)).project as { id: string };
  const video = (await jsonRequest(`/api/projects/${project.id}/videos`, {
    method: "POST", body: JSON.stringify({ title: videoTitle }),
  }, 201)).video as { id: string };
  return { project, video };
}

async function waitForStatus(path: string, expected: "running" | "succeeded" | "cancelled") {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const body = await jsonRequest(path) as { job: { status: string; errorMessage?: string } | null; videoStatus?: string };
    if (body.job?.status === expected) return body;
    if (body.job && ["failed", "cancelled", "succeeded"].includes(body.job.status)) {
      assert.fail(`Job 在等待 ${expected} 时结束为 ${body.job.status}：${body.job.errorMessage ?? ""}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.fail(`等待 Job 状态 ${expected} 超时`);
}

async function slowUntilCancelled(signal: AbortSignal) {
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, 10_000);
    const cancel = () => { clearTimeout(timer); reject(new Error("fixture 已取消")); };
    if (signal.aborted) cancel();
    else signal.addEventListener("abort", cancel, { once: true });
  });
  return scriptOutput();
}

const dataRoot = await mkdtemp(join(tmpdir(), "yingshu-video-plan-mvp-gate-"));
let app: ReturnType<typeof buildApp> | undefined;
let generatorCalls = 0;
const generator: GenerateVideoPlan = async ({ stage, prompt, signal }) => {
  generatorCalls += 1;
  if (prompt.includes("慢速取消测试")) return slowUntilCancelled(signal);
  return stage === "script" ? scriptOutput() : visualOutput(prompt);
};

try {
  app = buildApp({
    dataRoot,
    logger: false,
    chapterTextProvider: provider,
    videoPlanGenerator: generator,
    jobPollMs: 500,
    pipelinePollMs: 60_000,
    jobWorker: { workerId: "video-plan-mvp-gate", retryDelayMs: 0 },
  });
  await app.listen({ host: HOST, port: PORT });
  gate: {
  assert.equal((await jsonRequest("/api/health")).service, "yingshu");

  const owner = await createProjectAndVideo("阶段验收项目", "天空科普");
  const outsider = await createProjectAndVideo("其他项目", "其他视频");
  const ownerBase = `/api/projects/${owner.project.id}/videos/${owner.video.id}`;
  const foreignBase = `/api/projects/${outsider.project.id}/videos/${owner.video.id}`;

  await jsonRequest(`${ownerBase}/input`, {
    method: "PUT", body: JSON.stringify(input(true)),
  });
  assert.equal((await jsonRequest(`${ownerBase}/plan-job`)).job, null);
  const callsBeforeWebBlock = generatorCalls;
  const webBlocked = await jsonRequest(`${ownerBase}/plan-jobs`, {
    method: "POST", body: JSON.stringify({ idempotencyKey: "web-enabled" }),
  }, 409);
  assert.match(webBlocked.message, /联网|关闭/u);
  assert.equal((await jsonRequest(`${ownerBase}/plan-job`)).job, null);
  assert.equal(generatorCalls, callsBeforeWebBlock);

  await jsonRequest(`${ownerBase}/input`, {
    method: "PUT", body: JSON.stringify(input(false)),
  });
  const firstJob = (await jsonRequest(`${ownerBase}/plan-jobs`, {
    method: "POST", body: JSON.stringify({ idempotencyKey: "main-plan" }),
  })).job;
  const repeatedJob = (await jsonRequest(`${ownerBase}/plan-jobs`, {
    method: "POST", body: JSON.stringify({ idempotencyKey: "main-plan" }),
  })).job;
  assert.equal(repeatedJob.id, firstJob.id);
  await jsonRequest(`${ownerBase}/plan-jobs`, {
    method: "POST", body: JSON.stringify({ idempotencyKey: "second-active-plan" }),
  }, 409);
  await jsonRequest(`${foreignBase}/plan`, undefined, 404);
  await jsonRequest(`${foreignBase}/plan-job/cancel`, { method: "POST" }, 404);

  const completed = await waitForStatus(`${ownerBase}/plan-job`, "succeeded");
  assert.equal(completed.videoStatus, "awaiting_review");
  assert.equal(generatorCalls, 2);
  const initial = (await jsonRequest(`${ownerBase}/plan`)).plan;
  assert.equal(initial.script.revision, 1);
  assert.equal(initial.visual.revision, 1);
  assert.ok(initial.visual.visuals.every((visual: Record<string, unknown>) =>
    visual.generationStatus === "not_generated" && visual.currentCandidate === null));
  assert.deepEqual(await jsonRequest(`${ownerBase}/sources`), { ok: true, webEnabled: false, items: [] });

  const scriptPlan = (await jsonRequest(`${ownerBase}/script-revisions`, {
    method: "POST",
    body: JSON.stringify({
      snapshotId: initial.snapshotId,
      baseRevision: initial.script.revision,
      title: initial.script.title,
      summary: initial.script.summary,
      paragraphs: initial.script.paragraphs.map((paragraph: { id: string; text: string }, index: number) => ({
        ...paragraph,
        text: index === 0 ? `${paragraph.text}这是人工补充。` : paragraph.text,
      })),
    }),
  })).plan;
  assert.equal(scriptPlan.script.revision, 2);
  const visualPlan = (await jsonRequest(`${ownerBase}/visual-revisions`, {
    method: "POST",
    body: JSON.stringify({
      snapshotId: initial.snapshotId,
      baseRevision: initial.visual.revision,
      scriptRevisionId: scriptPlan.script.id,
      visuals: initial.visual.visuals.map((visual: Record<string, unknown>) => ({
        ...visual,
        description: `${visual.description as string}，保持简洁`,
      })),
    }),
  })).plan;
  assert.equal(visualPlan.visual.revision, 2);
  const approvedPlan = (await jsonRequest(`${ownerBase}/approve`, {
    method: "POST",
    body: JSON.stringify({
      snapshotId: initial.snapshotId,
      scriptRevisionId: visualPlan.script.id,
      visualRevisionId: visualPlan.visual.id,
    }),
  })).plan;
  assert.equal(approvedPlan.approval.valid, true);

  if (serve) {
    process.stdout.write(`${JSON.stringify({
      ok: true,
      mode: "serve",
      listen: `${HOST}:${PORT}`,
      projectId: owner.project.id,
      videoId: owner.video.id,
      dataRoot,
      planStatus: "awaiting_review",
      approvalValid: approvedPlan.approval.valid,
      externalProviderCalls: 0,
    }, null, 2)}\n`);
    await new Promise<void>((resolve) => {
      process.once("SIGINT", resolve);
      process.once("SIGTERM", resolve);
    });
    break gate;
  }

  const slow = await createProjectAndVideo("取消验收项目", "慢任务");
  const slowBase = `/api/projects/${slow.project.id}/videos/${slow.video.id}`;
  await jsonRequest(`${slowBase}/input`, {
    method: "PUT", body: JSON.stringify(input(false, "慢速取消测试")),
  });
  await jsonRequest(`${slowBase}/plan-jobs`, {
    method: "POST", body: JSON.stringify({ idempotencyKey: "cancel-plan" }),
  });
  await waitForStatus(`${slowBase}/plan-job`, "running");
  await jsonRequest(`${slowBase}/plan-job/cancel`, { method: "POST" });
  await waitForStatus(`${slowBase}/plan-job`, "cancelled");

  const files = await readdir(dataRoot, { recursive: true });
  assert.equal(files.some((file) => /\.(?:mp4|mp3|wav|png|jpe?g|webp)$/iu.test(file)), false,
    "本阶段不得生成图片、TTS 或 MP4 文件");

  await app.close();
  app = undefined;
  app = buildApp({
    dataRoot,
    logger: false,
    chapterTextProvider: provider,
    videoPlanGenerator: generator,
    jobPollMs: 500,
    pipelinePollMs: 60_000,
    jobWorker: { workerId: "video-plan-mvp-gate-restarted", retryDelayMs: 0 },
  });
  await app.listen({ host: HOST, port: PORT });
  const recoveredJob = await jsonRequest(`${ownerBase}/plan-job`);
  const recoveredPlan = (await jsonRequest(`${ownerBase}/plan`)).plan;
  const recoveredSources = await jsonRequest(`${ownerBase}/sources`);
  assert.equal(recoveredJob.job.id, firstJob.id);
  assert.equal(recoveredJob.job.status, "succeeded");
  assert.equal(recoveredJob.videoStatus, "awaiting_review");
  assert.equal(recoveredPlan.script.revision, 2);
  assert.equal(recoveredPlan.visual.revision, 2);
  assert.equal(recoveredPlan.approval.valid, true);
  assert.deepEqual(recoveredSources, { ok: true, webEnabled: false, items: [] });

  process.stdout.write(`${JSON.stringify({
    ok: true,
    gate: "video-plan-mvp-phase-b",
    listen: `${HOST}:${PORT}`,
    health: true,
    web_capability_blocked: true,
    web_block_generator_calls: 0,
    idempotent_job_id: firstJob.id,
    unique_active_job: true,
    completed_status: recoveredJob.job.status,
    video_status: recoveredJob.videoStatus,
    sources: recoveredSources.items.length,
    script_revision: recoveredPlan.script.revision,
    visual_revision: recoveredPlan.visual.revision,
    approval_valid: recoveredPlan.approval.valid,
    cross_project_rejections: 2,
    cancelled_job_recovered: (await jsonRequest(`${slowBase}/plan-job`)).job.status === "cancelled",
    generated_media_files: 0,
    restart_recovery: true,
    external_provider_calls: 0,
    elapsed_ms: Date.now() - startedAt,
  }, null, 2)}\n`);
  }
} finally {
  if (app) await app.close();
  await rm(dataRoot, { recursive: true, force: true });
}
