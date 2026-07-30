import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { openDatabase } from "../database.js";
import { createFinalVideoJobHandler, exportFinalVideo, FINAL_VIDEO_JOB_TYPE, type FinalVideoManifest } from "../final-video.js";
import { probeNineSixteenVideo } from "../ffmpeg-video.js";
import { createJob, getJob } from "../job-store.js";
import { JobWorker } from "../job-worker.js";

await import("./p6-render-chunks-gate.js");

const dataRoot = fileURLToPath(new URL("../../../../data/gates/p6-render-chunks", import.meta.url));
const hash = (value: Uint8Array | string) => createHash("sha256").update(value).digest("hex");
let connection = openDatabase(dataRoot);

async function runFinal(workerId: string) {
  const current = connection.database.prepare(
    "SELECT episode_id, timeline_hash FROM render_chunks ORDER BY created_at DESC LIMIT 1",
  ).get() as { episode_id: string; timeline_hash: string };
  const created = createJob(connection.database, { type: FINAL_VIDEO_JOB_TYPE,
    payload: { episodeId: current.episode_id, timelineHash: current.timeline_hash }, maxAttempts: 1 });
  const worker = new JobWorker(connection.database, {
    [FINAL_VIDEO_JOB_TYPE]: createFinalVideoJobHandler(connection.database, dataRoot),
  }, { workerId, leaseMs: 1_800_000, heartbeatMs: 10_000 });
  assert.equal(await worker.runOne(), true);
  const job = getJob(connection.database, created.id)!;
  assert.equal(job.status, "succeeded", job.errorMessage ?? "最终导出失败");
  return job.result as {
    episodeId: string; timelineHash: string; finalHash: string; manifestRelativePath: string;
    video: { relativePath: string; fileHash: string; bytes: number; durationMs: number }; reused: boolean;
  };
}

try {
  const first = await runFinal("p6-final-first");
  assert.equal(first.reused, false);
  const videoPath = join(dataRoot, ...first.video.relativePath.split("/"));
  const manifestPath = join(dataRoot, ...first.manifestRelativePath.split("/"));
  const firstVideo = await readFile(videoPath);
  const firstManifest = await readFile(manifestPath);
  const firstMtime = (await stat(videoPath)).mtimeMs;
  assert.equal(first.video.bytes, firstVideo.length);
  assert.equal(first.video.fileHash, hash(firstVideo));
  const probe = await probeNineSixteenVideo(videoPath);
  assert.equal(probe.bytes, first.video.bytes);
  assert.equal(probe.durationMs, first.video.durationMs);

  const manifest = JSON.parse(firstManifest.toString("utf8")) as FinalVideoManifest;
  assert.equal(manifest.version, "final-export-v1");
  assert.equal(manifest.exportHash, first.finalHash);
  assert.equal(manifest.finalVideo.relativePath, first.video.relativePath);
  assert.equal(manifest.finalVideo.fileHash, hash(firstVideo));
  assert.equal(manifest.chunks[0]?.startMs, 0);
  assert.ok(Math.abs(manifest.chunks.at(-1)!.endMs - manifest.finalVideo.durationMs) <= 1_000);
  for (const chunk of manifest.chunks) {
    const bytes = await readFile(join(dataRoot, ...chunk.relativePath.split("/")));
    assert.equal(bytes.length, chunk.bytes);
    assert.equal(hash(bytes), chunk.fileHash);
  }
  const serialized = JSON.stringify(manifest);
  assert.equal(serialized.includes(dataRoot), false);
  for (const forbidden of ["generatedAt", "mtime", "randomUUID", "ffmpegVersion"]) assert.equal(serialized.includes(forbidden), false);

  connection.close();
  connection = openDatabase(dataRoot);
  const restarted = await runFinal("p6-final-restart");
  assert.equal(restarted.reused, true);
  assert.deepEqual(await readFile(videoPath), firstVideo);
  assert.deepEqual(await readFile(manifestPath), firstManifest);
  assert.equal((await stat(videoPath)).mtimeMs, firstMtime);

  const extraHash = "f".repeat(64);
  connection.database.prepare(`INSERT INTO render_chunks (render_hash,episode_id,timeline_hash,chunk_index,
    script_version_id,approval_revision,start_ms,end_ms,relative_path,file_hash,bytes,duration_ms,created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(extraHash, first.episodeId, first.timelineHash, 99,
    manifest.scriptVersionId, manifest.approvalRevision, manifest.finalVideo.durationMs,
    manifest.finalVideo.durationMs + 60_000, "obsolete.mp4", extraHash, 1, 60_000, 1);
  assert.equal((await runFinal("p6-final-obsolete-row")).reused, true);

  connection.database.exec("BEGIN");
  connection.database.prepare("DELETE FROM render_chunks WHERE episode_id = ? AND timeline_hash = ? AND chunk_index = 0")
    .run(first.episodeId, first.timelineHash);
  await assert.rejects(exportFinalVideo(connection.database, dataRoot,
    { episodeId: first.episodeId, timelineHash: first.timelineHash }), /尚未全部渲染/);
  connection.database.exec("ROLLBACK");

  const firstChunk = manifest.chunks[0]!;
  const firstChunkPath = join(dataRoot, ...firstChunk.relativePath.split("/"));
  const originalChunk = await readFile(firstChunkPath);
  await writeFile(firstChunkPath, "tampered");
  await assert.rejects(exportFinalVideo(connection.database, dataRoot,
    { episodeId: first.episodeId, timelineHash: first.timelineHash }), /分片文件与登记信息不一致/);
  assert.deepEqual(await readFile(videoPath), firstVideo);
  assert.deepEqual(await readFile(manifestPath), firstManifest);
  await writeFile(firstChunkPath, originalChunk);

  console.log("P6-03 真实 concat、最终清单与重启确定性门禁通过");
  console.log(`final_hash=${first.finalHash}`);
  console.log(`duration_ms=${first.video.durationMs}`);
  console.log(`video_bytes=${first.video.bytes}`);
  console.log(`chunks=${manifest.chunks.length}`);
  console.log(`video_path=${videoPath}`);
  console.log(`manifest_path=${manifestPath}`);
  console.log("restart_byte_stable=true");
  console.log("obsolete_row_ignored=true");
  console.log("missing_or_tampered_chunk_blocked=true");
} finally {
  try { connection.database.exec("ROLLBACK"); } catch { /* 没有活动事务。 */ }
  connection.close();
}
