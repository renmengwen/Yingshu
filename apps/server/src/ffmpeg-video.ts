import { spawn } from "node:child_process";
import { stat } from "node:fs/promises";

import { JobCancelledError } from "./job-worker.js";

const MAX_PROCESS_OUTPUT = 64 * 1024;

export interface VideoProbe {
  bytes: number;
  durationMs: number;
}

export async function runVideoProcess(
  command: string,
  args: string[],
  options: { cwd?: string; signal?: AbortSignal } = {},
) {
  if (options.signal?.aborted) throw new JobCancelledError();
  const child = spawn(command, args, { cwd: options.cwd, windowsHide: true, shell: false });
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  let stdoutBytes = 0;
  let stderrBytes = 0;
  let overflow = false;
  let childError: unknown;
  child.stdout.on("data", (chunk: Buffer) => {
    if (overflow) return;
    stdoutBytes += chunk.length;
    if (stdoutBytes > MAX_PROCESS_OUTPUT) { overflow = true; child.kill(); return; }
    stdout.push(chunk);
  });
  child.stderr.on("data", (chunk: Buffer) => {
    if (overflow) return;
    stderrBytes += chunk.length;
    if (stderrBytes > MAX_PROCESS_OUTPUT) { overflow = true; child.kill(); return; }
    stderr.push(chunk);
  });
  child.once("error", (error) => { childError = error; });
  const poll = setInterval(() => { if (options.signal?.aborted) child.kill(); }, 50);
  const code = await new Promise<number | null>((resolve) => child.once("close", resolve));
  clearInterval(poll);
  if (options.signal?.aborted) throw new JobCancelledError();
  if (childError) throw childError;
  if (overflow) throw new Error(`${command} 输出超过 64 KiB 限制`);
  const stderrText = Buffer.concat(stderr).toString("utf8").trim();
  if (code !== 0) throw new Error(`${command} 执行失败${stderrText ? `：${stderrText}` : ""}`);
  return Buffer.concat(stdout).toString("utf8");
}

export async function probeNineSixteenVideo(
  path: string,
  signal?: AbortSignal,
  run: typeof runVideoProcess = runVideoProcess,
): Promise<VideoProbe> {
  const info = await stat(path);
  const stdout = await run("ffprobe", [
    "-v", "error",
    "-show_entries", "stream=codec_type,codec_name,width,height,pix_fmt,r_frame_rate:format=duration,size",
    "-of", "json",
    path,
  ], { signal });
  let parsed: {
    streams?: Array<{
      codec_type?: string;
      codec_name?: string;
      width?: number;
      height?: number;
      pix_fmt?: string;
      r_frame_rate?: string;
    }>;
    format?: { duration?: string; size?: string };
  };
  try { parsed = JSON.parse(stdout) as typeof parsed; } catch { throw new Error("ffprobe 返回了无效 JSON"); }
  const video = parsed.streams?.filter((stream) => stream.codec_type === "video") ?? [];
  const audio = parsed.streams?.filter((stream) => stream.codec_type === "audio") ?? [];
  const durationMs = Math.floor(Number(parsed.format?.duration) * 1_000);
  const stream = video[0];
  const audioStream = audio[0];
  if (video.length !== 1 || audio.length !== 1 || !stream || !audioStream ||
      stream.codec_name !== "h264" || stream.pix_fmt !== "yuv420p" || audioStream.codec_name !== "aac" ||
      stream.width !== 1080 || stream.height !== 1920 || stream.r_frame_rate !== "25/1" ||
      !Number.isSafeInteger(durationMs) || durationMs < 1 || Number(parsed.format?.size) !== info.size || info.size < 1) {
    throw new Error("视频流、尺寸、帧率、大小或时长无效");
  }
  return { bytes: info.size, durationMs };
}
