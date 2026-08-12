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

  async run<T>(action: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await action();
    } finally {
      this.release();
    }
  }

  private async acquire(): Promise<void> {
    if (this.available > 0) {
      this.available -= 1;
      return;
    }
    await new Promise<void>((resolve) => this.waiters.push(resolve));
  }

  private release(): void {
    const waiter = this.waiters.shift();
    if (waiter) waiter();
    else this.available += 1;
  }
}

interface MutexEntry {
  references: number;
  tail: Promise<void>;
}

export class KeyedMutex {
  private readonly entries = new Map<string, MutexEntry>();

  async acquire(key: string): Promise<() => void> {
    let entry = this.entries.get(key);
    if (!entry) {
      entry = { references: 0, tail: Promise.resolve() };
      this.entries.set(key, entry);
    }
    entry.references += 1;
    const previous = entry.tail;
    let unlock!: () => void;
    const current = new Promise<void>((resolveCurrent) => {
      unlock = resolveCurrent;
    });
    entry.tail = previous.then(() => current);
    await previous;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      unlock();
      entry!.references -= 1;
      if (entry!.references === 0) this.entries.delete(key);
    };
  }
}
