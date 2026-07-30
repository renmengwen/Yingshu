import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { ChapterTextModelConfig } from "./chapter-event-analyzer.js";
import { buildApp } from "./app.js";
import { openDatabase } from "./database.js";
import {
  createEpisodeScriptGenerationJobHandler,
  enqueueEpisodeScriptGenerationJob,
  EPISODE_SCRIPT_GENERATION_CONTRACT_VERSION,
  EPISODE_SCRIPT_GENERATION_V6_CONTRACT_VERSION,
  EPISODE_SCRIPT_GENERATION_JOB_TYPE,
  EPISODE_SCRIPT_GENERATION_IDLE_TIMEOUT_MS,
  EPISODE_SCRIPT_GENERATION_TIMEOUT_MS,
  EPISODE_SCRIPT_GENERATION_TOTAL_TIMEOUT_MS,
  type GenerateEpisodeScript,
} from "./episode-script-generation-job.js";
import { createOpenAiEpisodeScriptGenerator } from "./episode-script-provider.js";
import { getJob, requestJobCancellation } from "./job-store.js";
import { JobWorker } from "./job-worker.js";
import { writeModelConfig } from "./model-config.js";
import { getScriptApproval, requireApprovedScriptForProduction } from "./script-approval-store.js";
import { createSeriesPipelineRun, mapSeriesPipelineScriptJob } from "./series-pipeline-store.js";
import { listScriptVersions } from "./script-version-store.js";
import { textModelConcurrencyGate } from "./text-model-concurrency.js";
import { rememberTextModelEvidence, TextModelCallError } from "./text-model-stream.js";

const config: ChapterTextModelConfig = {
  baseUrl: "https://example.invalid/v1",
  apiKey: "test",
  model: "test-model",
  providerId: "test-provider",
};

async function fixture() {
  const dataRoot = await mkdtemp(join(tmpdir(), "narralume-script-job-"));
  const connection = openDatabase(dataRoot);
  const database = connection.database;
  const texts = ["第一段原文", "第二段原文", "第三段原文"];
  const bytes = texts.map((value) => Buffer.from(value));
  const source = Buffer.concat(bytes);
  await mkdir(join(dataRoot, "books", "book"), { recursive: true });
  await writeFile(join(dataRoot, "books", "book", "source.txt"), source);
  database.prepare(
    `INSERT INTO books (id,title,original_file_path,original_file_hash,encoding,import_status)
     VALUES ('book','书','books/book/source.txt',?,'UTF-8','ready')`,
  ).run(createHash("sha256").update(source).digest("hex"));
  database.prepare(
    "INSERT INTO series_projects (id,book_id,title,created_at,updated_at) VALUES ('series','book','系列',1,1)",
  ).run();
  database.prepare(
    `INSERT INTO episodes (id,series_project_id,episode_index,title,story_arc,target_duration_seconds,recap,next_hook,created_at,updated_at)
     VALUES ('episode','series',1,'第一集','进入墓道',120,'上集回顾','发现机关',1,1)`,
  ).run();
  let offset = 0;
  for (const [index, value] of bytes.entries()) {
    const end = offset + value.length;
    database.prepare(
      `INSERT INTO chapters (id,book_id,chapter_index,title,byte_start,byte_end,char_count,content_hash)
       VALUES (?,?,?,?,?,?,?,?)`,
    ).run(`chapter_${index}`, "book", index, `第${index + 1}章`, offset, end, texts[index]!.length,
      createHash("sha256").update(value).digest("hex"));
    database.prepare(
      `INSERT INTO chapter_events (id,chapter_id,event_index,occurrence,event_type,payload_json,created_at)
       VALUES (?,?,0,0,'revelation',?,1)`,
    ).run(`event_${index}`, `chapter_${index}`, JSON.stringify({ fact: `事实${index}` }));
    database.prepare(
      `INSERT INTO episode_sources (
         episode_id,source_index,chapter_id,source_event_id,source_byte_start,source_byte_end,source_hash
       ) VALUES ('episode',?,?,?,?,?,?)`,
    ).run(index, `chapter_${index}`, `event_${index}`, offset, end,
      createHash("sha256").update(value).digest("hex"));
    offset = end;
  }
  return { dataRoot, connection, database, texts };
}

const request = {
  seriesId: "series",
  episodeIndex: 1,
  voice: "说书音色",
  rate: 0,
  charactersPerSecond: 4.5,
  narrationOccupancy: 0.8,
  calibration: { identity: "provisional" as const },
};

function textForBudget(characterBudget: number, prefix = "稿") {
  return [...prefix].length >= characterBudget
    ? [...prefix].slice(0, characterBudget).join("")
    : `${prefix}${"文".repeat(characterBudget - [...prefix].length)}`;
}

test("Responses 三阶段请求不发送不兼容的 json_object format", async (t) => {
  let gateRuns = 0;
  t.mock.method(textModelConcurrencyGate, "run", async (_signal: AbortSignal | undefined, task: () => Promise<unknown>) => {
    gateRuns += 1; return task();
  });
  const outputs = [
    { beats: [{ intent: "进入墓道", sourceIndexes: [0] }] },
    { text: "忠实稿" },
    { paragraphs: [{ text: "包装稿", sourceIndexes: [0] }] },
  ];
  let calls = 0;
  const prompts: string[] = [];
  const generate = createOpenAiEpisodeScriptGenerator(config, (async (_url, init) => {
    const body = JSON.parse(String(init?.body)) as { input: string; text?: unknown };
    prompts.push(body.input);
    assert.match(body.input, /JSON/u);
    assert.equal(body.text, undefined);
    assert.equal((body as { stream?: unknown }).stream, true);
    return new Response(JSON.stringify({ output_text: JSON.stringify(outputs[calls++]!) }), {
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch);
  const signal = new AbortController().signal;
  await generate({
    stage: "skeleton", episode: { id: "episode", storyArc: "进入墓道", recap: null, nextHook: null, targetDurationSeconds: 120 },
    characterBudget: 400, calibration: { identity: "provisional" }, sources: [], signal,
  });
  await generate({ stage: "faithful", beat: { intent: "进入墓道", sourceIndexes: [0] }, characterBudget: 200,
    minimumCharacterCount: 180, maximumCharacterCount: 220,
    sources: [{ sourceIndex: 0, sourceText: "原文" }], signal });
  await generate({ stage: "packaged", targetDurationSeconds: 120, characterBudget: 400,
    minimumCharacterCount: 360, maximumCharacterCount: 440,
    paragraphs: [{ text: "忠实稿", sourceIndexes: [0] }], signal });
  assert.equal(calls, 3);
  assert.equal(gateRuns, 3);
  assert.match(prompts[1]!, /180 至 220 字/u);
  assert.match(prompts[1]!, /不得用摘要代替完整叙事/u);
  assert.match(prompts[2]!, /360 至 440 字/u);
  assert.match(prompts[2]!, /不得因润色或重组而压缩成摘要/u);
  assert.match(prompts[2]!, /不得原样返回输入 paragraphs/u);
});

test("骨架 prompt 注入完整来源 allowlist 与唯一输出 schema", async () => {
  let prompt = "";
  const generate = createOpenAiEpisodeScriptGenerator(config, (async (_url, init) => {
    const body = JSON.parse(String(init?.body)) as { input: string; stream?: boolean };
    prompt = body.input;
    assert.equal(body.stream, true);
    return Response.json({ output_text: JSON.stringify({ beats: [{ intent: "完整", sourceIndexes: [0, 1] }] }) });
  }) as typeof fetch);
  await generate({
    stage: "skeleton",
    episode: { id: "episode", storyArc: "进入墓道", recap: null, nextHook: null, targetDurationSeconds: 120 },
    characterBudget: 400,
    calibration: { identity: "provisional" },
    sources: [
      { sourceIndex: 0, chapterId: "chapter_0", sourceEventId: "event_0", eventType: "revelation", event: { fact: "事实0" } },
      { sourceIndex: 1, chapterId: "chapter_1", sourceEventId: "event_1", eventType: "revelation", event: { fact: "事实1" } },
    ],
    signal: new AbortController().signal,
  });
  assert.match(prompt, /唯一输出 schema/u);
  assert.match(prompt, /全局恰好出现一次/u);
  assert.match(prompt, /严格递增/u);
  assert.match(prompt, /不得遗漏、重复、伪造或越界/u);
  assert.equal(prompt.includes('[{"sourceIndex":0,"sourceEventId":"event_0"},{"sourceIndex":1,"sourceEventId":"event_1"}]'), true);
  assert.match(prompt, /输出中只能出现 sourceIndexes，不得输出 sourceEventId/u);
});

test("Responses SSE 仅在明确成功终态后返回完整骨架", async () => {
  const output = JSON.stringify({ beats: [{ intent: "完整", sourceIndexes: [0] }] });
  const generate = createOpenAiEpisodeScriptGenerator(config, (async () => new Response(
    `data: ${JSON.stringify({ type: "response.output_text.delta", delta: output })}\n\ndata: ${JSON.stringify({ type: "response.completed" })}\n\n`,
    { headers: { "content-type": "text/event-stream" } },
  )) as typeof fetch);
  const result = await generate({
    stage: "skeleton",
    episode: { id: "episode", storyArc: "进入墓道", recap: null, nextHook: null, targetDurationSeconds: 120 },
    characterBudget: 400,
    calibration: { identity: "provisional" },
    sources: [{ sourceIndex: 0, chapterId: "chapter_0", sourceEventId: "event_0", eventType: "revelation", event: { fact: "事实0" } }],
    signal: new AbortController().signal,
  });
  assert.deepEqual(result, { beats: [{ intent: "完整", sourceIndexes: [0] }] });
});

test("长稿 SSE 的 JSON 解析错误保留调用阶段、流统计与有界正文", async () => {
  const generate = createOpenAiEpisodeScriptGenerator(config, (async () => new Response(
    `data: ${JSON.stringify({ type: "response.output_text.delta", delta: "not-json" })}\n\n` +
      `data: ${JSON.stringify({ type: "response.completed" })}\n\n`,
    { headers: { "content-type": "text/event-stream", "x-request-id": "req-script" } },
  )) as typeof fetch);
  let caught: unknown;
  try {
    await generate({
      stage: "skeleton",
      diagnosticStage: "episode-script.skeleton.initial",
      episode: { id: "episode", storyArc: "进入墓道", recap: null, nextHook: null, targetDurationSeconds: 120 },
      characterBudget: 400,
      calibration: { identity: "provisional" },
      sources: [],
      signal: new AbortController().signal,
    });
  } catch (error) {
    caught = error;
  }

  assert.ok(caught instanceof TextModelCallError);
  assert.equal(caught.stage, "episode-script.skeleton.initial");
  assert.match(caught.message, /无效 JSON/u);
  assert.equal(caught.evidence.partialText, "not-json");
  assert.equal(caught.evidence.partialTextTruncated, false);
  assert.equal(caught.evidence.statistics?.responseFormat, "sse");
  assert.equal(caught.evidence.statistics?.eventCount, 2);
  assert.equal(caught.evidence.statistics?.terminalReceived, true);
  assert.deepEqual(caught.evidence.statistics?.requestIds, { "x-request-id": "req-script" });
});

test("长稿模型调用使用 180 秒首包与空闲、900 秒总上限", () => {
  assert.equal(EPISODE_SCRIPT_GENERATION_CONTRACT_VERSION, 5);
  assert.equal(EPISODE_SCRIPT_GENERATION_TIMEOUT_MS, 180_000);
  assert.equal(EPISODE_SCRIPT_GENERATION_IDLE_TIMEOUT_MS, 180_000);
  assert.equal(EPISODE_SCRIPT_GENERATION_TOTAL_TIMEOUT_MS, 900_000);
});

test("Anthropic Messages 配置使用 messages 端点与对应鉴权合同", async () => {
  const anthropic = { ...config, protocol: "anthropic-message" as const };
  let requestedUrl = "";
  let requestedHeaders = new Headers();
  let requestedBody: Record<string, unknown> = {};
  const generate = createOpenAiEpisodeScriptGenerator(anthropic, (async (url, init) => {
    requestedUrl = String(url);
    requestedHeaders = new Headers(init?.headers);
    requestedBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return Response.json({ content: [{ type: "text", text: JSON.stringify({ beats: [{ intent: "进入墓道", sourceIndexes: [0] }] }) }] });
  }) as typeof fetch);

  await generate({
    stage: "skeleton",
    episode: { id: "episode", storyArc: "进入墓道", recap: null, nextHook: null, targetDurationSeconds: 120 },
    characterBudget: 400,
    calibration: { identity: "provisional" },
    sources: [],
    signal: new AbortController().signal,
  });

  assert.equal(requestedUrl, "https://example.invalid/v1/messages");
  assert.equal(requestedHeaders.get("x-api-key"), "test");
  assert.equal(requestedHeaders.get("anthropic-version"), "2023-06-01");
  assert.equal(requestedHeaders.get("authorization"), null);
  assert.equal(requestedBody.model, "test-model");
  assert.equal(requestedBody.max_tokens, 8192);
  assert.equal(Array.isArray(requestedBody.messages), true);
  assert.equal(requestedBody.input, undefined);
});

async function run(
  context: Awaited<ReturnType<typeof fixture>>,
  generate: GenerateEpisodeScript,
  maxAttempts = 1,
  contract?: Parameters<typeof enqueueEpisodeScriptGenerationJob>[5],
) {
  const queued = await enqueueEpisodeScriptGenerationJob(context.database, context.dataRoot, config, {
    payload: request,
    maxAttempts,
  }, undefined, contract);
  const worker = new JobWorker(context.database, {
    [EPISODE_SCRIPT_GENERATION_JOB_TYPE]: createEpisodeScriptGenerationJobHandler(
      context.database,
      context.dataRoot,
      config,
      generate,
    ),
  }, { workerId: "script-test", leaseMs: 10_000, heartbeatMs: 1_000, retryDelayMs: 0 });
  await worker.runOne();
  return { queued, worker, job: getJob(context.database, queued.job.id)! };
}

function successfulGenerator(observe?: (input: Parameters<GenerateEpisodeScript>[0]) => void): GenerateEpisodeScript {
  return async (input) => {
    observe?.(input);
    if (input.stage === "skeleton") return { beats: [
      { intent: "进入", sourceIndexes: [0, 1], targetDurationSeconds: 80 },
      { intent: "揭示", sourceIndexes: [2], targetDurationSeconds: 40 },
    ] };
    if (input.stage === "faithful") return { text: textForBudget(input.characterBudget,
      input.sources.map((source) => source.sourceText).join("；")) };
    return { paragraphs: input.paragraphs.map((paragraph, index) => ({
      ...paragraph,
      text: index === 0 ? `旁${[...paragraph.text].slice(1).join("")}` : paragraph.text,
    })) };
  };
}

async function directHandlerError(
  context: Awaited<ReturnType<typeof fixture>>,
  generate: GenerateEpisodeScript,
  contract?: Parameters<typeof enqueueEpisodeScriptGenerationJob>[5],
) {
  const queued = await enqueueEpisodeScriptGenerationJob(context.database, context.dataRoot, config, {
    payload: request,
    maxAttempts: 1,
  }, undefined, contract);
  const handler = createEpisodeScriptGenerationJobHandler(context.database, context.dataRoot, config, generate);
  let caught: unknown;
  try {
    await handler({
      job: queued.job,
      reportProgress() {},
      isCancellationRequested: () => false,
      throwIfCancellationRequested() {},
      getCheckpoint: () => undefined,
      commitCheckpoint() { throw new Error("测试未预期写入 checkpoint"); },
    });
  } catch (error) {
    caught = error;
  }
  return caught;
}

test("长稿各阶段合同错误携带具体 beat 与 initial/correction 调用阶段", async (t) => {
  const evidence = { partialText: "model-result", partialTextTruncated: false };
  const prompt = {
    skeletonProductVersion: "episode-skeleton-product-v1" as const,
    beatProductVersion: "finished-narration-beat-product-v1" as const,
    profileRevision: 1,
    profileHash: "a".repeat(64),
    instructions: "保持第一人称。",
  };
  const cases: Array<{
    name: string;
    expectedStage: string;
    contract?: Parameters<typeof enqueueEpisodeScriptGenerationJob>[5];
    generate: GenerateEpisodeScript;
  }> = [
    {
      name: "skeleton correction",
      expectedStage: "episode-script.skeleton.correction-1",
      generate: async () => rememberTextModelEvidence({
        beats: [{ intent: "遗漏来源", sourceIndexes: [0] }],
      }, evidence),
    },
    {
      name: "faithful beat",
      expectedStage: "episode-script.faithful.beat-1.initial",
      generate: async (input) => input.stage === "skeleton"
        ? { beats: [{ intent: "完整", sourceIndexes: [0, 1, 2] }] }
        : rememberTextModelEvidence({ text: "" }, evidence),
    },
    {
      name: "packaged initial",
      expectedStage: "episode-script.packaged.initial",
      generate: async (input) => input.stage === "skeleton"
        ? { beats: [{ intent: "完整", sourceIndexes: [0, 1, 2] }] }
        : input.stage === "faithful"
          ? { text: textForBudget(input.characterBudget, "原著还原稿") }
          : rememberTextModelEvidence({ paragraphs: [] }, evidence),
    },
    {
      name: "finished correction",
      expectedStage: "episode-script.finished.beat-1.correction-1",
      contract: { version: EPISODE_SCRIPT_GENERATION_V6_CONTRACT_VERSION, prompt },
      generate: async (input) => input.stage === "skeleton"
        ? { beats: [{ intent: "完整", sourceIndexes: [0, 1, 2] }] }
        : rememberTextModelEvidence({ paragraphs: [] }, evidence),
    },
  ];

  for (const item of cases) await t.test(item.name, async () => {
    const context = await fixture();
    try {
      const caught = await directHandlerError(context, item.generate, item.contract);
      assert.ok(caught instanceof TextModelCallError);
      assert.equal(caught.stage, item.expectedStage);
      assert.equal(caught.evidence.partialText, "model-result");
    } finally {
      context.connection.close();
      await rm(context.dataRoot, { recursive: true, force: true });
    }
  });
});

test("v6 逐 beat 持久恢复并只创建 standalone 成片旁白", async () => {
  const context = await fixture();
  const prompt = {
    skeletonProductVersion: "episode-skeleton-product-v1" as const,
    beatProductVersion: "finished-narration-beat-product-v1" as const,
    profileRevision: 1,
    profileHash: "a".repeat(64),
    instructions: "保持第一人称。",
  };
  try {
    let failSecond = true;
    const firstCalls: number[][] = [];
    const generator: GenerateEpisodeScript = async (input) => {
      if (input.stage === "skeleton") return { beats: [
        { intent: "进入", sourceIndexes: [0, 1], targetDurationSeconds: 80 },
        { intent: "揭示", sourceIndexes: [2], targetDurationSeconds: 40 },
      ] };
      assert.equal(input.stage, "finished");
      firstCalls.push(input.beat.sourceIndexes);
      if (input.beat.sourceIndexes[0] === 2 && failSecond) throw new Error("模拟第二 beat 中断");
      return { paragraphs: [{
        text: textForBudget(input.characterBudget, input.sources.map((source) => source.sourceText).join("；")),
        sourceIndexes: input.beat.sourceIndexes,
      }] };
    };
    const first = await run(context, generator, 1, {
      version: EPISODE_SCRIPT_GENERATION_V6_CONTRACT_VERSION,
      prompt,
    });
    assert.equal(first.job.status, "failed");
    assert.deepEqual(firstCalls, [[0, 1], [2]]);
    assert.equal(Number(context.database.prepare(
      "SELECT COUNT(*) AS total FROM job_checkpoints WHERE job_id = ? AND stage = 'episode-script-finished-beat'",
    ).get(first.job.id)?.total), 1);

    context.database.prepare(
      `UPDATE jobs SET status='queued', attempts=0, error_code=NULL, error_message=NULL,
       lease_owner=NULL, lease_expires_at=NULL, started_at=NULL, finished_at=NULL WHERE id=?`,
    ).run(first.job.id);
    failSecond = false;
    firstCalls.length = 0;
    const worker = new JobWorker(context.database, {
      [EPISODE_SCRIPT_GENERATION_JOB_TYPE]: createEpisodeScriptGenerationJobHandler(
        context.database, context.dataRoot, config, generator,
      ),
    }, { workerId: "script-v6-resume", leaseMs: 10_000, heartbeatMs: 1_000, retryDelayMs: 0 });
    await worker.runOne();
    const succeeded = getJob(context.database, first.job.id)!;
    assert.equal(succeeded.status, "succeeded");
    assert.deepEqual(firstCalls, [[2]]);
    const versions = listScriptVersions(context.database, "episode");
    assert.equal(versions.length, 1);
    assert.equal(versions[0]!.kind, "packaged");
    assert.equal(versions[0]!.parentVersionId, null);
    assert.equal((succeeded.result as { packagedVersionId: string }).packagedVersionId, versions[0]!.id);
    assert.equal((succeeded.result as { faithfulVersionId?: string }).faithfulVersionId, undefined);
    assert.equal(Number(context.database.prepare(
      "SELECT COUNT(*) AS total FROM job_checkpoints WHERE job_id = ? AND stage = 'episode-script-finished-beat'",
    ).get(first.job.id)?.total), 2);
  } finally {
    context.connection.close();
    await rm(context.dataRoot, { recursive: true, force: true });
  }
});

test("v6 beat 纠正稿仅因句末标点超限时确定性收敛", async () => {
  const context = await fixture();
  const prompt = {
    skeletonProductVersion: "episode-skeleton-product-v1" as const,
    beatProductVersion: "finished-narration-beat-product-v1" as const,
    profileRevision: 1,
    profileHash: "a".repeat(64),
    instructions: "保持第一人称。",
  };
  let finishedCalls = 0;
  try {
    const result = await run(context, async (input) => {
      if (input.stage === "skeleton") return { beats: [{ intent: "完整", sourceIndexes: [0, 1, 2] }] };
      assert.equal(input.stage, "finished");
      finishedCalls += 1;
      return { paragraphs: [{
        text: `${"旁".repeat(input.maximumCharacterCount)}。`,
        sourceIndexes: input.beat.sourceIndexes,
      }] };
    }, 1, { version: EPISODE_SCRIPT_GENERATION_V6_CONTRACT_VERSION, prompt });
    assert.equal(result.job.status, "succeeded");
    assert.equal(finishedCalls, 2);
    const version = listScriptVersions(context.database, "episode")[0]!;
    assert.equal([...version.paragraphs[0]!.text].length, 476);
    assert.equal(version.paragraphs[0]!.text.endsWith("。"), false);
  } finally {
    context.connection.close();
    await rm(context.dataRoot, { recursive: true, force: true });
  }
});

test("流水线稿件按本书配置并发忠实稿 beat，包装稿等待全部忠实稿", async () => {
  const context = await fixture();
  try {
    const pipeline = createSeriesPipelineRun(context.database, {
      seriesProjectId: "series",
      episodeCount: 1,
      targetDurationSeconds: 120,
      sourceStartChapterId: "chapter_0",
      sourceEndChapterId: "chapter_2",
      chapterBatchSize: 1,
      chapterConcurrency: 2,
    });
    context.database.prepare("UPDATE series_pipeline_runs SET status = 'generating_scripts' WHERE id = ?")
      .run(pipeline.id);
    const queued = await enqueueEpisodeScriptGenerationJob(context.database, context.dataRoot, config, {
      payload: request,
      maxAttempts: 1,
    });
    mapSeriesPipelineScriptJob(context.database, pipeline.id, "episode", queued.job.id);

    let inFlight = 0;
    let peak = 0;
    let started = 0;
    let completed = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const generate: GenerateEpisodeScript = async (input) => {
      if (input.stage === "skeleton") return { beats: [
        { intent: "第一段", sourceIndexes: [0] },
        { intent: "第二段", sourceIndexes: [1] },
        { intent: "第三段", sourceIndexes: [2] },
      ] };
      if (input.stage === "packaged") {
        assert.equal(inFlight, 0);
        assert.equal(completed, 3);
        return { paragraphs: input.paragraphs.map((paragraph, index) => ({
          ...paragraph,
          text: index === 0 ? `旁${[...paragraph.text].slice(1).join("")}` : paragraph.text,
        })) };
      }
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      started += 1;
      if (started === 2) release();
      await gate;
      inFlight -= 1;
      completed += 1;
      return { text: textForBudget(input.characterBudget, input.sources[0]!.sourceText) };
    };
    const worker = new JobWorker(context.database, {
      [EPISODE_SCRIPT_GENERATION_JOB_TYPE]: createEpisodeScriptGenerationJobHandler(
        context.database,
        context.dataRoot,
        config,
        generate,
      ),
    }, { workerId: "script-concurrency-test", leaseMs: 10_000, heartbeatMs: 1_000 });
    await worker.runOne();
    assert.equal(getJob(context.database, queued.job.id)!.status, "succeeded");
    assert.equal(peak, 2);
  } finally {
    context.connection.close();
    await rm(context.dataRoot, { recursive: true, force: true });
  }
});

test("长稿 Job 骨架不接收原文，faithful 按 beat 隔离原文并写入冻结父链", async () => {
  const context = await fixture();
  const calls: Parameters<GenerateEpisodeScript>[0][] = [];
  try {
    const result = await run(context, successfulGenerator((input) => calls.push(input)));
    assert.equal(result.job.status, "succeeded");
    const skeleton = calls.find((input) => input.stage === "skeleton")!;
    const serialized = JSON.stringify(skeleton);
    for (const forbidden of ["sourceText", "byteStart", "byteEnd", ...context.texts]) {
      assert.equal(serialized.includes(forbidden), false, `骨架输入不得包含 ${forbidden}`);
    }
    const faithfulCalls = calls.filter((input) => input.stage === "faithful");
    assert.deepEqual(faithfulCalls.map((input) => input.stage === "faithful"
      ? input.sources.map((source) => source.sourceText)
      : []), [[context.texts[0], context.texts[1]], [context.texts[2]]]);

    const versions = listScriptVersions(context.database, "episode");
    assert.equal(versions.length, 2);
    assert.equal(versions[0]!.kind, "faithful");
    assert.equal(versions[1]!.kind, "packaged");
    assert.equal(versions[1]!.parentVersionId, versions[0]!.id);
    assert.deepEqual(versions[1]!.paragraphs.map((paragraph) =>
      paragraph.sources.map((source) => source.episodeSourceIndex)), [[0, 1], [2]]);
    assert.deepEqual(getScriptApproval(context.database, "episode"), {
      episodeId: "episode", status: "unapproved", revision: 0,
      scriptVersionId: null, changedAt: null,
    });
    assert.throws(() => requireApprovedScriptForProduction(context.database, "episode", "tts"), /未人工批准/);
    const payload = result.job.payload as Record<string, unknown>;
    assert.equal(payload.contractVersion, EPISODE_SCRIPT_GENERATION_CONTRACT_VERSION);
    assert.equal(payload.targetDurationSeconds, 120);
    assert.equal(payload.voice, request.voice);
    assert.deepEqual(payload.calibration, request.calibration);
    const jobResult = result.job.result as {
      characterBudget: number; minimumCharacterCount: number; maximumCharacterCount: number;
      scriptHandoff: { summary: string; continuityNotes: string[] };
    };
    assert.equal(jobResult.characterBudget, 432);
    assert.equal(jobResult.minimumCharacterCount, 388);
    assert.equal(jobResult.maximumCharacterCount, 476);
    assert.deepEqual(jobResult.scriptHandoff, {
      summary: "进入墓道",
      continuityNotes: ["发现机关", "进入", "揭示"],
    });
  } finally {
    context.connection.close();
    await rm(context.dataRoot, { recursive: true, force: true });
  }
});

test("原著还原稿与成片旁白稿必须落在动态字符预算区间内且失败不落库", async (t) => {
  for (const [name, generate, error] of [
    ["还原稿过短", async (input: Parameters<GenerateEpisodeScript>[0]) => input.stage === "skeleton"
      ? { beats: [{ intent: "完整", sourceIndexes: [0, 1, 2] }] }
      : input.stage === "faithful" ? { text: "过短" } : { paragraphs: input.paragraphs }, /原著还原稿字数不足/],
    ["旁白稿过短", async (input: Parameters<GenerateEpisodeScript>[0]) => input.stage === "skeleton"
      ? { beats: [{ intent: "完整", sourceIndexes: [0, 1, 2] }] }
      : input.stage === "faithful" ? { text: textForBudget(input.characterBudget) }
        : { paragraphs: [{ text: "过短", sourceIndexes: [0, 1, 2] }] }, /成片旁白稿字数不足/],
    ["旁白稿过长", async (input: Parameters<GenerateEpisodeScript>[0]) => input.stage === "skeleton"
      ? { beats: [{ intent: "完整", sourceIndexes: [0, 1, 2] }] }
      : input.stage === "faithful" ? { text: textForBudget(input.characterBudget) }
        : { paragraphs: [{ text: "长".repeat(input.maximumCharacterCount + 1), sourceIndexes: [0, 1, 2] }] }, /成片旁白稿字数过多/],
    ["旁白稿未改写", async (input: Parameters<GenerateEpisodeScript>[0]) => input.stage === "skeleton"
      ? { beats: [{ intent: "完整", sourceIndexes: [0, 1, 2] }] }
      : input.stage === "faithful" ? { text: textForBudget(input.characterBudget) }
        : { paragraphs: input.paragraphs }, /成片旁白稿与原著还原稿正文完全相同/],
  ] as const) await t.test(name, async () => {
    const context = await fixture();
    try {
      const result = await run(context, generate as GenerateEpisodeScript);
      assert.equal(result.job.status, "failed");
      assert.match(result.job.errorMessage ?? "", error);
      assert.equal(listScriptVersions(context.database, "episode").length, 0);
    } finally {
      context.connection.close();
      await rm(context.dataRoot, { recursive: true, force: true });
    }
  });
});

test("成片旁白稿长度越界时只定向重写一次且不重复生成原著还原稿", async () => {
  const context = await fixture();
  const prompts: string[] = [];
  let calls = 0;
  const outputs = [
    { beats: [{ intent: "完整", sourceIndexes: [0, 1, 2] }] },
    { text: textForBudget(432, "原著还原稿") },
    { paragraphs: [{ text: "长".repeat(477), sourceIndexes: [0, 1, 2] }] },
    { paragraphs: [{ text: textForBudget(432, "成片旁白稿"), sourceIndexes: [0, 1, 2] }] },
  ];
  try {
    const generate = createOpenAiEpisodeScriptGenerator(config, (async (_url, init) => {
      const body = JSON.parse(String(init?.body)) as { input: string };
      prompts.push(body.input);
      return Response.json({ output_text: JSON.stringify(outputs[calls++]!) });
    }) as typeof fetch);
    const result = await run(context, generate);
    assert.equal(result.job.status, "succeeded");
    assert.equal(calls, 4);
    assert.match(prompts[3]!, /上一次完整成片旁白稿被生成合同拒绝/u);
    assert.match(prompts[3]!, /实际 477 字，最多允许 476 字/u);
    assert.match(prompts[3]!, /"previousParagraphs":\[\{"text":"长长/u);
    assert.equal(prompts.filter((prompt) => prompt.includes('"stage":"faithful"')).length, 1);
    assert.equal(listScriptVersions(context.database, "episode").length, 2);
  } finally {
    context.connection.close();
    await rm(context.dataRoot, { recursive: true, force: true });
  }
});

test("成片旁白稿与原著还原稿完全相同时只定向改写一次", async () => {
  const context = await fixture();
  let packagedCalls = 0;
  try {
    const result = await run(context, async (input) => {
      if (input.stage === "skeleton") return { beats: [{ intent: "完整", sourceIndexes: [0, 1, 2] }] };
      if (input.stage === "faithful") return { text: textForBudget(input.characterBudget, "原著还原稿") };
      packagedCalls += 1;
      if (packagedCalls === 1) return { paragraphs: input.paragraphs };
      assert.match(input.correctionError ?? "", /正文完全相同/u);
      assert.deepEqual(input.previousParagraphs, input.paragraphs);
      return { paragraphs: [{ text: textForBudget(input.characterBudget, "成片旁白稿"), sourceIndexes: [0, 1, 2] }] };
    });
    assert.equal(result.job.status, "succeeded");
    assert.equal(packagedCalls, 2);
    const versions = listScriptVersions(context.database, "episode");
    assert.notEqual(versions[0]!.contentHash, versions[1]!.contentHash);
  } finally {
    context.connection.close();
    await rm(context.dataRoot, { recursive: true, force: true });
  }
});

test("成片旁白稿改写后超长时再定向压缩且不重复生成原著还原稿", async () => {
  const context = await fixture();
  let faithfulCalls = 0;
  let packagedCalls = 0;
  try {
    const result = await run(context, async (input) => {
      if (input.stage === "skeleton") return { beats: [{ intent: "完整", sourceIndexes: [0, 1, 2] }] };
      if (input.stage === "faithful") {
        faithfulCalls += 1;
        return { text: textForBudget(input.characterBudget, "原著还原稿") };
      }
      packagedCalls += 1;
      if (packagedCalls === 1) return { paragraphs: input.paragraphs };
      if (packagedCalls === 2) {
        assert.match(input.correctionError ?? "", /正文完全相同/u);
        return { paragraphs: [{ text: "长".repeat(input.maximumCharacterCount + 1), sourceIndexes: [0, 1, 2] }] };
      }
      assert.match(input.correctionError ?? "", /字数过多/u);
      assert.equal(input.previousParagraphs?.[0]?.text.length, input.maximumCharacterCount + 1);
      return { paragraphs: [{ text: textForBudget(input.characterBudget, "成片旁白稿"), sourceIndexes: [0, 1, 2] }] };
    });
    assert.equal(result.job.status, "succeeded");
    assert.equal(faithfulCalls, 1);
    assert.equal(packagedCalls, 3);
    assert.equal(listScriptVersions(context.database, "episode").length, 2);
  } finally {
    context.connection.close();
    await rm(context.dataRoot, { recursive: true, force: true });
  }
});

test("骨架完整 JSON 漏来源后仅纠正一次并原子写入双稿", async () => {
  const context = await fixture();
  const skeletonPrompts: string[] = [];
  let calls = 0;
  const outputs = [
    { beats: [{ intent: "漏项", sourceIndexes: [0, 1] }] },
    { beats: [{ intent: "完整", sourceIndexes: [0, 1, 2] }] },
    { text: textForBudget(432, "原著还原稿") },
    { paragraphs: [{ text: textForBudget(432, "成片旁白稿"), sourceIndexes: [0, 1, 2] }] },
  ];
  try {
    const generate = createOpenAiEpisodeScriptGenerator(config, (async (_url, init) => {
      const body = JSON.parse(String(init?.body)) as { input: string };
      if (calls < 2) skeletonPrompts.push(body.input);
      return Response.json({ output_text: JSON.stringify(outputs[calls++]!) });
    }) as typeof fetch);
    const result = await run(context, generate);
    assert.equal(result.job.status, "succeeded");
    assert.equal(calls, 4);
    assert.equal(skeletonPrompts.length, 2);
    assert.match(skeletonPrompts[1]!, /故事骨架必须明确覆盖全部冻结来源/u);
    assert.match(skeletonPrompts[1]!, /只纠正一次并重新输出完整 JSON/u);
    assert.equal(listScriptVersions(context.database, "episode", "faithful").length, 1);
    assert.equal(listScriptVersions(context.database, "episode", "packaged").length, 1);
    assert.deepEqual((result.job.result as { scriptHandoff: unknown }).scriptHandoff, {
      summary: "进入墓道",
      continuityNotes: ["发现机关", "完整"],
    });
  } finally {
    context.connection.close();
    await rm(context.dataRoot, { recursive: true, force: true });
  }
});

test("骨架纠正后仍漏来源最多调用两次且不写稿", async () => {
  const context = await fixture();
  let calls = 0;
  try {
    const generate = createOpenAiEpisodeScriptGenerator(config, (async () => {
      calls += 1;
      return Response.json({ output_text: JSON.stringify({ beats: [{ intent: "仍漏项", sourceIndexes: [0, 1] }] }) });
    }) as typeof fetch);
    const result = await run(context, generate);
    assert.equal(result.job.status, "failed");
    assert.equal(calls, 2);
    assert.equal(listScriptVersions(context.database, "episode").length, 0);
  } finally {
    context.connection.close();
    await rm(context.dataRoot, { recursive: true, force: true });
  }
});

test("HTTP、非 JSON、abort 与 SSE 无终态失败均不进入骨架纠错", async (t) => {
  const cases: Array<[string, () => Promise<Response>]> = [
    ["HTTP", async () => new Response("失败", { status: 503 })],
    ["非 JSON", async () => new Response("不是 JSON", { headers: { "content-type": "application/json" } })],
    ["abort", async () => { throw new DOMException("aborted", "AbortError"); }],
    ["SSE 无终态", async () => new Response(
      `data: ${JSON.stringify({ type: "response.output_text.delta", delta: "{\\\"beats\\\":[]}" })}\n\n`,
      { headers: { "content-type": "text/event-stream" } },
    )],
  ];
  for (const [name, response] of cases) await t.test(name, async () => {
    const context = await fixture();
    let calls = 0;
    try {
      const generate = createOpenAiEpisodeScriptGenerator(config, (async () => {
        calls += 1;
        return response();
      }) as typeof fetch);
      const result = await run(context, generate);
      assert.equal(result.job.status, "failed");
      assert.equal(calls, 1);
      assert.equal(listScriptVersions(context.database, "episode").length, 0);
    } finally {
      context.connection.close();
      await rm(context.dataRoot, { recursive: true, force: true });
    }
  });
});

test("骨架拒绝空、重复、越界、伪造及乱序来源", async (t) => {
  const cases: Array<[string, unknown]> = [
    ["空", []],
    ["beat 内重复", [{ intent: "坏", sourceIndexes: [0, 0] }]],
    ["跨 beat 重复", [{ intent: "一", sourceIndexes: [0] }, { intent: "二", sourceIndexes: [0] }]],
    ["越界", [{ intent: "坏", sourceIndexes: [3] }]],
    ["伪造", [{ intent: "坏", sourceIndexes: [999] }]],
    ["乱序", [{ intent: "坏", sourceIndexes: [1, 0] }]],
  ];
  for (const [name, beats] of cases) await t.test(name, async () => {
    const context = await fixture();
    try {
      const result = await run(context, async (input) => input.stage === "skeleton"
        ? { beats: beats as never[] }
        : input.stage === "faithful" ? { text: "不会执行" } : { paragraphs: [] });
      assert.equal(result.job.status, "failed");
      assert.equal(listScriptVersions(context.database, "episode").length, 0);
    } finally {
      context.connection.close();
      await rm(context.dataRoot, { recursive: true, force: true });
    }
  });
});

test("任务在开始、faithful 写入前和 packaged 写入前都拒绝 Episode 漂移", async (t) => {
  for (const point of ["start", "faithful", "packaged"] as const) await t.test(point, async () => {
    const context = await fixture();
    try {
      const queued = await enqueueEpisodeScriptGenerationJob(context.database, context.dataRoot, config, {
        payload: request,
        maxAttempts: 1,
      });
      if (point === "start") context.database.prepare("UPDATE episodes SET story_arc = '已漂移' WHERE id = 'episode'").run();
      let changed = false;
      const generate = successfulGenerator((input) => {
        if (!changed && ((point === "faithful" && input.stage === "faithful") ||
            (point === "packaged" && input.stage === "packaged"))) {
          context.database.prepare("UPDATE episodes SET target_duration_seconds = 121 WHERE id = 'episode'").run();
          changed = true;
        }
      });
      const worker = new JobWorker(context.database, {
        [EPISODE_SCRIPT_GENERATION_JOB_TYPE]: createEpisodeScriptGenerationJobHandler(
          context.database, context.dataRoot, config, generate,
        ),
      }, { workerId: `drift-${point}`, leaseMs: 10_000, heartbeatMs: 1_000, retryDelayMs: 0 });
      await worker.runOne();
      const job = getJob(context.database, queued.job.id)!;
      assert.equal(job.status, "failed");
      assert.match(job.errorMessage ?? "", /排队后已变化/);
      assert.equal(listScriptVersions(context.database, "episode").length, 0);
    } finally {
      context.connection.close();
      await rm(context.dataRoot, { recursive: true, force: true });
    }
  });
});

test("首次失败后重试 faithful 文本变化也只落成功的一组版本", async () => {
  const context = await fixture();
  let packagedAttempts = 0;
  let faithfulAttempts = 0;
  try {
    const generate: GenerateEpisodeScript = async (input) => {
      if (input.stage === "skeleton") return { beats: [{ intent: "完整", sourceIndexes: [0, 1, 2] }] };
      if (input.stage === "faithful") {
        faithfulAttempts += 1;
        return { text: textForBudget(input.characterBudget,
          `${faithfulAttempts === 1 ? "失败批次" : "成功批次"}：${input.sources.map((source) => source.sourceText).join("；")}`) };
      }
      packagedAttempts += 1;
      if (packagedAttempts === 1) throw new Error("模拟 packaged 暂时失败");
      return { paragraphs: [{ text: textForBudget(input.characterBudget, "重试后的成片旁白稿"), sourceIndexes: [0, 1, 2] }] };
    };
    const first = await run(context, generate, 2);
    assert.equal(first.job.status, "queued");
    assert.equal(listScriptVersions(context.database, "episode").length, 0);
    await first.worker.runOne();
    const completed = getJob(context.database, first.queued.job.id)!;
    assert.equal(completed.status, "succeeded");
    assert.equal(listScriptVersions(context.database, "episode", "faithful").length, 1);
    assert.equal(listScriptVersions(context.database, "episode", "packaged").length, 1);
    assert.match(listScriptVersions(context.database, "episode", "faithful")[0]!.paragraphs[0]!.text, /成功批次/);
    const resumed = await enqueueEpisodeScriptGenerationJob(context.database, context.dataRoot, config, { payload: request });
    assert.equal(resumed.created, false);
    assert.equal(resumed.job.id, first.queued.job.id);
  } finally {
    context.connection.close();
    await rm(context.dataRoot, { recursive: true, force: true });
  }
});

test("成片旁白稿拒绝对应原著还原稿冻结集合之外的来源", async () => {
  const context = await fixture();
  try {
    const result = await run(context, async (input) => {
      if (input.stage === "skeleton") return { beats: [{ intent: "完整", sourceIndexes: [0, 1, 2] }] };
      if (input.stage === "faithful") return { text: textForBudget(input.characterBudget, "原著还原稿") };
      return { paragraphs: [{ text: "越界包装稿", sourceIndexes: [3] }] };
    });
    assert.equal(result.job.status, "failed");
    assert.match(result.job.errorMessage ?? "", /对应原著还原稿之外/);
    assert.equal(listScriptVersions(context.database, "episode").length, 0);
  } finally {
    context.connection.close();
    await rm(context.dataRoot, { recursive: true, force: true });
  }
});

test("HTTP 入口持久化同一 Job，并由现有 Worker 完成后可查询恢复", async () => {
  const context = await fixture();
  context.connection.close();
  await writeModelConfig(context.dataRoot, {
    providers: {
      [config.providerId]: {
        name: "测试文本供应商",
        kind: "openai-compatible",
        protocol: "openai-response",
        baseUrl: config.baseUrl,
        apiKey: config.apiKey,
        models: { text: { enabled: true, modelId: config.model } },
      },
    },
    active: { text: `${config.providerId}/text` },
  });
  const app = buildApp({
    dataRoot: context.dataRoot,
    logger: false,
    jobPollMs: 5,
    episodeScriptGenerator: successfulGenerator(),
  });
  try {
    const created = await app.inject({
      method: "POST",
      url: "/api/jobs",
      payload: { type: EPISODE_SCRIPT_GENERATION_JOB_TYPE, payload: request },
    });
    assert.equal(created.statusCode, 201);
    assert.equal(created.json().message, "跨章骨架与长稿任务已创建并持久化");
    const jobId = created.json().job.id as string;
    const duplicate = await app.inject({
      method: "POST",
      url: "/api/jobs",
      payload: { type: EPISODE_SCRIPT_GENERATION_JOB_TYPE, payload: request },
    });
    assert.equal(duplicate.statusCode, 200);
    assert.equal(duplicate.json().job.id, jobId);
    const deadline = Date.now() + 2_000;
    let restored;
    do {
      restored = await app.inject({ method: "GET", url: `/api/jobs/${jobId}` });
      if (restored.json().job.status === "succeeded") break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    } while (Date.now() < deadline);
    assert.equal(restored.json().job.status, "succeeded");
    assert.equal(restored.json().job.result.episodeId, "episode");
  } finally {
    await app.close();
    await rm(context.dataRoot, { recursive: true, force: true });
  }
});

test("运行中的长稿模型调用响应持久取消且不写入稿件", async () => {
  const context = await fixture();
  try {
    const queued = await enqueueEpisodeScriptGenerationJob(context.database, context.dataRoot, config, {
      payload: request,
      maxAttempts: 1,
    });
    const generate: GenerateEpisodeScript = (input) => new Promise((_resolve, reject) => {
      input.signal.addEventListener("abort", () => reject(input.signal.reason), { once: true });
    });
    const worker = new JobWorker(context.database, {
      [EPISODE_SCRIPT_GENERATION_JOB_TYPE]: createEpisodeScriptGenerationJobHandler(
        context.database, context.dataRoot, config, generate,
      ),
    }, { workerId: "cancel-script", leaseMs: 10_000, heartbeatMs: 1_000 });
    const running = worker.runOne();
    while (getJob(context.database, queued.job.id)?.status !== "running") {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    requestJobCancellation(context.database, queued.job.id);
    await running;
    assert.equal(getJob(context.database, queued.job.id)?.status, "cancelled");
    assert.equal(listScriptVersions(context.database, "episode").length, 0);
  } finally {
    context.connection.close();
    await rm(context.dataRoot, { recursive: true, force: true });
  }
});

test("packaged 生成期间取消不会提前写入 faithful", async () => {
  const context = await fixture();
  let packagedStarted!: () => void;
  const started = new Promise<void>((resolve) => { packagedStarted = resolve; });
  try {
    const queued = await enqueueEpisodeScriptGenerationJob(context.database, context.dataRoot, config, {
      payload: request, maxAttempts: 1,
    });
    const generate: GenerateEpisodeScript = async (input) => {
      if (input.stage === "skeleton") return { beats: [{ intent: "完整", sourceIndexes: [0, 1, 2] }] };
      if (input.stage === "faithful") return { text: textForBudget(input.characterBudget, "内存原著还原稿") };
      packagedStarted();
      return new Promise((_resolve, reject) => input.signal.addEventListener(
        "abort", () => reject(input.signal.reason), { once: true },
      ));
    };
    const worker = new JobWorker(context.database, {
      [EPISODE_SCRIPT_GENERATION_JOB_TYPE]: createEpisodeScriptGenerationJobHandler(
        context.database, context.dataRoot, config, generate,
      ),
    }, { workerId: "cancel-packaged", leaseMs: 10_000, heartbeatMs: 1_000 });
    const running = worker.runOne();
    await started;
    requestJobCancellation(context.database, queued.job.id);
    await running;
    assert.equal(getJob(context.database, queued.job.id)?.status, "cancelled");
    assert.equal(listScriptVersions(context.database, "episode").length, 0);
  } finally {
    context.connection.close();
    await rm(context.dataRoot, { recursive: true, force: true });
  }
});

test("排队后事件同 ID 的 type 或 payload 漂移会在模型调用前失败", async () => {
  const context = await fixture();
  let called = false;
  try {
    const queued = await enqueueEpisodeScriptGenerationJob(context.database, context.dataRoot, config, {
      payload: request, maxAttempts: 1,
    });
    context.database.prepare("UPDATE chapter_events SET payload_json = ? WHERE id = 'event_0'")
      .run(JSON.stringify({ fact: "已漂移事实" }));
    const worker = new JobWorker(context.database, {
      [EPISODE_SCRIPT_GENERATION_JOB_TYPE]: createEpisodeScriptGenerationJobHandler(
        context.database, context.dataRoot, config, async () => {
          called = true;
          return { beats: [] };
        },
      ),
    }, { workerId: "event-drift", leaseMs: 10_000, heartbeatMs: 1_000 });
    await worker.runOne();
    const job = getJob(context.database, queued.job.id)!;
    assert.equal(job.status, "failed");
    assert.equal(called, false);
    assert.match(job.errorMessage ?? "", /事件摘要|排队后已变化/);
    assert.equal(listScriptVersions(context.database, "episode").length, 0);
  } finally {
    context.connection.close();
    await rm(context.dataRoot, { recursive: true, force: true });
  }
});

test("模型完成后事件摘要漂移会在原子落稿事务内复核并保持零稿件", async () => {
  const context = await fixture();
  let changed = false;
  try {
    const result = await run(context, successfulGenerator((input) => {
      if (!changed && input.stage === "packaged") {
        context.database.prepare("UPDATE chapter_events SET event_type = 'suspense' WHERE id = 'event_0'").run();
        changed = true;
      }
    }));
    assert.equal(result.job.status, "failed");
    assert.match(result.job.errorMessage ?? "", /事件摘要|排队后已变化/);
    assert.equal(listScriptVersions(context.database, "episode").length, 0);
  } finally {
    context.connection.close();
    await rm(context.dataRoot, { recursive: true, force: true });
  }
});

test("原子落稿第二次写入失败会回滚 faithful 与来源快照", async () => {
  const context = await fixture();
  try {
    context.database.exec(`CREATE TEMP TRIGGER fail_packaged BEFORE INSERT ON script_versions
      WHEN NEW.kind = 'packaged' BEGIN SELECT RAISE(ABORT, 'injected packaged failure'); END`);
    const result = await run(context, successfulGenerator());
    assert.equal(result.job.status, "failed");
    assert.match(result.job.errorMessage ?? "", /injected packaged failure/);
    assert.equal(listScriptVersions(context.database, "episode").length, 0);
    assert.equal(context.database.prepare("SELECT COUNT(*) AS count FROM script_version_sources").get()?.count, 0);
  } finally {
    context.connection.close();
    await rm(context.dataRoot, { recursive: true, force: true });
  }
});
