import type { RedisClientType, SetOptions } from "redis";
import { IdempotencyError } from "../errors.js";
import type { IdempotencyStore, IdempotencyStoreValue } from "../types.js";

export type RedisClientLike = Pick<
  RedisClientType,
  "set" | "get" | "ttl" | "persist" | "del"
>;

const toTtlSeconds = (ttl: number): number | null => {
  if (ttl < 0) {
    return null;
  }
  return ttl;
};

export class RedisIdempotencyStore implements IdempotencyStore {
  constructor(private readonly redis: RedisClientLike) {
    if (!redis) {
      throw new IdempotencyError("Redis client instance is required for RedisIdempotencyStore");
    }
  }

  async setIfAbsent(key: string, value: string, ttlSeconds: number | null): Promise<boolean> {
    const options: SetOptions = { NX: true };
    if (typeof ttlSeconds === "number" && ttlSeconds > 0) {
      options.EX = ttlSeconds;
    }
    const result = await this.redis.set(key, value, options);
    return result === "OK";
  }

  async get(key: string): Promise<IdempotencyStoreValue | null> {
    const value = await this.redis.get(key);
    if (value === null) {
      return null;
    }
    const ttl = await this.redis.ttl(key);
    return { value, ttlSeconds: toTtlSeconds(ttl) };
  }

  async update(key: string, value: string, ttlSeconds: number | null): Promise<void> {
    const options: SetOptions = { XX: true };
    if (typeof ttlSeconds === "number" && ttlSeconds > 0) {
      options.EX = ttlSeconds;
    }

    const result = await this.redis.set(key, value, options);
    if (result !== "OK") {
      throw new IdempotencyError(`Failed to update key ${key} in Redis store`);
    }

    if (ttlSeconds === null) {
      await this.redis.persist(key);
    }
  }

  async delete(key: string): Promise<boolean> {
    const deleted = await this.redis.del(key);
    return deleted > 0;
  }
}
