import type { DatabaseSync } from "node:sqlite";
import type { FastifyPluginAsync } from "fastify";

import {
  DouyinAnalysisContractError, parseDouyinAnalysisConfig, parseDouyinAnalysisSelection,
} from "./douyin-analysis-contract.js";
import {
  cancelDouyinAnalysisJob, enqueueDouyinAnalysis, getCurrentDouyinAnalysisSnapshot,
  getDouyinAnalysisJob, getDouyinAnalysisSelection, getDouyinAnalysisSnapshot, saveDouyinAnalysisSelection,
} from "./douyin-analysis-store.js";
import { DouyinSourceError, redactDouyinDiagnostic, resolveDouyinSource } from "./douyin-source.js";

interface Params { projectId: string; videoId: string }
interface SnapshotParams extends Params { snapshotId: string }

function manifest(snapshot: ReturnType<typeof getDouyinAnalysisSnapshot>) {
  return snapshot.artifactManifest as { transcript?: unknown; frames?: unknown[]; comments?: { items?: unknown[] } } | null;
}

function summary(database: DatabaseSync, projectId: string, videoId: string) {
  const snapshot = getCurrentDouyinAnalysisSnapshot(database, projectId, videoId);
  const job = getDouyinAnalysisJob(database, projectId, videoId);
  const selection = getDouyinAnalysisSelection(database, projectId, videoId);
  const blockReasons: string[] = [];
  if (!snapshot) blockReasons.push("尚未创建抖音分析");
  else if (["queued", "running"].includes(snapshot.status)) blockReasons.push("抖音分析仍在进行中");
  else if (snapshot.status === "need_login") blockReasons.push("需要登录抖音后重试");
  else if (snapshot.status === "need_verify") blockReasons.push("需要完成抖音验证后重试");
  else if (!snapshot.report) blockReasons.push("分析报告尚不可用");
  return {
    snapshot: snapshot && { id: snapshot.id, sourceUrl: snapshot.sourceUrl, config: snapshot.config, status: snapshot.status,
      completeness: snapshot.completeness, evidenceHash: snapshot.evidenceHash, reportHash: snapshot.reportHash,
      availability: snapshot.report?.availability ?? null, evidence: snapshot.report?.evidence ?? null,
      createdAt: snapshot.createdAt, completedAt: snapshot.completedAt, invalidatedAt: snapshot.invalidatedAt },
    job: job && { id: job.id, status: job.status, progress: job.progress, attempts: job.attempts,
      maxAttempts: job.maxAttempts, cancelRequested: job.cancelRequested, errorCode: job.errorCode,
      errorMessage: job.errorMessage ? redactDouyinDiagnostic(job.errorMessage) : null, createdAt: job.createdAt, updatedAt: job.updatedAt },
    selection, blockReasons,
    allowedActions: { start: !job || !["queued", "running"].includes(job.status),
      cancel: Boolean(job && ["queued", "running"].includes(job.status)),
      selectUsage: Boolean(snapshot?.report && ["succeeded", "partial"].includes(snapshot.status)) },
  };
}

export const registerDouyinAnalysisRoutes: FastifyPluginAsync<{
  database: DatabaseSync;
  resolveSource?: typeof resolveDouyinSource;
}> = async (app, options) => {
  const handle = (error: unknown, reply: { code(status: number): { send(value: unknown): unknown } }) => {
    const candidate = error as { statusCode?: unknown; message?: unknown };
    if (error instanceof DouyinAnalysisContractError || typeof candidate?.statusCode === "number") {
      return reply.code(Number(candidate.statusCode)).send({ ok: false, message: String(candidate.message ?? "请求无法处理") });
    }
    if (error instanceof DouyinSourceError) return reply.code(error.kind === "parse_failed" ? 400 : 502)
      .send({ ok: false, message: error.message });
    throw error;
  };

  app.get<{ Params: Params }>("/api/projects/:projectId/videos/:videoId/douyin-analysis", async (request, reply) => {
    try { return { ok: true, ...summary(options.database, request.params.projectId, request.params.videoId) }; }
    catch (error) { return handle(error, reply); }
  });

  app.post<{ Params: Params; Body: unknown }>("/api/projects/:projectId/videos/:videoId/douyin-analysis/jobs", async (request, reply) => {
    try {
      const config = parseDouyinAnalysisConfig(request.body);
      const source = await (options.resolveSource ?? resolveDouyinSource)(config.sourceText);
      const result = enqueueDouyinAnalysis(options.database, { projectId: request.params.projectId, videoId: request.params.videoId,
        awemeId: source.awemeId, sourceUrl: source.canonicalUrl, config });
      return reply.code(result.created ? 202 : 200).send({ ok: true,
        message: result.reusable ? "相同配置的分析结果可直接复用" : "抖音分析任务已创建", ...result });
    } catch (error) { return handle(error, reply); }
  });

  app.post<{ Params: Params & { jobId: string } }>("/api/projects/:projectId/videos/:videoId/douyin-analysis/jobs/:jobId/cancel", async (request, reply) => {
    try { return { ok: true, message: "抖音分析中断请求已记录", job: cancelDouyinAnalysisJob(options.database,
      request.params.projectId, request.params.videoId, request.params.jobId) }; }
    catch (error) { return handle(error, reply); }
  });

  app.put<{ Params: Params; Body: unknown }>("/api/projects/:projectId/videos/:videoId/douyin-analysis/selection", async (request, reply) => {
    try { return { ok: true, message: "抖音使用方式已保存", selection: saveDouyinAnalysisSelection(options.database,
      { projectId: request.params.projectId, videoId: request.params.videoId, selection: parseDouyinAnalysisSelection(request.body) }) }; }
    catch (error) { return handle(error, reply); }
  });

  app.get<{ Params: SnapshotParams }>("/api/projects/:projectId/videos/:videoId/douyin-analysis/snapshots/:snapshotId/report", async (request, reply) => {
    try { const item = getDouyinAnalysisSnapshot(options.database, request.params.projectId, request.params.videoId, request.params.snapshotId);
      if (!item.report) throw new DouyinAnalysisContractError(409, "分析报告尚不可用"); return { ok: true, report: item.report }; }
    catch (error) { return handle(error, reply); }
  });

  app.get<{ Params: SnapshotParams }>("/api/projects/:projectId/videos/:videoId/douyin-analysis/snapshots/:snapshotId/transcript", async (request, reply) => {
    try { const item = getDouyinAnalysisSnapshot(options.database, request.params.projectId, request.params.videoId, request.params.snapshotId);
      const value = manifest(item)?.transcript; if (!value) throw new DouyinAnalysisContractError(409, "转写尚不可用"); return { ok: true, transcript: value }; }
    catch (error) { return handle(error, reply); }
  });

  app.get<{ Params: SnapshotParams }>("/api/projects/:projectId/videos/:videoId/douyin-analysis/snapshots/:snapshotId/frames", async (request, reply) => {
    try { const item = getDouyinAnalysisSnapshot(options.database, request.params.projectId, request.params.videoId, request.params.snapshotId);
      return { ok: true, items: manifest(item)?.frames ?? [] }; }
    catch (error) { return handle(error, reply); }
  });

  app.get<{ Params: SnapshotParams; Querystring: { page?: string; pageSize?: string } }>("/api/projects/:projectId/videos/:videoId/douyin-analysis/snapshots/:snapshotId/comments", async (request, reply) => {
    try {
      const page = Number(request.query.page ?? 1); const pageSize = Number(request.query.pageSize ?? 10);
      if (!Number.isSafeInteger(page) || page < 1 || !Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 50) throw new DouyinAnalysisContractError(400, "评论分页参数无效");
      const item = getDouyinAnalysisSnapshot(options.database, request.params.projectId, request.params.videoId, request.params.snapshotId);
      const all = manifest(item)?.comments?.items ?? []; const offset = (page - 1) * pageSize;
      return { ok: true, page, pageSize, total: all.length, items: all.slice(offset, offset + pageSize) };
    } catch (error) { return handle(error, reply); }
  });
};
