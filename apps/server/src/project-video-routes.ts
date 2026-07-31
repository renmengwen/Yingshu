import type { FastifyInstance, FastifyReply } from "fastify";
import { rm } from "node:fs/promises";
import { resolve, sep } from "node:path";
import type { DatabaseSync } from "node:sqlite";

import { withDataFileMutationLock } from "./data-file-mutation-lock.js";
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
import { cleanupUnreferencedVideoImageFiles } from "./video-image-store.js";
import { cancelActiveVideoImageJobs } from "./video-image-invalidation.js";
import { requestJobCancellation } from "./job-store.js";

async function cleanupVideoTtsDirectories(dataRoot: string, videoIds: string[]) {
  const root = resolve(dataRoot);
  for (const videoId of videoIds) {
    if (!/^[A-Za-z0-9_-]+$/u.test(videoId)) throw new ProjectVideoStoreError(409, "视频文件身份无效，不能安全删除");
    const target = resolve(root, "video-tts", videoId);
    if (!target.startsWith(`${root}${sep}`)) throw new ProjectVideoStoreError(409, "配音目录越界，不能安全删除");
    await rm(target, { recursive: true, force: true });
  }
}

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
  options: { database: DatabaseSync; dataRoot: string },
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
      const project = await withDataFileMutationLock(options.dataRoot, async () => {
        const videoIds = options.database.prepare("SELECT id FROM videos WHERE project_id=?")
          .all(request.params.projectId) as Array<{ id: string }>;
        for (const video of videoIds) cancelActiveVideoImageJobs(options.database, video.id);
        const ttsJobIds = options.database.prepare(
          `SELECT map.job_id AS id FROM video_tts_jobs map JOIN videos ON videos.id=map.video_id
           WHERE videos.project_id=?`,
        ).all(request.params.projectId) as Array<{ id: string }>;
        for (const job of ttsJobIds) requestJobCancellation(options.database, job.id);
        const files = options.database.prepare(
          `SELECT DISTINCT candidate.relative_path AS relativePath, candidate.file_hash AS fileHash
           FROM video_image_candidates candidate
           JOIN videos ON videos.id = candidate.video_id
           WHERE videos.project_id = ? AND candidate.status = 'succeeded'`,
        ).all(request.params.projectId) as Array<{ relativePath: string; fileHash: string }>;
        const deleted = deleteProject(options.database, request.params.projectId);
        for (const job of ttsJobIds) options.database.prepare("DELETE FROM jobs WHERE id=?").run(job.id);
        await cleanupUnreferencedVideoImageFiles(options.database, options.dataRoot, files);
        await cleanupVideoTtsDirectories(options.dataRoot, videoIds.map((video) => video.id));
        return deleted;
      });
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
