import assert from "node:assert/strict";
import test from "node:test";

import {
  escapeAssText,
  renderSubtitleFiles,
  splitNarration,
  SUBTITLE_LINE_LIMIT,
} from "./subtitle-timeline.js";
import { systemSpeechInputHash } from "./tts-provider.js";

test("中文旁白按标点和 Unicode code point 拆成最多两行短句且不丢字", () => {
  const punctuated = "墓门开了。别回头！火把突然熄灭，身后传来脚步声。";
  const units = splitNarration(punctuated);
  assert.equal(units.map((unit) => unit.speechText).join(""), punctuated);
  assert.ok(units.length > 1);
  assert.equal(units.at(-1)?.speechText, "火把突然熄灭，身后传来脚步声。");
  for (const unit of units) {
    const lines = unit.subtitleText.split("\n");
    assert.ok(lines.length <= 2);
    assert.ok(lines.every((line) => line.length > 0 && [...line].length <= SUBTITLE_LINE_LIMIT));
  }

  const noPunctuation = "甲".repeat(35) + "𠮷";
  const fallback = splitNarration(noPunctuation);
  assert.equal(fallback.map((unit) => unit.speechText).join(""), noPunctuation);
  assert.deepEqual(fallback.map((unit) => [...unit.speechText].length), [32, 4]);
  assert.ok(fallback.every((unit) => unit.subtitleText.split("\n").length <= 2));
  assert.deepEqual(splitNarration("  \n\t  "), []);
});

test("SRT 和 ASS 共用 cue、正确转义并使用竖屏字幕安全区", () => {
  const cues = [
    { index: 0, startMs: 0, endMs: 1_255, text: "亮处<&>\n暗处{危险}\\N" },
    { index: 1, startMs: 1_255, endMs: 2_500, text: "第二句" },
  ];
  const rendered = renderSubtitleFiles(cues);
  assert.equal((rendered.srt.match(/ --> /gu) ?? []).length, cues.length);
  assert.match(rendered.srt, /&lt;&amp;&gt;/u);
  assert.equal((rendered.ass.match(/^Dialogue:/gmu) ?? []).length, cues.length);
  assert.match(rendered.ass, /Microsoft YaHei,54/u);
  assert.match(rendered.ass, /,80,80,180,1/u);
  assert.match(rendered.ass, /亮处<&>\\N暗处｛危险｝\\\\N/u);
  assert.equal(escapeAssText("{a}\\b\nc"), "｛a｝\\\\b\\Nc");
});

test("拆句合同版本进入 System.Speech 输入身份", () => {
  const input = { text: "同一句", scriptVersionId: "script", contentHash: "a".repeat(64), voice: "voice", rate: 0 };
  assert.notEqual(
    systemSpeechInputHash({ ...input, contractVersion: "subtitle-timeline-v1" }),
    systemSpeechInputHash({ ...input, contractVersion: "subtitle-timeline-v2" }),
  );
});

test("splitNarration merges quote-only punctuation into neighboring speakable text", () => {
  const units = splitNarration("\"项云峰，你不能就这么回去。你一定能成为有钱人。\"");
  assert.equal(units.map((unit) => unit.speechText).join(""), "\"项云峰，你不能就这么回去。你一定能成为有钱人。\"");
  assert.deepEqual(splitNarration("\""), []);
  assert.equal(units.some((unit) => !/[\p{L}\p{N}]/u.test(unit.speechText)), false);
  assert.equal(units.some((unit) => unit.speechText === "\""), false);
  for (const unit of units) {
    const lines = unit.subtitleText.split("\n");
    assert.ok(lines.length <= 2);
    assert.ok(lines.every((line) => line.length > 0 && [...line].length <= SUBTITLE_LINE_LIMIT));
  }
});
