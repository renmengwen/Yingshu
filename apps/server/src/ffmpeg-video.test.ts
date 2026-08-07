import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { JobCancelledError } from "./job-worker.js";
import { probeNineSixteenVideo, probeVideoOutputVideo, runVideoProcess } from "./ffmpeg-video.js";

test("视频进程封装限制输出并传播失败与取消", async () => {
  assert.equal(await runVideoProcess(process.execPath, ["-e", "process.stdout.write('ok')"]), "ok");
  await assert.rejects(
    runVideoProcess(process.execPath, ["-e", "process.stderr.write('bad');process.exit(7)"]),
    /执行失败：bad/,
  );
  await assert.rejects(
    runVideoProcess(process.execPath, ["-e", "process.stdout.write('中'.repeat(30000))"]),
    /64 KiB/,
  );

  const controller = new AbortController();
  const running = runVideoProcess(process.execPath, ["-e", "setInterval(()=>{},1000)"], { signal: controller.signal });
  setTimeout(() => controller.abort(), 30);
  await assert.rejects(running, JobCancelledError);

  const pipeController = new AbortController();
  const pipeRace = runVideoProcess(process.execPath, ["-e", "setInterval(()=>process.stdout.write('x'),0)"],
    { signal: pipeController.signal });
  setTimeout(() => pipeController.abort(), 0);
  await assert.rejects(pipeRace, JobCancelledError);
});

test("9:16 视频探测拒绝非 AAC 音轨和非 yuv420p 像素格式", async () => {
  const root = await mkdtemp(join(tmpdir(), "narralume-video-probe-"));
  try {
    const path = join(root, "video.mp4");
    await writeFile(path, "1234");
    const output = (audio = "aac", pixFmt = "yuv420p") => JSON.stringify({
      streams: [
        {
          codec_type: "video", codec_name: "h264", width: 1080, height: 1920,
          pix_fmt: pixFmt, r_frame_rate: "25/1",
        },
        { codec_type: "audio", codec_name: audio },
      ],
      format: { duration: "1.000", size: "4" },
    });
    assert.deepEqual(await probeNineSixteenVideo(path, undefined, async () => output()), { bytes: 4, durationMs: 1_000 });
    const landscape = () => output().replace('"width":1080', '"width":1920').replace('"height":1920', '"height":1080');
    assert.deepEqual(await probeVideoOutputVideo(path, { aspectRatio: "16:9", width: 1920, height: 1080 }, undefined,
      async () => landscape()), { bytes: 4, durationMs: 1_000 });
    await assert.rejects(probeNineSixteenVideo(path, undefined, async () => output("mp3")), /视频流/);
    await assert.rejects(probeNineSixteenVideo(path, undefined, async () => output("aac", "yuv444p")), /视频流/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
