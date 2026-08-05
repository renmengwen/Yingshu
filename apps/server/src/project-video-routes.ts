import type { FastifyInstance, FastifyReply } from "fastify";
import { rm } from "node:fs/promises";
import { resolve, sep } from "node:path";
import type { DatabaseSync } from "node:sqlite";

import { withDataFileMutationLock } from "./data-file-mutation-lock.js";
import {
  createProject,
  createVideo,
  deleteProject,
  deleteVideo,
  getProject,
  getVideo,
  listProjects,
  listVideos,
  ProjectVideoStoreError,
} from "./project-video-store.js";
import { cleanupUnreferencedVideoImageFiles } from "./video-image-store.js";
import { cancelActiveVideoImageJobs } from "./video-image-invalidation.js";
import { requestJobCancellation } from "./job-store.js";

async function cleanupVideoDirectories(dataRoot: string, videoIds: string[]) {
  const root = resolve(dataRoot);
  for (const videoId of videoIds) {
    if (!/^[A-Za-z0-9_-]+$/u.test(videoId)) throw new ProjectVideoStoreError(409, "视频文件身份无效，不能安全删除");
    for (const parts of [["video-tts", videoId], ["videos", videoId]]) {
      const target = resolve(root, ...parts);
      if (!target.startsWith(`${root}${sep}`)) throw new ProjectVideoStoreError(409, "视频目录越界，不能安全删除");
      await rm(target, { recursive: true, force: true });
    }
  }
}

function videoJobIds(database: DatabaseSync, videoId: string) {
  return database.prepare(`
    SELECT job_id AS id FROM video_plan_jobs WHERE video_id=?
    UNION SELECT job_id FROM video_image_batch_items WHERE video_id=? AND job_id IS NOT NULL
    UNION SELECT job_id FROM video_image_candidates WHERE video_id=? AND job_id IS NOT NULL
    UNION SELECT job_id FROM video_tts_jobs WHERE video_id=?
    UNION SELECT job_id FROM video_tts_artifacts WHERE video_id=?
    UNION SELECT job_id FROM video_render_runs WHERE video_id=? AND job_id IS NOT NULL
  `).all(videoId, videoId, videoId, videoId, videoId, videoId) as Array<{ id: string }>;
}

async function deleteVideoContents(
  database: DatabaseSync,
  dataRoot: string,
  projectId: string,
  videoId: string,
) {
  const video = getVideo(database, projectId, videoId);
  cancelActiveVideoImageJobs(database, video.id);
  const jobs = videoJobIds(database, video.id);
  for (const job of jobs) requestJobCancellation(database, job.id);
  const files = database.prepare(
    `SELECT DISTINCT relative_path AS relativePath, file_hash AS fileHash
     FROM video_image_candidates
     WHERE video_id=? AND status='succeeded'`,
  ).all(video.id) as Array<{ relativePath: string; fileHash: string }>;

  const deleted = deleteVideo(database, projectId, video.id);
  for (const job of jobs) database.prepare("DELETE FROM jobs WHERE id=?").run(job.id);
  // 图片按内容寻址，必须在数据库引用删除后再判断是否仍被其他视频使用。
  await cleanupUnreferencedVideoImageFiles(database, dataRoot, files);
  await cleanupVideoDirectories(dataRoot, [video.id]);
  return deleted;
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
        const project = getProject(options.database, request.params.projectId);
        for (const video of videoIds) {
          await deleteVideoContents(options.database, options.dataRoot, project.id, video.id);
        }
        return deleteProject(options.database, project.id);
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

  app.delete<{ Params: { projectId: string; videoId: string } }>(
    "/api/projects/:projectId/videos/:videoId",
    async (request, reply) => {
      try {
        const video = await withDataFileMutationLock(options.dataRoot, () => deleteVideoContents(
          options.database, options.dataRoot, request.params.projectId, request.params.videoId,
        ));
        return { ok: true, message: `视频“${video.title}”及其全部内容已永久删除`, video };
      } catch (error) { return sendStoreError(error, reply); }
    },
  );
}
