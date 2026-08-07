import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  getGlobalPromptSettings,
  getProjectSettings,
  getVideoInput,
  putGlobalPromptSettings,
  putProjectSettings,
  putVideoInput,
} from "./creative-input-store.js";
import { openDatabase } from "./database.js";
import { createProject, createVideo, deleteProject } from "./project-video-store.js";

function draft(overrides: Record<string, unknown> = {}) {
  return {
    inputMode: "topic",
    topic: "银票为什么难伪造",
    body: "备用正文",
    referenceText: "参考表达",
    referenceRole: "style_only",
    targetDurationSeconds: 180,
    visualDensity: "standard",
    webEnabled: true,
    scriptInstructions: "本视频文案要求",
    visualInstructions: "本视频画面要求",
    ...overrides,
  };
}

test("项目设置、视频输入和全局提示词使用正确默认值并彼此隔离", async () => {
  const dataRoot = await mkdtemp(join(tmpdir(), "yingshu-creative-input-store-"));
  const connection = openDatabase(dataRoot);
  try {
    const first = createProject(connection.database, { name: "甲项目" }, 10);
    const second = createProject(connection.database, { name: "乙项目" }, 11);
    const firstVideo = createVideo(connection.database, first.id, { title: "甲视频" }, 20);
    const secondVideo = createVideo(connection.database, first.id, { title: "乙视频" }, 21);

    assert.deepEqual(getVideoInput(connection.database, first.id, firstVideo.id), {
      inputMode: "topic", topic: "", body: "", referenceText: "", referenceRole: "style_only",
      targetDurationSeconds: 180, visualDensity: "standard", aspectRatio: "9:16", webEnabled: true,
      scriptInstructions: "", visualInstructions: "", updatedAt: 20,
    });
    assert.equal(getProjectSettings(connection.database, first.id).scriptInstructions, "");
    assert.deepEqual(getGlobalPromptSettings(connection.database), {
      scriptInstructions: "", visualInstructions: "", updatedAt: 0,
    });

    const projectSettings = putProjectSettings(connection.database, first.id, {
      scriptInstructions: "项目文案", visualInstructions: "项目画面",
    }, 30);
    assert.equal(projectSettings.scriptInstructions, "项目文案");
    assert.equal(getProjectSettings(connection.database, second.id).scriptInstructions, "");

    const saved = putVideoInput(connection.database, first.id, firstVideo.id, draft(), 40);
    assert.equal(saved.referenceRole, "style_only");
    assert.equal(saved.aspectRatio, "9:16");
    assert.equal(saved.webEnabled, true);
    assert.equal(getVideoInput(connection.database, first.id, secondVideo.id).topic, "");

    const bodySaved = putVideoInput(connection.database, first.id, firstVideo.id, draft({
      inputMode: "body", topic: "保留的主题", body: "正文第一段\r\n\r\n正文第二段",
      referenceRole: "content_source", targetDurationSeconds: 600,
      visualDensity: "compact", aspectRatio: "16:9", webEnabled: false,
    }), 50);
    assert.equal(bodySaved.topic, "保留的主题");
    assert.equal(bodySaved.body, "正文第一段\n\n正文第二段");
    assert.equal(bodySaved.referenceRole, "content_source");
    assert.equal(bodySaved.aspectRatio, "16:9");
    assert.equal(bodySaved.webEnabled, false);

    const global = putGlobalPromptSettings(connection.database, {
      scriptInstructions: "全局文案", visualInstructions: "全局画面",
    }, 60);
    assert.deepEqual(global, { scriptInstructions: "全局文案", visualInstructions: "全局画面", updatedAt: 60 });

    assert.throws(() => getVideoInput(connection.database, second.id, firstVideo.id),
      /视频不存在或不属于当前项目/u);
    deleteProject(connection.database, first.id);
    assert.equal(connection.database.prepare("SELECT COUNT(*) AS count FROM videos WHERE project_id = ?")
      .get(first.id)?.count, 0);
  } finally {
    connection.close();
    await rm(dataRoot, { recursive: true, force: true });
  }
});
