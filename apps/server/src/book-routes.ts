import type { FastifyInstance } from "fastify";
import type { DatabaseSync } from "node:sqlite";

import { BookLibraryError, deleteBook } from "./book-library.js";
import {
  EMPTY_BOOK_PROMPT_PROFILE,
  getBookPromptProfile,
  saveBookPromptProfile,
  type BookPromptProfileContent,
} from "./book-prompt-profile-store.js";
import {
  PRODUCT_PROMPTS,
  PRODUCT_PROMPT_SET_VERSION,
  PRODUCT_PROMPT_TITLES,
  PRODUCT_PROMPT_VERSIONS,
} from "./product-prompts.js";

export async function registerBookRoutes(
  app: FastifyInstance,
  options: { database: DatabaseSync; dataRoot: string },
) {
  app.get("/api/product-prompts", async () => ({
    ok: true, setVersion: PRODUCT_PROMPT_SET_VERSION, titles: PRODUCT_PROMPT_TITLES,
    versions: PRODUCT_PROMPT_VERSIONS, prompts: PRODUCT_PROMPTS,
  }));

  app.get<{ Params: { bookId: string } }>("/api/books/:bookId/prompt-profile", async (request, reply) => {
    if (!options.database.prepare("SELECT 1 FROM books WHERE id = ?").get(request.params.bookId)) {
      return reply.code(404).send({ ok: false, message: "书籍不存在" });
    }
    return { ok: true, profile: getBookPromptProfile(options.database, request.params.bookId) ?? {
      bookId: request.params.bookId, revision: 0, profileHash: null, createdAt: null, ...EMPTY_BOOK_PROMPT_PROFILE,
    } };
  });

  app.put<{ Params: { bookId: string }; Body: BookPromptProfileContent }>(
    "/api/books/:bookId/prompt-profile",
    async (request, reply) => {
      try {
        const profile = saveBookPromptProfile(options.database, request.params.bookId, request.body);
        return { ok: true, message: "本书专属提示词已保存；只影响之后新建的任务", profile };
      } catch (error) {
        const message = error instanceof Error ? error.message : "本书专属提示词保存失败";
        return reply.code(message === "书籍不存在" ? 404 : 400).send({ ok: false, message });
      }
    },
  );

  app.delete<{ Params: { bookId: string } }>("/api/books/:bookId", async (request, reply) => {
    try {
      const book = await deleteBook(options.database, options.dataRoot, request.params.bookId);
      return reply.code(book.fileCleanupComplete ? 200 : 202).send({
        ok: true,
        message: book.fileCleanupComplete
          ? `小说“${book.title}”及其全部项目数据已删除`
          : `小说“${book.title}”的项目数据已删除；部分本地文件将在服务重启时继续清理`,
        book,
      });
    } catch (error) {
      if (error instanceof BookLibraryError) {
        return reply.code(error.statusCode).send({ ok: false, message: error.message });
      }
      throw error;
    }
  });
}
