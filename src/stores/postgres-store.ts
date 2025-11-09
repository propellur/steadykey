import { IdempotencyError } from "../errors.js";
import type { IdempotencyStore, IdempotencyStoreValue, PgClientLike } from "../types.js";

interface PostgresStoreOptions {
  readonly tableName?: string;
  readonly ensureTable?: boolean;
}

interface PostgresRow {
  value: string;
  expires_at: string | null;
}

const DEFAULT_TABLE = "steadykey_entries";

const quoteIdentifier = (identifier: string): string => {
  if (!/^[A-Za-z_][A-Za-z0-9_$.]*$/.test(identifier)) {
    throw new IdempotencyError(`Invalid identifier provided: ${identifier}`);
  }
  return identifier
    .split(".")
    .map((segment) => `"${segment.replace(/"/g, '""')}"`)
    .join(".");
};

const toDateOrNull = (ttlSeconds: number | null): Date | null => {
  if (typeof ttlSeconds === "number" && ttlSeconds > 0) {
    return new Date(Date.now() + ttlSeconds * 1000);
  }
  return null;
};

const ttlFromDate = (expiresAt: Date | null): number | null => {
  if (!expiresAt) {
    return null;
  }
  const remaining = Math.floor((expiresAt.getTime() - Date.now()) / 1000);
  return remaining > 0 ? remaining : 0;
};

const CURRENT_CONDITION = "(expires_at IS NULL OR expires_at > NOW())";

export class PostgresIdempotencyStore implements IdempotencyStore {
  private readonly table: string;
  private readonly ready: Promise<void>;
  private readonly indexName: string;

  constructor(private readonly client: PgClientLike, options: PostgresStoreOptions = {}) {
    if (!client) {
      throw new IdempotencyError("PostgreSQL client instance is required for PostgresIdempotencyStore");
    }

  const rawTable = options.tableName ?? DEFAULT_TABLE;
  this.table = quoteIdentifier(rawTable);
  this.indexName = `${rawTable.replace(/"/g, "").replace(/\./g, "_")}_expires_at_idx`;

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
        expires_at TIMESTAMPTZ NULL
      );
      CREATE INDEX IF NOT EXISTS "${this.indexName}" ON ${this.table} (expires_at);
    `;
    await this.client.query(ddl);
  }

  async setIfAbsent(key: string, value: string, ttlSeconds: number | null): Promise<boolean> {
    await this.ready;
    const expiresAt = toDateOrNull(ttlSeconds);
    const result = await this.client.query(
      `INSERT INTO ${this.table} (key, value, expires_at)
       VALUES ($1, $2, $3)
       ON CONFLICT (key) DO NOTHING`,
      [key, value, expiresAt],
    );
    return result.rowCount === 1;
  }

  async get(key: string): Promise<IdempotencyStoreValue | null> {
    await this.ready;
    const result = await this.client.query<PostgresRow>(
      `SELECT value, expires_at FROM ${this.table} WHERE key = $1 AND ${CURRENT_CONDITION} LIMIT 1`,
      [key],
    );
    const row = result.rows[0];
    if (!row) {
      return null;
    }
    const expiresAt = row.expires_at ? new Date(row.expires_at) : null;
    return { value: row.value, ttlSeconds: ttlFromDate(expiresAt) };
  }

  async update(key: string, value: string, ttlSeconds: number | null): Promise<void> {
    await this.ready;
    const expiresAt = toDateOrNull(ttlSeconds);
    const result = await this.client.query(
      `UPDATE ${this.table}
         SET value = $2,
             expires_at = $3
       WHERE key = $1`,
      [key, value, expiresAt],
    );

    if (result.rowCount === 0) {
      throw new IdempotencyError(`Failed to update key ${key} in Postgres store`);
    }
  }

  async delete(key: string): Promise<boolean> {
    await this.ready;
    const result = await this.client.query(`DELETE FROM ${this.table} WHERE key = $1`, [key]);
    return result.rowCount > 0;
  }
}
