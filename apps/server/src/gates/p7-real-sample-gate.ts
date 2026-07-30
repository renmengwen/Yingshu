import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, readFile, rm, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { appendAssetCandidateReview, registerAssetCandidate } from "../asset-candidate-store.js";
import { createAsset } from "../asset-store.js";
import { openDatabase } from "../database.js";
import {
  createFinalVideoJobHandler,
  FINAL_VIDEO_JOB_TYPE,
  type FinalVideoManifest,
} from "../final-video.js";
import { probeNineSixteenVideo } from "../ffmpeg-video.js";
import { createJob, getJob, type JobRecord } from "../job-store.js";
import { JobWorker, type JobHandler } from "../job-worker.js";
import { createRenderChunksJobHandler, RENDER_CHUNKS_JOB_TYPE } from "../render-chunk-job.js";
import { requireApprovedScriptForProduction } from "../script-approval-store.js";
import { createTtsTimelineJobHandler, TTS_TIMELINE_JOB_TYPE } from "../tts-timeline-job.js";
import { assertVisualPlanReady, putVisualSegment, type VisualMotionKind } from "../visual-segment-store.js";

const SOURCE_SHA256 = "ff1526996bf4b81807651921a85e5c1c0f1d1d123c9fa4553057ba6a3ec72011";
const IMAGE_SHA256 = "e6ce4d3aa60094f5aa6ee34fc680c008196e363204ed17234fd8172ca65ae471";
const IMAGE_BYTES = 1_038_668;
const repositoryRoot = fileURLToPath(new URL("../../../../", import.meta.url));
const dataRoot = resolve(process.env.YINGSHU_P7_GATE_DATA_ROOT ??
  resolve(repositoryRoot, "data/gates/p7-real-sample"));
const historicalImagePath = "D:\\code3\\Narralume\\data\\gates\\p5-candidates\\assets\\candidates\\e6\\e6ce4d3aa60094f5aa6ee34fc680c008196e363204ed17234fd8172ca65ae471.jpg";
const hash = (value: Uint8Array | string) => createHash("sha256").update(value).digest("hex");

interface P3Result {
  ok: true;
  source_bytes: number;
  source_sha256: string;
  book_id: string;
  series_id: string;
  episode_id: string;
  approved_script_version_id: string;
  approved_script_content_hash: string;
  approval_revision: number;
  approved_script_characters: number;
}

interface TimelineResult {
  episodeId: string;
  scriptVersionId: string;
  timelineHash: string;
  durationMs: number;
  segmentCount: number;
  cueCount: number;
  srtRelativePath: string;
  assRelativePath: string;
  reusedSegments: number;
}

interface ChunkResult {
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

interface RenderResult {
  episodeId: string;
  timelineHash: string;
  chunks: ChunkResult[];
}

interface FinalResult {
  episodeId: string;
  timelineHash: string;
  finalHash: string;
  manifestRelativePath: string;
  video: { relativePath: string; fileHash: string; bytes: number; durationMs: number };
  reused: boolean;
}

interface EvidenceRow {
  source_byte_start: number;
  source_byte_end: number;
  source_hash: string;
}

interface BookRow {
  original_file_path: string;
  original_file_hash: string;
}

const jobs: JobRecord[] = [];

function fromRelative(relativePath: string) {
  assert.equal(relativePath.startsWith("/") || /^[A-Za-z]:/u.test(relativePath), false, "产物路径必须相对数据根");
  assert.equal(relativePath.split("/").includes(".."), false, "产物路径不得逃逸数据根");
  return join(dataRoot, ...relativePath.split("/"));
}

function runP3(): P3Result {
  const gatePath = join(repositoryRoot, "apps/server/src/gates/p3-real-episode-gate.ts");
  const result = spawnSync(process.execPath, ["--no-warnings", "--import", "tsx", gatePath], {
    cwd: repositoryRoot,
    env: { ...process.env, YINGSHU_P3_GATE_DATA_ROOT: dataRoot },
    encoding: "utf8",
    windowsHide: true,
    maxBuffer: 8 * 1024 * 1024,
  });
  assert.equal(result.status, 0, `P3 真实生产链失败：${result.stderr || result.stdout}`);
  return JSON.parse(result.stdout) as P3Result;
}

async function runJob<TResult>(
  database: ReturnType<typeof openDatabase>["database"],
  type: string,
  payload: unknown,
  handler: JobHandler,
  workerId: string,
) {
  const created = createJob(database, { type, payload, maxAttempts: 1 });
  const worker = new JobWorker(database, { [type]: handler }, {
    workerId,
    leaseMs: 1_800_000,
    heartbeatMs: 10_000,
  });
  assert.equal(await worker.runOne(), true, `${type} 未被 Worker 领取`);
  const completed = getJob(database, created.id)!;
  jobs.push(completed);
  assert.equal(completed.status, "succeeded", completed.errorMessage ?? `${type} 失败`);
  return completed.result as TResult;
}

async function verifySource(
  database: ReturnType<typeof openDatabase>["database"],
  p3: P3Result,
) {
  const book = database.prepare(
    "SELECT original_file_path, original_file_hash FROM books WHERE id = ?",
  ).get(p3.book_id) as unknown as BookRow;
  assert.equal(book.original_file_hash, SOURCE_SHA256);
  const sourcePath = fromRelative(book.original_file_path.replaceAll("\\", "/"));
  const source = await readFile(sourcePath);
  assert.equal(source.byteLength, 2_663_455);
  assert.equal(hash(source), SOURCE_SHA256);
  const evidence = database.prepare(
    `SELECT source_byte_start, source_byte_end, source_hash
     FROM episode_sources WHERE episode_id = ? ORDER BY source_index`,
  ).all(p3.episode_id) as unknown as EvidenceRow[];
  assert.equal(evidence.length, 6);
  for (const item of evidence) {
    assert(item.source_byte_start >= 0 && item.source_byte_end <= source.byteLength);
    assert.equal(hash(source.subarray(item.source_byte_start, item.source_byte_end)), item.source_hash);
  }
  return { path: sourcePath, bytes: source.byteLength, evidenceCount: evidence.length };
}

async function verifyTimeline(
  database: ReturnType<typeof openDatabase>["database"],
  timeline: TimelineResult,
) {
  assert(timeline.durationMs >= 180_000 && timeline.durationMs <= 300_000,
    `真实时间轴不在 3～5 分钟：${timeline.durationMs}ms`);
  assert.equal(timeline.segmentCount, timeline.cueCount);
  assert(timeline.cueCount > 0);
  const audioRows = database.prepare(
    `SELECT relative_path, file_hash, bytes, duration_ms FROM audio_segments
     WHERE episode_id = ? AND timeline_hash = ? ORDER BY segment_index`,
  ).all(timeline.episodeId, timeline.timelineHash) as unknown as Array<{
    relative_path: string; file_hash: string; bytes: number; duration_ms: number;
  }>;
  assert.equal(audioRows.length, timeline.segmentCount);
  for (const row of audioRows) {
    const bytes = await readFile(fromRelative(row.relative_path));
    assert.equal(bytes.byteLength, row.bytes);
    assert.equal(hash(bytes), row.file_hash);
    assert(row.duration_ms > 0);
  }
  const srt = await readFile(fromRelative(timeline.srtRelativePath), "utf8");
  const ass = await readFile(fromRelative(timeline.assRelativePath), "utf8");
  assert(srt.includes("-->"));
  assert(ass.includes("PlayResX: 1080") && ass.includes("PlayResY: 1920"));
}

async function verifyChunks(
  database: ReturnType<typeof openDatabase>["database"],
  render: RenderResult,
) {
  assert(render.chunks.length >= 2);
  assert.equal(render.chunks[0]?.startMs, 0);
  for (const [index, chunk] of render.chunks.entries()) {
    assert.equal(chunk.chunkIndex, index);
    assert.equal(index === 0 ? chunk.startMs : chunk.startMs, index === 0 ? 0 : render.chunks[index - 1]!.endMs);
    const bytes = await readFile(fromRelative(chunk.relativePath));
    assert.equal(bytes.byteLength, chunk.bytes);
    assert.equal(hash(bytes), chunk.fileHash);
    const probe = await probeNineSixteenVideo(fromRelative(chunk.relativePath));
    assert.equal(probe.bytes, chunk.bytes);
    assert(Math.abs(probe.durationMs - chunk.durationMs) <= 1_000);
    const row = database.prepare(
      `SELECT render_hash, relative_path, file_hash, bytes FROM render_chunks
       WHERE episode_id = ? AND timeline_hash = ? AND chunk_index = ?`,
    ).get(render.episodeId, render.timelineHash, index) as {
      render_hash: string; relative_path: string; file_hash: string; bytes: number;
    };
    assert.equal(row.render_hash, chunk.renderHash);
    assert.equal(row.relative_path, chunk.relativePath);
    assert.equal(row.file_hash, chunk.fileHash);
    assert.equal(row.bytes, chunk.bytes);
  }
}

async function verifyFinal(final: FinalResult) {
  const videoPath = fromRelative(final.video.relativePath);
  const manifestPath = fromRelative(final.manifestRelativePath);
  const video = await readFile(videoPath);
  assert.equal(video.byteLength, final.video.bytes);
  assert.equal(hash(video), final.video.fileHash);
  assert(final.video.durationMs >= 180_000 && final.video.durationMs <= 300_000);
  const probe = await probeNineSixteenVideo(videoPath);
  assert.equal(probe.bytes, final.video.bytes);
  assert(Math.abs(probe.durationMs - final.video.durationMs) <= 1_000);
  const manifestBytes = await readFile(manifestPath);
  const manifest = JSON.parse(manifestBytes.toString("utf8")) as FinalVideoManifest;
  assert.equal(manifest.version, "final-export-v1");
  assert.equal(manifest.exportHash, final.finalHash);
  assert.equal(manifest.episodeId, final.episodeId);
  assert.equal(manifest.timelineHash, final.timelineHash);
  assert.deepEqual(manifest.finalVideo.streams, {
    video: "h264:1080x1920:25:yuv420p",
    audio: "aac",
  });
  assert.equal(manifest.finalVideo.fileHash, final.video.fileHash);
  assert.equal(manifest.finalVideo.bytes, final.video.bytes);
  assert.equal(manifest.chunks[0]?.startMs, 0);
  assert(Math.abs(manifest.chunks.at(-1)!.endMs - final.video.durationMs) <= 1_000);
  for (const chunk of manifest.chunks) {
    const bytes = await readFile(fromRelative(chunk.relativePath));
    assert.equal(bytes.byteLength, chunk.bytes);
    assert.equal(hash(bytes), chunk.fileHash);
  }
  const decode = spawnSync("ffmpeg", [
    "-v", "error", "-i", videoPath, "-map", "0:v:0", "-map", "0:a:0", "-f", "null", "-",
  ], { windowsHide: true, encoding: "utf8", maxBuffer: 4 * 1024 * 1024 });
  assert.equal(decode.status, 0, `最终样片完整解码失败：${decode.stderr}`);
  return { videoPath, manifestPath, video, manifestBytes, manifest };
}

assert.equal(/[\\/]data[\\/]gates[\\/]p7-real-sample$/u.test(dataRoot), true, "P7 门禁数据根越界");
const historicalImage = await readFile(historicalImagePath);
assert.equal(historicalImage.byteLength, IMAGE_BYTES, "历史 Seedream 图片大小变化");
assert.equal(hash(historicalImage), IMAGE_SHA256, "历史 Seedream 图片哈希变化");

const startedAt = Date.now();
await rm(dataRoot, { recursive: true, force: true });
await mkdir(dataRoot, { recursive: true });
const p3 = runP3();
assert.equal(p3.ok, true);
assert.equal(p3.source_sha256, SOURCE_SHA256);
assert.equal(p3.approval_revision, 3);

let connection = openDatabase(dataRoot);
try {
  const source = await verifySource(connection.database, p3);
  const permit = requireApprovedScriptForProduction(connection.database, p3.episode_id, "tts");
  assert.deepEqual({ id: permit.scriptVersionId, hash: permit.contentHash, revision: permit.approvalRevision }, {
    id: p3.approved_script_version_id,
    hash: p3.approved_script_content_hash,
    revision: p3.approval_revision,
  });

  const timeline = await runJob<TimelineResult>(
    connection.database,
    TTS_TIMELINE_JOB_TYPE,
    { episodeId: p3.episode_id },
    createTtsTimelineJobHandler(connection.database, dataRoot),
    "p7-real-sample-tts",
  );
  assert.equal(timeline.scriptVersionId, permit.scriptVersionId);
  await verifyTimeline(connection.database, timeline);

  const asset = createAsset(connection.database, p3.series_id, {
    type: "character",
    name: "林黛玉",
    description: "Phase 5 真实 Seedream 竖屏生成图，供首版真实样片复用。",
  });
  const candidate = await registerAssetCandidate(connection.database, dataRoot, {
    assetId: asset.id,
    source: {
      kind: "generation",
      episodeId: "p5_episode",
      scriptVersionId: "p5_script",
      approvalRevision: 1,
      provider: "provider_1783572093812",
      model: "doubao-seedream-4-5-251128",
      promptHash: "88c35c4c158e243ee7dabcd4328082b80ac8b2c3cd38dfe0a62130354f1b5415",
      requestHash: "26b89471c081001dbff059487842ae8ad5aa7d6ce309aec614cb57381980fee1",
      size: "1600x2848",
      outputIndex: 0,
    },
    raw: createReadStream(historicalImagePath),
  });
  assert.equal(candidate.fileHash, IMAGE_SHA256);
  assert.equal(candidate.bytes, IMAGE_BYTES);
  assert.equal(candidate.mime, "image/jpeg");
  assert(candidate.height > candidate.width);
  appendAssetCandidateReview(connection.database, candidate.id, {
    expectedRevision: 0,
    action: "approve",
    note: "P7-01 真实样片复用 Phase 5 已验收 Seedream 生成图",
  });
  const copiedImagePath = fromRelative(candidate.relativePath);
  assert.notEqual(resolve(copiedImagePath), resolve(historicalImagePath));
  assert.equal(hash(await readFile(copiedImagePath)), IMAGE_SHA256);

  const motions: VisualMotionKind[] = ["zoom-in", "pan-left", "pan-right", "zoom-out", "none"];
  for (let index = 0; index < timeline.cueCount; index += 1) {
    const motionKind = motions[index % motions.length]!;
    putVisualSegment(connection.database, p3.episode_id, index, {
      timelineHash: timeline.timelineHash,
      cueStartIndex: index,
      cueEndIndex: index,
      motionKind,
      motionAmountPpm: motionKind === "none" ? 0 : 30_000,
      fadeMs: 250,
      expectedRevision: 0,
      assets: [{ assetId: asset.id, selectedCandidateId: candidate.id }],
    });
  }
  const visuals = assertVisualPlanReady(connection.database, p3.episode_id, timeline.timelineHash);
  assert.equal(visuals.length, timeline.cueCount);
  assert.equal(visuals[0]?.startMs, 0);
  assert.equal(visuals.at(-1)?.endMs, timeline.durationMs);
  assert(visuals.every((segment) => segment.productionReady));

  const render = await runJob<RenderResult>(
    connection.database,
    RENDER_CHUNKS_JOB_TYPE,
    { episodeId: p3.episode_id, timelineHash: timeline.timelineHash },
    createRenderChunksJobHandler(connection.database, dataRoot),
    "p7-real-sample-render",
  );
  assert.equal(render.chunks.every((chunk) => !chunk.reused), true);
  await verifyChunks(connection.database, render);

  const final = await runJob<FinalResult>(
    connection.database,
    FINAL_VIDEO_JOB_TYPE,
    { episodeId: p3.episode_id, timelineHash: timeline.timelineHash },
    createFinalVideoJobHandler(connection.database, dataRoot),
    "p7-real-sample-final",
  );
  assert.equal(final.reused, false);
  const verified = await verifyFinal(final);
  const firstMtime = (await stat(verified.videoPath)).mtimeMs;

  connection.close();
  connection = openDatabase(dataRoot);
  const restartedPermit = requireApprovedScriptForProduction(connection.database, p3.episode_id, "tts");
  assert.deepEqual(restartedPermit, permit);
  await verifySource(connection.database, p3);
  const restartedTimeline = await runJob<TimelineResult>(
    connection.database,
    TTS_TIMELINE_JOB_TYPE,
    { episodeId: p3.episode_id },
    createTtsTimelineJobHandler(connection.database, dataRoot),
    "p7-real-sample-tts-restart",
  );
  assert.equal(restartedTimeline.timelineHash, timeline.timelineHash);
  assert.equal(restartedTimeline.reusedSegments, timeline.segmentCount);
  const restartedRender = await runJob<RenderResult>(
    connection.database,
    RENDER_CHUNKS_JOB_TYPE,
    { episodeId: p3.episode_id, timelineHash: timeline.timelineHash },
    createRenderChunksJobHandler(connection.database, dataRoot),
    "p7-real-sample-render-restart",
  );
  assert.equal(restartedRender.chunks.every((chunk) => chunk.reused), true);
  const restartedFinal = await runJob<FinalResult>(
    connection.database,
    FINAL_VIDEO_JOB_TYPE,
    { episodeId: p3.episode_id, timelineHash: timeline.timelineHash },
    createFinalVideoJobHandler(connection.database, dataRoot),
    "p7-real-sample-final-restart",
  );
  assert.equal(restartedFinal.reused, true);
  assert.equal(restartedFinal.finalHash, final.finalHash);
  assert.deepEqual(await readFile(verified.videoPath), verified.video);
  assert.deepEqual(await readFile(verified.manifestPath), verified.manifestBytes);
  assert.equal((await stat(verified.videoPath)).mtimeMs, firstMtime);

  const attempts = jobs.reduce((total, job) => total + job.attempts, 0);
  const retries = jobs.reduce((total, job) => total + Math.max(0, job.attempts - 1), 0);
  const failures = jobs.filter((job) => job.status === "failed").length;
  process.stdout.write(`${JSON.stringify({
    ok: true,
    data_root: dataRoot,
    source_path: source.path,
    source_bytes: source.bytes,
    source_sha256: SOURCE_SHA256,
    evidence_snapshots: source.evidenceCount,
    episode_id: p3.episode_id,
    approved_script_version_id: p3.approved_script_version_id,
    approved_script_content_hash: p3.approved_script_content_hash,
    approval_revision: p3.approval_revision,
    approved_script_characters: p3.approved_script_characters,
    timeline_hash: timeline.timelineHash,
    duration_ms: final.video.durationMs,
    srt_path: fromRelative(timeline.srtRelativePath),
    ass_path: fromRelative(timeline.assRelativePath),
    candidate_id: candidate.id,
    candidate_path: copiedImagePath,
    candidate_sha256: candidate.fileHash,
    candidate_bytes: candidate.bytes,
    candidate_source_kind: candidate.source.kind,
    candidate_review_status: "approved",
    visual_segments: visuals.length,
    chunks: render.chunks.map((chunk) => ({
      index: chunk.chunkIndex,
      render_hash: chunk.renderHash,
      file_hash: chunk.fileHash,
      bytes: chunk.bytes,
      start_ms: chunk.startMs,
      end_ms: chunk.endMs,
      path: fromRelative(chunk.relativePath),
    })),
    final_hash: final.finalHash,
    final_video_sha256: final.video.fileHash,
    final_video_bytes: final.video.bytes,
    final_video_path: verified.videoPath,
    manifest_path: verified.manifestPath,
    video_contract: verified.manifest.finalVideo.streams,
    full_decode: true,
    restart_query: true,
    restart_reused_tts: true,
    restart_reused_chunks: true,
    restart_reused_final: true,
    jobs: jobs.length,
    job_attempts: attempts,
    job_retries: retries,
    job_failures: failures,
    manual_approval_actions: 4,
    manual_elapsed_ms: 0,
    manual_elapsed_basis: "门禁代执行三次稿件批准事件和一次图片审核，不计人工等待",
    external_model_calls: 0,
    incremental_cost: 0,
    historical_image_call_price: "unknown",
    elapsed_ms: Date.now() - startedAt,
  }, null, 2)}\n`);
} finally {
  connection.close();
}
