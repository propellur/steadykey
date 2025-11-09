import { createHash } from "crypto";
import { IdempotencySerializationError, IdempotencyError } from "./errors.js";
import type { HashAlgorithm, IdempotencyRecord } from "./types.js";

const BIGINT_PREFIX = "bigint:";
const BUFFER_PREFIX = "buffer:";
const MAP_PREFIX = "map:";
const SET_PREFIX = "set:";

export type CanonicalJsonValue =
  | string
  | number
  | boolean
  | null
  | CanonicalJsonValue[]
  | { [key: string]: CanonicalJsonValue };

export interface SerializeRecordInput {
  readonly record: IdempotencyRecord;
}

export const canonicalize = (value: unknown): string => {
  try {
    const normalized = normalize(value);
    return JSON.stringify(normalized);
  } catch (error) {
    throw new IdempotencySerializationError(
      error instanceof Error ? error.message : "Failed to canonicalize payload",
    );
  }
};

const normalize = (value: unknown): CanonicalJsonValue => {
  if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return value as CanonicalJsonValue;
  }

  if (typeof value === "bigint") {
    return `${BIGINT_PREFIX}${value.toString(10)}`;
  }

  if (value instanceof Date) {
    return value.toJSON();
  }

  if (Buffer.isBuffer(value)) {
    return `${BUFFER_PREFIX}${value.toString("base64")}`;
  }

  if (Array.isArray(value)) {
    return value.map((item) => normalize(item));
  }

  if (value instanceof Map) {
    return Array.from(value.entries())
      .map(([entryKey, entryValue]) => [String(entryKey), normalize(entryValue)] as const)
      .sort(([keyA], [keyB]) => keyA.localeCompare(keyB))
      .map(([entryKey, entryValue]) => `${MAP_PREFIX}${entryKey}:${JSON.stringify(entryValue)}`);
  }

  if (value instanceof Set) {
    const normalizedValues = Array.from(value.values()).map((entry) => normalize(entry));
    return normalizedValues
      .map((entry) => JSON.stringify(entry))
      .sort()
      .map((entry) => `${SET_PREFIX}${entry}`);
  }

  if (typeof value === "object") {
    const plain: Record<string, CanonicalJsonValue> = {};
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, entryValue]) => entryValue !== undefined)
      .sort(([keyA], [keyB]) => keyA.localeCompare(keyB));

    for (const [entryKey, entryValue] of entries) {
      plain[entryKey] = normalize(entryValue);
    }

    return plain;
  }

  throw new IdempotencySerializationError(`Unsupported value type: ${typeof value}`);
};

export const hashCanonicalValue = (canonicalValue: string, algorithm: HashAlgorithm): string => {
  return createHash(algorithm).update(canonicalValue).digest("hex");
};

export const serializeRecord = ({ record }: SerializeRecordInput): string => {
  try {
    return JSON.stringify(record);
  } catch (error) {
    throw new IdempotencySerializationError(
      error instanceof Error ? error.message : "Failed to serialize idempotency record",
    );
  }
};

export const deserializeRecord = (value: string): IdempotencyRecord => {
  try {
    const parsed = JSON.parse(value) as IdempotencyRecord;
    if (typeof parsed !== "object" || parsed === null || typeof parsed.id !== "string") {
      throw new IdempotencyError("Stored idempotency record has invalid shape");
    }
    return parsed;
  } catch (error) {
    if (error instanceof IdempotencyError) {
      throw error;
    }
    throw new IdempotencySerializationError(
      error instanceof Error ? error.message : "Failed to deserialize idempotency record",
    );
  }
};
