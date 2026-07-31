import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { buildApp } from "./app.js";
import type { ChapterTextModelConfig } from "./chapter-event-analyzer.js";
import type { GenerateVideoPlan } from "./video-plan-service.js";

const textProvider: ChapterTextModelConfig = {
  baseUrl: "https://example.invalid/v1",
  apiKey: "fixture-secret-never-persist",
  model: "fixture-model",
  providerId: "fixture-provider",
  protocol: "openai-response",
};

const creativeInput = (webEnabled: boolean) => ({
  inputMode: "topic",
  topic: "为什么天空是蓝色的",
  body: "",
  referenceText: "只参考平实、清楚的表达方式",
  referenceRole: "style_only",
  targetDurationSeconds: 60,
  visualDensity: "standard",
  webEnabled,
  scriptInstructions: "避免机械重复",
  visualInstructions: "使用竖屏科普画面",
});

function generatedScript() {
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

function generatedVisuals(prompt: string) {
  const paragraphIds = [...new Set(
    [...prompt.matchAll(/paragraph_[0-9a-f]{20}/gu)].map((match) => match[0]),
  )];
  assert.equal(paragraphIds.length, 2);
  return {
    visuals: paragraphIds.map((paragraphId, index) => ({
      paragraphId,
      purpose: index === 0 ? "建立概念" : "解释机制",
      description: index === 0 ? "阳光进入地球大气层的剖面示意" : "蓝色光线向各方向散射的科普示意",
      prompt: index === 0
        ? "vertical scientific illustration, sunlight entering atmosphere"
        : "vertical scientific illustration, blue light scattering",
      negativePrompt: "readable text, watermark",
      suggestedDurationSeconds: 30,
      weight: 1,
    })),
  };
}

async function createProjectAndVideo(app: ReturnType<typeof buildApp>, projectName: string, videoTitle: string) {
  const projectResponse = await app.inject({ method: "POST", url: "/api/projects", payload: { name: projectName } });
  assert.equal(projectResponse.statusCode, 201);
  const project = projectResponse.json().project as { id: string };
  const videoResponse = await app.inject({
    method: "POST",
    url: `/api/projects/${project.id}/videos`,
    payload: { title: videoTitle },
  });
  assert.equal(videoResponse.statusCode, 201);
  return { project, video: videoResponse.json().video as { id: string } };
}

async function waitForPlanJob(app: ReturnType<typeof buildApp>, url: string) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const response = await app.inject({ method: "GET", url });
    assert.equal(response.statusCode, 200);
    const body = response.json() as { job: { status: string; errorMessage?: string } | null };
    if (body.job?.status === "succeeded") return body;
    if (body.job && ["failed", "cancelled"].includes(body.job.status)) {
      assert.fail(`方案任务意外结束：${body.job.status} ${body.job.errorMessage ?? ""}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.fail("等待方案任务完成超时");
}

test("buildApp 完成关闭联网的方案生成、幂等、跨项目保护与人工审核闭环", async () => {
  const dataRoot = await mkdtemp(join(tmpdir(), "yingshu-video-plan-routes-"));
  let generatorCalls = 0;
  const generator: GenerateVideoPlan = async ({ stage, prompt }) => {
    generatorCalls += 1;
    return stage === "script" ? generatedScript() : generatedVisuals(prompt);
  };
  const app = buildApp({
    dataRoot,
    logger: false,
    chapterTextProvider: textProvider,
    videoPlanGenerator: generator,
    jobPollMs: 50,
    pipelinePollMs: 60_000,
    jobWorker: { workerId: "video-plan-route-test", retryDelayMs: 0 },
  });
  try {
    const owner = await createProjectAndVideo(app, "方案项目", "天空科普");
    const outsider = await createProjectAndVideo(app, "其他项目", "其他视频");
    const baseUrl = `/api/projects/${owner.project.id}/videos/${owner.video.id}`;
    const foreignUrl = `/api/projects/${outsider.project.id}/videos/${owner.video.id}`;

    const saved = await app.inject({ method: "PUT", url: `${baseUrl}/input`, payload: creativeInput(false) });
    assert.equal(saved.statusCode, 200);

    const first = await app.inject({
      method: "POST",
      url: `${baseUrl}/plan-jobs`,
      payload: { idempotencyKey: "same-plan-request" },
    });
    const repeated = await app.inject({
      method: "POST",
      url: `${baseUrl}/plan-jobs`,
      payload: { idempotencyKey: "same-plan-request" },
    });
    assert.equal(first.statusCode, 200);
    assert.equal(repeated.statusCode, 200);
    assert.equal(repeated.json().job.id, first.json().job.id);
    assert.equal(repeated.json().message, "已返回同一次方案任务");

    assert.equal((await app.inject({ method: "GET", url: `${foreignUrl}/plan` })).statusCode, 404);
    assert.equal((await app.inject({ method: "POST", url: `${foreignUrl}/plan-job/cancel` })).statusCode, 404);

    const completed = await waitForPlanJob(app, `${baseUrl}/plan-job`);
    assert.equal(completed.job?.status, "succeeded");
    assert.equal((completed as { videoStatus?: string }).videoStatus, "awaiting_review");
    assert.equal(generatorCalls, 2);

    const planResponse = await app.inject({ method: "GET", url: `${baseUrl}/plan` });
    assert.equal(planResponse.statusCode, 200);
    const initial = planResponse.json().plan;
    assert.equal(initial.script.revision, 1);
    assert.equal(initial.visual.revision, 1);
    assert.ok(initial.visual.visuals.every((visual: Record<string, unknown>) =>
      visual.generationStatus === "not_generated" && visual.currentCandidate === null));

    const sources = await app.inject({ method: "GET", url: `${baseUrl}/sources` });
    assert.equal(sources.statusCode, 200);
    assert.deepEqual(sources.json(), { ok: true, webEnabled: false, items: [] });
    assert.equal(JSON.stringify(initial).includes("imageCandidate"), false);
    assert.equal(JSON.stringify(initial).includes("tts"), false);

    const scriptSaved = await app.inject({
      method: "POST",
      url: `${baseUrl}/script-revisions`,
      payload: {
        snapshotId: initial.snapshotId,
        baseRevision: initial.script.revision,
        title: initial.script.title,
        summary: initial.script.summary,
        paragraphs: initial.script.paragraphs.map((paragraph: { id: string; text: string }, index: number) => ({
          ...paragraph,
          text: index === 0 ? `${paragraph.text}这是人工补充。` : paragraph.text,
        })),
      },
    });
    assert.equal(scriptSaved.statusCode, 200);
    const editedScriptPlan = scriptSaved.json().plan;
    assert.equal(editedScriptPlan.script.revision, 2);

    const visualSaved = await app.inject({
      method: "POST",
      url: `${baseUrl}/visual-revisions`,
      payload: {
        snapshotId: initial.snapshotId,
        baseRevision: initial.visual.revision,
        scriptRevisionId: editedScriptPlan.script.id,
        visuals: initial.visual.visuals.map((visual: Record<string, unknown>) => ({
          ...visual,
          description: `${visual.description as string}，保持简洁`,
        })),
      },
    });
    assert.equal(visualSaved.statusCode, 200);
    const editedPlan = visualSaved.json().plan;
    assert.equal(editedPlan.visual.revision, 2);

    const approved = await app.inject({
      method: "POST",
      url: `${baseUrl}/approve`,
      payload: {
        snapshotId: initial.snapshotId,
        scriptRevisionId: editedPlan.script.id,
        visualRevisionId: editedPlan.visual.id,
      },
    });
    assert.equal(approved.statusCode, 200);
    assert.equal(approved.json().plan.approval.valid, true);
  } finally {
    await app.close();
    await rm(dataRoot, { recursive: true, force: true });
  }
});

test("buildApp 在联网能力不受支持时返回 409 且不创建方案 Job", async () => {
  const dataRoot = await mkdtemp(join(tmpdir(), "yingshu-video-plan-web-blocked-"));
  let generatorCalls = 0;
  const app = buildApp({
    dataRoot,
    logger: false,
    chapterTextProvider: textProvider,
    videoPlanGenerator: async () => { generatorCalls += 1; return {}; },
    jobPollMs: 50,
    pipelinePollMs: 60_000,
  });
  try {
    const value = await createProjectAndVideo(app, "联网边界", "联网视频");
    const baseUrl = `/api/projects/${value.project.id}/videos/${value.video.id}`;
    assert.equal((await app.inject({
      method: "PUT", url: `${baseUrl}/input`, payload: creativeInput(true),
    })).statusCode, 200);
    const before = (await app.inject({ method: "GET", url: `${baseUrl}/plan-job` })).json();
    assert.equal(before.job, null);

    const blocked = await app.inject({
      method: "POST", url: `${baseUrl}/plan-jobs`, payload: { idempotencyKey: "web-plan-request" },
    });
    assert.equal(blocked.statusCode, 409);
    assert.match(blocked.json().message, /联网|关闭/u);
    const after = (await app.inject({ method: "GET", url: `${baseUrl}/plan-job` })).json();
    assert.equal(after.job, null);
    assert.equal(generatorCalls, 0);
  } finally {
    await app.close();
    await rm(dataRoot, { recursive: true, force: true });
  }
});
