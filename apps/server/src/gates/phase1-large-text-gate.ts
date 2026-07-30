import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdtemp, open, rm, stat } from "node:fs/promises";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

import { buildApp } from "../app.js";

const FROZEN_SOURCE_URL = "https://www.gutenberg.org/cache/epub/24264/pg24264.txt";
const FROZEN_SOURCE_SHA256 = "ff1526996bf4b81807651921a85e5c1c0f1d1d123c9fa4553057ba6a3ec72011";
const expectedSha256 = (process.env.YINGSHU_LONG_TEXT_SHA256 ?? FROZEN_SOURCE_SHA256).toLowerCase();
const expectedDuplicateNumbers = new Map([
  ["二", 2],
  ["四", 2],
  ["四十五", 2],
]);

async function fileSha256(path: string) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

async function upload(port: number, path: string) {
  const file = await stat(path);
  return new Promise<{ statusCode: number; body: Record<string, any> }>((resolve, reject) => {
    const outgoing = request(
      {
        hostname: "127.0.0.1",
        port,
        path: "/api/books/import",
        method: "POST",
        headers: {
          "content-type": "text/plain",
          "content-length": file.size,
          "x-file-name": encodeURIComponent("红楼梦-Project-Gutenberg-24264.txt"),
        },
      },
      (incoming) => {
        const chunks: Buffer[] = [];
        incoming.once("aborted", () => reject(new Error("上传响应被中断")));
        incoming.once("error", reject);
        incoming.on("data", (chunk: Buffer) => chunks.push(chunk));
        incoming.on("end", () => {
          try {
            resolve({
              statusCode: incoming.statusCode ?? 0,
              body: JSON.parse(Buffer.concat(chunks).toString("utf8")),
            });
          } catch (error) {
            reject(error);
          }
        });
      },
    );
    outgoing.on("error", reject);
    const source = createReadStream(path);
    source.on("error", (error) => {
      outgoing.destroy(error);
      reject(error);
    });
    source.pipe(outgoing);
  });
}

async function start(dataRoot: string) {
  const app = buildApp({ dataRoot, logger: false });
  const address = new URL(await app.listen({ host: "127.0.0.1", port: 0 }));
  return { app, baseUrl: address.origin, port: Number(address.port) };
}

async function getJson(baseUrl: string, path: string) {
  const response = await fetch(`${baseUrl}${path}`);
  assert.equal(response.status, 200, `${path} 应返回 200`);
  return response.json() as Promise<Record<string, any>>;
}

async function rawSlice(path: string, start: number, end: number) {
  const length = end - start;
  const bytes = Buffer.alloc(length);
  const file = await open(path, "r");
  try {
    let offset = 0;
    while (offset < length) {
      const { bytesRead } = await file.read(bytes, offset, length - offset, start + offset);
      assert(bytesRead > 0, "原文切片发生意外 EOF");
      offset += bytesRead;
    }
  } finally {
    await file.close();
  }
  return bytes;
}

let sourcePath = process.env.YINGSHU_LONG_TEXT_PATH;
let downloadRoot: string | undefined;
let dataRoot: string | undefined;
let firstRuntime: Awaited<ReturnType<typeof start>> | undefined;
let restartedRuntime: Awaited<ReturnType<typeof start>> | undefined;
let sampler: ReturnType<typeof setInterval> | undefined;

try {
  if (!sourcePath) {
    downloadRoot = await mkdtemp(join(tmpdir(), "narralume-p1-05-source-"));
    sourcePath = join(downloadRoot, "pg24264.txt");
    const response = await fetch(FROZEN_SOURCE_URL);
    assert(response.ok && response.body, `真实长篇下载失败：HTTP ${response.status}`);
    await pipeline(
      Readable.fromWeb(response.body as import("node:stream/web").ReadableStream),
      createWriteStream(sourcePath, { flush: true }),
    );
  }

  const memoryLimitMiB = Number(process.env.YINGSHU_MEMORY_DELTA_MIB ?? 96);
  assert(Number.isFinite(memoryLimitMiB) && memoryLimitMiB > 0, "YINGSHU_MEMORY_DELTA_MIB 必须是正数");
  const sourceInfo = await stat(sourcePath);
  const sourceHash = await fileSha256(sourcePath);
  assert.equal(sourceHash, expectedSha256, "真实输入 SHA-256 与冻结值不一致");

  dataRoot = await mkdtemp(join(tmpdir(), "narralume-p1-05-data-"));
  firstRuntime = await start(dataRoot);
  const baselineRss = process.memoryUsage().rss;
  let peakRss = baselineRss;
  sampler = setInterval(() => {
    peakRss = Math.max(peakRss, process.memoryUsage().rss);
  }, 5);
  if (process.env.YINGSHU_GATE_FAULT_AFTER_SAMPLER === "1") {
    throw new Error("Phase 1 门禁故障注入：sampler 启动后中止");
  }

  const first = await upload(firstRuntime.port, sourcePath);
  const duplicate = await upload(firstRuntime.port, sourcePath);
  clearInterval(sampler);
  sampler = undefined;
  peakRss = Math.max(peakRss, process.memoryUsage().rss);

  assert.equal(first.statusCode, 201, "首次真实长篇导入应创建书籍");
  assert.equal(duplicate.statusCode, 200, "重复真实长篇导入应幂等命中");
  assert.equal(duplicate.body.book.id, first.body.book.id, "重复导入必须返回同一稳定书籍 ID");
  assert.equal(first.body.chapter_count, 124, "冻结真实长篇应稳定识别 124 个章节范围");

  const memoryDelta = peakRss - baselineRss;
  assert(
    memoryDelta <= memoryLimitMiB * 1024 * 1024,
    `真实长篇导入 RSS 增量 ${Math.ceil(memoryDelta / 1024 / 1024)} MiB 超过 ${memoryLimitMiB} MiB 门限`,
  );

  await firstRuntime.app.close();
  firstRuntime = undefined;
  restartedRuntime = await start(dataRoot);

  const books = await getJson(restartedRuntime.baseUrl, "/api/books");
  const book = books.items.find((item: Record<string, any>) => item.id === first.body.book.id);
  assert(book, "重启后应能查询已导入书籍");
  assert.equal(book.chapter_count, first.body.chapter_count, "重启后章节数必须保持一致");

  const chapters: Record<string, any>[] = [];
  for (let offset = 0; ; offset += 100) {
    const page = await getJson(
      restartedRuntime.baseUrl,
      `/api/books/${encodeURIComponent(book.id)}/chapters?limit=100&offset=${offset}`,
    );
    chapters.push(...page.items);
    if (chapters.length >= page.total) break;
  }
  assert.equal(chapters.length, first.body.chapter_count, "分页必须覆盖全部章节");

  const storedSource = join(dataRoot, book.original_file_path ?? `books/${book.id}/source.txt`);
  assert.equal(await fileSha256(storedSource), sourceHash, "落盘原文哈希必须与输入一致");
  const sampleIndexes = [...new Set([0, Math.floor(chapters.length / 2), chapters.length - 1])];
  const sliceChecks = [];
  for (const index of sampleIndexes) {
    const chapter = chapters[index];
    assert(chapter, `缺少第 ${index + 1} 个章节`);
    const response = await getJson(
      restartedRuntime.baseUrl,
      `/api/books/${encodeURIComponent(book.id)}/chapters/${encodeURIComponent(chapter.id)}/text`,
    );
    const bytes = await rawSlice(storedSource, chapter.byte_start, chapter.byte_end);
    const decoded = new TextDecoder(String(book.encoding).toLowerCase(), { fatal: true }).decode(bytes);
    assert.equal(response.text, decoded, `第 ${index + 1} 个章节必须精确对应原始字节切片`);
    assert.equal(createHash("sha256").update(bytes).digest("hex"), chapter.content_hash);
    sliceChecks.push({ index, id: chapter.id, byte_start: chapter.byte_start, byte_end: chapter.byte_end });
  }

  const numberCounts = new Map<string, number>();
  for (const chapter of chapters) {
    if (chapter.chapter_number) numberCounts.set(chapter.chapter_number, (numberCounts.get(chapter.chapter_number) ?? 0) + 1);
  }
  const duplicateNumbers = [...numberCounts.entries()].filter(([, count]) => count > 1);
  for (const [chapterNumber, expectedCount] of expectedDuplicateNumbers) {
    const matches = chapters.filter((chapter) => chapter.chapter_number === chapterNumber);
    assert.equal(matches.length, expectedCount, `重复章节编号 ${chapterNumber} 必须保留 ${expectedCount} 个范围`);
    assert.equal(new Set(matches.map((chapter) => chapter.id)).size, expectedCount, `重复章节编号 ${chapterNumber} 必须具有不同稳定 ID`);
    assert.equal(new Set(matches.map((chapter) => chapter.chapter_index)).size, expectedCount, `重复章节编号 ${chapterNumber} 不得覆盖顺序索引`);
  }
  assert.deepEqual(new Map(duplicateNumbers), expectedDuplicateNumbers, "冻结来源的重复章节编号集合必须稳定");

  process.stdout.write(`${JSON.stringify({
    ok: true,
    source: {
      title: "红楼梦",
      provider: "Project Gutenberg",
      ebook: 24264,
      url: FROZEN_SOURCE_URL,
      bytes: sourceInfo.size,
      sha256: sourceHash,
    },
    book_id: book.id,
    encoding: book.encoding,
    chapter_count: chapters.length,
    duplicate_import_status: duplicate.statusCode,
    restart_query: true,
    pagination_complete: true,
    slice_checks: sliceChecks,
    duplicate_chapter_numbers_in_source: duplicateNumbers,
    memory: {
      baseline_rss: baselineRss,
      peak_rss: peakRss,
      delta_bytes: memoryDelta,
      limit_mib: memoryLimitMiB,
    },
  }, null, 2)}\n`);
} finally {
  if (sampler) clearInterval(sampler);
  await firstRuntime?.app.close();
  await restartedRuntime?.app.close();
  if (dataRoot) await rm(dataRoot, { recursive: true, force: true });
  if (downloadRoot) await rm(downloadRoot, { recursive: true, force: true });
}
