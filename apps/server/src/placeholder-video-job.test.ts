import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, stat, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import { commitCheckpoint } from "./checkpoint-store.js";
import { openDatabase } from "./database.js";
import { createJob, getJob, requestJobCancellation, claimNextJob } from "./job-store.js";
import { JobCancelledError, JobWorker, type JobExecutionContext } from "./job-worker.js";
import { createPlaceholderVideoJobHandler, PLACEHOLDER_VIDEO_JOB_TYPE } from "./placeholder-video-job.js";
import { changeScriptApproval } from "./script-approval-store.js";

const TIMELINE_HASH = "a".repeat(64);

function hash(content: string) {
  return createHash("sha256").update(content).digest("hex");
}

async function seed(dataRoot: string, database: ReturnType<typeof openDatabase>["database"]) {
  database.prepare(
    `INSERT INTO books (id, title, original_file_path, original_file_hash, encoding, import_status)
     VALUES ('book_video', '测试书', 'book.txt', ?, 'utf-8', 'ready')`,
  ).run("1".repeat(64));
  database.prepare(
    `INSERT INTO series_projects (id, book_id, title, created_at, updated_at)
     VALUES ('series_video', 'book_video', '测试系列', 1, 1)`,
  ).run();
  database.prepare(
    `INSERT INTO episodes (
      id, series_project_id, episode_index, title, story_arc, target_duration_seconds, created_at, updated_at
    ) VALUES ('episode_video', 'series_video', 1, '第一集', '测试故事弧', 240, 1, 1)`,
  ).run();
  database.prepare(
    `INSERT INTO script_versions (
      id, episode_id, kind, version, parent_version_id, content_json, content_hash, created_at
    ) VALUES ('script_video', 'episode_video', 'packaged', 1, NULL, ?, ?, 1)`,
  ).run(JSON.stringify({ paragraphs: [{ text: "第一段" }, { text: "第二段" }] }), "2".repeat(64));
  changeScriptApproval(database, "episode_video", {
    action: "approve", expectedRevision: 0, scriptVersionId: "script_video",
  });

  const audioDirectory = join(dataRoot, "episodes", "episode_video", "audio");
  await mkdir(join(audioDirectory, "segments"), { recursive: true });
  for (const [index, content] of ["audio-one", "audio-two"].entries()) {
    const inputHash = String(index + 3).repeat(64);
    const relativePath = `episodes/episode_video/audio/segments/${inputHash}.wav`;
    await writeFile(join(dataRoot, relativePath), content);
    database.prepare(
      `INSERT INTO audio_segments (
        timeline_hash, segment_index, episode_id, script_version_id, text, provider_id, voice, rate,
        input_hash, relative_path, file_hash, bytes, duration_ms, created_at
      ) VALUES (?, ?, 'episode_video', 'script_video', ?, 'test', 'test', 0, ?, ?, ?, ?, 1250, 1)`,
    ).run(TIMELINE_HASH, index, `第${index + 1}段`, inputHash, relativePath, hash(content), content.length);
    database.prepare(
      `INSERT INTO subtitle_cues (
        timeline_hash, cue_index, segment_index, episode_id, script_version_id, start_ms, end_ms, text
      ) VALUES (?, ?, ?, 'episode_video', 'script_video', ?, ?, ?)`,
    ).run(TIMELINE_HASH, index, index, index * 1_250, (index + 1) * 1_250, `第${index + 1}段`);
  }
  await writeFile(join(audioDirectory, `${TIMELINE_HASH}.ass`),
    "[Script Info]\nScriptType: v4.00+\n[Events]\nDialogue: first\nDialogue: second\n");
}

test("占位视频宽流程覆盖成功、复用、坏音频、取消和批准竞态", async () => {
  const dataRoot = await mkdtemp(join(tmpdir(), "narralume-placeholder-video-"));
  const connection = openDatabase(dataRoot);
  try {
    await seed(dataRoot, connection.database);
    let renders = 0;
    const probeAudio = async (path: string) => ({ bytes: (await stat(path)).size, durationMs: 1_250 });
    const probeVideo = async (path: string) => ({ bytes: (await stat(path)).size, durationMs: 2_500 });
    const render = async ({ concatPath, outputPath }: { concatPath: string; outputPath: string }) => {
      const list = await readFile(concatPath, "utf8");
      assert.match(list, /^ffconcat version 1\.0\nfile '\.\.\/audio\/segments\/3{64}\.wav'/);
      renders += 1;
      await writeFile(outputPath, "fake-mp4");
    };
    const handler = createPlaceholderVideoJobHandler(connection.database, dataRoot, { probeAudio, probeVideo, render });
    const run = async () => {
      const job = createJob(connection.database, {
        type: PLACEHOLDER_VIDEO_JOB_TYPE,
        payload: { episodeId: "episode_video", timelineHash: TIMELINE_HASH },
        maxAttempts: 1,
      });
      const worker = new JobWorker(connection.database, { [PLACEHOLDER_VIDEO_JOB_TYPE]: handler }, {
        workerId: `video-test-${job.id}`, leaseMs: 5_000, heartbeatMs: 100,
      });
      assert.equal(await worker.runOne(), true);
      return getJob(connection.database, job.id)!;
    };

    const first = await run();
    assert.equal(first.status, "succeeded");
    assert.equal(renders, 1);
    assert.equal((first.result as { reused: boolean; durationMs: number }).reused, false);
    assert.equal((first.result as { durationMs: number }).durationMs, 2_500);
    assert.equal(connection.database.prepare(
      "SELECT COUNT(*) AS count FROM job_checkpoints WHERE job_id = ?",
    ).get(first.id)!.count, 1);

    const repeated = await run();
    assert.equal(repeated.status, "succeeded");
    assert.equal((repeated.result as { reused: boolean }).reused, true);
    assert.equal(renders, 1);

    connection.database.prepare(
      "UPDATE audio_segments SET file_hash = ? WHERE timeline_hash = ? AND segment_index = 1",
    ).run("f".repeat(64), TIMELINE_HASH);
    const corrupted = await run();
    assert.equal(corrupted.status, "failed");
    assert.match(corrupted.errorMessage ?? "", /登记信息不一致/);
    assert.equal(renders, 1);
    connection.database.prepare(
      "UPDATE audio_segments SET file_hash = ? WHERE timeline_hash = ? AND segment_index = 1",
    ).run(hash("audio-two"), TIMELINE_HASH);

    connection.database.prepare(
      "DELETE FROM subtitle_cues WHERE timeline_hash = ? AND cue_index = 1",
    ).run(TIMELINE_HASH);
    const missingCue = await run();
    assert.equal(missingCue.status, "failed");
    assert.match(missingCue.errorMessage ?? "", /缺少完整分段/);
    assert.equal(renders, 1);
    connection.database.prepare(
      `INSERT INTO subtitle_cues (
        timeline_hash, cue_index, segment_index, episode_id, script_version_id, start_ms, end_ms, text
      ) VALUES (?, 1, 1, 'episode_video', 'script_video', 1250, 2500, '第二段')`,
    ).run(TIMELINE_HASH);

    const cancellationJob = createJob(connection.database, {
      type: PLACEHOLDER_VIDEO_JOB_TYPE,
      payload: { episodeId: "episode_video", timelineHash: TIMELINE_HASH }, maxAttempts: 1,
    });
    const existingPath = join(dataRoot, (first.result as { relativePath: string }).relativePath);
    await rm(existingPath);
    let renderingStarted!: () => void;
    const started = new Promise<void>((resolvePromise) => { renderingStarted = resolvePromise; });
    const cancellingHandler = createPlaceholderVideoJobHandler(connection.database, dataRoot, {
      probeAudio,
      probeVideo,
      render: async ({ outputPath, signal }) => {
        await writeFile(outputPath, "partial");
        renderingStarted();
        await new Promise<void>((_, reject) => signal.addEventListener("abort", () => {
          setTimeout(() => reject(new JobCancelledError()), 20);
        }, { once: true }));
      },
    });
    const cancellingWorker = new JobWorker(connection.database, { [PLACEHOLDER_VIDEO_JOB_TYPE]: cancellingHandler }, {
      workerId: "video-cancel-test", leaseMs: 5_000, heartbeatMs: 100,
    });
    const running = cancellingWorker.runOne();
    await started;
    requestJobCancellation(connection.database, cancellationJob.id);
    await running;
    assert.equal(getJob(connection.database, cancellationJob.id)?.status, "cancelled");
    assert.equal(connection.database.prepare(
      "SELECT COUNT(*) AS count FROM job_checkpoints WHERE job_id = ?",
    ).get(cancellationJob.id)!.count, 0);
    const videoDirectory = dirname(existingPath);
    assert.deepEqual((await readdir(videoDirectory)).filter((name) => name.includes(".tmp.")), []);

    const raceJob = createJob(connection.database, {
      type: PLACEHOLDER_VIDEO_JOB_TYPE,
      payload: { episodeId: "episode_video", timelineHash: TIMELINE_HASH }, maxAttempts: 1,
    });
    const claimed = claimNextJob(connection.database, "video-race-test", 5_000, Date.now(), [PLACEHOLDER_VIDEO_JOB_TYPE])!;
    assert.equal(claimed.id, raceJob.id);
    await assert.rejects(handler({
      job: claimed,
      reportProgress() {},
      isCancellationRequested: () => false,
      throwIfCancellationRequested() {},
      getCheckpoint: () => undefined,
      commitCheckpoint(stage, scopeKey, inputHash, writer) {
        changeScriptApproval(connection.database, "episode_video", { action: "withdraw", expectedRevision: 1 });
        return commitCheckpoint(connection.database, {
          jobId: raceJob.id, stage, scopeKey, inputHash, workerId: "video-race-test",
        }, writer);
      },
    } as JobExecutionContext), /稿件未人工批准|批准稿已变化/);
    assert.equal(connection.database.prepare(
      "SELECT COUNT(*) AS count FROM job_checkpoints WHERE job_id = ?",
    ).get(raceJob.id)!.count, 0);
  } finally {
    connection.close();
    await rm(dataRoot, { recursive: true, force: true });
  }
});
