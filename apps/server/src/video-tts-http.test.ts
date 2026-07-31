import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { buildApp } from "./app.js";
import { putGlobalPromptSettings, putProjectSettings, putVideoInput } from "./creative-input-store.js";
import { openDatabase } from "./database.js";
import { JobWorker } from "./job-worker.js";
import { getJob } from "./job-store.js";
import { defaultModelConfig, resolveRuntimeModelConfig } from "./model-config.js";
import { createProject, createVideo } from "./project-video-store.js";
import {
  approveVideoPlan, createVideoPlanJobHandler, enqueueVideoPlanJob, getVideoPlan, VIDEO_PLAN_JOB_TYPE,
} from "./video-plan-service.js";
import { createVideoTtsPcmFixture, resolveVideoTtsProviderIdentity } from "./video-tts-provider.js";

async function seed(dataRoot: string) {
  const connection = openDatabase(dataRoot);
  const project = createProject(connection.database, { name: "HTTP 配音验收" }, 10);
  const video = createVideo(connection.database, project.id, { title: "蓝天为什么是蓝色" }, 20);
  putGlobalPromptSettings(connection.database, { scriptInstructions: "简洁", visualInstructions: "科普插画" }, 30);
  putProjectSettings(connection.database, project.id, { scriptInstructions: "准确", visualInstructions: "竖屏" }, 40);
  putVideoInput(connection.database, project.id, video.id, { inputMode: "topic", topic: "蓝天", body: "", referenceText: "",
    referenceRole: "style_only", targetDurationSeconds: 60, visualDensity: "standard", webEnabled: false,
    scriptInstructions: "", visualInstructions: "" }, 50);
  const model = { baseUrl: "https://example.invalid", apiKey: "fixture", model: "fixture", providerId: "fixture" };
  const queued = enqueueVideoPlanJob(connection.database, { projectId: project.id, videoId: video.id, idempotencyKey: "http-plan",
    config: model, now: 60 });
  const narration = "阳光进入大气后，波长较短的蓝光更容易被空气分子散射，因此晴朗天空通常呈现蓝色。".repeat(7);
  const handler = createVideoPlanJobHandler(connection.database, model, async ({ stage, prompt }) => stage === "script"
    ? { title: video.title, summary: "解释散射", narration, paragraphs: [{ text: narration }], sourceSummary: [], risks: [] }
    : { visuals: [{ paragraphId: prompt.match(/paragraph_[0-9a-f]{20}/u)![0], purpose: "解释", description: "蓝光散射",
      prompt: "blue sky scattering", negativePrompt: "text", suggestedDurationSeconds: 60, weight: 1 }] });
  await new JobWorker(connection.database, { [VIDEO_PLAN_JOB_TYPE]: handler },
    { workerId: "http-plan", leaseMs: 5_000, heartbeatMs: 100 }).runOne();
  const completed = getJob(connection.database, queued.job.id)!;
  assert.equal(completed.status, "succeeded", completed.errorMessage ?? "方案生成失败");
  const plan = getVideoPlan(connection.database, project.id, video.id)!;
  approveVideoPlan(connection.database, project.id, video.id, { snapshotId: plan.snapshotId,
    scriptRevisionId: plan.script.id, visualRevisionId: plan.visual.id }, 70);
  connection.close();
  return { projectId: project.id, videoId: video.id };
}

async function waitForWorkspace(app: ReturnType<typeof buildApp>, url: string, predicate: (value: any) => boolean) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const response = await app.inject({ method: "GET", url });
    assert.equal(response.statusCode, 200, response.body);
    const workspace = response.json().workspace;
    if (predicate(workspace)) return workspace;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("等待配音 HTTP 状态超时");
}

test("隔离 HTTP fixture 完成真实音频、字幕、幂等、批准与重启恢复", async () => {
  const dataRoot = await mkdtemp(join(tmpdir(), "yingshu-video-tts-http-"));
  const ids = await seed(dataRoot);
  const runtime = resolveRuntimeModelConfig("tts", defaultModelConfig())!;
  const identity = resolveVideoTtsProviderIdentity(runtime, { voice: runtime.voiceId!, rate: 0, language: runtime.language! });
  const fixture = createVideoTtsPcmFixture(identity);
  const base = `/api/projects/${ids.projectId}/videos/${ids.videoId}`;
  let app = buildApp({ dataRoot, logger: false, jobPollMs: 5, videoTtsSynthesizer: fixture.synthesize });
  try {
    await app.ready();
    const initial = await waitForWorkspace(app, `${base}/tts`, (value) => value.available);
    assert.equal(initial.history.length, 0);
    const body = { voiceId: identity.voice, rate: 0, language: identity.language };
    const started = await app.inject({ method: "POST", url: `${base}/tts-jobs`, payload: body });
    assert.equal(started.statusCode, 200, started.body);
    const duplicate = await app.inject({ method: "POST", url: `${base}/tts-jobs`, payload: body });
    assert.equal(duplicate.statusCode, 200, duplicate.body);
    const completed = await waitForWorkspace(app, `${base}/tts`, (value) => value.job?.status === "succeeded" && value.artifact);
    assert.equal(fixture.getCallCount(), completed.cues.length);

    const audio = await app.inject({ method: "GET", url: `${base}/tts/audio` });
    assert.equal(audio.statusCode, 200, audio.body);
    assert.equal(audio.rawPayload.toString("ascii", 0, 4), "RIFF");
    for (const format of ["srt", "ass"] as const) {
      const subtitle = await app.inject({ method: "GET", url: `${base}/tts/subtitles/${format}` });
      assert.equal(subtitle.statusCode, 200, subtitle.body);
      assert(subtitle.rawPayload.length > 0);
    }
    const deviation = Math.abs(completed.artifact.durationSeconds - completed.targetDurationSeconds) / completed.targetDurationSeconds;
    const approved = await app.inject({ method: "POST", url: `${base}/audio-approval`, payload: {
      snapshotId: completed.snapshot.id, artifactId: completed.artifact.id, confirmedFullPlayback: true,
      notes: "HTTP fixture 完整试听", durationDecision: deviation > 0.1 ? "accept_actual" : "within_target",
    } });
    assert.equal(approved.statusCode, 200, approved.body);
    assert.equal(approved.json().workspace.audioGate.valid, true);
    const calls = fixture.getCallCount();
    await app.close();

    app = buildApp({ dataRoot, logger: false, jobPollMs: 5, videoTtsSynthesizer: fixture.synthesize });
    await app.ready();
    const restored = await waitForWorkspace(app, `${base}/tts`, (value) => value.audioGate?.valid);
    assert.equal(restored.job.status, "succeeded");
    assert.equal(fixture.getCallCount(), calls);
  } finally {
    await app.close().catch(() => undefined);
    await rm(dataRoot, { recursive: true, force: true });
  }
});
