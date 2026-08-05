import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { buildApp } from "./app.js";
import { DOUYIN_ANALYSIS_JOB_TYPE } from "./douyin-analysis-contract.js";
import { openDatabase } from "./database.js";

test("抖音分析 HTTP 严格返回 202/400/404/409，取消幂等且摘要不泄密", async () => {
  const dataRoot = await mkdtemp(join(tmpdir(), "yingshu-douyin-http-"));
  const app = buildApp({ dataRoot, logger: false, jobHandlers: { [DOUYIN_ANALYSIS_JOB_TYPE]: async () => ({ fixture: true }) }, jobPollMs: 60_000 });
  try {
    const project = (await app.inject({ method: "POST", url: "/api/projects", payload: { name: "HTTP" } })).json().project;
    const video = (await app.inject({ method: "POST", url: `/api/projects/${project.id}/videos`, payload: { title: "视频" } })).json().video;
    const url = `/api/projects/${project.id}/videos/${video.id}/douyin-analysis`;
    assert.equal((await app.inject({ method: "POST", url: `${url}/jobs`, payload: { sourceText: "https://example.com/video/12345",
      extractFrames: true, frameCount: 6, transcribeAudio: false, analyzeComments: false } })).statusCode, 400);
    assert.equal((await app.inject({ method: "POST", url: `${url}/jobs`, payload: { sourceText: "https://www.douyin.com/video/12345",
      extractFrames: false, frameCount: 12, transcribeAudio: false, analyzeComments: false } })).statusCode, 400);
    const created = await app.inject({ method: "POST", url: `${url}/jobs`, payload: { sourceText: "https://www.douyin.com/video/12345",
      extractFrames: true, frameCount: 6, transcribeAudio: false, analyzeComments: false } });
    assert.equal(created.statusCode, 202);
    const body = created.json();
    assert.equal((await app.inject({ method: "POST", url: `${url}/jobs`, payload: { sourceText: "https://www.douyin.com/video/12345",
      extractFrames: true, frameCount: 6, transcribeAudio: false, analyzeComments: false } })).statusCode, 409);
    const summary = await app.inject({ method: "GET", url });
    assert.equal(summary.statusCode, 200); assert.equal(summary.body.includes("Authorization"), false); assert.equal(summary.body.includes(dataRoot), false);
    const connection = openDatabase(dataRoot);
    try {
      const comments = Array.from({ length: 12 }, (_, index) => ({ id: `comment-${index + 1}`, parentId: null,
        text: `评论 ${index + 1}`, likeCount: index, publishedAt: 1, authorId: `anon-${index + 1}`, isReply: false, replies: [] }));
      connection.database.prepare("UPDATE video_douyin_analysis_snapshots SET artifact_manifest_json=? WHERE id=?").run(JSON.stringify({
        version: "yingshu-douyin-evidence-v1", evidenceHash: "a".repeat(64), artifacts: [],
        transcript: { status: "succeeded", textHash: "b".repeat(64), segments: [{ id: "asr-1", startMs: 0,
          endMs: 1_000, text: "转写", status: "succeeded" }], missingRanges: [] }, frames: [],
        comments: { interpretationOnly: true, status: "succeeded", truncated: false, items: comments },
      }), body.snapshot.id);
    } finally { connection.close(); }
    const page = await app.inject({ method: "GET", url: `${url}/snapshots/${body.snapshot.id}/comments?page=2&pageSize=5` });
    assert.equal(page.statusCode, 200); assert.equal(page.json().total, 12); assert.equal(page.json().items.length, 5);
    assert.equal((await app.inject({ method: "GET", url: `${url}/snapshots/${body.snapshot.id}/transcript` })).json().transcript.segments.length, 1);
    const cancelUrl = `${url}/jobs/${body.job.id}/cancel`;
    assert.equal((await app.inject({ method: "POST", url: cancelUrl })).statusCode, 200);
    assert.equal((await app.inject({ method: "POST", url: cancelUrl })).statusCode, 200);
    assert.equal((await app.inject({ method: "GET", url: `/api/projects/missing/videos/${video.id}/douyin-analysis` })).statusCode, 404);
    assert.equal((await app.inject({ method: "GET", url: `${url}/snapshots/missing/report` })).statusCode, 404);
    assert.equal((await app.inject({ method: "GET", url: `${url}/snapshots/${body.snapshot.id}/comments?page=0&pageSize=51` })).statusCode, 400);
    assert.equal((await app.inject({ method: "PUT", url: `${url}/selection`, payload: { snapshotId: body.snapshot.id,
      usageRole: "content_source", creativeAngle: "改写", rightsConfirmed: false, acceptedMissingDimensions: [] } })).statusCode, 409);
  } finally { await app.close(); await rm(dataRoot, { recursive: true, force: true }); }
});
