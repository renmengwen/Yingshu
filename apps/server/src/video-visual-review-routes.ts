import type { DatabaseSync } from "node:sqlite";
import type { FastifyInstance, FastifyReply } from "fastify";

import { ProjectVideoStoreError } from "./project-video-store.js";
import { VideoVisualTimelineError } from "./video-visual-timeline.js";
import {
  getVideoVisualReview,
  saveVideoVisualReview,
  VideoVisualReviewError,
} from "./video-visual-review.js";

type Params = { projectId: string; videoId: string };

function sendError(error: unknown, reply: FastifyReply) {
  if (error instanceof VideoVisualReviewError || error instanceof VideoVisualTimelineError ||
      error instanceof ProjectVideoStoreError) {
    return reply.code(error.statusCode).send({ ok: false, message: error.message });
  }
  throw error;
}

export async function registerVideoVisualReviewRoutes(app: FastifyInstance, options: { database: DatabaseSync }) {
  app.get<{ Params: Params }>(
    "/api/projects/:projectId/videos/:videoId/visual-review",
    async (request, reply) => {
      try { return { ok: true, review: getVideoVisualReview(options.database, request.params.projectId, request.params.videoId) }; }
      catch (error) { return sendError(error, reply); }
    },
  );

  app.post<{ Params: Params; Body: unknown }>(
    "/api/projects/:projectId/videos/:videoId/visual-review",
    async (request, reply) => {
      try {
        const review = saveVideoVisualReview(options.database, request.params.projectId, request.params.videoId, request.body);
        return { ok: true, message: review.reviewGate.complete ? "当前整片画面已批准；不会自动开始最终渲染" : "修改意见已保存", review };
      } catch (error) { return sendError(error, reply); }
    },
  );
}
