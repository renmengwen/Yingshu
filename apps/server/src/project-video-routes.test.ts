import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import Fastify from "fastify";

import { openDatabase } from "./database.js";
import { registerProjectVideoRoutes } from "./project-video-routes.js";

function buildProjectApp(dataRoot: string) {
  const connection = openDatabase(dataRoot);
  const app = Fastify({ logger: false });
  void app.register(registerProjectVideoRoutes, { database: connection.database });
  app.addHook("onClose", async () => connection.close());
  return app;
}

test("Project/Video HTTP 合同持久化并在应用重建后恢复", async () => {
  const dataRoot = await mkdtemp(join(tmpdir(), "yingshu-project-routes-"));
  let app = buildProjectApp(dataRoot);
  try {
    assert.deepEqual((await app.inject({ method: "GET", url: "/api/projects" })).json(), {
      ok: true,
      items: [],
    });
    const createdProject = await app.inject({
      method: "POST",
      url: "/api/projects",
      payload: { name: " 中文项目 " },
    });
    assert.equal(createdProject.statusCode, 201);
    const project = createdProject.json().project as { id: string; name: string };
    assert.equal(project.name, "中文项目");

    const createdVideo = await app.inject({
      method: "POST",
      url: `/api/projects/${project.id}/videos`,
      payload: { title: " 中文草稿 " },
    });
    assert.equal(createdVideo.statusCode, 201);
    const video = createdVideo.json().video as { id: string; status: string };
    assert.equal(video.status, "draft");

    await app.close();
    app = buildProjectApp(dataRoot);
    const restored = await app.inject({
      method: "GET",
      url: `/api/projects/${project.id}/videos/${video.id}`,
    });
    assert.equal(restored.statusCode, 200);
    assert.equal(restored.json().video.title, "中文草稿");
    const listed = await app.inject({ method: "GET", url: "/api/projects" });
    assert.equal(listed.json().items[0].videoCount, 1);
  } finally {
    await app.close();
    await rm(dataRoot, { recursive: true, force: true });
  }
});

test("HTTP 边界拒绝额外字段、非法归属并级联删除项目视频", async () => {
  const dataRoot = await mkdtemp(join(tmpdir(), "yingshu-project-http-boundary-"));
  const app = buildProjectApp(dataRoot);
  try {
    const extra = await app.inject({
      method: "POST", url: "/api/projects", payload: { name: "项目", status: "fake" },
    });
    assert.equal(extra.statusCode, 400);
    assert.equal(extra.json().message, "创建项目只能提交项目名称");

    const first = (await app.inject({
      method: "POST", url: "/api/projects", payload: { name: "甲" },
    })).json().project as { id: string };
    const second = (await app.inject({
      method: "POST", url: "/api/projects", payload: { name: "乙" },
    })).json().project as { id: string };
    const video = (await app.inject({
      method: "POST", url: `/api/projects/${first.id}/videos`, payload: { title: "草稿" },
    })).json().video as { id: string };

    const foreign = await app.inject({
      method: "GET", url: `/api/projects/${second.id}/videos/${video.id}`,
    });
    assert.equal(foreign.statusCode, 404);
    assert.equal(foreign.json().message, "视频不存在或不属于当前项目");

    const deleted = await app.inject({ method: "DELETE", url: `/api/projects/${first.id}` });
    assert.equal(deleted.statusCode, 200);
    assert.equal((await app.inject({
      method: "GET", url: `/api/projects/${first.id}/videos/${video.id}`,
    })).statusCode, 404);
  } finally {
    await app.close();
    await rm(dataRoot, { recursive: true, force: true });
  }
});
