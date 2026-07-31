import assert from "node:assert/strict";
import test from "node:test";
import Fastify from "fastify";
import type { DatabaseSync } from "node:sqlite";

import { registerVideoImageRoutes } from "./video-image-routes.js";

test("图片审核路由只注册冻结的批量、单张、上传、批准和受控预览入口", async () => {
  const app = Fastify();
  await registerVideoImageRoutes(app, {
    database: {} as DatabaseSync,
    dataRoot: "unused",
    resolveImageProvider: async () => null,
  });
  await app.ready();
  const routes: Array<[string, string]> = [
    ["POST", "/api/projects/:projectId/videos/:videoId/image-batches"],
    ["POST", "/api/projects/:projectId/videos/:videoId/visuals/:visualId/image-jobs"],
    ["POST", "/api/projects/:projectId/videos/:videoId/visuals/:visualId/image-candidates/upload"],
    ["PUT", "/api/projects/:projectId/videos/:videoId/visuals/:visualId/image-approval"],
    ["GET", "/api/projects/:projectId/videos/:videoId/image-candidates/:candidateId/preview"],
  ];
  for (const [method, url] of routes) assert.equal(app.hasRoute({ method, url }), true);
  assert.doesNotMatch(app.printRoutes(), /tts|subtitle|render/iu);
  await app.close();
});
