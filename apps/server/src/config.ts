import { resolve } from "node:path";

export function resolveDataRoot(dataRoot = process.env.YINGSHU_DATA_DIR ?? "data") {
  return resolve(dataRoot);
}
