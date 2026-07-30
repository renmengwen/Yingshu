import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { rename, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { openDatabase } from "../database.js";
import { exportFinalVideo } from "../final-video.js";
import { probeNineSixteenVideo } from "../ffmpeg-video.js";
import { createJob, getJob, requestJobCancellation } from "../job-store.js";
import { JobWorker } from "../job-worker.js";
import { createRenderChunksJobHandler, RENDER_CHUNKS_JOB_TYPE } from "../render-chunk-job.js";
import { putVisualSegment, assertVisualPlanReady, type VisualMotionKind } from "../visual-segment-store.js";

const serverRoot = fileURLToPath(new URL("../../", import.meta.url));
const dataRoot = fileURLToPath(new URL("../../../../data/gates/p6-render-chunks", import.meta.url));
const workerPath = fileURLToPath(new URL("./p6-render-recovery-worker.ts", import.meta.url));
const hash = (value: Uint8Array | string) => createHash("sha256").update(value).digest("hex");
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

interface Chunk {
  chunkIndex: number;
  renderHash: string;
  startMs: number;
  endMs: number;
  durationMs: number;
  bytes: number;
  fileHash: string;
  relativePath: string;
  reused: boolean;
}

interface RenderResult { timelineHash: string; chunks: Chunk[] }
interface Snapshot extends Chunk { mtimeMs: number; content: Buffer }

function absolute(relativePath: string) {
  return join(dataRoot, ...relativePath.split("/"));
}

async function snapshot(chunks: Chunk[]) {
  return new Map(await Promise.all(chunks.map(async (chunk) => [chunk.chunkIndex, {
    ...chunk,
    content: await readFile(absolute(chunk.relativePath)),
    mtimeMs: (await stat(absolute(chunk.relativePath))).mtimeMs,
  }] as const)));
}

async function runRender(connection: ReturnType<typeof openDatabase>, episodeId: string, timelineHash: string, workerId: string) {
  const created = createJob(connection.database, {
    type: RENDER_CHUNKS_JOB_TYPE, payload: { episodeId, timelineHash }, maxAttempts: 1,
  });
  const worker = new JobWorker(connection.database, {
    [RENDER_CHUNKS_JOB_TYPE]: createRenderChunksJobHandler(connection.database, dataRoot),
  }, { workerId, leaseMs: 1_800_000, heartbeatMs: 10_000 });
  assert.equal(await worker.runOne(), true);
  const job = getJob(connection.database, created.id)!;
  assert.equal(job.status, "succeeded", job.errorMessage ?? "分片任务失败");
  return job.result as unknown as RenderResult;
}

async function waitForCheckpoint(connection: ReturnType<typeof openDatabase>, jobId: string) {
  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline) {
    const count = (connection.database.prepare(
      "SELECT COUNT(*) AS count FROM job_checkpoints WHERE job_id = ? AND stage = 'render-chunk'",
    ).get(jobId) as { count: number }).count;
    if (count >= 1) return;
    await sleep(50);
  }
  throw new Error("等待首个分片 checkpoint 超时");
}

async function waitForStatus(connection: ReturnType<typeof openDatabase>, jobId: string, status: string) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (getJob(connection.database, jobId)?.status === status) return;
    await sleep(25);
  }
  throw new Error(`等待任务状态 ${status} 超时`);
}

async function hardKillTree(pid: number) {
  spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true, encoding: "utf8" });
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try { process.kill(pid, 0); } catch { return; }
    await sleep(50);
  }
  throw new Error(`硬退出后子 Worker 仍然存活：${pid}`);
}

async function waitForChildExit(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`等待子进程退出超时：${child.pid ?? "unknown"}`)), 30_000);
    child.once("exit", () => { clearTimeout(timeout); resolve(); });
  });
}

async function cleanupChildTree(child: ChildProcess) {
  if (child.pid && child.exitCode === null && child.signalCode === null) await hardKillTree(child.pid);
  await waitForChildExit(child);
}

async function withChildLifecycle<T>(child: ChildProcess, action: (child: ChildProcess) => Promise<T>) {
  let actionFailed = false;
  try {
    return await action(child);
  } catch (error) {
    actionFailed = true;
    throw error;
  } finally {
    try { await cleanupChildTree(child); } catch (cleanupError) {
      if (!actionFailed) throw cleanupError;
    }
  }
}

function assertProcessStopped(pid: number) {
  let alive = true;
  try { process.kill(pid, 0); } catch { alive = false; }
  assert.equal(alive, false, `子进程仍然存活：${pid}`);
}

async function proveWaitFailureCleanup(kind: "checkpoint" | "status") {
  const script = `
    import { spawn } from "node:child_process";
    const child = spawn("ffmpeg", ["-v", "error", "-re", "-f", "lavfi", "-i",
      "color=c=black:s=16x16:r=1", "-f", "null", "-"], { stdio: "ignore", windowsHide: true });
    console.log(child.pid);
    setInterval(() => undefined, 1000);
  `;
  const child = spawn(process.execPath, ["--input-type=module", "-e", script], {
    windowsHide: true, stdio: ["ignore", "pipe", "ignore"],
  });
  assert.ok(child.pid);
  const workerPid = child.pid;
  let ffmpegPid = 0;
  await assert.rejects(withChildLifecycle(child, async () => {
    ffmpegPid = await new Promise<number>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("等待故障注入 FFmpeg PID 超时")), 5_000);
      child.stdout!.once("data", (data: Buffer) => {
        clearTimeout(timeout);
        const pid = Number.parseInt(data.toString("utf8").trim(), 10);
        if (Number.isSafeInteger(pid) && pid > 0) resolve(pid);
        else reject(new Error("故障注入 FFmpeg PID 无效"));
      });
    });
    throw new Error(`注入 ${kind} 等待失败`);
  }), new RegExp(`注入 ${kind} 等待失败`, "u"));
  assertProcessStopped(workerPid);
  assertProcessStopped(ffmpegPid);
}

function assertStable(before: Snapshot, after: Chunk) {
  assert.deepEqual(
    { path: after.relativePath, hash: after.fileHash, bytes: after.bytes },
    { path: before.relativePath, hash: before.fileHash, bytes: before.bytes },
  );
}

await proveWaitFailureCleanup("checkpoint");
await proveWaitFailureCleanup("status");
if (process.env.YINGSHU_P6_RECOVERY_CLEANUP_CHECK === "1") {
  console.log("P6-04 子进程等待失败清理门禁通过");
  process.exit(0);
}

const seeded = spawnSync(process.execPath, ["--no-warnings", "--import", "tsx", "src/gates/p6-render-chunks-gate.ts"], {
  cwd: serverRoot, windowsHide: true, encoding: "utf8", maxBuffer: 2 * 1024 * 1024,
});
assert.equal(seeded.status, 0, seeded.stderr || seeded.stdout);

let connection = openDatabase(dataRoot);
try {
  const current = connection.database.prepare(
    "SELECT episode_id, timeline_hash FROM render_chunks ORDER BY chunk_index LIMIT 1",
  ).get() as { episode_id: string; timeline_hash: string };
  const baseline = await runRender(connection, current.episode_id, current.timeline_hash, "p6-recovery-baseline");
  assert.ok(baseline.chunks.length >= 2);
  assert.equal(baseline.chunks.every((chunk) => chunk.reused), true);
  const baselineFiles = await snapshot(baseline.chunks);

  const damagedForCrash = baseline.chunks[1]!;
  await writeFile(absolute(damagedForCrash.relativePath), "crash-injection");
  const crashJob = createJob(connection.database, {
    type: RENDER_CHUNKS_JOB_TYPE,
    payload: { episodeId: current.episode_id, timelineHash: current.timeline_hash },
    maxAttempts: 3,
    priority: 100,
  });
  const child = spawn(process.execPath, ["--no-warnings", "--import", "tsx", workerPath, dataRoot, crashJob.id], {
    cwd: serverRoot, windowsHide: true, stdio: "ignore",
  });
  await withChildLifecycle(child, async () => {
    assert.ok(child.pid);
    await waitForCheckpoint(connection, crashJob.id);
    await hardKillTree(child.pid);
    await waitForChildExit(child);
    assert.equal(getJob(connection.database, crashJob.id)?.status, "running");
  });

  await sleep(2_100);
  const recoveryWorker = new JobWorker(connection.database, {
    [RENDER_CHUNKS_JOB_TYPE]: createRenderChunksJobHandler(connection.database, dataRoot),
  }, { workerId: "p6-recovery-resume", leaseMs: 1_800_000, heartbeatMs: 10_000 });
  assert.equal(await recoveryWorker.runOne(), true);
  const recoveredJob = getJob(connection.database, crashJob.id)!;
  assert.equal(recoveredJob.status, "succeeded", recoveredJob.errorMessage ?? "租约恢复失败");
  const recovered = recoveredJob.result as unknown as RenderResult;
  assert.equal(recovered.chunks[0]!.reused, true);
  assert.equal(recovered.chunks[1]!.reused, false);
  const trusted = baselineFiles.get(0)!;
  assertStable(trusted, recovered.chunks[0]!);
  assert.deepEqual(await readFile(absolute(trusted.relativePath)), trusted.content);
  assert.equal((await stat(absolute(trusted.relativePath))).mtimeMs, trusted.mtimeMs);

  const beforeCorruption = await snapshot(recovered.chunks);
  const corruptTarget = recovered.chunks[0]!;
  await writeFile(absolute(corruptTarget.relativePath), "corrupt-one-chunk");
  const repaired = await runRender(connection, current.episode_id, current.timeline_hash, "p6-recovery-corruption");
  assert.equal(repaired.chunks[0]!.reused, false);
  assert.equal(repaired.chunks.slice(1).every((chunk) => chunk.reused), true);
  for (const chunk of repaired.chunks.slice(1)) {
    const before = beforeCorruption.get(chunk.chunkIndex)!;
    assertStable(before, chunk);
    assert.deepEqual(await readFile(absolute(chunk.relativePath)), before.content);
    assert.equal((await stat(absolute(chunk.relativePath))).mtimeMs, before.mtimeMs);
  }

  const oldFinal = await exportFinalVideo(connection.database, dataRoot, {
    episodeId: current.episode_id, timelineHash: current.timeline_hash,
  });
  const oldFinalBytes = await readFile(oldFinal.finalPath);
  const oldFinalMtime = (await stat(oldFinal.finalPath)).mtimeMs;

  const beforeVisualChange = await snapshot(repaired.chunks);
  const middle = repaired.chunks[Math.floor(repaired.chunks.length / 2)]!;
  const visual = assertVisualPlanReady(connection.database, current.episode_id, current.timeline_hash)
    .find((item) => item.startMs >= middle.startMs && item.endMs <= middle.endMs)!;
  const changedMotion: VisualMotionKind = visual.motionKind === "zoom-out" ? "pan-left" : "zoom-out";
  putVisualSegment(connection.database, current.episode_id, visual.segmentIndex, {
    timelineHash: current.timeline_hash,
    cueStartIndex: visual.cueStartIndex,
    cueEndIndex: visual.cueEndIndex,
    motionKind: changedMotion,
    motionAmountPpm: 41_000,
    fadeMs: visual.fadeMs,
    expectedRevision: visual.revision,
    assets: visual.assets.map((item) => ({ assetId: item.assetId, selectedCandidateId: item.selectedCandidateId ?? undefined })),
  });
  const changed = await runRender(connection, current.episode_id, current.timeline_hash, "p6-recovery-visual-change");
  for (const chunk of changed.chunks) {
    const before = beforeVisualChange.get(chunk.chunkIndex)!;
    if (chunk.chunkIndex === middle.chunkIndex) {
      assert.equal(chunk.reused, false);
      assert.notEqual(chunk.renderHash, before.renderHash);
      assert.notEqual(chunk.relativePath, before.relativePath);
    } else {
      assert.equal(chunk.reused, true);
      assertStable(before, chunk);
      assert.deepEqual(await readFile(absolute(chunk.relativePath)), before.content);
      assert.equal((await stat(absolute(chunk.relativePath))).mtimeMs, before.mtimeMs);
    }
  }

  const newFinal = await exportFinalVideo(connection.database, dataRoot, {
    episodeId: current.episode_id, timelineHash: current.timeline_hash,
  });
  assert.notEqual(newFinal.manifest.exportHash, oldFinal.manifest.exportHash);
  assert.notEqual(newFinal.finalPath, oldFinal.finalPath);
  assert.deepEqual(await readFile(oldFinal.finalPath), oldFinalBytes);
  assert.equal((await stat(oldFinal.finalPath)).mtimeMs, oldFinalMtime);
  assert.equal(newFinal.manifest.chunks[middle.chunkIndex]!.renderHash, changed.chunks[middle.chunkIndex]!.renderHash);
  const finalBytes = await readFile(newFinal.finalPath);

  const currentChunkPath = absolute(changed.chunks[0]!.relativePath);
  const missingChunkPath = `${currentChunkPath}.missing`;
  await rename(currentChunkPath, missingChunkPath);
  try {
    await assert.rejects(exportFinalVideo(connection.database, dataRoot, {
      episodeId: current.episode_id, timelineHash: current.timeline_hash,
    }), /分片文件与登记信息不一致/);
    assert.deepEqual(await readFile(newFinal.finalPath), finalBytes);
  } finally {
    await rename(missingChunkPath, currentChunkPath);
  }

  const cancelTarget = changed.chunks[1]!;
  await writeFile(absolute(cancelTarget.relativePath), "cancel-injection");
  const cancelJob = createJob(connection.database, {
    type: RENDER_CHUNKS_JOB_TYPE,
    payload: { episodeId: current.episode_id, timelineHash: current.timeline_hash },
    maxAttempts: 1,
    priority: 100,
  });
  const cancellingChild = spawn(process.execPath,
    ["--no-warnings", "--import", "tsx", workerPath, dataRoot, cancelJob.id], {
      cwd: serverRoot, windowsHide: true, stdio: "ignore",
    });
  await withChildLifecycle(cancellingChild, async () => {
    await waitForStatus(connection, cancelJob.id, "running");
    assert.equal(requestJobCancellation(connection.database, cancelJob.id)?.cancelRequested, true);
    await waitForChildExit(cancellingChild);
  });
  assert.equal(getJob(connection.database, cancelJob.id)?.status, "cancelled");
  assert.deepEqual(await readFile(newFinal.finalPath), finalBytes);
  const afterCancel = await runRender(connection, current.episode_id, current.timeline_hash, "p6-recovery-after-cancel");
  assert.equal(afterCancel.chunks.length, changed.chunks.length);

  const audio = connection.database.prepare(
    "SELECT relative_path FROM audio_segments WHERE episode_id = ? AND timeline_hash = ? ORDER BY segment_index LIMIT 1",
  ).get(current.episode_id, current.timeline_hash) as { relative_path: string };
  const audioPath = absolute(audio.relative_path);
  const hiddenAudio = `${audioPath}.missing`;
  await rename(audioPath, hiddenAudio);
  try {
    const missing = createJob(connection.database, {
      type: RENDER_CHUNKS_JOB_TYPE,
      payload: { episodeId: current.episode_id, timelineHash: current.timeline_hash },
      maxAttempts: 1,
    });
    const worker = new JobWorker(connection.database, {
      [RENDER_CHUNKS_JOB_TYPE]: createRenderChunksJobHandler(connection.database, dataRoot),
    }, { workerId: "p6-recovery-missing-input", leaseMs: 1_800_000, heartbeatMs: 10_000 });
    assert.equal(await worker.runOne(), true);
    assert.equal(getJob(connection.database, missing.id)?.status, "failed");
  } finally {
    await rename(hiddenAudio, audioPath);
  }

  const manifestBytes = await readFile(newFinal.manifestPath);
  const probe = await probeNineSixteenVideo(newFinal.finalPath);
  assert.ok(probe.durationMs >= 180_000 && probe.durationMs <= 300_000);
  assert.equal(probe.bytes, finalBytes.length);
  assert.equal(newFinal.manifest.finalVideo.fileHash, hash(finalBytes));
  const decoded = spawnSync("ffmpeg", ["-v", "error", "-i", newFinal.finalPath, "-map", "0:v:0", "-map", "0:a:0", "-f", "null", "-"], {
    windowsHide: true, encoding: "utf8", maxBuffer: 1024 * 1024,
  });
  assert.equal(decoded.status, 0, decoded.stderr);

  console.log("P6-04 真实渲染硬退出、局部恢复与最终成片门禁通过");
  console.log(`timeline_hash=${current.timeline_hash}`);
  console.log(`duration_ms=${probe.durationMs}`);
  console.log(`chunks=${changed.chunks.length}`);
  console.log(`hard_exit_job=${crashJob.id}`);
  console.log("trusted_completed_chunk_reused=true");
  console.log("corruption_rerendered_only_target=true");
  console.log(`visual_change_target_chunk=${middle.chunkIndex}`);
  console.log("visual_change_preserved_non_target_path_hash_bytes_mtime=true");
  console.log(`old_final_hash=${oldFinal.manifest.exportHash}`);
  console.log(`current_final_hash=${newFinal.manifest.exportHash}`);
  console.log(`video_sha256=${hash(finalBytes)}`);
  console.log(`manifest_sha256=${hash(manifestBytes)}`);
  console.log(`video_path=${newFinal.finalPath}`);
  console.log(`manifest_path=${newFinal.manifestPath}`);
  console.log("missing_input_failed=true");
  console.log("missing_chunk_blocked=true");
  console.log("cancelled_render_not_succeeded=true");
  console.log("full_decode=true");
} finally {
  connection.close();
}
