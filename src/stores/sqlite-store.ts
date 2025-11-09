import { IdempotencyError } from "../errors.js";
import type { IdempotencyStore, IdempotencyStoreValue, SqliteDatabaseLike, SqliteRunResult } from "../types.js";

interface SqliteStoreOptions {
  readonly tableName?: string;
  readonly ensureTable?: boolean;
}

interface SqliteRow {
  value: string;
  expires_at: number | null;
}

const DEFAULT_TABLE = "steadykey_entries";

const isPromise = <T>(value: T | Promise<T>): value is Promise<T> =>
  typeof value === "object" && value !== null && "then" in (value as unknown as Record<string, unknown>);

const maybeAwait = async <T>(value: T | Promise<T>): Promise<T> => (isPromise(value) ? value : Promise.resolve(value));

const quoteIdentifier = (identifier: string): string => {
  if (!/^[A-Za-z_][A-Za-z0-9_$.]*$/.test(identifier)) {
    throw new IdempotencyError(`Invalid identifier provided: ${identifier}`);
  }
  return identifier
    .split(".")
    .map((segment) => `"${segment.replace(/"/g, '""')}"`)
    .join(".");
};

const expirationEpoch = (ttlSeconds: number | null): number | null => {
  if (typeof ttlSeconds === "number" && ttlSeconds > 0) {
    return Math.floor((Date.now() + ttlSeconds * 1000) / 1000);
  }
  return null;
};

const ttlFromEpoch = (epochSeconds: number | null): number | null => {
  if (epochSeconds === null) {
    return null;
  }
  const remaining = epochSeconds - Math.floor(Date.now() / 1000);
  return remaining > 0 ? remaining : 0;
};

export class SqliteIdempotencyStore implements IdempotencyStore {
  private readonly table: string;
  private readonly ready: Promise<void>;

  constructor(private readonly db: SqliteDatabaseLike, options: SqliteStoreOptions = {}) {
    if (!db) {
      throw new IdempotencyError("SQLite database handle is required for SqliteIdempotencyStore");
    }

    const rawTable = options.tableName ?? DEFAULT_TABLE;
    this.table = quoteIdentifier(rawTable);

    if (options.ensureTable === false) {
      this.ready = Promise.resolve();
    } else {
      this.ready = this.ensureTable();
    }
  }

  private async ensureTable(): Promise<void> {
    const ddl = `
      CREATE TABLE IF NOT EXISTS ${this.table} (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        expires_at INTEGER NULL
      );
      CREATE INDEX IF NOT EXISTS ${this.table.replace(/"/g, "").replace(/\./g, "_")}_expires_at_idx
        ON ${this.table} (expires_at);
    `;
    await maybeAwait(this.db.exec(ddl));
  }

  async setIfAbsent(key: string, value: string, ttlSeconds: number | null): Promise<boolean> {
    await this.ready;
    const expiresAt = expirationEpoch(ttlSeconds);
    const result = await maybeAwait<SqliteRunResult>(
      this.db.run(
        `INSERT INTO ${this.table} (key, value, expires_at)
         VALUES (?, ?, ?)
         ON CONFLICT (key) DO NOTHING`,
        [key, value, expiresAt],
      ),
    );
    return Boolean(result.changes && result.changes > 0);
  }

  async get(key: string): Promise<IdempotencyStoreValue | null> {
    await this.ready;
    const row = await maybeAwait<SqliteRow | undefined>(
      this.db.get<SqliteRow>(
        `SELECT value, expires_at FROM ${this.table}
         WHERE key = ?
           AND (expires_at IS NULL OR expires_at > STRFTIME('%s', 'now'))
         LIMIT 1`,
        [key],
      ),
    );

    if (!row) {
      return null;
    }

    return {
      value: row.value,
      ttlSeconds: ttlFromEpoch(row.expires_at ?? null),
    };
  }

  async update(key: string, value: string, ttlSeconds: number | null): Promise<void> {
    await this.ready;
    const expiresAt = expirationEpoch(ttlSeconds);
    const result = await maybeAwait<SqliteRunResult>(
      this.db.run(
        `UPDATE ${this.table}
           SET value = ?,
               expires_at = ?
         WHERE key = ?`,
        [value, expiresAt, key],
      ),
    );

    if (!result.changes) {
      throw new IdempotencyError(`Failed to update key ${key} in SQLite store`);
    }
  }

  async delete(key: string): Promise<boolean> {
    await this.ready;
    const result = await maybeAwait<SqliteRunResult>(
      this.db.run(`DELETE FROM ${this.table} WHERE key = ?`, [key]),
    );
    return Boolean(result.changes && result.changes > 0);
  }
}
