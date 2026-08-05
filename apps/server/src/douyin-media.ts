import { createHash, randomUUID } from "node:crypto";
import { constants, createWriteStream } from "node:fs";
import { lstat, mkdir, open, realpath, rename, rm } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";

import { runVideoProcess } from "./ffmpeg-video.js";

const DEFAULT_MAX_VIDEO_BYTES = 512 * 1024 * 1024;
const HASH = /^[0-9a-f]{64}$/u;

export interface VerifiedDouyinMediaUrl {
  url: string;
  source: "douyin-detail";
}

export interface MediaFileIdentity {
  relativePath: string;
  bytes: number;
  sha256: string;
  mime: string;
}

export interface DouyinVideoProbe {
  durationMs: number;
  width: number;
  height: number;
  codec: string;
  frameRate: string | null;
  audioTracks: Array<{ codec: string; durationMs: number | null }>;
}

export interface DouyinFrameResult {
  index: number;
  timestampMs: number;
  status: "succeeded" | "failed";
  attempts: 1 | 2;
  relativePath?: string;
  width?: number;
  height?: number;
  bytes?: number;
  sha256?: string;
  error?: string;
}

export interface DouyinFramesResult {
  status: "succeeded" | "partial" | "failed";
  planned: number;
  succeeded: number;
  failed: number;
  frames: DouyinFrameResult[];
}

type ProcessRunner = typeof runVideoProcess;

export function douyinMediaSteps(config: { extractFrames: boolean; transcribeAudio: boolean }) {
  return {
    downloadVideo: config.extractFrames || config.transcribeAudio,
    probeVideo: config.extractFrames || config.transcribeAudio,
    extractFrames: config.extractFrames,
    extractAudio: config.transcribeAudio,
  };
}

export function planDouyinFrameTimestamps(durationMs: number, frameCount: number) {
  if (!Number.isSafeInteger(durationMs) || durationMs <= 0) throw new Error("视频时长无效");
  if (!Number.isInteger(frameCount) || frameCount < 6 || frameCount > 30) throw new Error("抽帧数量必须是 6～30 的整数");
  const points: number[] = [];
  const appendMidpoints = (startMs: number, spanMs: number, count: number) => {
    for (let index = 0; index < count; index += 1) {
      points.push(Math.floor(startMs + spanMs * (index + 0.5) / count));
    }
  };
  if (durationMs <= 15_000) {
    appendMidpoints(0, durationMs, frameCount);
  } else {
    const openingCount = Math.min(4, Math.floor(frameCount / 3));
    appendMidpoints(0, 15_000, openingCount);
    appendMidpoints(15_000, durationMs - 15_000, frameCount - openingCount);
  }
  if (points.length !== frameCount) throw new Error("抽帧计划数量无效");
  return points;
}

function inside(root: string, path: string) {
  const value = relative(root, path);
  return value !== "" && value !== ".." && !value.startsWith(`..${sep}`) && !isAbsolute(value);
}

function controlledRelativePath(value: string) {
  if (!value || value.startsWith("/") || value.includes("\\") || value.split("/").some((part) => !part || part === "." || part === "..")) {
    throw new Error("媒体相对路径无效");
  }
  return value;
}

async function controlledTarget(dataRoot: string, relativePath: string) {
  const root = resolve(dataRoot);
  await mkdir(root, { recursive: true });
  const rootReal = await realpath(root);
  const target = resolve(rootReal, ...controlledRelativePath(relativePath).split("/"));
  if (!inside(rootReal, target)) throw new Error("媒体路径越界");
  await mkdir(dirname(target), { recursive: true });
  if (!inside(rootReal, await realpath(dirname(target)))) throw new Error("媒体目录越界");
  return { root: rootReal, path: target };
}

async function openedControlledFile(dataRoot: string, relativePath: string) {
  const root = await realpath(resolve(dataRoot));
  const path = resolve(root, ...controlledRelativePath(relativePath).split("/"));
  const [actual, before] = await Promise.all([realpath(path), lstat(path)]);
  if (!inside(root, actual) || !before.isFile() || before.isSymbolicLink() || before.nlink !== 1) {
    throw new Error("媒体文件必须是受控目录内的普通独占文件");
  }
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  const after = await handle.stat();
  if (!after.isFile() || after.dev !== before.dev || after.ino !== before.ino || after.nlink !== 1) {
    await handle.close();
    throw new Error("媒体文件在打开期间发生变化");
  }
  return { handle, path, bytes: after.size };
}

function mp4Magic(bytes: Buffer) {
  return bytes.length >= 12 && bytes.toString("ascii", 4, 8) === "ftyp";
}

function jpegSize(bytes: Buffer) {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
  let offset = 2;
  while (offset + 3 < bytes.length) {
    if (bytes[offset] !== 0xff) { offset += 1; continue; }
    const marker = bytes[offset + 1]!;
    if (marker === 0xd8 || marker === 0xd9) { offset += 2; continue; }
    const length = bytes.readUInt16BE(offset + 2);
    if (length < 2 || offset + 2 + length > bytes.length) return null;
    if ((marker >= 0xc0 && marker <= 0xc3) || (marker >= 0xc5 && marker <= 0xc7) ||
        (marker >= 0xc9 && marker <= 0xcb) || (marker >= 0xcd && marker <= 0xcf)) {
      if (length < 7) return null;
      return { height: bytes.readUInt16BE(offset + 5), width: bytes.readUInt16BE(offset + 7) };
    }
    offset += 2 + length;
  }
  return null;
}

export async function verifyDouyinMediaFile(
  dataRoot: string,
  relativePath: string,
  expected: { mime: "video/mp4" | "image/jpeg"; bytes?: number; sha256?: string },
): Promise<MediaFileIdentity & { width?: number; height?: number }> {
  if (expected.sha256 !== undefined && !HASH.test(expected.sha256)) throw new Error("媒体 Hash 格式无效");
  const opened = await openedControlledFile(dataRoot, relativePath);
  try {
    if (opened.bytes < 1 || expected.bytes !== undefined && opened.bytes !== expected.bytes) throw new Error("媒体字节数不一致");
    const hash = createHash("sha256");
    const chunks: Buffer[] = [];
    const buffer = Buffer.allocUnsafe(256 * 1024);
    let offset = 0;
    while (offset < opened.bytes) {
      const result = await opened.handle.read(buffer, 0, Math.min(buffer.length, opened.bytes - offset), offset);
      if (!result.bytesRead) break;
      const chunk = Buffer.from(buffer.subarray(0, result.bytesRead));
      if (offset < 1024 * 1024) chunks.push(chunk);
      hash.update(chunk);
      offset += result.bytesRead;
    }
    if (offset !== opened.bytes) throw new Error("媒体文件读取不完整");
    const sha256 = hash.digest("hex");
    if (expected.sha256 !== undefined && sha256 !== expected.sha256) throw new Error("媒体 Hash 不一致");
    const header = Buffer.concat(chunks).subarray(0, 1024 * 1024);
    if (expected.mime === "video/mp4" && !mp4Magic(header)) throw new Error("视频 magic bytes 无效");
    const dimensions = expected.mime === "image/jpeg" ? jpegSize(header) : undefined;
    if (expected.mime === "image/jpeg" && (!dimensions || dimensions.width < 1 || dimensions.height < 1)) {
      throw new Error("图片 magic bytes 或尺寸无效");
    }
    return { relativePath, bytes: opened.bytes, sha256, mime: expected.mime, ...dimensions };
  } finally {
    await opened.handle.close();
  }
}

export async function downloadDouyinVideo(options: {
  source: VerifiedDouyinMediaUrl;
  dataRoot: string;
  relativePath: string;
  maxBytes?: number;
  signal?: AbortSignal;
  fetch?: typeof fetch;
}) {
  if (options.source.source !== "douyin-detail") throw new Error("视频下载地址未经过抖音详情验证");
  const url = new URL(options.source.url);
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error("视频下载协议不受支持");
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_VIDEO_BYTES;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new Error("视频下载字节上限无效");
  const target = await controlledTarget(options.dataRoot, options.relativePath);
  const temporary = `${target.path}.${randomUUID()}.tmp`;
  try {
    const response = await (options.fetch ?? fetch)(url, { redirect: "error", signal: options.signal });
    if (!response.ok || !response.body) throw new Error(`视频下载失败：HTTP ${response.status}`);
    const declared = Number(response.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > maxBytes) throw new Error("视频下载超过字节上限");
    let bytes = 0;
    await pipeline(
      Readable.fromWeb(response.body as never),
      new Transform({
        transform(chunk: Buffer, _encoding, callback) {
          const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          bytes += value.length;
          callback(bytes > maxBytes ? new Error("视频下载超过字节上限") : null, value);
        },
      }),
      createWriteStream(temporary, { flags: "wx", flush: true }),
      { signal: options.signal },
    );
    if (bytes < 1) throw new Error("视频下载内容为空");
    const downloadedRelative = relative(target.root, temporary).split(sep).join("/");
    await verifyDouyinMediaFile(options.dataRoot, downloadedRelative, { mime: "video/mp4", bytes });
    await rename(temporary, target.path);
    return verifyDouyinMediaFile(options.dataRoot, options.relativePath, { mime: "video/mp4", bytes });
  } finally {
    await rm(temporary, { force: true });
  }
}

export async function probeDouyinVideo(
  dataRoot: string,
  relativePath: string,
  signal?: AbortSignal,
  run: ProcessRunner = runVideoProcess,
): Promise<DouyinVideoProbe> {
  const opened = await openedControlledFile(dataRoot, relativePath);
  await opened.handle.close();
  const stdout = await run("ffprobe", [
    "-v", "error", "-show_entries",
    "stream=codec_type,codec_name,width,height,r_frame_rate,duration:format=duration", "-of", "json", opened.path,
  ], { signal });
  let parsed: {
    streams?: Array<{ codec_type?: string; codec_name?: string; width?: number; height?: number; r_frame_rate?: string; duration?: string }>;
    format?: { duration?: string };
  };
  try { parsed = JSON.parse(stdout) as typeof parsed; } catch { throw new Error("ffprobe 返回了无效 JSON"); }
  const video = parsed.streams?.find((stream) => stream.codec_type === "video");
  const durationMs = Math.round(Number(parsed.format?.duration ?? video?.duration) * 1_000);
  if (!video || !video.codec_name || !Number.isInteger(video.width) || video.width! < 1 || !Number.isInteger(video.height) || video.height! < 1 ||
      !Number.isSafeInteger(durationMs) || durationMs <= 0) throw new Error("ffprobe 未返回有效视频流或真实时长");
  const audioTracks = (parsed.streams ?? []).filter((stream) => stream.codec_type === "audio" && stream.codec_name).map((stream) => {
    const value = Number(stream.duration);
    return { codec: stream.codec_name!, durationMs: Number.isFinite(value) && value > 0 ? Math.round(value * 1_000) : null };
  });
  return { durationMs, width: video.width!, height: video.height!, codec: video.codec_name,
    frameRate: video.r_frame_rate?.trim() || null, audioTracks };
}

export async function extractDouyinFrames(options: {
  dataRoot: string;
  videoRelativePath: string;
  framesRelativeDirectory: string;
  durationMs: number;
  frameCount: number;
  signal?: AbortSignal;
  run?: ProcessRunner;
}): Promise<DouyinFramesResult> {
  const timestamps = planDouyinFrameTimestamps(options.durationMs, options.frameCount);
  const input = await openedControlledFile(options.dataRoot, options.videoRelativePath);
  await input.handle.close();
  const directory = controlledRelativePath(options.framesRelativeDirectory).replace(/\/$/u, "");
  await controlledTarget(options.dataRoot, `${directory}/placeholder`).then(({ path }) => rm(path, { force: true }));
  const run = options.run ?? runVideoProcess;
  const frames: DouyinFrameResult[] = [];
  const seenTimestamps = new Set<number>();
  for (let index = 0; index < timestamps.length; index += 1) {
    const timestampMs = timestamps[index]!;
    if (seenTimestamps.has(timestampMs)) {
      frames.push({ index, timestampMs, status: "failed", attempts: 1, error: "抽帧时间戳碰撞" });
      continue;
    }
    seenTimestamps.add(timestampMs);
    const relativePath = `${directory}/frame-${String(index + 1).padStart(4, "0")}.jpg`;
    const target = await controlledTarget(options.dataRoot, relativePath);
    let succeeded: DouyinFrameResult | undefined;
    for (let attempt = 1 as 1 | 2; attempt <= 2; attempt += 1) {
      const temporary = `${target.path}.${randomUUID()}.tmp.jpg`;
      try {
        await run("ffmpeg", ["-v", "error", "-y", "-i", input.path, "-ss", (timestampMs / 1_000).toFixed(3),
          "-map", "0:v:0", "-frames:v", "1", "-q:v", "3", "-f", "image2", temporary], { signal: options.signal });
        const temporaryRelative = relative(target.root, temporary).split(sep).join("/");
        const identity = await verifyDouyinMediaFile(options.dataRoot, temporaryRelative, { mime: "image/jpeg" });
        await rename(temporary, target.path);
        succeeded = { index, timestampMs, status: "succeeded", attempts: attempt, relativePath,
          width: identity.width, height: identity.height, bytes: identity.bytes, sha256: identity.sha256 };
        break;
      } catch (error) {
        await rm(temporary, { force: true });
        if (options.signal?.aborted) throw error;
      }
    }
    frames.push(succeeded ?? { index, timestampMs, status: "failed", attempts: 2, error: "同一时间点重试后仍无法抽帧" });
  }
  const succeeded = frames.filter((frame) => frame.status === "succeeded").length;
  const failed = frames.length - succeeded;
  return { status: failed === 0 ? "succeeded" : succeeded === 0 ? "failed" : "partial",
    planned: timestamps.length, succeeded, failed, frames };
}
