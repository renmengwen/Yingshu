import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { runVideoProcess } from "./ffmpeg-video.js";
import {
  douyinMediaSteps,
  downloadDouyinVideo,
  extractDouyinFrames,
  planDouyinFrameTimestamps,
  probeDouyinVideo,
  verifyDouyinMediaFile,
} from "./douyin-media.js";

test("媒体门控不会执行未请求的下载、抽帧或音频", () => {
  assert.deepEqual(douyinMediaSteps({ extractFrames: false, transcribeAudio: false }), {
    downloadVideo: false, probeVideo: false, extractFrames: false, extractAudio: false,
  });
  assert.deepEqual(douyinMediaSteps({ extractFrames: true, transcribeAudio: false }), {
    downloadVideo: true, probeVideo: true, extractFrames: true, extractAudio: false,
  });
  assert.deepEqual(douyinMediaSteps({ extractFrames: false, transcribeAudio: true }), {
    downloadVideo: true, probeVideo: true, extractFrames: false, extractAudio: true,
  });
});

test("固定总数抽帧按短视频中点和长视频开头分层规划", () => {
  assert.deepEqual(planDouyinFrameTimestamps(12_000, 6), [1_000, 3_000, 5_000, 7_000, 9_000, 11_000]);
  assert.deepEqual(planDouyinFrameTimestamps(60_000, 12), [
    1_875, 5_625, 9_375, 13_125, 17_812, 23_437, 29_062, 34_687, 40_312, 45_937, 51_562, 57_187,
  ]);
  for (const count of [6, 12, 30]) {
    const points = planDouyinFrameTimestamps(60_000, count);
    assert.equal(points.length, count);
    assert.equal(new Set(points).size, count);
    assert.ok(points.every((point, index) => point > 0 && point < 60_000 && (!index || point > points[index - 1]!)));
  }
  assert.equal(planDouyinFrameTimestamps(15_001, 30).length, 30, "毫秒碰撞仍保留固定计划总数，由执行层记录失败");
  assert.throws(() => planDouyinFrameTimestamps(0, 12), /时长/);
  assert.throws(() => planDouyinFrameTimestamps(1_000, 5), /6～30/);
});

test("受控流式下载校验来源、上限、magic、Hash 和链接逃逸", async () => {
  const root = await mkdtemp(join(tmpdir(), "yingshu-douyin-download-"));
  const fakeMp4 = Buffer.concat([Buffer.from([0, 0, 0, 20]), Buffer.from("ftypisom"), Buffer.alloc(24)]);
  const server = createServer((request, response) => {
    response.writeHead(200, { "content-type": "video/mp4" });
    response.end(request.url === "/large" ? Buffer.concat([fakeMp4, Buffer.alloc(100)]) : fakeMp4);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const url = `http://127.0.0.1:${address.port}/video`;
  try {
    const file = await downloadDouyinVideo({ source: { url, source: "douyin-detail" }, dataRoot: root,
      relativePath: "douyin/snapshot/video.mp4", maxBytes: 1024 });
    assert.equal(file.bytes, fakeMp4.length);
    assert.deepEqual(await readFile(join(root, "douyin/snapshot/video.mp4")), fakeMp4);
    await assert.rejects(downloadDouyinVideo({ source: { url: url.replace("/video", "/large"), source: "douyin-detail" },
      dataRoot: root, relativePath: "douyin/large.mp4", maxBytes: 50 }), /字节上限/);
    assert.deepEqual(await readdir(join(root, "douyin")), ["snapshot"]);
    await assert.rejects(downloadDouyinVideo({ source: { url: "file:///tmp/a", source: "douyin-detail" },
      dataRoot: root, relativePath: "douyin/file.mp4" }), /协议/);

    await writeFile(join(root, "bad.mp4"), "not video");
    await assert.rejects(verifyDouyinMediaFile(root, "bad.mp4", { mime: "video/mp4" }), /magic/);
    await assert.rejects(verifyDouyinMediaFile(root, "douyin/snapshot/video.mp4", {
      mime: "video/mp4", bytes: fakeMp4.length, sha256: "0".repeat(64),
    }), /Hash/);
    const outside = await mkdtemp(join(tmpdir(), "yingshu-douyin-outside-"));
    try {
      await writeFile(join(outside, "video.mp4"), fakeMp4);
      await mkdir(join(root, "links"));
      await symlink(outside, join(root, "links", "junction"), "junction");
      await assert.rejects(verifyDouyinMediaFile(root, "links/junction/video.mp4", { mime: "video/mp4" }), /普通独占文件/);
    } finally { await rm(outside, { recursive: true, force: true }); }
  } finally {
    server.close();
    await once(server, "close");
    await rm(root, { recursive: true, force: true });
  }
});

test("system ffprobe 和 ffmpeg 生成真实可解码帧；单帧失败重试后形成 partial", async (context) => {
  try { await runVideoProcess("ffmpeg", ["-version"]); await runVideoProcess("ffprobe", ["-version"]); }
  catch { context.skip("系统未安装 ffmpeg/ffprobe"); return; }
  const root = await mkdtemp(join(tmpdir(), "yingshu-douyin-ffmpeg-"));
  try {
    const video = join(root, "video.mp4");
    await runVideoProcess("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "testsrc=size=160x90:rate=10",
      "-t", "2", "-pix_fmt", "yuv420p", video]);
    const identity = await verifyDouyinMediaFile(root, "video.mp4", { mime: "video/mp4" });
    assert.ok(identity.bytes > 0);
    const probe = await probeDouyinVideo(root, "video.mp4");
    assert.equal(probe.width, 160);
    assert.equal(probe.height, 90);
    assert.ok(probe.durationMs >= 1_900 && probe.durationMs <= 2_100);
    const frames = await extractDouyinFrames({ dataRoot: root, videoRelativePath: "video.mp4",
      framesRelativeDirectory: "frames", durationMs: probe.durationMs, frameCount: 6 });
    assert.equal(frames.status, "succeeded");
    assert.equal(frames.succeeded, 6);
    assert.ok(frames.frames.every((frame) => frame.width === 160 && frame.height === 90 && frame.sha256));

    let calls = 0;
    const partial = await extractDouyinFrames({ dataRoot: root, videoRelativePath: "video.mp4",
      framesRelativeDirectory: "failed-frames", durationMs: probe.durationMs, frameCount: 6,
      run: async (command, args, options) => {
        calls += 1;
        if (calls <= 2) throw new Error("fixture failure");
        return runVideoProcess(command, args, options);
      } });
    assert.equal(partial.status, "partial");
    assert.equal(partial.failed, 1);
    assert.equal(partial.frames[0]?.attempts, 2);
    assert.equal(partial.succeeded, 5);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
