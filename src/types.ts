export type HashAlgorithm = "sha256" | "sha512";

export type JsonPrimitive = string | number | boolean | null;

export type JsonValue = JsonPrimitive | { [key: string]: JsonValue } | JsonValue[];

export type IdempotencyMetadata = JsonValue;

export interface IdempotencyManagerOptions {
  readonly keyPrefix?: string;
  readonly defaultTtlSeconds?: number | null;
  readonly hashAlgorithm?: HashAlgorithm;
  readonly storeCanonicalPayload?: boolean;
}

export interface IdempotencyRegisterOptions {
  readonly ttlSeconds?: number | null;
  readonly metadata?: IdempotencyMetadata;
  readonly storeCanonicalPayload?: boolean;
}

export interface IdempotencyRecord {
  readonly id: string;
  readonly payloadHash: string;
  readonly createdAt: string;
  readonly metadata?: IdempotencyMetadata;
  readonly canonicalPayload?: string;
  readonly ttlSeconds?: number | null;
}

export interface IdempotencyRegistrationResult {
  readonly id: string;
  readonly key: string;
  readonly stored: boolean;
  readonly record: IdempotencyRecord;
}

export interface IdempotencyLookupResult {
  readonly id: string;
  readonly key: string;
  readonly record: IdempotencyRecord;
  readonly ttlSeconds?: number | null;
}

export interface IdempotencyStoreValue {
  readonly value: string;
  readonly ttlSeconds?: number | null;
}

export interface IdempotencyStore {
  setIfAbsent(key: string, value: string, ttlSeconds: number | null): Promise<boolean>;
  get(key: string): Promise<IdempotencyStoreValue | null>;
  update(key: string, value: string, ttlSeconds: number | null): Promise<void>;
  delete(key: string): Promise<boolean>;
}

export interface MemcachedClientLike {
  add(key: string, value: string, lifetime: number, callback: (error: unknown, success: boolean) => void): void;
  set(key: string, value: string, lifetime: number, callback: (error: unknown, success: boolean) => void): void;
  get(key: string, callback: (error: unknown, data: string | undefined | null) => void): void;
  del(key: string, callback: (error: unknown, success: boolean) => void): void;
  touch?(key: string, lifetime: number, callback: (error: unknown, success: boolean) => void): void;
}

export interface PgClientLike {
  query<T = unknown>(text: string, params?: readonly unknown[]): Promise<{ rowCount: number; rows: T[] }>;
}

export interface MySqlClientLike {
  execute<T = unknown>(sql: string, params?: readonly unknown[]): Promise<[T, unknown]>;
}

export interface MongoCollectionLike<TDocument> {
  findOne(filter: Record<string, unknown>): Promise<TDocument | null>;
  insertOne(doc: TDocument): Promise<{ acknowledged: boolean }>;
  updateOne(
    filter: Record<string, unknown>,
    update: Record<string, unknown>,
    options?: { upsert?: boolean },
  ): Promise<{ matchedCount: number; modifiedCount: number }>;
  deleteOne(filter: Record<string, unknown>): Promise<{ deletedCount?: number }>;
  createIndex(keys: Record<string, unknown>, options?: Record<string, unknown>): Promise<string>;
}

export interface SqliteRunResult {
  changes?: number;
}

export interface SqliteDatabaseLike {
  exec(sql: string): void | Promise<void>;
  run(sql: string, params?: readonly unknown[] | Record<string, unknown>): SqliteRunResult | Promise<SqliteRunResult>;
  get<T = unknown>(
    sql: string,
    params?: readonly unknown[] | Record<string, unknown>,
  ): T | undefined | Promise<T | undefined>;
}

export interface DynamoDbClientLike {
  put(params: {
    TableName: string;
    Item: Record<string, unknown>;
    ConditionExpression?: string;
    ExpressionAttributeNames?: Record<string, string>;
    ExpressionAttributeValues?: Record<string, unknown>;
  }): Promise<unknown>;
  get(params: {
    TableName: string;
    Key: Record<string, unknown>;
    ConsistentRead?: boolean;
    ProjectionExpression?: string;
    ExpressionAttributeNames?: Record<string, string>;
  }): Promise<{ Item?: Record<string, unknown> | undefined } | undefined>;
  update(params: {
    TableName: string;
    Key: Record<string, unknown>;
    UpdateExpression: string;
    ConditionExpression?: string;
    ExpressionAttributeNames?: Record<string, string>;
    ExpressionAttributeValues?: Record<string, unknown>;
    ReturnValues?: string;
  }): Promise<unknown>;
  delete(params: {
    TableName: string;
    Key: Record<string, unknown>;
    ConditionExpression?: string;
    ExpressionAttributeNames?: Record<string, string>;
    ExpressionAttributeValues?: Record<string, unknown>;
    ReturnValues?: string;
  }): Promise<{ Attributes?: Record<string, unknown> | undefined } | undefined>;
}
