# steadykey

Deterministic idempotency manager for JSON payloads with pluggable persistence. Generate stable idempotency keys, prevent duplicate work, and keep canonical payloads for auditing when you need them.

## Contents

- Getting Started
- Installation
- Quick Tour
- How It Works
- API Reference
- Storage Adapters
- Utilities
- Error Reference
- Developing and Testing
- Need Help?

## Getting Started

Use `IdempotencyManager` to protect any workflow where repeated payloads should only be processed once. The manager stores a marker the first time it sees a payload, then lets you decide what to do when the payload returns.

```ts
import { createClient } from "redis";
import { IdempotencyManager, RedisIdempotencyStore } from "steadykey";

const redis = createClient({ url: process.env.REDIS_URL });
await redis.connect();

const store = new RedisIdempotencyStore(redis);
const manager = new IdempotencyManager(store, {
  keyPrefix: "checkout",
  defaultTtlSeconds: 3600,
  storeCanonicalPayload: true,
});

const payload = { orderId: "order-123", total: 42.5 };

const registration = await manager.register(payload, {
  metadata: { workflow: "checkout" },
});

if (registration.stored) {
  // First encounter: perform the expensive work and persist your result.
  // Later you can call manager.clear(id) or manager.updateTtl(id, ttl) when done.
} else {
  // Duplicate payload: skip the work and reuse the prior result.
}
```

For quick checks, call `steadyKey(payload)` to get a deterministic hash without creating a manager.

## Installation

Install the core package plus the adapter dependencies your project uses.

```sh
npm install steadykey

# Optional adapter helpers
npm install redis             # RedisIdempotencyStore
npm install memcached         # MemcachedIdempotencyStore
npm install pg                # PostgresIdempotencyStore
npm install mysql2            # MySqlIdempotencyStore
npm install mongodb           # MongoIdempotencyStore
npm install better-sqlite3    # SqliteIdempotencyStore
```

## Quick Tour

- `IdempotencyManager` orchestrates key generation, storage, TTL management, and collision detection.
- Storage adapters implement the lightweight `IdempotencyStore` interface so you can bring your own persistence layer.
- Utility helpers (`steadyKey`, `canonicalize`, `hashCanonicalValue`) let you generate and inspect deterministic payload hashes outside of a full manager.
- Typed results explain whether the current call was stored (`stored: true`) or matches an existing record (`stored: false`).

## How It Works

1. Payloads are canonicalized before hashing. Object keys are sorted, `undefined` values are dropped, Maps/Sets/BigInts/Buffers are normalized, and Dates become ISO strings. Identical logical payloads always hash to the same value.
2. The chosen hash algorithm (`sha256` by default) creates an idempotency identifier.
3. `IdempotencyManager` prefixes the identifier (default `idempotency:`) to build the storage key.
4. The storage adapter stores the record if the key is not already present. When the key exists, the stored payload hash is compared to guard against silent collisions.
5. TTLs come either from the manager constructor (`defaultTtlSeconds`), from each registration call, or can be removed entirely by passing `null` or `0`.

## API Reference

### `steadyKey(payload, options?)`

- Returns a deterministic string hash for any JSON-like payload.
- `options.hashAlgorithm` accepts "sha256" (default) or "sha512".

```ts
import { steadyKey } from "steadykey";

const key = steadyKey({ customerId: 123, items: ["A", "B"] });
// same key every call, regardless of object key order
```

### `class IdempotencyManager`

```ts
const manager = new IdempotencyManager(store, options?);
```

- `store` must satisfy the `IdempotencyStore` interface (see adapters below).
- `options.keyPrefix` (string) defaults to "idempotency". Trailing colons are trimmed automatically.
- `options.defaultTtlSeconds` (positive integer | `null` | `undefined`) sets the fallback TTL. `null` or `undefined` means no expiration.
- `options.hashAlgorithm` overrides the hashing algorithm used for the manager ("sha256" or "sha512").
- `options.storeCanonicalPayload` stores the canonical JSON alongside the record to help with auditing or debugging.

#### `generateId(payload)`

Returns the deterministic hash for a payload using the manager's algorithm. Useful if you want to build keys or pre-compute lookups.

#### `buildKey(id)`

Combines `keyPrefix` and an id into the stored key. The legacy alias `buildRedisKey` is still available but deprecated.

#### `register(payload, options?)`

Stores a record the first time the payload is seen.

```ts
const result = await manager.register(payload, {
  ttlSeconds: 900,
  metadata: { workflow: "checkout" },
  storeCanonicalPayload: false,
});

if (result.stored) {
  // process payload
}
```

- `options.ttlSeconds` overrides the manager default for this call.
- `options.metadata` accepts any JSON-serializable object and is stored with the record.
- `options.storeCanonicalPayload` toggles payload storage per call.
- Result shape: `{ id, key, stored, record }` where `record` reflects the stored data (including metadata and canonical payload when present).

#### `lookupByPayload(payload)` / `lookupById(id)`

Fetch existing records without registering anything. Returns `null` when no record is found.

```ts
const previous = await manager.lookupByPayload(payload);
if (previous) {
  console.log(previous.record.metadata);
}
```

- Lookup results include `{ id, key, record, ttlSeconds }` where `ttlSeconds` comes from the backing store when available.

#### `updateTtl(id, ttlSeconds)`

Refreshes, sets, or removes the TTL for an existing record. Pass `null` or `0` to make the record persistent. Throws when the key does not exist.

#### `clear(id)`

Deletes the stored record. Returns `true` when a record was removed.

### Records and Data Shapes

- `IdempotencyRecord`: `{ id, payloadHash, createdAt, metadata?, canonicalPayload?, ttlSeconds? }`
- `IdempotencyRegistrationResult`: `{ id, key, stored, record }`
- `IdempotencyLookupResult`: `{ id, key, record, ttlSeconds? }`
- `HashAlgorithm`: union of "sha256" | "sha512"

These types are exported from `steadykey` so you can annotate your code when TypeScript type safety matters.

### Creating Custom Stores

Implement the `IdempotencyStore` interface if you need a bespoke persistence layer.

```ts
interface IdempotencyStore {
  setIfAbsent(key: string, value: string, ttlSeconds: number | null): Promise<boolean>;
  get(key: string): Promise<{ value: string; ttlSeconds?: number | null } | null>;
  update(key: string, value: string, ttlSeconds: number | null): Promise<void>;
  delete(key: string): Promise<boolean>;
}
```

- `setIfAbsent` must behave atomically: only return `true` when the key did not exist.
- `get` should ignore expired entries and return their TTL when known.
- `update` must throw when the key is missing to avoid silently masking data issues.
- `delete` should return whether the key was removed.

## Storage Adapters

### InMemoryIdempotencyStore

- Lightweight Map-based implementation ideal for tests.
- Constructor accepts `{ now?: () => number }` for deterministic time sources.
- Exposes `advanceTime(milliseconds)` to fast-forward expirations in tests.

```ts
import { InMemoryIdempotencyStore } from "steadykey";

const store = new InMemoryIdempotencyStore();
const manager = new IdempotencyManager(store);

store.advanceTime(5_000); // simulate clock jumps in unit tests
```

### RedisIdempotencyStore

- Wraps a `redis` client with `set`, `get`, `ttl`, `persist`, and `del` methods.
- Pass TTLs via `EX` so expirations are handled server-side.
- `update` removes TTLs when `ttlSeconds` is `null`.

```ts
const redisStore = new RedisIdempotencyStore(redisClient);
```

### MemcachedIdempotencyStore

- Works with clients compatible with the `memcached` npm package.
- TTL reporting is not available, so lookups return `ttlSeconds: undefined`.
- Uses `add` for atomic set-if-absent operations.

```ts
const memcachedStore = new MemcachedIdempotencyStore(memcachedClient);
```

### PostgresIdempotencyStore

- Requires any client exposing a `query(sql, params)` method (e.g., `pg.Pool`).
- Options: `{ tableName?: string, ensureTable?: boolean }`.
- Defaults to creating `steadykey_entries` with an `expires_at` index. Disable auto-DDL with `ensureTable: false`.

```ts
const pgStore = new PostgresIdempotencyStore(pool, {
  tableName: "public.steadykey_entries",
});
```

### MySqlIdempotencyStore

- Works with `mysql2/promise` connections.
- Options: `{ tableName?: string, ensureTable?: boolean, keyLength?: number }`.
- Auto-DDL creates an indexed table with configurable primary key length.

```ts
const mysqlStore = new MySqlIdempotencyStore(connection, {
  tableName: "steadykey_entries",
  keyLength: 128,
});
```

### MongoIdempotencyStore

- Accepts a MongoDB collection implementing `insertOne`, `findOne`, `updateOne`, `deleteOne`, and `createIndex`.
- Options: `{ ensureIndexes?: boolean }`. Defaults to building a TTL index on `expiresAt`.

```ts
const mongoStore = new MongoIdempotencyStore(collection, {
  ensureIndexes: true,
});
```

### SqliteIdempotencyStore

- Compatible with synchronous libraries such as `better-sqlite3` or async wrappers that match the minimal interface.
- Options: `{ tableName?: string, ensureTable?: boolean }`.
- Automatically creates a table keyed by `key` with an index on `expires_at` (epoch seconds).

```ts
const sqliteStore = new SqliteIdempotencyStore(sqliteDb, {
  tableName: "steadykey_entries",
});
```

## Utilities

- `canonicalize(value)` returns the deterministic JSON string used for hashing. Useful for debugging when combined with `storeCanonicalPayload`.
- `hashCanonicalValue(canonicalValue, algorithm)` hashes previously canonicalized JSON. This is exported for advanced integrations or to align custom tooling with Steadykey.

```ts
import { canonicalize, hashCanonicalValue } from "steadykey";

const canonical = canonicalize(payload);
const id = hashCanonicalValue(canonical, "sha512");
```

## Error Reference

- `IdempotencyError`: thrown for invalid input or misconfigured stores.
- `IdempotencyCollisionError`: thrown when two different payloads attempt to reuse the same key.
- `IdempotencySerializationError`: wraps canonicalization or JSON serialization issues. Inspect the message for the underlying cause.

Always surface collisions and serialization errors in logs or metrics—they indicate data drift or payloads the hashing strategy cannot support yet.

## Developing and Testing

- Run unit tests with `npm test` (Vitest).
- Build distributable bundles with `npm run build` (outputs ESM, CJS, and type declarations under `dist/`).
- Build once before running the Node examples under `examples/` (they import from `dist/index.js`).
- When adding new storage backends, implement the `IdempotencyStore` contract and add adapter-specific tests under `tests/`.

## Need Help?

- Open an issue or discussion in the repository with payload samples and adapter details.
- Pull requests are welcome—please include tests and update this README when the API surface changes.
