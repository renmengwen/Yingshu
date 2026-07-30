import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { openDatabase } from "./database.js";
import {
  createProject,
  createVideo,
  deleteProject,
  getProject,
  getVideo,
  listProjects,
  listVideos,
  ProjectVideoStoreError,
} from "./project-video-store.js";

test("项目和视频校验统一规范文本且拒绝空值与超长内容", async () => {
  const dataRoot = await mkdtemp(join(tmpdir(), "yingshu-project-validation-"));
  const connection = openDatabase(dataRoot);
  try {
    const project = createProject(connection.database, { name: "  映\u3000述　 项目  " }, 10);
    assert.equal(project.name, "映 述 项目");
    const video = createVideo(connection.database, project.id, { title: "  第一条\n视频  " }, 20);
    assert.equal(video.title, "第一条 视频");
    assert.equal(video.status, "draft");
    assert.throws(
      () => createProject(connection.database, { name: "　 " }),
      (error: unknown) => error instanceof ProjectVideoStoreError && error.statusCode === 400,
    );
    assert.throws(
      () => createVideo(connection.database, project.id, { title: "长".repeat(101) }),
      /视频标题不能超过 100 个字符/,
    );
  } finally {
    connection.close();
    await rm(dataRoot, { recursive: true, force: true });
  }
});

test("视频严格归属项目且删除项目由数据库级联清理", async () => {
  const dataRoot = await mkdtemp(join(tmpdir(), "yingshu-project-relation-"));
  const connection = openDatabase(dataRoot);
  try {
    const first = createProject(connection.database, { name: "甲项目" }, 100);
    const second = createProject(connection.database, { name: "乙项目" }, 200);
    const video = createVideo(connection.database, first.id, { title: "甲视频" }, 300);

    assert.equal(getVideo(connection.database, first.id, video.id).projectId, first.id);
    assert.throws(
      () => getVideo(connection.database, second.id, video.id),
      /视频不存在或不属于当前项目/,
    );
    assert.equal(listVideos(connection.database, first.id).length, 1);
    assert.equal(listProjects(connection.database).find((item) => item.id === first.id)?.videoCount, 1);
    assert.ok(getProject(connection.database, first.id).updatedAt > first.updatedAt);

    deleteProject(connection.database, first.id);
    assert.equal(connection.database.prepare("SELECT COUNT(*) AS count FROM videos WHERE project_id = ?")
      .get(first.id)?.count, 0);
    assert.throws(() => getProject(connection.database, first.id), /项目不存在/);
  } finally {
    connection.close();
    await rm(dataRoot, { recursive: true, force: true });
  }
});
