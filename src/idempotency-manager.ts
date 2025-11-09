import { canonicalize, deserializeRecord, hashCanonicalValue, serializeRecord } from "./utils.js";
import { IdempotencyCollisionError, IdempotencyError } from "./errors.js";
import type {
  HashAlgorithm,
  IdempotencyLookupResult,
  IdempotencyManagerOptions,
  IdempotencyRecord,
  IdempotencyRegisterOptions,
  IdempotencyRegistrationResult,
  IdempotencyStore,
} from "./types.js";

const DEFAULT_PREFIX = "idempotency";
const DEFAULT_HASH_ALGORITHM: HashAlgorithm = "sha256";

const isFiniteTtl = (ttlSeconds: number | null | undefined): ttlSeconds is number =>
  typeof ttlSeconds === "number" && Number.isFinite(ttlSeconds) && ttlSeconds > 0;

export class IdempotencyManager {
  private readonly store: IdempotencyStore;
  private readonly keyPrefix: string;
  private readonly defaultTtlSeconds: number | null;
  private readonly hashAlgorithm: HashAlgorithm;
  private readonly storeCanonicalPayload: boolean;

  constructor(store: IdempotencyStore, options: IdempotencyManagerOptions = {}) {
    if (!store) {
      throw new IdempotencyError("A storage adapter instance is required");
    }

    this.store = store;
    this.keyPrefix = options.keyPrefix?.replace(/:+$/, "") ?? DEFAULT_PREFIX;
    const defaultTtl = options.defaultTtlSeconds;
    if (defaultTtl === undefined || defaultTtl === null) {
      this.defaultTtlSeconds = null;
    } else {
      if (!Number.isInteger(defaultTtl) || defaultTtl <= 0) {
        throw new IdempotencyError("defaultTtlSeconds must be a positive integer when provided");
      }
      this.defaultTtlSeconds = defaultTtl;
    }
    this.hashAlgorithm = options.hashAlgorithm ?? DEFAULT_HASH_ALGORITHM;
    this.storeCanonicalPayload = options.storeCanonicalPayload ?? false;
  }

  public generateId(payload: unknown): string {
    const canonicalPayload = canonicalize(payload);
    return hashCanonicalValue(canonicalPayload, this.hashAlgorithm);
  }

  public buildKey(id: string): string {
    return `${this.keyPrefix}:${id}`;
  }

  /**
   * @deprecated Use {@link buildKey} instead. This remains for backwards compatibility.
   */
  public buildRedisKey(id: string): string {
    return this.buildKey(id);
  }

  public async register(
    payload: unknown,
    options: IdempotencyRegisterOptions = {},
  ): Promise<IdempotencyRegistrationResult> {
    const canonicalPayload = canonicalize(payload);
    const id = hashCanonicalValue(canonicalPayload, this.hashAlgorithm);
  const key = this.buildKey(id);
    const ttlSeconds = this.resolveTtl(options.ttlSeconds);
    const storeCanonicalPayload = options.storeCanonicalPayload ?? this.storeCanonicalPayload;

    const record: IdempotencyRecord = {
      id,
      payloadHash: id,
      createdAt: new Date().toISOString(),
      metadata: options.metadata,
      canonicalPayload: storeCanonicalPayload ? canonicalPayload : undefined,
      ttlSeconds,
    };

    const serialized = serializeRecord({ record });
    const inserted = await this.store.setIfAbsent(key, serialized, ttlSeconds);
    if (inserted) {
      return { id, key, stored: true, record };
    }

    const existingValue = await this.store.get(key);
    if (!existingValue) {
      throw new IdempotencyError("Failed to persist idempotency record due to concurrent deletion");
    }

    const existingRecord = deserializeRecord(existingValue.value);

    if (existingRecord.payloadHash !== record.payloadHash) {
      throw new IdempotencyCollisionError(`Collision detected for key ${key}`);
    }

    return { id, key, stored: false, record: existingRecord };
  }

  public async lookupByPayload(payload: unknown): Promise<IdempotencyLookupResult | null> {
    const canonicalPayload = canonicalize(payload);
    const id = hashCanonicalValue(canonicalPayload, this.hashAlgorithm);
    return this.lookupById(id);
  }

  public async lookupById(id: string): Promise<IdempotencyLookupResult | null> {
  const key = this.buildKey(id);
    const stored = await this.store.get(key);
    if (!stored) {
      return null;
    }

    const record = deserializeRecord(stored.value);
    const ttlSeconds = stored.ttlSeconds ?? record.ttlSeconds ?? null;
    return { id, key, record, ttlSeconds };
  }

  public async clear(id: string): Promise<boolean> {
  const key = this.buildKey(id);
    return this.store.delete(key);
  }

  public async updateTtl(id: string, ttlSeconds: number | null | undefined): Promise<void> {
    const key = this.buildRedisKey(id);
    const newTtl = this.resolveTtl(ttlSeconds);

    const stored = await this.store.get(key);
    if (!stored) {
      throw new IdempotencyError(`Cannot update TTL for missing key ${key}`);
    }

    const existingRecord = deserializeRecord(stored.value);
    const recordToStore: IdempotencyRecord = {
      ...existingRecord,
      ttlSeconds: isFiniteTtl(newTtl) ? newTtl : null,
    };
    const serialized = serializeRecord({ record: recordToStore });
    await this.store.update(key, serialized, newTtl);
  }

  private resolveTtl(ttlSeconds: number | null | undefined): number | null {
    if (ttlSeconds === undefined) {
      return this.defaultTtlSeconds;
    }

    if (ttlSeconds === null) {
      return null;
    }

    if (!Number.isInteger(ttlSeconds) || ttlSeconds < 0) {
      throw new IdempotencyError("TTL must be a positive integer, null, or undefined");
    }

    if (ttlSeconds === 0) {
      return null;
    }

    return ttlSeconds;
  }
}
