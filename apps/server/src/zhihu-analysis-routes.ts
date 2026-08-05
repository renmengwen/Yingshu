import type { DatabaseSync } from "node:sqlite";
import type { FastifyPluginAsync } from "fastify";

import {
  parseZhihuAnalysisConfig, parseZhihuAnalysisSelection, parseZhihuAnswerUrl, ZhihuAnalysisContractError,
} from "./zhihu-analysis-contract.js";
import {
  cancelZhihuAnalysisJob, enqueueZhihuAnalysis, getCurrentZhihuAnalysisSnapshot, getZhihuAnalysisJob,
  getZhihuAnalysisSelection, getZhihuAnalysisSnapshot, saveZhihuAnalysisSelection,
} from "./zhihu-analysis-store.js";
import { ZhihuSourceError } from "./zhihu-source.js";
import type { ChapterTextModelConfig } from "./chapter-event-analyzer.js";
import { createZhihuAnalysisModelSnapshot, ZHIHU_ANALYSIS_PROMPT_VERSION } from "./zhihu-analysis-provider.js";

interface Params { projectId: string; videoId: string }
interface SnapshotParams extends Params { snapshotId: string }

function manifest(snapshot: ReturnType<typeof getZhihuAnalysisSnapshot>) {
  return snapshot.artifactManifest as { answer?: unknown; images?: unknown[]; comments?: {
    status?: unknown; items?: unknown[]; failedReplyCount?: unknown; replyFailureKinds?: unknown[];
  } } | null;
}

function summary(database: DatabaseSync, projectId: string, videoId: string) {
  const snapshot = getCurrentZhihuAnalysisSnapshot(database, projectId, videoId);
  const job = getZhihuAnalysisJob(database, projectId, videoId);
  const selection = getZhihuAnalysisSelection(database, projectId, videoId);
  const blockReasons: string[] = [];
  if (!snapshot) blockReasons.push("尚未创建知乎分析");
  else if (["queued", "running"].includes(snapshot.status)) blockReasons.push("知乎分析仍在进行中");
  else if (!snapshot.report) blockReasons.push("分析报告尚不可用");
  return {
    snapshot: snapshot && { id: snapshot.id, sourceUrl: snapshot.sourceUrl, config: snapshot.config, status: snapshot.status,
      completeness: snapshot.completeness, evidenceHash: snapshot.evidenceHash, reportHash: snapshot.reportHash,
      availability: snapshot.report?.availability ?? null, evidence: snapshot.report?.evidence ?? null,
      createdAt: snapshot.createdAt, completedAt: snapshot.completedAt, invalidatedAt: snapshot.invalidatedAt },
    job: job && { id: job.id, status: job.status, progress: job.progress, attempts: job.attempts,
      maxAttempts: job.maxAttempts, cancelRequested: job.cancelRequested, errorCode: job.errorCode,
      errorMessage: job.errorMessage, createdAt: job.createdAt, updatedAt: job.updatedAt },
    selection, blockReasons,
    allowedActions: { start: !job || !["queued", "running"].includes(job.status),
      cancel: Boolean(job && ["queued", "running"].includes(job.status)),
      selectUsage: Boolean(snapshot?.report && ["succeeded", "partial"].includes(snapshot.status)) },
  };
}

export const registerZhihuAnalysisRoutes: FastifyPluginAsync<{
  database: DatabaseSync; resolveTextModel?: () => Promise<ChapterTextModelConfig | null>;
}> = async (app, options) => {
  const handle = (error: unknown, reply: { code(status: number): { send(value: unknown): unknown } }) => {
    const candidate = error as { statusCode?: unknown; message?: unknown };
    if (error instanceof ZhihuAnalysisContractError || typeof candidate?.statusCode === "number") {
      return reply.code(Number(candidate.statusCode)).send({ ok: false, message: String(candidate.message ?? "请求无法处理") });
    }
    if (error instanceof ZhihuSourceError) return reply.code(error.kind === "invalid_url" ? 400 : 502)
      .send({ ok: false, message: error.message });
    throw error;
  };

  app.get<{ Params: Params }>("/api/projects/:projectId/videos/:videoId/zhihu-analysis", async (request, reply) => {
    try { return { ok: true, ...summary(options.database, request.params.projectId, request.params.videoId) }; }
    catch (error) { return handle(error, reply); }
  });
  app.post<{ Params: Params; Body: unknown }>("/api/projects/:projectId/videos/:videoId/zhihu-analysis/jobs", async (request, reply) => {
    try {
      const config = parseZhihuAnalysisConfig(request.body); const source = parseZhihuAnswerUrl(config.sourceUrl);
      const model = await options.resolveTextModel?.();
      const result = enqueueZhihuAnalysis(options.database, { projectId: request.params.projectId, videoId: request.params.videoId,
        questionId: source.questionId, answerId: source.answerId, config,
        modelSnapshot: model ? createZhihuAnalysisModelSnapshot(model) : null,
        promptVersion: model ? ZHIHU_ANALYSIS_PROMPT_VERSION : null });
      return reply.code(result.created ? 202 : 200).send({ ok: true,
        message: result.reusable ? "相同配置的分析结果可直接复用" : "知乎分析任务已创建", ...result });
    } catch (error) { return handle(error, reply); }
  });
  app.post<{ Params: Params & { jobId: string } }>("/api/projects/:projectId/videos/:videoId/zhihu-analysis/jobs/:jobId/cancel", async (request, reply) => {
    try { return { ok: true, message: "知乎分析中断请求已记录", job: cancelZhihuAnalysisJob(options.database,
      request.params.projectId, request.params.videoId, request.params.jobId) }; }
    catch (error) { return handle(error, reply); }
  });
  app.put<{ Params: Params; Body: unknown }>("/api/projects/:projectId/videos/:videoId/zhihu-analysis/selection", async (request, reply) => {
    try { return { ok: true, message: "知乎使用方式已保存", selection: saveZhihuAnalysisSelection(options.database,
      { projectId: request.params.projectId, videoId: request.params.videoId, selection: parseZhihuAnalysisSelection(request.body) }) }; }
    catch (error) { return handle(error, reply); }
  });
  app.get<{ Params: SnapshotParams }>("/api/projects/:projectId/videos/:videoId/zhihu-analysis/snapshots/:snapshotId/report", async (request, reply) => {
    try { const item = getZhihuAnalysisSnapshot(options.database, request.params.projectId, request.params.videoId, request.params.snapshotId);
      if (!item.report) throw new ZhihuAnalysisContractError(409, "分析报告尚不可用"); return { ok: true, report: item.report }; }
    catch (error) { return handle(error, reply); }
  });
  app.get<{ Params: SnapshotParams }>("/api/projects/:projectId/videos/:videoId/zhihu-analysis/snapshots/:snapshotId/answer", async (request, reply) => {
    try { const item = getZhihuAnalysisSnapshot(options.database, request.params.projectId, request.params.videoId, request.params.snapshotId);
      const answer = manifest(item)?.answer; if (!answer) throw new ZhihuAnalysisContractError(409, "回答正文尚不可用");
      return { ok: true, answer, images: manifest(item)?.images ?? [] }; }
    catch (error) { return handle(error, reply); }
  });
  app.get<{ Params: SnapshotParams; Querystring: { page?: string; pageSize?: string } }>("/api/projects/:projectId/videos/:videoId/zhihu-analysis/snapshots/:snapshotId/comments", async (request, reply) => {
    try {
      const page = Number(request.query.page ?? 1); const pageSize = Number(request.query.pageSize ?? 10);
      if (!Number.isSafeInteger(page) || page < 1 || !Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 50) {
        throw new ZhihuAnalysisContractError(400, "评论分页参数无效");
      }
      const item = getZhihuAnalysisSnapshot(options.database, request.params.projectId, request.params.videoId, request.params.snapshotId);
      const comments = manifest(item)?.comments; const all = comments?.items ?? []; const offset = (page - 1) * pageSize;
      return { ok: true, status: comments?.status ?? "not_requested",
        failedReplyCount: comments?.failedReplyCount ?? 0, replyFailureKinds: comments?.replyFailureKinds ?? [],
        page, pageSize, total: all.length, items: all.slice(offset, offset + pageSize) };
    } catch (error) { return handle(error, reply); }
  });
};
