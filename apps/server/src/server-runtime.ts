import type { FastifyInstance, FastifyListenOptions } from "fastify";

export async function listenAndCloseOnFailure(
  app: Pick<FastifyInstance, "listen" | "close" | "log">,
  options: FastifyListenOptions,
) {
  try {
    await app.listen(options);
    return true;
  } catch (error) {
    app.log.error(error);
    try {
      await app.close();
    } catch (closeError) {
      app.log.error(closeError, "服务启动失败后的资源清理也失败");
    }
    return false;
  }
}
