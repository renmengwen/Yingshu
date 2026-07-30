import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { link, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import Fastify from "fastify";

import { openDatabase } from "./database.js";
import { registerExportRoutes } from "./export-routes.js";
import { exportFinalVideo } from "./final-video.js";
import { loadRenderPlanSnapshot } from "./render-chunk-job.js";

const TIMELINE = "a".repeat(64);
const hash = (content: string | Buffer) => createHash("sha256").update(content).digest("hex");

async function fixture() {
  const dataRoot = await mkdtemp(join(tmpdir(), "narralume-export-routes-"));
  const connection = openDatabase(dataRoot);
  const db = connection.database;
  const original = Buffer.from("o");
  const image = Buffer.from("i");
  const audio = Buffer.from("a");
  await mkdir(join(dataRoot, "books"), { recursive: true });
  await mkdir(join(dataRoot, "assets/candidates"), { recursive: true });
  await mkdir(join(dataRoot, "episodes/episode/audio/segments"), { recursive: true });
  await writeFile(join(dataRoot, "books/source.txt"), original);
  await writeFile(join(dataRoot, "assets/candidates/x.png"), image);
  await writeFile(join(dataRoot, "episodes/episode/audio/segments/audio.wav"), audio);
  await writeFile(join(dataRoot, `episodes/episode/audio/${TIMELINE}.srt`), "srt");
  await writeFile(join(dataRoot, `episodes/episode/audio/${TIMELINE}.ass`), "ass");
  db.prepare("INSERT INTO books (id,title,original_file_path,original_file_hash,encoding,import_status) VALUES ('book','book','books/source.txt',?,'UTF-8','ready')").run(hash(original));
  db.prepare("INSERT INTO series_projects (id,book_id,title,created_at,updated_at) VALUES ('series','book','series',1,1)").run();
  db.prepare("INSERT INTO episodes (id,series_project_id,episode_index,title,story_arc,target_duration_seconds,created_at,updated_at) VALUES ('episode','series',1,'episode','arc',180,1,1)").run();
  db.prepare("INSERT INTO episodes (id,series_project_id,episode_index,title,story_arc,target_duration_seconds,created_at,updated_at) VALUES ('other-episode','series',2,'other','arc',180,1,1)").run();
  db.prepare("INSERT INTO script_versions (id,episode_id,kind,version,content_json,content_hash,created_at) VALUES ('script','episode','packaged',1,'{}',?,1)").run("2".repeat(64));
  db.prepare("INSERT INTO script_approval_events (id,episode_id,revision,action,script_version_id,created_at) VALUES ('approval','episode',1,'approve','script',1)").run();
  db.prepare("INSERT INTO assets (id,series_project_id,asset_type,asset_role,canonical_name,normalized_name,created_at) VALUES ('asset','series','scene','master','scene','scene',1)").run();
  db.prepare(`INSERT INTO asset_candidates (id,asset_id,source_kind,source_identity_hash,source_json,file_hash,mime,width,height,bytes,relative_path,created_at)
    VALUES ('candidate','asset','upload',?,'{}',?,'image/png',1080,1920,1,'assets/candidates/x.png',1)`).run("3".repeat(64), hash(image));
  db.prepare("INSERT INTO asset_candidate_review_events (candidate_id,revision,action,created_at) VALUES ('candidate',1,'approve',1)").run();
  db.prepare(`INSERT INTO audio_segments (timeline_hash,segment_index,episode_id,script_version_id,text,provider_id,voice,rate,input_hash,relative_path,file_hash,bytes,duration_ms,created_at)
    VALUES (?,0,'episode','script','text','test','voice',0,?,'episodes/episode/audio/segments/audio.wav',?,1,60000,1)`).run(TIMELINE, "5".repeat(64), hash(audio));
  db.prepare("INSERT INTO subtitle_cues (timeline_hash,cue_index,segment_index,episode_id,script_version_id,start_ms,end_ms,text) VALUES (?,0,0,'episode','script',0,60000,'text')").run(TIMELINE);
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
  const exported = await exportFinalVideo(db, dataRoot, { episodeId: "episode", timelineHash: TIMELINE }, {
    probe: async (path: string) => ({ bytes: (await stat(path)).size, durationMs: 60_000 }),
    run: async (_command, _args, options) => {
      if (!options?.cwd) throw new Error("missing cwd");
      await writeFile(join(options.cwd, "final.tmp.mp4"), "final-video");
      return "";
    },
  });
  const app = Fastify({ logger: false });
  await app.register(registerExportRoutes, { database: db, dataRoot });
  return { app, connection, dataRoot, packageRoot: `${dataRoot}-project-packages`, exported };
}

async function usingFixture(run: (value: Awaited<ReturnType<typeof fixture>>) => Promise<void>) {
  const value = await fixture();
  try { await run(value); } finally {
    await value.app.close();
    value.connection.close();
    await rm(value.dataRoot, { recursive: true, force: true });
    await rm(value.packageRoot, { recursive: true, force: true });
  }
}

test("受控清单与 MP4 读取返回已复核产物及下载头", async () => usingFixture(async ({ app, exported }) => {
  const base = `/api/episodes/episode/exports/${exported.manifest.exportHash}`;
  const manifest = await app.inject({ method: "GET", url: `${base}/manifest` });
  assert.equal(manifest.statusCode, 200, manifest.body);
  assert.equal(manifest.headers["cache-control"], "no-store");
  assert.equal(manifest.headers["content-type"], "application/json; charset=utf-8");
  assert.equal(manifest.json().exportHash, exported.manifest.exportHash);

  const video = await app.inject({ method: "GET", url: `${base}/video` });
  assert.equal(video.statusCode, 200);
  assert.equal(video.headers["cache-control"], "no-store");
  assert.equal(video.headers["content-type"], "video/mp4");
  assert.equal(video.headers["content-length"], String(exported.manifest.finalVideo.bytes));
  assert.match(video.headers["content-disposition"]!, /^attachment; filename="episode-episode-[0-9a-f]{64}\.mp4"$/u);
  assert.equal(video.rawPayload.toString(), "final-video");
}));

test("服务端在受控目录为多分集数据根创建当前分集项目包", async () => usingFixture(async ({ app, dataRoot, exported }) => {
  const response = await app.inject({
    method: "POST",
    url: `/api/episodes/episode/exports/${exported.manifest.exportHash}/project-package`,
  });
  assert.equal(response.statusCode, 200, response.body);
  const body = response.json();
  const expectedPath = resolve(`${dataRoot}-project-packages`, "episode", exported.manifest.exportHash);
  assert.equal(body.packagePath, expectedPath);
  assert.equal(body.packageHash, body.manifest.packageHash);
  assert.equal(body.manifest.project.episodeId, "episode");
  assert.equal(body.manifest.project.finalExportHash, exported.manifest.exportHash);
  assert.equal(JSON.parse(await readFile(join(expectedPath, "manifest.json"), "utf8")).packageHash, body.packageHash);
  const repeated = await app.inject({
    method: "POST",
    url: `/api/episodes/episode/exports/${exported.manifest.exportHash}/project-package`,
  });
  assert.equal(repeated.statusCode, 200, repeated.body);
  assert.equal(repeated.json().packageHash, body.packageHash);
}));

test("项目包路由拒绝客户端路径、假标识和过期导出", async (context) => {
  await context.test("body 不接受路径或额外字段", async () => usingFixture(async ({ app, exported }) => {
    const response = await app.inject({
      method: "POST",
      url: `/api/episodes/episode/exports/${exported.manifest.exportHash}/project-package`,
      payload: { packagePath: "D:/client-controlled" },
    });
    assert.equal(response.statusCode, 400);
  }));
  await context.test("假 hash 与其他 Episode 被拒绝", async () => usingFixture(async ({ app, exported }) => {
    assert.equal((await app.inject({ method: "POST", url: "/api/episodes/episode/exports/INVALID/project-package" })).statusCode, 400);
    assert.equal((await app.inject({ method: "POST", url: `/api/episodes/other/exports/${exported.manifest.exportHash}/project-package` })).statusCode, 404);
  }));
  await context.test("当前批准撤回后旧导出过期", async () => usingFixture(async ({ app, connection, exported }) => {
    connection.database.prepare("INSERT INTO script_approval_events (id,episode_id,revision,action,script_version_id,created_at) VALUES ('withdraw-package','episode',2,'withdraw','script',2)").run();
    const response = await app.inject({ method: "POST", url: `/api/episodes/episode/exports/${exported.manifest.exportHash}/project-package` });
    assert.equal(response.statusCode, 409);
  }));
});

test("生产就绪路由返回真实阻断并拒绝非法查询", async () => usingFixture(async ({ app, connection }) => {
  connection.database.prepare(
    "INSERT INTO script_approval_events (id,episode_id,revision,action,script_version_id,created_at) VALUES ('withdraw-readiness','episode',2,'withdraw','script',2)",
  ).run();
  const blocked = await app.inject({
    method: "GET",
    url: `/api/episodes/episode/export-readiness?timelineHash=${TIMELINE}`,
  });
  assert.equal(blocked.statusCode, 200, blocked.body);
  assert.equal(blocked.json().productionReady, false);
  assert.match(blocked.json().blockers[0].message, /未人工批准/);

  const missing = await app.inject({ method: "GET", url: "/api/episodes/episode/export-readiness" });
  const invalid = await app.inject({
    method: "GET",
    url: `/api/episodes/episode/export-readiness?timelineHash=INVALID&extra=1`,
  });
  assert.equal(missing.statusCode, 400);
  assert.equal(invalid.statusCode, 400);
}));

test("假标识、错集、过期、损坏与非独占文件均被拒绝", async (context) => {
  await context.test("假 hash 与错 Episode", async () => usingFixture(async ({ app, exported }) => {
    assert.equal((await app.inject({ method: "GET", url: "/api/episodes/episode/exports/INVALID/manifest" })).statusCode, 400);
    assert.equal((await app.inject({ method: "GET", url: `/api/episodes/other/exports/${exported.manifest.exportHash}/video` })).statusCode, 404);
  }));
  await context.test("撤回批准后旧导出过期", async () => usingFixture(async ({ app, connection, exported }) => {
    connection.database.prepare("INSERT INTO script_approval_events (id,episode_id,revision,action,script_version_id,created_at) VALUES ('withdraw','episode',2,'withdraw','script',2)").run();
    assert.equal((await app.inject({ method: "GET", url: `/api/episodes/episode/exports/${exported.manifest.exportHash}/manifest` })).statusCode, 409);
  }));
  await context.test("清单路径和视频 hash 损坏", async () => usingFixture(async ({ app, exported }) => {
    const manifest = JSON.parse(await readFile(exported.manifestPath, "utf8"));
    manifest.finalVideo.relativePath = "elsewhere/video.mp4";
    await writeFile(exported.manifestPath, JSON.stringify(manifest));
    assert.equal((await app.inject({ method: "GET", url: `/api/episodes/episode/exports/${exported.manifest.exportHash}/manifest` })).statusCode, 409);
  }));
  await context.test("视频内容与登记 hash 不符", async () => usingFixture(async ({ app, exported }) => {
    await writeFile(exported.finalPath, "tampered-video");
    assert.equal((await app.inject({ method: "GET", url: `/api/episodes/episode/exports/${exported.manifest.exportHash}/video` })).statusCode, 409);
  }));
  await context.test("hardlink 视频不是独占文件", async () => usingFixture(async ({ app, exported }) => {
    await link(exported.finalPath, `${exported.finalPath}.hardlink`);
    assert.equal((await app.inject({ method: "GET", url: `/api/episodes/episode/exports/${exported.manifest.exportHash}/video` })).statusCode, 409);
  }));
});
