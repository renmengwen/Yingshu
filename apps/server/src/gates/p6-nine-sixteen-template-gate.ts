import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { probeNineSixteenVideo } from "../ffmpeg-video.js";
import { renderNineSixteenTemplate, type NineSixteenScene } from "../nine-sixteen-template.js";

const dataRoot = fileURLToPath(new URL("../../../../data/gates/p6-template", import.meta.url));
if (!/[\\/]data[\\/]gates[\\/]p6-template$/.test(dataRoot)) throw new Error("P6-01 门禁数据目录越界");

async function run(command: string, args: string[], maxBytes = 64 * 1024) {
  const child = spawn(command, args, { windowsHide: true, shell: false });
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  let stdoutBytes = 0;
  let stderrBytes = 0;
  child.stdout.on("data", (chunk: Buffer) => { stdoutBytes += chunk.length; if (stdoutBytes <= maxBytes) stdout.push(chunk); });
  child.stderr.on("data", (chunk: Buffer) => { stderrBytes += chunk.length; if (stderrBytes <= maxBytes) stderr.push(chunk); });
  const code = await new Promise<number | null>((done, reject) => {
    child.once("error", reject);
    child.once("close", done);
  });
  if (stdoutBytes > maxBytes || stderrBytes > maxBytes) throw new Error(`${command} 输出超过门禁限制`);
  if (code !== 0) throw new Error(`${command} 执行失败：${Buffer.concat(stderr).toString("utf8").trim()}`);
  return Buffer.concat(stdout);
}

async function frame(path: string, seconds: number) {
  return run("ffmpeg", [
    "-v", "error", "-i", path, "-ss", seconds.toFixed(3),
    "-frames:v", "1", "-vf", "scale=180:320:flags=area", "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1",
  ], 180 * 320 * 3 + 1_024);
}

function brightness(pixels: Buffer) {
  let total = 0;
  for (const byte of pixels) total += byte;
  return total / pixels.length;
}

function meanAbsoluteDifference(left: Buffer, right: Buffer) {
  assert.equal(left.length, right.length);
  let total = 0;
  for (let index = 0; index < left.length; index += 1) total += Math.abs(left[index]! - right[index]!);
  return total / left.length;
}

function assertNoBlackBorder(pixels: Buffer) {
  const width = 180;
  const height = 320;
  const at = (x: number, y: number) => (y * width + x) * 3;
  for (let y = 0; y < height; y += 1) {
    for (const x of [0, width - 1]) {
      const offset = at(x, y);
      assert.ok(pixels[offset]! + pixels[offset + 1]! + pixels[offset + 2]! > 24, "cover 后出现黑色竖边");
    }
  }
  for (let x = 0; x < width; x += 1) {
    for (const y of [0, height - 1]) {
      const offset = at(x, y);
      assert.ok(pixels[offset]! + pixels[offset + 1]! + pixels[offset + 2]! > 24, "cover 后出现黑色横边");
    }
  }
}

await rm(dataRoot, { recursive: true, force: true });
await mkdir(dataRoot, { recursive: true });
const imagePath = resolve(dataRoot, "landscape.png");
const audioPath = resolve(dataRoot, "audio.wav");
const assPath = resolve(dataRoot, "captions.ass");
const blankAssPath = resolve(dataRoot, "blank.ass");
const outputPath = resolve(dataRoot, "template.mp4");
const baselinePath = resolve(dataRoot, "template-no-captions.mp4");

await run("ffmpeg", [
  "-v", "error", "-y", "-f", "lavfi", "-i",
  "color=c=0x315d78:s=1600x900,drawbox=x=0:y=0:w=400:h=900:c=0xd28b49:t=fill,drawbox=x=1100:y=0:w=500:h=900:c=0x8bb8a8:t=fill,drawbox=x=650:y=180:w=300:h=540:c=0xf0d9b5:t=fill",
  "-frames:v", "1", "-threads", "1", imagePath,
]);
await run("ffmpeg", [
  "-v", "error", "-y", "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000:duration=10",
  "-c:a", "pcm_s16le", audioPath,
]);

const assHeader = `[Script Info]\nScriptType: v4.00+\nPlayResX: 1080\nPlayResY: 1920\n\n[V4+ Styles]\nFormat: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\nStyle: Default,Microsoft YaHei,64,&H00FFFFFF,&H000000FF,&H00181818,&H80000000,-1,0,0,0,100,100,0,0,1,3,1,2,80,80,170,1\n\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n`;
await writeFile(assPath, `${assHeader}Dialogue: 0,0:00:00.00,0:00:10.00,Default,,0,0,0,,Narralume 中文字幕验收\n`, "utf8");
await writeFile(blankAssPath, assHeader, "utf8");

const motions: NineSixteenScene["motionKind"][] = ["none", "pan-left", "pan-right", "zoom-in", "zoom-out"];
const scenes: NineSixteenScene[] = motions.map((motionKind, index) => ({
  imagePath,
  durationMs: 2_000,
  motionKind,
  motionAmountPpm: motionKind === "none" ? 0 : 80_000,
  fadeMs: index === 2 ? 400 : 0,
}));

await renderNineSixteenTemplate({ scenes, audioPath, assPath, outputPath });
await renderNineSixteenTemplate({ scenes, audioPath, assPath: blankAssPath, outputPath: baselinePath });

const probe = await probeNineSixteenVideo(outputPath);
assert.ok(Math.abs(probe.durationMs - 10_000) <= 1_000, `成片时长漂移：${probe.durationMs}ms`);
const streamInfo = JSON.parse((await run("ffprobe", [
  "-v", "error", "-show_entries", "stream=codec_type,codec_name,width,height,r_frame_rate,pix_fmt", "-of", "json", outputPath,
])).toString("utf8")) as { streams: Array<{ codec_type: string; codec_name: string; width?: number; height?: number; r_frame_rate?: string; pix_fmt?: string }> };
assert.deepEqual(
  streamInfo.streams.map(({ codec_type, codec_name, width, height, r_frame_rate, pix_fmt }) => ({ codec_type, codec_name, width, height, r_frame_rate, pix_fmt })),
  [
    { codec_type: "video", codec_name: "h264", width: 1080, height: 1920, r_frame_rate: "25/1", pix_fmt: "yuv420p" },
    { codec_type: "audio", codec_name: "aac", width: undefined, height: undefined, r_frame_rate: "0/0", pix_fmt: undefined },
  ],
  "输出必须恰好包含 1080x1920@25 yuv420p H.264 与 AAC",
);

const coverFrame = await frame(outputPath, 1);
assertNoBlackBorder(coverFrame);
const motionMad = new Map<string, number>();
for (const [index, motion] of motions.entries()) {
  const start = index * 2 + 0.6;
  const mad = meanAbsoluteDifference(await frame(baselinePath, start), await frame(baselinePath, start + 0.8));
  motionMad.set(motion, mad);
  if (motion === "none") assert.ok(mad <= 0.5, `静态段帧差异常：MAD=${mad}`);
  else assert.ok(mad >= 1, `${motion} 微动帧差不足：MAD=${mad}`);
}

const fadeStart = brightness(await frame(baselinePath, 4.02));
const fadeMiddle = brightness(await frame(baselinePath, 5));
const fadeEnd = brightness(await frame(baselinePath, 5.8));
assert.ok(fadeStart < fadeMiddle * 0.7, `淡入首帧不够暗：${fadeStart}/${fadeMiddle}`);
assert.ok(fadeEnd < fadeMiddle * 0.7, `淡出末帧不够暗：${fadeEnd}/${fadeMiddle}`);

const captioned = await frame(outputPath, 1);
const noCaptions = await frame(baselinePath, 1);
assert.notDeepEqual(captioned, noCaptions, "ASS 字幕与无字幕基线帧相同");

console.log("P6-01 唯一 9:16 模板真实门禁通过");
console.log(`duration_ms=${probe.durationMs}`);
console.log(`video_bytes=${probe.bytes}`);
console.log(`motions=${motions.join(",")}`);
console.log(`motion_mad=${motions.map((motion) => `${motion}:${motionMad.get(motion)!.toFixed(3)}`).join(",")}`);
console.log(`fade_brightness=${fadeStart.toFixed(2)},${fadeMiddle.toFixed(2)},${fadeEnd.toFixed(2)}`);
console.log("cover_no_black_border=true");
console.log("motion_frames_different=true");
console.log("ass_burned_in=true");
console.log(`video_path=${outputPath}`);
