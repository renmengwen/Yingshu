import type { DatabaseSync } from "node:sqlite";
import type { FastifyPluginAsync } from "fastify";

import { getBookStoryBible } from "./book-story-bible-store.js";
import { getCurrentSeriesPipelineRun, getSeriesPipelineRun } from "./series-pipeline-store.js";

interface Options { database: DatabaseSync }

class StoryBibleReadError extends Error {
  constructor(readonly code: string, readonly state: string, message: string, readonly statusCode = 409) {
    super(message);
  }
}

function unavailableState(run: NonNullable<ReturnType<typeof getSeriesPipelineRun>>) {
  if (run.status === "failed") {
    return new StoryBibleReadError("full_book_worldview_failed", "failed", "全书世界观构建失败，请先处理流水线失败项。");
  }
  if (run.status === "paused" || run.status === "cancelled") {
    return new StoryBibleReadError("full_book_worldview_interrupted", "interrupted", "全书世界观尚未完成，构建任务已中断。");
  }
  if (["configured", "analyzing_chapters", "building_story_bible"].includes(run.status)) {
    return new StoryBibleReadError("full_book_worldview_building", "building", "全书世界观尚未生成完成。");
  }
  return new StoryBibleReadError("full_book_worldview_identity_damaged", "damaged", "当前全书世界观身份缺失，无法安全读取。");
}

export function readCurrentStoryBible(database: DatabaseSync, runId: string) {
  const run = getSeriesPipelineRun(database, runId);
  if (!run) throw new StoryBibleReadError("pipeline_run_not_found", "missing", "全本流水线不存在。", 404);
  if (!run.storyBibleId) throw unavailableState(run);

  const series = database.prepare("SELECT book_id FROM series_projects WHERE id = ?").get(run.seriesProjectId) as
    { book_id: string } | undefined;
  if (!series) {
    throw new StoryBibleReadError("full_book_worldview_identity_damaged", "damaged", "当前全书世界观所属书籍身份损坏，无法安全读取。");
  }

  const currentRun = getCurrentSeriesPipelineRun(database, run.seriesProjectId);
  if (!currentRun || currentRun.id !== run.id || currentRun.storyBibleId !== run.storyBibleId) {
    throw new StoryBibleReadError(
      "full_book_worldview_non_current",
      "invalidated",
      "该全书世界观已不是当前流水线使用的版本，无法继续查看。",
    );
  }

  let bible: ReturnType<typeof getBookStoryBible>;
  try {
    bible = getBookStoryBible(database, run.storyBibleId);
  } catch {
    throw new StoryBibleReadError("full_book_worldview_identity_damaged", "damaged", "当前全书世界观身份或内容校验失败，无法安全读取。");
  }
  if (bible.bookId !== series.book_id || bible.scope !== "final") {
    throw new StoryBibleReadError("full_book_worldview_identity_damaged", "damaged", "当前全书世界观身份不匹配，无法安全读取。");
  }
  if (bible.invalidatedAt !== null) {
    throw new StoryBibleReadError("full_book_worldview_invalidated", "invalidated", "当前全书世界观已失效，无法继续查看。");
  }

  return {
    content: bible.content,
    metadata: {
      revision: bible.revision,
      contentHash: bible.contentHash,
      provider: bible.providerId,
      model: bible.model,
      sourceStartChapterId: bible.sourceStartChapterId,
      sourceEndChapterId: bible.sourceEndChapterId,
      createdAt: bible.createdAt,
    },
  };
}

export const registerSeriesPipelineStoryBibleRoutes: FastifyPluginAsync<Options> = async (app, options) => {
  app.get<{ Params: { runId: string } }>(
    "/api/pipeline-runs/:runId/full-book-worldview",
    async (request, reply) => {
      try {
        return { ok: true, state: "ready", worldview: readCurrentStoryBible(options.database, request.params.runId) };
      } catch (error) {
        if (error instanceof StoryBibleReadError) {
          return reply.code(error.statusCode).send({
            ok: false, code: error.code, state: error.state, message: error.message,
          });
        }
        throw error;
      }
    },
  );
};
