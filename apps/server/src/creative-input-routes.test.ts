import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import Fastify from "fastify";

import { registerCreativeInputRoutes } from "./creative-input-routes.js";
import { openDatabase } from "./database.js";
import { registerProjectVideoRoutes } from "./project-video-routes.js";

function buildApp(dataRoot: string) {
  const connection = openDatabase(dataRoot);
  const app = Fastify({ logger: false });
  void app.register(registerProjectVideoRoutes, { database: connection.database, dataRoot });
  void app.register(registerCreativeInputRoutes, { database: connection.database });
  app.addHook("onClose", async () => connection.close());
  return app;
}

function input(overrides: Record<string, unknown> = {}) {
  return {
    inputMode: "topic", topic: "银票为什么难伪造", body: "备用正文",
    referenceText: "", referenceRole: "style_only", targetDurationSeconds: 180,
    visualDensity: "standard", webEnabled: true,
    scriptInstructions: "视频文案", visualInstructions: "视频画面", ...overrides,
  };
}

test("创作输入 API 保存后可在应用重建时恢复且 envelope 稳定", async () => {
  const dataRoot = await mkdtemp(join(tmpdir(), "yingshu-creative-input-routes-"));
  let app = buildApp(dataRoot);
  try {
    const project = (await app.inject({ method: "POST", url: "/api/projects", payload: { name: "项目" } }))
      .json().project as { id: string };
    const video = (await app.inject({
      method: "POST", url: `/api/projects/${project.id}/videos`, payload: { title: "视频" },
    })).json().video as { id: string };

    const initial = await app.inject({
      method: "GET", url: `/api/projects/${project.id}/videos/${video.id}/input`,
    });
    assert.equal(initial.statusCode, 200);
    assert.equal(initial.json().input.targetDurationSeconds, 180);
    assert.equal(initial.json().input.webEnabled, true);
    assert.equal(typeof initial.json().input.updatedAt, "number");

    const projectSaved = await app.inject({
      method: "PUT", url: `/api/projects/${project.id}/settings`,
      payload: { scriptInstructions: "项目文案", visualInstructions: "项目画面" },
    });
    assert.equal(projectSaved.statusCode, 200);
    assert.equal(projectSaved.json().settings.scriptInstructions, "项目文案");
    assert.equal(typeof projectSaved.json().settings.updatedAt, "number");

    const videoSaved = await app.inject({
      method: "PUT", url: `/api/projects/${project.id}/videos/${video.id}/input`, payload: input({
        inputMode: "body", topic: "保留主题", body: "正文", referenceRole: "content_source",
        visualDensity: "relaxed", webEnabled: false,
      }),
    });
    assert.equal(videoSaved.statusCode, 200);
    assert.equal(videoSaved.json().input.topic, "保留主题");
    assert.equal(videoSaved.json().input.webEnabled, false);

    const globalSaved = await app.inject({
      method: "PUT", url: "/api/product-prompts",
      payload: { scriptInstructions: "全局文案", visualInstructions: "全局画面" },
    });
    assert.equal(globalSaved.statusCode, 200);
    assert.deepEqual(Object.keys(globalSaved.json().settings).sort(),
      ["scriptInstructions", "updatedAt", "visualInstructions"]);

    await app.close();
    app = buildApp(dataRoot);
    assert.equal((await app.inject({
      method: "GET", url: `/api/projects/${project.id}/videos/${video.id}/input`,
    })).json().input.body, "正文");
    assert.equal((await app.inject({ method: "GET", url: "/api/product-prompts" }))
      .json().settings.scriptInstructions, "全局文案");
  } finally {
    await app.close();
    await rm(dataRoot, { recursive: true, force: true });
  }
});

test("创作输入 API 允许空主内容草稿并拒绝字段漂移、错误类型和跨项目视频", async () => {
  const dataRoot = await mkdtemp(join(tmpdir(), "yingshu-creative-input-boundary-"));
  const app = buildApp(dataRoot);
  try {
    const first = (await app.inject({ method: "POST", url: "/api/projects", payload: { name: "甲" } }))
      .json().project as { id: string };
    const second = (await app.inject({ method: "POST", url: "/api/projects", payload: { name: "乙" } }))
      .json().project as { id: string };
    const video = (await app.inject({
      method: "POST", url: `/api/projects/${first.id}/videos`, payload: { title: "视频" },
    })).json().video as { id: string };

    for (const payload of [
      { ...input(), extra: true },
      { ...input(), webEnabled: "true" },
      { ...input(), targetDurationSeconds: 59 },
      { ...input(), visualDensity: "dense" },
      { ...input(), referenceRole: "facts" },
    ]) {
      assert.equal((await app.inject({
        method: "PUT", url: `/api/projects/${first.id}/videos/${video.id}/input`, payload,
      })).statusCode, 400);
    }
    assert.equal((await app.inject({
      method: "PUT", url: `/api/projects/${first.id}/videos/${video.id}/input`, payload: { ...input(), topic: "" },
    })).statusCode, 200);
    assert.equal((await app.inject({
      method: "PUT", url: `/api/projects/${first.id}/videos/${video.id}/input`, payload: { ...input(), inputMode: "body", body: "" },
    })).statusCode, 200);
    assert.equal((await app.inject({
      method: "PUT", url: `/api/projects/${first.id}/settings`, payload: { scriptInstructions: "缺字段" },
    })).statusCode, 400);
    const foreign = await app.inject({
      method: "PUT", url: `/api/projects/${second.id}/videos/${video.id}/input`, payload: input(),
    });
    assert.equal(foreign.statusCode, 404);
    assert.equal(foreign.json().message, "视频不存在或不属于当前项目");

    assert.equal((await app.inject({ method: "DELETE", url: `/api/projects/${first.id}` })).statusCode, 200);
    assert.equal((await app.inject({
      method: "GET", url: `/api/projects/${first.id}/videos/${video.id}/input`,
    })).statusCode, 404);
    assert.equal((await app.inject({
      method: "GET", url: `/api/projects/${first.id}/settings`,
    })).statusCode, 404);
  } finally {
    await app.close();
    await rm(dataRoot, { recursive: true, force: true });
  }
});
