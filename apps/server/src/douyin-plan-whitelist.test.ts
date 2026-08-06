import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { ChapterTextModelConfig } from "./chapter-event-analyzer.js";
import { putVideoInput } from "./creative-input-store.js";
import { openDatabase } from "./database.js";
import type { DouyinAnalysisReport, DouyinUsageRole } from "./douyin-analysis-contract.js";
import { enqueueDouyinAnalysis, saveDouyinAnalysisSelection, updateDouyinAnalysisSnapshot } from "./douyin-analysis-store.js";
import { JobWorker } from "./job-worker.js";
import { createProject, createVideo } from "./project-video-store.js";
import { createVideoPlanJobHandler, enqueueVideoPlanJob, VIDEO_PLAN_JOB_TYPE } from "./video-plan-service.js";

const config: ChapterTextModelConfig = { providerId: "fixture", baseUrl: "https://example.invalid/v1",
  apiKey: "secret", model: "fixture-model" };
const HASH = "a".repeat(64);

function observation(dimension: string, conclusion: string) {
  return { dimension, conclusion, evidenceRefs: ["asr:0"], confidence: "high" as const, nature: "observation" as const };
}

function report(partialAsr = false): DouyinAnalysisReport {
  const available = { status: "available" as const, reason: "" };
  return {
    version: "yingshu-douyin-analysis-v1",
    evidence: { metadataStatus: "succeeded", videoStatus: "succeeded", asrStatus: partialAsr ? "partial" : "succeeded",
      asrCoveredDurationMs: 60_000, asrTextCharacters: 100, plannedFrames: 12, succeededFrames: 12,
      failedFrames: 0, commentCount: 1, evidenceHash: HASH, capturedAt: 1, analyzedAt: 2,
      modelIdentity: "fixture", completeness: partialAsr ? "partial" : "complete" },
    availability: { content: available, narrative: available, pacing: available, visualOverall: available,
      visualOpening: available, audioSubtitle: available, audience: available, narrationVisualAlignment: available },
    content: { observations: [observation("topic", "冻结抖音选题"), observation("coreQuestion", "冻结核心问题"),
      observation("audienceAngle", "冻结受众角度"), observation("claim", "CLAIM_EVENT_7788")] },
    narrative: { sections: [{ startMs: 0, endMs: 10_000, role: "问题开场", summary: "STRUCTURE_EVENT_7788",
      technique: "ABSTRACT_METHOD_HOOK", evidenceRefs: ["asr:0"] }], observations: [observation("narrative", "ABSTRACT_METHOD_ARC")] },
    pacing: { metrics: { questionRatio: 0.2 }, observations: [observation("pacing", "第二人称代入，冲突范围连续扩大，并以危机出手推动局势逆转")] },
    visual: { observations: [observation("visual", "ABSTRACT_VISUAL_DENSITY")] },
    audioSubtitle: { observations: [{ dimension: "subtitle", conclusion: "无法确认字幕状态", evidenceRefs: [],
      confidence: "low", nature: "unknown" }] },
    audience: { interpretationOnly: true, observations: [observation("audience", "AUDIENCE_NEED_SUMMARY")] },
    observations: [], risks: [{ code: "uncertain", summary: "UNCERTAINTY_SUMMARY", evidenceRefs: ["asr:0"] }],
  };
}

function manifest(partialAsr = false) {
  return {
    version: "yingshu-douyin-evidence-v1", evidenceHash: HASH,
    artifacts: [{ id: "secret-artifact", kind: "video", relativePath: "SECRET/PATH/video.mp4", bytes: 1, sha256: HASH,
      status: "succeeded" }],
    transcript: { status: partialAsr ? "partial" : "succeeded", textHash: HASH, segments: [
      { id: "asr:0", startMs: 0, endMs: 10_000, text: "TRANSCRIPT_PERSON_7788", status: "succeeded" }], missingRanges: [] },
    frames: [{ artifactId: "secret-frame", timestampMs: 1_000 }],
    comments: { status: "succeeded", interpretationOnly: true, rawText: "RAW_COMMENT_7788" },
  };
}

function scriptOutput() {
  const first = "这是用于验证真实方案模型调用边界的旁白文本，它保持足够长度并覆盖一个完整解释段落。";
  const second = "系统随后继续组织内容，让生成结果满足目标时长下限，同时不需要任何自动批准步骤，并明确保留人工审核与后续修订空间。";
  return { title: "测试方案", summary: "验证抖音证据白名单。", narration: `${first}${second}`,
    paragraphs: [{ text: first }, { text: second }], sourceSummary: [], risks: [] };
}

function visualOutput(prompt: string) {
  const ids = [...new Set([...prompt.matchAll(/paragraph_[0-9a-f]{20}/gu)].map((match) => match[0]))];
  return { visuals: ids.map((paragraphId) => ({ paragraphId, purpose: "解释", description: "抽象信息图",
    prompt: "vertical infographic", negativePrompt: "text", suggestedDurationSeconds: 30, weight: 1 })) };
}

async function runRole(role: DouyinUsageRole, partialAsr = false) {
  const dataRoot = await mkdtemp(join(tmpdir(), `yingshu-douyin-${role}-`));
  const connection = openDatabase(dataRoot);
  const project = createProject(connection.database, { name: "测试项目" }, 1);
  const video = createVideo(connection.database, project.id, { title: "测试视频" }, 2);
  if (role === "method_only") {
    putVideoInput(connection.database, project.id, video.id, { inputMode: "topic", topic: "用户原主题", body: "",
      referenceText: "用户参考", referenceRole: "style_only", targetDurationSeconds: 60, visualDensity: "standard",
      webEnabled: false, scriptInstructions: "", visualInstructions: "" }, 3);
  } else {
    putVideoInput(connection.database, project.id, video.id, { inputMode: "topic", topic: "", body: "",
      referenceText: "", referenceRole: "style_only", targetDurationSeconds: 60, visualDensity: "standard",
      webEnabled: role === "topic_seed", scriptInstructions: "", visualInstructions: "" }, 3, true);
  }
  const analysis = enqueueDouyinAnalysis(connection.database, { projectId: project.id, videoId: video.id,
    awemeId: "12345", sourceUrl: "https://www.douyin.com/video/12345",
    config: { sourceText: "https://www.douyin.com/video/12345", extractFrames: true, frameCount: 12,
      transcribeAudio: true, analyzeComments: true }, now: 4 });
  const completed = updateDouyinAnalysisSnapshot(connection.database, { snapshotId: analysis.snapshot.id,
    status: partialAsr ? "partial" : "succeeded", completeness: partialAsr ? "partial" : "complete",
    evidenceHash: HASH, report: report(partialAsr), artifactManifest: manifest(partialAsr), completedAt: 5 });
  saveDouyinAnalysisSelection(connection.database, { projectId: project.id, videoId: video.id, now: 6,
    selection: { snapshotId: completed.id, usageRole: role, creativeAngle: "用户改写角度", rightsConfirmed: role === "content_source",
      acceptedMissingDimensions: partialAsr ? ["asr"] : [] } });
  enqueueVideoPlanJob(connection.database, { projectId: project.id, videoId: video.id,
    idempotencyKey: `plan-${role}`, entryMode: "douyin", config, now: 7 });
  const prompts: string[] = [];
  const worker = new JobWorker(connection.database, { [VIDEO_PLAN_JOB_TYPE]: createVideoPlanJobHandler(
    connection.database, config, async ({ stage, prompt }) => {
      prompts.push(prompt);
      return stage === "script" ? scriptOutput() : visualOutput(prompt);
    }, async ({ query }) => {
      assert.equal(query, "冻结抖音选题");
      return [{ title: "独立来源", url: "https://example.com/independent", summary: "独立查证摘要" }];
    }) }, { workerId: `worker-${role}`, leaseMs: 10_000, heartbeatMs: 1_000 });
  await worker.runOne();
  return { dataRoot, connection, prompts };
}

test("三种使用方式的真实 provider prompt 只包含各自字段白名单", async () => {
  for (const role of ["method_only", "topic_seed", "content_source"] as const) {
    const value = await runRole(role);
    try {
      const providerPayload = value.prompts.join("\n");
      assert.doesNotMatch(providerPayload, /SECRET\/PATH|secret-frame|RAW_COMMENT_7788/u);
      if (role === "method_only") {
        assert.match(providerPayload, /问题开场/u);
        assert.doesNotMatch(providerPayload, /ABSTRACT_METHOD_HOOK|ABSTRACT_METHOD_ARC|AUDIENCE_NEED_SUMMARY|UNCERTAINTY_SUMMARY/u);
        assert.doesNotMatch(providerPayload, /TRANSCRIPT_PERSON_7788|CLAIM_EVENT_7788|STRUCTURE_EVENT_7788|冻结抖音选题/u);
      } else if (role === "topic_seed") {
        assert.match(providerPayload, /冻结抖音选题|冻结核心问题|冻结受众角度|https:\/\/example\.com\/independent/u);
        assert.doesNotMatch(providerPayload, /TRANSCRIPT_PERSON_7788|CLAIM_EVENT_7788|STRUCTURE_EVENT_7788/u);
      } else {
        for (const expected of ["TRANSCRIPT_PERSON_7788", "CLAIM_EVENT_7788", "STRUCTURE_EVENT_7788",
          "第二人称代入", "逐级升级", "危机反转", "AUDIENCE_NEED_SUMMARY"]) assert.match(providerPayload, new RegExp(expected, "u"));
        assert.match(providerPayload, /"startMs":0.*"endMs":10000.*"technique":"ABSTRACT_METHOD_HOOK"/su);
        assert.doesNotMatch(providerPayload, /ABSTRACT_VISUAL_DENSITY|字幕辅助/u);
        assert.match(providerPayload, /评论洞察仅作受众解读.*来源边界、未核验说明和分析过程只写入 risks/su);
      }
      assert.equal(value.connection.database.prepare("SELECT status FROM videos WHERE id=(SELECT id FROM videos LIMIT 1)")
        .get()?.status, "awaiting_review");
      assert.equal(value.connection.database.prepare("SELECT COUNT(*) AS count FROM video_plan_approvals").get()?.count, 0);
    } finally {
      value.connection.close();
      await rm(value.dataRoot, { recursive: true, force: true });
    }
  }
});

test("部分 ASR 必须由同一报告事件显式接受后才可进入实际 provider", async () => {
  const value = await runRole("topic_seed", true);
  try {
    assert.match(value.prompts.join("\n"), /冻结抖音选题|https:\/\/example\.com\/independent/u);
  } finally {
    value.connection.close();
    await rm(value.dataRoot, { recursive: true, force: true });
  }
});

test("普通输入入口默认忽略已经保存的抖音使用方式", async () => {
  const value = await runRole("method_only");
  try {
    const video = value.connection.database.prepare("SELECT id,project_id FROM videos LIMIT 1")
      .get() as { id: string; project_id: string };
    enqueueVideoPlanJob(value.connection.database, { projectId: video.project_id, videoId: video.id,
      idempotencyKey: "primary-after-douyin", config, now: 8 });
    const row = value.connection.database.prepare(
      "SELECT input_json FROM video_plan_snapshots WHERE video_id=? AND idempotency_key=?",
    ).get(video.id, "primary-after-douyin") as { input_json: string };
    assert.equal((JSON.parse(row.input_json) as { douyin: unknown }).douyin, null);
  } finally {
    value.connection.close();
    await rm(value.dataRoot, { recursive: true, force: true });
  }
});
