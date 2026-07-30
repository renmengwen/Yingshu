import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, readFile, rm, stat } from "node:fs/promises";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  appendAssetCandidateReview,
  listAssetCandidateReviewEvents,
  listAssetCandidates,
  registerAssetCandidate,
  type AssetCandidateRecord,
} from "../asset-candidate-store.js";
import { openDatabase } from "../database.js";
import {
  createImageCandidateJobHandler,
  enqueueImageCandidateJob,
  IMAGE_CANDIDATE_JOB_TYPE,
} from "../image-candidate-job.js";
import { generateOpenAiImage, type OpenAiImageConfig } from "../image-provider.js";
import { getJob } from "../job-store.js";
import { JobWorker } from "../job-worker.js";
import { changeScriptApproval } from "../script-approval-store.js";

const MODEL = "doubao-seedream-4-5-251128";
const MUSEDOCK_CONFIG = "D:\\code3\\MuseDock\\data\\config\\ai-models.json";

async function readGateConfig(): Promise<OpenAiImageConfig> {
  const stored = JSON.parse(await readFile(MUSEDOCK_CONFIG, "utf8")) as {
    providers?: Record<string, {
      apiKey?: unknown; baseUrl?: unknown;
      models?: { image?: { enabled?: unknown; modelId?: unknown } };
    }>;
  };
  for (const [providerId, provider] of Object.entries(stored.providers ?? {})) {
    const image = provider.models?.image;
    if (image?.enabled === true && image.modelId === MODEL &&
        typeof provider.apiKey === "string" && provider.apiKey.trim() &&
        typeof provider.baseUrl === "string" && provider.baseUrl.trim()) {
      return {
        providerId,
        model: MODEL,
        apiKey: provider.apiKey.trim(),
        baseUrl: provider.baseUrl.trim().replace(/\/+$/, ""),
      };
    }
  }
  throw new Error("真实图片模型未配置");
}

function seed(database: ReturnType<typeof openDatabase>["database"]) {
  database.prepare(
    `INSERT INTO books (id, title, original_file_path, original_file_hash, encoding, import_status)
     VALUES ('p5_book', 'P5 候选图门禁', 'source.txt', ?, 'utf-8', 'ready')`,
  ).run("1".repeat(64));
  database.prepare(
    `INSERT INTO series_projects (id, book_id, title, created_at, updated_at)
     VALUES ('p5_series', 'p5_book', '红楼梦竖屏样片', 1, 1)`,
  ).run();
  database.prepare(
    `INSERT INTO episodes (
      id, series_project_id, episode_index, title, story_arc, target_duration_seconds, created_at, updated_at
    ) VALUES ('p5_episode', 'p5_series', 1, '黛玉进府', '初入荣国府', 240, 1, 1)`,
  ).run();
  database.prepare(
    `INSERT INTO assets (
      id, series_project_id, asset_type, asset_role, canonical_name, normalized_name, created_at
    ) VALUES
      ('p5_generated_asset', 'p5_series', 'character', 'master', '林黛玉', '林黛玉', 1),
      ('p5_uploaded_asset', 'p5_series', 'scene', 'master', '荣国府', '荣国府', 2)`,
  ).run();
  const content = JSON.stringify({
    paragraphs: [{ text: "林黛玉辞别父亲，乘船北上，初入荣国府。", sourceIndexes: [0] }],
  });
  database.prepare(
    `INSERT INTO script_versions (
      id, episode_id, kind, version, parent_version_id, content_json, content_hash, created_at
    ) VALUES ('p5_script', 'p5_episode', 'packaged', 1, NULL, ?, ?, 1)`,
  ).run(content, createHash("sha256").update(content).digest("hex"));
  changeScriptApproval(database, "p5_episode", {
    action: "approve", expectedRevision: 0, scriptVersionId: "p5_script",
  });
}

function probe(path: string) {
  const result = spawnSync("ffprobe", [
    "-v", "error", "-select_streams", "v:0", "-show_entries", "stream=codec_name,width,height",
    "-of", "json", path,
  ], { windowsHide: true, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout) as { streams?: Array<{ codec_name?: string; width?: number; height?: number }> };
}

const config = await readGateConfig();
const repositoryRoot = fileURLToPath(new URL("../../../../", import.meta.url));
const dataRoot = resolve(repositoryRoot, "data/gates/p5-candidates");
assert.equal(dataRoot.startsWith(resolve(repositoryRoot, "data/gates")), true);
await rm(dataRoot, { recursive: true, force: true });
await mkdir(dataRoot, { recursive: true });

let connection = openDatabase(dataRoot);
try {
  seed(connection.database);

  const uploadPath = join(dataRoot, "local-upload.png");
  const fixture = spawnSync("ffmpeg", [
    "-v", "error", "-f", "lavfi", "-i", "color=c=0x8d8073:s=900x1600", "-frames:v", "1", "-y", uploadPath,
  ], { windowsHide: true, encoding: "utf8" });
  assert.equal(fixture.status, 0, fixture.stderr);
  const uploaded = await registerAssetCandidate(connection.database, dataRoot, {
    assetId: "p5_uploaded_asset",
    source: { kind: "upload", originalName: "荣国府本地图.png" },
    raw: createReadStream(uploadPath),
  });
  assert.equal(uploaded.width, 900);
  assert.equal(uploaded.height, 1600);

  const { job } = enqueueImageCandidateJob(connection.database, config, {
    payload: {
      episodeId: "p5_episode",
      assetId: "p5_generated_asset",
      prompt: "中国古典文学人物林黛玉，清雅克制的影视定妆照，真实布料与自然肤质，荣国府室内柔和天光，竖屏全身构图，无文字无水印",
    },
    maxAttempts: 1,
  });
  const handler = createImageCandidateJobHandler(connection.database, dataRoot, config, {
    generate: (input) => generateOpenAiImage({
      ...input,
      signal: AbortSignal.any([input.signal ?? new AbortController().signal, AbortSignal.timeout(180_000)]),
    }),
  });
  const worker = new JobWorker(connection.database, { [IMAGE_CANDIDATE_JOB_TYPE]: handler }, {
    workerId: "p5-real-image-gate", leaseMs: 240_000, heartbeatMs: 5_000,
  });
  assert.equal(await worker.runOne(), true);
  const completed = getJob(connection.database, job.id)!;
  assert.equal(completed.status, "succeeded", completed.errorMessage ?? "真实生图任务失败");
  const result = completed.result as { candidate: AssetCandidateRecord };
  const candidate = result.candidate;
  const absolutePath = join(dataRoot, ...candidate.relativePath.split("/"));
  const bytes = await readFile(absolutePath);
  assert.equal(bytes.byteLength, candidate.bytes);
  assert.equal(createHash("sha256").update(bytes).digest("hex"), candidate.fileHash);
  const metadata = probe(absolutePath).streams?.[0];
  assert.equal(metadata?.width, candidate.width);
  assert.equal(metadata?.height, candidate.height);
  assert.ok((metadata?.width ?? 0) < (metadata?.height ?? 0));
  assert.ok(["png", "mjpeg", "webp"].includes(metadata?.codec_name ?? ""));
  assert.equal(
    (connection.database.prepare(
      "SELECT COUNT(*) AS count FROM job_checkpoints WHERE job_id = ? AND stage = 'image-candidate'",
    ).get(job.id) as { count: number }).count,
    1,
  );
  assert.equal(JSON.stringify(candidate.source).includes(config.apiKey), false);
  assert.equal(JSON.stringify(candidate.source).includes(config.baseUrl), false);

  const beforeRestart = await stat(absolutePath);
  connection.close();
  connection = openDatabase(dataRoot);
  const persisted = listAssetCandidates(connection.database, "p5_generated_asset");
  assert.equal(persisted.length, 1);
  assert.equal(persisted[0]?.id, candidate.id);
  assert.equal(persisted[0]?.fileHash, candidate.fileHash);
  assert.equal((await stat(absolutePath)).mtimeMs, beforeRestart.mtimeMs);
  appendAssetCandidateReview(connection.database, candidate.id, {
    expectedRevision: 0, action: "approve", note: "真实门禁通过",
  });
  appendAssetCandidateReview(connection.database, candidate.id, {
    expectedRevision: 1, action: "note", note: "竖屏构图已记录",
  });
  assert.deepEqual(
    listAssetCandidateReviewEvents(connection.database, candidate.id).map((event) => event.action),
    ["approve", "note"],
  );

  console.log("configured=true");
  console.log(`model=${MODEL}`);
  console.log(`candidate_id=${candidate.id}`);
  console.log(`hash=${candidate.fileHash}`);
  console.log(`bytes=${candidate.bytes}`);
  console.log(`width=${candidate.width}`);
  console.log(`height=${candidate.height}`);
  console.log(`path=${absolutePath}`);
  console.log("restart=true");
} finally {
  connection.close();
}
