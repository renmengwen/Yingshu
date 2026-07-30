import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

import { withDataFileMutationLock } from "./data-file-mutation-lock.js";

import {
  findGeneratedAssetCandidate,
  publishAssetCandidate,
  registerPublishedAssetCandidate,
  type AssetCandidateRecord,
  type PublishedAssetCandidate,
} from "./asset-candidate-store.js";
import {
  generateOpenAiImage,
  IMAGE_GENERATION_SIZE,
  type GenerateImageInput,
  type OpenAiImageConfig,
} from "./image-provider.js";
import { createJob, getJob, type CreateJobInput, type JobRecord } from "./job-store.js";
import { JobCancelledError, type JobExecutionContext, type JobHandler } from "./job-worker.js";
import { requireApprovedScriptForProduction } from "./script-approval-store.js";

export const IMAGE_CANDIDATE_JOB_TYPE = "image_candidate_generate";
const HASH = /^[0-9a-f]{64}$/u;

interface ImageCandidateDependencies {
  generate: (input: GenerateImageInput) => ReturnType<typeof generateOpenAiImage>;
  publish: typeof publishAssetCandidate;
}

interface ImageCandidateRequest {
  episodeId: string;
  assetId: string;
  prompt: string;
  derivedFromCandidateId?: string;
}

interface ImageCandidateJobPayload extends ImageCandidateRequest {
  requestHash: string;
  scriptVersionId: string;
  approvalRevision: number;
  contentHash: string;
  providerId: string;
  model: string;
}

function text(value: unknown, message: string, max = 255) {
  if (typeof value !== "string") throw new Error(message);
  const normalized = value.normalize("NFKC").trim();
  if (!normalized || normalized.length > max) throw new Error(message);
  return normalized;
}

function requestPayload(value: unknown): ImageCandidateRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("图片生成任务参数无效");
  const input = value as { episodeId?: unknown; assetId?: unknown; prompt?: unknown; derivedFromCandidateId?: unknown };
  const episodeId = text(input.episodeId, "图片生成任务缺少有效的分集或资产 ID");
  const assetId = text(input.assetId, "图片生成任务缺少有效的分集或资产 ID");
  if (!/^[A-Za-z0-9_-]+$/.test(episodeId) || !/^[A-Za-z0-9_-]+$/.test(assetId)) {
    throw new Error("图片生成任务缺少有效的分集或资产 ID");
  }
  const request: ImageCandidateRequest = { episodeId, assetId, prompt: text(input.prompt, "图片生成提示词无效", 20_000) };
  if (input.derivedFromCandidateId !== undefined) {
    request.derivedFromCandidateId = text(input.derivedFromCandidateId, "父候选 ID 无效");
  }
  return request;
}

function frozenPayload(value: unknown): ImageCandidateJobPayload {
  const request = requestPayload(value);
  const input = value as Record<string, unknown>;
  const requestHash = text(input.requestHash, "图片生成任务冻结身份无效", 64).toLowerCase();
  const contentHash = text(input.contentHash, "图片生成任务冻结身份无效", 64).toLowerCase();
  const approvalRevision = input.approvalRevision;
  if (!HASH.test(requestHash) || !HASH.test(contentHash) ||
      !Number.isSafeInteger(approvalRevision) || (approvalRevision as number) < 1) {
    throw new Error("图片生成任务冻结身份无效");
  }
  return {
    ...request,
    requestHash,
    scriptVersionId: text(input.scriptVersionId, "图片生成任务冻结身份无效"),
    approvalRevision: approvalRevision as number,
    contentHash,
    providerId: text(input.providerId, "图片生成任务冻结身份无效", 100),
    model: text(input.model, "图片生成任务冻结身份无效", 150),
  };
}

function requireSameSeries(database: DatabaseSync, episodeId: string, assetId: string) {
  const row = database.prepare(
    `SELECT episode.series_project_id AS episode_series_id, asset.series_project_id AS asset_series_id
     FROM episodes episode CROSS JOIN assets asset
     WHERE episode.id = ? AND asset.id = ?`,
  ).get(episodeId, assetId) as { episode_series_id: string; asset_series_id: string } | undefined;
  if (!row) throw new Error("分集或资产不存在");
  if (row.episode_series_id !== row.asset_series_id) throw new Error("图片资产与分集不属于同一系列");
}

function requireParentCandidate(database: DatabaseSync, assetId: string, candidateId: string | undefined) {
  if (!candidateId) return;
  const parent = database.prepare("SELECT asset_id FROM asset_candidates WHERE id = ?").get(candidateId) as
    { asset_id: string } | undefined;
  if (!parent) throw new Error("父候选不存在");
  if (parent.asset_id !== assetId) throw new Error("父候选与目标资产不一致");
}

function sha256(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

async function* oneChunk(bytes: Uint8Array) {
  yield bytes;
}

export function imageGenerationRequestHash(input: {
  episodeId: string;
  assetId: string;
  scriptVersionId: string;
  approvalRevision: number;
  contentHash: string;
  providerId: string;
  model: string;
  prompt: string;
  derivedFromCandidateId?: string;
}) {
  return sha256(JSON.stringify({
    contract: input.derivedFromCandidateId ? "image-generation-request-v2" : "image-generation-request-v1",
    episodeId: input.episodeId,
    assetId: input.assetId,
    scriptVersionId: input.scriptVersionId,
    approvalRevision: input.approvalRevision,
    contentHash: input.contentHash,
    providerId: input.providerId,
    model: input.model,
    prompt: input.prompt,
    size: IMAGE_GENERATION_SIZE,
    ...(input.derivedFromCandidateId ? { derivedFromCandidateId: input.derivedFromCandidateId } : {}),
  }));
}

function assertFrozenIdentity(
  database: DatabaseSync,
  config: OpenAiImageConfig,
  jobId: string,
  task: ImageCandidateJobPayload,
) {
  if (jobId !== `job_image_${task.requestHash}`) throw new Error("图片生成任务 ID 与冻结请求不一致");
  if (config.providerId.trim() !== task.providerId || config.model.trim() !== task.model) {
    throw new Error("图片生成任务的模型配置已变化");
  }
  const calculated = imageGenerationRequestHash(task);
  if (calculated !== task.requestHash) throw new Error("图片生成任务冻结请求哈希不一致");
  const current = requireApprovedScriptForProduction(database, task.episodeId, "image");
  if (current.scriptVersionId !== task.scriptVersionId || current.approvalRevision !== task.approvalRevision ||
      current.contentHash !== task.contentHash) {
    throw new Error("图片生成任务排队后批准稿已变化");
  }
  requireSameSeries(database, task.episodeId, task.assetId);
  requireParentCandidate(database, task.assetId, task.derivedFromCandidateId);
}

export function enqueueImageCandidateJob(
  database: DatabaseSync,
  config: OpenAiImageConfig,
  input: Omit<CreateJobInput, "id" | "type">,
): { job: JobRecord; created: boolean } {
  const request = requestPayload(input.payload);
  const permit = requireApprovedScriptForProduction(database, request.episodeId, "image");
  requireSameSeries(database, request.episodeId, request.assetId);
  requireParentCandidate(database, request.assetId, request.derivedFromCandidateId);
  const identity = {
    ...request,
    scriptVersionId: permit.scriptVersionId,
    approvalRevision: permit.approvalRevision,
    contentHash: permit.contentHash,
    providerId: text(config.providerId, "图片模型标识配置无效", 100),
    model: text(config.model, "图片模型标识配置无效", 150),
  };
  const requestHash = imageGenerationRequestHash(identity);
  const expectedPayload: ImageCandidateJobPayload = { ...identity, requestHash };
  const id = `job_image_${requestHash}`;
  const currentJob = (job: JobRecord) => {
    const candidate = findGeneratedAssetCandidate(database, request.assetId, requestHash);
    return candidate ? { ...job, result: { episodeId: request.episodeId, requestHash, candidate } } : job;
  };
  const existing = getJob(database, id);
  if (existing) {
    if (existing.type !== IMAGE_CANDIDATE_JOB_TYPE || JSON.stringify(existing.payload) !== JSON.stringify(expectedPayload)) {
      throw new Error("图片生成幂等任务身份冲突");
    }
    return { job: currentJob(existing), created: false };
  }
  try {
    return {
      job: createJob(database, { ...input, id, type: IMAGE_CANDIDATE_JOB_TYPE, payload: expectedPayload }),
      created: true,
    };
  } catch (error) {
    const raced = getJob(database, id);
    if (!raced || raced.type !== IMAGE_CANDIDATE_JOB_TYPE ||
        JSON.stringify(raced.payload) !== JSON.stringify(expectedPayload)) throw error;
    return { job: currentJob(raced), created: false };
  }
}

export function createImageCandidateJobHandler(
  database: DatabaseSync,
  dataRoot: string,
  config: OpenAiImageConfig,
  dependencies: Partial<ImageCandidateDependencies> = {},
): JobHandler {
  const generate = dependencies.generate ?? generateOpenAiImage;
  const publish = dependencies.publish ?? publishAssetCandidate;
  if (!config.providerId.trim() || !config.model.trim()) throw new Error("图片模型标识配置无效");
  return async (context: JobExecutionContext) => {
    const task = frozenPayload(context.job.payload);
    assertFrozenIdentity(database, config, context.job.id, task);
    const promptHash = sha256(task.prompt);
    const existing = findGeneratedAssetCandidate(database, task.assetId, task.requestHash);
    if (existing) {
      context.reportProgress(1);
      return { episodeId: task.episodeId, requestHash: task.requestHash, candidate: existing };
    }
    context.throwIfCancellationRequested();
    const controller = new AbortController();
    const poll = setInterval(() => { if (context.isCancellationRequested()) controller.abort(); }, 50);
    let candidate: AssetCandidateRecord;
    try {
      const generated = await generate({ prompt: task.prompt, config, signal: controller.signal });
      if (controller.signal.aborted) throw new JobCancelledError();
      candidate = await withDataFileMutationLock(dataRoot, async () => {
        assertFrozenIdentity(database, config, context.job.id, task);
        const published: PublishedAssetCandidate = await publish(dataRoot, {
          assetId: task.assetId,
          source: {
            kind: "generation",
            episodeId: task.episodeId,
            scriptVersionId: task.scriptVersionId,
            approvalRevision: task.approvalRevision,
            provider: task.providerId,
            model: task.model,
            promptHash,
            requestHash: task.requestHash,
            size: IMAGE_GENERATION_SIZE,
            outputIndex: 0,
            ...(generated.revisedPrompt ? { revisedPrompt: generated.revisedPrompt } : {}),
            ...(task.derivedFromCandidateId ? { derivedFromCandidateId: task.derivedFromCandidateId } : {}),
          },
          raw: oneChunk(generated.bytes),
          signal: controller.signal,
        });
        context.throwIfCancellationRequested();
        let committed: AssetCandidateRecord = { ...published, reviewRevision: 0, reviewStatus: "pending" };
        context.commitCheckpoint("image-candidate", task.assetId, task.requestHash, (transaction) => {
          assertFrozenIdentity(database, config, context.job.id, task);
          committed = registerPublishedAssetCandidate(transaction, published);
          return undefined;
        });
        return findGeneratedAssetCandidate(database, task.assetId, task.requestHash) ?? committed;
      });
    } catch (error) {
      if (controller.signal.aborted || context.isCancellationRequested()) throw new JobCancelledError();
      throw error;
    } finally {
      clearInterval(poll);
    }

    context.reportProgress(1);
    return { episodeId: task.episodeId, requestHash: task.requestHash, candidate };
  };
}
