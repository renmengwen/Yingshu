import { resolve } from "node:path";

const queues = new Map<string, Promise<void>>();

// ponytail: 映述当前约定一个 dataRoot 只由一个后端进程写入；支持多进程时改为 OS 级文件锁。
export async function withDataFileMutationLock<T>(dataRoot: string, action: () => Promise<T>): Promise<T> {
  const key = resolve(dataRoot);
  const previous = queues.get(key) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolveQueue) => { release = resolveQueue; });
  queues.set(key, current);
  await previous;
  try {
    return await action();
  } finally {
    release();
    if (queues.get(key) === current) queues.delete(key);
  }
}
