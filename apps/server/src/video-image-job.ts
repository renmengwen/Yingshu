import type { DatabaseSync } from "node:sqlite";

import { publishAssetCandidate } from "./asset-candidate-store.js";
import { generateOpenAiImage, type GenerateImageInput, type OpenAiImageConfig } from "./image-provider.js";
import { JobCancelledError, type JobExecutionContext, type JobHandler } from "./job-worker.js";
import { requestJobCancellation } from "./job-store.js";
import { withDataFileMutationLock } from "./data-file-mutation-lock.js";
import { type VideoImageJobPayload, VIDEO_IMAGE_JOB_TYPE, videoImageParameters, videoImageRequestIdentity } from "./video-image-contract.js";
import { cleanupUnreferencedVideoImageFiles, insertVideoImageCandidate, insertVideoImageFailure, permitStillCurrent, syncVideoImageStatus } from "./video-image-store.js";

interface Dependencies {
  generate: (input: GenerateImageInput) => ReturnType<typeof generateOpenAiImage>;
  publish: typeof publishAssetCandidate;
  timeoutMs: number;
}

function payload(value: unknown): VideoImageJobPayload {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("图片任务冻结参数无效");
  const task = value as VideoImageJobPayload;
  const imageParameters = videoImageParameters(task.parameters?.aspectRatio);
  if (!task.projectId || !task.videoId || !task.visualId || !task.batchId || !task.requestIdentity ||
      !task.providerId || !task.model || !task.prompt || task.parameters?.size !== imageParameters.size ||
      task.aspectRatio !== imageParameters.aspectRatio || task.parameters?.candidates !== 1 || task.attempt !== 1) {
    throw new Error("图片任务冻结参数无效");
  }
  return { ...task, parameters: imageParameters };
}

async function* bytes(value: Uint8Array) { yield value; }

function temporary(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return /(?:HTTP 408|HTTP 429|HTTP 5\d\d|timeout|timed out|ECONNRESET|ETIMEDOUT|EAI_AGAIN)/iu.test(message);
}

function chineseError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  if (/abort|cancel|取消|中断/iu.test(message)) return "图片生成已中断";
  if (/timeout|timed out|ETIMEDOUT/iu.test(message)) return "图片服务响应超时，请单独重试该画面";
  if (/429/u.test(message)) return "图片服务请求过于频繁，请稍后单独重试该画面";
  if (/HTTP 5\d\d/u.test(message)) return "图片服务暂时不可用，请稍后单独重试该画面";
  if (/解码|PNG|JPEG|WebP|图片格式|尺寸/u.test(message)) return "图片服务返回的文件无效，请单独重试该画面";
  return "图片生成失败，请单独重试该画面";
}

export function createVideoImageJobHandler(
  database: DatabaseSync,
  dataRoot: string,
  resolveProvider: (identity: { providerId: string; modelId: string }) => Promise<OpenAiImageConfig | null>,
  dependencies: Partial<Dependencies> = {},
): JobHandler {
  const generate = dependencies.generate ?? generateOpenAiImage;
  const publish = dependencies.publish ?? publishAssetCandidate;
  const timeoutMs = dependencies.timeoutMs ?? 120_000;
  return async (context: JobExecutionContext) => {
    const task = payload(context.job.payload);
    const imageParameters = videoImageParameters(task.parameters.aspectRatio);
    const batch = database.prepare("SELECT idempotency_key FROM video_image_batches WHERE id=? AND project_id=? AND video_id=?")
      .get(task.batchId, task.projectId, task.videoId) as { idempotency_key: string } | undefined;
    if (context.job.type !== VIDEO_IMAGE_JOB_TYPE || context.job.id !== `job_video_image_${task.requestIdentity}`) {
      throw new Error("图片任务 ID 与冻结身份不一致");
    }
    if (!batch || videoImageRequestIdentity(task, task.providerId, task.model, batch.idempotency_key) !== task.requestIdentity) {
      throw new Error("图片任务冻结身份哈希不一致");
    }
    if (!permitStillCurrent(database, task)) {
      database.prepare("UPDATE video_image_batch_items SET status='cancelled',updated_at=? WHERE batch_id=? AND visual_id=?")
        .run(Date.now(), task.batchId, task.visualId);
      requestJobCancellation(database, context.job.id);
      throw new JobCancelledError();
    }
    const existing = database.prepare("SELECT id,status,error_summary FROM video_image_candidates WHERE request_identity=?")
      .get(task.requestIdentity) as { id: string; status: "succeeded" | "failed"; error_summary: string | null } | undefined;
    if (existing?.status === "succeeded") {
      database.prepare("UPDATE video_image_batch_items SET status='succeeded',updated_at=? WHERE batch_id=? AND visual_id=?")
        .run(Date.now(), task.batchId, task.visualId);
      syncVideoImageStatus(database, task.videoId);
      return { candidateId: existing.id, requestIdentity: task.requestIdentity, reused: true };
    }
    if (existing) {
      database.prepare("UPDATE video_image_batch_items SET status='failed',updated_at=? WHERE batch_id=? AND visual_id=?")
        .run(Date.now(), task.batchId, task.visualId);
      syncVideoImageStatus(database, task.videoId);
      throw new Error(existing.error_summary ?? "图片生成失败，请单独重试该画面");
    }
    const config = await resolveProvider({ providerId: task.providerId, modelId: task.model });
    if (!config || config.providerId !== task.providerId || config.model !== task.model) {
      database.prepare("UPDATE video_image_batch_items SET status='failed',updated_at=? WHERE batch_id=? AND visual_id=?")
        .run(Date.now(), task.batchId, task.visualId);
      insertVideoImageFailure(database, task, "图片服务配置已变化或能力不匹配");
      throw new Error("图片服务配置已变化或能力不匹配");
    }
    database.prepare("UPDATE video_image_batch_items SET status='running',updated_at=? WHERE batch_id=? AND visual_id=?")
      .run(Date.now(), task.batchId, task.visualId);
    context.throwIfCancellationRequested();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(new Error("timeout")), timeoutMs);
    const cancellation = setInterval(() => { if (context.isCancellationRequested()) controller.abort(); }, 50);
    try {
      let generated: Awaited<ReturnType<typeof generate>> | undefined;
      for (let attempt = 1; attempt <= 2; attempt += 1) {
        try {
          generated = await generate({ prompt: task.prompt, negativePrompt: task.negativePrompt, config,
            aspectRatio: imageParameters.aspectRatio, size: imageParameters.size, signal: controller.signal });
          break;
        } catch (error) {
          if (controller.signal.aborted || context.isCancellationRequested()) throw new JobCancelledError();
          if (attempt === 2 || !temporary(error)) throw error;
        }
      }
      if (!generated) throw new Error("图片服务没有返回结果");
      const staleAfterRequest = !permitStillCurrent(database, task);
      const candidateId = await withDataFileMutationLock(dataRoot, async () => {
        if (!permitStillCurrent(database, task)) {
          requestJobCancellation(database, context.job.id);
          throw new JobCancelledError();
        }
        const published = await publish(dataRoot, {
          assetId: `${task.videoId}_${task.visualId}`,
          source: {
            kind: "generation", episodeId: task.videoId, scriptVersionId: task.scriptRevisionId,
            approvalRevision: 1, provider: task.providerId, model: task.model, promptHash: task.promptHash,
            requestHash: task.requestIdentity, size: imageParameters.size, outputIndex: 0,
            ...(generated.revisedPrompt ? { revisedPrompt: generated.revisedPrompt } : {}),
          },
          raw: bytes(generated.bytes), signal: controller.signal,
        });
        try {
          let committedId = "";
          context.commitCheckpoint("video-image-candidate", task.visualId, task.requestIdentity, (transaction) => {
            committedId = insertVideoImageCandidate(transaction, task, published, "generated", {
              providerRequestId: generated.providerRequestId,
            });
            transaction.run("UPDATE video_image_batch_items SET status='succeeded',updated_at=? WHERE batch_id=? AND visual_id=?",
              Date.now(), task.batchId, task.visualId);
            return undefined;
          }, { requestIdentity: task.requestIdentity });
          return committedId;
        } catch (error) {
          await cleanupUnreferencedVideoImageFiles(database, dataRoot, [published]);
          throw error;
        }
      });
      context.reportProgress(1);
      syncVideoImageStatus(database, task.videoId);
      return { candidateId, requestIdentity: task.requestIdentity, currentCompatible: !staleAfterRequest };
    } catch (error) {
      const cancelled = controller.signal.aborted || context.isCancellationRequested() || error instanceof JobCancelledError;
      database.prepare("UPDATE video_image_batch_items SET status=?,updated_at=? WHERE batch_id=? AND visual_id=?")
        .run(cancelled ? "cancelled" : "failed", Date.now(), task.batchId, task.visualId);
      syncVideoImageStatus(database, task.videoId);
      if (cancelled) throw new JobCancelledError();
      const summary = chineseError(error);
      insertVideoImageFailure(database, task, summary);
      throw new Error(summary, { cause: error });
    } finally {
      clearTimeout(timeout);
      clearInterval(cancellation);
    }
  };
}
