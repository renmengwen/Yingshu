import type { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";

import type { ChapterTextModelConfig } from "./chapter-event-analyzer.js";
import { canonicalZhihuJson, zhihuSha256, type ZhihuAnalysisReport } from "./zhihu-analysis-contract.js";
import {
  createZhihuAnalysisProvider, ZHIHU_ANALYSIS_PROMPT_VERSION,
  type ZhihuAnalysisProviderInput, type ZhihuAnalysisProviderResult,
} from "./zhihu-analysis-provider.js";
import { getZhihuAnalysisSnapshot, updateZhihuAnalysisSnapshot } from "./zhihu-analysis-store.js";
import { buildZhihuAudienceInput, fetchZhihuComments, type ZhihuCommentsResult } from "./zhihu-comments.js";
import { fetchZhihuImageEvidence, type ZhihuImageEvidence } from "./zhihu-image-evidence.js";
import { fetchZhihuAnswer, normalizeZhihuSource, type NormalizedZhihuSource, type ZhihuAnswer } from "./zhihu-source.js";
import { JobCancelledError, type JobExecutionContext, type JobHandler } from "./job-worker.js";

export const ZHIHU_EVIDENCE_VERSION = "yingshu-zhihu-evidence-v1" as const;

export interface ZhihuAnalysisJobDependencies {
  normalizeSource: typeof normalizeZhihuSource;
  fetchAnswer: typeof fetchZhihuAnswer;
  fetchComments: typeof fetchZhihuComments;
  fetchImages: typeof fetchZhihuImageEvidence;
  supportsImages: boolean;
  analyze(input: ZhihuAnalysisProviderInput): Promise<ZhihuAnalysisProviderResult>;
}

function payload(value: unknown) {
  const item = value as Record<string, unknown>;
  for (const key of ["projectId", "videoId", "snapshotId"] as const) {
    if (typeof item?.[key] !== "string" || !item[key]) throw new Error("知乎分析 Job 载荷无效");
  }
  return item as { projectId: string; videoId: string; snapshotId: string };
}

function checkpoint<T>(context: JobExecutionContext, stage: string, inputHash: string) {
  const value = context.getCheckpoint(stage, "snapshot");
  return value?.inputHash === inputHash ? value.output as T : undefined;
}

function commit(context: JobExecutionContext, stage: string, inputHash: string, output: unknown) {
  context.commitCheckpoint(stage, "snapshot", inputHash, () => undefined, output);
}

async function cancellable<T>(context: JobExecutionContext, run: (signal: AbortSignal) => Promise<T>) {
  context.throwIfCancellationRequested();
  const controller = new AbortController();
  const timer = setInterval(() => { if (context.isCancellationRequested()) controller.abort(); }, 100);
  try { const result = await run(controller.signal); context.throwIfCancellationRequested(); return result; }
  catch (error) { if (controller.signal.aborted || context.isCancellationRequested()) throw new JobCancelledError(); throw error; }
  finally { clearInterval(timer); }
}

async function freezeJson(dataRoot: string, relativePath: string, value: unknown) {
  const root = resolve(dataRoot); const target = resolve(root, relativePath);
  if (target !== root && !target.startsWith(`${root}${sep}`)) throw new Error("知乎冻结产物路径越界");
  const text = `${JSON.stringify(value, null, 2)}\n`;
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, text, { encoding: "utf8", flag: "w" });
  return { relativePath: relativePath.replace(/\\/gu, "/"), bytes: Buffer.byteLength(text), sha256: zhihuSha256(text) };
}

async function freezeBytes(dataRoot: string, relativePath: string, bytes: Uint8Array) {
  const root = resolve(dataRoot); const target = resolve(root, relativePath);
  if (target !== root && !target.startsWith(`${root}${sep}`)) throw new Error("知乎冻结产物路径越界");
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, bytes, { flag: "w" });
  return { relativePath: relativePath.replace(/\\/gu, "/"), bytes: bytes.byteLength,
    sha256: createHash("sha256").update(bytes).digest("hex") };
}

function allComments(result: ZhihuCommentsResult | null) {
  return result?.comments.flatMap((item) => [item, ...item.replies]) ?? [];
}

export function createZhihuAnalysisJobHandler(database: DatabaseSync, dataRoot: string,
  dependencies: ZhihuAnalysisJobDependencies): JobHandler {
  return async (context) => {
    const ids = payload(context.job.payload);
    try {
      const snapshot = getZhihuAnalysisSnapshot(database, ids.projectId, ids.videoId, ids.snapshotId);
      updateZhihuAnalysisSnapshot(database, { snapshotId: snapshot.id, status: "running", completeness: "unavailable" });
      const inputHash = snapshot.configHash;

      let source = checkpoint<NormalizedZhihuSource>(context, "normalize", inputHash);
      if (!source) { source = dependencies.normalizeSource(snapshot.sourceUrl); commit(context, "normalize", inputHash, source); }
      if (source.questionId !== snapshot.questionId || source.answerId !== snapshot.answerId) throw new Error("知乎来源身份与冻结快照不一致");
      context.reportProgress(0.1);

      let answer = checkpoint<ZhihuAnswer>(context, "fetch_answer", inputHash);
      if (!answer) { answer = await cancellable(context, (signal) => dependencies.fetchAnswer(source!, { signal }));
        commit(context, "fetch_answer", inputHash, answer); }
      context.reportProgress(0.35);

      let images: readonly ZhihuImageEvidence[] = [];
      let imageFailure: string | null = null;
      if (answer.imageUrls.length && dependencies.supportsImages) {
        const saved = checkpoint<{ images: readonly ZhihuImageEvidence[]; failure: string | null }>(context, "fetch_images", inputHash);
        if (saved) { images = saved.images; imageFailure = saved.failure; }
        else {
          try { images = await cancellable(context, (signal) => dependencies.fetchImages(answer!.imageUrls, { signal })); }
          catch (error) { if (error instanceof JobCancelledError) throw error;
            imageFailure = error instanceof Error ? error.message.slice(0, 500) : "图片证据获取失败"; }
          commit(context, "fetch_images", inputHash, { images, failure: imageFailure });
        }
      } else if (answer.imageUrls.length) imageFailure = "当前文本模型不支持图片证据";

      let comments: ZhihuCommentsResult | null = null;
      let commentsFailure: string | null = null;
      if (snapshot.config.analyzeComments) {
        const saved = checkpoint<{ result: ZhihuCommentsResult | null; failure: string | null }>(context, "fetch_comments", inputHash);
        if (saved) { comments = saved.result; commentsFailure = saved.failure; }
        else {
          try { comments = await cancellable(context, (signal) => dependencies.fetchComments(source!, { signal }));
            comments = { ...comments, comments: comments.comments.slice(0, snapshot.config.maxComments) }; }
          catch (error) {
            if (error instanceof JobCancelledError) throw error;
            commentsFailure = error instanceof Error ? error.message.slice(0, 500) : "评论获取失败";
          }
          commit(context, "fetch_comments", inputHash, { result: comments, failure: commentsFailure });
        }
      }
      context.reportProgress(0.55);

      const flatComments = allComments(comments);
      const providerImages = images.map((image) => ({ evidenceRef: `answer:image:${image.sha256}`, sha256: image.sha256,
        mime: image.mime, bytes: Buffer.from(image.base64, "base64") }));
      // 上游图片 URL 只用于本次受控抓取；冻结身份与恢复包只保留内容 Hash。
      const { imageUrls: _imageUrls, ...frozenAnswer } = answer;
      const validEvidenceRefs = new Set(["answer:body", ...providerImages.map((item) => item.evidenceRef),
        ...flatComments.map((item) => `comment:${item.id}`)]);
      const commentsComplete = !snapshot.config.analyzeComments || Boolean(comments && !commentsFailure && comments.status !== "partial");
      const imagesComplete = answer.imageUrls.length === images.length && !imageFailure;
      const completeness = commentsComplete && imagesComplete ? "complete" : "partial";
      const evidenceHash = zhihuSha256(canonicalZhihuJson({ answer: frozenAnswer, imageHashes: images.map((item) => item.sha256), imageFailure,
        comments, commentsFailure }));
      const evidence: ZhihuAnalysisReport["evidence"] = {
        answerStatus: "succeeded",
        commentsStatus: !snapshot.config.analyzeComments ? "not_requested"
          : commentsFailure ? "failed" : comments?.status === "partial" ? "partial" : "succeeded",
        commentCount: flatComments.length, evidenceHash, capturedAt: Date.now(), analyzedAt: Date.now(),
        modelIdentity: "pending", completeness,
      };
      const audience = comments ? buildZhihuAudienceInput(comments.comments) : null;
      const providerInput: ZhihuAnalysisProviderInput = { evidence, answer, audience, validEvidenceRefs, images: providerImages };
      let analyzed = checkpoint<ZhihuAnalysisProviderResult>(context, "analyze", evidenceHash);
      if (!analyzed) { analyzed = await cancellable(context, (signal) => dependencies.analyze({ ...providerInput, signal }));
        commit(context, "analyze", evidenceHash, analyzed); }
      context.reportProgress(0.8);

      const reportHash = zhihuSha256(canonicalZhihuJson(analyzed.report));
      commit(context, "validate", analyzed.modelSnapshot.inputHash, { reportHash });

      const root = `zhihu/analyses/${snapshot.videoId}/${snapshot.id}`;
      const answerFile = await freezeJson(dataRoot, `${root}/answer.json`, frozenAnswer);
      const commentsFile = await freezeJson(dataRoot, `${root}/comments.json`, {
        status: snapshot.config.analyzeComments ? comments?.status ?? "partial" : "not_requested",
        comments: comments?.comments ?? [], pagesFetched: comments?.pagesFetched ?? 0,
        truncated: comments?.truncated ?? false, failedReplyCount: comments?.failedReplyCount ?? 0,
        replyFailureKinds: comments?.replyFailureKinds ?? [], interpretationOnly: true,
      });
      const reportFile = await freezeJson(dataRoot, `${root}/report.json`, analyzed.report);
      const imageFiles = await Promise.all(providerImages.map(async (image) => {
        const extension = image.mime === "image/jpeg" ? "jpg" : image.mime === "image/png" ? "png" : "webp";
        return { id: `image-${image.sha256}`, kind: "image", mime: image.mime,
          ...await freezeBytes(dataRoot, `${root}/images/${image.sha256}.${extension}`, image.bytes) };
      }));
      const artifacts = [
        { id: "answer", kind: "answer", ...answerFile },
        { id: "comments", kind: "comments", ...commentsFile },
        { id: "report", kind: "report", ...reportFile },
        ...imageFiles,
      ];
      const manifest = { version: ZHIHU_EVIDENCE_VERSION, evidenceHash, artifacts, answer: frozenAnswer,
        images: providerImages.map(({ evidenceRef, sha256, mime, bytes }) => ({ evidenceRef, sha256, mime, bytes: bytes.byteLength })),
        comments: { status: snapshot.config.analyzeComments ? comments?.status ?? "partial" : "not_requested",
          failure: commentsFailure, items: comments?.comments ?? [], pagesFetched: comments?.pagesFetched ?? 0,
          truncated: comments?.truncated ?? false, failedReplyCount: comments?.failedReplyCount ?? 0,
          replyFailureKinds: comments?.replyFailureKinds ?? [], interpretationOnly: true } };
      commit(context, "freeze", evidenceHash, { evidenceHash, artifactCount: artifacts.length });
      updateZhihuAnalysisSnapshot(database, { snapshotId: snapshot.id,
        status: completeness === "complete" ? "succeeded" : "partial", completeness, evidenceHash,
        report: analyzed.report, artifactManifest: manifest, completedAt: Date.now() });
      context.reportProgress(1);
      return { snapshotId: snapshot.id, status: completeness === "complete" ? "succeeded" : "partial", evidenceHash };
    } catch (error) {
      if (error instanceof JobCancelledError || context.isCancellationRequested()) {
        updateZhihuAnalysisSnapshot(database, { snapshotId: ids.snapshotId, status: "cancelled", completeness: "partial", completedAt: Date.now() });
        throw new JobCancelledError();
      }
      updateZhihuAnalysisSnapshot(database, { snapshotId: ids.snapshotId, status: "failed", completeness: "unavailable", completedAt: Date.now() });
      throw error;
    }
  };
}

export function createConfiguredZhihuAnalysisJobHandler(database: DatabaseSync, dataRoot: string, options: {
  resolveTextProvider(identity?: { providerId: string; modelId: string }): Promise<ChapterTextModelConfig | null>;
}): JobHandler {
  return async (context) => {
    const ids = payload(context.job.payload);
    const snapshot = getZhihuAnalysisSnapshot(database, ids.projectId, ids.videoId, ids.snapshotId);
    const frozen = snapshot.modelSnapshot as { providerId?: unknown; model?: unknown } | null;
    const identity = typeof frozen?.providerId === "string" && typeof frozen.model === "string"
      ? { providerId: frozen.providerId, modelId: frozen.model } : undefined;
    const config = await options.resolveTextProvider(identity);
    if (!config) throw new Error("尚未配置可用的知乎分析文本模型");
    if (identity && (config.providerId !== identity.providerId || config.model !== identity.modelId)) {
      throw new Error("知乎分析冻结模型身份已不可用");
    }
    return createZhihuAnalysisJobHandler(database, dataRoot, { normalizeSource: normalizeZhihuSource,
      fetchAnswer: fetchZhihuAnswer, fetchComments: fetchZhihuComments, fetchImages: fetchZhihuImageEvidence,
      supportsImages: config.protocol !== "anthropic-message" && config.supportsMultimodal === true,
      analyze: createZhihuAnalysisProvider(config) })(context);
  };
}
