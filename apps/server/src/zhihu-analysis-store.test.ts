import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { openDatabase } from "./database.js";
import type { ZhihuAnalysisConfig, ZhihuAnalysisReport } from "./zhihu-analysis-contract.js";
import { enqueueZhihuAnalysis, getCurrentZhihuAnalysisSnapshot, getZhihuAnalysisSelection,
  saveZhihuAnalysisSelection, updateZhihuAnalysisSnapshot } from "./zhihu-analysis-store.js";
import { createProject, createVideo } from "./project-video-store.js";

const config: ZhihuAnalysisConfig = {
  sourceUrl: "https://www.zhihu.com/question/9389089116/answer/1976331888235927140",
  analyzeComments: true, maxComments: 50,
};

function report(): ZhihuAnalysisReport {
  const available = { status: "available" as const, reason: "fixture 证据可用" };
  return {
    version: "yingshu-zhihu-analysis-v1",
    evidence: { answerStatus: "succeeded", commentsStatus: "partial", commentCount: 10,
      evidenceHash: "a".repeat(64), capturedAt: 3, analyzedAt: 4, modelIdentity: "fixture", completeness: "partial" },
    availability: { original: available, method: available, topic: available,
      audience: { status: "partial", reason: "仅抓取部分评论" } },
    original: { sourceEvidenceOnly: true, title: "问题", authorName: "作者", bodyText: "回答正文", observations: [] },
    method: { observations: [] }, topic: { observations: [] },
    audience: { interpretationOnly: true, observations: [] }, observations: [], risks: [],
  };
}

test("知乎快照、部分接受、权利事件与选择失效可恢复", async () => {
  const dataRoot = await mkdtemp(join(tmpdir(), "yingshu-zhihu-store-"));
  try {
    let connection = openDatabase(dataRoot);
    const project = createProject(connection.database, { name: "知乎 fixture" }, 1);
    const video = createVideo(connection.database, project.id, { title: "知乎分析视频" }, 2);
    const created = enqueueZhihuAnalysis(connection.database, { projectId: project.id, videoId: video.id,
      questionId: "9389089116", answerId: "1976331888235927140", config, now: 3 });
    connection.database.prepare("UPDATE jobs SET status='succeeded',progress=1,finished_at=4,updated_at=4 WHERE id=?")
      .run(created.job!.id);
    const completed = updateZhihuAnalysisSnapshot(connection.database, { snapshotId: created.snapshot.id,
      status: "partial", completeness: "partial", evidenceHash: "a".repeat(64), report: report(), completedAt: 4 });
    assert.throws(() => saveZhihuAnalysisSelection(connection.database, { projectId: project.id, videoId: video.id, now: 5,
      selection: { snapshotId: completed.id, usageRole: "method_only", creativeAngle: "复用讲述方法",
        rightsConfirmed: false, acceptedMissingDimensions: ["original"] } }), /只能接受/u);

    connection.database.prepare(`INSERT INTO video_plan_snapshots
      (id,video_id,idempotency_key,input_json,prompt_json,model_json,system_contract_version,web_capability,
       canonical_json,snapshot_hash,created_at) VALUES ('zhihu_plan',?,'fixture','{}','{}','{}','v1','none','{}',?,5)`)
      .run(video.id, "1".repeat(64));
    const selected = saveZhihuAnalysisSelection(connection.database, { projectId: project.id, videoId: video.id, now: 6,
      selection: { snapshotId: completed.id, usageRole: "content_source", creativeAngle: "独立重组",
        rightsConfirmed: true, acceptedMissingDimensions: ["comments"] } });
    assert.equal(selected.rightsConfirmed, true);
    assert.equal(connection.database.prepare("SELECT invalidated_at FROM video_plan_snapshots WHERE id='zhihu_plan'").get()?.invalidated_at, 6);
    assert.equal(connection.database.prepare("SELECT COUNT(*) AS count FROM video_zhihu_analysis_selection_events").get()?.count, 2);
    assert.throws(() => connection.database.prepare("DELETE FROM video_zhihu_analysis_selection_events").run(), /append-only/u);
    assert.throws(() => connection.database.prepare("DELETE FROM video_zhihu_analysis_snapshots").run(), /append-only/u);

    updateZhihuAnalysisSnapshot(connection.database, { snapshotId: completed.id,
      status: "failed", completeness: "unavailable", completedAt: 7 });
    const retry = enqueueZhihuAnalysis(connection.database, { projectId: project.id, videoId: video.id,
      questionId: "9389089116", answerId: "1976331888235927140", config, now: 8 });
    assert.notEqual(retry.snapshot.id, completed.id);
    assert.equal(connection.database.prepare("SELECT invalidated_at FROM video_zhihu_analysis_snapshots WHERE id=?")
      .get(completed.id)?.invalidated_at, 8);
    updateZhihuAnalysisSnapshot(connection.database, { snapshotId: retry.snapshot.id,
      status: "partial", completeness: "partial", evidenceHash: "a".repeat(64), report: report(), completedAt: 9 });
    assert.equal(connection.database.prepare("PRAGMA foreign_key_check").all().length, 0);

    connection.close(); connection = openDatabase(dataRoot);
    assert.equal(getCurrentZhihuAnalysisSnapshot(connection.database, project.id, video.id)?.answerId, "1976331888235927140");
    assert.equal(getZhihuAnalysisSelection(connection.database, project.id, video.id)?.usageRole, "content_source");
    connection.close();
  } finally { await rm(dataRoot, { recursive: true, force: true }); }
});
