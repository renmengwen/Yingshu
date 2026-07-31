import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { openDatabase } from "./database.js";
import { JobWorker } from "./job-worker.js";
import type { RuntimeModelConfig } from "./model-config.js";
import { createProject, createVideo } from "./project-video-store.js";
import { canonical, sha256, type VideoScriptContent } from "./video-plan-contract.js";
import { probeSystemSpeechWav } from "./tts-provider.js";
import { createVideoTtsJobHandler } from "./video-tts-job.js";
import { createVideoTtsJob, getVideoTtsState, VIDEO_TTS_JOB_TYPE, VideoTtsStoreError } from "./video-tts-store.js";

const runtime: RuntimeModelConfig = {
  enabled: true, type: "tts", providerId: "edge-tts", providerName: "Edge TTS", providerKind: "edge-tts",
  protocol: "openai-response", baseUrl: "", apiKey: "", modelId: "node-edge-tts", voiceId: "zh-CN-YunjianNeural",
  language: "zh-CN", wordBoundary: true,
};

function pcmWav(durationMs: number) {
  const samples = Math.floor(22_050 * durationMs / 1_000);
  const payload = Buffer.alloc(samples * 2);
  for (let index = 0; index < samples; index += 1) payload.writeInt16LE(Math.round(Math.sin(index / 12) * 4_000), index * 2);
  const header = Buffer.alloc(44);
  header.write("RIFF", 0); header.writeUInt32LE(36 + payload.length, 4); header.write("WAVEfmt ", 8);
  header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22); header.writeUInt32LE(22_050, 24);
  header.writeUInt32LE(44_100, 28); header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34);
  header.write("data", 36); header.writeUInt32LE(payload.length, 40);
  return Buffer.concat([header, payload]);
}

async function fixture() {
  const dataRoot = await mkdtemp(join(tmpdir(), "yingshu-video-tts-"));
  const connection = openDatabase(dataRoot);
  const project = createProject(connection.database, { name: "配音测试" }, 1_000);
  const video = createVideo(connection.database, project.id, { title: "并行门禁" }, 1_001);
  const script: VideoScriptContent = {
    title: "首版", summary: "摘要", narration: "第一段旁白。\n\n第二段旁白。", estimatedCharacters: 12,
    estimatedDurationSeconds: 4, paragraphs: [{ id: "paragraph_a", text: "第一段旁白。" }, { id: "paragraph_b", text: "第二段旁白。" }],
    sourceSummary: [], risks: [],
  };
  const scriptHash = sha256(canonical(script));
  const planHash = sha256("plan");
  connection.database.prepare(
    `INSERT INTO video_plan_snapshots (id,video_id,idempotency_key,input_json,prompt_json,model_json,system_contract_version,
     web_capability,canonical_json,snapshot_hash,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
  ).run("plan_tts", video.id, "tts", JSON.stringify({ targetDurationSeconds: 60, webEnabled: false }), JSON.stringify({}),
    JSON.stringify({ providerId: "text", modelId: "text", protocol: "openai-response", baseUrl: "http://text", identityHash: sha256("text") }),
    "video-plan-system-v1", "unsupported-v1", JSON.stringify({ targetDurationSeconds: 60 }), planHash, 2_000);
  connection.database.prepare(
    `INSERT INTO video_script_revisions (id,video_id,snapshot_id,revision,content_json,content_hash,provider_id,model_id,
     prompt_version,prompt_hash,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
  ).run("script_tts", video.id, "plan_tts", 1, JSON.stringify(script), scriptHash, "text", "text", "v1", sha256("prompt"), 2_001);
  const visual = { visuals: [{ id: "visual_a", paragraphId: "paragraph_a", purpose: "说明", description: "画面",
    prompt: "prompt", negativePrompt: "none", suggestedDurationSeconds: 60, weight: 1, generationStatus: "not_generated", currentCandidate: null }] };
  const visualHash = sha256(canonical(visual));
  connection.database.prepare(
    `INSERT INTO video_visual_revisions (id,video_id,snapshot_id,script_revision_id,script_content_hash,revision,content_json,
     content_hash,created_at) VALUES (?,?,?,?,?,?,?,?,?)`,
  ).run("visual_tts", video.id, "plan_tts", "script_tts", scriptHash, 1, JSON.stringify(visual), visualHash, 2_002);
  connection.database.prepare(
    `INSERT INTO video_plan_approvals (id,video_id,snapshot_id,revision,script_revision_id,visual_revision_id,
     script_content_hash,visual_content_hash,created_at) VALUES (?,?,?,?,?,?,?,?,?)`,
  ).run("approval_tts", video.id, "plan_tts", 1, "script_tts", "visual_tts", scriptHash, visualHash, 2_003);
  return { dataRoot, connection, project, video };
}

const identity = (rate = 0) => ({ providerId: runtime.providerId, providerName: runtime.providerName,
  providerKind: runtime.providerKind, protocol: runtime.protocol, baseUrl: runtime.baseUrl, modelId: runtime.modelId,
  voiceId: runtime.voiceId!, rate, language: runtime.language! });

test("Video TTS 不依赖图片 gate，重复身份幂等且不同身份有唯一 active 门禁", async () => {
  const value = await fixture();
  try {
    const first = createVideoTtsJob(value.connection.database, value.project.id, value.video.id, identity(), 3_000);
    assert(first.job);
    const repeated = createVideoTtsJob(value.connection.database, value.project.id, value.video.id, identity(), 3_001);
    assert.equal(repeated.reused, true);
    assert.equal(repeated.job?.id, first.job.id);
    assert.throws(() => createVideoTtsJob(value.connection.database, value.project.id, value.video.id, identity(1), 3_002),
      (error: unknown) => error instanceof VideoTtsStoreError && error.statusCode === 409);
    assert.throws(() => createVideoTtsJob(value.connection.database, value.project.id, value.video.id,
      { ...identity(1), params: { nested: { apiKey: "不得落库" } } }, 3_003),
    (error: unknown) => error instanceof VideoTtsStoreError && error.statusCode === 400);
    assert.equal(value.connection.database.prepare("SELECT COUNT(*) AS count FROM video_tts_jobs").get()!.count, 1);
  } finally { value.connection.close(); await rm(value.dataRoot, { recursive: true, force: true }); }
});

test("真实分段 WAV 以 checkpoint 避免重调，并生成同源 cue、SRT、ASS 与规范整轨", async () => {
  const value = await fixture();
  let calls = 0;
  let failNormalizeOnce = true;
  try {
    const queued = createVideoTtsJob(value.connection.database, value.project.id, value.video.id, identity(), 3_000);
    const handler = createVideoTtsJobHandler(value.connection.database, value.dataRoot, async () => runtime, {
      synthesize: async (input) => {
        calls += 1;
        await writeFile(input.outputPath, pcmWav(300));
        return { providerRequestId: `fixture-${calls}` };
      },
      probe: async (path, signal) => {
        if (path.endsWith(`${queued.snapshot.snapshotHash}.wav`) && failNormalizeOnce) {
          failNormalizeOnce = false;
          throw new Error("fixture normalize failure");
        }
        return probeSystemSpeechWav(path, signal);
      },
    });
    const worker = new JobWorker(value.connection.database, { [VIDEO_TTS_JOB_TYPE]: handler },
      { workerId: "video-tts", leaseMs: 5_000, heartbeatMs: 100, retryDelayMs: 0 });
    assert.equal(await worker.runOne(), true);
    assert.equal(calls, 2);
    assert.equal(await worker.runOne(), true);
    assert.equal(calls, 2, "规范化重试不得再次调用可能计费的 provider");

    const state = getVideoTtsState(value.connection.database, value.project.id, value.video.id)!;
    assert.equal(state.job?.status, "succeeded");
    assert.equal(state.stale, false);
    assert.equal(state.artifact?.audio.mime, "audio/wav");
    assert.equal(state.artifact?.audio.codec, "pcm_s16le");
    assert.equal(state.artifact?.audio.sampleRate, 22_050);
    assert.equal(state.artifact?.audio.channels, 1);
    assert.equal(state.artifact?.cues.length, 2);
    assert.equal(state.artifact?.cues[0]?.paragraphId, "paragraph_a");
    assert.equal(state.artifact?.cues[0]?.startMs, 0);
    assert.equal(state.artifact?.cues.at(-1)?.endMs, state.artifact?.audio.durationMs);
    const root = value.dataRoot;
    const srt = await readFile(join(root, state.artifact!.subtitles.srt.relativePath), "utf8");
    const ass = await readFile(join(root, state.artifact!.subtitles.ass.relativePath), "utf8");
    assert.match(srt, /第一段旁白/);
    assert.match(ass, /第一段旁白/);
    await probeSystemSpeechWav(join(root, state.artifact!.audio.relativePath));

    const changed = createVideoTtsJob(value.connection.database, value.project.id, value.video.id, identity(1), 4_000);
    assert.notEqual(changed.snapshot.id, state.snapshot.id);
    assert.equal(getVideoTtsState(value.connection.database, value.project.id, value.video.id)?.artifact, null);
  } finally { value.connection.close(); await rm(value.dataRoot, { recursive: true, force: true }); }
});
