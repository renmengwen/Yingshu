import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";

import { buildDouyinAudienceInput, fetchDouyinComments, type DouyinCommentsResult } from "./douyin-comments.js";
import { prepareDouyinAsrSegments, transcribeDouyinAsrSegments, type DouyinAsrResult } from "./douyin-asr.js";
import {
  canonicalDouyinJson, douyinSha256, type DouyinAnalysisReport,
} from "./douyin-analysis-contract.js";
import {
  DOUYIN_ANALYSIS_PROMPT_VERSION, createDouyinAnalysisProvider,
  type DouyinAnalysisProviderInput, type DouyinAnalysisProviderResult,
} from "./douyin-analysis-provider.js";
import {
  getDouyinAnalysisSnapshot, updateDouyinAnalysisSnapshot,
} from "./douyin-analysis-store.js";
import {
  downloadDouyinVideo, extractDouyinFrames, probeDouyinVideo, verifyDouyinMediaFile,
  type DouyinFramesResult, type DouyinVideoProbe, type MediaFileIdentity,
} from "./douyin-media.js";
import {
  DouyinSourceError, fetchDouyinVideoDetail, resolveDouyinSource, type DouyinVideoDetail,
} from "./douyin-source.js";
import { JobCancelledError, type JobExecutionContext, type JobHandler } from "./job-worker.js";
import type { RuntimeModelConfig } from "./model-config.js";
import type { ChapterTextModelConfig } from "./chapter-event-analyzer.js";

const MANIFEST_VERSION = "yingshu-douyin-evidence-v1" as const;
const HASH = /^[0-9a-f]{64}$/u;

interface JsonIdentity { relativePath: string; bytes: number; sha256: string }
interface Artifact extends JsonIdentity { id: string; kind: "metadata" | "video" | "audio" | "transcript" | "frame" | "comments" | "report"; mime?: string; status: "succeeded" | "partial" }

export interface DouyinAnalysisJobDependencies {
  resolveSource: typeof resolveDouyinSource;
  fetchMetadata: typeof fetchDouyinVideoDetail;
  downloadVideo: typeof downloadDouyinVideo;
  probeVideo: typeof probeDouyinVideo;
  extractFrames: typeof extractDouyinFrames;
  prepareAsr: typeof prepareDouyinAsrSegments;
  transcribeAsr: typeof transcribeDouyinAsrSegments;
  fetchComments: typeof fetchDouyinComments;
  resolveAsrRuntime(): Promise<RuntimeModelConfig | null>;
  analyze(input: DouyinAnalysisProviderInput): Promise<DouyinAnalysisProviderResult>;
}

function payload(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("抖音分析 Job 载荷无效");
  const item = value as Record<string, unknown>;
  for (const key of ["projectId", "videoId", "snapshotId"] as const) if (typeof item[key] !== "string" || !item[key]) throw new Error("抖音分析 Job 载荷无效");
  return item as { projectId: string; videoId: string; snapshotId: string };
}

function controlled(dataRoot: string, relativePath: string) {
  if (!relativePath || relativePath.includes("\\") || relativePath.split("/").some((part) => !part || part === "." || part === "..")) throw new Error("抖音分析路径无效");
  const root = resolve(dataRoot);
  const path = resolve(root, ...relativePath.split("/"));
  const value = relative(root, path);
  if (!value || value === ".." || value.startsWith(`..${sep}`)) throw new Error("抖音分析路径越界");
  return path;
}

async function writeJson(dataRoot: string, relativePath: string, value: unknown): Promise<JsonIdentity> {
  const text = `${JSON.stringify(value)}\n`;
  const path = controlled(dataRoot, relativePath);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, text, { encoding: "utf8", mode: 0o600 });
  return { relativePath, bytes: Buffer.byteLength(text), sha256: douyinSha256(text) };
}

async function verifyFile(dataRoot: string, identity: JsonIdentity) {
  if (!HASH.test(identity.sha256) || !Number.isSafeInteger(identity.bytes) || identity.bytes < 1) return false;
  try {
    const path = controlled(dataRoot, identity.relativePath);
    const info = await stat(path);
    if (!info.isFile() || info.isSymbolicLink() || info.size !== identity.bytes) return false;
    return createHash("sha256").update(await readFile(path)).digest("hex") === identity.sha256;
  } catch { return false; }
}

function checkpointValue<T>(context: JobExecutionContext, stage: string, inputHash: string) {
  const checkpoint = context.getCheckpoint(stage, "snapshot");
  return checkpoint?.inputHash === inputHash ? checkpoint.output as T : undefined;
}

function commit(context: JobExecutionContext, stage: string, inputHash: string, output: unknown) {
  context.commitCheckpoint(stage, "snapshot", inputHash, () => undefined, output);
}

function cancellation(context: JobExecutionContext) {
  context.throwIfCancellationRequested();
  const controller = new AbortController();
  const timer = setInterval(() => { if (context.isCancellationRequested()) controller.abort(); }, 50);
  return { signal: controller.signal, close: () => clearInterval(timer) };
}

async function cancellable<T>(context: JobExecutionContext, run: (signal: AbortSignal) => Promise<T>) {
  const active = cancellation(context);
  try { return await run(active.signal); }
  catch (error) {
    if (active.signal.aborted || context.isCancellationRequested()) throw new JobCancelledError();
    throw error;
  } finally { active.close(); }
}

function artifact(id: string, kind: Artifact["kind"], identity: JsonIdentity, status: Artifact["status"] = "succeeded", mime?: string): Artifact {
  return { id, kind, ...identity, ...(mime ? { mime } : {}), status };
}

function sanitizedMetadata(detail: DouyinVideoDetail) {
  const { videoDownloadUrl: _video, audioDownloadUrl: _audio, ...safe } = detail;
  return safe;
}

function transcriptEvidence(asr: DouyinAsrResult | null) {
  if (!asr) return { status: "not_requested", textHash: douyinSha256(""), segments: [], missingRanges: [] };
  return {
    status: asr.status,
    textHash: douyinSha256(asr.text.slice(0, 1_000_000)),
    segments: asr.segments.map((segment) => ({ id: `asr-${segment.index + 1}`, startMs: segment.startMs,
      endMs: segment.endMs, text: segment.text.slice(0, 20_000), status: segment.status === "succeeded" ? "succeeded" : "failed" })),
    missingRanges: asr.missingRanges,
  };
}

function commentsEvidence(result: DouyinCommentsResult | null) {
  return { interpretationOnly: true as const, status: result?.status ?? "not_requested", truncated: result?.truncated ?? false,
    items: (result?.comments ?? []).map((item) => ({ id: item.id, parentId: item.parentId, text: item.text,
      likeCount: item.likeCount, publishedAt: item.publishedAt, authorId: item.authorId, isReply: item.isReply,
      replies: item.replies })) };
}

function evidenceRefs(metadata: DouyinVideoDetail, transcript: ReturnType<typeof transcriptEvidence>, frames: DouyinFramesResult | null,
  comments: DouyinCommentsResult | null) {
  return new Set(["metadata:title", "metadata:description", "metadata:durationMs",
    ...transcript.segments.filter((item) => item.status === "succeeded").map((item) => item.id),
    ...(frames?.frames.filter((item) => item.status === "succeeded").map((item) => `frame:${item.index}`) ?? []),
    ...(comments?.comments.flatMap((item) => [item, ...item.replies]).map((item) => `comment:${item.id}`) ?? []),
  ].filter((ref) => ref !== "metadata:durationMs" || metadata.durationMs !== null));
}

function completeness(config: { extractFrames: boolean; transcribeAudio: boolean; analyzeComments: boolean }, frames: DouyinFramesResult | null,
  asr: DouyinAsrResult | null, comments: DouyinCommentsResult | null) {
  const failed = config.extractFrames && frames?.status !== "succeeded" || config.transcribeAudio && asr?.status !== "succeeded" ||
    config.analyzeComments && !["succeeded", "empty"].includes(comments?.status ?? "failed");
  return failed ? "partial" as const : "complete" as const;
}

export function createDouyinAnalysisJobHandler(database: DatabaseSync, dataRoot: string,
  dependencies: DouyinAnalysisJobDependencies): JobHandler {
  const execute: JobHandler = async (context) => {
    const ids = payload(context.job.payload);
    const snapshot = getDouyinAnalysisSnapshot(database, ids.projectId, ids.videoId, ids.snapshotId);
    const root = `douyin/analyses/${ids.videoId}/${ids.snapshotId}`;
    updateDouyinAnalysisSnapshot(database, { snapshotId: snapshot.id, status: "running", completeness: "unavailable" });
    const inputHash = snapshot.configHash;
    const artifacts: Artifact[] = [];

    let normalized = checkpointValue<Awaited<ReturnType<typeof resolveDouyinSource>>>(context, "normalize_source", inputHash);
    if (!normalized) { normalized = await dependencies.resolveSource(snapshot.sourceText); commit(context, "normalize_source", inputHash, normalized); }
    if (normalized.awemeId !== snapshot.awemeId) throw new Error("抖音来源身份与冻结快照不一致");
    context.reportProgress(0.08);

    let detail = checkpointValue<DouyinVideoDetail>(context, "fetch_metadata", inputHash);
    try {
      if (!detail) {
        detail = await cancellable(context, (signal) => dependencies.fetchMetadata(dataRoot, snapshot.awemeId, {
          signal,
          onLoginRequired: () => { updateDouyinAnalysisSnapshot(database, {
            snapshotId: snapshot.id, status: "need_login", completeness: "unavailable", completedAt: null,
          }); },
          onLoginSucceeded: () => { updateDouyinAnalysisSnapshot(database, {
            snapshotId: snapshot.id, status: "running", completeness: "unavailable", completedAt: null,
          }); },
        }));
        commit(context, "fetch_metadata", inputHash, detail);
      }
    } catch (error) {
      if (error instanceof DouyinSourceError && (error.kind === "need_login" || error.kind === "need_verify")) {
        updateDouyinAnalysisSnapshot(database, { snapshotId: snapshot.id, status: error.kind, completeness: "unavailable", completedAt: Date.now() });
        return { snapshotId: snapshot.id, status: error.kind };
      }
      throw error;
    }
    const metadataIdentity = await writeJson(dataRoot, `${root}/metadata.json`, sanitizedMetadata(detail));
    artifacts.push(artifact("metadata", "metadata", metadataIdentity, "succeeded", "application/json"));
    context.reportProgress(0.16);

    let video: MediaFileIdentity | null = null;
    let probe: DouyinVideoProbe | null = null;
    let mediaFailure: string | null = null;
    if (snapshot.config.extractFrames || snapshot.config.transcribeAudio) {
      const videoPath = `${root}/video.mp4`;
      video = checkpointValue<MediaFileIdentity>(context, "download_video", inputHash) ?? null;
      if (video && !await verifyDouyinMediaFile(dataRoot, video.relativePath, { mime: "video/mp4", bytes: video.bytes, sha256: video.sha256 }).then(() => true, () => false)) video = null;
      if (!video) {
        try {
          if (!detail.videoDownloadUrl) throw new Error("抖音详情没有可验证的视频下载地址");
          video = await cancellable(context, (signal) => dependencies.downloadVideo({ source: { url: detail!.videoDownloadUrl!, source: "douyin-detail" }, dataRoot, relativePath: videoPath, signal }));
          commit(context, "download_video", inputHash, video);
        } catch (error) {
          if (error instanceof JobCancelledError) throw error;
          mediaFailure = error instanceof Error ? error.message : "视频下载失败";
        }
      }
      if (video) {
        artifacts.push(artifact("video", "video", video, "succeeded", "video/mp4"));
        probe = checkpointValue<DouyinVideoProbe>(context, "probe_video", video.sha256) ?? null;
        if (!probe) {
          try { probe = await cancellable(context, (signal) => dependencies.probeVideo(dataRoot, video!.relativePath, signal)); commit(context, "probe_video", video.sha256, probe); }
          catch (error) { if (error instanceof JobCancelledError) throw error; mediaFailure = error instanceof Error ? error.message : "视频探测失败"; }
        }
      }
    }
    context.reportProgress(0.3);

    let asr: DouyinAsrResult | null = null;
    if (snapshot.config.transcribeAudio && video && probe) {
      try {
        const runtime = await dependencies.resolveAsrRuntime();
        if (runtime?.segmentDurationSeconds) {
        const directory = controlled(dataRoot, `${root}/audio`);
        let prepared = checkpointValue<Awaited<ReturnType<typeof prepareDouyinAsrSegments>>>(context, "extract_audio", video.sha256);
        if (prepared && !(await Promise.all(prepared.map((segment) => verifyFile(dataRoot,
          { relativePath: `${root}/audio/${segment.fileName}`, bytes: segment.bytes, sha256: segment.sha256 })))).every(Boolean)) prepared = undefined;
        if (!prepared) {
          prepared = await cancellable(context, (signal) => dependencies.prepareAsr({ transcribeAudio: true,
            videoPath: controlled(dataRoot, video!.relativePath), outputDirectory: directory, durationMs: probe!.durationMs,
            segmentDurationSeconds: runtime.segmentDurationSeconds!, signal }));
          commit(context, "extract_audio", video.sha256, prepared);
        }
        for (const segment of prepared) artifacts.push(artifact(`audio-${segment.index + 1}`, "audio",
          { relativePath: `${root}/audio/${segment.fileName}`, bytes: segment.bytes, sha256: segment.sha256 }, "succeeded", "audio/mpeg"));
        const asrIdentity = runtime.identityHash ?? video.sha256;
        asr = checkpointValue<DouyinAsrResult>(context, "transcribe_audio", asrIdentity) ?? null;
        if (!asr) {
          asr = await cancellable(context, (signal) => dependencies.transcribeAsr({ segments: prepared, audioDirectory: directory, runtime, signal }));
          commit(context, "transcribe_audio", asrIdentity, asr);
        }
        } else {
          asr = { status: "failed", text: "", segments: [], missingRanges: [{ startMs: 0, endMs: probe.durationMs }],
            model: { providerId: "unconfigured", model: "unconfigured", protocol: "openai-transcription", baseUrl: "", identityHash: douyinSha256("unconfigured") } };
        }
      } catch (error) {
        if (error instanceof JobCancelledError) throw error;
        asr = { status: "failed", text: "", segments: [], missingRanges: [{ startMs: 0, endMs: probe.durationMs }],
          model: { providerId: "failed", model: "failed", protocol: "openai-transcription", baseUrl: "", identityHash: douyinSha256("failed") } };
      }
      const transcriptIdentity = await writeJson(dataRoot, `${root}/transcript.json`, asr);
      artifacts.push(artifact("transcript", "transcript", transcriptIdentity, asr.status === "succeeded" ? "succeeded" : "partial", "application/json"));
    } else if (snapshot.config.transcribeAudio) asr = { status: "failed", text: "", segments: [],
      missingRanges: detail.durationMs ? [{ startMs: 0, endMs: detail.durationMs }] : [],
      model: { providerId: "unavailable", model: "unavailable", protocol: "openai-transcription", baseUrl: "", identityHash: douyinSha256(mediaFailure ?? "unavailable") } };
    context.reportProgress(0.5);

    let frames: DouyinFramesResult | null = null;
    if (snapshot.config.extractFrames && video && probe) {
      const frameIdentity = douyinSha256(`${video.sha256}:${snapshot.config.frameCount}`);
      frames = checkpointValue<DouyinFramesResult>(context, "extract_frames", frameIdentity) ?? null;
      if (frames && !(await Promise.all(frames.frames.filter((item) => item.status === "succeeded").map((item) =>
        item.relativePath && item.bytes && item.sha256 ? verifyDouyinMediaFile(dataRoot, item.relativePath,
          { mime: "image/jpeg", bytes: item.bytes, sha256: item.sha256 }).then(() => true, () => false) : false))).every(Boolean)) frames = null;
      if (!frames) {
        try {
          frames = await cancellable(context, (signal) => dependencies.extractFrames({ dataRoot, videoRelativePath: video!.relativePath,
            framesRelativeDirectory: `${root}/frames`, durationMs: probe!.durationMs, frameCount: snapshot.config.frameCount, signal }));
          commit(context, "extract_frames", frameIdentity, frames);
        } catch (error) {
          if (error instanceof JobCancelledError) throw error;
          frames = { status: "failed", planned: snapshot.config.frameCount, succeeded: 0, failed: snapshot.config.frameCount,
            frames: Array.from({ length: snapshot.config.frameCount }, (_, index) => ({ index, timestampMs: 0,
              status: "failed", attempts: 1, error: error instanceof Error ? error.message : "抽帧失败" })) };
        }
      }
      for (const frame of frames.frames) if (frame.status === "succeeded" && frame.relativePath && frame.bytes && frame.sha256) {
        artifacts.push(artifact(`frame-${frame.index}`, "frame", { relativePath: frame.relativePath, bytes: frame.bytes, sha256: frame.sha256 }, "succeeded", "image/jpeg"));
      }
    } else if (snapshot.config.extractFrames) frames = { status: "failed", planned: snapshot.config.frameCount,
      succeeded: 0, failed: snapshot.config.frameCount, frames: Array.from({ length: snapshot.config.frameCount }, (_, index) => ({
        index, timestampMs: 0, status: "failed", attempts: 1, error: mediaFailure ?? "视频不可用" })) };

    let comments: DouyinCommentsResult | null = null;
    if (snapshot.config.analyzeComments) {
      comments = checkpointValue<DouyinCommentsResult>(context, "fetch_comments", inputHash) ?? null;
      if (!comments) {
        try { comments = await dependencies.fetchComments(dataRoot, snapshot.awemeId); }
        catch (error) { comments = { status: "failed", failureKind: "platform_blocked", comments: [], fetchedAt: Date.now(),
          pagesFetched: 0, truncated: false, interpretationOnly: true, diagnostic: { cache: "miss",
            cacheWriteError: error instanceof Error ? error.message.slice(0, 500) : "评论获取失败" } }; }
        commit(context, "fetch_comments", inputHash, comments);
      }
      const commentsIdentity = await writeJson(dataRoot, `${root}/comments.json`, comments);
      artifacts.push(artifact("comments", "comments", commentsIdentity,
        ["succeeded", "empty"].includes(comments.status) ? "succeeded" : "partial", "application/json"));
    }
    context.reportProgress(0.7);

    const transcript = transcriptEvidence(asr);
    const commentsManifest = commentsEvidence(comments);
    const refs = evidenceRefs(detail, transcript, frames, comments);
    const evidenceHash = douyinSha256(canonicalDouyinJson({ metadata: sanitizedMetadata(detail), video, probe, transcript,
      frames, comments: commentsManifest }));
    const state = completeness(snapshot.config, frames, asr, comments);
    const evidence: DouyinAnalysisReport["evidence"] = {
      metadataStatus: "succeeded", videoStatus: video ? "succeeded" : "not_requested",
      asrStatus: !snapshot.config.transcribeAudio ? "not_requested" : asr?.status ?? "failed",
      asrCoveredDurationMs: asr?.segments.filter((item) => item.status === "succeeded").reduce((sum, item) => sum + item.endMs - item.startMs, 0) ?? 0,
      asrTextCharacters: [...(asr?.text ?? "")].length, plannedFrames: frames?.planned ?? 0,
      succeededFrames: frames?.succeeded ?? 0, failedFrames: frames?.failed ?? 0,
      commentCount: comments?.comments.reduce((sum, item) => sum + 1 + item.replies.length, 0) ?? 0,
      evidenceHash, capturedAt: Date.now(), analyzedAt: Date.now(), modelIdentity: "pending", completeness: state,
    };
    const segments = transcript.segments.filter((item) => item.status === "succeeded").map((item) => ({ evidenceRef: item.id,
      startMs: item.startMs, endMs: item.endMs, text: item.text }));
    const audience = comments ? buildDouyinAudienceInput(comments.comments) : null;
    const providerInput: DouyinAnalysisProviderInput = { evidence, validEvidenceRefs: refs, metadata: sanitizedMetadata(detail),
      deterministic: { durationMs: probe?.durationMs ?? detail.durationMs ?? 1, transcriptSegments: segments,
        media: probe ? { width: probe.width, height: probe.height, frameRate: probe.frameRate,
          audioTrackCount: probe.audioTracks.length, audioDurationMs: probe.audioTracks[0]?.durationMs ?? null } : undefined },
      comments: audience ? { interpretationOnly: true, samples: [
        ...audience.signals.map((item) => ({ evidenceRef: `comment:${item.commentId}`, text: item.text, likes: item.likeCount })),
        ...audience.risks.map((item) => ({ evidenceRef: `comment:${item.commentId}`, text: item.reason, likes: 0 })),
      ] } : undefined, supportsMultimodal: false };
    let analyzed = checkpointValue<DouyinAnalysisProviderResult>(context, "analyze_report", evidenceHash);
    try {
      if (!analyzed) {
        analyzed = await cancellable(context, (signal) => dependencies.analyze({ ...providerInput, signal }));
        commit(context, "analyze_report", evidenceHash, analyzed);
      }
    }
    catch (error) {
      updateDouyinAnalysisSnapshot(database, { snapshotId: snapshot.id, status: state === "partial" ? "partial" : "failed",
        completeness: state, evidenceHash, completedAt: Date.now() });
      throw error;
    }
    commit(context, "validate_report", analyzed.modelSnapshot.inputHash, { reportHash: douyinSha256(canonicalDouyinJson(analyzed.report)) });
    const reportIdentity = await writeJson(dataRoot, `${root}/report.json`, analyzed.report);
    artifacts.push(artifact("report", "report", reportIdentity, "succeeded", "application/json"));

    for (const item of artifacts) if (!await verifyFile(dataRoot, item)) throw new Error(`冻结产物校验失败：${item.id}`);
    const manifest = { version: MANIFEST_VERSION, evidenceHash, artifacts,
      transcript, frames: (frames?.frames ?? []).filter((item) => item.status === "succeeded").map((item) => ({
        index: item.index, timestampMs: item.timestampMs, status: item.status, artifactId: `frame-${item.index}` })), comments: commentsManifest };
    await writeJson(dataRoot, `${root}/manifest.json`, manifest);
    commit(context, "freeze_manifest", evidenceHash, { evidenceHash, artifactCount: artifacts.length });
    updateDouyinAnalysisSnapshot(database, { snapshotId: snapshot.id, status: state === "complete" ? "succeeded" : "partial",
      completeness: state, evidenceHash, report: analyzed.report, artifactManifest: manifest, completedAt: Date.now() });
    context.reportProgress(1);
    return { snapshotId: snapshot.id, status: state === "complete" ? "succeeded" : "partial", evidenceHash };
  };
  return async (context) => {
    try { return await execute(context); }
    catch (error) {
      if (error instanceof JobCancelledError || context.isCancellationRequested()) {
        const ids = payload(context.job.payload);
        updateDouyinAnalysisSnapshot(database, { snapshotId: ids.snapshotId, status: "cancelled",
          completeness: "partial", completedAt: Date.now() });
        throw new JobCancelledError();
      }
      const ids = payload(context.job.payload);
      updateDouyinAnalysisSnapshot(database, { snapshotId: ids.snapshotId, status: "failed",
        completeness: "unavailable", completedAt: Date.now() });
      throw error;
    }
  };
}

export function createConfiguredDouyinAnalysisJobHandler(database: DatabaseSync, dataRoot: string, options: {
  resolveAsrRuntime(): Promise<RuntimeModelConfig | null>;
  resolveTextProvider(): Promise<ChapterTextModelConfig | null>;
}): JobHandler {
  return createDouyinAnalysisJobHandler(database, dataRoot, {
    resolveSource: resolveDouyinSource, fetchMetadata: fetchDouyinVideoDetail, downloadVideo: downloadDouyinVideo,
    probeVideo: probeDouyinVideo, extractFrames: extractDouyinFrames, prepareAsr: prepareDouyinAsrSegments,
    transcribeAsr: transcribeDouyinAsrSegments, fetchComments: fetchDouyinComments,
    resolveAsrRuntime: options.resolveAsrRuntime,
    analyze: async (input) => {
      const provider = await options.resolveTextProvider();
      if (!provider) throw new Error("抖音结构化分析模型未配置");
      return createDouyinAnalysisProvider(provider)(input);
    },
  });
}

export { DOUYIN_ANALYSIS_PROMPT_VERSION };
