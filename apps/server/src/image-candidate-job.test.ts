import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  appendAssetCandidateReview,
  type PublishedAssetCandidate,
  type RegisterAssetCandidateInput,
} from "./asset-candidate-store.js";
import { commitCheckpoint } from "./checkpoint-store.js";
import { openDatabase } from "./database.js";
import {
  createImageCandidateJobHandler,
  enqueueImageCandidateJob,
  IMAGE_CANDIDATE_JOB_TYPE,
  imageGenerationRequestHash,
} from "./image-candidate-job.js";
import { claimNextJob, getJob, requestJobCancellation } from "./job-store.js";
import { JobCancelledError, JobWorker, type JobExecutionContext } from "./job-worker.js";
import { changeScriptApproval } from "./script-approval-store.js";

const config = { baseUrl: "https://unused.example/v1", apiKey: "unused", model: "test-image", providerId: "test-provider" };

function hash(value: string) { return createHash("sha256").update(value).digest("hex"); }

function seed(database: ReturnType<typeof openDatabase>["database"]) {
  database.prepare(
    `INSERT INTO books (id, title, original_file_path, original_file_hash, encoding, import_status)
     VALUES ('book_image', '图片测试', 'book.txt', ?, 'utf-8', 'ready')`,
  ).run("1".repeat(64));
  for (const suffix of ["a", "b"]) {
    database.prepare(
      `INSERT INTO series_projects (id, book_id, title, created_at, updated_at) VALUES (?, 'book_image', ?, 1, 1)`,
    ).run(`series_${suffix}`, `系列${suffix}`);
    database.prepare(
      `INSERT INTO episodes (
         id, series_project_id, episode_index, title, story_arc, target_duration_seconds, created_at, updated_at
       ) VALUES (?, ?, 1, '第一集', '测试故事弧', 240, 1, 1)`,
    ).run(`episode_${suffix}`, `series_${suffix}`);
    database.prepare(
      `INSERT INTO assets (
         id, series_project_id, asset_type, asset_role, canonical_name, normalized_name, created_at
       ) VALUES (?, ?, 'character', 'master', ?, ?, 1)`,
    ).run(`asset_${suffix}`, `series_${suffix}`, `人物${suffix}`, `人物${suffix}`);
  }
  database.prepare(
    `INSERT INTO script_versions (
       id, episode_id, kind, version, content_json, content_hash, created_at
     ) VALUES ('script_image', 'episode_a', 'packaged', 1, ?, ?, 1)`,
  ).run(JSON.stringify({ paragraphs: [{ text: "批准包装稿" }] }), "2".repeat(64));
  database.prepare(
    `INSERT INTO assets (
       id, series_project_id, asset_type, asset_role, canonical_name, normalized_name, created_at
     ) VALUES ('asset_a_peer', 'series_a', 'character', 'master', '同系列另一人物', '同系列另一人物', 1)`,
  ).run();
}

function fakePublished(input: RegisterAssetCandidateInput): PublishedAssetCandidate {
  const sourceJson = JSON.stringify(input.source);
  const sourceIdentityHash = hash(sourceJson);
  const fileHash = hash("fake-png");
  return {
    id: hash(`${input.assetId}\0${sourceIdentityHash}\0${fileHash}`),
    assetId: input.assetId,
    source: input.source,
    sourceIdentityHash,
    sourceJson,
    fileHash,
    mime: "image/png",
    width: 1600,
    height: 2848,
    bytes: 128,
    relativePath: `assets/candidates/${fileHash.slice(0, 2)}/${fileHash}.png`,
    createdAt: 1,
  };
}

test("图片候选 Job 覆盖批准、同系列、成功、取消、撤回竞态和幂等", async () => {
  const dataRoot = await mkdtemp(join(tmpdir(), "narralume-image-job-"));
  const connection = openDatabase(dataRoot);
  const generate = async () => ({ bytes: new Uint8Array([1, 2, 3]), revisedPrompt: "安全修订词" });
  const publish = async (_root: string, input: RegisterAssetCandidateInput) => fakePublished(input);
  const handler = createImageCandidateJobHandler(connection.database, dataRoot, config, { generate, publish });
  const run = async (payload: unknown, selectedHandler = handler) => {
    const { job, created } = enqueueImageCandidateJob(connection.database, config, { payload, maxAttempts: 1 });
    const worker = new JobWorker(connection.database, { [IMAGE_CANDIDATE_JOB_TYPE]: selectedHandler }, {
      workerId: `image-worker-${job.id}`, leaseMs: 5_000, heartbeatMs: 100,
    });
    if (created) assert.equal(await worker.runOne(), true);
    return getJob(connection.database, job.id)!;
  };
  try {
    seed(connection.database);
    const task = { episodeId: "episode_a", assetId: "asset_a", prompt: "竖屏人物肖像" };
    assert.throws(() => enqueueImageCandidateJob(connection.database, config, { payload: task }), /批准/);

    changeScriptApproval(connection.database, "episode_a", {
      action: "approve", expectedRevision: 0, scriptVersionId: "script_image",
    });
    assert.throws(
      () => enqueueImageCandidateJob(connection.database, config, { payload: { ...task, assetId: "asset_b" } }),
      /不属于同一系列/,
    );

    const first = await run(task);
    assert.equal(first.status, "succeeded");
    assert.deepEqual(first.payload, {
      ...task,
      scriptVersionId: "script_image",
      approvalRevision: 1,
      contentHash: "2".repeat(64),
      providerId: "test-provider",
      model: "test-image",
      requestHash: first.id.replace(/^job_image_/, ""),
    });
    assert.equal(connection.database.prepare("SELECT COUNT(*) AS count FROM asset_candidates").get()!.count, 1);
    assert.equal(connection.database.prepare(
      "SELECT COUNT(*) AS count FROM job_checkpoints WHERE job_id = ?",
    ).get(first.id)!.count, 1);
    const source = JSON.parse((connection.database.prepare("SELECT source_json FROM asset_candidates").get() as { source_json: string }).source_json);
    assert.equal(source.episodeId, "episode_a");
    assert.equal(source.approvalRevision, 1);
    assert.equal(source.provider, "test-provider");
    assert.equal(source.model, "test-image");
    assert.equal(source.size, "1600x2848");
    assert.equal(source.outputIndex, 0);
    assert.equal(source.revisedPrompt, "安全修订词");
    assert.equal(source.baseUrl, undefined);

    const derivedTask = { ...task, prompt: "从首版派生", derivedFromCandidateId: (first.result as { candidate: { id: string } }).candidate.id };
    const derived = await run(derivedTask);
    assert.equal((derived.payload as { derivedFromCandidateId: string }).derivedFromCandidateId, derivedTask.derivedFromCandidateId);
    assert.equal((derived.result as { candidate: { source: { derivedFromCandidateId: string } } }).candidate.source.derivedFromCandidateId, derivedTask.derivedFromCandidateId);
    assert.notEqual(derived.id, first.id);
    const repeatedDerived = enqueueImageCandidateJob(connection.database, config, { payload: derivedTask });
    assert.equal(repeatedDerived.created, false);
    assert.equal(repeatedDerived.job.id, derived.id);
    assert.throws(() => enqueueImageCandidateJob(connection.database, config, {
      payload: { ...derivedTask, assetId: "asset_a_peer" },
    }), /父候选与目标资产不一致/);

    const repeated = await run(task);
    assert.equal(repeated.status, "succeeded");
    assert.equal(connection.database.prepare("SELECT COUNT(*) AS count FROM asset_candidates").get()!.count, 2);

    let uniqueCalls = 0;
    const uniqueHandler = createImageCandidateJobHandler(connection.database, dataRoot, config, {
      publish,
      generate: async () => {
        uniqueCalls += 1;
        return { bytes: new Uint8Array([4, 5, 6]) };
      },
    });
    const uniqueTask = { ...task, prompt: "并发只生成一次" };
    const enqueued = await Promise.all([
      Promise.resolve().then(() => enqueueImageCandidateJob(connection.database, config, { payload: uniqueTask, maxAttempts: 1 })),
      Promise.resolve().then(() => enqueueImageCandidateJob(connection.database, config, { payload: uniqueTask, maxAttempts: 1 })),
    ]);
    assert.equal(enqueued[0]!.job.id, enqueued[1]!.job.id);
    assert.deepEqual(enqueued.map((item) => item.created).sort(), [false, true]);
    const uniqueWorker = new JobWorker(connection.database, { [IMAGE_CANDIDATE_JOB_TYPE]: uniqueHandler }, {
      workerId: "image-unique", leaseMs: 5_000, heartbeatMs: 100,
    });
    assert.equal(await uniqueWorker.runOne(), true);
    assert.equal(uniqueCalls, 1);
    const uniqueJob = getJob(connection.database, enqueued[0]!.job.id)!;
    const uniqueCandidate = (uniqueJob.result as { candidate: { id: string } }).candidate;
    appendAssetCandidateReview(connection.database, uniqueCandidate.id, {
      expectedRevision: 0, action: "approve",
    });
    const reused = enqueueImageCandidateJob(connection.database, config, { payload: uniqueTask, maxAttempts: 1 });
    const reusedCandidate = (reused.job.result as {
      candidate: { reviewRevision: number; reviewStatus: string };
    }).candidate;
    assert.equal(reused.created, false);
    assert.equal(reusedCandidate.reviewRevision, 1);
    assert.equal(reusedCandidate.reviewStatus, "approved");
    assert.equal(uniqueCalls, 1);

    const cancellationTask = { ...task, prompt: "取消中的生成" };
    const cancellationJob = enqueueImageCandidateJob(connection.database, config, {
      payload: cancellationTask, maxAttempts: 1,
    }).job;
    let started!: () => void;
    const generating = new Promise<void>((resolve) => { started = resolve; });
    const cancelling = createImageCandidateJobHandler(connection.database, dataRoot, config, {
      publish,
      generate: async ({ signal }) => {
        started();
        await new Promise<void>((_, reject) => signal?.addEventListener("abort", () => reject(new JobCancelledError()), { once: true }));
        throw new Error("unreachable");
      },
    });
    const cancellationWorker = new JobWorker(connection.database, { [IMAGE_CANDIDATE_JOB_TYPE]: cancelling }, {
      workerId: "image-cancel", leaseMs: 5_000, heartbeatMs: 100,
    });
    const running = cancellationWorker.runOne();
    await generating;
    requestJobCancellation(connection.database, cancellationJob.id);
    await running;
    assert.equal(getJob(connection.database, cancellationJob.id)?.status, "cancelled");
    assert.equal(connection.database.prepare(
      "SELECT COUNT(*) AS count FROM job_checkpoints WHERE job_id = ?",
    ).get(cancellationJob.id)!.count, 0);
    const imports = join(dataRoot, ".imports", "images");
    await assert.doesNotReject(async () => {
      try { assert.deepEqual(await readdir(imports), []); } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    });

    const raceTask = { ...task, prompt: "批准撤回竞态" };
    const raceJob = enqueueImageCandidateJob(connection.database, config, { payload: raceTask, maxAttempts: 1 }).job;
    const claimed = claimNextJob(connection.database, "image-race", 5_000, Date.now(), [IMAGE_CANDIDATE_JOB_TYPE])!;
    assert.equal(claimed.id, raceJob.id);
    const countBeforeRace = connection.database.prepare("SELECT COUNT(*) AS count FROM asset_candidates").get()!.count;
    await assert.rejects(handler({
      job: claimed,
      reportProgress() {},
      isCancellationRequested: () => false,
      throwIfCancellationRequested() {},
      getCheckpoint: () => undefined,
      commitCheckpoint(stage, scopeKey, inputHash, writer) {
        changeScriptApproval(connection.database, "episode_a", { action: "withdraw", expectedRevision: 1 });
        return commitCheckpoint(connection.database, {
          jobId: raceJob.id, stage, scopeKey, inputHash, workerId: "image-race",
        }, writer);
      },
    } as JobExecutionContext), /批准|不登记/);
    assert.equal(connection.database.prepare("SELECT COUNT(*) AS count FROM asset_candidates").get()!.count, countBeforeRace);
    assert.equal(connection.database.prepare(
      "SELECT COUNT(*) AS count FROM job_checkpoints WHERE job_id = ?",
    ).get(raceJob.id)!.count, 0);

    assert.match(imageGenerationRequestHash({
      episodeId: "episode_a", assetId: "asset_a", scriptVersionId: "script_image", approvalRevision: 1,
      contentHash: "2".repeat(64), providerId: "test-provider", model: "test-image", prompt: "竖屏人物肖像",
    }), /^[0-9a-f]{64}$/);
    assert.notEqual(
      imageGenerationRequestHash({
        episodeId: "episode_a", assetId: "asset_a", scriptVersionId: "script_image", approvalRevision: 1,
        contentHash: "2".repeat(64), providerId: "test-provider", model: "test-image", prompt: "相同提示词",
        derivedFromCandidateId: "candidate_parent_a",
      }),
      imageGenerationRequestHash({
        episodeId: "episode_a", assetId: "asset_a", scriptVersionId: "script_image", approvalRevision: 1,
        contentHash: "2".repeat(64), providerId: "test-provider", model: "test-image", prompt: "相同提示词",
        derivedFromCandidateId: "candidate_parent_b",
      }),
    );
  } finally {
    connection.close();
    await rm(dataRoot, { recursive: true, force: true });
  }
});

test("排队后的批准身份或模型配置变化会在生成前失败", async () => {
  const runCase = async (kind: "approval" | "config") => {
    const dataRoot = await mkdtemp(join(tmpdir(), `narralume-image-frozen-${kind}-`));
    const connection = openDatabase(dataRoot);
    let generateCalls = 0;
    try {
      seed(connection.database);
      changeScriptApproval(connection.database, "episode_a", {
        action: "approve", expectedRevision: 0, scriptVersionId: "script_image",
      });
      const task = { episodeId: "episode_a", assetId: "asset_a", prompt: `冻结身份-${kind}` };
      const job = enqueueImageCandidateJob(connection.database, config, { payload: task, maxAttempts: 1 }).job;
      if (kind === "approval") {
        connection.database.prepare(
          `INSERT INTO script_versions (
             id, episode_id, kind, version, parent_version_id, content_json, content_hash, created_at
           ) VALUES ('script_image_2', 'episode_a', 'packaged', 2, 'script_image', ?, ?, 2)`,
        ).run(JSON.stringify({ paragraphs: [{ text: "新的批准包装稿" }] }), "3".repeat(64));
        changeScriptApproval(connection.database, "episode_a", {
          action: "approve", expectedRevision: 1, scriptVersionId: "script_image_2",
        });
      }
      const handler = createImageCandidateJobHandler(
        connection.database,
        dataRoot,
        kind === "config" ? { ...config, model: "changed-model" } : config,
        {
          publish: async (_root, input) => fakePublished(input),
          generate: async () => {
            generateCalls += 1;
            return { bytes: new Uint8Array([1]) };
          },
        },
      );
      const worker = new JobWorker(connection.database, { [IMAGE_CANDIDATE_JOB_TYPE]: handler }, {
        workerId: `frozen-${kind}`, leaseMs: 5_000, heartbeatMs: 100,
      });
      assert.equal(await worker.runOne(), true);
      const finished = getJob(connection.database, job.id)!;
      assert.equal(finished.status, "failed");
      assert.match(finished.errorMessage ?? "", kind === "approval" ? /批准稿已变化/ : /模型配置已变化/);
      assert.equal(generateCalls, 0);
    } finally {
      connection.close();
      await rm(dataRoot, { recursive: true, force: true });
    }
  };
  await runCase("approval");
  await runCase("config");
});
