import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { synthesizeSystemSpeech } from "../tts-provider.js";

const run = promisify(execFile);
const root = await mkdtemp(join(tmpdir(), "narralume-p4-tts-"));
try {
  const outputPath = join(root, "probe.wav");
  const result = await synthesizeSystemSpeech({
    text: "Narralume 已使用本机中文语音生成真实音频。",
    outputPath,
    scriptVersionId: "script_real_probe",
    contentHash: "a".repeat(64),
  });
  const { stdout } = await run("ffprobe", [
    "-v", "error", "-show_entries", "stream=codec_name,sample_rate,channels:format=duration,size",
    "-of", "json", outputPath,
  ], { windowsHide: true });
  const probe = JSON.parse(stdout) as {
    streams: Array<{ codec_name: string; sample_rate: string; channels: number }>;
    format: { duration: string; size: string };
  };
  assert.equal(probe.streams[0]?.codec_name, "pcm_s16le");
  assert.equal(probe.streams[0]?.channels, 1);
  assert(Number(probe.format.duration) > 0);
  assert.equal(Number(probe.format.size), result.bytes);
  process.stdout.write(`${JSON.stringify({ ok: true, ...result, ffprobe: probe }, null, 2)}\n`);
} finally {
  await rm(root, { recursive: true, force: true });
}
