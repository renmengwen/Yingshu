import type { FastifyInstance } from "fastify";

import { readModelConfig, toPublicModelConfig, writeModelConfig } from "./model-config.js";

interface ModelConfigRoutesOptions {
  dataRoot: string;
}

interface SaveModelConfigBody {
  providers?: unknown;
  active?: unknown;
}

export async function registerModelConfigRoutes(app: FastifyInstance, options: ModelConfigRoutesOptions) {
  app.get("/api/config/models", async () => {
    const config = await readModelConfig(options.dataRoot);
    return { ok: true, config: toPublicModelConfig(config) };
  });

  app.put<{ Body: SaveModelConfigBody }>("/api/config/models", async (request) => {
    const config = await writeModelConfig(options.dataRoot, request.body);
    return { ok: true, message: "模型配置已保存", config: toPublicModelConfig(config) };
  });
}
