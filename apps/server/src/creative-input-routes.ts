import type { FastifyInstance, FastifyReply } from "fastify";
import type { DatabaseSync } from "node:sqlite";

import { CreativeInputError } from "./creative-input-contract.js";
import {
  getGlobalPromptSettings,
  getProjectSettings,
  getVideoInput,
  putGlobalPromptSettings,
  putProjectSettings,
  putVideoInput,
} from "./creative-input-store.js";
import { ProjectVideoStoreError } from "./project-video-store.js";

function sendInputError(error: unknown, reply: FastifyReply) {
  if (error instanceof CreativeInputError || error instanceof ProjectVideoStoreError) {
    return reply.code(error.statusCode).send({ ok: false, message: error.message });
  }
  throw error;
}

export async function registerCreativeInputRoutes(
  app: FastifyInstance,
  options: { database: DatabaseSync },
) {
  app.get<{ Params: { projectId: string } }>(
    "/api/projects/:projectId/settings",
    async (request, reply) => {
      try {
        return { ok: true, settings: getProjectSettings(options.database, request.params.projectId) };
      } catch (error) { return sendInputError(error, reply); }
    },
  );

  app.put<{ Params: { projectId: string }; Body: unknown }>(
    "/api/projects/:projectId/settings",
    async (request, reply) => {
      try {
        return {
          ok: true,
          message: "项目创作设置已保存；只影响本项目后续新生成",
          settings: putProjectSettings(options.database, request.params.projectId, request.body),
        };
      } catch (error) { return sendInputError(error, reply); }
    },
  );

  app.get<{ Params: { projectId: string; videoId: string } }>(
    "/api/projects/:projectId/videos/:videoId/input",
    async (request, reply) => {
      try {
        return { ok: true, input: getVideoInput(
          options.database, request.params.projectId, request.params.videoId,
        ) };
      } catch (error) { return sendInputError(error, reply); }
    },
  );

  app.put<{ Params: { projectId: string; videoId: string }; Body: unknown }>(
    "/api/projects/:projectId/videos/:videoId/input",
    async (request, reply) => {
      try {
        return {
          ok: true,
          message: "视频输入草稿已保存",
          // 草稿允许主输入暂时为空；真正启动方案任务时再按当前创作起点执行严格门禁。
          input: putVideoInput(options.database, request.params.projectId, request.params.videoId, request.body,
            Date.now(), true),
        };
      } catch (error) { return sendInputError(error, reply); }
    },
  );

  app.get("/api/product-prompts", async () => ({
    ok: true,
    settings: getGlobalPromptSettings(options.database),
  }));

  app.put<{ Body: unknown }>("/api/product-prompts", async (request, reply) => {
    try {
      return {
        ok: true,
        message: "全局提示词已保存；只影响后续新生成",
        settings: putGlobalPromptSettings(options.database, request.body),
      };
    } catch (error) { return sendInputError(error, reply); }
  });
}
