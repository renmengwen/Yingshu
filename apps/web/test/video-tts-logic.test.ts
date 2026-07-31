import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToString } from "react-dom/server";

import { canApproveVideoTts, formatTtsDuration, formatTtsRate, requiresDurationDecision, videoTtsDeviation, videoTtsJobLabel, type VideoTtsApprovalCandidate } from "../src/projects/video-tts-logic.ts";

const artifact = (override: Partial<VideoTtsApprovalCandidate> = {}): VideoTtsApprovalCandidate => ({ id: "tts_1", stale: false, durationSeconds: 100, targetDurationSeconds: 100, durationDecision: "within_target", approved: false, ...override });

test("真实时长偏差边界严格按百分之十处理", () => {
  assert.equal(videoTtsDeviation(110, 100), 0.1);
  assert.equal(requiresDurationDecision(artifact({ durationSeconds: 110 })), false);
  assert.equal(requiresDurationDecision(artifact({ durationSeconds: 110.01 })), true);
  assert.equal(videoTtsDeviation(10, 0), null);
});

test("超出时长必须显式接受实际时长且失效产物永远不可批准", () => {
  const over = artifact({ durationSeconds: 120, durationDecision: null });
  assert.equal(canApproveVideoTts(over), false);
  assert.equal(canApproveVideoTts({ ...over, durationDecision: "regenerate" }), false);
  assert.equal(canApproveVideoTts({ ...over, durationDecision: "accept_actual" }), true);
  assert.equal(canApproveVideoTts({ ...over, stale: true, durationDecision: "accept_actual" }), false);
});

test("状态和时长文案不伪造百分比", () => {
  assert.equal(videoTtsJobLabel({ id: "job_1", status: "processing_subtitles" }), "处理字幕");
  assert.equal(formatTtsDuration(65.4), "01:05");
  assert.equal(formatTtsRate(3), "+3 档");
  assert.equal(formatTtsDuration(Number.NaN), "--:--");
  assert.match(renderToString(createElement("audio", { controls: true, src: "/api/audio/tts_1" })), /controls=""/);
});
