export const TEXT_MODEL_REQUEST_CONCURRENCY = 8;

type Waiter = {
  resolve: (release: () => void) => void;
  reject: (error: unknown) => void;
  signal?: AbortSignal;
  onAbort?: () => void;
};

function abortReason(signal: AbortSignal) {
  return signal.reason instanceof Error ? signal.reason : new DOMException("文本模型请求已取消", "AbortError");
}

export class TextModelConcurrencyGate {
  readonly limit: number;
  #active = 0;
  readonly #waiters: Waiter[] = [];

  constructor(limit = TEXT_MODEL_REQUEST_CONCURRENCY) {
    if (!Number.isSafeInteger(limit) || limit < 1) throw new Error("文本模型请求并发预算无效");
    this.limit = limit;
  }

  get active() { return this.#active; }
  get pending() { return this.#waiters.length; }

  acquire(signal?: AbortSignal): Promise<() => void> {
    if (signal?.aborted) return Promise.reject(abortReason(signal));
    return new Promise((resolve, reject) => {
      const waiter: Waiter = { resolve, reject, signal };
      waiter.onAbort = () => {
        const index = this.#waiters.indexOf(waiter);
        if (index < 0) return;
        this.#waiters.splice(index, 1);
        reject(abortReason(signal!));
      };
      if (this.#active < this.limit) this.#grant(waiter);
      else {
        this.#waiters.push(waiter);
        signal?.addEventListener("abort", waiter.onAbort, { once: true });
      }
    });
  }

  async run<T>(signal: AbortSignal | undefined, task: () => Promise<T>): Promise<T> {
    const release = await this.acquire(signal);
    try {
      signal?.throwIfAborted();
      return await task();
    } finally {
      release();
    }
  }

  #grant(waiter: Waiter) {
    waiter.signal?.removeEventListener("abort", waiter.onAbort!);
    if (waiter.signal?.aborted) {
      waiter.reject(abortReason(waiter.signal));
      this.#drain();
      return;
    }
    this.#active += 1;
    let released = false;
    waiter.resolve(() => {
      if (released) return;
      released = true;
      this.#active -= 1;
      this.#drain();
    });
  }

  #drain() {
    while (this.#active < this.limit && this.#waiters.length > 0) this.#grant(this.#waiters.shift()!);
  }
}

export const textModelConcurrencyGate = new TextModelConcurrencyGate();
