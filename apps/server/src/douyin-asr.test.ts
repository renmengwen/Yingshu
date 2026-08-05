import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { prepareDouyinAsrSegments, transcribeDouyinAsrSegments, type DouyinAsrSegment } from "./douyin-asr.js";
import { runVideoProcess } from "./ffmpeg-video.js";
import type { RuntimeModelConfig } from "./model-config.js";

function runtime(protocol: "openai-transcription" | "mimo-audio"): RuntimeModelConfig {
  return { enabled: true, type: "asr", providerId: "fixture", providerName: "Fixture", providerKind: "openai-compatible",
    protocol: "openai-response", asrProtocol: protocol, baseUrl: "https://asr.example/v1", apiKey: "secret",
    modelId: protocol === "mimo-audio" ? "mimo-v2.5-asr" : "whisper-1", maxRequestBytes: 1024 * 1024,
    segmentDurationSeconds: 30, identityHash: "a".repeat(64) };
}

function hash(value: Buffer) { return createHash("sha256").update(value).digest("hex"); }

test("ASR 开关关闭不执行 ffmpeg；开启后按固定时长切片并冻结 Hash", async () => {
  const root = await mkdtemp(join(tmpdir(), "yingshu-asr-"));
  let calls = 0;
  try {
    assert.deepEqual(await prepareDouyinAsrSegments({ transcribeAudio: false, videoPath: "ignored", outputDirectory: root,
      durationMs: 61_000, segmentDurationSeconds: 30, run: async () => { calls += 1; return ""; } }), []);
    const segments = await prepareDouyinAsrSegments({ transcribeAudio: true, videoPath: "video.mp4", outputDirectory: root,
      durationMs: 61_000, segmentDurationSeconds: 30, run: async (_command, args) => {
        calls += 1; await writeFile(args.at(-1)!, Buffer.from(`audio-${calls}`)); return "";
      } });
    assert.equal(calls, 3);
    assert.deepEqual(segments.map(({ startMs, endMs, status }) => ({ startMs, endMs, status })), [
      { startMs: 0, endMs: 30_000, status: "prepared" }, { startMs: 30_000, endMs: 60_000, status: "prepared" },
      { startMs: 60_000, endMs: 61_000, status: "prepared" },
    ]);
    assert.match(segments[0]!.sha256, /^[a-f0-9]{64}$/u);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("系统 ffmpeg 真实生成可恢复的有界音频切片", async (context) => {
  try { await runVideoProcess("ffmpeg", ["-version"]); } catch { context.skip("系统未安装 ffmpeg"); return; }
  const root = await mkdtemp(join(tmpdir(), "yingshu-asr-ffmpeg-"));
  try {
    const source = join(root, "source.mp3");
    await runVideoProcess("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "sine=frequency=440:duration=31",
      "-ac", "1", "-ar", "16000", "-b:a", "32k", source]);
    const segments = await prepareDouyinAsrSegments({ transcribeAudio: true, videoPath: source,
      outputDirectory: join(root, "segments"), durationMs: 31_000, segmentDurationSeconds: 30 });
    assert.deepEqual(segments.map(({ startMs, endMs }) => ({ startMs, endMs })), [
      { startMs: 0, endMs: 30_000 }, { startMs: 30_000, endMs: 31_000 },
    ]);
    assert.ok(segments.every((segment) => segment.bytes > 0 && !segment.fileName.includes(root)));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("OpenAI multipart 请求按时间合并，失败段形成 partial 和缺失范围", async () => {
  const root = await mkdtemp(join(tmpdir(), "yingshu-asr-openai-"));
  try {
    const segments: DouyinAsrSegment[] = [];
    for (const [index, text] of ["second", "first"].entries()) {
      const fileName = `asr-${String(index + 1).padStart(4, "0")}.mp3`;
      const path = join(root, fileName); const bytes = Buffer.from(text); await writeFile(path, bytes);
      segments.push({ index, startMs: index ? 0 : 30_000, endMs: index ? 30_000 : 60_000, fileName,
        bytes: bytes.length, sha256: hash(bytes), status: "prepared" });
    }
    let calls = 0;
    const result = await transcribeDouyinAsrSegments({ segments, audioDirectory: root, runtime: runtime("openai-transcription"),
      fetchImpl: (async (url, init) => {
        calls += 1; assert.equal(url, "https://asr.example/v1/audio/transcriptions");
        assert.equal((init!.headers as Record<string, string>).Authorization, "Bearer secret");
        const form = init!.body as FormData; assert.equal(form.get("model"), "whisper-1"); assert.ok(form.get("file") instanceof Blob);
        return new Response(calls === 1 ? JSON.stringify({ text: "第一段" }) : JSON.stringify({ error: {} }),
          { status: calls === 1 ? 200 : 500, headers: { "content-type": "application/json" } });
      }) as typeof fetch });
    assert.equal(result.status, "partial"); assert.equal(result.text, "第一段");
    assert.deepEqual(result.missingRanges, [{ startMs: 30_000, endMs: 60_000 }]);
    assert.equal(JSON.stringify(result).includes("secret"), false);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("MiMo JSON 请求形状正确；Hash 变化和取消均返回可序列化隔离结果", async () => {
  const root = await mkdtemp(join(tmpdir(), "yingshu-asr-mimo-"));
  try {
    const path = join(root, "asr-0001.mp3"); const bytes = Buffer.from("audio"); await writeFile(path, bytes);
    const segment: DouyinAsrSegment = { index: 0, startMs: 0, endMs: 1000, fileName: "asr-0001.mp3", bytes: bytes.length,
      sha256: hash(bytes), status: "prepared" };
    const success = await transcribeDouyinAsrSegments({ segments: [segment], audioDirectory: root, runtime: runtime("mimo-audio"),
      fetchImpl: (async (url, init) => {
        assert.equal(url, "https://asr.example/v1/chat/completions");
        assert.equal((init!.headers as Record<string, string>)["api-key"], "secret");
        const body = JSON.parse(String(init!.body));
        assert.equal(body.messages[0].content[0].type, "input_audio");
        assert.match(body.messages[0].content[0].input_audio.data, /^data:audio\/mpeg;base64,/u);
        return new Response(JSON.stringify({ choices: [{ message: { content: "完成" } }] }), { status: 200 });
      }) as typeof fetch });
    assert.equal(success.status, "succeeded"); assert.equal(success.text, "完成");

    await writeFile(path, "changed");
    const failed = await transcribeDouyinAsrSegments({ segments: [segment], audioDirectory: root, runtime: runtime("mimo-audio"),
      fetchImpl: async () => { throw new Error("不应请求"); } });
    assert.equal(failed.status, "failed"); assert.match(failed.segments[0]!.error!, /Hash/u);

    const controller = new AbortController(); controller.abort();
    const cancelled = await transcribeDouyinAsrSegments({ segments: [segment], audioDirectory: root, runtime: runtime("mimo-audio"),
      signal: controller.signal, fetchImpl: async () => { throw new Error("不应请求"); } });
    assert.equal(cancelled.status, "cancelled"); assert.doesNotThrow(() => JSON.parse(JSON.stringify(cancelled)));
    await assert.rejects(() => transcribeDouyinAsrSegments({ segments: [{ ...segment, startMs: 1 }], audioDirectory: root,
      runtime: runtime("mimo-audio") }), /清单无效/u);
  } finally { await rm(root, { recursive: true, force: true }); }
});
