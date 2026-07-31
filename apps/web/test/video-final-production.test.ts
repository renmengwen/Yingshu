import assert from "node:assert/strict";
import test from "node:test";

import {
  formatProductionTime, mergeVideoVisualReview, parseVideoRenderWorkspace, parseVideoVisualTimeline,
} from "../src/projects/video-final-production-logic.ts";

const hash = (value: string) => value.repeat(64);
const expected = { projectId: "project_1", videoId: "video_1" };
const preview = {
  id: "segment_1", segmentIndex: 0, cueStartIndex: 0, cueEndIndex: 1, startMs: 0, endMs: 12_000,
  visualId: "visual_1", narrationSummary: "第一段旁白", candidateId: "candidate_1", candidateHash: hash("c"),
  previewUrl: "/api/projects/project_1/videos/video_1/image-candidates/candidate_1/preview",
  motionKind: "zoom_in", motionAmountPpm: 80_000, fadeInMs: 250, fadeOutMs: 250,
};

test("画面时间轴解析严格绑定项目视频并合并受控整片预览", () => {
  const workspace = parseVideoVisualTimeline({ ok: true, workspace: {
    ...expected,
    gates: { plan: { label: "方案", valid: true }, image: { label: "图片", valid: true }, audio: { label: "音频", valid: true } },
    timeline: { id: "timeline_1", revision: 2, timelineHash: hash("a"), identityHash: hash("b"), audioDurationMs: 12_000, stale: false },
    issues: [],
  } }, expected);
  const merged = mergeVideoVisualReview(workspace, { ok: true, review: {
    timeline: { id: "timeline_1", revision: 2 }, preview: [preview], latestReview: null,
    reviewGate: { complete: false, approval: null }, hasStaleReview: true, validationIssues: [],
  } });
  assert.equal(merged.timeline?.durationMs, 12_000);
  assert.deepEqual(merged.segments, [preview]);
  assert.deepEqual(merged.review, { complete: false, action: null, notes: null, hasStaleReview: true });
  assert.throws(() => parseVideoVisualTimeline({ workspace: { ...expected, projectId: "other", timeline: null } }, expected), /不属于当前项目/);
});

test("渲染工作区只接受首版固定规格并读取最终真实媒体证据", () => {
  const workspace = parseVideoRenderWorkspace({ ok: true,
    readiness: { ready: true, issues: [], spec: { width: 1080, height: 1920, fps: 25, videoCodec: "h264", audioCodec: "aac", pixelFormat: "yuv420p", container: "mp4", subtitles: "ass" }, segmentCount: 1, durationMs: 12_000, estimatedChunks: 1 },
    render: { id: "render_1", status: "succeeded", jobId: "job_1", progress: 1, chunks: { total: 1, queued: 0, running: 0, succeeded: 1, failed: 0, cancelled: 0 }, errorMessage: null,
      final: { fileHash: hash("f"), bytes: 1024, mediaInfo: { width: 1080, height: 1920, fps: 25, videoCodec: "h264", audioCodec: "aac", pixelFormat: "yuv420p", durationMs: 12_000 } } },
  }, expected);
  assert.equal(workspace.final?.fileHash, hash("f"));
  assert.equal(workspace.final?.height, 1920);
  assert.equal(formatProductionTime(workspace.final!.durationMs), "00:12");
  assert.throws(() => parseVideoRenderWorkspace({ readiness: { ready: true, issues: [], spec: { width: 720, height: 1280, fps: 25, videoCodec: "h264", audioCodec: "aac", pixelFormat: "yuv420p" }, segmentCount: 1, durationMs: 1, estimatedChunks: 1 }, render: null }, expected), /输出规格/);
});
