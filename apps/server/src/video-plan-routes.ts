import type { FastifyInstance, FastifyReply } from "fastify";
import type { DatabaseSync } from "node:sqlite";

import type { ChapterTextModelConfig } from "./chapter-event-analyzer.js";
import { CreativeInputError } from "./creative-input-contract.js";
import { ProjectVideoStoreError } from "./project-video-store.js";
import { approveVideoPlan, cancelVideoPlanJob, enqueueVideoPlanJob, getVideoPlan, getVideoPlanJob,
  getVideoPlanSources, saveVideoScriptRevision, saveVideoVisualRevision, VideoPlanError,
  videoPlanJobSummary, videoStatus } from "./video-plan-service.js";

function sendError(error: unknown, reply: FastifyReply) {
  if (error instanceof VideoPlanError || error instanceof ProjectVideoStoreError || error instanceof CreativeInputError) {
    return reply.code(error.statusCode).send({ ok: false, message: error.message });
  }
  throw error;
}

type Params = { projectId: string; videoId: string };

export async function registerVideoPlanRoutes(app: FastifyInstance, options: {
  database: DatabaseSync;
  resolveTextModel: () => ChapterTextModelConfig | null | Promise<ChapterTextModelConfig | null>;
}) {
  app.post<{ Params: Params; Body: { idempotencyKey?: unknown; entryMode?: unknown } }>(
    "/api/projects/:projectId/videos/:videoId/plan-jobs", async (request, reply) => {
      try {
        const config = await options.resolveTextModel();
        if (!config) throw new VideoPlanError(409, "文本模型未配置或不可用，请先在设置中完成配置");
        const result = enqueueVideoPlanJob(options.database, { ...request.params,
          idempotencyKey: request.body?.idempotencyKey, entryMode: request.body?.entryMode, config });
        return { ok: true, message: result.created ? "方案任务已创建" : "已返回同一次方案任务",
          job: videoPlanJobSummary(result.job), videoStatus: videoStatus(options.database, request.params.projectId, request.params.videoId) };
      } catch (error) { return sendError(error, reply); }
    });

  app.get<{ Params: Params }>("/api/projects/:projectId/videos/:videoId/plan", async (request, reply) => {
    try { return { ok: true, plan: getVideoPlan(options.database, request.params.projectId, request.params.videoId) }; }
    catch (error) { return sendError(error, reply); }
  });
  app.get<{ Params: Params }>("/api/projects/:projectId/videos/:videoId/sources", async (request, reply) => {
    try { return { ok: true, ...getVideoPlanSources(options.database, request.params.projectId, request.params.videoId) }; }
    catch (error) { return sendError(error, reply); }
  });
  app.get<{ Params: Params }>("/api/projects/:projectId/videos/:videoId/plan-job", async (request, reply) => {
    try { return { ok: true, job: videoPlanJobSummary(getVideoPlanJob(options.database, request.params.projectId, request.params.videoId)),
      videoStatus: videoStatus(options.database, request.params.projectId, request.params.videoId) }; }
    catch (error) { return sendError(error, reply); }
  });
  app.post<{ Params: Params }>("/api/projects/:projectId/videos/:videoId/plan-job/cancel", async (request, reply) => {
    try { const job = cancelVideoPlanJob(options.database, request.params.projectId, request.params.videoId);
      return { ok: true, message: "已请求取消方案任务", job: videoPlanJobSummary(job),
        videoStatus: videoStatus(options.database, request.params.projectId, request.params.videoId) }; }
    catch (error) { return sendError(error, reply); }
  });
  app.post<{ Params: Params; Body: unknown }>("/api/projects/:projectId/videos/:videoId/script-revisions", async (request, reply) => {
    try { return { ok: true, message: "旁白修订已保存", plan: saveVideoScriptRevision(options.database,
      request.params.projectId, request.params.videoId, request.body) }; }
    catch (error) { return sendError(error, reply); }
  });
  app.post<{ Params: Params; Body: unknown }>("/api/projects/:projectId/videos/:videoId/visual-revisions", async (request, reply) => {
    try { return { ok: true, message: "画面修订已保存", plan: saveVideoVisualRevision(options.database,
      request.params.projectId, request.params.videoId, request.body) }; }
    catch (error) { return sendError(error, reply); }
  });
  app.post<{ Params: Params; Body: unknown }>("/api/projects/:projectId/videos/:videoId/approve", async (request, reply) => {
    try { return { ok: true, message: "旁白与画面方案已批准；不会自动生成图片或语音", plan: approveVideoPlan(options.database,
      request.params.projectId, request.params.videoId, request.body) }; }
    catch (error) { return sendError(error, reply); }
  });
}
