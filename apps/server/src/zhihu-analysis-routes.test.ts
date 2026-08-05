import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { buildApp } from "./app.js";
import { ZHIHU_ANALYSIS_JOB_TYPE, type ZhihuAnalysisReport } from "./zhihu-analysis-contract.js";
import { openDatabase } from "./database.js";
import { updateZhihuAnalysisSnapshot } from "./zhihu-analysis-store.js";

function report(hash: string): ZhihuAnalysisReport {
  const available = { status: "available" as const, reason: "" };
  return { version: "yingshu-zhihu-analysis-v1", evidence: { answerStatus: "succeeded", commentsStatus: "succeeded",
    commentCount: 12, evidenceHash: hash, capturedAt: 1, analyzedAt: 2, modelIdentity: "fixture", completeness: "complete" },
    availability: { original: available, method: available, topic: available, audience: available },
    original: { sourceEvidenceOnly: true, title: "问题", authorName: "作者", bodyText: "正文", observations: [] },
    method: { observations: [] }, topic: { observations: [] }, audience: { interpretationOnly: true, observations: [] },
    observations: [], risks: [] };
}

test("知乎分析 HTTP 提供摘要、202/409、详情分页与取消", async () => {
  const dataRoot = await mkdtemp(join(tmpdir(), "yingshu-zhihu-http-"));
  const app = buildApp({ dataRoot, logger: false,
    jobHandlers: { [ZHIHU_ANALYSIS_JOB_TYPE]: async () => ({ fixture: true }) }, jobPollMs: 60_000 });
  try {
    const project = (await app.inject({ method: "POST", url: "/api/projects", payload: { name: "HTTP" } })).json().project;
    const video = (await app.inject({ method: "POST", url: `/api/projects/${project.id}/videos`, payload: { title: "视频" } })).json().video;
    const base = `/api/projects/${project.id}/videos/${video.id}/zhihu-analysis`;
    assert.equal((await app.inject({ method: "POST", url: `${base}/jobs`, payload: {
      sourceUrl: "https://example.com/question/1/answer/2", analyzeComments: true, maxComments: 10 } })).statusCode, 400);
    const created = await app.inject({ method: "POST", url: `${base}/jobs`, payload: {
      sourceUrl: "https://www.zhihu.com/question/9389089116/answer/1976331888235927140", analyzeComments: true, maxComments: 10 } });
    assert.equal(created.statusCode, 202); const body = created.json();
    assert.equal((await app.inject({ method: "POST", url: `${base}/jobs`, payload: body.snapshot.config })).statusCode, 409);
    const comments = Array.from({ length: 12 }, (_, index) => ({ id: String(index + 1), text: `评论${index + 1}`,
      replies: [], interpretationOnly: true }));
    const hash = "a".repeat(64); const connection = openDatabase(dataRoot);
    try { updateZhihuAnalysisSnapshot(connection.database, { snapshotId: body.snapshot.id, status: "succeeded", completeness: "complete",
      evidenceHash: hash, report: report(hash), artifactManifest: { version: "yingshu-zhihu-evidence-v1", evidenceHash: hash,
        artifacts: [], answer: { questionTitle: "问题", content: "正文" },
        images: [{ evidenceRef: `answer:image:${"b".repeat(64)}`, sha256: "b".repeat(64), mime: "image/jpeg", bytes: 4 }],
        comments: { status: "partial", failedReplyCount: 1, replyFailureKinds: ["access_denied"],
          interpretationOnly: true, items: comments } }, completedAt: Date.now() }); }
    finally { connection.close(); }
    const summary = (await app.inject({ method: "GET", url: base })).json();
    assert.deepEqual(Object.keys(summary).sort(), ["allowedActions", "blockReasons", "job", "ok", "selection", "snapshot"].sort());
    const answer = (await app.inject({ method: "GET", url: `${base}/snapshots/${body.snapshot.id}/answer` })).json();
    assert.equal(answer.images.length, 1); assert.equal(JSON.stringify(answer).includes("zhimg"), false);
    const page = (await app.inject({ method: "GET", url: `${base}/snapshots/${body.snapshot.id}/comments?page=2&pageSize=5` })).json();
    assert.equal(page.total, 12); assert.equal(page.items.length, 5); assert.equal(page.status, "partial");
    assert.equal(page.failedReplyCount, 1); assert.deepEqual(page.replyFailureKinds, ["access_denied"]);
    assert.equal((await app.inject({ method: "GET", url: `${base}/snapshots/${body.snapshot.id}/report` })).statusCode, 200);
    assert.equal((await app.inject({ method: "POST", url: `${base}/jobs/${body.job.id}/cancel` })).statusCode, 200);
    assert.equal((await app.inject({ method: "GET", url: `/api/projects/missing/videos/${video.id}/zhihu-analysis` })).statusCode, 404);
  } finally { await app.close(); await rm(dataRoot, { recursive: true, force: true }); }
});
