import type { DatabaseSync } from "node:sqlite";
import { basename, dirname, join, resolve } from "node:path";
import type { FastifyPluginAsync } from "fastify";

import { createEpisodeProjectPackage } from "./episode-project-package.js";
import { deriveExportReadiness, ExportReadinessError } from "./export-readiness.js";
import { FinalExportReadError, openVerifiedFinalExport } from "./final-video.js";

interface Options { database: DatabaseSync; dataRoot: string }
interface Params { episodeId: string; exportHash: string }
interface ReadinessParams { episodeId: string }
interface ReadinessQuery { timelineHash: string }

const exportParamsSchema = {
  type: "object",
  additionalProperties: false,
  required: ["episodeId", "exportHash"],
  properties: {
    episodeId: { type: "string", pattern: "^[A-Za-z0-9_-]+$" },
    exportHash: { type: "string", pattern: "^[0-9a-f]{64}$" },
  },
} as const;

export const registerExportRoutes: FastifyPluginAsync<Options> = async (app, options) => {
  const open = async (params: Params) => openVerifiedFinalExport(options.database, options.dataRoot, params);
  app.get<{ Params: ReadinessParams; Querystring: ReadinessQuery }>(
    "/api/episodes/:episodeId/export-readiness",
    {
      schema: {
        querystring: {
          type: "object",
          additionalProperties: false,
          required: ["timelineHash"],
          properties: { timelineHash: { type: "string", pattern: "^[0-9a-f]{64}$" } },
        },
      },
    },
    async (request, reply) => {
      try {
        return await deriveExportReadiness({
          database: options.database,
          dataRoot: options.dataRoot,
          episodeId: request.params.episodeId,
          timelineHash: request.query.timelineHash,
        });
      } catch (error) {
        if (error instanceof ExportReadinessError) {
          return reply.code(error.statusCode).send({ ok: false, message: error.message });
        }
        throw error;
      }
    },
  );
  app.get<{ Params: Params }>("/api/episodes/:episodeId/exports/:exportHash/manifest", async (request, reply) => {
    try {
      const result = await open(request.params);
      await result.videoHandle.close();
      return reply.header("Cache-Control", "no-store").type("application/json; charset=utf-8").send(result.manifest);
    } catch (error) {
      if (error instanceof FinalExportReadError) return reply.code(error.statusCode).send({ ok: false, message: error.message });
      throw error;
    }
  });
  app.get<{ Params: Params }>("/api/episodes/:episodeId/exports/:exportHash/video", async (request, reply) => {
    try {
      const result = await open(request.params);
      const filename = `episode-${request.params.episodeId}-${request.params.exportHash}.mp4`;
      return reply.header("Cache-Control", "no-store")
        .header("Content-Length", result.manifest.finalVideo.bytes)
        .header("Content-Disposition", `attachment; filename="${filename}"`)
        .type("video/mp4")
        .send(result.videoHandle.createReadStream({ autoClose: true, start: 0 }));
    } catch (error) {
      if (error instanceof FinalExportReadError) return reply.code(error.statusCode).send({ ok: false, message: error.message });
      throw error;
    }
  });
  app.post<{ Params: Params; Body: unknown }>(
    "/api/episodes/:episodeId/exports/:exportHash/project-package",
    {
      schema: {
        params: exportParamsSchema,
      },
    },
    async (request, reply) => {
      try {
        if (request.body !== undefined &&
            (request.body === null || typeof request.body !== "object" || Object.keys(request.body).length > 0)) {
          return reply.code(400).send({ ok: false, message: "创建项目包不接受请求参数或路径" });
        }
        const verified = await open(request.params);
        await verified.videoHandle.close();
        const dataRoot = resolve(options.dataRoot);
        const packagePath = join(
          dirname(dataRoot),
          `${basename(dataRoot)}-project-packages`,
          request.params.episodeId,
          request.params.exportHash,
        );
        const result = await createEpisodeProjectPackage(options.database, dataRoot, {
          packagePath,
          episodeId: request.params.episodeId,
          timelineHash: verified.manifest.timelineHash,
          finalExportHash: request.params.exportHash,
        });
        return { packagePath: result.packagePath, packageHash: result.manifest.packageHash, manifest: result.manifest };
      } catch (error) {
        if (error instanceof FinalExportReadError) return reply.code(error.statusCode).send({ ok: false, message: error.message });
        throw error;
      }
    },
  );
};
