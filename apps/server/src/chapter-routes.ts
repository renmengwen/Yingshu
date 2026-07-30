import type { FastifyInstance } from "fastify";
import type { DatabaseSync } from "node:sqlite";

import { BookLibraryError, deleteChapter } from "./book-library.js";

export async function registerChapterRoutes(app: FastifyInstance, options: { database: DatabaseSync }) {
  app.delete<{ Params: { bookId: string; chapterId: string } }>(
    "/api/books/:bookId/chapters/:chapterId",
    async (request, reply) => {
      try {
        const chapter = deleteChapter(options.database, request.params.bookId, request.params.chapterId);
        return { ok: true, message: `章节“${chapter.title}”已从本地索引删除`, chapter };
      } catch (error) {
        if (error instanceof BookLibraryError) {
          return reply.code(error.statusCode).send({ ok: false, message: error.message });
        }
        throw error;
      }
    },
  );
}
