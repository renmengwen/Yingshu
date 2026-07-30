import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { changeScriptApproval } from "../script-approval-store.js";
import { openDatabase } from "../database.js";
import { createJob, getJob } from "../job-store.js";
import { JobWorker } from "../job-worker.js";
import { createTtsTimelineJobHandler, TTS_TIMELINE_JOB_TYPE } from "../tts-timeline-job.js";

function seed(database: ReturnType<typeof openDatabase>["database"]) {
  database.prepare(
    `INSERT INTO books (id, title, original_file_path, original_file_hash, encoding, import_status)
     VALUES ('gate_book', '红楼梦真实旁白门禁', 'source.txt', ?, 'utf-8', 'ready')`,
  ).run("1".repeat(64));
  database.prepare(
    `INSERT INTO series_projects (id, book_id, title, created_at, updated_at)
     VALUES ('gate_series', 'gate_book', '真实音频时间轴', 1, 1)`,
  ).run();
  database.prepare(
    `INSERT INTO episodes (
      id, series_project_id, episode_index, title, story_arc, target_duration_seconds, created_at, updated_at
    ) VALUES ('gate_episode', 'gate_series', 1, '第一集', '黛玉进府', 240, 1, 1)`,
  ).run();
  const paragraphs = [
    { text: "林黛玉辞别父亲，乘船北上，初入荣国府。她步步留心，时时在意，唯恐被人耻笑。", sourceIndexes: [0] },
    { text: "众人相见悲喜交集，宝玉随后归来。两位少年第一次相逢，竟都生出似曾相识之感。", sourceIndexes: [0] },
  ];
  const content = JSON.stringify({ paragraphs });
  const contentHash = createHash("sha256").update(content).digest("hex");
  database.prepare(
    `INSERT INTO script_versions (
      id, episode_id, kind, version, parent_version_id, content_json, content_hash, created_at
    ) VALUES ('gate_script', 'gate_episode', 'packaged', 1, NULL, ?, ?, 1)`,
  ).run(content, contentHash);
  changeScriptApproval(database, "gate_episode", {
    action: "approve", expectedRevision: 0, scriptVersionId: "gate_script",
  });
}

async function runJob(database: ReturnType<typeof openDatabase>["database"], dataRoot: string) {
  const job = createJob(database, {
    type: TTS_TIMELINE_JOB_TYPE, payload: { episodeId: "gate_episode" }, maxAttempts: 1,
  });
  const worker = new JobWorker(database, {
    [TTS_TIMELINE_JOB_TYPE]: createTtsTimelineJobHandler(database, dataRoot),
  }, { workerId: `p4-gate-${job.id}`, leaseMs: 120_000, heartbeatMs: 5_000 });
  assert.equal(await worker.runOne(), true);
  const completed = getJob(database, job.id)!;
  assert.equal(completed.status, "succeeded", completed.errorMessage ?? "真实 TTS 时间轴任务失败");
  return completed.result as {
    timelineHash: string; durationMs: number; segmentCount: number; cueCount: number;
    srtRelativePath: string; assRelativePath: string; reusedSegments: number;
  };
}

const dataRoot = await mkdtemp(join(tmpdir(), "narralume-p4-timeline-gate-"));
let connection = openDatabase(dataRoot);
try {
  seed(connection.database);
  const first = await runJob(connection.database, dataRoot);
  assert.equal(first.segmentCount, 2);
  assert.equal(first.cueCount, 2);
  assert.equal(first.reusedSegments, 0);
  assert.ok(first.durationMs > 0);
  const rows = connection.database.prepare(
    `SELECT relative_path, file_hash, bytes, duration_ms FROM audio_segments
     WHERE timeline_hash = ? ORDER BY segment_index`,
  ).all(first.timelineHash) as unknown as Array<{
    relative_path: string; file_hash: string; bytes: number; duration_ms: number;
  }>;
  assert.equal(rows.length, 2);
  const mtimes = await Promise.all(rows.map(async (row) => {
    const path = join(dataRoot, ...row.relative_path.split("/"));
    const file = await readFile(path);
    assert.equal(file.length, row.bytes);
    assert.equal(createHash("sha256").update(file).digest("hex"), row.file_hash);
    assert.ok(row.duration_ms > 0);
    return (await stat(path)).mtimeMs;
  }));
  const cues = connection.database.prepare(
    "SELECT start_ms, end_ms FROM subtitle_cues WHERE timeline_hash = ? ORDER BY cue_index",
  ).all(first.timelineHash) as unknown as Array<{ start_ms: number; end_ms: number }>;
  assert.equal(cues[0]?.start_ms, 0);
  assert.equal(cues.at(-1)?.end_ms, first.durationMs);
  assert.ok(cues.every((cue, index) => cue.end_ms > cue.start_ms &&
    (index === 0 || cue.start_ms === cues[index - 1]!.end_ms)));
  assert.ok((await readFile(join(dataRoot, ...first.srtRelativePath.split("/")), "utf8")).includes("-->"));
  assert.ok((await readFile(join(dataRoot, ...first.assRelativePath.split("/")), "utf8")).includes("PlayResX: 1080"));

  connection.close();
  connection = openDatabase(dataRoot);
  const repeated = await runJob(connection.database, dataRoot);
  assert.equal(repeated.timelineHash, first.timelineHash);
  assert.equal(repeated.reusedSegments, 2);
  const repeatedRows = connection.database.prepare(
    "SELECT relative_path FROM audio_segments WHERE timeline_hash = ? ORDER BY segment_index",
  ).all(first.timelineHash) as unknown as Array<{ relative_path: string }>;
  assert.deepEqual(await Promise.all(repeatedRows.map(async (row) =>
    (await stat(join(dataRoot, ...row.relative_path.split("/")))).mtimeMs)), mtimes);

  console.log("P4-02 真实批准稿音频时间轴门禁通过");
  console.log(`timeline_hash=${first.timelineHash}`);
  console.log(`segments=${first.segmentCount}`);
  console.log(`cues=${first.cueCount}`);
  console.log(`duration_ms=${first.durationMs}`);
  console.log("restart_query=true");
  console.log("content_addressed_reuse=true");
} finally {
  connection.close();
  await rm(dataRoot, { recursive: true, force: true });
}
