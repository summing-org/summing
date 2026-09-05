export class Deferred<T = void> {
  readonly promise: Promise<T>;
  resolve!: (value: T | PromiseLike<T>) => void;
  reject!: (reason?: unknown) => void;

  constructor() {
    this.promise = new Promise<T>((resolve, reject) => {
      this.resolve = resolve;
      this.reject = reject;
    });
  }
}

export class Semaphore {
  private available: number;
  private readonly waiters: Array<() => void> = [];

  constructor(capacity: number) {
    this.available = capacity;
  }

  async run<T>(action: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    await this.acquire(signal);
    try {
      signal?.throwIfAborted();
      return await action();
    } finally {
      this.release();
    }
  }

  private async acquire(signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    if (this.available > 0) {
      this.available -= 1;
      return;
    }
    await new Promise<void>((resolve, reject) => {
      const ready = () => {
        signal?.removeEventListener("abort", abort);
        resolve();
      };
      const abort = () => {
        const index = this.waiters.indexOf(ready);
        if (index >= 0) this.waiters.splice(index, 1);
        reject(signal!.reason);
      };
      this.waiters.push(ready);
      signal?.addEventListener("abort", abort, { once: true });
    });
  }

  private release(): void {
    const waiter = this.waiters.shift();
    if (waiter) waiter();
    else this.available += 1;
  }
}

interface MutexEntry {
  references: number;
  semaphore: Semaphore;
}

export class KeyedMutex {
  private readonly entries = new Map<string, MutexEntry>();

  async acquire(key: string, signal?: AbortSignal): Promise<() => void> {
    let entry = this.entries.get(key);
    if (!entry) {
      entry = { references: 0, semaphore: new Semaphore(1) };
      this.entries.set(key, entry);
    }
    entry.references += 1;
    const acquired = new Deferred<void>();
    const unlock = new Deferred<void>();
    void entry.semaphore.run(async () => {
      acquired.resolve();
      await unlock.promise;
    }, signal).catch((error) => acquired.reject(error)).finally(() => {
      entry!.references -= 1;
      if (entry!.references === 0) this.entries.delete(key);
    });
    await acquired.promise;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      unlock.resolve();
    };
  }
}

/** Bounded wait with no dangling timer or abort listener after completion. */
export async function waitForCompletion(
  completion: Promise<void>, signal: AbortSignal, timeoutMs: number,
): Promise<void> {
  signal.throwIfAborted();
  let timer: NodeJS.Timeout | undefined;
  let abort: () => void = () => {};
  const stopped = new Promise<never>((_, reject) => {
    abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    timer = setTimeout(() => reject(new Error("review completion timeout")), timeoutMs);
  });
  try { await Promise.race([completion, stopped]); }
  finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", abort);
  }
}
