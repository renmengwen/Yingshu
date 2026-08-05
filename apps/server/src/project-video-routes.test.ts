import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import Fastify from "fastify";

import { openDatabase } from "./database.js";
import { registerProjectVideoRoutes } from "./project-video-routes.js";

function buildProjectApp(dataRoot: string) {
  const connection = openDatabase(dataRoot);
  const app = Fastify({ logger: false });
  void app.register(registerProjectVideoRoutes, { database: connection.database, dataRoot });
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

test("DELETE 视频会校验项目归属并删除数据库记录、配音、渲染和成片文件", async () => {
  const dataRoot = await mkdtemp(join(tmpdir(), "yingshu-video-delete-"));
  const app = buildProjectApp(dataRoot);
  try {
    const project = (await app.inject({
      method: "POST", url: "/api/projects", payload: { name: "删除测试项目" },
    })).json().project as { id: string };
    const other = (await app.inject({
      method: "POST", url: "/api/projects", payload: { name: "其他项目" },
    })).json().project as { id: string };
    const video = (await app.inject({
      method: "POST", url: `/api/projects/${project.id}/videos`, payload: { title: "待删除视频" },
    })).json().video as { id: string };
    const ttsFile = join(dataRoot, "video-tts", video.id, "audio.wav");
    const finalFile = join(dataRoot, "videos", video.id, "renders", "final", "video.mp4");
    await mkdir(dirname(ttsFile), { recursive: true });
    await mkdir(dirname(finalFile), { recursive: true });
    await writeFile(ttsFile, "audio");
    await writeFile(finalFile, "video");

    const crossed = await app.inject({
      method: "DELETE", url: `/api/projects/${other.id}/videos/${video.id}`,
    });
    assert.equal(crossed.statusCode, 404);
    await access(ttsFile);
    await access(finalFile);

    const deleted = await app.inject({
      method: "DELETE", url: `/api/projects/${project.id}/videos/${video.id}`,
    });
    assert.equal(deleted.statusCode, 200);
    assert.match(deleted.json().message, /全部内容已永久删除/u);
    assert.equal((await app.inject({
      method: "GET", url: `/api/projects/${project.id}/videos`,
    })).json().items.length, 0);
    await assert.rejects(access(ttsFile), { code: "ENOENT" });
    await assert.rejects(access(finalFile), { code: "ENOENT" });
  } finally {
    await app.close();
    await rm(dataRoot, { recursive: true, force: true });
  }
});
