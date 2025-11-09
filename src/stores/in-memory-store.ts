import type { IdempotencyStore, IdempotencyStoreValue } from "../types.js";

interface Entry {
  value: string;
  expiresAt: number | null;
}

interface InMemoryStoreOptions {
  readonly now?: () => number;
}

const toExpiryEpoch = (ttlSeconds: number | null, nowMs: number): number | null => {
  if (typeof ttlSeconds === "number" && ttlSeconds > 0) {
    return nowMs + ttlSeconds * 1000;
  }
  return null;
};

export class InMemoryIdempotencyStore implements IdempotencyStore {
  private readonly store = new Map<string, Entry>();
  private readonly nowBase: () => number;
  private timeOffset = 0;

  constructor(options: InMemoryStoreOptions = {}) {
    this.nowBase = options.now ?? (() => Date.now());
  }

  async setIfAbsent(key: string, value: string, ttlSeconds: number | null): Promise<boolean> {
    this.evictIfExpired(key);
    if (this.store.has(key)) {
      return false;
    }
    const nowMs = this.currentTime();
    this.store.set(key, {
      value,
      expiresAt: toExpiryEpoch(ttlSeconds, nowMs),
    });
    return true;
  }

  async get(key: string): Promise<IdempotencyStoreValue | null> {
    this.evictIfExpired(key);
    const entry = this.store.get(key);
    if (!entry) {
      return null;
    }
    return {
      value: entry.value,
      ttlSeconds:
        entry.expiresAt === null ? null : Math.max(0, Math.floor((entry.expiresAt - this.currentTime()) / 1000)),
    };
  }

  async update(key: string, value: string, ttlSeconds: number | null): Promise<void> {
    this.evictIfExpired(key);
    if (!this.store.has(key)) {
      throw new Error(`Key ${key} does not exist in InMemoryIdempotencyStore`);
    }
    const nowMs = this.currentTime();
    this.store.set(key, {
      value,
      expiresAt: toExpiryEpoch(ttlSeconds, nowMs),
    });
  }

  async delete(key: string): Promise<boolean> {
    return this.store.delete(key);
  }

  advanceTime(milliseconds: number): void {
    if (milliseconds <= 0) {
      return;
    }
    this.timeOffset += milliseconds;
    this.purgeExpiredEntries();
  }

  private evictIfExpired(key: string): void {
    const entry = this.store.get(key);
    if (!entry) {
      return;
    }
    if (entry.expiresAt !== null && entry.expiresAt <= this.currentTime()) {
      this.store.delete(key);
    }
  }

  private currentTime(): number {
    return this.nowBase() + this.timeOffset;
  }

  private purgeExpiredEntries(): void {
    for (const key of this.store.keys()) {
      this.evictIfExpired(key);
    }
  }
}
