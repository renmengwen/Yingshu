import type { Readable } from "node:stream";
import type { DatabaseSync } from "node:sqlite";
import type { FastifyInstance, FastifyReply } from "fastify";

import { AssetCandidateStoreError } from "./asset-candidate-store.js";
import { ProjectVideoStoreError } from "./project-video-store.js";
import { VideoPlanError } from "./video-plan-contract.js";
import { getVideoPlan } from "./video-plan-store.js";
import { VideoImageError, videoImageText, type ResolveVideoImageProvider } from "./video-image-contract.js";
import {
  approveVideoImageCandidate, cancelVideoImageBatch, enqueueVideoImageBatch, getVideoImageBatch,
  getVideoImageWorkspace, openVideoImagePreview, uploadVideoImageCandidate,
} from "./video-image-store.js";

type Params = { projectId: string; videoId: string };

function sendError(error: unknown, reply: FastifyReply) {
  if (error instanceof VideoImageError || error instanceof ProjectVideoStoreError ||
      error instanceof VideoPlanError || error instanceof AssetCandidateStoreError) {
    return reply.code(error.statusCode).send({ ok: false, message: error.message });
  }
  throw error;
}

function fileName(value: string | string[] | undefined) {
  const raw = Array.isArray(value) ? value[0] : value;
  if (!raw) return "上传图片";
  try { return videoImageText(decodeURIComponent(raw), "原始文件名", 255); }
  catch { throw new VideoImageError(400, "原始文件名无效"); }
}

function publicBatch(batch: ReturnType<typeof getVideoImageBatch>) {
  if (!batch) return null;
  const { counts } = batch;
  const status = counts.running ? "running" : counts.queued ? "queued"
    : counts.failed && counts.succeeded ? "partial" : counts.failed ? "failed"
      : counts.cancelled ? "cancelled" : "succeeded";
  return { id: batch.id, status, counts: { ...counts, total: batch.items.length }, items: batch.items };
}

async function publicWorkspace(options: {
  database: DatabaseSync;
  resolveImageProvider: ResolveVideoImageProvider;
}, projectId: string, videoId: string) {
  const raw = getVideoImageWorkspace(options.database, projectId, videoId);
  const plan = getVideoPlan(options.database, projectId, videoId);
  const provider = await options.resolveImageProvider();
  const approvals = new Map(raw.approvals.map((item) => [item.visualId, item.candidateId]));
  const successful = raw.candidates.filter((item) => item.status === "succeeded" && item.fileHash);
  const covered = new Set(successful.filter((item) => item.currentCompatible).map((item) => item.visualId));
  const generationIdentities = new Map((options.database.prepare(
    `SELECT item.job_id AS jobId, batch.id AS batchId, batch.idempotency_key AS idempotencyKey
     FROM video_image_batch_items item JOIN video_image_batches batch ON batch.id = item.batch_id
     WHERE batch.video_id = ?`,
  ).all(videoId) as Array<{ jobId: string; batchId: string; idempotencyKey: string }>).map((item) => [item.jobId, item]));
  const latestBatchItems = new Map((raw.batch?.items ?? []).map((item) => [item.visualId as string, item]));
  const visuals = (plan?.visual.visuals ?? []).map((visual, order) => ({
    id: visual.id,
    order,
    paragraphId: visual.paragraphId,
    narrationSummary: plan?.script.paragraphs.find((item) => item.id === visual.paragraphId)?.text ?? "",
    description: visual.description,
    prompt: visual.prompt,
    negativePrompt: visual.negativePrompt,
    generationState: latestBatchItems.has(visual.id) ? {
      status: latestBatchItems.get(visual.id)!.status,
      errorSummary: latestBatchItems.get(visual.id)!.errorMessage ?? null,
    } : null,
    candidates: successful.filter((item) => item.visualId === visual.id).map((item) => ({
      id: item.id,
      visualId: item.visualId,
      origin: item.origin === "generated" ? "generation" : "upload",
      currentCompatible: item.currentCompatible,
      approved: item.currentCompatible && approvals.get(item.visualId) === item.id,
      previewUrl: `/api/projects/${encodeURIComponent(projectId)}/videos/${encodeURIComponent(videoId)}/image-candidates/${encodeURIComponent(item.id)}/preview`,
      originalName: item.originalFileName ?? undefined,
      prompt: item.prompt,
      negativePrompt: item.negativePrompt,
      styleSnapshot: item.styleSnapshot,
      providerId: item.providerId,
      modelId: item.model,
      params: item.parameters,
      width: item.width,
      height: item.height,
      bytes: item.bytes,
      fileHash: item.fileHash,
      providerRequestId: item.providerRequestId ?? undefined,
      planSnapshotId: item.planSnapshotId,
      planSnapshotHash: item.planSnapshotHash,
      scriptRevisionId: item.scriptRevisionId,
      scriptContentHash: item.scriptContentHash,
      visualRevisionId: item.visualRevisionId,
      visualContentHash: item.visualContentHash,
      promptHash: item.promptHash,
      requestIdentity: item.requestIdentity,
      batchId: item.jobId ? generationIdentities.get(item.jobId)?.batchId : undefined,
      idempotencyKey: item.jobId ? generationIdentities.get(item.jobId)?.idempotencyKey : undefined,
      jobId: item.jobId,
      attempt: item.attempt,
      checkpointScope: item.checkpointScope,
      mime: item.mime,
      relativePath: item.relativePath,
      createdAt: item.createdAt,
    })),
  }));
  const productionAllowed = raw.permitValid && !!provider;
  const approvedCount = visuals.filter((visual) => visual.candidates.some((item) => item.approved)).length;
  return {
    productionAllowed,
    blockedReason: raw.permitValid
      ? provider ? null : "图片模型未配置或能力不匹配，请先在设置中完成配置"
      : "当前方案尚未有效批准或已经失效，旧候选仅供历史查看",
    provider: provider ? { id: provider.providerId, model: provider.model } : null,
    feeEstimate: null,
    summary: { visualTotal: visuals.length,
      currentCandidateCount: successful.filter((item) => item.currentCompatible).length,
      coveredVisualCount: covered.size,
      missingCount: Math.max(0, visuals.length - covered.size), plannedPerVisual: 1 as const },
    gate: { status: raw.gateComplete ? "complete" as const : "pending" as const,
      revision: raw.gateRevision, approvedCount, total: visuals.length },
    batch: publicBatch(raw.batch),
    visuals,
  };
}

export async function registerVideoImageRoutes(app: FastifyInstance, options: {
  database: DatabaseSync;
  dataRoot: string;
  resolveImageProvider: ResolveVideoImageProvider;
}) {
  app.get<{ Params: Params }>("/api/projects/:projectId/videos/:videoId/images/workspace", async (request, reply) => {
    try {
      return { ok: true, workspace: await publicWorkspace(options, request.params.projectId, request.params.videoId) };
    } catch (error) {
      if (error instanceof VideoImageError && error.statusCode === 409) {
        return { ok: true, workspace: await publicWorkspace(options, request.params.projectId, request.params.videoId) };
      }
      return sendError(error, reply);
    }
  });

  app.post<{ Params: Params; Body: { idempotencyKey?: unknown; mode?: unknown } }>(
    "/api/projects/:projectId/videos/:videoId/image-batches", async (request, reply) => {
      try {
        const provider = await options.resolveImageProvider();
        if (!provider) throw new VideoImageError(409, "图片模型未配置或能力不匹配，请先在设置中完成配置");
        const mode = request.body?.mode === "retry_failed" ? "retry_failed" : "missing";
        const result = enqueueVideoImageBatch(options.database, { ...request.params, mode,
          idempotencyKey: request.body?.idempotencyKey as string, providerId: provider.providerId, model: provider.model });
        return reply.code(result.created ? 201 : 200).send({ ok: true,
          message: result.created ? "图片批次已创建" : "已返回同一次图片批次", ...result });
      } catch (error) { return sendError(error, reply); }
    });

  app.post<{ Params: Params & { visualId: string }; Body: { idempotencyKey?: unknown; regenerate?: unknown } }>(
    "/api/projects/:projectId/videos/:videoId/visuals/:visualId/image-jobs", async (request, reply) => {
      try {
        const provider = await options.resolveImageProvider();
        if (!provider) throw new VideoImageError(409, "图片模型未配置或能力不匹配，请先在设置中完成配置");
        const result = enqueueVideoImageBatch(options.database, { projectId: request.params.projectId,
          videoId: request.params.videoId, visualId: request.params.visualId,
          mode: request.body?.regenerate === true ? "regenerate" : "single",
          idempotencyKey: request.body?.idempotencyKey as string, providerId: provider.providerId, model: provider.model });
        return reply.code(result.created ? 201 : 200).send({ ok: true,
          message: result.created ? "单张图片任务已创建" : "已返回同一次单张任务", ...result });
      } catch (error) { return sendError(error, reply); }
    });

  app.get<{ Params: Params }>("/api/projects/:projectId/videos/:videoId/image-batches/current", async (request, reply) => {
    try { return { ok: true, batch: getVideoImageBatch(options.database, request.params.projectId, request.params.videoId) }; }
    catch (error) { return sendError(error, reply); }
  });

  app.post<{ Params: Params & { batchId: string } }>(
    "/api/projects/:projectId/videos/:videoId/image-batches/:batchId/cancel", async (request, reply) => {
      try { return { ok: true, message: "图片批次取消请求已记录", batch: cancelVideoImageBatch(options.database,
        request.params.projectId, request.params.videoId, request.params.batchId) }; }
      catch (error) { return sendError(error, reply); }
    });

  app.post<{ Params: Params & { visualId: string } }>(
    "/api/projects/:projectId/videos/:videoId/visuals/:visualId/image-candidates/upload",
    { bodyLimit: 30 * 1024 * 1024 }, async (request, reply) => {
      try {
        if (request.headers["content-type"]?.split(";", 1)[0]?.trim().toLowerCase() !== "application/octet-stream") {
          throw new VideoImageError(415, "候选图上传只支持 application/octet-stream");
        }
        const candidate = await uploadVideoImageCandidate(options.database, options.dataRoot, {
          projectId: request.params.projectId, videoId: request.params.videoId, visualId: request.params.visualId,
          originalFileName: fileName(request.headers["x-file-name"]), raw: request.body as Readable,
        });
        return reply.code(201).send({ ok: true, message: "图片候选已上传，尚未自动批准", candidate });
      } catch (error) { return sendError(error, reply); }
    });

  app.put<{ Params: Params & { visualId: string }; Body: { candidateId?: unknown; expectedGateRevision?: unknown } }>(
    "/api/projects/:projectId/videos/:videoId/visuals/:visualId/image-approval", async (request, reply) => {
      try {
        const revision = request.body?.expectedGateRevision;
        if (!Number.isSafeInteger(revision) || (revision as number) < 0) throw new VideoImageError(422, "图片审核版本无效");
        const workspace = approveVideoImageCandidate(options.database, options.dataRoot, { ...request.params,
          candidateId: videoImageText(request.body?.candidateId, "候选图 ID", 200), expectedGateRevision: revision as number });
        return { ok: true, message: workspace.gateComplete ? "全部画面配图已批准；不会自动启动语音或渲染" : "当前画面配图已批准" };
      } catch (error) { return sendError(error, reply); }
    });

  app.get<{ Params: Params & { candidateId: string } }>(
    "/api/projects/:projectId/videos/:videoId/image-candidates/:candidateId/preview", async (request, reply) => {
      try {
        const preview = await openVideoImagePreview(options.database, options.dataRoot, request.params.projectId,
          request.params.videoId, request.params.candidateId);
        return reply.header("content-type", preview.mime).header("content-length", preview.bytes)
          .header("etag", `\"${preview.fileHash}\"`).header("cache-control", "private, no-store").send(preview.stream);
      } catch (error) { return sendError(error, reply); }
    });
}
