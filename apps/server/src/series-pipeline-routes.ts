import type { FastifyPluginAsync } from "fastify";

import { SeriesPipelineService, SeriesPipelineWorker } from "./series-pipeline-service.js";
import { SeriesPipelineError } from "./series-pipeline-store.js";

interface Options { service: SeriesPipelineService; worker: SeriesPipelineWorker }
interface CreateBody {
  episodeCount?: unknown; targetDurationSeconds?: unknown;
  sourceStartChapterId?: unknown; sourceEndChapterId?: unknown;
  chapterBatchSize?: unknown; chapterConcurrency?: unknown;
  episodeRanges?: unknown;
}

function statusCode(error: unknown) {
  if (error instanceof SeriesPipelineError) return error.statusCode;
  if (error && typeof error === "object" && "statusCode" in error &&
      typeof (error as { statusCode?: unknown }).statusCode === "number") {
    return (error as { statusCode: number }).statusCode;
  }
  return undefined;
}

export const registerSeriesPipelineRoutes: FastifyPluginAsync<Options> = async (app, options) => {
  app.post<{ Params: { seriesId: string }; Body: CreateBody }>(
    "/api/series/:seriesId/pipeline-runs",
    async (request, reply) => {
      try {
        if (!Array.isArray(request.body?.episodeRanges)) {
          throw new SeriesPipelineError(400, "开始付费分析前必须先预览并确认全部分集章节范围");
        }
        const run = await options.service.create({
          seriesProjectId: request.params.seriesId,
          episodeCount: request.body?.episodeCount as number,
          targetDurationSeconds: request.body?.targetDurationSeconds as number,
          sourceStartChapterId: request.body?.sourceStartChapterId as string,
          sourceEndChapterId: request.body?.sourceEndChapterId as string,
          chapterBatchSize: request.body?.chapterBatchSize as number,
          chapterConcurrency: request.body?.chapterConcurrency as number,
          episodeRanges: request.body?.episodeRanges as Array<{
            episodeIndex: number; startChapterId: string; endChapterId: string;
          }>,
        });
        options.worker.poke();
        return reply.code(201).send({ ok: true, message: "全本自动改写流水线已创建", run });
      } catch (error) {
        const code = statusCode(error);
        if (code) return reply.code(code).send({ ok: false, message: error instanceof Error ? error.message : "创建失败" });
        throw error;
      }
    },
  );

  app.post<{ Params: { seriesId: string }; Body: CreateBody }>(
    "/api/series/:seriesId/pipeline-runs/episode-ranges/preview",
    async (request, reply) => {
      try {
        return {
          ok: true,
          ranges: options.service.preview({
            seriesProjectId: request.params.seriesId,
            episodeCount: request.body?.episodeCount as number,
            sourceStartChapterId: request.body?.sourceStartChapterId as string,
            sourceEndChapterId: request.body?.sourceEndChapterId as string,
          }),
        };
      } catch (error) {
        const code = statusCode(error);
        if (code) return reply.code(code).send({ ok: false, message: error instanceof Error ? error.message : "预览失败" });
        throw error;
      }
    },
  );

  app.get<{ Params: { seriesId: string } }>(
    "/api/series/:seriesId/pipeline-runs/current",
    async (request, reply) => {
      const run = options.service.current(request.params.seriesId);
      return run ? { ok: true, run } : reply.code(404).send({ ok: false, message: "该系列没有未结束的全本流水线" });
    },
  );

  app.get<{ Params: { runId: string } }>("/api/pipeline-runs/:runId", async (request, reply) => {
    const run = options.service.get(request.params.runId);
    return run ? { ok: true, run } : reply.code(404).send({ ok: false, message: "全本流水线不存在" });
  });

  const controls = {
    pause: { action: (id: string) => options.service.pause(id), message: "全本流水线正在暂停当前任务" },
    resume: { action: (id: string) => options.service.resume(id), message: "全本流水线已继续" },
    cancel: { action: (id: string) => options.service.cancel(id), message: "全本流水线已取消" },
    retry: { action: (id: string) => options.service.retry(id), message: "失败章节已重新排队" },
  } as const;
  for (const [name, control] of Object.entries(controls)) {
    app.post<{ Params: { runId: string } }>(`/api/pipeline-runs/:runId/${name}`, async (request, reply) => {
      try {
        const run = control.action(request.params.runId);
        options.worker.poke();
        return { ok: true, message: control.message, run };
      } catch (error) {
        if (error instanceof SeriesPipelineError) {
          return reply.code(error.statusCode).send({ ok: false, message: error.message });
        }
        throw error;
      }
    });
  }
};
