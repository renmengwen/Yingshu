import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createReadStream } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { putGlobalPromptSettings, putProjectSettings, putVideoInput } from "./creative-input-store.js";
import { openDatabase } from "./database.js";
import { JobWorker } from "./job-worker.js";
import { getJob } from "./job-store.js";
import { createProject, createVideo, deleteProject } from "./project-video-store.js";
import { approveVideoPlan, createVideoPlanJobHandler, enqueueVideoPlanJob, getVideoPlan, VIDEO_PLAN_JOB_TYPE } from "./video-plan-service.js";
import { saveVideoVisualRevision } from "./video-plan-store.js";
import { createVideoImageJobHandler } from "./video-image-job.js";
import { VIDEO_IMAGE_JOB_TYPE } from "./video-image-contract.js";
import { approveVideoImageCandidate, cleanupUnreferencedVideoImageFiles, enqueueVideoImageBatch, getVideoImageWorkspace, uploadVideoImageCandidate } from "./video-image-store.js";

const textConfig = { baseUrl: "https://example.invalid/v1", apiKey: "secret", model: "text-fixture", providerId: "fixture" };
const imageConfig = { baseUrl: "https://example.invalid/v1", apiKey: "secret", model: "image-fixture", providerId: "fixture" };

async function approvedFixture(visualCount = 1) {
  const dataRoot = await mkdtemp(join(tmpdir(), "yingshu-video-images-"));
  const connection = openDatabase(dataRoot);
  const project = createProject(connection.database, { name: "图片测试" }, 10);
  const video = createVideo(connection.database, project.id, { title: "配图" }, 20);
  putGlobalPromptSettings(connection.database, { scriptInstructions: "简洁", visualInstructions: "竖屏" }, 30);
  putProjectSettings(connection.database, project.id, { scriptInstructions: "科普", visualInstructions: "插画" }, 40);
  putVideoInput(connection.database, project.id, video.id, { inputMode: "topic", topic: "蓝天", body: "", referenceText: "平实科普",
    referenceRole: "style_only", targetDurationSeconds: 60, visualDensity: "standard", webEnabled: false,
    scriptInstructions: "", visualInstructions: "" }, 50);
  const queued = enqueueVideoPlanJob(connection.database, { projectId: project.id, videoId: video.id,
    idempotencyKey: "plan", config: textConfig, now: 60 });
  const narration = "阳光进入大气层后，蓝光更容易被空气分子散射到各个方向，因此从地面望去会接收到来自天空各处的蓝色散射光。".repeat(4);
  const handler = createVideoPlanJobHandler(connection.database, textConfig, async ({ stage, prompt }) => stage === "script"
    ? { title: "蓝天", summary: "散射", narration,
      paragraphs: [{ text: narration }], sourceSummary: [], risks: [] }
    : { visuals: Array.from({ length: visualCount }, (_, index) => ({
      paragraphId: prompt.match(/paragraph_[0-9a-f]{20}/u)![0], purpose: "解释散射",
      description: `蓝色光线在大气层中散射 ${index + 1}`, prompt: `vertical scientific illustration of blue light scattering ${index + 1}`,
      negativePrompt: "watermark, text", suggestedDurationSeconds: 30, weight: 1,
    })) });
  const worker = new JobWorker(connection.database, { [VIDEO_PLAN_JOB_TYPE]: handler }, { workerId: "plan", leaseMs: 5000, heartbeatMs: 100 });
  await worker.runOne();
  assert.equal(getJob(connection.database, queued.job.id)?.status, "succeeded", getJob(connection.database, queued.job.id)?.errorMessage ?? "");
  const plan = getVideoPlan(connection.database, project.id, video.id)!;
  approveVideoPlan(connection.database, project.id, video.id, { snapshotId: plan.snapshotId,
    scriptRevisionId: plan.script.id, visualRevisionId: plan.visual.id }, 70);
  assert.equal(queued.job.id.length > 0, true);
  return { dataRoot, connection, project, video, visualId: plan.visual.visuals[0]!.id,
    visualIds: plan.visual.visuals.map((visual) => visual.id) };
}

function png(path: string) {
  const result = spawnSync("ffmpeg", ["-loglevel", "error", "-f", "lavfi", "-i", "color=c=blue:s=32x24:d=0.04",
    "-frames:v", "1", "-y", path], { windowsHide: true });
  assert.equal(result.status, 0, result.stderr.toString());
}

test("Video 图片批次复用现有 Job 与真实媒体校验，并以 CAS 完成人工 gate", async () => {
  const value = await approvedFixture();
  const fixturePath = join(value.dataRoot, "fixture.png");
  png(fixturePath);
  try {
    const input = { projectId: value.project.id, videoId: value.video.id, visualId: value.visualId,
      mode: "single" as const, idempotencyKey: "single-1", providerId: imageConfig.providerId, model: imageConfig.model };
    const queued = enqueueVideoImageBatch(value.connection.database, input);
    assert.equal(queued.created, true);
    assert.equal(enqueueVideoImageBatch(value.connection.database, input).created, false);
    let calls = 0;
    const handler = createVideoImageJobHandler(value.connection.database, value.dataRoot, async () => imageConfig, {
      generate: async (input) => {
        assert.equal(input.negativePrompt, "watermark, text");
        calls += 1;
        return { bytes: await readFile(fixturePath) };
      },
    });
    const worker = new JobWorker(value.connection.database, { [VIDEO_IMAGE_JOB_TYPE]: handler },
      { workerId: "images", leaseMs: 5000, heartbeatMs: 100 });
    await worker.runOne();
    const imageJobId = queued.batch!.items[0]!.jobId as string;
    assert.equal(getJob(value.connection.database, imageJobId)?.status, "succeeded",
      getJob(value.connection.database, imageJobId)?.errorMessage ?? "");
    assert.equal(calls, 1);
    let workspace = getVideoImageWorkspace(value.connection.database, value.project.id, value.video.id);
    assert.equal(workspace.candidates.length, 1);
    assert.equal(workspace.candidates[0]!.mime, "image/png");
    assert.equal(workspace.gateComplete, false);
    workspace = approveVideoImageCandidate(value.connection.database, value.dataRoot, { projectId: value.project.id,
      videoId: value.video.id, visualId: value.visualId, candidateId: workspace.candidates[0]!.id,
      expectedGateRevision: 0 });
    assert.equal(workspace.gateComplete, true);
    assert.throws(() => approveVideoImageCandidate(value.connection.database, value.dataRoot, { projectId: value.project.id,
      videoId: value.video.id, visualId: value.visualId, candidateId: workspace.candidates[0]!.id,
      expectedGateRevision: 0 }), /图片审核已更新/u);

    const uploaded = await uploadVideoImageCandidate(value.connection.database, value.dataRoot, { projectId: value.project.id,
      videoId: value.video.id, visualId: value.visualId, originalFileName: "本地.png", raw: createReadStream(fixturePath) });
    assert.equal(uploaded.origin, "upload");
    assert.equal(uploaded.providerId, null);
    assert.equal(uploaded.fileHash, workspace.candidates[0]!.fileHash);
    const relativePath = uploaded.relativePath!;
    await rm(join(value.dataRoot, ...relativePath.split("/")));
    assert.throws(() => approveVideoImageCandidate(value.connection.database, value.dataRoot, {
      projectId: value.project.id, videoId: value.video.id, visualId: value.visualId,
      candidateId: workspace.candidates[0]!.id, expectedGateRevision: 1,
    }), /丢失或损坏/u);
    deleteProject(value.connection.database, value.project.id);
    await cleanupUnreferencedVideoImageFiles(value.connection.database, value.dataRoot, [{ relativePath, fileHash: uploaded.fileHash! }]);
    await assert.rejects(readFile(join(value.dataRoot, ...relativePath.split("/"))), /ENOENT/u);
  } finally {
    value.connection.close();
    await rm(value.dataRoot, { recursive: true, force: true });
  }
});

test("上游输入失效会取消尚未执行的图片 Job", async () => {
  const value = await approvedFixture();
  try {
    const queued = enqueueVideoImageBatch(value.connection.database, {
      projectId: value.project.id, videoId: value.video.id, visualId: value.visualId,
      mode: "single", idempotencyKey: "cancel-on-stale", providerId: imageConfig.providerId, model: imageConfig.model,
    });
    const jobId = queued.batch!.items[0]!.jobId as string;
    putVideoInput(value.connection.database, value.project.id, value.video.id, {
      inputMode: "topic", topic: "蓝天为什么会变化", body: "", referenceText: "平实科普",
      referenceRole: "style_only", targetDurationSeconds: 60, visualDensity: "standard", webEnabled: false,
      scriptInstructions: "", visualInstructions: "",
    }, 80);
    assert.equal(getJob(value.connection.database, jobId)?.status, "cancelled");
    assert.equal(value.connection.database.prepare(
      "SELECT status FROM video_image_batch_items WHERE job_id = ?",
    ).get(jobId)?.status, "cancelled");
  } finally {
    value.connection.close();
    await rm(value.dataRoot, { recursive: true, force: true });
  }
});

test("只修改单个画面后，其他画面的候选与批准仍保持当前", async () => {
  const value = await approvedFixture(4);
  const fixturePath = join(value.dataRoot, "fixture.png");
  png(fixturePath);
  try {
    const queued = enqueueVideoImageBatch(value.connection.database, {
      projectId: value.project.id, videoId: value.video.id, mode: "missing", idempotencyKey: "all-4",
      providerId: imageConfig.providerId, model: imageConfig.model,
    });
    const handler = createVideoImageJobHandler(value.connection.database, value.dataRoot, async () => imageConfig, {
      generate: async () => ({ bytes: await readFile(fixturePath) }),
    });
    const worker = new JobWorker(value.connection.database, { [VIDEO_IMAGE_JOB_TYPE]: handler },
      { workerId: "images-4", leaseMs: 5000, heartbeatMs: 100 });
    for (const _ of queued.batch!.items) await worker.runOne();
    let workspace = getVideoImageWorkspace(value.connection.database, value.project.id, value.video.id);
    assert.equal(workspace.candidates.filter((item) => item.currentCompatible).length, 4);
    const firstCandidate = workspace.candidates.find((item) => item.visualId === value.visualIds[0])!;
    workspace = approveVideoImageCandidate(value.connection.database, value.dataRoot, {
      projectId: value.project.id, videoId: value.video.id, visualId: value.visualIds[0]!, candidateId: firstCandidate.id,
      expectedGateRevision: workspace.gateRevision,
    });

    const plan = getVideoPlan(value.connection.database, value.project.id, value.video.id)!;
    saveVideoVisualRevision(value.connection.database, value.project.id, value.video.id, {
      snapshotId: plan.snapshotId, baseRevision: plan.visual.revision, scriptRevisionId: plan.script.id,
      visuals: plan.visual.visuals.map((visual) => visual.id === value.visualIds[3]
        ? { ...visual, prompt: `${visual.prompt} revised` } : visual),
    }, 80);
    const revised = getVideoPlan(value.connection.database, value.project.id, value.video.id)!;
    approveVideoPlan(value.connection.database, value.project.id, value.video.id, {
      snapshotId: revised.snapshotId, scriptRevisionId: revised.script.id, visualRevisionId: revised.visual.id,
    }, 90);

    workspace = getVideoImageWorkspace(value.connection.database, value.project.id, value.video.id);
    assert.equal(workspace.candidates.filter((item) => item.currentCompatible).length, 3);
    assert.equal(workspace.candidates.find((item) => item.visualId === value.visualIds[3])!.currentCompatible, false);
    assert.equal(workspace.approvals.find((item) => item.visualId === value.visualIds[0])?.candidateId, firstCandidate.id);
    const missing = enqueueVideoImageBatch(value.connection.database, {
      projectId: value.project.id, videoId: value.video.id, mode: "missing", idempotencyKey: "only-4",
      providerId: imageConfig.providerId, model: imageConfig.model,
    });
    assert.equal(missing.batch?.plannedCount, 1);
    assert.deepEqual(missing.batch?.items.map((item) => item.visualId), [value.visualIds[3]]);
  } finally {
    value.connection.close();
    await rm(value.dataRoot, { recursive: true, force: true });
  }
});
