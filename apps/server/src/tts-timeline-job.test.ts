import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { buildApp } from "./app.js";
import { commitCheckpoint } from "./checkpoint-store.js";
import { changeScriptApproval } from "./script-approval-store.js";
import { openDatabase } from "./database.js";
import { claimNextJob, createJob, getJob, requestJobCancellation } from "./job-store.js";
import { JobWorker, type JobExecutionContext } from "./job-worker.js";
import type { RuntimeModelConfig } from "./model-config.js";
import { createTtsTimelineJobHandler, TTS_TIMELINE_JOB_TYPE } from "./tts-timeline-job.js";
import type { SystemSpeechInput } from "./tts-provider.js";
import { TtsCancelledError } from "./tts-provider.js";

function seedEpisode(database: ReturnType<typeof openDatabase>["database"]) {
  database.prepare(
    `INSERT INTO books (id, title, original_file_path, original_file_hash, encoding, import_status)
     VALUES ('book_tts', '测试书', 'book.txt', ?, 'utf-8', 'ready')`,
  ).run("1".repeat(64));
  database.prepare(
    `INSERT INTO series_projects (id, book_id, title, created_at, updated_at)
     VALUES ('series_tts', 'book_tts', '测试系列', 1, 1)`,
  ).run();
  database.prepare(
    `INSERT INTO episodes (
      id, series_project_id, episode_index, title, story_arc, target_duration_seconds, created_at, updated_at
    ) VALUES ('episode_tts', 'series_tts', 1, '第一集', '测试故事弧', 240, 1, 1)`,
  ).run();
  database.prepare(
    `INSERT INTO script_versions (
      id, episode_id, kind, version, parent_version_id, script_contract_version, content_json, content_hash, created_at
    ) VALUES ('script_tts', 'episode_tts', 'packaged', 1, NULL, 6, ?, ?, 1)`,
  ).run(JSON.stringify({ paragraphs: [
    { text: "甲".repeat(35), sourceIndexes: [0] },
    { text: "第二段真实旁白。", sourceIndexes: [0] },
  ] }), "a".repeat(64));
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

test("批准稿按真实音频段建立可恢复时间轴并复用内容寻址文件", async () => {
  const dataRoot = await mkdtemp(join(tmpdir(), "narralume-tts-timeline-"));
  const connection = openDatabase(dataRoot);
  let syntheses = 0;
  const synthesize = async (input: SystemSpeechInput) => {
    syntheses += 1;
    await writeFile(input.outputPath, Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(60, syntheses)]));
    return {
      providerId: "windows-system-speech", voice: input.voice ?? "Microsoft Huihui Desktop",
      rate: input.rate ?? 0, inputHash: "b".repeat(64), outputPath: input.outputPath, bytes: 64,
    };
  };
  const probe = async (path: string) => ({ bytes: (await stat(path)).size, durationMs: 1_250 });
  const handler = createTtsTimelineJobHandler(connection.database, dataRoot, { synthesize, probe });
  const run = async (payload: unknown) => {
    const job = createJob(connection.database, { type: TTS_TIMELINE_JOB_TYPE, payload, maxAttempts: 1 });
    const worker = new JobWorker(connection.database, { [TTS_TIMELINE_JOB_TYPE]: handler }, {
      workerId: `tts-test-${job.id}`, leaseMs: 5_000, heartbeatMs: 100,
    });
    assert.equal(await worker.runOne(), true);
    return getJob(connection.database, job.id)!;
  };

  try {
    seedEpisode(connection.database);
    const blocked = await run({ episodeId: "episode_tts" });
    assert.equal(blocked.status, "failed");
    assert.equal(syntheses, 0);

    changeScriptApproval(connection.database, "episode_tts", {
      action: "approve", expectedRevision: 0, scriptVersionId: "script_tts",
    });
    const first = await run({ episodeId: "episode_tts" });
    assert.equal(first.status, "succeeded");
    assert.equal(syntheses, 3);
    const result = first.result as {
      timelineHash: string; durationMs: number; segmentCount: number; cueCount: number;
      srtRelativePath: string; assRelativePath: string; reusedSegments: number;
    };
    assert.equal(result.durationMs, 3_750);
    assert.equal(result.segmentCount, 3);
    assert.equal(result.cueCount, 3);
    assert.equal(result.reusedSegments, 0);
    assert.equal(connection.database.prepare(
      "SELECT COUNT(*) AS count FROM audio_segments WHERE timeline_hash = ?",
    ).get(result.timelineHash)!.count, 3);
    const cues = connection.database.prepare(
      "SELECT start_ms, end_ms FROM subtitle_cues WHERE timeline_hash = ? ORDER BY cue_index",
    ).all(result.timelineHash) as unknown as Array<{ start_ms: number; end_ms: number }>;
    assert.deepEqual(cues.map((cue) => ({ ...cue })), [
      { start_ms: 0, end_ms: 1_250 },
      { start_ms: 1_250, end_ms: 2_500 },
      { start_ms: 2_500, end_ms: 3_750 },
    ]);
    assert.match(await readFile(join(dataRoot, result.srtRelativePath), "utf8"), /00:00:01,250 --> 00:00:02,500/);
    assert.match(await readFile(join(dataRoot, result.assRelativePath), "utf8"), /PlayResY: 1920/);

    const repeated = await run({ episodeId: "episode_tts" });
    assert.equal(repeated.status, "succeeded");
    assert.equal(syntheses, 3);
    assert.equal((repeated.result as { timelineHash: string }).timelineHash, result.timelineHash);
    assert.equal((repeated.result as { reusedSegments: number }).reusedSegments, 3);

    const changedVoice = await run({ episodeId: "episode_tts", voice: "测试音色" });
    assert.equal(changedVoice.status, "succeeded");
    assert.equal(syntheses, 6);
    assert.notEqual((changedVoice.result as { timelineHash: string }).timelineHash, result.timelineHash);

    const beforeCheckpointFailure = connection.database.prepare("SELECT COUNT(*) AS count FROM audio_segments").get()!.count;
    const faultJob = createJob(connection.database, {
      type: TTS_TIMELINE_JOB_TYPE, payload: { episodeId: "episode_tts", voice: "检查点失败音色" }, maxAttempts: 1,
    });
    const faultingHandler = createTtsTimelineJobHandler(connection.database, dataRoot, { synthesize, probe });
    await assert.rejects(faultingHandler({
      job: faultJob,
      reportProgress() {},
      isCancellationRequested: () => false,
      throwIfCancellationRequested() {},
      getCheckpoint: () => undefined,
      commitCheckpoint() { throw new Error("lease expired"); },
    } as JobExecutionContext), /lease expired/);
    assert.equal(connection.database.prepare("SELECT COUNT(*) AS count FROM audio_segments").get()!.count, beforeCheckpointFailure);
    assert.equal(connection.database.prepare("SELECT COUNT(*) AS count FROM subtitle_cues").get()!.count, beforeCheckpointFailure);
    connection.database.prepare("DELETE FROM jobs WHERE id = ?").run(faultJob.id);

    const beforeApprovalRace = connection.database.prepare("SELECT COUNT(*) AS count FROM audio_segments").get()!.count;
    const raceJob = createJob(connection.database, {
      type: TTS_TIMELINE_JOB_TYPE, payload: { episodeId: "episode_tts", voice: "撤回竞态音色" }, maxAttempts: 1,
    });
    const claimedRaceJob = claimNextJob(connection.database, "approval-race-test", 5_000, Date.now(), [TTS_TIMELINE_JOB_TYPE])!;
    assert.equal(claimedRaceJob.id, raceJob.id);
    const raceHandler = createTtsTimelineJobHandler(connection.database, dataRoot, { synthesize, probe });
    await assert.rejects(raceHandler({
      job: claimedRaceJob,
      reportProgress() {},
      isCancellationRequested: () => false,
      throwIfCancellationRequested() {},
      getCheckpoint: () => undefined,
      commitCheckpoint(stage, scopeKey, inputHash, writer) {
        changeScriptApproval(connection.database, "episode_tts", { action: "withdraw", expectedRevision: 1 });
        return commitCheckpoint(connection.database, {
          jobId: raceJob.id, stage, scopeKey, inputHash, workerId: "approval-race-test",
        }, writer);
      },
    } as JobExecutionContext), /未人工批准|批准稿已变化/);
    assert.equal(connection.database.prepare("SELECT COUNT(*) AS count FROM audio_segments").get()!.count, beforeApprovalRace);
    assert.equal(connection.database.prepare("SELECT COUNT(*) AS count FROM job_checkpoints WHERE job_id = ?").get(raceJob.id)!.count, 0);
    connection.database.prepare("DELETE FROM jobs WHERE id = ?").run(raceJob.id);
    changeScriptApproval(connection.database, "episode_tts", {
      action: "approve", expectedRevision: 2, scriptVersionId: "script_tts",
    });

    const beforeCancellation = connection.database.prepare("SELECT COUNT(*) AS count FROM audio_segments").get()!.count;
    let synthesisStarted!: () => void;
    const started = new Promise<void>((resolvePromise) => { synthesisStarted = resolvePromise; });
    const cancellingHandler = createTtsTimelineJobHandler(connection.database, dataRoot, {
      synthesize: (input) => new Promise((_, reject) => {
        synthesisStarted();
        input.signal?.addEventListener("abort", () => reject(new TtsCancelledError("测试取消")), { once: true });
      }),
      probe,
    });
    const cancellationJob = createJob(connection.database, {
      type: TTS_TIMELINE_JOB_TYPE, payload: { episodeId: "episode_tts", voice: "取消音色" }, maxAttempts: 1,
    });
    const cancellingWorker = new JobWorker(connection.database, { [TTS_TIMELINE_JOB_TYPE]: cancellingHandler }, {
      workerId: "tts-cancellation-test", leaseMs: 5_000, heartbeatMs: 100,
    });
    const running = cancellingWorker.runOne();
    await started;
    requestJobCancellation(connection.database, cancellationJob.id);
    await running;
    assert.equal(getJob(connection.database, cancellationJob.id)?.status, "cancelled");
    assert.equal(connection.database.prepare("SELECT COUNT(*) AS count FROM audio_segments").get()!.count, beforeCancellation);

    changeScriptApproval(connection.database, "episode_tts", { action: "withdraw", expectedRevision: 3 });
    const withdrawn = await run({ episodeId: "episode_tts" });
    assert.equal(withdrawn.status, "failed");
    assert.equal(syntheses, 12);
  } finally {
    connection.close();
    await rm(dataRoot, { recursive: true, force: true });
  }
});

test("默认任务 API 只为已批准稿创建语音时间轴任务", async () => {
  const dataRoot = await mkdtemp(join(tmpdir(), "narralume-tts-api-"));
  const seedConnection = openDatabase(dataRoot);
  seedEpisode(seedConnection.database);
  seedConnection.close();
  const app = buildApp({
    dataRoot,
    logger: false,
    jobPollMs: 5,
    jobHandlers: { [TTS_TIMELINE_JOB_TYPE]: async () => ({ accepted: true }) },
  });
  try {
    const blocked = await app.inject({
      method: "POST", url: "/api/jobs",
      payload: { type: TTS_TIMELINE_JOB_TYPE, payload: { episodeId: "episode_tts" } },
    });
    assert.equal(blocked.statusCode, 409);
    assert.match(blocked.json().message, /未人工批准/);

    const approvalConnection = openDatabase(dataRoot);
    changeScriptApproval(approvalConnection.database, "episode_tts", {
      action: "approve", expectedRevision: 0, scriptVersionId: "script_tts",
    });
    approvalConnection.close();
    const created = await app.inject({
      method: "POST", url: "/api/jobs",
      payload: { type: TTS_TIMELINE_JOB_TYPE, payload: { episodeId: "episode_tts" } },
    });
    assert.equal(created.statusCode, 201);
    assert.equal(created.json().job.type, TTS_TIMELINE_JOB_TYPE);
  } finally {
    await app.close();
    await rm(dataRoot, { recursive: true, force: true });
  }
});

test("语音时间轴消费当前 TTS runtime 并登记 provider 身份", async () => {
  const dataRoot = await mkdtemp(join(tmpdir(), "narralume-tts-runtime-"));
  const connection = openDatabase(dataRoot);
  try {
    seedEpisode(connection.database);
    changeScriptApproval(connection.database, "episode_tts", {
      action: "approve", expectedRevision: 0, scriptVersionId: "script_tts",
    });
    let consumedRuntime: RuntimeModelConfig | null | undefined;
    const handler = createTtsTimelineJobHandler(connection.database, dataRoot, {
      runtime: async () => edgeRuntime,
      synthesize: async (input) => {
        consumedRuntime = input.runtime;
        await writeFile(input.outputPath, Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(60, 8)]));
        return {
          providerId: edgeRuntime.providerId,
          voice: edgeRuntime.voiceId!,
          rate: input.rate!,
          inputHash: "x",
          outputPath: input.outputPath,
          bytes: 64,
          wordBoundaries: [{ part: "吴邪", startMs: 0, endMs: 400 }, { part: "墓道", startMs: 400, endMs: 900 }],
        };
      },
      probe: async (path) => ({ bytes: (await stat(path)).size, durationMs: 1_000 }),
    });
    const job = createJob(connection.database, { type: TTS_TIMELINE_JOB_TYPE, payload: { episodeId: "episode_tts" }, maxAttempts: 1 });
    const worker = new JobWorker(connection.database, { [TTS_TIMELINE_JOB_TYPE]: handler }, {
      workerId: "tts-runtime", leaseMs: 5_000, heartbeatMs: 50,
    });
    assert.equal(await worker.runOne(), true);
    assert.equal(getJob(connection.database, job.id)?.status, "succeeded");
    assert.equal(consumedRuntime?.providerId, "edge-tts");
    const rows = connection.database.prepare(
      "SELECT provider_id, voice FROM audio_segments WHERE episode_id = ?",
    ).all("episode_tts") as unknown as Array<{ provider_id: string; voice: string }>;
    assert(rows.length > 0);
    assert(rows.every((row) => row.provider_id === "edge-tts" && row.voice === "zh-CN-YunjianNeural"));
    const cues = connection.database.prepare(
      "SELECT segment_index, start_ms, end_ms, text FROM subtitle_cues WHERE episode_id = ? ORDER BY cue_index LIMIT 1",
    ).all("episode_tts") as unknown as Array<{ segment_index: number; start_ms: number; end_ms: number; text: string }>;
    assert.equal(cues[0]?.segment_index, 0);
    assert.equal(cues[0]?.start_ms, 0);
    assert.equal(cues[0]?.end_ms, 900);
    assert.notEqual(cues[0]?.text, "吴邪");
    assert.notEqual(cues[0]?.text, "墓道");
    const result = getJob(connection.database, job.id)?.result as { srtRelativePath: string };
    assert.doesNotMatch(await readFile(join(dataRoot, result.srtRelativePath), "utf8"), /^吴邪$/mu);
  } finally {
    connection.close();
    await rm(dataRoot, { recursive: true, force: true });
  }
});
