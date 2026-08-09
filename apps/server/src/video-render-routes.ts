import type { DatabaseSync } from "node:sqlite";
import { basename, dirname, join, resolve } from "node:path";
import type { FastifyInstance, FastifyReply } from "fastify";

import { ProjectVideoStoreError } from "./project-video-store.js";
import { createVideoProjectPackage } from "./video-project-package.js";
import {
  cancelVideoRender, enqueueVideoRender, getVideoRenderWorkspace, openCurrentFinalVideo, openFinalVideo, VideoRenderError,
  videoRenderIdentity,
} from "./video-render-store.js";
import { VideoVisualReviewError } from "./video-visual-review.js";
import { VideoVisualTimelineError } from "./video-visual-timeline.js";

type Params = { projectId: string; videoId: string };
type RunParams = Params & { renderId: string };

function sendError(error: unknown, reply: FastifyReply) {
  if (error instanceof VideoRenderError || error instanceof VideoVisualReviewError ||
      error instanceof VideoVisualTimelineError || error instanceof ProjectVideoStoreError) {
    return reply.code(error.statusCode).send({ ok: false, message: error.message });
  }
  if ((error as NodeJS.ErrnoException)?.code === "ENOENT") {
    return reply.code(409).send({ ok: false, message: "最终视频文件不存在或已损坏" });
  }
  throw error;
}

function emptyBody(value: unknown) {
  if (value === undefined || (value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).length === 0)) return;
  throw new VideoRenderError(400, "最终渲染不接受自定义路径或输出参数");
}

export function parseVideoRange(value: string | undefined, bytes: number) {
  if (!value) return null;
  const match = /^bytes=(\d*)-(\d*)$/u.exec(value.trim());
  if (!match || (!match[1] && !match[2])) throw new VideoRenderError(416, "视频 Range 请求无效");
  let start: number;
  let end: number;
  if (!match[1]) {
    const suffix = Number(match[2]);
    if (!Number.isSafeInteger(suffix) || suffix < 1) throw new VideoRenderError(416, "视频 Range 请求无效");
    start = Math.max(0, bytes - suffix);
    end = bytes - 1;
  } else {
    start = Number(match[1]);
    end = match[2] ? Number(match[2]) : bytes - 1;
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start || start >= bytes) {
      throw new VideoRenderError(416, "视频 Range 超出文件范围");
    }
    end = Math.min(end, bytes - 1);
  }
  return { start, end };
}

async function sendVideo(database: DatabaseSync, dataRoot: string, params: Params,
  rangeHeader: string | undefined, download: boolean, reply: FastifyReply, runId?: string) {
  const result = await openFinalVideo(database, dataRoot, params.projectId, params.videoId, runId);
  try {
    let range;
    try { range = parseVideoRange(rangeHeader, result.bytes); }
    catch (error) {
      await result.handle.close();
      if (error instanceof VideoRenderError && error.statusCode === 416) {
        return reply.code(416).header("Content-Range", `bytes */${result.bytes}`).send({ ok: false, message: error.message });
      }
      throw error;
    }
    const start = range?.start ?? 0;
    const end = range?.end ?? result.bytes - 1;
    const filename = `yingshu-${params.videoId}.mp4`;
    reply.header("Accept-Ranges", "bytes").header("Cache-Control", "no-store")
      .header("Content-Length", end - start + 1)
      .header("Content-Disposition", `${download ? "attachment" : "inline"}; filename="${filename}"`)
      .type("video/mp4");
    if (range) reply.code(206).header("Content-Range", `bytes ${start}-${end}/${result.bytes}`);
    return reply.send(result.handle.createReadStream({ autoClose: true, start, end }));
  } catch (error) {
    await result.handle.close().catch(() => undefined);
    throw error;
  }
}

export async function registerVideoRenderRoutes(app: FastifyInstance, options: { database: DatabaseSync; dataRoot: string }) {
  const base = "/api/projects/:projectId/videos/:videoId";
  app.get<{ Params: Params }>(`${base}/renders`, async (request, reply) => {
    try { return { ok: true, ...getVideoRenderWorkspace(options.database, request.params.projectId, request.params.videoId) }; }
    catch (error) { return sendError(error, reply); }
  });
  app.post<{ Params: Params; Body: unknown }>(`${base}/renders`, async (request, reply) => {
    try {
      emptyBody(request.body);
      return { ok: true, message: "最终视频渲染已启动；不会自动发布", ...enqueueVideoRender(
        options.database, request.params.projectId, request.params.videoId,
      ) };
    } catch (error) { return sendError(error, reply); }
  });
  app.post<{ Params: RunParams; Body: unknown }>(`${base}/renders/:renderId/cancel`, async (request, reply) => {
    try {
      emptyBody(request.body);
      return { ok: true, message: "已请求中断最终渲染", ...cancelVideoRender(
        options.database, request.params.projectId, request.params.videoId, request.params.renderId,
      ) };
    } catch (error) { return sendError(error, reply); }
  });
  app.get<{ Params: Params; Headers: { range?: string } }>(`${base}/final-video`, async (request, reply) => {
    try { return await sendVideo(options.database, options.dataRoot, request.params, request.headers.range, false, reply); }
    catch (error) { return sendError(error, reply); }
  });
  app.get<{ Params: Params; Headers: { range?: string } }>(`${base}/final-video/download`, async (request, reply) => {
    try { return await sendVideo(options.database, options.dataRoot, request.params, request.headers.range, true, reply); }
    catch (error) { return sendError(error, reply); }
  });
  app.get<{ Params: Params; Querystring: { runId?: string }; Headers: { range?: string } }>(`${base}/previous-final-video`, async (request, reply) => {
      try {
        if (!request.query.runId || !/^[A-Za-z0-9_-]+$/u.test(request.query.runId)) {
          throw new VideoRenderError(400, "旧版本视频标识无效");
        }
        return await sendVideo(options.database, options.dataRoot, request.params, request.headers.range, false, reply, request.query.runId);
      } catch (error) { return sendError(error, reply); }
    });
  app.get<{ Params: Params; Querystring: { runId?: string }; Headers: { range?: string } }>(`${base}/previous-final-video/download`, async (request, reply) => {
      try {
        if (!request.query.runId || !/^[A-Za-z0-9_-]+$/u.test(request.query.runId)) {
          throw new VideoRenderError(400, "旧版本视频标识无效");
        }
        return await sendVideo(options.database, options.dataRoot, request.params, request.headers.range, true, reply, request.query.runId);
      } catch (error) { return sendError(error, reply); }
  });
  app.post<{ Params: Params; Body: unknown }>(`${base}/project-package`, async (request, reply) => {
    try {
      emptyBody(request.body);
      const verified = await openCurrentFinalVideo(
        options.database, options.dataRoot, request.params.projectId, request.params.videoId,
      );
      await verified.handle.close();
      const identity = videoRenderIdentity(options.database, request.params.projectId, request.params.videoId);
      const final = options.database.prepare(
        `SELECT final.id,final.identity_hash FROM video_final_videos final
         JOIN video_render_runs run ON run.id=final.run_id
         WHERE final.project_id=? AND final.video_id=? AND run.status='succeeded' AND run.identity_hash=?
         ORDER BY final.created_at DESC,final.id DESC LIMIT 1`,
      ).get(request.params.projectId, request.params.videoId, identity.identityHash) as { id: string; identity_hash: string } | undefined;
      if (!final) throw new VideoRenderError(404, "当前视频尚无可打包的最终成片");
      const dataRoot = resolve(options.dataRoot);
      const packagePath = join(dirname(dataRoot), `${basename(dataRoot)}-project-packages`,
        request.params.projectId, request.params.videoId, final.identity_hash);
      const result = await createVideoProjectPackage(options.database, dataRoot, {
        packagePath, projectId: request.params.projectId, videoId: request.params.videoId, finalVideoId: final.id,
      });
      return { ok: true, message: "当前视频项目包已生成", packageHash: result.manifest.packageHash };
    } catch (error) { return sendError(error, reply); }
  });
}
