import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { buildApp } from "./app.js";
import { openDatabase } from "./database.js";
import { enqueueEpisodeScriptGenerationJob } from "./episode-script-generation-job.js";
import { createJob, getJob, requestJobCancellation } from "./job-store.js";
import { JobWorker } from "./job-worker.js";
import type { RuntimeModelConfig } from "./model-config.js";
import { changeScriptApproval } from "./script-approval-store.js";
import {
  createTtsCalibrationJobHandler,
  enqueueTtsCalibrationJob,
  getCurrentTtsCalibration,
  readVerifiedTtsCalibrationSample,
  requireMeasuredTtsCalibration,
  TTS_CALIBRATION_JOB_TYPE,
  type TtsCalibrationSample,
} from "./tts-calibration-job.js";
import { TtsCancelledError, type SystemSpeechInput } from "./tts-provider.js";
import { createTtsTimelineJobHandler, TTS_TIMELINE_JOB_TYPE } from "./tts-timeline-job.js";

async function seed(dataRoot: string, database: ReturnType<typeof openDatabase>["database"]) {
  const source = Buffer.from("吴邪进入墓道");
  await writeFile(join(dataRoot, "book.txt"), source);
  const sourceHash = createHash("sha256").update(source).digest("hex");
  database.prepare(
    `INSERT INTO books (id,title,original_file_path,original_file_hash,encoding,import_status)
     VALUES ('book_cal','测试书','book.txt',?,'utf-8','ready')`,
  ).run(sourceHash);
  database.prepare(
    "INSERT INTO series_projects (id,book_id,title,created_at,updated_at) VALUES ('series_cal','book_cal','测试系列',1,1)",
  ).run();
  database.prepare(
    `INSERT INTO chapters (id,book_id,chapter_index,title,byte_start,byte_end,char_count,content_hash)
     VALUES ('chapter_cal','book_cal',0,'第一章',0,?,6,?)`,
  ).run(source.length, sourceHash);
  database.prepare(
    `INSERT INTO chapter_events (id,chapter_id,event_index,occurrence,event_type,payload_json,created_at)
     VALUES ('event_cal','chapter_cal',0,0,'character',?,1)`,
  ).run(JSON.stringify({ name: "吴邪", state: "进入墓道" }));
  database.prepare(
    `INSERT INTO episodes (id,series_project_id,episode_index,title,story_arc,target_duration_seconds,created_at,updated_at)
     VALUES ('episode_cal','series_cal',1,'第一集：吴邪入墓','吴邪与潘子进入墓道',240,1,1)`,
  ).run();
  database.prepare(
    `INSERT INTO episode_sources (
       episode_id,source_index,chapter_id,source_event_id,source_byte_start,source_byte_end,source_hash
     ) VALUES ('episode_cal',0,'chapter_cal','event_cal',0,?,?)`,
  ).run(source.length, sourceHash);
  database.prepare(
    `INSERT INTO script_versions (id,episode_id,kind,version,parent_version_id,content_json,content_hash,created_at)
     VALUES ('script_cal','episode_cal','packaged',1,NULL,?,?,1)`,
  ).run(JSON.stringify({ paragraphs: [{ text: "吴邪与潘子进入墓道。", sourceIndexes: [] }] }), "a".repeat(64));
  changeScriptApproval(database, "episode_cal", {
    action: "approve", expectedRevision: 0, scriptVersionId: "script_cal",
  });
}

function wav(seedByte = 1) {
  const bytes = Buffer.alloc(64, seedByte);
  bytes.write("RIFF", 0, "ascii");
  bytes.write("WAVE", 8, "ascii");
  return bytes;
}

const edgeRuntime: RuntimeModelConfig = {
  enabled: true,
  type: "tts",
  providerId: "edge-tts",
  providerName: "Edge TTS",
  providerKind: "edge-tts",
  protocol: "openai-response",
  baseUrl: "",
  apiKey: "",
  modelId: "node-edge-tts",
  voiceId: "zh-CN-YunjianNeural",
  voiceLabel: "Chinese - China - Yunjian",
  language: "zh-CN",
  gender: "male",
  wordBoundary: true,
};

test("双短样生成、append-only 选择、恢复与 WAV 完整验证", async () => {
  const dataRoot = await mkdtemp(join(tmpdir(), "narralume-tts-cal-"));
  const connection = openDatabase(dataRoot);
  let synthesisCount = 0;
  const synthesize = async (input: SystemSpeechInput) => {
    synthesisCount += 1;
    const bytes = wav(synthesisCount);
    await writeFile(input.outputPath, bytes);
    return { providerId: "windows-system-speech", voice: input.voice!, rate: input.rate!, inputHash: "x", outputPath: input.outputPath, bytes: bytes.length };
  };
  const stableProbe = async (path: string) => ({ bytes: await (await import("node:fs/promises")).stat(path).then((info) => info.size), durationMs: 5_000 });
  const handler = createTtsCalibrationJobHandler(connection.database, dataRoot, { synthesize, probe: stableProbe });
  const run = async (payload: unknown) => {
    const job = enqueueTtsCalibrationJob(connection.database, payload, { maxAttempts: 1 });
    const worker = new JobWorker(connection.database, { [TTS_CALIBRATION_JOB_TYPE]: handler }, {
      workerId: `cal-${job.id}`, leaseMs: 5_000, heartbeatMs: 50,
    });
    assert.equal(await worker.runOne(), true);
    return getJob(connection.database, job.id)!;
  };
  try {
    await seed(dataRoot, connection.database);
    const generated = await run({ mode: "generate", episodeId: "episode_cal", voice: "测试音色", rate: 0 });
    assert.equal(generated.status, "succeeded");
    const result = generated.result as { exactText: string; characterCount: number; samples: TtsCalibrationSample[] };
    assert.match(result.exactText, /第3盏灯.*21点07分/u);
    assert.equal(result.characterCount, [...result.exactText.normalize("NFKC")].length);
    assert.equal(result.samples.length, 2);
    assert(result.samples.every((sample) => sample.characterCountMethod === "unicode_code_points_nfkc"));
    assert.deepEqual(result.samples.map((sample) => [sample.voice, sample.rate]), [["测试音色", 0], ["测试音色", 1]]);
    assert(result.samples.every((sample) => sample.durationMs === 5_000 && sample.charactersPerSecond > 0 && sample.fileHash.length === 64));
    assert.equal(synthesisCount, 2);
    assert.equal(connection.database.prepare("SELECT COUNT(*) AS count FROM audio_segments").get()!.count, 0);

    const firstSelection = await run({
      mode: "select", episodeId: "episode_cal", generateJobId: generated.id, sampleId: result.samples[0]!.sampleId,
    });
    assert.equal(firstSelection.status, "succeeded");
    await new Promise((resolve) => setTimeout(resolve, 2));
    const generatedB = await run({ mode: "generate", episodeId: "episode_cal", voice: "测试音色", rate: 4 });
    const resultB = generatedB.result as { samples: TtsCalibrationSample[] };
    const generatedBRestored = getCurrentTtsCalibration(connection.database, "episode_cal");
    assert.equal(generatedBRestored.generationJobId, generatedB.id);
    assert.equal(generatedBRestored.selection, undefined, "最新 generate 必须让历史选择失效并展示新短样");
    assert.deepEqual(generatedBRestored.samples.map((sample) => sample.rate), [4, 5]);
    await new Promise((resolve) => setTimeout(resolve, 2));
    const secondSelection = await run({
      mode: "select", episodeId: "episode_cal", generateJobId: generatedB.id, sampleId: resultB.samples[1]!.sampleId,
    });
    assert.notEqual(firstSelection.id, secondSelection.id, "每次显式选择都必须新增 append-only Job");
    const restored = getCurrentTtsCalibration(connection.database, "episode_cal");
    assert.equal(restored.samples.length, 2);
    assert.equal(restored.generationJobId, generatedB.id);
    assert.equal(restored.selection?.sampleId, resultB.samples[1]!.sampleId);
    const restarted = openDatabase(dataRoot);
    try {
      const restartRestored = getCurrentTtsCalibration(restarted.database, "episode_cal");
      assert.equal(restartRestored.generationJobId, generatedB.id);
      assert.equal(restartRestored.selection?.sampleId, resultB.samples[1]!.sampleId);
    } finally { restarted.close(); }
    assert.deepEqual(requireMeasuredTtsCalibration(connection.database, "episode_cal", {
      sampleId: restored.selection!.sampleId,
      voice: restored.selection!.voice,
      rate: restored.selection!.rate,
      charactersPerSecond: restored.selection!.charactersPerSecond,
    }), restored.selection);
    assert.throws(() => requireMeasuredTtsCalibration(connection.database, "episode_cal", {
      sampleId: restored.selection!.sampleId, voice: restored.selection!.voice,
      rate: restored.selection!.rate, charactersPerSecond: 19.9,
    }), /已选短样不一致/);
    const config = { providerId: "test", model: "test", baseUrl: "https://example.invalid", apiKey: "test" };
    const measuredRequest = {
      seriesId: "series_cal", episodeIndex: 1, voice: restored.selection!.voice, rate: restored.selection!.rate,
      charactersPerSecond: restored.selection!.charactersPerSecond, narrationOccupancy: 0.8,
      calibration: { identity: "measured" as const, sampleId: restored.selection!.sampleId },
    };
    assert.equal((await enqueueEpisodeScriptGenerationJob(connection.database, dataRoot, config, {
      payload: measuredRequest, maxAttempts: 1,
    })).created, true);
    await assert.rejects(enqueueEpisodeScriptGenerationJob(connection.database, dataRoot, config, {
      payload: { ...measuredRequest, charactersPerSecond: 19.9 }, maxAttempts: 1,
    }), /已选短样不一致/);

    let timelineVoice = "";
    let timelineRate = -99;
    const timelineJob = createJob(connection.database, {
      type: TTS_TIMELINE_JOB_TYPE, payload: { episodeId: "episode_cal" }, maxAttempts: 1,
    });
    const timelineWorker = new JobWorker(connection.database, {
      [TTS_TIMELINE_JOB_TYPE]: createTtsTimelineJobHandler(connection.database, dataRoot, {
        synthesize: async (input) => {
          timelineVoice = input.voice!; timelineRate = input.rate!;
          return synthesize(input);
        },
        probe: stableProbe,
      }),
    }, { workerId: "cal-timeline", leaseMs: 5_000, heartbeatMs: 50 });
    await timelineWorker.runOne();
    assert.equal(getJob(connection.database, timelineJob.id)?.status, "succeeded");
    assert.deepEqual([timelineVoice, timelineRate], [restored.selection!.voice, restored.selection!.rate]);

    assert.equal((await readVerifiedTtsCalibrationSample(
      connection.database, dataRoot, "episode_cal", resultB.samples[0]!.sampleId,
    )).length, 64);
    const app = buildApp({
      dataRoot, logger: false, jobPollMs: 10_000,
      jobHandlers: { [TTS_CALIBRATION_JOB_TYPE]: async () => ({ accepted: true }) },
    });
    try {
      const created = await app.inject({
        method: "POST", url: "/api/jobs",
        payload: { type: TTS_CALIBRATION_JOB_TYPE, payload: { mode: "generate", episodeId: "episode_cal", voice: "测试音色", rate: 0 } },
      });
      assert.equal(created.statusCode, 201);
      assert.equal(created.json().job.type, TTS_CALIBRATION_JOB_TYPE);
      const audio = await app.inject({ method: "GET", url: `/api/episodes/episode_cal/tts-calibration/${resultB.samples[0]!.sampleId}/audio` });
      assert.equal(audio.statusCode, 200);
      assert.equal(audio.headers["content-type"], "audio/wav");
      await writeFile(join(dataRoot, resultB.samples[0]!.relativePath), wav(9));
      const damaged = await app.inject({ method: "GET", url: `/api/episodes/episode_cal/tts-calibration/${resultB.samples[0]!.sampleId}/audio` });
      assert.equal(damaged.statusCode, 409);
      assert.match(damaged.json().message, /哈希/);
    } finally { await app.close(); }
  } finally {
    connection.close();
    await rm(dataRoot, { recursive: true, force: true });
  }
});

test("批准漂移、失败和取消不会产生伪成功校准", async () => {
  const dataRoot = await mkdtemp(join(tmpdir(), "narralume-tts-cal-failure-"));
  const connection = openDatabase(dataRoot);
  try {
    await seed(dataRoot, connection.database);
    const drift = enqueueTtsCalibrationJob(connection.database, { mode: "generate", episodeId: "episode_cal" }, { maxAttempts: 1 });
    changeScriptApproval(connection.database, "episode_cal", { action: "withdraw", expectedRevision: 1 });
    const driftWorker = new JobWorker(connection.database, {
      [TTS_CALIBRATION_JOB_TYPE]: createTtsCalibrationJobHandler(connection.database, dataRoot),
    }, { workerId: "cal-drift", leaseMs: 5_000, heartbeatMs: 50 });
    await driftWorker.runOne();
    assert.equal(getJob(connection.database, drift.id)?.status, "failed");
    assert.equal(getJob(connection.database, drift.id)?.result, null);

    changeScriptApproval(connection.database, "episode_cal", {
      action: "approve", expectedRevision: 2, scriptVersionId: "script_cal",
    });
    const failed = enqueueTtsCalibrationJob(connection.database, { mode: "generate", episodeId: "episode_cal" }, { maxAttempts: 1 });
    const failedWorker = new JobWorker(connection.database, {
      [TTS_CALIBRATION_JOB_TYPE]: createTtsCalibrationJobHandler(connection.database, dataRoot, {
        synthesize: async () => { throw new Error("测试合成失败"); },
      }),
    }, { workerId: "cal-failed", leaseMs: 5_000, heartbeatMs: 50 });
    await failedWorker.runOne();
    assert.equal(getJob(connection.database, failed.id)?.status, "failed");
    assert.equal(getJob(connection.database, failed.id)?.result, null);

    let started!: () => void;
    const synthesisStarted = new Promise<void>((resolve) => { started = resolve; });
    const cancelled = enqueueTtsCalibrationJob(connection.database, { mode: "generate", episodeId: "episode_cal", rate: 2 }, { maxAttempts: 1 });
    const cancelledWorker = new JobWorker(connection.database, {
      [TTS_CALIBRATION_JOB_TYPE]: createTtsCalibrationJobHandler(connection.database, dataRoot, {
        synthesize: (input) => new Promise((_, reject) => {
          started();
          input.signal?.addEventListener("abort", () => reject(new TtsCancelledError("测试取消")), { once: true });
        }),
      }),
    }, { workerId: "cal-cancelled", leaseMs: 5_000, heartbeatMs: 50 });
    const running = cancelledWorker.runOne();
    await synthesisStarted;
    requestJobCancellation(connection.database, cancelled.id);
    await running;
    assert.equal(getJob(connection.database, cancelled.id)?.status, "cancelled");
    assert.equal(getJob(connection.database, cancelled.id)?.result, null);
  } finally {
    connection.close();
    await rm(dataRoot, { recursive: true, force: true });
  }
});

test("短样校准消费当前 TTS runtime provider 身份", async () => {
  const dataRoot = await mkdtemp(join(tmpdir(), "narralume-tts-cal-runtime-"));
  const connection = openDatabase(dataRoot);
  try {
    await seed(dataRoot, connection.database);
    let consumedRuntime: RuntimeModelConfig | null | undefined;
    const job = enqueueTtsCalibrationJob(connection.database, { mode: "generate", episodeId: "episode_cal" }, { maxAttempts: 1 });
    const worker = new JobWorker(connection.database, {
      [TTS_CALIBRATION_JOB_TYPE]: createTtsCalibrationJobHandler(connection.database, dataRoot, {
        runtime: async () => edgeRuntime,
        synthesize: async (input) => {
          consumedRuntime = input.runtime;
          await writeFile(input.outputPath, wav(7));
          return { providerId: edgeRuntime.providerId, voice: edgeRuntime.voiceId!, rate: input.rate!, inputHash: "x", outputPath: input.outputPath, bytes: 64 };
        },
        probe: async () => ({ bytes: 64, durationMs: 4_000 }),
      }),
    }, { workerId: "cal-runtime", leaseMs: 5_000, heartbeatMs: 50 });
    assert.equal(await worker.runOne(), true);
    const result = getJob(connection.database, job.id)!.result as { samples: TtsCalibrationSample[] };
    assert.equal(consumedRuntime?.providerId, "edge-tts");
    assert(result.samples.every((sample) => sample.providerId === "edge-tts" && sample.voice === "zh-CN-YunjianNeural"));
  } finally {
    connection.close();
    await rm(dataRoot, { recursive: true, force: true });
  }
});
