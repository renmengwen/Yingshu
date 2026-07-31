import type { FastifyInstance, FastifyReply } from "fastify";
import type { DatabaseSync } from "node:sqlite";

import { requestJobCancellation, type JobRecord } from "./job-store.js";
import { ProjectVideoStoreError } from "./project-video-store.js";
import { TtsProviderError } from "./tts-provider.js";
import { getVideoPlan } from "./video-plan-store.js";
import {
  approveVideoAudio, getVideoAudioReview, saveVideoAudioReview, VideoAudioReviewError,
} from "./video-audio-review.js";
import {
  createVideoTtsJob, getVideoTtsState, openVideoTtsMedia, VideoTtsStoreError, type VideoTtsProviderIdentity,
} from "./video-tts-store.js";

type Params = { projectId: string; videoId: string };

function selectionBody(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new VideoTtsStoreError(422, "配音配置无效");
  const input = value as Record<string, unknown>;
  const fields = ["voiceId", "rate", "language"];
  if (Object.keys(input).some((key) => !fields.includes(key))) throw new VideoTtsStoreError(422, "配音配置字段无效");
  return input as { voiceId: unknown; rate: unknown; language: unknown };
}

function sendError(error: unknown, reply: FastifyReply) {
  if (error instanceof VideoAudioReviewError || error instanceof VideoTtsStoreError || error instanceof ProjectVideoStoreError) {
    return reply.code(error.statusCode).send({ ok: false, message: error.message });
  }
  if (error instanceof TtsProviderError) return reply.code(409).send({ ok: false, message: error.message });
  throw error;
}

function publicJob(job: JobRecord | null) {
  return job ? { id: job.id, status: job.status, errorSummary: job.errorMessage ?? null,
    cancelRequested: job.cancelRequested, attempts: job.attempts } : null;
}

async function publicWorkspace(options: {
  database: DatabaseSync;
  resolveDefaultProvider: () => VideoTtsProviderIdentity | null | Promise<VideoTtsProviderIdentity | null>;
}, projectId: string, videoId: string) {
  const state = getVideoTtsState(options.database, projectId, videoId);
  const provider = await options.resolveDefaultProvider();
  const review = getVideoAudioReview(options.database, projectId, videoId);
  const plan = getVideoPlan(options.database, projectId, videoId);
  const planAvailable = !!plan?.approval?.valid && !plan.stale;
  const available = planAvailable && !!provider;
  const video = options.database.prepare("SELECT target_duration_seconds FROM videos WHERE id=? AND project_id=?")
    .get(videoId, projectId) as { target_duration_seconds: number };
  const history = (options.database.prepare(
    `SELECT artifact.id,artifact.duration_ms,snapshot.provider_id,snapshot.model_id,snapshot.voice_id,
            snapshot.rate,snapshot.language,artifact.created_at
     FROM video_tts_artifacts artifact JOIN video_tts_snapshots snapshot ON snapshot.id=artifact.snapshot_id
     WHERE artifact.project_id=? AND artifact.video_id=? AND artifact.id<>COALESCE(?, '')
     ORDER BY artifact.created_at DESC,artifact.rowid DESC`,
  ).all(projectId, videoId, state?.artifact?.id ?? null) as unknown as Array<{
    id: string; duration_ms: number; provider_id: string; model_id: string; voice_id: string;
    rate: number; language: string; created_at: number;
  }>).map((item) => ({ id: item.id, stale: true, durationSeconds: item.duration_ms / 1_000,
    providerId: item.provider_id, modelId: item.model_id, voiceId: item.voice_id, rate: item.rate,
    language: item.language, createdAt: item.created_at }));
  return {
    available,
    blockedReason: planAvailable ? provider ? null : "TTS 模型未配置或能力不匹配，请先前往设置" : "当前旁白方案尚未有效批准或已经失效",
    provider: provider ? { id: provider.providerId, name: provider.providerName, modelId: provider.modelId,
      voiceId: provider.voiceId, rate: provider.rate, language: provider.language, costKnown: false as const } : null,
    targetDurationSeconds: state?.snapshot.targetDurationSeconds ?? video.target_duration_seconds,
    snapshot: state ? { id: state.snapshot.id, providerId: state.snapshot.providerId, modelId: state.snapshot.modelId,
      voiceId: state.snapshot.voiceId, rate: state.snapshot.rate, language: state.snapshot.language, stale: state.stale } : null,
    job: publicJob(state?.job ?? null),
    artifact: state?.artifact ? { id: state.artifact.id, stale: state.stale,
      durationSeconds: state.artifact.audio.durationMs / 1_000 } : null,
    cues: state?.artifact?.cues.map((cue) => ({ id: cue.hash, paragraphId: cue.paragraphId, text: cue.text,
      startSeconds: cue.startMs / 1_000, endSeconds: cue.endMs / 1_000 })) ?? [],
    review: review.latestReview ? { notes: review.latestReview.notes, durationDecision: review.latestReview.durationDecision } : null,
    audioGate: { valid: review.audioGate.complete },
    history,
  };
}

export async function registerVideoTtsRoutes(app: FastifyInstance, options: {
  database: DatabaseSync;
  dataRoot: string;
  resolveDefaultProvider: () => VideoTtsProviderIdentity | null | Promise<VideoTtsProviderIdentity | null>;
  resolveProvider: (selection: { voiceId: unknown; rate: unknown; language: unknown }) => VideoTtsProviderIdentity | Promise<VideoTtsProviderIdentity>;
}) {
  app.get<{ Params: Params }>("/api/projects/:projectId/videos/:videoId/tts", async (request, reply) => {
    try { return { ok: true, workspace: await publicWorkspace(options, request.params.projectId, request.params.videoId) }; }
    catch (error) { return sendError(error, reply); }
  });

  app.get<{ Params: Params }>("/api/projects/:projectId/videos/:videoId/tts-jobs", async (request, reply) => {
    try { return { ok: true, workspace: await publicWorkspace(options, request.params.projectId, request.params.videoId) }; }
    catch (error) { return sendError(error, reply); }
  });

  app.post<{ Params: Params; Body: VideoTtsProviderIdentity }>(
    "/api/projects/:projectId/videos/:videoId/tts-jobs", async (request, reply) => {
      try {
        // provider/model/baseUrl 只能来自服务端当前设置；客户端只选择 capability 范围内的音色、语速和语言。
        const provider = await options.resolveProvider(selectionBody(request.body));
        const result = createVideoTtsJob(options.database, request.params.projectId, request.params.videoId, provider);
        return { ok: true, message: result.reused ? "已返回相同配音身份的任务或产物" : "配音与字幕任务已创建",
          workspace: await publicWorkspace(options, request.params.projectId, request.params.videoId) };
      } catch (error) { return sendError(error, reply); }
    },
  );

  app.post<{ Params: Params & { jobId: string } }>(
    "/api/projects/:projectId/videos/:videoId/tts-jobs/:jobId/cancel", async (request, reply) => {
      try {
        const state = getVideoTtsState(options.database, request.params.projectId, request.params.videoId);
        if (!state?.job || state.job.id !== request.params.jobId) throw new VideoTtsStoreError(404, "配音任务不存在或不属于当前视频");
        if (state.job.status !== "queued" && state.job.status !== "running") throw new VideoTtsStoreError(409, "当前配音任务已经结束");
        const job = requestJobCancellation(options.database, state.job.id);
        return { ok: true, message: "已请求取消配音任务，不会继续生成后续字幕", job,
          workspace: await publicWorkspace(options, request.params.projectId, request.params.videoId) };
      } catch (error) { return sendError(error, reply); }
    },
  );

  app.get<{ Params: Params }>("/api/projects/:projectId/videos/:videoId/audio-review", async (request, reply) => {
    try { return { ok: true, review: getVideoAudioReview(options.database, request.params.projectId, request.params.videoId) }; }
    catch (error) { return sendError(error, reply); }
  });

  app.post<{ Params: Params; Body: unknown }>("/api/projects/:projectId/videos/:videoId/audio-review", async (request, reply) => {
    try {
      saveVideoAudioReview(
        options.database, request.params.projectId, request.params.videoId, request.body,
      );
      return { ok: true, message: "已记录需要重新生成，不会自动启动新任务",
        workspace: await publicWorkspace(options, request.params.projectId, request.params.videoId) };
    } catch (error) { return sendError(error, reply); }
  });

  app.post<{ Params: Params; Body: unknown }>("/api/projects/:projectId/videos/:videoId/audio-approval", async (request, reply) => {
    try {
      approveVideoAudio(
        options.database, request.params.projectId, request.params.videoId, request.body,
      );
      return { ok: true, message: "当前音频与字幕已批准；不会自动启动视觉时间轴或渲染",
        workspace: await publicWorkspace(options, request.params.projectId, request.params.videoId) };
    } catch (error) { return sendError(error, reply); }
  });

  app.get<{ Params: Params }>("/api/projects/:projectId/videos/:videoId/tts/audio", async (request, reply) => {
    try {
      const media = await openVideoTtsMedia(options.database, options.dataRoot, request.params.projectId, request.params.videoId, "audio");
      return reply.header("content-type", media.mime).header("content-length", media.bytes)
        .header("etag", `\"${media.hash}\"`).header("cache-control", "private, no-store").send(media.stream);
    } catch (error) { return sendError(error, reply); }
  });
  app.get<{ Params: Params & { format: string } }>(
    "/api/projects/:projectId/videos/:videoId/tts/subtitles/:format", async (request, reply) => {
      try {
        if (request.params.format !== "srt" && request.params.format !== "ass") throw new VideoTtsStoreError(404, "字幕格式不存在");
        const media = await openVideoTtsMedia(options.database, options.dataRoot, request.params.projectId,
          request.params.videoId, request.params.format);
        return reply.header("content-type", media.mime).header("content-length", media.bytes)
          .header("etag", `\"${media.hash}\"`).header("cache-control", "private, no-store")
          .header("content-disposition", `attachment; filename=\"subtitles.${request.params.format}\"`).send(media.stream);
      } catch (error) { return sendError(error, reply); }
    },
  );
  app.get<{ Params: Params & { artifactId: string } }>(
    "/api/projects/:projectId/videos/:videoId/tts/artifacts/:artifactId/audio", async (request, reply) => {
      try {
        const media = await openVideoTtsMedia(options.database, options.dataRoot, request.params.projectId,
          request.params.videoId, "audio", request.params.artifactId);
        return reply.header("content-type", media.mime).header("content-length", media.bytes)
          .header("etag", `\"${media.hash}\"`).header("cache-control", "private, no-store").send(media.stream);
      } catch (error) { return sendError(error, reply); }
    },
  );
}
