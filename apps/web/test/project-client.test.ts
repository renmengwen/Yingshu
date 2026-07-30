import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToString } from "react-dom/server";

import { normalizeName, parseAppRoute, projectPath, videoPath } from "../src/projects/logic.ts";
import { VideoStageNavigation } from "../src/projects/VideoStageNavigation.tsx";

test("项目与视频路由可安全编码并从刷新地址恢复", () => {
  assert.equal(projectPath("项目/一"), "/projects/%E9%A1%B9%E7%9B%AE%2F%E4%B8%80");
  const path = videoPath("项目/一", "视频?二");
  assert.deepEqual(parseAppRoute(path), { page: "video", projectId: "项目/一", videoId: "视频?二" });
  assert.deepEqual(parseAppRoute("/projects/%E0%A4%A"), { page: "not-found" });
  assert.deepEqual(parseAppRoute("/unknown"), { page: "not-found" });
});

test("名称与标题统一归一化且不静默截断", () => {
  assert.equal(normalizeName("  Ａ  项目\n名称  ", "项目名称"), "A 项目 名称");
  assert.throws(() => normalizeName("　", "视频标题"), /请输入视频标题/);
  assert.throws(() => normalizeName("映".repeat(101), "项目名称"), /不能超过100个字符/);
});

test("草稿工作区只有输入与来源可进入，其余阶段明确尚未生成", () => {
  const html = renderToString(createElement(VideoStageNavigation));
  assert.match(html, /输入与来源/);
  assert.equal((html.match(/尚未生成/g) ?? []).length, 5);
  assert.equal((html.match(/disabled=""/g) ?? []).length, 5);
  assert.doesNotMatch(html, /书籍|章节|系列|分集/);
});
