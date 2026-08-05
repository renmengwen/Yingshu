import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import { calculateDouyinDeterministicMetrics, type DouyinAnalysisProviderInput } from "./douyin-analysis-provider.js";
import { createDouyinAnalysisJobHandler, type DouyinAnalysisJobDependencies } from "./douyin-analysis-job.js";
import { enqueueDouyinAnalysis, getCurrentDouyinAnalysisSnapshot } from "./douyin-analysis-store.js";
import { openDatabase } from "./database.js";
import { JobWorker } from "./job-worker.js";
import { getJob, requestJobCancellation } from "./job-store.js";
import { createProject, createVideo } from "./project-video-store.js";
import { DouyinSourceError } from "./douyin-source.js";

const sha = (value: Buffer) => createHash("sha256").update(value).digest("hex");
const mp4 = Buffer.from([0, 0, 0, 12, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d]);
const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0, 17, 8, 0, 1, 0, 1, 3, 1, 0x11, 0, 2, 0x11, 0, 3, 0x11, 0]);

function report(input: DouyinAnalysisProviderInput) {
  const available = { status: "available" as const, reason: "fixture" };
  const unavailable = { status: "unavailable" as const, reason: "未提供证据" };
  return {
    version: "yingshu-douyin-analysis-v1" as const, evidence: { ...input.evidence, modelIdentity: "fixture-model" },
    availability: { content: available, narrative: available, pacing: available, visualOverall: unavailable,
      visualOpening: unavailable, audioSubtitle: available, audience: input.comments ? available : unavailable,
      narrationVisualAlignment: unavailable },
    content: { observations: [] }, narrative: { sections: [], observations: [] },
    pacing: { metrics: calculateDouyinDeterministicMetrics(input.deterministic), observations: [] },
    visual: null, audioSubtitle: { observations: [] },
    audience: input.comments ? { interpretationOnly: true as const, observations: [] } : null, observations: [], risks: [],
  };
}

async function fixture(config: { extractFrames: boolean; transcribeAudio: boolean; analyzeComments: boolean }, partialFrame = false) {
  const dataRoot = await mkdtemp(join(tmpdir(), "yingshu-douyin-job-"));
  const connection = openDatabase(dataRoot);
  const project = createProject(connection.database, { name: "抖音 Job" }, 1);
  const video = createVideo(connection.database, project.id, { title: "视频" }, 2);
  const calls = { download: 0, frames: 0, prepare: 0, transcribe: 0, comments: 0, analyze: 0 };
  const created = enqueueDouyinAnalysis(connection.database, { projectId: project.id, videoId: video.id, awemeId: "12345",
    sourceUrl: "https://www.douyin.com/video/12345", config: { sourceText: "https://www.douyin.com/video/12345",
      frameCount: 6, ...config } });
  const dependencies: DouyinAnalysisJobDependencies = {
    resolveSource: async () => ({ awemeId: "12345", sourceUrl: "https://www.douyin.com/video/12345",
      canonicalUrl: "https://www.douyin.com/video/12345" }),
    fetchMetadata: async () => ({ awemeId: "12345", canonicalUrl: "https://www.douyin.com/video/12345", title: "标题",
      description: "描述", author: { id: "author", secUid: "sec", nickname: "昵称" }, publishedAt: 1,
      durationMs: 20_000, statistics: { likes: 1, comments: 1, collects: 1, shares: 1 }, coverUrl: null,
      videoDownloadUrl: "https://example.com/video.mp4", audioDownloadUrl: null }),
    downloadVideo: async (options) => { calls.download += 1; const path = join(dataRoot, ...options.relativePath.split("/"));
      await mkdir(dirname(path), { recursive: true }); await writeFile(path, mp4);
      return { relativePath: options.relativePath, bytes: mp4.length, sha256: sha(mp4), mime: "video/mp4" }; },
    probeVideo: async () => ({ durationMs: 20_000, width: 1080, height: 1920, codec: "h264", frameRate: "30/1", audioTracks: [{ codec: "aac", durationMs: 20_000 }] }),
    extractFrames: async (options) => { calls.frames += 1; const frames = [];
      for (let index = 0; index < options.frameCount; index += 1) {
        if (partialFrame && index === options.frameCount - 1) { frames.push({ index, timestampMs: 19_000, status: "failed" as const, attempts: 2 as const, error: "fixture" }); continue; }
        const relativePath = `${options.framesRelativeDirectory}/frame-${String(index + 1).padStart(4, "0")}.jpg`;
        const path = join(dataRoot, ...relativePath.split("/")); await mkdir(dirname(path), { recursive: true }); await writeFile(path, jpeg);
        frames.push({ index, timestampMs: 1_000 + index * 3_000, status: "succeeded" as const, attempts: 1 as const,
          relativePath, width: 1, height: 1, bytes: jpeg.length, sha256: sha(jpeg) });
      }
      const succeeded = frames.filter((item) => item.status === "succeeded").length;
      return { status: succeeded === frames.length ? "succeeded" as const : "partial" as const,
        planned: frames.length, succeeded, failed: frames.length - succeeded, frames }; },
    prepareAsr: async (options) => { calls.prepare += 1; const value = Buffer.from("fixture-audio");
      const path = join(options.outputDirectory, "asr-0001.mp3"); await mkdir(dirname(path), { recursive: true }); await writeFile(path, value);
      return [{ index: 0, startMs: 0, endMs: 20_000, fileName: "asr-0001.mp3", bytes: value.length, sha256: sha(value), status: "prepared" as const }]; },
    transcribeAsr: async (options) => { calls.transcribe += 1; const segment = options.segments[0]!;
      return { status: "succeeded", text: "完整转写", segments: [{ ...segment, status: "succeeded", text: "完整转写" }], missingRanges: [],
        model: { providerId: "asr", model: "asr-model", protocol: "openai-transcription", baseUrl: "https://example.com", identityHash: "a".repeat(64) } }; },
    fetchComments: async () => { calls.comments += 1; return { status: "failed", failureKind: "platform_blocked", comments: [],
      fetchedAt: 1, pagesFetched: 0, truncated: false, interpretationOnly: true, diagnostic: { cache: "miss" } }; },
    resolveAsrRuntime: async () => ({ enabled: true, type: "asr", providerId: "asr", providerName: "ASR", providerKind: "openai-compatible",
      protocol: "openai-response", asrProtocol: "openai-transcription", baseUrl: "https://example.com", apiKey: "secret",
      modelId: "asr-model", maxRequestBytes: 10_000_000, segmentDurationSeconds: 60, identityHash: "a".repeat(64) }),
    analyze: async (input) => { calls.analyze += 1; return { report: report(input), modelSnapshot: { providerId: "text", model: "model",
      protocol: "openai-response", baseUrl: "https://example.com", modelIdentityHash: "b".repeat(64),
      promptVersion: "yingshu-douyin-analysis-prompt-v1", systemVersion: "yingshu-douyin-analysis-system-v1",
      inputHash: "c".repeat(64), transcriptStrategy: "complete", omittedTranscriptRanges: [] } }; },
  };
  const handler = createDouyinAnalysisJobHandler(connection.database, dataRoot, dependencies);
  const worker = new JobWorker(connection.database, { douyin_video_analysis: handler }, { workerId: `worker-${Math.random()}`, leaseMs: 5_000, heartbeatMs: 100, retryDelayMs: 0 });
  return { dataRoot, connection, project, video, created, calls, dependencies, handler, worker };
}

test("Job 按开关隔离媒体步骤，并把单帧和评论失败冻结为 partial", async () => {
  for (const [config, expected] of [
    [{ extractFrames: true, transcribeAudio: false, analyzeComments: false }, { frames: 1, prepare: 0 }],
    [{ extractFrames: false, transcribeAudio: true, analyzeComments: false }, { frames: 0, prepare: 1 }],
    [{ extractFrames: true, transcribeAudio: true, analyzeComments: true }, { frames: 1, prepare: 1 }],
  ] as const) {
    const value = await fixture(config, config.analyzeComments);
    try {
      assert.equal(await value.worker.runOne(), true);
      assert.equal(value.calls.frames, expected.frames); assert.equal(value.calls.prepare, expected.prepare);
      assert.equal(value.calls.transcribe, config.transcribeAudio ? 1 : 0); assert.equal(value.calls.comments, config.analyzeComments ? 1 : 0);
      const snapshot = getCurrentDouyinAnalysisSnapshot(value.connection.database, value.project.id, value.video.id)!;
      assert.equal(snapshot.status, config.analyzeComments ? "partial" : "succeeded",
        JSON.stringify(getJob(value.connection.database, value.created.job!.id)));
      assert.equal(snapshot.artifactManifest?.version, "yingshu-douyin-evidence-v1");
      assert.equal(JSON.stringify(snapshot.artifactManifest).includes("secret"), false);
    } finally { value.connection.close(); await rm(value.dataRoot, { recursive: true, force: true }); }
  }
});

test("失败重试复用已校验 checkpoint，视频 Hash 变化时只重做受影响下游", async () => {
  const value = await fixture({ extractFrames: true, transcribeAudio: false, analyzeComments: false });
  let first = true;
  value.dependencies.analyze = async (input) => { value.calls.analyze += 1; if (first) { first = false; throw new Error("fixture model failure"); }
    return { report: report(input), modelSnapshot: { providerId: "text", model: "model", protocol: "openai-response",
      baseUrl: "https://example.com", modelIdentityHash: "b".repeat(64), promptVersion: "yingshu-douyin-analysis-prompt-v1",
      systemVersion: "yingshu-douyin-analysis-system-v1", inputHash: "c".repeat(64), transcriptStrategy: "complete", omittedTranscriptRanges: [] } }; };
  const worker = new JobWorker(value.connection.database, { douyin_video_analysis: createDouyinAnalysisJobHandler(value.connection.database,
    value.dataRoot, value.dependencies) }, { workerId: "retry-worker", leaseMs: 5_000, heartbeatMs: 100, retryDelayMs: 0 });
  try {
    await worker.runOne(); await worker.runOne();
    assert.deepEqual({ download: value.calls.download, frames: value.calls.frames, analyze: value.calls.analyze }, { download: 1, frames: 1, analyze: 2 },
      JSON.stringify(getJob(value.connection.database, value.created.job!.id)));
    const videoPath = join(value.dataRoot, "douyin", "analyses", value.video.id, value.created.snapshot.id, "video.mp4");
    await writeFile(videoPath, Buffer.concat([mp4, Buffer.from([1])]));
    connectionReset(value.connection.database, value.created.job!.id);
    await worker.runOne();
    assert.equal(value.calls.download, 2);
  } finally { value.connection.close(); await rm(value.dataRoot, { recursive: true, force: true }); }
});

function connectionReset(database: ReturnType<typeof openDatabase>["database"], jobId: string) {
  database.prepare("UPDATE jobs SET status='queued',progress=0,attempts=0,finished_at=NULL,lease_owner=NULL,lease_expires_at=NULL WHERE id=?").run(jobId);
  database.prepare("UPDATE video_douyin_analysis_snapshots SET status='queued',completed_at=NULL WHERE id=(SELECT snapshot_id FROM video_douyin_analysis_jobs WHERE job_id=?)").run(jobId);
}

test("运行中取消会中止 provider 并保留 cancelled 快照", async () => {
  const value = await fixture({ extractFrames: false, transcribeAudio: true, analyzeComments: false });
  let started!: () => void;
  const active = new Promise<void>((resolve) => { started = resolve; });
  value.dependencies.analyze = async (input) => {
    started();
    await new Promise<void>((_resolve, reject) => input.signal!.addEventListener("abort", () => reject(new DOMException("取消", "AbortError")), { once: true }));
    throw new Error("unreachable");
  };
  const worker = new JobWorker(value.connection.database, { douyin_video_analysis: createDouyinAnalysisJobHandler(value.connection.database,
    value.dataRoot, value.dependencies) }, { workerId: "cancel-worker", leaseMs: 5_000, heartbeatMs: 100, retryDelayMs: 0 });
  try {
    const running = worker.runOne(); await active; requestJobCancellation(value.connection.database, value.created.job!.id); await running;
    assert.equal(getJob(value.connection.database, value.created.job!.id)?.status, "cancelled");
    assert.equal(getCurrentDouyinAnalysisSnapshot(value.connection.database, value.project.id, value.video.id)?.status, "cancelled");
  } finally { value.connection.close(); await rm(value.dataRoot, { recursive: true, force: true }); }
});

test("元数据登录和验证阻断写入显式快照状态而不伪装平台失败", async () => {
  for (const status of ["need_login", "need_verify"] as const) {
    const value = await fixture({ extractFrames: true, transcribeAudio: false, analyzeComments: false });
    value.dependencies.fetchMetadata = async () => { throw new DouyinSourceError(status, "fixture 阻断"); };
    const worker = new JobWorker(value.connection.database, { douyin_video_analysis: createDouyinAnalysisJobHandler(value.connection.database,
      value.dataRoot, value.dependencies) }, { workerId: `blocked-${status}`, leaseMs: 5_000, heartbeatMs: 100 });
    try {
      await worker.runOne();
      assert.equal(getCurrentDouyinAnalysisSnapshot(value.connection.database, value.project.id, value.video.id)?.status, status);
      assert.equal(getJob(value.connection.database, value.created.job!.id)?.status, "succeeded");
    } finally { value.connection.close(); await rm(value.dataRoot, { recursive: true, force: true }); }
  }
});
