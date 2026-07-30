import type { FastifyInstance, FastifyReply } from "fastify";
import type { DatabaseSync } from "node:sqlite";

import {
  createProject,
  createVideo,
  deleteProject,
  getProject,
  getVideo,
  listProjects,
  listVideos,
  ProjectVideoStoreError,
} from "./project-video-store.js";

function exactBody(value: unknown, field: "name" | "title") {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      Object.keys(value).some((key) => key !== field)) {
    throw new ProjectVideoStoreError(400, field === "name"
      ? "创建项目只能提交项目名称"
      : "创建视频只能提交视频标题");
  }
  return value as { name?: unknown; title?: unknown };
}

function sendStoreError(error: unknown, reply: FastifyReply) {
  if (error instanceof ProjectVideoStoreError) {
    return reply.code(error.statusCode).send({ ok: false, message: error.message });
  }
  throw error;
}

export async function registerProjectVideoRoutes(
  app: FastifyInstance,
  options: { database: DatabaseSync },
) {
  app.get("/api/projects", async () => ({ ok: true, items: listProjects(options.database) }));

  app.post<{ Body: unknown }>("/api/projects", async (request, reply) => {
    try {
      const body = exactBody(request.body, "name");
      const project = createProject(options.database, { name: body.name });
      return reply.code(201).send({ ok: true, message: "项目已创建", project });
    } catch (error) { return sendStoreError(error, reply); }
  });

  app.get<{ Params: { projectId: string } }>("/api/projects/:projectId", async (request, reply) => {
    try {
      return { ok: true, project: getProject(options.database, request.params.projectId) };
    } catch (error) { return sendStoreError(error, reply); }
  });

  app.delete<{ Params: { projectId: string } }>("/api/projects/:projectId", async (request, reply) => {
    try {
      const project = deleteProject(options.database, request.params.projectId);
      return { ok: true, message: `项目“${project.name}”及其草稿视频已删除`, project };
    } catch (error) { return sendStoreError(error, reply); }
  });

  app.get<{ Params: { projectId: string } }>("/api/projects/:projectId/videos", async (request, reply) => {
    try {
      return { ok: true, items: listVideos(options.database, request.params.projectId) };
    } catch (error) { return sendStoreError(error, reply); }
  });

  app.post<{ Params: { projectId: string }; Body: unknown }>(
    "/api/projects/:projectId/videos",
    async (request, reply) => {
      try {
        const body = exactBody(request.body, "title");
        const video = createVideo(options.database, request.params.projectId, { title: body.title });
        return reply.code(201).send({ ok: true, message: "草稿视频已创建", video });
      } catch (error) { return sendStoreError(error, reply); }
    },
  );

  app.get<{ Params: { projectId: string; videoId: string } }>(
    "/api/projects/:projectId/videos/:videoId",
    async (request, reply) => {
      try {
        return { ok: true, video: getVideo(
          options.database, request.params.projectId, request.params.videoId,
        ) };
      } catch (error) { return sendStoreError(error, reply); }
    },
  );
}
