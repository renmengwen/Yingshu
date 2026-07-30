import { randomUUID } from "node:crypto";
import { mkdir, open, rename, rm, stat } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";

import { probeNineSixteenVideo, runVideoProcess } from "./ffmpeg-video.js";
import { JobCancelledError } from "./job-worker.js";

const MOTIONS = ["none", "pan-left", "pan-right", "zoom-in", "zoom-out"] as const;
export type NineSixteenMotionKind = typeof MOTIONS[number];

export interface NineSixteenScene {
  imagePath: string;
  durationMs: number;
  motionKind: NineSixteenMotionKind;
  motionAmountPpm: number;
  fadeMs: number;
}

export interface NineSixteenRenderInput {
  scenes: NineSixteenScene[];
  audioPath: string;
  assPath: string;
  outputPath: string;
  signal?: AbortSignal;
}

function safeInteger(value: unknown, label: string, minimum: number, maximum = Number.MAX_SAFE_INTEGER) {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw new Error(`${label}无效`);
  }
  return value as number;
}

async function ordinaryFile(path: string, label: string) {
  if (!(await stat(path)).isFile()) throw new Error(`${label}不是普通文件`);
}

function absolutePath(path: unknown, label: string) {
  if (typeof path !== "string" || !path) throw new Error(`${label}路径无效`);
  return resolve(path);
}

async function syncFile(path: string) {
  const file = await open(path, "r+");
  try { await file.sync(); } finally { await file.close(); }
}

function sceneFilter(scene: NineSixteenScene, index: number) {
  const seconds = (scene.durationMs / 1_000).toFixed(3);
  const frames = Math.max(1, Math.ceil(scene.durationMs * 25 / 1_000));
  const progress = frames === 1 ? "0" : `on/${frames - 1}`;
  const amount = (scene.motionAmountPpm / 1_000_000).toFixed(6);
  let zoom = "1";
  let x = "0";
  let y = "0";
  if (scene.motionKind === "pan-left" || scene.motionKind === "pan-right") {
    zoom = `1+${amount}`;
    const travel = scene.motionKind === "pan-left" ? progress : `1-${progress}`;
    x = `(iw-iw/zoom)*(${travel})`;
    y = "ih/2-ih/zoom/2";
  } else if (scene.motionKind === "zoom-in" || scene.motionKind === "zoom-out") {
    const travel = scene.motionKind === "zoom-in" ? progress : `1-${progress}`;
    zoom = `1+${amount}*(${travel})`;
    x = "iw/2-iw/zoom/2";
    y = "ih/2-ih/zoom/2";
  }
  const fades = scene.fadeMs === 0 ? "" :
    `,fade=t=in:st=0:d=${(scene.fadeMs / 1_000).toFixed(3)}` +
    `,fade=t=out:st=${((scene.durationMs - scene.fadeMs) / 1_000).toFixed(3)}:d=${(scene.fadeMs / 1_000).toFixed(3)}`;
  return `[${index}:v]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,` +
    `zoompan=z='${zoom}':x='${x}':y='${y}':d=1:s=1080x1920:fps=25,` +
    `trim=duration=${seconds},setpts=PTS-STARTPTS${fades}[scene${index}]`;
}

export function buildNineSixteenFfmpegArgs(input: NineSixteenRenderInput, renderedOutputPath = input.outputPath) {
  const inputs = input.scenes.flatMap((scene) => [
    "-loop", "1", "-framerate", "25", "-t", (scene.durationMs / 1_000).toFixed(3), "-i", resolve(scene.imagePath),
  ]);
  const filters = input.scenes.map(sceneFilter);
  const sceneLabels = input.scenes.map((_, index) => `[scene${index}]`).join("");
  filters.push(`${sceneLabels}concat=n=${input.scenes.length}:v=1:a=0[visual]`);
  filters.push(`[visual]ass=${basename(input.assPath)}[subtitled]`);
  return [
    "-v", "error", "-y", ...inputs, "-i", resolve(input.audioPath),
    "-filter_complex", filters.join(";"),
    "-map", "[subtitled]", "-map", `${input.scenes.length}:a:0`,
    "-c:v", "libx264", "-pix_fmt", "yuv420p", "-color_range", "tv", "-r", "25",
    "-c:a", "aac", "-shortest", "-movflags", "+faststart", renderedOutputPath,
  ];
}

export async function renderNineSixteenTemplate(
  input: NineSixteenRenderInput,
  dependencies: {
    run?: typeof runVideoProcess;
    probe?: typeof probeNineSixteenVideo;
    sync?: typeof syncFile;
    rename?: typeof rename;
  } = {},
) {
  if (!Array.isArray(input.scenes) || input.scenes.length === 0) throw new Error("画面场景不能为空");
  const normalized: NineSixteenRenderInput = {
    ...input,
    scenes: input.scenes.map((scene, index) => ({
      ...scene,
      imagePath: absolutePath(scene?.imagePath, `第 ${index + 1} 个场景图片`),
    })),
    audioPath: absolutePath(input.audioPath, "音频输入"),
    assPath: absolutePath(input.assPath, "ASS 字幕输入"),
  };
  for (const [index, scene] of normalized.scenes.entries()) {
    if (!scene || typeof scene !== "object") throw new Error(`第 ${index + 1} 个场景无效`);
    safeInteger(scene.durationMs, "场景时长", 1);
    if (!MOTIONS.includes(scene.motionKind)) throw new Error("运镜类型无效");
    const amount = safeInteger(scene.motionAmountPpm, "运镜幅度", 0, 1_000_000);
    if (scene.motionKind === "none" && amount !== 0) throw new Error("静态画面不能设置运镜幅度");
    const fadeMs = safeInteger(scene.fadeMs, "淡入淡出时长", 0, 10_000);
    if (fadeMs * 2 > scene.durationMs) throw new Error("淡入淡出时长超过场景时长");
    await ordinaryFile(scene.imagePath, "场景图片");
  }
  await ordinaryFile(normalized.audioPath, "音频输入");
  await ordinaryFile(normalized.assPath, "ASS 字幕输入");
  if (!/^[A-Za-z0-9._-]+$/u.test(basename(normalized.assPath))) throw new Error("ASS 字幕文件名无法安全传给 ffmpeg");
  if (typeof input.outputPath !== "string" || !input.outputPath) throw new Error("输出路径无效");

  const outputPath = resolve(input.outputPath);
  if ([...normalized.scenes.map((scene) => scene.imagePath), normalized.audioPath, normalized.assPath]
      .includes(outputPath)) throw new Error("输出路径不能覆盖输入文件");
  const temporaryPath = resolve(dirname(outputPath), `${basename(outputPath)}.${randomUUID()}.tmp.mp4`);
  await mkdir(dirname(outputPath), { recursive: true });
  try {
    await (dependencies.run ?? runVideoProcess)(
      "ffmpeg",
      buildNineSixteenFfmpegArgs(normalized, temporaryPath),
      { cwd: dirname(normalized.assPath), signal: input.signal },
    );
    if (input.signal?.aborted) throw new JobCancelledError();
    const rendered = await (dependencies.probe ?? probeNineSixteenVideo)(temporaryPath, input.signal);
    if (input.signal?.aborted) throw new JobCancelledError();
    const expectedDurationMs = normalized.scenes.reduce((total, scene) => total + scene.durationMs, 0);
    if (Math.abs(rendered.durationMs - expectedDurationMs) > 1_000) throw new Error("视频时长与场景时间轴不一致");
    await (dependencies.sync ?? syncFile)(temporaryPath);
    if (input.signal?.aborted) throw new JobCancelledError();
    await (dependencies.rename ?? rename)(temporaryPath, outputPath);
  } finally {
    await rm(temporaryPath, { force: true });
  }
}
