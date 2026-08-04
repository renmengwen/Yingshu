import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { readFileSync } from "node:fs";

import { VideoAudioCueList } from "../src/projects/VideoAudioCueList.tsx";
import type { VideoTtsCue } from "../src/projects/video-tts-logic.ts";

const cues: VideoTtsCue[] = Array.from({ length: 12 }, (_, index) => ({
  id: `cue_${index}`,
  paragraphId: `paragraph_${index}`,
  text: `第 ${index + 1} 段完整旁白`,
  startSeconds: index * 5,
  endSeconds: index * 5 + 5,
}));

test("音频分段复用 10/20 分页并只渲染当前页记录", () => {
  const html = renderToString(createElement(VideoAudioCueList, {
    base: "/api/projects/project_1/videos/video_1",
    cues,
    busy: false,
    stale: false,
    fullPlaybackConfirmed: false,
  }));
  assert.match(html, /配音与字幕分段记录/);
  assert.match(html, /音频分段分页/);
  assert.match(html, /共.*12.*条.*第.*1.*\/.*2.*页/);
  assert.equal((html.match(/aria-label="音频分段 \d+：查看详情"/g) ?? []).length, 20);
  assert.doesNotMatch(html, /第 11 段完整旁白/);
});

test("桌面表格与移动紧凑列表保留完整状态列和可区分操作名称", () => {
  const html = renderToString(createElement(VideoAudioCueList, {
    base: "/api/projects/project_1/videos/video_1",
    cues: cues.slice(0, 1),
    busy: false,
    stale: false,
    fullPlaybackConfirmed: true,
  }));
  for (const heading of ["开始", "结束", "真实时长", "音频状态", "字幕状态", "试听状态", "操作"]) assert.match(html, new RegExp(heading));
  assert.match(html, /md:block/);
  assert.match(html, /md:hidden/);
  assert.match(html, /aria-label="音频分段 01：查看详情"/);
  assert.match(html, /整片已试听/);
});

test("单段定位按钮只控制 Dialog 内可见播放器", () => {
  const source = readFileSync(new URL("../src/projects/VideoAudioCueList.tsx", import.meta.url), "utf8");
  assert.match(source, /<audio ref=\{dialogAudioRef\}/);
  assert.match(source, /dialogAudioRef\.current\.currentTime = seconds/);
  assert.match(source, /seekDialogAudio\(openCue\.startSeconds\)/);
  assert.doesNotMatch(source, /onClick=\{\(\) => onSeek\(openCue\.startSeconds\)\}/);
});

test("已批准音频恢复后展示为已完成听审", () => {
  const source = readFileSync(new URL("../src/projects/VideoAudioStage.tsx", import.meta.url), "utf8");
  assert.match(source, /fullPlaybackConfirmed=\{confirmedFullPlayback \|\| approved\}/);
  assert.match(source, /checked=\{confirmedFullPlayback \|\| approved\}/);
});
