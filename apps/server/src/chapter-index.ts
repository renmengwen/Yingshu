import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { resolve, sep } from "node:path";
import type { DatabaseSync } from "node:sqlite";

import type { BookRecord } from "./book-import.js";

const CHAPTER_HEADING = /^\s*第([0-9０-９一二三四五六七八九十百千万两零〇]+)[章节回卷部篇集]\s*(.*)$/;
// ponytail: 1 MiB 单行上限保证流式内存有界；真实输入证明不足时改为增量标题扫描。
const MAX_LINE_BYTES = 1024 * 1024;

interface IndexOptions {
  book: BookRecord;
  database: DatabaseSync;
  dataRoot: string;
}

interface ChapterRecord {
  id: string;
  book_id: string;
  chapter_index: number;
  chapter_number: string | null;
  title: string;
  byte_start: number;
  byte_end: number;
  char_count: number;
  content_hash: string;
}

async function isValidEncoding(path: string, encoding: string) {
  const decoder = new TextDecoder(encoding, { fatal: true });
  try {
    for await (const chunk of createReadStream(path)) {
      decoder.decode(chunk as Buffer, { stream: true });
    }
    decoder.decode();
    return true;
  } catch {
    return false;
  }
}

async function detectEncoding(path: string) {
  if (await isValidEncoding(path, "utf-8")) {
    const bom = Buffer.alloc(3);
    const file = createReadStream(path, { start: 0, end: 2 });
    let length = 0;
    for await (const chunk of file) length += (chunk as Buffer).copy(bom, length);
    return { encoding: "UTF-8" as const, bomBytes: bom.equals(Buffer.from([0xef, 0xbb, 0xbf])) ? 3 : 0 };
  }
  if (await isValidEncoding(path, "gb18030")) return { encoding: "GB18030" as const, bomBytes: 0 };
  throw new Error("TXT 不是有效的 UTF-8 或 GB18030 编码");
}

export async function indexBookChapters(options: IndexOptions) {
  const root = resolve(options.dataRoot);
  const path = resolve(root, options.book.original_file_path);
  if (!path.startsWith(`${root}${sep}`)) throw new Error("原文路径超出数据目录");

  const detected = await detectEncoding(path);
  const decoder = new TextDecoder(detected.encoding.toLowerCase(), { fatal: true });
  const chapters: ChapterRecord[] = [];
  let pending = Buffer.alloc(0);
  let offset = detected.bomBytes;
  let current:
    | {
        byteStart: number;
        title: string;
        chapterNumber: string | null;
        charCount: number;
        hash: ReturnType<typeof createHash>;
      }
    | undefined;

  function finish(byteEnd: number) {
    if (!current) return;
    const contentHash = current.hash.digest("hex");
    const chapterIndex = chapters.length;
    chapters.push({
      id: `chapter_${createHash("sha256")
        .update(`${options.book.id}\0${chapterIndex}\0${current.byteStart}\0${contentHash}`)
        .digest("hex")}`,
      book_id: options.book.id,
      chapter_index: chapterIndex,
      chapter_number: current.chapterNumber,
      title: current.title,
      byte_start: current.byteStart,
      byte_end: byteEnd,
      char_count: current.charCount,
      content_hash: contentHash,
    });
  }

  function consume(rawLine: Buffer, lineOffset: number) {
    const text = decoder.decode(rawLine);
    const titleLine = text.replace(/[\r\n]+$/, "");
    const heading = CHAPTER_HEADING.exec(titleLine);
    if (heading) {
      finish(lineOffset);
      current = {
        byteStart: lineOffset,
        title: titleLine.trim(),
        chapterNumber: heading[1] ?? null,
        charCount: 0,
        hash: createHash("sha256"),
      };
    } else if (!current) {
      current = {
        byteStart: lineOffset,
        title: "正文",
        chapterNumber: null,
        charCount: 0,
        hash: createHash("sha256"),
      };
    }
    current.hash.update(rawLine);
    for (const _character of text) current.charCount += 1;
  }

  for await (const chunk of createReadStream(path, { start: detected.bomBytes })) {
    const data = pending.length ? Buffer.concat([pending, chunk as Buffer]) : (chunk as Buffer);
    let start = 0;
    for (let newline = data.indexOf(0x0a, start); newline !== -1; newline = data.indexOf(0x0a, start)) {
      const line = data.subarray(start, newline + 1);
      if (line.length > MAX_LINE_BYTES) throw new Error(`TXT 单行不能超过 ${MAX_LINE_BYTES} 字节`);
      consume(line, offset);
      offset += line.length;
      start = newline + 1;
    }
    pending = Buffer.from(data.subarray(start));
    if (pending.length > MAX_LINE_BYTES) throw new Error(`TXT 单行不能超过 ${MAX_LINE_BYTES} 字节`);
  }
  if (pending.length) {
    consume(pending, offset);
    offset += pending.length;
  }
  finish(offset);

  const existing = options.database.prepare(
    `SELECT id, book_id, chapter_index, chapter_number, title,
            byte_start, byte_end, char_count, content_hash
     FROM chapters WHERE book_id = ? ORDER BY chapter_index`,
  ).all(options.book.id) as unknown as ChapterRecord[];
  const unchanged = existing.length === chapters.length && existing.every((saved, index) => {
    const next = chapters[index];
    return next !== undefined &&
      saved.id === next.id &&
      saved.book_id === next.book_id &&
      saved.chapter_index === next.chapter_index &&
      saved.chapter_number === next.chapter_number &&
      saved.title === next.title &&
      saved.byte_start === next.byte_start &&
      saved.byte_end === next.byte_end &&
      saved.char_count === next.char_count &&
      saved.content_hash === next.content_hash;
  });

  options.database.exec("BEGIN IMMEDIATE");
  try {
    if (!unchanged) {
      options.database.prepare("DELETE FROM chapters WHERE book_id = ?").run(options.book.id);
      const insert = options.database.prepare(
        `INSERT INTO chapters (
          id, book_id, chapter_index, chapter_number, title,
          byte_start, byte_end, char_count, content_hash
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const chapter of chapters) {
        insert.run(
          chapter.id,
          chapter.book_id,
          chapter.chapter_index,
          chapter.chapter_number,
          chapter.title,
          chapter.byte_start,
          chapter.byte_end,
          chapter.char_count,
          chapter.content_hash,
        );
      }
    }
    options.database
      .prepare("UPDATE books SET encoding = ?, import_status = 'ready', updated_at = CURRENT_TIMESTAMP WHERE id = ?")
      .run(detected.encoding, options.book.id);
    options.database.exec("COMMIT");
  } catch (error) {
    try {
      options.database.exec("ROLLBACK");
    } catch {
      // 保留原始索引写入错误。
    }
    try {
      options.database
        .prepare("UPDATE books SET import_status = 'failed', updated_at = CURRENT_TIMESTAMP WHERE id = ?")
        .run(options.book.id);
    } catch {
      // 保留原始索引写入错误。
    }
    throw error;
  }

  return { encoding: detected.encoding, chapters };
}
