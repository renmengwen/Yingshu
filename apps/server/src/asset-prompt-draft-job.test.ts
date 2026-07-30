import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { ChapterTextModelConfig } from "./chapter-event-analyzer.js";
import {
  ASSET_PROMPT_DRAFT_JOB_TYPE,
  createOpenAiAssetPromptDraftGenerator,
  createAssetPromptDraftJobHandler,
  enqueueAssetPromptDraftJob,
} from "./asset-prompt-draft-job.js";
import { openDatabase } from "./database.js";
import { getJob } from "./job-store.js";
import { JobWorker } from "./job-worker.js";
import { textModelConcurrencyGate } from "./text-model-concurrency.js";
import { TextModelCallError } from "./text-model-stream.js";

const config: ChapterTextModelConfig = {
  baseUrl: "https://unused.invalid/v1", apiKey: "unused", model: "fixture-model", providerId: "fixture-provider",
};
const sha = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");

async function fixture() {
  const dataRoot = await mkdtemp(join(tmpdir(), "narralume-asset-prompt-"));
  const connection = openDatabase(dataRoot);
  const db = connection.database;
  const original = Buffer.from("原文明确写着石门缓慢打开。", "utf8");
  await mkdir(join(dataRoot, "books", "book"), { recursive: true });
  await writeFile(join(dataRoot, "books", "book", "source.txt"), original);
  db.prepare(`INSERT INTO books (id,title,original_file_path,original_file_hash,encoding,import_status)
    VALUES ('book','书','books/book/source.txt',?,'UTF-8','ready')`).run(sha(original));
  db.prepare("INSERT INTO chapters (id,book_id,chapter_index,title,byte_start,byte_end,char_count,content_hash) VALUES ('chapter','book',0,'第一章',0,?,?,?)")
    .run(original.length, [..."原文明确写着石门缓慢打开。"].length, sha(original));
  db.prepare("INSERT INTO chapter_events (id,chapter_id,event_index,occurrence,event_type,payload_json,created_at) VALUES ('event','chapter',0,0,'revelation','{\"fact\":\"石门打开\"}',1)").run();
  db.prepare("INSERT INTO series_projects (id,book_id,title,created_at,updated_at) VALUES ('series','book','系列',1,1)").run();
  db.prepare("INSERT INTO episodes (id,series_project_id,episode_index,title,story_arc,target_duration_seconds,created_at,updated_at) VALUES ('episode','series',1,'第一集','石门开启',180,1,1)").run();
  db.prepare(`INSERT INTO episode_sources (episode_id,source_index,chapter_id,source_event_id,source_byte_start,source_byte_end,source_hash)
    VALUES ('episode',0,'chapter','event',0,?,?)`).run(original.length, sha(original));
  const content = JSON.stringify({ paragraphs: [{ text: "石门缓慢打开。", sourceIndexes: [0] }] });
  db.prepare(`INSERT INTO script_versions (id,episode_id,kind,version,parent_version_id,content_json,content_hash,created_at,script_contract_version)
    VALUES ('script','episode','packaged',1,NULL,?,?,1,6)`).run(content, sha(content));
  db.prepare(`INSERT INTO script_version_sources (script_version_id,segment_index,source_index,episode_source_index,chapter_id,source_event_id,source_byte_start,source_byte_end,source_hash)
    VALUES ('script',0,0,0,'chapter','event',0,?,?)`).run(original.length, sha(original));
  db.prepare("INSERT INTO script_approval_events (id,episode_id,revision,action,script_version_id,created_at) VALUES ('approval','episode',1,'approve','script',1)").run();
  db.prepare(`INSERT INTO assets (id,series_project_id,asset_type,asset_role,canonical_name,normalized_name,created_at)
    VALUES ('asset','series','scene','master','石门','石门',1)`).run();
  db.prepare("INSERT INTO asset_aliases (series_project_id,asset_id,alias,normalized_alias,is_primary,created_at) VALUES ('series','asset','石门','石门',1,1)").run();
  return { dataRoot, connection, db };
}

const output = {
  evidence: "批准旁白和原文均明确写到石门打开",
  sceneIntent: "表现石门开启",
  subjectAction: "石门缓慢打开",
  environment: "石门所在空间",
  lightingComposition: "中景正视石门",
  styleConstraints: "禁止水印、无来源文字和现代品牌",
  prompt: "中景正视石门缓慢打开，禁止水印、无来源文字和现代品牌",
};

test("资产 Prompt 草稿模型请求经过共享文本并发闸门", async (t) => {
  let gateRuns = 0;
  t.mock.method(textModelConcurrencyGate, "run", async (_signal: AbortSignal | undefined, task: () => Promise<unknown>) => {
    gateRuns += 1; return task();
  });
  const generate = createOpenAiAssetPromptDraftGenerator(config, (async () => new Response(
    JSON.stringify({ output_text: JSON.stringify(output) }),
    { headers: { "content-type": "application/json" } },
  )) as typeof fetch);
  assert.deepEqual(await generate({
    prompt: "生成草稿", stage: "asset-prompt:asset", signal: new AbortController().signal, onActivity: () => undefined,
  }), output);
  assert.equal(gateRuns, 1);
});

test("资产 Prompt 草稿在成功收流后的 JSON 错误保留调用阶段和响应证据", async () => {
  const generate = createOpenAiAssetPromptDraftGenerator(config, (async () => new Response([
    'data: {"type":"response.output_text.delta","delta":"不是 JSON"}\n\n',
    'data: {"type":"response.completed"}\n\n',
  ].join(""), { headers: { "content-type": "text/event-stream", "x-request-id": "asset-request" } })) as typeof fetch);
  const error = await generate({
    prompt: "生成草稿", stage: "asset-prompt:asset", signal: new AbortController().signal, onActivity: () => undefined,
  }).then(() => undefined, (reason: unknown) => reason);
  assert.ok(error instanceof TextModelCallError);
  assert.equal(error.stage, "asset-prompt:asset");
  assert.equal(error.evidence.partialText, "不是 JSON");
  assert.equal(error.evidence.statistics?.terminalReceived, true);
  assert.equal(error.evidence.statistics?.requestIds["x-request-id"], "asset-request");
});

test("资产 Prompt 草稿领域合同错误保留成功模型结果证据", async () => {
  const setup = await fixture();
  try {
    const queued = await enqueueAssetPromptDraftJob(setup.db, setup.dataRoot, config, {
      payload: { episodeId: "episode", assetId: "asset" }, maxAttempts: 1,
    });
    const generate = createOpenAiAssetPromptDraftGenerator(config, (async () => new Response([
      'data: {"type":"response.output_text.delta","delta":"{}"}\n\n',
      'data: {"type":"response.completed"}\n\n',
    ].join(""), { headers: { "content-type": "text/event-stream" } })) as typeof fetch);
    const worker = new JobWorker(setup.db, {
      [ASSET_PROMPT_DRAFT_JOB_TYPE]: createAssetPromptDraftJobHandler(setup.db, setup.dataRoot, config, generate),
    }, {
      workerId: "asset-prompt-contract", leaseMs: 5_000, heartbeatMs: 100,
      textModelDiagnosticsRoot: setup.dataRoot,
    });
    assert.equal(await worker.runOne(), true);
    const failed = getJob(setup.db, queued.job.id)!;
    assert.equal(failed.status, "failed");
    assert.match(failed.errorMessage ?? "", /字段无效/u);
    const directory = join(setup.dataRoot, "diagnostics", "text-model");
    const files = await readdir(directory);
    assert.equal(files.length, 1);
    const diagnostic = JSON.parse(await readFile(join(directory, files[0]!), "utf8"));
    assert.equal(diagnostic.stage, "asset-prompt:asset");
    assert.equal(diagnostic.partialText.content, "{}");
    assert.equal(diagnostic.statistics.terminalReceived, true);
  } finally { setup.connection.close(); await rm(setup.dataRoot, { recursive: true, force: true }); }
});

test("资产 Prompt 草稿只写现有 Job/checkpoint，不创建图片、审核或视觉绑定", async () => {
  const setup = await fixture();
  try {
    let prompt = "";
    const queued = await enqueueAssetPromptDraftJob(setup.db, setup.dataRoot, config, {
      payload: { episodeId: "episode", assetId: "asset", draftKind: "story" }, maxAttempts: 1,
    });
    const worker = new JobWorker(setup.db, {
      [ASSET_PROMPT_DRAFT_JOB_TYPE]: createAssetPromptDraftJobHandler(setup.db, setup.dataRoot, config, async (input) => {
        prompt = input.prompt;
        return output;
      }),
    }, { workerId: "asset-prompt-fixture", leaseMs: 5_000, heartbeatMs: 100 });
    assert.equal(await worker.runOne(), true);
    const completed = getJob(setup.db, queued.job.id)!;
    assert.equal(completed.status, "succeeded");
    assert.deepEqual(completed.result, output);
    assert.equal((completed.payload as { productPromptVersion: string }).productPromptVersion, "asset-prompt-draft-product-v1");
    assert.match(prompt, /石门缓慢打开/u);
    assert.match(prompt, /只生成草稿/u);
    assert.equal(setup.db.prepare("SELECT COUNT(*) AS count FROM job_checkpoints WHERE job_id = ?").get(queued.job.id)!.count, 1);
    assert.equal(setup.db.prepare("SELECT COUNT(*) AS count FROM asset_candidates").get()!.count, 0);
    assert.equal(setup.db.prepare("SELECT COUNT(*) AS count FROM asset_candidate_review_events").get()!.count, 0);
    assert.equal(setup.db.prepare("SELECT COUNT(*) AS count FROM visual_segments").get()!.count, 0);
    assert.equal((await enqueueAssetPromptDraftJob(setup.db, setup.dataRoot, config, {
      payload: { episodeId: "episode", assetId: "asset", draftKind: "story" }, maxAttempts: 1,
    })).created, false);
  } finally { setup.connection.close(); await rm(setup.dataRoot, { recursive: true, force: true }); }
});

test("资产 Prompt 草稿拒绝未批准稿和跨系列资产", async () => {
  const setup = await fixture();
  try {
    setup.db.prepare("INSERT INTO series_projects (id,book_id,title,created_at,updated_at) VALUES ('other','book','其他',1,1)").run();
    setup.db.prepare("INSERT INTO assets (id,series_project_id,asset_type,asset_role,canonical_name,normalized_name,created_at) VALUES ('other_asset','other','scene','master','别处','别处',1)").run();
    await assert.rejects(() => enqueueAssetPromptDraftJob(setup.db, setup.dataRoot, config, {
      payload: { episodeId: "episode", assetId: "other_asset" },
    }), /不属于同一系列/u);
    setup.db.prepare("DELETE FROM script_approval_events").run();
    await assert.rejects(() => enqueueAssetPromptDraftJob(setup.db, setup.dataRoot, config, {
      payload: { episodeId: "episode", assetId: "asset" },
    }), /未人工批准/u);
  } finally { setup.connection.close(); await rm(setup.dataRoot, { recursive: true, force: true }); }
});
