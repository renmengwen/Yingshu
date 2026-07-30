import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, renameSync, rmSync } from "node:fs";
import { cp, lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import { openDatabase } from "./database.js";
import { createFinalVideoJobHandler, exportFinalVideo, FINAL_VIDEO_JOB_TYPE } from "./final-video.js";
import { createJob, getJob } from "./job-store.js";
import { JobCancelledError, JobWorker } from "./job-worker.js";
import { loadRenderPlanSnapshot } from "./render-chunk-job.js";
import { changeScriptApproval, getScriptApproval } from "./script-approval-store.js";

const TIMELINE = "a".repeat(64);
const hash = (content: string | Buffer) => createHash("sha256").update(content).digest("hex");

async function fixture() {
  const dataRoot = await mkdtemp(join(tmpdir(), "narralume-final-video-"));
  const connection = openDatabase(dataRoot);
  const db = connection.database;
  db.prepare("INSERT INTO books (id,title,original_file_path,original_file_hash,encoding,import_status) VALUES ('book','书','books/source.txt',?,'UTF-8','ready')").run("1".repeat(64));
  db.prepare("INSERT INTO series_projects (id,book_id,title,created_at,updated_at) VALUES ('series','book','系列',1,1)").run();
  db.prepare("INSERT INTO episodes (id,series_project_id,episode_index,title,story_arc,target_duration_seconds,created_at,updated_at) VALUES ('episode','series',1,'集','弧',180,1,1)").run();
  db.prepare("INSERT INTO script_versions (id,episode_id,kind,version,content_json,content_hash,created_at) VALUES ('script','episode','packaged',1,'{}',?,1)").run("2".repeat(64));
  db.prepare("INSERT INTO script_approval_events (id,episode_id,revision,action,script_version_id,created_at) VALUES ('approval','episode',1,'approve','script',1)").run();
  db.prepare("INSERT INTO assets (id,series_project_id,asset_type,asset_role,canonical_name,normalized_name,created_at) VALUES ('asset','series','scene','master','场景','场景',1)").run();
  db.prepare(`INSERT INTO asset_candidates (id,asset_id,source_kind,source_identity_hash,source_json,file_hash,mime,width,height,bytes,relative_path,created_at)
    VALUES ('candidate','asset','upload',?,'{}',?,'image/png',1080,1920,1,'assets/candidates/x.png',1)`).run("3".repeat(64), "4".repeat(64));
  db.prepare("INSERT INTO asset_candidate_review_events (candidate_id,revision,action,created_at) VALUES ('candidate',1,'approve',1)").run();
  db.prepare(`INSERT INTO audio_segments (timeline_hash,segment_index,episode_id,script_version_id,text,provider_id,voice,rate,input_hash,relative_path,file_hash,bytes,duration_ms,created_at)
    VALUES (?,0,'episode','script','旁白','test','voice',0,?,'episodes/episode/audio/segments/audio.wav',?,1,60000,1)`).run(TIMELINE, "5".repeat(64), "6".repeat(64));
  db.prepare("INSERT INTO subtitle_cues (timeline_hash,cue_index,segment_index,episode_id,script_version_id,start_ms,end_ms,text) VALUES (?,0,0,'episode','script',0,60000,'旁白')").run(TIMELINE);
  db.prepare(`INSERT INTO visual_segments (id,episode_id,segment_index,script_version_id,approval_revision,timeline_hash,cue_start_index,cue_end_index,start_ms,end_ms,motion_kind,motion_amount_ppm,fade_ms,revision,created_at,updated_at)
    VALUES ('visual','episode',0,'script',1,?,0,0,0,60000,'none',0,0,1,1,1)`).run(TIMELINE);
  db.prepare("INSERT INTO visual_segment_assets (visual_segment_id,asset_index,asset_id,selected_candidate_id,candidate_review_revision) VALUES ('visual',0,'asset','candidate',1)").run();
  const expected = loadRenderPlanSnapshot(db, "episode", TIMELINE).chunks[0]!;
  const chunk = Buffer.from("registered-chunk");
  const relativePath = `episodes/episode/renders/chunks/${expected.renderHash.slice(0, 2)}/${expected.renderHash}.mp4`;
  await mkdir(dirname(join(dataRoot, relativePath)), { recursive: true });
  await writeFile(join(dataRoot, relativePath), chunk);
  db.prepare(`INSERT INTO render_chunks (render_hash,episode_id,timeline_hash,chunk_index,script_version_id,approval_revision,start_ms,end_ms,relative_path,file_hash,bytes,duration_ms,created_at)
    VALUES (?,'episode',?,0,'script',1,0,60000,?,?,?,60000,1)`).run(expected.renderHash, TIMELINE, relativePath, hash(chunk), chunk.length);
  return { dataRoot, connection, chunkPath: join(dataRoot, relativePath) };
}

test("最终导出严格复验当前分片并成对生成可复用视频与版本化清单", async () => {
  const current = await fixture();
  let concatCalls = 0;
  const dependencies = {
    probe: async (path: string) => ({ bytes: (await stat(path)).size, durationMs: 60_000 }),
    run: async (_command: string, args: string[], options?: { cwd?: string; signal?: AbortSignal }) => {
      concatCalls += 1;
      if (!options?.cwd) throw new Error("missing cwd");
      assert.deepEqual(args.slice(0, 10), ["-v", "error", "-y", "-f", "concat", "-safe", "1", "-i", "chunks.ffconcat", "-c"]);
      assert.match(await readFile(join(options.cwd, "chunks.ffconcat"), "utf8"), /^ffconcat version 1\.0\nfile 'chunk-0000\.mp4'\n$/u);
      await writeFile(join(options.cwd, "final.tmp.mp4"), "final-video");
      return "";
    },
  };
  try {
    const first = await exportFinalVideo(current.connection.database, current.dataRoot,
      { episodeId: "episode", timelineHash: TIMELINE }, dependencies);
    assert.equal(first.reused, false);
    assert.match(first.finalPath, /[\\/]video\.mp4$/u);
    assert.equal(await readFile(first.finalPath, "utf8"), "final-video");
    const manifest = JSON.parse(await readFile(first.manifestPath, "utf8")) as Record<string, unknown>;
    assert.equal(manifest.version, "final-export-v1");
    assert.equal(JSON.stringify(manifest).includes(current.dataRoot), false);
    for (const forbidden of ["generatedAt", "mtime", "randomUUID", "ffmpegVersion"]) {
      assert.equal(JSON.stringify(manifest).includes(forbidden), false);
    }
    const second = await exportFinalVideo(current.connection.database, current.dataRoot,
      { episodeId: "episode", timelineHash: TIMELINE }, dependencies);
    assert.equal(second.reused, true);
    assert.equal(concatCalls, 1);

    const extraHash = "f".repeat(64);
    current.connection.database.prepare(`INSERT INTO render_chunks (render_hash,episode_id,timeline_hash,chunk_index,script_version_id,approval_revision,start_ms,end_ms,relative_path,file_hash,bytes,duration_ms,created_at)
      VALUES (?,'episode',?,9,'script',1,60000,120000,'old.mp4',?,1,60000,1)`).run(extraHash, TIMELINE, extraHash);
    assert.equal((await exportFinalVideo(current.connection.database, current.dataRoot,
      { episodeId: "episode", timelineHash: TIMELINE }, dependencies)).reused, true, "旧的高位分片记录不属于当前计划");

    createJob(current.connection.database, { id: "final-job", type: FINAL_VIDEO_JOB_TYPE,
      payload: { episodeId: "episode", timelineHash: TIMELINE }, maxAttempts: 1 });
    const worker = new JobWorker(current.connection.database, {
      [FINAL_VIDEO_JOB_TYPE]: createFinalVideoJobHandler(current.connection.database, current.dataRoot, dependencies),
    }, { workerId: "final-worker", leaseMs: 5_000, heartbeatMs: 1_000 });
    assert.equal(await worker.runOne(), true);
    assert.equal(getJob(current.connection.database, "final-job")?.status, "succeeded");
    assert.equal((getJob(current.connection.database, "final-job")?.result as { reused?: boolean }).reused, true);

    await writeFile(current.chunkPath, "tampered");
    await assert.rejects(exportFinalVideo(current.connection.database, current.dataRoot,
      { episodeId: "episode", timelineHash: TIMELINE }, dependencies), /分片文件与登记信息不一致/);
    assert.equal(await readFile(first.finalPath, "utf8"), "final-video", "坏分片不能覆盖旧成功导出");
  } finally {
    current.connection.close();
    await rm(current.dataRoot, { recursive: true, force: true });
  }
});

test("复用旧 final 的异步探测期间撤回批准时不得返回 reused", async () => {
  const current = await fixture();
  let runCalls = 0;
  const base = {
    probe: async (path: string) => ({ bytes: (await stat(path)).size, durationMs: 60_000 }),
    run: async (_command: string, _args: string[], options?: { cwd?: string }) => {
      runCalls += 1;
      if (!options?.cwd) throw new Error("missing cwd");
      await writeFile(join(options.cwd, "final.tmp.mp4"), "final-video"); return "";
    },
  };
  try {
    const old = await exportFinalVideo(current.connection.database, current.dataRoot,
      { episodeId: "episode", timelineHash: TIMELINE }, base);
    runCalls = 0;
    let withdrawn = false;
    await assert.rejects(exportFinalVideo(current.connection.database, current.dataRoot,
      { episodeId: "episode", timelineHash: TIMELINE }, { ...base, probe: async (path) => {
        const measured = await base.probe(path);
        if (path === old.finalPath && !withdrawn) {
          withdrawn = true;
          changeScriptApproval(current.connection.database, "episode", { action: "withdraw", expectedRevision: 1 });
        }
        return measured;
      } }), /不能开始.*视频生产/u);
    assert.equal(withdrawn, true);
    assert.equal(runCalls, 0, "当前身份变化必须立即失败，不能进入 ffmpeg 重建");
  } finally {
    current.connection.close();
    await rm(current.dataRoot, { recursive: true, force: true });
  }
});

test("最终身份复核与同步目录切换共享数据库写事务", async () => {
  const current = await fixture();
  const contender = openDatabase(current.dataRoot);
  contender.database.exec("PRAGMA busy_timeout=0");
  const base = {
    probe: async (path: string) => ({ bytes: (await stat(path)).size, durationMs: 60_000 }),
    run: async (_command: string, _args: string[], options?: { cwd?: string }) => {
      if (!options?.cwd) throw new Error("missing cwd");
      await writeFile(join(options.cwd, "final.tmp.mp4"), "final-video"); return "";
    },
  };
  try {
    const old = await exportFinalVideo(current.connection.database, current.dataRoot,
      { episodeId: "episode", timelineHash: TIMELINE }, base);
    await writeFile(old.manifestPath, "force-rebuild");
    let withdrawBlocked = false;
    const rebuilt = await exportFinalVideo(current.connection.database, current.dataRoot,
      { episodeId: "episode", timelineHash: TIMELINE }, { ...base, publishRenameSync: (from, to) => {
        if (from.toString().includes(".tmp")) {
          try { changeScriptApproval(contender.database, "episode", { action: "withdraw", expectedRevision: 1 }); }
          catch (error) { withdrawBlocked = /busy|locked/u.test(String(error).toLowerCase()); }
        }
        renameSync(from, to);
      } });
    assert.equal(rebuilt.reused, false);
    assert.equal(withdrawBlocked, true);
    assert.equal(getScriptApproval(current.connection.database, "episode").status, "approved");
  } finally {
    contender.close();
    current.connection.close();
    await rm(current.dataRoot, { recursive: true, force: true });
  }
});

test("崩溃残留只按完整 pair 恢复且非 ENOENT 与清理失败原样返回", async () => {
  const current = await fixture();
  const base = {
    probe: async (path: string) => ({ bytes: (await stat(path)).size, durationMs: 60_000 }),
    run: async (_command: string, _args: string[], options?: { cwd?: string }) => {
      if (!options?.cwd) throw new Error("missing cwd");
      await writeFile(join(options.cwd, "final.tmp.mp4"), "final-video"); return "";
    },
  };
  try {
    const first = await exportFinalVideo(current.connection.database, current.dataRoot,
      { episodeId: "episode", timelineHash: TIMELINE }, base);
    const target = dirname(first.finalPath);
    const backup = `${target}.backup`;
    await rename(target, backup);
    assert.equal((await exportFinalVideo(current.connection.database, current.dataRoot,
      { episodeId: "episode", timelineHash: TIMELINE }, base)).reused, true);

    await cp(target, backup, { recursive: true });
    assert.equal((await exportFinalVideo(current.connection.database, current.dataRoot,
      { episodeId: "episode", timelineHash: TIMELINE }, base)).reused, true);
    await assert.rejects(stat(backup), { code: "ENOENT" });

    await cp(target, backup, { recursive: true });
    await writeFile(first.manifestPath, "changed-identity");
    assert.equal((await exportFinalVideo(current.connection.database, current.dataRoot,
      { episodeId: "episode", timelineHash: TIMELINE }, base)).reused, true);

    await cp(target, backup, { recursive: true });
    await assert.rejects(exportFinalVideo(current.connection.database, current.dataRoot,
      { episodeId: "episode", timelineHash: TIMELINE }, { ...base, publishRenameSync: (from, to) => {
        if (from.toString().includes(".recover-") && to === target) throw new Error("restore-denied");
        renameSync(from, to);
      } }), /restore-denied/u);
    assert.equal((await stat(target)).isDirectory(), true);
    assert.equal((await stat(backup)).isDirectory(), true);
    await rm(backup, { recursive: true });

    await cp(target, backup, { recursive: true });
    await assert.rejects(exportFinalVideo(current.connection.database, current.dataRoot,
      { episodeId: "episode", timelineHash: TIMELINE }, { ...base, publishLstat: ((path: string) => {
        if (path === backup) throw Object.assign(new Error("stat-denied"), { code: "EACCES" });
        return lstat(path);
      }) as typeof lstat }), /stat-denied/u);
    assert.equal((await stat(target)).isDirectory(), true);
    assert.equal((await stat(backup)).isDirectory(), true);
  } finally {
    current.connection.close();
    await rm(current.dataRoot, { recursive: true, force: true });
  }
});

test("quarantine 清理前 EACCES 会保留完整 target 并回滚 backup", async () => {
  const current = await fixture();
  const base = {
    probe: async (path: string) => ({ bytes: (await stat(path)).size, durationMs: 60_000 }),
    run: async (_command: string, _args: string[], options?: { cwd?: string }) => {
      if (!options?.cwd) throw new Error("missing cwd");
      await writeFile(join(options.cwd, "final.tmp.mp4"), "final-video"); return "";
    },
  };
  try {
    const first = await exportFinalVideo(current.connection.database, current.dataRoot,
      { episodeId: "episode", timelineHash: TIMELINE }, base);
    const target = dirname(first.finalPath);
    const backup = `${target}.backup`;
    const video = await readFile(first.finalPath);
    const manifest = await readFile(first.manifestPath);
    await cp(target, backup, { recursive: true });
    await assert.rejects(exportFinalVideo(current.connection.database, current.dataRoot,
      { episodeId: "episode", timelineHash: TIMELINE }, { ...base, recoverRemoveSync: () => {
        throw Object.assign(new Error("cleanup-eacces"), { code: "EACCES" });
      } }), /cleanup-eacces/u);
    assert.deepEqual(await readFile(first.finalPath), video);
    assert.deepEqual(await readFile(first.manifestPath), manifest);
    assert.deepEqual(await readFile(join(backup, "video.mp4")), video);
    assert.deepEqual(await readFile(join(backup, "manifest.json")), manifest);
  } finally {
    current.connection.close();
    await rm(current.dataRoot, { recursive: true, force: true });
  }
});

test("quarantine 部分删除且 backup 竞争会保留完整 target 与明确残余", async () => {
  const current = await fixture();
  const base = {
    probe: async (path: string) => ({ bytes: (await stat(path)).size, durationMs: 60_000 }),
    run: async (_command: string, _args: string[], options?: { cwd?: string }) => {
      if (!options?.cwd) throw new Error("missing cwd");
      await writeFile(join(options.cwd, "final.tmp.mp4"), "final-video"); return "";
    },
  };
  let quarantine = "";
  try {
    const first = await exportFinalVideo(current.connection.database, current.dataRoot,
      { episodeId: "episode", timelineHash: TIMELINE }, base);
    const target = dirname(first.finalPath);
    const backup = `${target}.backup`;
    const video = await readFile(first.finalPath);
    const manifest = await readFile(first.manifestPath);
    await cp(target, backup, { recursive: true });
    await assert.rejects(exportFinalVideo(current.connection.database, current.dataRoot,
      { episodeId: "episode", timelineHash: TIMELINE }, { ...base, recoverRemoveSync: (path) => {
        quarantine = path.toString();
        rmSync(join(quarantine, "manifest.json"));
        mkdirSync(backup);
        throw new Error("cleanup-partial");
      } }), /cleanup-partial/u);
    assert.deepEqual(await readFile(first.finalPath), video);
    assert.deepEqual(await readFile(first.manifestPath), manifest);
    assert.equal((await stat(backup)).isDirectory(), true, "竞争 backup 阻止隔离目录回滚");
    assert.equal((await stat(quarantine)).isDirectory(), true, "部分删除的隔离目录必须保留为失败现场");
    assert.deepEqual(await readFile(join(quarantine, "video.mp4")), video);
    await assert.rejects(stat(join(quarantine, "manifest.json")), { code: "ENOENT" });
  } finally {
    current.connection.close();
    await rm(current.dataRoot, { recursive: true, force: true });
  }
});

test("target 验证后被替换时不得删除唯一有效 backup", async () => {
  const current = await fixture();
  const base = {
    probe: async (path: string) => ({ bytes: (await stat(path)).size, durationMs: 60_000 }),
    run: async (_command: string, _args: string[], options?: { cwd?: string }) => {
      if (!options?.cwd) throw new Error("missing cwd");
      await writeFile(join(options.cwd, "final.tmp.mp4"), "final-video"); return "";
    },
  };
  try {
    const first = await exportFinalVideo(current.connection.database, current.dataRoot,
      { episodeId: "episode", timelineHash: TIMELINE }, base);
    const target = dirname(first.finalPath);
    const backup = `${target}.backup`;
    const validatedTarget = `${target}.validated`;
    await cp(target, backup, { recursive: true });
    let replaced = false;
    await assert.rejects(exportFinalVideo(current.connection.database, current.dataRoot,
      { episodeId: "episode", timelineHash: TIMELINE }, { ...base, publishRenameSync: (from, to) => {
        if (from.toString().startsWith(`${target}.recover-`) && to === target && !replaced) {
          replaced = true;
          renameSync(from, validatedTarget);
          mkdirSync(from);
        }
        renameSync(from, to);
      } }), /捕获目录已被替换/u);
    assert.equal((await stat(backup)).isDirectory(), true, "有效 backup 不得被竞态删除");
    assert.equal((await stat(validatedTarget)).isDirectory(), true);
  } finally {
    current.connection.close();
    await rm(current.dataRoot, { recursive: true, force: true });
  }
});

test("backup-only 验证后被替换时不得恢复未验证目录", async () => {
  const current = await fixture();
  const base = {
    probe: async (path: string) => ({ bytes: (await stat(path)).size, durationMs: 60_000 }),
    run: async (_command: string, _args: string[], options?: { cwd?: string }) => {
      if (!options?.cwd) throw new Error("missing cwd");
      await writeFile(join(options.cwd, "final.tmp.mp4"), "final-video"); return "";
    },
  };
  try {
    const first = await exportFinalVideo(current.connection.database, current.dataRoot,
      { episodeId: "episode", timelineHash: TIMELINE }, base);
    const target = dirname(first.finalPath);
    const backup = `${target}.backup`;
    const validatedBackup = `${backup}.validated`;
    await rename(target, backup);
    let replaced = false;
    await assert.rejects(exportFinalVideo(current.connection.database, current.dataRoot,
      { episodeId: "episode", timelineHash: TIMELINE }, { ...base, publishRenameSync: (from, to) => {
        if (from.toString().startsWith(`${backup}.recover-`) && to === target && !replaced) {
          replaced = true;
          renameSync(from, validatedBackup);
          mkdirSync(from);
        }
        renameSync(from, to);
      } }), /捕获目录已被替换/u);
    assert.equal((await stat(target)).isDirectory(), true, "替换后的未验证目录只能留作失败现场");
    await assert.rejects(stat(backup), { code: "ENOENT" });
    assert.equal((await stat(validatedBackup)).isDirectory(), true);
  } finally {
    current.connection.close();
    await rm(current.dataRoot, { recursive: true, force: true });
  }
});

test("成对发布失败会恢复旧目录且不留下撕裂版本", async () => {
  const current = await fixture();
  const base = {
    probe: async (path: string) => ({ bytes: (await stat(path)).size, durationMs: 60_000 }),
    run: async (_command: string, _args: string[], options?: { cwd?: string; signal?: AbortSignal }) => {
      if (!options?.cwd) throw new Error("missing cwd");
      await writeFile(join(options.cwd, "final.tmp.mp4"), "final-video"); return "";
    },
  };
  try {
    const first = await exportFinalVideo(current.connection.database, current.dataRoot,
      { episodeId: "episode", timelineHash: TIMELINE }, base);
    await writeFile(first.manifestPath, "invalid-old-manifest");
    await assert.rejects(exportFinalVideo(current.connection.database, current.dataRoot,
      { episodeId: "episode", timelineHash: TIMELINE }, {
        ...base,
        publishRenameSync: (from, to) => {
          if (from.toString().includes(".tmp") && to.toString() === dirname(first.finalPath)) throw new Error("publish-failure");
          renameSync(from, to);
        },
      }), /publish-failure/);
    assert.equal(await readFile(first.manifestPath, "utf8"), "invalid-old-manifest");
    assert.equal(await readFile(first.finalPath, "utf8"), "final-video");
  } finally {
    current.connection.close();
    await rm(current.dataRoot, { recursive: true, force: true });
  }
});

test("最后一次分片复验返回取消时不进入目录切换并清理 staging", async () => {
  const current = await fixture();
  const base = {
    probe: async (path: string) => ({ bytes: (await stat(path)).size, durationMs: 60_000 }),
    run: async (_command: string, _args: string[], options?: { cwd?: string }) => {
      if (!options?.cwd) throw new Error("missing cwd");
      await writeFile(join(options.cwd, "final.tmp.mp4"), "final-video"); return "";
    },
  };
  try {
    const old = await exportFinalVideo(current.connection.database, current.dataRoot,
      { episodeId: "episode", timelineHash: TIMELINE }, base);
    const oldVideo = await readFile(old.finalPath);
    const oldManifest = await readFile(old.manifestPath);
    const controller = new AbortController();
    let sourceProbes = 0;
    let publishRenames = 0;
    let rejected: unknown;
    try {
      await exportFinalVideo(current.connection.database, current.dataRoot,
        { episodeId: "episode", timelineHash: TIMELINE, signal: controller.signal }, {
          ...base,
          probe: async (path, signal) => {
            if (path === old.finalPath) throw new Error("force-rebuild");
            const result = await base.probe(path);
            if (path === current.chunkPath && ++sourceProbes === 2) controller.abort();
            if (signal?.aborted && path !== current.chunkPath) throw new JobCancelledError();
            return result;
          },
          publishRenameSync: (from, to) => { publishRenames += 1; renameSync(from, to); },
        });
    } catch (error) { rejected = error; }
    assert.ok(rejected instanceof JobCancelledError);
    assert.equal(sourceProbes, 2, "取消必须发生在最后一轮源分片复验返回时");
    assert.equal(publishRenames, 0, "取消后不能进入 target/backup/staged 切换");
    assert.deepEqual(await readFile(old.finalPath), oldVideo);
    assert.deepEqual(await readFile(old.manifestPath), oldManifest);
    assert.deepEqual((await readdir(dirname(dirname(old.finalPath)))).filter((name) => name.endsWith(".tmp")), []);
  } finally {
    current.connection.close();
    await rm(current.dataRoot, { recursive: true, force: true });
  }
});

test("最后异步复验期间撤回批准会拒绝发布并保留旧 pair", async () => {
  const current = await fixture();
  const base = {
    probe: async (path: string) => ({ bytes: (await stat(path)).size, durationMs: 60_000 }),
    run: async (_command: string, _args: string[], options?: { cwd?: string }) => {
      if (!options?.cwd) throw new Error("missing cwd");
      await writeFile(join(options.cwd, "final.tmp.mp4"), "final-video"); return "";
    },
  };
  try {
    const old = await exportFinalVideo(current.connection.database, current.dataRoot,
      { episodeId: "episode", timelineHash: TIMELINE }, base);
    const oldVideo = await readFile(old.finalPath);
    const oldManifest = await readFile(old.manifestPath);
    let sourceProbes = 0;
    let publishRenames = 0;
    await assert.rejects(exportFinalVideo(current.connection.database, current.dataRoot,
      { episodeId: "episode", timelineHash: TIMELINE }, {
        ...base,
        probe: async (path) => {
          if (path === old.finalPath) throw new Error("force-rebuild");
          const result = await base.probe(path);
          if (path === current.chunkPath && ++sourceProbes === 2) {
            current.connection.database.prepare(
              "INSERT INTO script_approval_events (id,episode_id,revision,action,script_version_id,created_at) VALUES ('withdraw','episode',2,'withdraw','script',2)",
            ).run();
          }
          return result;
        },
        publishRenameSync: (from, to) => { publishRenames += 1; renameSync(from, to); },
      }), /未人工批准|批准/);
    assert.equal(sourceProbes, 2, "撤回必须发生在最终异步文件复验期间");
    assert.equal(publishRenames, 0, "批准身份变化后不能进入目录切换");
    assert.deepEqual(await readFile(old.finalPath), oldVideo);
    assert.deepEqual(await readFile(old.manifestPath), oldManifest);
    assert.deepEqual((await readdir(dirname(dirname(old.finalPath)))).filter((name) => name.endsWith(".tmp")), []);
  } finally {
    current.connection.close();
    await rm(current.dataRoot, { recursive: true, force: true });
  }
});
