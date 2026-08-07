import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { link, mkdir, mkdtemp, open, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import { openDatabase } from "./database.js";
import { createJob, getJob, requestJobCancellation } from "./job-store.js";
import { JobWorker } from "./job-worker.js";
import { createRenderChunksJobHandler, planRenderChunks, renderChunkIdentity, RENDER_CHUNKS_JOB_TYPE, writeSnapshot } from "./render-chunk-job.js";
import type { VisualSegmentRecord } from "./visual-segment-store.js";
import { getVideoOutputProfile } from "./video-output-profile.js";

const HASH = "a".repeat(64);
const PROFILE = getVideoOutputProfile("9:16");

function segment(index: number, startMs: number, endMs: number): VisualSegmentRecord {
  return {
    id: `visual_${index}`, episodeId: "episode", segmentIndex: index, scriptVersionId: "script",
    approvalRevision: 1, timelineHash: HASH, cueStartIndex: index, cueEndIndex: index,
    startMs, endMs, motionKind: "none", motionAmountPpm: 0, fadeMs: 0, revision: 1,
    assets: [{ assetId: `asset_${index}`, selectedCandidateId: `candidate_${index}`, candidateReviewRevision: 1 }],
    productionReady: true,
  };
}

test("分片只选择视觉段/cue 边界并保持每片 1～3 分钟", () => {
  const plans = planRenderChunks([
    segment(0, 0, 60_000), segment(1, 60_000, 120_000),
    segment(2, 120_000, 180_000), segment(3, 180_000, 240_000),
  ]);
  assert.deepEqual(plans.map((chunk) => [chunk.startMs, chunk.endMs]), [[0, 180_000], [180_000, 240_000]]);
  assert.throws(() => planRenderChunks([segment(0, 0, 59_000)]), /1～3 分钟/);
});

test("分片身份包含生产输入且不受路径、时间或机器版本影响", () => {
  const chunk = planRenderChunks([segment(0, 0, 60_000)])[0]!;
  const candidates = new Map([["candidate_0", { candidate_id: "candidate_0", review_revision: 1, file_hash: "b".repeat(64) }]]);
  const audio = [{ segment_index: 0, input_hash: "c".repeat(64), relative_path: "任意路径", file_hash: "d".repeat(64), bytes: 9, duration_ms: 60_000 }];
  const first = renderChunkIdentity({ episodeId: "episode", scriptVersionId: "script", approvalRevision: 1,
    timelineHash: HASH, profile: PROFILE, chunk, candidates, audio, assHash: "e".repeat(64) });
  const second = renderChunkIdentity({ episodeId: "episode", scriptVersionId: "script", approvalRevision: 1,
    timelineHash: HASH, profile: PROFILE, chunk, candidates, audio: [{ ...audio[0]!, relative_path: "另一绝对路径", bytes: 999 }], assHash: "e".repeat(64) });
  assert.equal(first.renderHash, second.renderHash);
  const json = JSON.stringify(first.identity);
  for (const forbidden of ["relative_path", "generatedAt", "mtime", "randomUUID", "ffmpegVersion"]) {
    assert.equal(json.includes(forbidden), false);
  }
});

test("局部视觉身份变化只使所属分片失效", () => {
  const plans = planRenderChunks([
    segment(0, 0, 60_000), segment(1, 60_000, 120_000),
    segment(2, 120_000, 180_000), segment(3, 180_000, 240_000),
  ]);
  const candidates = new Map(plans.flatMap((chunk) => chunk.segments.map((item) => [item.assets[0]!.selectedCandidateId!, {
    candidate_id: item.assets[0]!.selectedCandidateId!, review_revision: 1, file_hash: "b".repeat(64),
  }] as const)));
  const identity = (chunk: typeof plans[number], map = candidates) => renderChunkIdentity({
    episodeId: "episode", scriptVersionId: "script", approvalRevision: 1, timelineHash: HASH, chunk,
    profile: PROFILE, candidates: map,
    audio: chunk.segments.map((_, index) => ({ segment_index: index, input_hash: "c".repeat(64),
      relative_path: "ignored", file_hash: "d".repeat(64), bytes: 1, duration_ms: 60_000 })),
    assHash: "e".repeat(64),
  }).renderHash;
  const before = plans.map((chunk) => identity(chunk));
  const changed = new Map(candidates);
  changed.set("candidate_3", { ...changed.get("candidate_3")!, file_hash: "f".repeat(64) });
  const after = plans.map((chunk) => identity(chunk, changed));
  assert.equal(after[0], before[0]);
  assert.notEqual(after[1], before[1]);
});

test("私有快照 write、sync 或 close 失败都会关闭并删除当前文件", async () => {
  const directory = await mkdtemp(join(tmpdir(), "narralume-snapshot-failure-"));
  try {
    for (const stage of ["write", "sync", "close"] as const) {
      const path = join(directory, `${stage}.tmp.wav`);
      let closeCalls = 0;
      await assert.rejects(
        writeSnapshot(path, "snapshot", async (target, flags) => {
          const file = await open(target, flags);
          return {
            writeFile: async (content) => {
              if (stage === "write") throw new Error("write-failure");
              await file.writeFile(content);
            },
            sync: async () => {
              if (stage === "sync") throw new Error("sync-failure");
              await file.sync();
            },
            close: async () => {
              closeCalls += 1;
              if (stage === "close" && closeCalls === 1) {
                await file.close();
                throw new Error("close-failure");
              }
              await file.close();
            },
          };
        }),
        new RegExp(`${stage}-failure`),
      );
      assert.equal(closeCalls >= 1, true);
      assert.deepEqual(await readdir(directory), []);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("分片 Job 耐久登记并在同一身份下复用已复验产物", async () => {
  const dataRoot = await mkdtemp(join(tmpdir(), "narralume-render-chunks-"));
  const connection = openDatabase(dataRoot);
  try {
    const db = connection.database;
    db.prepare("INSERT INTO books (id,title,original_file_path,original_file_hash,encoding,import_status) VALUES ('book','书','books/source.txt',?,'UTF-8','ready')").run("1".repeat(64));
    db.prepare("INSERT INTO series_projects (id,book_id,title,created_at,updated_at) VALUES ('series','book','系列',1,1)").run();
    db.prepare("INSERT INTO episodes (id,series_project_id,episode_index,title,story_arc,target_duration_seconds,created_at,updated_at) VALUES ('episode','series',1,'集','弧',180,1,1)").run();
    db.prepare("INSERT INTO script_versions (id,episode_id,kind,version,content_json,content_hash,created_at) VALUES ('script','episode','packaged',1,'{}',?,1)").run("2".repeat(64));
    db.prepare("INSERT INTO script_approval_events (id,episode_id,revision,action,script_version_id,created_at) VALUES ('approval','episode',1,'approve','script',1)").run();

    const image = Buffer.from("verified-image");
    const imageHash = createHash("sha256").update(image).digest("hex");
    const imageRelative = `assets/candidates/${imageHash.slice(0, 2)}/${imageHash}.png`;
    await mkdir(dirname(join(dataRoot, imageRelative)), { recursive: true });
    await writeFile(join(dataRoot, imageRelative), image);
    const audio = Buffer.from("verified-audio");
    const audioHash = createHash("sha256").update(audio).digest("hex");
    const inputHash = "3".repeat(64);
    const audioRelative = `episodes/episode/audio/segments/${inputHash}.wav`;
    await mkdir(dirname(join(dataRoot, audioRelative)), { recursive: true });
    await writeFile(join(dataRoot, audioRelative), audio);

    db.prepare("INSERT INTO assets (id,series_project_id,asset_type,asset_role,canonical_name,normalized_name,created_at) VALUES ('asset','series','scene','master','场景','场景',1)").run();
    db.prepare(`INSERT INTO asset_candidates (id,asset_id,source_kind,source_identity_hash,source_json,file_hash,mime,width,height,bytes,relative_path,created_at)
      VALUES ('candidate','asset','upload',?,'{}',?,'image/png',1080,1920,?,?,1)`).run("4".repeat(64), imageHash, image.length, imageRelative);
    db.prepare("INSERT INTO asset_candidate_review_events (candidate_id,revision,action,created_at) VALUES ('candidate',1,'approve',1)").run();
    db.prepare(`INSERT INTO audio_segments (timeline_hash,segment_index,episode_id,script_version_id,text,provider_id,voice,rate,input_hash,relative_path,file_hash,bytes,duration_ms,created_at)
      VALUES (?,0,'episode','script','旁白','test','voice',0,?,?,?,?,60000,1)`).run(HASH, inputHash, audioRelative, audioHash, audio.length);
    db.prepare("INSERT INTO subtitle_cues (timeline_hash,cue_index,segment_index,episode_id,script_version_id,start_ms,end_ms,text) VALUES (?,0,0,'episode','script',0,60000,'旁白')").run(HASH);
    db.prepare(`INSERT INTO visual_segments (id,episode_id,segment_index,script_version_id,approval_revision,timeline_hash,cue_start_index,cue_end_index,start_ms,end_ms,motion_kind,motion_amount_ppm,fade_ms,revision,created_at,updated_at)
      VALUES ('visual','episode',0,'script',1,?,0,0,0,60000,'none',0,0,1,1,1)`).run(HASH);
    db.prepare("INSERT INTO visual_segment_assets (visual_segment_id,asset_index,asset_id,selected_candidate_id,candidate_review_revision) VALUES ('visual',0,'asset','candidate',1)").run();

    let renders = 0;
    let cancelAfterPublish: string | undefined;
    const handler = createRenderChunksJobHandler(db, dataRoot, {
      concatAudio: async (paths, output) => {
        assert.equal(paths.length, 1);
        assert.notEqual(paths[0], join(dataRoot, audioRelative));
        assert.deepEqual(await readFile(paths[0]!), audio);
        await writeFile(output, "joined");
      },
      render: async (input) => {
        renders += 1;
        assert.deepEqual(await readFile(input.scenes[0]!.imagePath), image);
        assert.notEqual(input.scenes[0]!.imagePath, join(dataRoot, imageRelative));
        await writeFile(input.outputPath, "valid-video");
        if (cancelAfterPublish) requestJobCancellation(db, cancelAfterPublish);
      },
      probe: async (path) => ({ bytes: (await stat(path)).size, durationMs: 60_000 }),
    });
    for (const id of ["render_job_1", "render_job_2"]) {
      createJob(db, { id, type: RENDER_CHUNKS_JOB_TYPE, payload: { episodeId: "episode", timelineHash: HASH }, maxAttempts: 1 });
      const worker = new JobWorker(db, { [RENDER_CHUNKS_JOB_TYPE]: handler }, { workerId: `worker_${id}`, leaseMs: 5_000, heartbeatMs: 1_000 });
      assert.equal(await worker.runOne(), true);
      assert.equal(getJob(db, id)?.status, "succeeded");
    }
    assert.equal(renders, 1);
    const row = db.prepare("SELECT render_hash, relative_path, duration_ms FROM render_chunks").get() as { render_hash: string; relative_path: string; duration_ms: number };
    assert.match(row.render_hash, /^[0-9a-f]{64}$/u);
    assert.equal(row.relative_path, `episodes/episode/renders/chunks/${row.render_hash.slice(0, 2)}/${row.render_hash}.mp4`);
    assert.equal(row.duration_ms, 60_000);
    assert.equal((await readFile(join(dataRoot, row.relative_path), "utf8")), "valid-video");

    db.prepare("DELETE FROM render_chunks").run();
    await writeFile(join(dataRoot, row.relative_path), "wrong-video");
    createJob(db, { id: "render_job_orphan", type: RENDER_CHUNKS_JOB_TYPE, payload: { episodeId: "episode", timelineHash: HASH }, maxAttempts: 1 });
    const orphan = new JobWorker(db, { [RENDER_CHUNKS_JOB_TYPE]: handler }, { workerId: "worker_orphan", leaseMs: 5_000, heartbeatMs: 1_000 });
    assert.equal(await orphan.runOne(), true);
    assert.equal(getJob(db, "render_job_orphan")?.status, "succeeded");
    assert.equal(renders, 2, "没有可信 DB 记录时不得接纳可 probe 且同时长的孤儿 MP4");
    assert.equal(await readFile(join(dataRoot, row.relative_path), "utf8"), "valid-video");

    db.prepare("DELETE FROM render_chunks").run();
    cancelAfterPublish = "render_job_cancelled";
    createJob(db, { id: cancelAfterPublish, type: RENDER_CHUNKS_JOB_TYPE, payload: { episodeId: "episode", timelineHash: HASH }, maxAttempts: 1 });
    const cancelling = new JobWorker(db, { [RENDER_CHUNKS_JOB_TYPE]: handler }, { workerId: "worker_cancelled", leaseMs: 5_000, heartbeatMs: 1_000 });
    assert.equal(await cancelling.runOne(), true);
    assert.equal(getJob(db, cancelAfterPublish)?.status, "cancelled");
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM render_chunks").get()?.count, 0);
    cancelAfterPublish = undefined;
    createJob(db, { id: "render_job_after_cancel", type: RENDER_CHUNKS_JOB_TYPE, payload: { episodeId: "episode", timelineHash: HASH }, maxAttempts: 1 });
    const afterCancel = new JobWorker(db, { [RENDER_CHUNKS_JOB_TYPE]: handler }, { workerId: "worker_after_cancel", leaseMs: 5_000, heartbeatMs: 1_000 });
    assert.equal(await afterCancel.runOne(), true);
    assert.equal(getJob(db, "render_job_after_cancel")?.status, "succeeded");
    assert.equal(renders, 4, "发布后 checkpoint 未登记的孤儿必须在下次重渲");
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM render_chunks").get()?.count, 1);

    await writeFile(join(dataRoot, row.relative_path), "broken");
    createJob(db, { id: "render_job_3", type: RENDER_CHUNKS_JOB_TYPE, payload: { episodeId: "episode", timelineHash: HASH }, maxAttempts: 1 });
    const recovery = new JobWorker(db, { [RENDER_CHUNKS_JOB_TYPE]: handler }, { workerId: "worker_recovery", leaseMs: 5_000, heartbeatMs: 1_000 });
    assert.equal(await recovery.runOne(), true);
    assert.equal(getJob(db, "render_job_3")?.status, "succeeded");
    assert.equal(renders, 5);

    const audioPath = join(dataRoot, audioRelative);
    const outsideAudio = join(dataRoot, "outside-audio.wav");
    await rm(audioPath);
    await writeFile(outsideAudio, audio);
    await link(outsideAudio, audioPath);
    createJob(db, { id: "render_job_linked_audio", type: RENDER_CHUNKS_JOB_TYPE, payload: { episodeId: "episode", timelineHash: HASH }, maxAttempts: 1 });
    const linkedAudio = new JobWorker(db, { [RENDER_CHUNKS_JOB_TYPE]: handler }, { workerId: "worker_linked_audio", leaseMs: 5_000, heartbeatMs: 1_000 });
    assert.equal(await linkedAudio.runOne(), true);
    assert.equal(getJob(db, "render_job_linked_audio")?.status, "failed");
    assert.match(getJob(db, "render_job_linked_audio")?.errorMessage ?? "", /普通文件|发生变化/);
  } finally {
    connection.close();
    await rm(dataRoot, { recursive: true, force: true });
  }
});
