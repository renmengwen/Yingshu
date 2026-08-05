import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { openDatabase } from "./database.js";
import { type ZhihuAnalysisReport, ZHIHU_ANALYSIS_JOB_TYPE } from "./zhihu-analysis-contract.js";
import { createZhihuAnalysisJobHandler } from "./zhihu-analysis-job.js";
import type { ZhihuAnalysisProviderInput } from "./zhihu-analysis-provider.js";
import { enqueueZhihuAnalysis, getCurrentZhihuAnalysisSnapshot } from "./zhihu-analysis-store.js";
import { JobWorker } from "./job-worker.js";
import { createProject, createVideo } from "./project-video-store.js";

function report(input: ZhihuAnalysisProviderInput): ZhihuAnalysisReport {
  const available = { status: "available" as const, reason: "证据可用" };
  const audienceAvailability = input.evidence.commentsStatus === "partial"
    ? { status: "partial" as const, reason: "子评论局部获取失败" }
    : input.audience ? available : { status: "unavailable" as const, reason: "无评论" };
  return { version: "yingshu-zhihu-analysis-v1", evidence: input.evidence,
    availability: { original: input.images.length ? available : { status: "partial", reason: "图片未识别" },
      method: available, topic: available, audience: audienceAvailability },
    original: { sourceEvidenceOnly: true, title: input.answer.questionTitle, authorName: input.answer.authorName,
      bodyText: input.answer.content, observations: [] }, method: { observations: [] }, topic: { observations: [] },
    audience: input.audience ? { interpretationOnly: true, observations: [] } : null,
    observations: [], risks: [] };
}

type CommentsMode = "success" | "root_failure" | "reply_partial";

async function run(commentsMode: CommentsMode) {
  const dataRoot = await mkdtemp(join(tmpdir(), "yingshu-zhihu-job-"));
  const connection = openDatabase(dataRoot); const project = createProject(connection.database, { name: "项目" }, 1);
  const video = createVideo(connection.database, project.id, { title: "视频" }, 2);
  const created = enqueueZhihuAnalysis(connection.database, { projectId: project.id, videoId: video.id,
    questionId: "9389089116", answerId: "1976331888235927140", config: {
      sourceUrl: "https://www.zhihu.com/question/9389089116/answer/1976331888235927140",
      analyzeComments: true, maxComments: 10 }, now: 3 });
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
  const handler = createZhihuAnalysisJobHandler(connection.database, dataRoot, {
    normalizeSource: () => ({ questionId: "9389089116", answerId: "1976331888235927140",
      sourceUrl: created.snapshot.sourceUrl, canonicalUrl: created.snapshot.sourceUrl }),
    fetchAnswer: async () => ({ questionId: "9389089116", answerId: "1976331888235927140",
      canonicalUrl: created.snapshot.sourceUrl, questionTitle: "问题", content: "正文", excerpt: "", authorName: "作者",
      imageUrls: ["https://picx.zhimg.com/a.jpg"], publishedAt: 1, updatedAt: 2, voteupCount: 3, commentCount: 1 }),
    fetchComments: async () => {
      if (commentsMode === "root_failure") throw new Error("评论限流");
      if (commentsMode === "reply_partial") return {
        status: "partial", comments: [{ id: "comment-1", parentId: null, text: "保留的根评论",
          likeCount: 1, publishedAt: 1, authorId: "anon", isReply: false, replies: [], interpretationOnly: true }],
        pagesFetched: 1, truncated: false, interpretationOnly: true,
        failedReplyCount: 1, replyFailureKinds: ["access_denied"],
      };
      return { status: "succeeded", comments: [], pagesFetched: 1, truncated: false, interpretationOnly: true };
    },
    fetchImages: async () => [{ base64: jpeg.toString("base64"), sha256: "32461d5bd1773012b1c44ac88e8f3fd9f6cbe41a2f5c2cf50f9c33122d5a92c0",
      mime: "image/jpeg", sourceUrl: "https://picx.zhimg.com/a.jpg" }],
    supportsImages: true,
    analyze: async (input) => ({ report: report(input), modelSnapshot: { providerId: "fixture", model: "fixture",
      protocol: "openai-response", baseUrl: "https://fixture.invalid/v1", modelIdentityHash: "b".repeat(64),
      promptVersion: "v1", systemVersion: "v1", inputHash: "c".repeat(64) } }),
  });
  const worker = new JobWorker(connection.database, { [ZHIHU_ANALYSIS_JOB_TYPE]: handler },
    { workerId: "fixture", leaseMs: 10_000, heartbeatMs: 1_000, retryDelayMs: 0 });
  await worker.runOne();
  return { dataRoot, connection, project, video, created };
}

test("知乎 Job 冻结回答、图片、评论和报告并保留六阶段 checkpoint", async () => {
  const value = await run("success");
  try {
    const snapshot = getCurrentZhihuAnalysisSnapshot(value.connection.database, value.project.id, value.video.id)!;
    assert.equal(snapshot.status, "succeeded", String(value.connection.database.prepare("SELECT error_message FROM jobs WHERE id=?").get(value.created.job!.id)?.error_message));
    const manifest = snapshot.artifactManifest as { artifacts: Array<{ kind: string; relativePath: string }> };
    assert.deepEqual(new Set(manifest.artifacts.map((item) => item.kind)), new Set(["answer", "image", "comments", "report"]));
    const image = manifest.artifacts.find((item) => item.kind === "image")!;
    assert.equal((await readFile(join(value.dataRoot, ...image.relativePath.split("/")))).subarray(0, 3).toString("hex"), "ffd8ff");
    const stages = value.connection.database.prepare("SELECT stage FROM job_checkpoints WHERE job_id=? ORDER BY stage")
      .all(value.created.job!.id).map((row) => (row as { stage: string }).stage);
    assert.deepEqual(new Set(stages), new Set(["normalize", "fetch_answer", "fetch_images", "fetch_comments", "analyze", "validate", "freeze"]));
  } finally { value.connection.close(); await rm(value.dataRoot, { recursive: true, force: true }); }
});

test("知乎评论失败降级为 partial，回答与图片失败才不会被伪装成功", async () => {
  const value = await run("root_failure");
  try {
    const snapshot = getCurrentZhihuAnalysisSnapshot(value.connection.database, value.project.id, value.video.id)!;
    assert.equal(snapshot.status, "partial", String(value.connection.database.prepare("SELECT error_message FROM jobs WHERE id=?").get(value.created.job!.id)?.error_message)); assert.equal(snapshot.report?.evidence.commentsStatus, "failed");
    assert.ok((snapshot.artifactManifest as { answer?: unknown }).answer);
  } finally { value.connection.close(); await rm(value.dataRoot, { recursive: true, force: true }); }
});

test("知乎子评论局部失败时保留根评论并冻结有界诊断", async () => {
  const value = await run("reply_partial");
  try {
    const snapshot = getCurrentZhihuAnalysisSnapshot(value.connection.database, value.project.id, value.video.id)!;
    assert.equal(snapshot.status, "partial");
    assert.equal(snapshot.report?.evidence.commentsStatus, "partial");
    assert.equal(snapshot.report?.evidence.commentCount, 1);
    assert.notEqual(snapshot.report?.availability.audience.status, "available");
    const manifest = snapshot.artifactManifest as { comments: { status: string; items: Array<{ id: string; text: string }>;
      failedReplyCount: number; replyFailureKinds: string[] } };
    assert.equal(manifest.comments.status, "partial");
    assert.equal(manifest.comments.items.length, 1);
    assert.equal(manifest.comments.items[0]?.id, "comment-1");
    assert.equal(manifest.comments.items[0]?.text, "保留的根评论");
    assert.equal(manifest.comments.failedReplyCount, 1);
    assert.deepEqual(manifest.comments.replyFailureKinds, ["access_denied"]);
  } finally { value.connection.close(); await rm(value.dataRoot, { recursive: true, force: true }); }
});
