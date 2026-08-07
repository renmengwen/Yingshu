import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import test from "node:test";

import { probeNineSixteenVideo, runVideoProcess } from "./ffmpeg-video.js";
import { JobCancelledError } from "./job-worker.js";
import {
  buildNineSixteenFfmpegArgs,
  renderNineSixteenTemplate,
  type NineSixteenRenderInput,
} from "./nine-sixteen-template.js";

test("9:16 模板覆盖五类运镜、编码参数与安全边界", async () => {
  const root = await mkdtemp(join(tmpdir(), "narralume-nine-sixteen-"));
  try {
    const imagePath = join(root, "image.png");
    const audioPath = join(root, "audio.wav");
    const assPath = join(root, "timeline.ass");
    const outputPath = join(root, "output.mp4");
    await Promise.all([
      writeFile(imagePath, "image"),
      writeFile(audioPath, "audio"),
      writeFile(assPath, "[Events]"),
    ]);
    const motions = ["none", "pan-left", "pan-right", "zoom-in", "zoom-out"] as const;
    const input: NineSixteenRenderInput = {
      scenes: motions.map((motionKind) => ({
        imagePath,
        durationMs: 2_000,
        motionKind,
        motionAmountPpm: motionKind === "none" ? 0 : 100_000,
        fadeMs: 200,
      })),
      audioPath,
      assPath,
      outputPath,
    };
    const args = buildNineSixteenFfmpegArgs(input);
    const filter = args[args.indexOf("-filter_complex") + 1]!;
    assert.match(filter, /scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920/);
    assert.match(filter, /zoompan=z='1':x='0':y='0'/);
    assert.match(filter, /\(iw-iw\/zoom\)\*\(on\/49\)/);
    assert.match(filter, /1-on\/49/);
    assert.match(filter, /1\+0\.100000\*\(on\/49\)/);
    assert.match(filter, /1\+0\.100000\*\(1-on\/49\)/);
    assert.match(filter, /concat=n=5:v=1:a=0\[visual\];\[visual\]ass=timeline\.ass/);
    const landscapeArgs = buildNineSixteenFfmpegArgs({ ...input, aspectRatio: "16:9" });
    const landscapeFilter = landscapeArgs[landscapeArgs.indexOf("-filter_complex") + 1]!;
    assert.match(landscapeFilter, /scale=1920:1080:force_original_aspect_ratio=increase,crop=1920:1080/);
    assert.deepEqual(args.slice(-14), [
      "-c:v", "libx264", "-pix_fmt", "yuv420p", "-color_range", "tv", "-r", "25",
      "-c:a", "aac", "-shortest", "-movflags", "+faststart", outputPath,
    ]);

    let observedCwd = "";
    let observedArgs: string[] = [];
    const relativeInput: NineSixteenRenderInput = {
      ...input,
      scenes: input.scenes.map((scene) => ({ ...scene, imagePath: relative(process.cwd(), scene.imagePath) })),
      audioPath: relative(process.cwd(), audioPath),
      assPath: relative(process.cwd(), assPath),
    };
    await renderNineSixteenTemplate(relativeInput, {
      run: async (_command, renderArgs, options) => {
        observedCwd = options?.cwd ?? "";
        observedArgs = renderArgs;
        await writeFile(renderArgs.at(-1)!, "mp4");
        return "";
      },
      probe: async () => ({ bytes: 3, durationMs: 10_000 }),
    });
    assert.equal(observedCwd, root);
    assert.ok(observedArgs.includes(resolve(imagePath)));
    assert.ok(observedArgs.includes(resolve(audioPath)));
    assert.equal(await readFile(outputPath, "utf8"), "mp4");
    await assert.rejects(renderNineSixteenTemplate({ ...input, outputPath: imagePath }), /不能覆盖输入/);
    await assert.rejects(renderNineSixteenTemplate(input, {
      run: async (_command, renderArgs) => { await writeFile(renderArgs.at(-1)!, "bad"); return ""; },
      probe: async () => ({ bytes: 3, durationMs: 1 }),
    }), /时长与场景时间轴不一致/);
    assert.equal(await readFile(outputPath, "utf8"), "mp4");

    await assert.rejects(renderNineSixteenTemplate({ ...input, scenes: [] }, { run: async () => "" }), /不能为空/);
    await assert.rejects(renderNineSixteenTemplate({
      ...input, scenes: [{ ...input.scenes[0]!, durationMs: 100, fadeMs: 51 }],
    }, { run: async () => "", probe: async () => ({ bytes: 1, durationMs: 1 }) }), /超过场景时长/);
    await assert.rejects(renderNineSixteenTemplate({
      ...input, scenes: [{ ...input.scenes[0]!, motionKind: "none", motionAmountPpm: 1 }],
    }, { run: async () => "", probe: async () => ({ bytes: 1, durationMs: 1 }) }), /静态画面/);
    await assert.rejects(renderNineSixteenTemplate({
      ...input, scenes: [{ ...input.scenes[0]!, motionKind: "bad" as "none" }],
    }, { run: async () => "", probe: async () => ({ bytes: 1, durationMs: 1 }) }), /运镜类型/);

    for (const oldOutput of [undefined, "old-video"] as const) {
      if (oldOutput) await writeFile(outputPath, oldOutput); else await rm(outputPath, { force: true });
      const controller = new AbortController();
      await assert.rejects(renderNineSixteenTemplate({ ...input, signal: controller.signal }, {
        run: async (_command, renderArgs) => { await writeFile(renderArgs.at(-1)!, "new-video"); return ""; },
        probe: async () => { controller.abort(); return { bytes: 9, durationMs: 10_000 }; },
      }), JobCancelledError);
      if (oldOutput) assert.equal(await readFile(outputPath, "utf8"), oldOutput);
      else await assert.rejects(stat(outputPath), { code: "ENOENT" });
    }

    await writeFile(outputPath, "durable-old");
    const renderTemporary = async (_command: string, renderArgs: string[]) => {
      await writeFile(renderArgs.at(-1)!, "new-video");
      return "";
    };
    const validProbe = async () => ({ bytes: 9, durationMs: 10_000 });
    await assert.rejects(renderNineSixteenTemplate(input, {
      run: renderTemporary, probe: validProbe, sync: async () => { throw new Error("sync failed"); },
    }), /sync failed/);
    assert.equal(await readFile(outputPath, "utf8"), "durable-old");
    await assert.rejects(renderNineSixteenTemplate(input, {
      run: renderTemporary, probe: validProbe, rename: async () => { throw new Error("rename failed"); },
    }), /rename failed/);
    assert.equal(await readFile(outputPath, "utf8"), "durable-old");
    assert.deepEqual((await readdir(root)).filter((name) => name.includes(".tmp.mp4")), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("9:16 模板把真实 JPEG 直接渲染为 yuv420p", async () => {
  const root = await mkdtemp(join(tmpdir(), "narralume-nine-sixteen-jpeg-"));
  try {
    const imagePath = join(root, "image.jpg");
    const audioPath = join(root, "audio.wav");
    const assPath = join(root, "timeline.ass");
    const outputPath = join(root, "output.mp4");
    await runVideoProcess("ffmpeg", [
      "-v", "error", "-y", "-f", "lavfi", "-i", "color=c=0x8b674c:s=320x568",
      "-frames:v", "1", imagePath,
    ]);
    await runVideoProcess("ffmpeg", [
      "-v", "error", "-y", "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000:duration=1",
      "-c:a", "pcm_s16le", audioPath,
    ]);
    await writeFile(assPath, "[Script Info]\nScriptType: v4.00+\n\n[Events]\n", "utf8");

    await renderNineSixteenTemplate({
      scenes: [{ imagePath, durationMs: 1_000, motionKind: "none", motionAmountPpm: 0, fadeMs: 0 }],
      audioPath,
      assPath,
      outputPath,
    });

    assert.deepEqual(await probeNineSixteenVideo(outputPath), {
      bytes: (await stat(outputPath)).size,
      durationMs: 1_000,
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
