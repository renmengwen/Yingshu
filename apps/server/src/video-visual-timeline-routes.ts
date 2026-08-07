import type { DatabaseSync } from "node:sqlite";
import type { FastifyInstance, FastifyReply } from "fastify";

import { ProjectVideoStoreError } from "./project-video-store.js";
import { getVideoRenderWorkspace } from "./video-render-store.js";
import { getVideoOutputProfileForVideo } from "./video-output-profile.js";
import {
  createVideoVisualTimeline, getCurrentVideoVisualTimeline, updateVideoVisualSegment, VideoVisualTimelineError,
} from "./video-visual-timeline.js";

type VideoParams = { projectId: string; videoId: string };
type SegmentParams = VideoParams & { timelineId: string; segmentId: string };

function sendError(error: unknown, reply: FastifyReply) {
  if (error instanceof VideoVisualTimelineError || error instanceof ProjectVideoStoreError) {
    return reply.code(error.statusCode).send({ ok: false, message: error.message });
  }
  throw error;
}

function workspace(database: DatabaseSync, projectId: string, videoId: string) {
  const gates = getVideoRenderWorkspace(database, projectId, videoId).readiness.gates
    .filter((gate) => gate.key !== "visual");
  // 时间轴预览与最终成片共享同一输出画幅，避免横屏候选被旧竖屏容器裁切。
  return { aspectRatio: getVideoOutputProfileForVideo(database, projectId, videoId).aspectRatio,
    gates, timeline: getCurrentVideoVisualTimeline(database, projectId, videoId) };
}

export async function registerVideoVisualTimelineRoutes(app: FastifyInstance, options: { database: DatabaseSync }) {
  app.get<{ Params: VideoParams }>("/api/projects/:projectId/videos/:videoId/visual-timelines", async (request, reply) => {
    try { return { ok: true, workspace: workspace(options.database, request.params.projectId, request.params.videoId) }; }
    catch (error) { return sendError(error, reply); }
  });

  app.post<{ Params: VideoParams }>("/api/projects/:projectId/videos/:videoId/visual-timelines", async (request, reply) => {
    try {
      createVideoVisualTimeline(options.database, request.params.projectId, request.params.videoId);
      return { ok: true, message: "正式画面时间轴已创建", workspace: workspace(options.database,
        request.params.projectId, request.params.videoId) };
    } catch (error) { return sendError(error, reply); }
  });

  app.patch<{ Params: SegmentParams; Body: unknown }>(
    "/api/projects/:projectId/videos/:videoId/visual-timelines/:timelineId/segments/:segmentId",
    async (request, reply) => {
      try {
        const body = request.body;
        if (!body || typeof body !== "object" || Array.isArray(body)) throw new VideoVisualTimelineError(422, "运镜调整无效");
        const input = body as Record<string, unknown>;
        if (Object.keys(input).some((key) => ![
          "expectedTimelineHash", "motionKind", "motionAmountPpm", "fadeInMs", "fadeOutMs",
        ].includes(key))) throw new VideoVisualTimelineError(422, "运镜调整字段无效");
        const current = getCurrentVideoVisualTimeline(options.database, request.params.projectId, request.params.videoId);
        if (!current || current.id !== request.params.timelineId || current.timelineHash !== input.expectedTimelineHash) {
          throw new VideoVisualTimelineError(409, "画面时间轴已变化，请刷新后重试");
        }
        const segmentIndex = current.segments.findIndex((segment) => segment.id === request.params.segmentId);
        if (segmentIndex < 0) throw new VideoVisualTimelineError(404, "画面段不存在或不属于当前时间轴");
        updateVideoVisualSegment(options.database, request.params.projectId, request.params.videoId,
          current.id, segmentIndex, { motionKind: input.motionKind, motionAmountPpm: input.motionAmountPpm,
            fadeInMs: input.fadeInMs, fadeOutMs: input.fadeOutMs });
        return { ok: true, message: "运镜参数已保存，整片审核需重新确认", workspace: workspace(options.database,
          request.params.projectId, request.params.videoId) };
      } catch (error) { return sendError(error, reply); }
    },
  );
}
