import { createHash, randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, rename, rm, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import { Transform, type Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { DatabaseSync } from "node:sqlite";

import { withDataFileMutationLock } from "./data-file-mutation-lock.js";

const DEFAULT_MAX_BYTES = 512 * 1024 * 1024;

export class BookImportError extends Error {
  constructor(
    readonly statusCode: number,
    message: string,
  ) {
    super(message);
  }
}

export interface BookRecord {
  id: string;
  title: string;
  author: string | null;
  original_file_path: string;
  original_file_hash: string;
  encoding: string;
  import_status: string;
}

interface ImportBookTextOptions {
  stream: Readable;
  fileName: string;
  title?: string;
  author?: string;
  database: DatabaseSync;
  dataRoot: string;
  maxBytes?: number;
}

function displayTitle(title: string | undefined, fileName: string) {
  const safeFileName = basename(fileName.replaceAll("\\", "/"))
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .replace(/\.txt$/i, "")
    .trim();
  return title?.trim().slice(0, 200) || safeFileName.slice(0, 200) || "未命名书籍";
}

function findBookByHash(database: DatabaseSync, hash: string) {
  return database
    .prepare(
      `SELECT id, title, author, original_file_path, original_file_hash, encoding, import_status
       FROM books WHERE original_file_hash = ?`,
    )
    .get(hash) as BookRecord | undefined;
}

export async function importBookText(options: ImportBookTextOptions) {
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const stagingRoot = join(options.dataRoot, ".imports");
  const stagingDirectory = join(stagingRoot, randomUUID());
  const stagingFile = join(stagingDirectory, "source.txt");
  const hash = createHash("sha256");
  let bytes = 0;
  let stagingOwned = true;
  let bookDirectoryOwned = false;
  let bookDirectory = "";

  await mkdir(stagingDirectory, { recursive: true });
  try {
    await pipeline(
      options.stream,
      new Transform({
        transform(chunk: Buffer, _encoding, callback) {
          const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          bytes += buffer.length;
          if (bytes > maxBytes) {
            callback(new BookImportError(413, `TXT 文件不能超过 ${maxBytes} 字节`));
            return;
          }
          hash.update(buffer);
          callback(null, buffer);
        },
      }),
      createWriteStream(stagingFile, { flags: "wx", flush: true }),
    );
    if (bytes === 0) throw new BookImportError(400, "TXT 文件不能为空");

    const contentHash = hash.digest("hex");
    return await withDataFileMutationLock(options.dataRoot, async () => {
      const existing = findBookByHash(options.database, contentHash);
      if (existing) return { book: existing, created: false, bytes };

      const id = `book_${contentHash}`;
      const booksRoot = join(options.dataRoot, "books");
      bookDirectory = join(booksRoot, id);
      await mkdir(booksRoot, { recursive: true });

      try {
        await rename(stagingDirectory, bookDirectory);
        stagingOwned = false;
        bookDirectoryOwned = true;
      } catch (error) {
        const alreadyClaimed = await stat(bookDirectory)
          .then((entry) => entry.isDirectory())
          .catch(() => false);
        if (!alreadyClaimed) throw error;
      }

      const book: BookRecord = {
        id,
        title: displayTitle(options.title, options.fileName),
        author: options.author?.trim() || null,
        original_file_path: `books/${id}/source.txt`,
        original_file_hash: contentHash,
        encoding: "pending",
        import_status: "importing",
      };

      try {
        options.database
          .prepare(
            `INSERT INTO books (
              id, title, author, original_file_path, original_file_hash, encoding, import_status
            ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            book.id,
            book.title,
            book.author,
            book.original_file_path,
            book.original_file_hash,
            book.encoding,
            book.import_status,
          );
        bookDirectoryOwned = false;
        return { book, created: true, bytes };
      } catch (error) {
        const concurrent = findBookByHash(options.database, contentHash);
        if (concurrent) {
          bookDirectoryOwned = false;
          return { book: concurrent, created: false, bytes };
        }
        throw error;
      }
    });
  } catch (error) {
    if (bookDirectoryOwned) await rm(bookDirectory, { recursive: true, force: true });
    throw error;
  } finally {
    if (stagingOwned) await rm(stagingDirectory, { recursive: true, force: true });
  }
}
