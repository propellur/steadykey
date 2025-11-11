import { describe, it, expect, beforeEach } from "vitest";
import {
  IdempotencyManager,
  IdempotencyCollisionError,
  steadyKey,
} from "../src/index.js";
import type { IdempotencyStore, IdempotencyStoreValue } from "../src/types.js";

interface StoredEntry {
  value: string;
  expiresAt: number | null;
}

class TestStore implements IdempotencyStore {
  private readonly store = new Map<string, StoredEntry>();
  private currentTime = Date.now();

  async setIfAbsent(key: string, value: string, ttlSeconds: number | null): Promise<boolean> {
    this.evictIfExpired(key);
    if (this.store.has(key)) {
      return false;
    }
    this.store.set(key, {
      value,
      expiresAt: this.toExpiration(ttlSeconds),
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
        entry.expiresAt === null
          ? null
          : Math.max(0, Math.floor((entry.expiresAt - this.currentTime) / 1000)),
    };
  }

  async update(key: string, value: string, ttlSeconds: number | null): Promise<void> {
    this.evictIfExpired(key);
    if (!this.store.has(key)) {
      throw new Error(`Key ${key} missing in TestStore`);
    }
    this.store.set(key, {
      value,
      expiresAt: this.toExpiration(ttlSeconds),
    });
  }

  async delete(key: string): Promise<boolean> {
    return this.store.delete(key);
  }

  forceSet(key: string, value: string): void {
    this.store.set(key, { value, expiresAt: null });
  }

  advanceTime(milliseconds: number): void {
    this.currentTime += milliseconds;
  }

  private toExpiration(ttlSeconds: number | null): number | null {
    if (typeof ttlSeconds === "number" && ttlSeconds > 0) {
      return this.currentTime + ttlSeconds * 1000;
    }
    return null;
  }

  private evictIfExpired(key: string): void {
    const entry = this.store.get(key);
    if (!entry) {
      return;
    }
    if (entry.expiresAt !== null && entry.expiresAt <= this.currentTime) {
      this.store.delete(key);
    }
  }
}

const createPayload = (overrides: Partial<Record<string, unknown>> = {}) => ({
  id: "order-123",
  total: 42.5,
  items: [
    { sku: "ABC", qty: 1 },
    { sku: "XYZ", qty: 2 },
  ],
  ...overrides,
});

describe("IdempotencyManager", () => {
  let store: TestStore;
  let manager: IdempotencyManager;

  beforeEach(() => {
    store = new TestStore();
    manager = new IdempotencyManager(store, {
      keyPrefix: "tests:idempotency",
      defaultTtlSeconds: 60,
      storeCanonicalPayload: true,
    });
  });

  it("generates deterministic ids for the same payload", () => {
    const payloadA = createPayload({ extra: "value" });
    const payloadB = {
      extra: "value",
      total: 42.5,
      id: "order-123",
      items: [
        { qty: 1, sku: "ABC" },
        { qty: 2, sku: "XYZ" },
      ],
    };

    const idA = manager.generateId(payloadA);
    const idB = manager.generateId(payloadB);

    expect(idA).toBe(idB);
  });

  it("steadyKey helper matches manager-generated ids", () => {
    const payload = createPayload({ extra: "helper" });
    const standalone = steadyKey(payload);
    const managed = manager.generateId(payload);
    expect(standalone).toBe(managed);
  });

  it("persists a new idempotency record and respects TTL", async () => {
    const payload = createPayload();

    const result = await manager.register(payload);
    expect(result.stored).toBe(true);
    expect(result.record.ttlSeconds).toBe(60);

    const lookup = await manager.lookupById(result.id);
    expect(lookup?.record.metadata).toBeUndefined();
    expect(lookup?.record.canonicalPayload).toBeDefined();
    expect(lookup?.ttlSeconds).toBeGreaterThan(0);
  });

  it("returns existing record without overwriting when payload repeats", async () => {
    const payload = createPayload();

    const first = await manager.register(payload, { metadata: { attempt: 1 } });
    expect(first.stored).toBe(true);

    const second = await manager.register(payload, { metadata: { attempt: 2 } });
    expect(second.stored).toBe(false);
    expect(second.record.metadata).toEqual({ attempt: 1 });
  });

  it("handles string payloads", async () => {
    const first = await manager.register("simple-payload", { metadata: "initial", ttlSeconds: 15 });
    expect(first.stored).toBe(true);
    expect(first.record.metadata).toBe("initial");
    expect(first.record.ttlSeconds).toBe(15);

    const second = await manager.register("simple-payload");
    expect(second.stored).toBe(false);
    expect(second.record.metadata).toBe("initial");

    const lookup = await manager.lookupByPayload("simple-payload");
    expect(lookup?.id).toBe(first.id);
    expect((lookup?.ttlSeconds ?? 0)).toBeGreaterThan(0);

    await manager.updateTtl(first.id, null);
    const persistent = await manager.lookupById(first.id);
    expect(persistent?.ttlSeconds).toBeNull();

    const cleared = await manager.clear(first.id);
    expect(cleared).toBe(true);
    expect(await manager.lookupById(first.id)).toBeNull();
  });

  it("allows overriding TTL per call", async () => {
    const payload = createPayload();

    const result = await manager.register(payload, { ttlSeconds: 5 });
    expect(result.record.ttlSeconds).toBe(5);

    const lookup = await manager.lookupById(result.id);
    expect(lookup?.ttlSeconds).not.toBeNull();
    expect((lookup?.ttlSeconds ?? 0)).toBeLessThanOrEqual(5);
    expect((lookup?.ttlSeconds ?? 0)).toBeGreaterThanOrEqual(0);
  });

  it("can remove TTL and make records persistent", async () => {
    const payload = createPayload();
    const { id } = await manager.register(payload, { ttlSeconds: 2 });

    await manager.updateTtl(id, null);
    const lookup = await manager.lookupById(id);
    expect(lookup?.ttlSeconds).toBeNull();
  });

  it("throws when attempting to update TTL on missing key", async () => {
    await expect(manager.updateTtl("missing", 10)).rejects.toThrow(/missing key/);
  });

  it("clears records", async () => {
    const payload = createPayload();
    const { id } = await manager.register(payload);

    const cleared = await manager.clear(id);
    expect(cleared).toBe(true);
    expect(await manager.lookupById(id)).toBeNull();
  });

  it("detects hash collisions", async () => {
    const payload = createPayload();
    const registration = await manager.register(payload);
  const key = manager.buildKey(registration.id);

    store.forceSet(
      key,
      JSON.stringify({
        ...registration.record,
        payloadHash: "different-hash",
      }),
    );

    await expect(manager.register(payload)).rejects.toBeInstanceOf(IdempotencyCollisionError);
  });

  it("supports lookup by payload", async () => {
    const payload = createPayload({ metadata: { firstAttempt: true } });
    const registration = await manager.register(payload);

    const lookup = await manager.lookupByPayload(payload);
    expect(lookup?.id).toBe(registration.id);
    expect(lookup?.record.payloadHash).toBe(registration.record.payloadHash);
  });

  it("honours fake timer advances for TTL", async () => {
    const payload = createPayload();
    const { id } = await manager.register(payload, { ttlSeconds: 10 });

    store.advanceTime(8000);
    const lookup = await manager.lookupById(id);
    expect((lookup?.ttlSeconds ?? 0)).toBeLessThanOrEqual(2);

    store.advanceTime(4000);
    expect(await manager.lookupById(id)).toBeNull();
  });
});
