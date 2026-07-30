import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, readFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { appendAssetCandidateReview, registerAssetCandidate } from "../asset-candidate-store.js";
import { createAsset } from "../asset-store.js";
import { openDatabase } from "../database.js";
import { probeNineSixteenVideo } from "../ffmpeg-video.js";
import { createJob, getJob } from "../job-store.js";
import { JobWorker, type JobHandler } from "../job-worker.js";
import { createRenderChunksJobHandler, RENDER_CHUNKS_JOB_TYPE } from "../render-chunk-job.js";
import { changeScriptApproval } from "../script-approval-store.js";
import { createTtsTimelineJobHandler, TTS_TIMELINE_JOB_TYPE } from "../tts-timeline-job.js";
import { assertVisualPlanReady, putVisualSegment, type VisualMotionKind } from "../visual-segment-store.js";

const EPISODE_ID = "p6_render_chunks_episode";
const SERIES_ID = "p6_render_chunks_series";
const SCRIPT_ID = "p6_render_chunks_script";
const dataRoot = fileURLToPath(new URL("../../../../data/gates/p6-render-chunks", import.meta.url));
if (!/[\\/]data[\\/]gates[\\/]p6-render-chunks$/.test(dataRoot)) throw new Error("P6-02 门禁数据目录越界");

const narration = [
  "故事从一块顽石写起。甄士隐在梦中看见通灵之物，也看见它将从天地之间进入人世。这个神异开端不是装饰，它提醒我们，眼前即将展开的日常生活背后，还牵着一条更长的因缘线。镜头先停在梦境与现实交界处，让观众记住这件通灵之物的来历。此刻不急着解释它未来属于谁，只确认这条线索已经进入故事，并将在人物相遇以后重新显出意义。",
  "梦醒之后，人间故事由一个极小的动作推动。原文写到，人物因为偶然一顾，便引出后续事来。一次看似轻微的回望，把原本陌生的道路接在一起。改编不夸大巧合，只保留已经写明的动作和因果，让命运的转向显得具体而可信。",
  "个人因果刚刚启动，贾府的命运也被提前放到读者面前。旁观者提出关于兴衰的疑问，却没有抢先宣布答案。繁华仍在，变化的征兆已经出现。我们只把这句提醒留在观众心里，等待后面的生活细节慢慢回答。",
  "与此同时，黛玉的生活来到转折处。她要依傍外祖母和舅氏姊妹，离开原来的环境，前往一个熟悉于名声、陌生于日常的家族。这是现实处境下的投亲，不是追逐虚构目标。她既期待亲人，也要面对规矩和未知。",
  "车马继续向前，真正的空间边界终于出现。黛玉确认眼前就是荣国府。梦中的通灵线索、人间的一次回望、旁观者关于兴衰的提醒，在府门前逐渐汇合。她即将走进去，也将成为观众观察这个家族的一双眼睛。",
  "这一集并不是几段互不相关的旧事。它讲的是一条逐渐收紧的路径：从顽石入世，到梦中识得通灵；从偶然回望，到因果真正发生；从旁观者提出兴衰之问，到黛玉投亲并抵达荣国府。每一步都能回到已有的人物、动作和地点。",
  "府门打开以后，故事没有急着制造冲突。黛玉会先遇见谁，会怎样理解这里的亲疏与规矩，又会从哪些细节感受到家族命运的变化，这些问题都留给后面的真实章节回答。首集只负责把人物和线索稳稳送到同一个地方。",
  "结尾再次回望已经建立的四个支点：从梦幻中出现的通灵之物，一次改变人物道路的偶然回望，一句关于家族兴衰的冷眼提醒，以及一个走进荣国府的少女。它们已经在同一条叙事线上相遇，下一集将从府门之内继续。观众带着已经出现的证据和仍未回答的问题越过这道门槛，后续变化才有清楚的来处，而不是凭空发生。",
];
const hash = (value: Uint8Array | string) => createHash("sha256").update(value).digest("hex");

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
  timelineHash: string;
  chunks: ChunkResult[];
}

function seed(database: ReturnType<typeof openDatabase>["database"]) {
  database.prepare("INSERT INTO books (id,title,original_file_path,original_file_hash,encoding,import_status) VALUES ('p6_book','红楼梦','source.txt',?,'utf-8','ready')").run("1".repeat(64));
  database.prepare("INSERT INTO series_projects (id,book_id,title,created_at,updated_at) VALUES (?,'p6_book','黛玉初入荣国府',1,1)").run(SERIES_ID);
  database.prepare("INSERT INTO episodes (id,series_project_id,episode_index,title,story_arc,target_duration_seconds,created_at,updated_at) VALUES (?,?,1,'第一集','从顽石入世到黛玉抵达荣国府',240,1,1)").run(EPISODE_ID, SERIES_ID);
  const content = JSON.stringify({ paragraphs: narration.map((text) => ({ text, sourceIndexes: [0] })) });
  database.prepare("INSERT INTO script_versions (id,episode_id,kind,version,parent_version_id,content_json,content_hash,created_at) VALUES (?,?,'packaged',1,NULL,?,?,1)").run(SCRIPT_ID, EPISODE_ID, content, hash(content));
  changeScriptApproval(database, EPISODE_ID, { action: "approve", expectedRevision: 0, scriptVersionId: SCRIPT_ID });
}

async function runJob(database: ReturnType<typeof openDatabase>["database"], type: string, payload: unknown, handler: JobHandler, workerId: string) {
  const job = createJob(database, { type, payload, maxAttempts: 1 });
  const worker = new JobWorker(database, { [type]: handler }, { workerId, leaseMs: 1_800_000, heartbeatMs: 10_000 });
  assert.equal(await worker.runOne(), true);
  const completed = getJob(database, job.id)!;
  assert.equal(completed.status, "succeeded", completed.errorMessage ?? `${type} 失败`);
  return { id: job.id, result: completed.result as Record<string, unknown> };
}

function createPng(path: string) {
  const result = spawnSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i",
    "color=c=0x315d78:s=900x1600,drawbox=x=0:y=0:w=250:h=1600:c=0xd28b49:t=fill,drawbox=x=560:y=250:w=260:h=900:c=0x8bb8a8:t=fill",
    "-frames:v", "1", "-threads", "1", path], { windowsHide: true, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
}

function rows(database: ReturnType<typeof openDatabase>["database"], timelineHash: string) {
  return database.prepare("SELECT * FROM render_chunks WHERE episode_id = ? AND timeline_hash = ? ORDER BY chunk_index")
    .all(EPISODE_ID, timelineHash) as unknown as Array<Record<string, string | number>>;
}

async function verifyChunks(database: ReturnType<typeof openDatabase>["database"], timelineHash: string, jobId: string, chunks: ChunkResult[]) {
  const cues = database.prepare("SELECT start_ms,end_ms FROM subtitle_cues WHERE episode_id = ? AND timeline_hash = ? ORDER BY cue_index")
    .all(EPISODE_ID, timelineHash) as unknown as Array<{ start_ms: number; end_ms: number }>;
  const visuals = assertVisualPlanReady(database, EPISODE_ID, timelineHash);
  const boundaries = new Set([0, ...cues.map((cue) => cue.end_ms)]);
  const visualBoundaries = new Set([0, ...visuals.map((segment) => segment.endMs)]);
  const stored = rows(database, timelineHash);
  assert.equal(stored.length, chunks.length);
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM job_checkpoints WHERE job_id = ? AND stage = 'render-chunk'").get(jobId)?.count, chunks.length);
  for (const chunk of chunks) {
    assert.ok(chunk.endMs - chunk.startMs >= 60_000 && chunk.endMs - chunk.startMs <= 180_000);
    assert.ok(boundaries.has(chunk.startMs) && boundaries.has(chunk.endMs), "分片必须落在 cue 边界");
    assert.ok(visualBoundaries.has(chunk.startMs) && visualBoundaries.has(chunk.endMs), "分片必须落在视觉段边界");
    assert.equal(chunk.relativePath, `episodes/${EPISODE_ID}/renders/chunks/${chunk.renderHash.slice(0, 2)}/${chunk.renderHash}.mp4`);
    const path = join(dataRoot, ...chunk.relativePath.split("/"));
    const bytes = await readFile(path);
    assert.equal(bytes.byteLength, chunk.bytes);
    assert.equal(hash(bytes), chunk.fileHash);
    const probe = await probeNineSixteenVideo(path);
    assert.equal(probe.bytes, chunk.bytes);
    assert.ok(Math.abs(probe.durationMs - (chunk.endMs - chunk.startMs)) <= 1_000);
    const row = stored.find((item) => item.chunk_index === chunk.chunkIndex)!;
    assert.equal(row.render_hash, chunk.renderHash);
    assert.equal(row.relative_path, chunk.relativePath);
    assert.equal(row.file_hash, chunk.fileHash);
    assert.equal(row.bytes, chunk.bytes);
    assert.equal(row.duration_ms, chunk.durationMs);
  }
}

await rm(dataRoot, { recursive: true, force: true });
await mkdir(dataRoot, { recursive: true });
let connection = openDatabase(dataRoot);
try {
  seed(connection.database);
  const timelineJob = await runJob(connection.database, TTS_TIMELINE_JOB_TYPE, { episodeId: EPISODE_ID },
    createTtsTimelineJobHandler(connection.database, dataRoot), "p6-render-chunks-tts");
  const timeline = timelineJob.result as unknown as { timelineHash: string; durationMs: number; cueCount: number };
  assert.ok(timeline.durationMs >= 180_000 && timeline.durationMs <= 300_000, `真实旁白时长不在 3～5 分钟：${timeline.durationMs}ms`);

  const fixture = join(dataRoot, "local-candidate.png");
  createPng(fixture);
  const asset = createAsset(connection.database, SERIES_ID, { type: "scene", name: "荣国府" });
  const candidate = await registerAssetCandidate(connection.database, dataRoot, {
    assetId: asset.id, source: { kind: "upload", originalName: "荣国府本地候选图.png" }, raw: createReadStream(fixture),
  });
  appendAssetCandidateReview(connection.database, candidate.id, { expectedRevision: 0, action: "approve", note: "P6-02 真实门禁批准" });
  const motions: VisualMotionKind[] = ["none", "pan-left", "zoom-in", "pan-right", "zoom-out"];
  for (let index = 0; index < timeline.cueCount; index += 1) {
    const motionKind = motions[index % motions.length]!;
    putVisualSegment(connection.database, EPISODE_ID, index, {
      timelineHash: timeline.timelineHash, cueStartIndex: index, cueEndIndex: index,
      motionKind, motionAmountPpm: motionKind === "none" ? 0 : 30_000, fadeMs: 250, expectedRevision: 0,
      assets: [{ assetId: asset.id, selectedCandidateId: candidate.id }],
    });
  }

  const firstJob = await runJob(connection.database, RENDER_CHUNKS_JOB_TYPE,
    { episodeId: EPISODE_ID, timelineHash: timeline.timelineHash },
    createRenderChunksJobHandler(connection.database, dataRoot), "p6-render-chunks-first");
  const first = firstJob.result as unknown as RenderResult;
  assert.ok(first.chunks.length >= 2);
  assert.equal(first.chunks.every((chunk) => !chunk.reused), true);
  await verifyChunks(connection.database, timeline.timelineHash, firstJob.id, first.chunks);
  const firstStats = new Map(await Promise.all(first.chunks.map(async (chunk) => [chunk.chunkIndex, {
    ...chunk, mtimeMs: (await stat(join(dataRoot, ...chunk.relativePath.split("/")))).mtimeMs,
  }] as const)));

  connection.close();
  connection = openDatabase(dataRoot);
  const restartJob = await runJob(connection.database, RENDER_CHUNKS_JOB_TYPE,
    { episodeId: EPISODE_ID, timelineHash: timeline.timelineHash },
    createRenderChunksJobHandler(connection.database, dataRoot), "p6-render-chunks-restart");
  const restarted = restartJob.result as unknown as RenderResult;
  assert.equal(restarted.chunks.every((chunk) => chunk.reused), true);
  await verifyChunks(connection.database, timeline.timelineHash, restartJob.id, restarted.chunks);
  for (const chunk of restarted.chunks) {
    const before = firstStats.get(chunk.chunkIndex)!;
    assert.deepEqual({ path: chunk.relativePath, hash: chunk.fileHash, bytes: chunk.bytes },
      { path: before.relativePath, hash: before.fileHash, bytes: before.bytes });
    assert.equal((await stat(join(dataRoot, ...chunk.relativePath.split("/")))).mtimeMs, before.mtimeMs);
  }

  const middleMs = timeline.durationMs / 2;
  const target = restarted.chunks.find((chunk) => chunk.startMs <= middleMs && chunk.endMs > middleMs)!;
  const visual = assertVisualPlanReady(connection.database, EPISODE_ID, timeline.timelineHash)
    .find((segment) => segment.startMs >= target.startMs && segment.endMs <= target.endMs)!;
  const changedMotion: VisualMotionKind = visual.motionKind === "zoom-in" ? "pan-right" : "zoom-in";
  putVisualSegment(connection.database, EPISODE_ID, visual.segmentIndex, {
    timelineHash: timeline.timelineHash, cueStartIndex: visual.cueStartIndex, cueEndIndex: visual.cueEndIndex,
    motionKind: changedMotion, motionAmountPpm: 45_000, fadeMs: visual.fadeMs, expectedRevision: visual.revision,
    assets: visual.assets.map((item) => ({ assetId: item.assetId, selectedCandidateId: item.selectedCandidateId ?? undefined })),
  });

  const changedJob = await runJob(connection.database, RENDER_CHUNKS_JOB_TYPE,
    { episodeId: EPISODE_ID, timelineHash: timeline.timelineHash },
    createRenderChunksJobHandler(connection.database, dataRoot), "p6-render-chunks-local-change");
  const changed = changedJob.result as unknown as RenderResult;
  await verifyChunks(connection.database, timeline.timelineHash, changedJob.id, changed.chunks);
  for (const chunk of changed.chunks) {
    const before = firstStats.get(chunk.chunkIndex)!;
    if (chunk.chunkIndex === target.chunkIndex) {
      assert.equal(chunk.reused, false);
      assert.notEqual(chunk.renderHash, before.renderHash);
      assert.notEqual(chunk.relativePath, before.relativePath);
    } else {
      assert.equal(chunk.reused, true);
      assert.deepEqual({ path: chunk.relativePath, hash: chunk.fileHash, bytes: chunk.bytes },
        { path: before.relativePath, hash: before.fileHash, bytes: before.bytes });
      assert.equal((await stat(join(dataRoot, ...chunk.relativePath.split("/")))).mtimeMs, before.mtimeMs);
    }
  }

  console.log("P6-02 真实分片渲染与局部失效门禁通过");
  console.log(`timeline_hash=${timeline.timelineHash}`);
  console.log(`duration_ms=${timeline.durationMs}`);
  console.log(`chunks=${changed.chunks.length}`);
  console.log(`chunk_ranges=${changed.chunks.map((chunk) => `${chunk.startMs}-${chunk.endMs}`).join(",")}`);
  console.log(`target_chunk=${target.chunkIndex}`);
  console.log("video_contract=1080x1920@25,H264,yuv420p,AAC");
  console.log("restart_reused_all=true");
  console.log("local_change_rerendered_only_target=true");
  console.log(`data_root=${dataRoot}`);
} finally {
  connection.close();
}
