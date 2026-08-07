import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { ChapterTextModelConfig } from "./chapter-event-analyzer.js";
import { putGlobalPromptSettings, putProjectSettings, putVideoInput } from "./creative-input-store.js";
import { openDatabase } from "./database.js";
import { getJob } from "./job-store.js";
import { JobWorker } from "./job-worker.js";
import { createProject, createVideo } from "./project-video-store.js";
import {
  approveVideoPlan,
  createVideoPlanJobHandler,
  enqueueVideoPlanJob,
  getVideoPlan,
  getVideoPlanSources,
  saveVideoScriptRevision,
  saveVideoVisualRevision,
  VIDEO_PLAN_JOB_TYPE,
  VideoPlanError,
  type GenerateVideoPlan,
} from "./video-plan-service.js";

const config: ChapterTextModelConfig = {
  baseUrl: "https://example.invalid/v1",
  apiKey: "绝不能持久化的密钥",
  model: "fixture-model",
  providerId: "fixture-provider",
};

async function fixture(webEnabled = false) {
  const dataRoot = await mkdtemp(join(tmpdir(), "yingshu-video-plan-"));
  const connection = openDatabase(dataRoot);
  const project = createProject(connection.database, { name: "测试项目" }, 10);
  const video = createVideo(connection.database, project.id, { title: "测试视频" }, 20);
  putGlobalPromptSettings(connection.database, {
    scriptInstructions: "全局文案约束", visualInstructions: "全局画面约束",
  }, 30);
  putProjectSettings(connection.database, project.id, {
    scriptInstructions: "项目文案约束", visualInstructions: "项目画面约束",
  }, 40);
  putVideoInput(connection.database, project.id, video.id, {
    inputMode: "topic", topic: "为什么天空是蓝色的", body: "", referenceText: "只参考平实表达",
    referenceRole: "style_only", targetDurationSeconds: 60, visualDensity: "standard", webEnabled,
    scriptInstructions: "视频文案约束", visualInstructions: "视频画面约束",
  }, 50);
  return { dataRoot, connection, project, video };
}

function scriptOutput() {
  const first = "天空呈现蓝色，核心原因是阳光进入大气层后，不同颜色的光会发生程度不同的散射。";
  const second = "蓝光波长较短，更容易被空气分子散向各个方向，因此我们从地面望去，视野中会接收到更多蓝色散射光。太阳接近地平线时，光线穿过的大气路径更长，蓝光大量散开，留下的红橙色光更显眼，这也解释了日出日落常见的暖色。";
  return {
    title: "天空为什么是蓝色", summary: "用光的散射解释日常天空颜色。",
    paragraphs: [{ text: first }, { text: second }],
    sourceSummary: [], risks: ["这里只给出面向大众的简化解释"],
  };
}

function paragraphIds(prompt: string) {
  return [...prompt.matchAll(/paragraph_[0-9a-f]{20}/gu)].map((match) => match[0]);
}

function visualOutput(prompt: string) {
  const ids = [...new Set(paragraphIds(prompt))];
  assert.equal(ids.length, 2);
  return { visuals: ids.map((paragraphId, index) => ({
    paragraphId, purpose: index === 0 ? "建立概念" : "解释机制",
    description: index === 0 ? "阳光进入地球大气层的剖面示意" : "蓝色光线向各方向散射的科普示意",
    prompt: index === 0 ? "vertical scientific illustration, sunlight entering atmosphere" : "vertical scientific illustration, blue light scattering",
    negativePrompt: "readable text, watermark", suggestedDurationSeconds: 30, weight: 1,
  })) };
}

test("默认空草稿不能绕过保存校验创建方案任务", async () => {
  const dataRoot = await mkdtemp(join(tmpdir(), "yingshu-empty-video-plan-"));
  const connection = openDatabase(dataRoot);
  const project = createProject(connection.database, { name: "空草稿项目" }, 10);
  const video = createVideo(connection.database, project.id, { title: "空草稿视频" }, 20);
  try {
    assert.throws(() => enqueueVideoPlanJob(connection.database, {
      projectId: project.id, videoId: video.id, idempotencyKey: "invalid-entry", entryMode: "other", config,
    }), /方案创作起点无效/);
    assert.throws(() => enqueueVideoPlanJob(connection.database, {
      projectId: project.id, videoId: video.id, idempotencyKey: "missing-douyin", entryMode: "douyin", config,
    }), /请先完成抖音分析并选择使用方式/);
    assert.throws(() => enqueueVideoPlanJob(connection.database, {
      projectId: project.id, videoId: video.id, idempotencyKey: "empty-draft", entryMode: "primary_input", config,
    }), /请输入主题后再生成方案/);
    assert.equal((connection.database.prepare("SELECT COUNT(*) AS count FROM video_plan_snapshots")
      .get() as { count: number }).count, 0);
    assert.equal((connection.database.prepare("SELECT COUNT(*) AS count FROM video_plan_jobs")
      .get() as { count: number }).count, 0);
    assert.equal((connection.database.prepare("SELECT COUNT(*) AS count FROM jobs")
      .get() as { count: number }).count, 0);
  } finally {
    connection.close();
    await rm(dataRoot, { recursive: true, force: true });
  }
});

test("开启联网时冻结搜索来源、只搜索一次并把来源交给旁白模型", async () => {
  const value = await fixture(true);
  let searchCalls = 0;
  let scriptPrompt = "";
  try {
    enqueueVideoPlanJob(value.connection.database, {
      projectId: value.project.id, videoId: value.video.id, idempotencyKey: "web-enabled", config,
    });
    const worker = new JobWorker(value.connection.database, {
      [VIDEO_PLAN_JOB_TYPE]: createVideoPlanJobHandler(value.connection.database, config, async ({ stage, prompt }) => {
        if (stage === "script") { scriptPrompt = prompt; return scriptOutput(); }
        return visualOutput(prompt);
      }, async ({ query }) => {
        searchCalls += 1;
        assert.equal(query, "为什么天空是蓝色的");
        return [{ title: "天空颜色科普", url: "https://example.com/sky", summary: "短波蓝光更容易发生瑞利散射。" }];
      }),
    }, { workerId: "web-enabled-worker", leaseMs: 10_000, heartbeatMs: 1_000 });
    await worker.runOne();
    assert.equal(searchCalls, 1);
    assert.match(scriptPrompt, /https:\/\/example\.com\/sky/u);
    const sources = getVideoPlanSources(value.connection.database, value.project.id, value.video.id);
    assert.equal(sources.webEnabled, true);
    assert.equal(sources.items.length, 1);
    assert.equal((sources.items[0] as { title: string }).title, "天空颜色科普");
    assert.deepEqual(getVideoPlan(value.connection.database, value.project.id, value.video.id)?.script.sourceSummary,
      ["天空颜色科普：短波蓝光更容易发生瑞利散射。"]);
  } finally {
    value.connection.close();
    await rm(value.dataRoot, { recursive: true, force: true });
  }
});

test("关闭联网时幂等创建唯一 Job，并冻结不含密钥的输入、提示词和模型身份", async () => {
  const value = await fixture();
  try {
    const input = { projectId: value.project.id, videoId: value.video.id, idempotencyKey: "same-request", config, now: 100 };
    const first = enqueueVideoPlanJob(value.connection.database, input);
    const repeated = enqueueVideoPlanJob(value.connection.database, input);
    assert.equal(first.created, true);
    assert.equal(repeated.created, false);
    assert.equal(repeated.job.id, first.job.id);
    assert.equal((value.connection.database.prepare("SELECT COUNT(*) AS count FROM video_plan_snapshots")
      .get() as { count: number }).count, 1);
    assert.equal((value.connection.database.prepare("SELECT COUNT(*) AS count FROM video_plan_jobs")
      .get() as { count: number }).count, 1);

    const row = value.connection.database.prepare(
      "SELECT input_json, prompt_json, model_json, canonical_json FROM video_plan_snapshots",
    ).get() as { input_json: string; prompt_json: string; model_json: string; canonical_json: string };
    const persisted = JSON.stringify(row);
    assert.equal(persisted.includes(config.apiKey!), false);
    assert.equal(JSON.parse(row.input_json).webEnabled, false);
    assert.equal(JSON.parse(row.prompt_json).global.scriptInstructions, "全局文案约束");
    assert.equal(JSON.parse(row.prompt_json).project.visualInstructions, "项目画面约束");
    assert.deepEqual(JSON.parse(row.model_json), {
      providerId: config.providerId, modelId: config.model, protocol: "openai-response",
      baseUrl: config.baseUrl, identityHash: JSON.parse(row.model_json).identityHash,
    });
  } finally {
    value.connection.close();
    await rm(value.dataRoot, { recursive: true, force: true });
  }
});

test("Worker 在画面失败后复用旁白 checkpoint，最终停在待审核且没有来源", async () => {
  const value = await fixture();
  let scriptCalls = 0;
  let visualCalls = 0;
  const generate: GenerateVideoPlan = async ({ stage, prompt }) => {
    if (stage === "script") { scriptCalls += 1; return scriptOutput(); }
    visualCalls += 1;
    if (visualCalls === 1) throw new Error("fixture 画面阶段瞬时失败");
    return visualOutput(prompt);
  };
  try {
    const queued = enqueueVideoPlanJob(value.connection.database, {
      projectId: value.project.id, videoId: value.video.id, idempotencyKey: "checkpoint-retry", config,
    });
    const worker = new JobWorker(value.connection.database, {
      [VIDEO_PLAN_JOB_TYPE]: createVideoPlanJobHandler(value.connection.database, config, generate),
    }, { workerId: "video-plan-worker", leaseMs: 10_000, heartbeatMs: 1_000, retryDelayMs: 0 });

    assert.equal(await worker.runOne(), true);
    assert.equal(getJob(value.connection.database, queued.job.id)?.status, "queued");
    assert.equal((value.connection.database.prepare("SELECT COUNT(*) AS count FROM video_script_revisions")
      .get() as { count: number }).count, 1);
    assert.equal((value.connection.database.prepare("SELECT COUNT(*) AS count FROM video_visual_revisions")
      .get() as { count: number }).count, 0);
    assert.equal(await worker.runOne(), true);

    assert.equal(scriptCalls, 1);
    assert.equal(visualCalls, 2);
    assert.equal(getJob(value.connection.database, queued.job.id)?.status, "succeeded");
    assert.equal(value.connection.database.prepare("SELECT status FROM videos WHERE id = ?").get(value.video.id)?.status,
      "awaiting_review");
    assert.deepEqual(getVideoPlanSources(value.connection.database, value.project.id, value.video.id), {
      webEnabled: false, items: [],
    });
    const plan = getVideoPlan(value.connection.database, value.project.id, value.video.id)!;
    assert.equal(plan.script?.revision, 1);
    assert.equal(plan.visual?.revision, 1);
    assert.ok(plan.visual?.visuals.every((item) => item.generationStatus === "not_generated" && item.currentCandidate === null));
  } finally {
    value.connection.close();
    await rm(value.dataRoot, { recursive: true, force: true });
  }
});

test("编辑形成新 revision；批准只接受同一组兼容版本；跨项目读取被拒绝", async () => {
  const value = await fixture();
  try {
    enqueueVideoPlanJob(value.connection.database, {
      projectId: value.project.id, videoId: value.video.id, idempotencyKey: "review-flow", config,
    });
    const worker = new JobWorker(value.connection.database, {
      [VIDEO_PLAN_JOB_TYPE]: createVideoPlanJobHandler(value.connection.database, config, async ({ stage, prompt }) =>
        stage === "script" ? scriptOutput() : visualOutput(prompt)),
    }, { workerId: "review-worker", leaseMs: 10_000, heartbeatMs: 1_000 });
    await worker.runOne();
    const initial = getVideoPlan(value.connection.database, value.project.id, value.video.id)!;
    const approved = approveVideoPlan(value.connection.database, value.project.id, value.video.id, {
      snapshotId: initial.snapshotId, scriptRevisionId: initial.script!.id, visualRevisionId: initial.visual!.id,
    });
    assert.ok(approved);
    assert.equal(approved.approval?.valid, true);

    const editedScript = saveVideoScriptRevision(value.connection.database, value.project.id, value.video.id, {
      snapshotId: initial.snapshotId, baseRevision: 1, title: initial.script!.title,
      summary: initial.script!.summary,
      paragraphs: initial.script!.paragraphs.map((item, index) => ({
        id: item.id, text: index === 0 ? `${item.text}这是人工补充。` : item.text,
      })),
    });
    assert.ok(editedScript);
    assert.equal(editedScript.script?.revision, 2);
    assert.equal(editedScript.approval?.valid, false);
    assert.throws(() => approveVideoPlan(value.connection.database, value.project.id, value.video.id, {
      snapshotId: initial.snapshotId, scriptRevisionId: editedScript.script!.id, visualRevisionId: initial.visual!.id,
    }), (error: unknown) => error instanceof VideoPlanError && error.statusCode === 409);

    const editedVisual = saveVideoVisualRevision(value.connection.database, value.project.id, value.video.id, {
      snapshotId: initial.snapshotId, baseRevision: 1, scriptRevisionId: editedScript.script!.id,
      visuals: initial.visual!.visuals.map((item) => ({ ...item, description: `${item.description}，保持简洁` })),
    });
    assert.ok(editedVisual);
    assert.equal(editedVisual.visual?.revision, 2);
    const reapproved = approveVideoPlan(value.connection.database, value.project.id, value.video.id, {
      snapshotId: initial.snapshotId, scriptRevisionId: editedScript.script!.id, visualRevisionId: editedVisual.visual!.id,
    });
    assert.ok(reapproved);
    assert.equal(reapproved.approval?.revision, 2);
    assert.equal(reapproved.approval?.valid, true);

    const other = createProject(value.connection.database, { name: "其他项目" }, 200);
    assert.throws(() => getVideoPlan(value.connection.database, other.id, value.video.id), /不属于当前项目/u);
  } finally {
    value.connection.close();
    await rm(value.dataRoot, { recursive: true, force: true });
  }
});

test("模型结构化输出无效时拒绝落 revision，并保留可重试 Job", async () => {
  const value = await fixture();
  try {
    const queued = enqueueVideoPlanJob(value.connection.database, {
      projectId: value.project.id, videoId: value.video.id, idempotencyKey: "invalid-output", config,
    });
    const worker = new JobWorker(value.connection.database, {
      [VIDEO_PLAN_JOB_TYPE]: createVideoPlanJobHandler(value.connection.database, config, async () => ({ unexpected: true })),
    }, { workerId: "invalid-worker", leaseMs: 10_000, heartbeatMs: 1_000, retryDelayMs: 0 });
    await worker.runOne();
    const job = getJob(value.connection.database, queued.job.id);
    assert.equal(job?.status, "queued");
    assert.equal(job?.errorCode, "handler_failed");
    assert.match(job?.errorMessage ?? "", /无效|字段/u);
    assert.equal((value.connection.database.prepare("SELECT COUNT(*) AS count FROM video_script_revisions")
      .get() as { count: number }).count, 0);
    assert.equal((value.connection.database.prepare("SELECT COUNT(*) AS count FROM video_visual_revisions")
      .get() as { count: number }).count, 0);
  } finally {
    value.connection.close();
    await rm(value.dataRoot, { recursive: true, force: true });
  }
});

test("缺少冻结 provider 授权时 Job 与视频状态都收敛为失败", async () => {
  const value = await fixture();
  try {
    const queued = enqueueVideoPlanJob(value.connection.database, {
      projectId: value.project.id, videoId: value.video.id, idempotencyKey: "missing-provider", config,
    });
    const worker = new JobWorker(value.connection.database, {
      [VIDEO_PLAN_JOB_TYPE]: createVideoPlanJobHandler(value.connection.database, async () => null, async () => {
        assert.fail("缺少授权时不得调用模型");
      }),
    }, { workerId: "missing-provider-worker", leaseMs: 10_000, heartbeatMs: 1_000, retryDelayMs: 0 });

    await worker.runOne();
    await worker.runOne();
    assert.equal(getJob(value.connection.database, queued.job.id)?.status, "failed");
    assert.equal(value.connection.database.prepare("SELECT status FROM videos WHERE id = ?").get(value.video.id)?.status,
      "failed");
  } finally {
    value.connection.close();
    await rm(value.dataRoot, { recursive: true, force: true });
  }
});

test("已失效快照的运行中 Job 不覆盖新输入的 draft 状态", async () => {
  const value = await fixture();
  let release!: () => void;
  let started!: () => void;
  const entered = new Promise<void>((resolve) => { started = resolve; });
  const waiting = new Promise<void>((resolve) => { release = resolve; });
  try {
    const queued = enqueueVideoPlanJob(value.connection.database, {
      projectId: value.project.id, videoId: value.video.id, idempotencyKey: "running-invalidation", config,
    });
    const worker = new JobWorker(value.connection.database, {
      [VIDEO_PLAN_JOB_TYPE]: createVideoPlanJobHandler(value.connection.database, config, async () => {
        started();
        await waiting;
        return scriptOutput();
      }),
    }, { workerId: "running-invalidation-worker", leaseMs: 10_000, heartbeatMs: 1_000, retryDelayMs: 0 });

    const running = worker.runOne();
    await entered;
    putVideoInput(value.connection.database, value.project.id, value.video.id, {
      inputMode: "topic", topic: "天空颜色为什么会变化", body: "", referenceText: "只参考平实表达",
      referenceRole: "style_only", targetDurationSeconds: 60, visualDensity: "standard", webEnabled: false,
      scriptInstructions: "视频文案约束", visualInstructions: "视频画面约束",
    });
    release();
    await running;

    assert.equal(getJob(value.connection.database, queued.job.id)?.status, "cancelled");
    assert.equal(value.connection.database.prepare("SELECT status FROM videos WHERE id = ?").get(value.video.id)?.status,
      "draft");
  } finally {
    release?.();
    value.connection.close();
    await rm(value.dataRoot, { recursive: true, force: true });
  }
});

test("未联网来源摘要和超出目标时长预算的旁白都拒绝持久化", async () => {
  for (const [idempotencyKey, output, message] of [
    ["offline-fake-source", { ...scriptOutput(), sourceSummary: ["https://example.com/虚假来源"] }, /未联网核验/u],
    ["overlong-script", (() => {
      const text = "长".repeat(331);
      return { ...scriptOutput(), paragraphs: [{ text }] };
    })(), /最多允许 330 字/u],
  ] as const) {
    const value = await fixture();
    try {
      const queued = enqueueVideoPlanJob(value.connection.database, {
        projectId: value.project.id, videoId: value.video.id, idempotencyKey, config,
      });
      const worker = new JobWorker(value.connection.database, {
        [VIDEO_PLAN_JOB_TYPE]: createVideoPlanJobHandler(value.connection.database, config, async () => output),
      }, { workerId: `${idempotencyKey}-worker`, leaseMs: 10_000, heartbeatMs: 1_000, retryDelayMs: 0 });
      await worker.runOne();
      assert.match(getJob(value.connection.database, queued.job.id)?.errorMessage ?? "", message);
      assert.equal(value.connection.database.prepare("SELECT COUNT(*) AS count FROM video_script_revisions")
        .get()?.count, 0);
    } finally {
      value.connection.close();
      await rm(value.dataRoot, { recursive: true, force: true });
    }
  }
});

test("视频输入真实变化会失效快照并取消任务，全局或项目提示词变化不会改写已冻结方案", async () => {
  const value = await fixture();
  try {
    const queued = enqueueVideoPlanJob(value.connection.database, {
      projectId: value.project.id, videoId: value.video.id, idempotencyKey: "input-invalidation", config, now: 100,
    });
    putGlobalPromptSettings(value.connection.database, {
      scriptInstructions: "新的全局文案", visualInstructions: "新的全局画面",
    }, 110);
    putProjectSettings(value.connection.database, value.project.id, {
      scriptInstructions: "新的项目文案", visualInstructions: "新的项目画面",
    }, 120);
    assert.equal(value.connection.database.prepare(
      "SELECT invalidated_at FROM video_plan_snapshots WHERE video_id = ?",
    ).get(value.video.id)?.invalidated_at, null);

    putVideoInput(value.connection.database, value.project.id, value.video.id, {
      inputMode: "topic", topic: "为什么天空是蓝色的", body: "", referenceText: "只参考平实表达",
      referenceRole: "style_only", targetDurationSeconds: 180, visualDensity: "standard", webEnabled: false,
      scriptInstructions: "视频文案约束", visualInstructions: "视频画面约束",
    }, 130);
    assert.equal(value.connection.database.prepare(
      "SELECT invalidated_at FROM video_plan_snapshots WHERE video_id = ?",
    ).get(value.video.id)?.invalidated_at, 130);
    assert.equal(getJob(value.connection.database, queued.job.id)?.status, "cancelled");
    assert.equal(value.connection.database.prepare("SELECT status FROM videos WHERE id = ?")
      .get(value.video.id)?.status, "draft");
    assert.equal(value.connection.database.prepare(
      "SELECT invalidated_at IS NOT NULL AS stale FROM video_plan_snapshots WHERE video_id = ?",
    ).get(value.video.id)?.stale, 1);
  } finally {
    value.connection.close();
    await rm(value.dataRoot, { recursive: true, force: true });
  }
});
