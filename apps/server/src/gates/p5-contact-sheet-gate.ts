import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, readFile, rm, unlink } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  appendAssetCandidateReview,
  listAssetCandidateReviewEvents,
  registerAssetCandidate,
} from "../asset-candidate-store.js";
import { addAssetAliases, createAsset, listAssets } from "../asset-store.js";
import { exportContactSheet } from "../contact-sheet.js";
import { openDatabase } from "../database.js";
import { createJob, getJob } from "../job-store.js";
import { JobWorker } from "../job-worker.js";
import { changeScriptApproval } from "../script-approval-store.js";
import { createTtsTimelineJobHandler, TTS_TIMELINE_JOB_TYPE } from "../tts-timeline-job.js";
import { assertVisualPlanReady, putVisualSegment, type VisualMotionKind } from "../visual-segment-store.js";

const EPISODE_ID = "p5_contact_sheet_episode";
const SERIES_ID = "p5_contact_sheet_series";
const narration = Array.from({ length: 10 }, (_, index) =>
  `第${index + 1}段，故事从顽石入世写到黛玉初进荣国府。镜头保留梦中通灵之物、人物偶然回望、家族兴衰疑问和少女投亲四条已有线索。黛玉谨慎观察称呼、座次与人物关系；宝玉归来，两人初见时生出似曾相识之感。叙事只使用原稿已有的人物、动作和地点，不凭空制造冲突，并让每个画面都能回到批准稿与真实时间轴。`,
);

const hash = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");

function seed(database: ReturnType<typeof openDatabase>["database"]) {
  database.prepare(
    `INSERT INTO books (id, title, original_file_path, original_file_hash, encoding, import_status)
     VALUES ('p5_contact_sheet_book', '红楼梦', 'source.txt', ?, 'utf-8', 'ready')`,
  ).run("1".repeat(64));
  database.prepare(
    `INSERT INTO series_projects (id, book_id, title, created_at, updated_at)
     VALUES (?, 'p5_contact_sheet_book', '黛玉初入荣国府', 1, 1)`,
  ).run(SERIES_ID);
  database.prepare(
    `INSERT INTO episodes (
       id, series_project_id, episode_index, title, story_arc, target_duration_seconds, created_at, updated_at
     ) VALUES (?, ?, 1, '第一集', '从顽石入世到宝黛初见', 240, 1, 1)`,
  ).run(EPISODE_ID, SERIES_ID);
  const content = JSON.stringify({ paragraphs: narration.map((text) => ({ text, sourceIndexes: [0] })) });
  database.prepare(
    `INSERT INTO script_versions (
       id, episode_id, kind, version, parent_version_id, content_json, content_hash, created_at
     ) VALUES ('p5_contact_sheet_script', ?, 'packaged', 1, NULL, ?, ?, 1)`,
  ).run(EPISODE_ID, content, hash(content));
  changeScriptApproval(database, EPISODE_ID, {
    action: "approve", expectedRevision: 0, scriptVersionId: "p5_contact_sheet_script",
  });
}

async function createTimeline(database: ReturnType<typeof openDatabase>["database"], dataRoot: string) {
  const job = createJob(database, {
    type: TTS_TIMELINE_JOB_TYPE, payload: { episodeId: EPISODE_ID, rate: 2 }, maxAttempts: 1,
  });
  const worker = new JobWorker(database, {
    [TTS_TIMELINE_JOB_TYPE]: createTtsTimelineJobHandler(database, dataRoot),
  }, { workerId: "p5-contact-sheet-real-tts", leaseMs: 900_000, heartbeatMs: 10_000 });
  assert.equal(await worker.runOne(), true);
  const completed = getJob(database, job.id)!;
  assert.equal(completed.status, "succeeded", completed.errorMessage ?? "真实 TTS 时间轴失败");
  return completed.result as { timelineHash: string; durationMs: number; cueCount: number };
}

function createPng(path: string, color: string) {
  const result = spawnSync("ffmpeg", [
    "-v", "error", "-f", "lavfi", "-i", `color=c=${color}:s=900x1600`,
    "-frames:v", "1", "-y", path,
  ], { windowsHide: true, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
}

const repositoryRoot = fileURLToPath(new URL("../../../../", import.meta.url));
const dataRoot = resolve(repositoryRoot, "data/gates/p5-contact-sheet");
assert.equal(dataRoot.startsWith(resolve(repositoryRoot, "data/gates")), true);
await rm(dataRoot, { recursive: true, force: true });
await mkdir(dataRoot, { recursive: true });

let connection = openDatabase(dataRoot);
try {
  seed(connection.database);
  const character = createAsset(connection.database, SERIES_ID, {
    type: "character", name: "林黛玉", description: "长期人物主资产",
  });
  createAsset(connection.database, SERIES_ID, {
    type: "character", name: "林黛玉·初入贾府", parentAssetId: character.id, stateLabel: "初入贾府",
  });
  const scene = createAsset(connection.database, SERIES_ID, { type: "scene", name: "荣国府" });
  const prop = createAsset(connection.database, SERIES_ID, { type: "prop", name: "通灵宝玉" });
  addAssetAliases(connection.database, character.id, ["黛玉", "林姑娘"]);
  addAssetAliases(connection.database, scene.id, ["贾府"]);
  addAssetAliases(connection.database, prop.id, ["宝玉"]);
  const assets = listAssets(connection.database, SERIES_ID);
  assert.equal(assets.length, 3);
  assert.equal(assets.find((asset) => asset.id === character.id)?.states.length, 1);

  const timeline = await createTimeline(connection.database, dataRoot);
  assert.equal(timeline.cueCount, narration.length);
  assert.ok(timeline.durationMs >= 180_000 && timeline.durationMs <= 300_000,
    `真实旁白时长不在 3～5 分钟：${timeline.durationMs}ms`);

  const generatedFixture = join(dataRoot, "generated.png");
  const uploadedFixture = join(dataRoot, "uploaded.png");
  createPng(generatedFixture, "0x8d8073");
  createPng(uploadedFixture, "0x425467");
  const prompt = "林黛玉初入荣国府，竖屏影视定妆画面，无文字无水印";
  const generated = await registerAssetCandidate(connection.database, dataRoot, {
    assetId: character.id,
    source: {
      kind: "generation",
      episodeId: EPISODE_ID,
      scriptVersionId: "p5_contact_sheet_script",
      approvalRevision: 1,
      provider: "phase-5-gate",
      model: "local-ffmpeg-fixture",
      promptHash: hash(prompt),
      requestHash: hash(`phase-5-gate\0${prompt}`),
      size: "900x1600",
      outputIndex: 0,
    },
    raw: createReadStream(generatedFixture),
  });
  const uploaded = await registerAssetCandidate(connection.database, dataRoot, {
    assetId: scene.id,
    source: { kind: "upload", originalName: "荣国府竖屏底图.png" },
    raw: createReadStream(uploadedFixture),
  });
  assert.equal(generated.source.kind, "generation");
  assert.equal(generated.sourceJson.includes("promptHash"), true);
  assert.equal(/apiKey|baseUrl|https?:\/\//iu.test(generated.sourceJson), false);
  for (const candidate of [generated, uploaded]) {
    appendAssetCandidateReview(connection.database, candidate.id, {
      expectedRevision: 0, action: "approve", note: "Phase 5 真实门禁批准",
    });
    appendAssetCandidateReview(connection.database, candidate.id, {
      expectedRevision: 1, action: "note", note: "联系表内容与构图已核对",
    });
    assert.deepEqual(
      listAssetCandidateReviewEvents(connection.database, candidate.id).map((event) => event.action),
      ["approve", "note"],
    );
  }

  const motions: VisualMotionKind[] = ["none", "zoom-in", "pan-left", "zoom-out", "pan-right"];
  for (let index = 0; index < timeline.cueCount; index += 1) {
    const selectCharacter = index % 2 === 0;
    putVisualSegment(connection.database, EPISODE_ID, index, {
      timelineHash: timeline.timelineHash,
      cueStartIndex: index,
      cueEndIndex: index,
      motionKind: motions[index % motions.length]!,
      motionAmountPpm: motions[index % motions.length] === "none" ? 0 : 30_000,
      fadeMs: 350,
      expectedRevision: 0,
      assets: [
        { assetId: character.id, selectedCandidateId: selectCharacter ? generated.id : undefined },
        { assetId: scene.id, selectedCandidateId: selectCharacter ? undefined : uploaded.id },
        { assetId: prop.id },
      ],
    });
  }
  assert.equal(assertVisualPlanReady(connection.database, EPISODE_ID, timeline.timelineHash).length, narration.length);

  await exportContactSheet(connection.database, dataRoot, EPISODE_ID, timeline.timelineHash);
  const outputRoot = join(dataRoot, "episodes", EPISODE_ID, "contact-sheets", timeline.timelineHash);
  const jsonPath = join(outputRoot, "contact-sheet.json");
  const htmlPath = join(outputRoot, "contact-sheet.html");
  const jsonBefore = await readFile(jsonPath);
  const htmlBefore = await readFile(htmlPath);
  const manifest = JSON.parse(jsonBefore.toString("utf8")) as { segments?: unknown[] };
  assert.equal(manifest.segments?.length, narration.length);
  for (const candidate of [generated, uploaded]) {
    const bytes = await readFile(join(dataRoot, ...candidate.relativePath.split("/")));
    assert.equal(bytes.byteLength, candidate.bytes);
    assert.equal(hash(bytes), candidate.fileHash);
  }
  assert.match(htmlBefore.toString("utf8"), /<img\b/iu);

  connection.close();
  connection = openDatabase(dataRoot);
  await exportContactSheet(connection.database, dataRoot, EPISODE_ID, timeline.timelineHash);
  assert.deepEqual(await readFile(jsonPath), jsonBefore);
  assert.deepEqual(await readFile(htmlPath), htmlBefore);

  appendAssetCandidateReview(connection.database, generated.id, {
    expectedRevision: 2, action: "reject", note: "验证驳回立即阻断联系表导出",
  });
  await assert.rejects(
    exportContactSheet(connection.database, dataRoot, EPISODE_ID, timeline.timelineHash),
    /候选|批准|审核|生产/,
  );
  assert.deepEqual(await readFile(jsonPath), jsonBefore);
  assert.deepEqual(await readFile(htmlPath), htmlBefore);

  appendAssetCandidateReview(connection.database, generated.id, {
    expectedRevision: 3, action: "approve", note: "恢复后验证缺失文件阻断",
  });
  await unlink(join(dataRoot, ...uploaded.relativePath.split("/")));
  await assert.rejects(
    exportContactSheet(connection.database, dataRoot, EPISODE_ID, timeline.timelineHash),
    /候选|文件|不存在|缺失|读取/,
  );
  assert.deepEqual(await readFile(jsonPath), jsonBefore);
  assert.deepEqual(await readFile(htmlPath), htmlBefore);

  console.log("P5 联系表与阶段真实门禁通过");
  console.log(`timeline_hash=${timeline.timelineHash}`);
  console.log(`duration_ms=${timeline.durationMs}`);
  console.log(`visual_segments=${narration.length}`);
  console.log(`contact_sheet_json_sha256=${hash(jsonBefore)}`);
  console.log(`contact_sheet_html_sha256=${hash(htmlBefore)}`);
  console.log(`contact_sheet_path=${htmlPath}`);
  console.log("restart_deterministic=true");
  console.log("reject_blocks_export=true");
  console.log("missing_file_blocks_export=true");
  console.log("failed_export_preserves_previous=true");
} finally {
  connection.close();
}
