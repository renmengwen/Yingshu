export interface TextModelTimeoutOptions {
  firstActivityMs: number;
  idleMs: number;
  totalMs: number;
  signal?: AbortSignal;
  isCancellationRequested?: () => boolean;
  cancellationPollMs?: number;
}

function timeout(reason: string) {
  return new DOMException(reason, "TimeoutError");
}

export async function withTextModelTimeout<T>(
  call: (signal: AbortSignal, onActivity: () => void) => Promise<T>,
  options: TextModelTimeoutOptions,
) {
  const idleController = new AbortController();
  const totalController = new AbortController();
  const cancellationController = new AbortController();
  let idle = setTimeout(() => idleController.abort(timeout("first activity timeout")), options.firstActivityMs);
  const total = setTimeout(() => totalController.abort(timeout("total timeout")), options.totalMs);
  const poll = options.isCancellationRequested
    ? setInterval(() => {
      if (options.isCancellationRequested?.()) cancellationController.abort(new DOMException("cancelled", "AbortError"));
    }, options.cancellationPollMs ?? 50)
    : undefined;
  const onActivity = () => {
    clearTimeout(idle);
    idle = setTimeout(() => idleController.abort(timeout("idle timeout")), options.idleMs);
  };
  try {
    return await call(AbortSignal.any([
      idleController.signal,
      totalController.signal,
      cancellationController.signal,
      ...(options.signal ? [options.signal] : []),
    ]), onActivity);
  } finally {
    if (poll) clearInterval(poll);
    clearTimeout(idle);
    clearTimeout(total);
  }
}
