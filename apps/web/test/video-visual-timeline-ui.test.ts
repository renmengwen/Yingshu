import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createElement } from "react";
import { renderToString } from "react-dom/server";

import type { VideoVisualSegment } from "../src/projects/video-final-production-logic.ts";
import { VideoVisualTimelineList } from "../src/projects/VideoVisualTimelineList.tsx";

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");

const segment = (index: number): VideoVisualSegment => ({
  id: `segment_${index}`, segmentIndex: index, cueStartIndex: index, cueEndIndex: index,
  startMs: index * 1000, endMs: (index + 1) * 1000, visualId: `visual_${index}`,
  narrationSummary: `视觉段旁白摘要 ${index + 1}`, candidateId: `candidate_${index}`,
  candidateHash: "a".repeat(64), previewUrl: `/api/media/${index}`, motionKind: "zoom_in",
  motionAmountPpm: 12000, fadeInMs: 300, fadeOutMs: 500,
});

test("视觉段首屏使用桌面语义表格、移动紧凑列表和常数分页", () => {
  const html = renderToString(createElement(VideoVisualTimelineList, {
    segments: Array.from({ length: 21 }, (_, index) => segment(index)),
    timelineHash: "b".repeat(64), stale: false, issues: [], busyAction: null,
    onDirtyChange: () => undefined, onSave: async () => undefined,
  }));
  assert.match(html, /<table\b/u);
  assert.match(html, /<caption[^>]*>[^<]*视觉时间轴/u);
  for (const heading of ["当前图", "段号", "时间", "cue", "旁白摘要", "运镜", "淡入淡出", "校验状态", "操作"]) assert.match(html, new RegExp(`>${heading}<`, "u"));
  assert.match(html, /class="hidden[^"]*md:block/u);
  assert.match(html, /class="[^"]*md:hidden/u);
  assert.match(html, /视觉段旁白摘要 1/u);
  assert.doesNotMatch(html, /视觉段旁白摘要 11/u);
  assert.equal(html.match(/>上一页</gu)?.length, 1);
  assert.equal(html.match(/>下一页</gu)?.length, 1);
  assert.match(html, /aria-current="page">1(?:<!-- -->)? \/ (?:<!-- -->)?3</u);
  assert.match(html, /aria-label="视觉段 01：查看与编辑运镜"/u);
});

test("视觉段失效与阻断状态使用明确中文而不只依赖颜色", () => {
  const render = (stale: boolean, issues: string[]) => renderToString(createElement(VideoVisualTimelineList, {
    segments: [segment(0)], timelineHash: "b".repeat(64), stale, issues, busyAction: null,
    onDirtyChange: () => undefined, onSave: async () => undefined,
  }));
  assert.match(render(true, []), /修订已失效/u);
  assert.match(render(false, ["覆盖不连续"]), /存在校验阻断/u);
  assert.match(render(false, []), /连续有效/u);
});

test("视觉段详情保留独立淡入淡出、焦点返还、未保存拦截和本段保存合同", () => {
  const source = read("../src/projects/VideoVisualTimelineList.tsx");
  for (const text of ["运镜类型", "运镜幅度 ppm", "淡入 ms", "淡出 ms", "完整旁白摘要", "当前批准图片", "保存本段设置", "放弃修改并关闭"]) assert.match(source, new RegExp(text, "u"));
  assert.match(source, /onOpenAutoFocus/u);
  assert.match(source, /onCloseAutoFocus/u);
  assert.match(source, /当前运镜参数尚未保存/u);
  assert.match(source, /onSave\(\{ motionKind, motionAmountPpm, fadeInMs, fadeOutMs \}\)/u);
});

test("视觉审核保持保存与批准分离且批准文案不启动渲染", () => {
  const source = read("../src/projects/VideoVisualTimelineStage.tsx");
  assert.match(source, /1 个段落设置未保存/u);
  assert.match(source, /记录返修意见/u);
  assert.match(source, /批准当前整片视觉/u);
  assert.match(source, /批准视觉修订不会自动启动最终渲染/u);
  assert.match(source, /state\.reviewTimeline\("approve", notes\)/u);
  assert.doesNotMatch(source, /startRender/u);
});

test("已批准修订优先展示完成状态并锁定已勾选的审核确认", () => {
  const source = read("../src/projects/VideoVisualTimelineStage.tsx");
  assert.match(source, /reviewComplete \? "当前修订已完成人工审核，无需再次确认。"/u);
  assert.match(source, /checked=\{reviewComplete \|\| confirmed\}/u);
  assert.match(source, /disabled=\{reviewComplete \|\| busy \|\| !canReview\}/u);
  assert.match(source, /const reviewDisabledReason = reviewComplete \? null/u);
});
