/**
 * Append-only HTTP request audit log (`api_log`).
 *
 * v1 default is in-memory. Production boot injects Postgres when
 * `DATABASE_URL` is set. Paths are already redacted by the caller.
 */

import type { SqlClient } from '@/lib/auth/sql';

/** How the request was authenticated. */
export type ApiLogAuthKind = 'session' | 'debug' | 'spend' | 'none';

/** Cap for `GET /debug/api-log`. */
export const API_LOG_LIST_LIMIT = 200;

/** Persisted HTTP audit row. */
export interface ApiLogRow {
  /** Opaque unique row id. */
  id: string;
  /** Instant the request finished. */
  createdAt: Date;
  /** HTTP method. */
  method: string;
  /** Redacted path (no query string). */
  path: string;
  /** Response status. */
  status: number;
  /** Handler duration in milliseconds. */
  ms: number;
  /** Session account id when `authKind` is `session`; else null. */
  accountId: string | null;
  /** Bearer class. */
  authKind: ApiLogAuthKind;
}

/** Operator JSON for one audit row. */
export interface DebugApiLog {
  /** Opaque unique row id. */
  id: string;
  /** ISO-8601 instant. */
  createdAt: string;
  /** HTTP method. */
  method: string;
  /** Redacted path. */
  path: string;
  /** Response status. */
  status: number;
  /** Handler duration in milliseconds. */
  ms: number;
  /** Session account id, or null. */
  accountId: string | null;
  /** Bearer class. */
  authKind: ApiLogAuthKind;
}

/**
 * Project a store row to operator JSON.
 *
 * @param row - Persisted audit row.
 * @returns Debug fields; `createdAt` as ISO-8601.
 */
export function serializeDebugApiLog(row: ApiLogRow): DebugApiLog {
  return {
    id: row.id,
    createdAt: row.createdAt.toISOString(),
    method: row.method,
    path: row.path,
    status: row.status,
    ms: row.ms,
    accountId: row.accountId,
    authKind: row.authKind,
  };
}

/**
 * Persistence port for HTTP audit rows.
 */
export interface ApiLogStore {
  /**
   * Append one finished request.
   *
   * @param row - Fully formed row (path already redacted).
   */
  append(row: ApiLogRow): Promise<void>;

  /**
   * Newest rows first (`createdAt` desc, then `id` desc), capped at `limit`.
   *
   * @param limit - Maximum rows.
   * @returns Row copies.
   */
  listLatest(limit: number): Promise<ApiLogRow[]>;
}

/** Idempotent DDL (matches `docs/schema/api_log.sql`). */
export const API_LOG_SCHEMA_SQL: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS api_log (
  id uuid PRIMARY KEY,
  created_at timestamptz NOT NULL,
  method text NOT NULL,
  path text NOT NULL,
  status integer NOT NULL,
  ms integer NOT NULL,
  account_id uuid REFERENCES account (id),
  auth_kind text NOT NULL CHECK (auth_kind IN ('session', 'debug', 'spend', 'none'))
)`,
  `CREATE INDEX IF NOT EXISTS api_log_created_at_idx ON api_log (created_at DESC, id DESC)`,
];

/**
 * Apply {@link API_LOG_SCHEMA_SQL} in order. Idempotent.
 *
 * @param sql - Parameter-bound SQL client.
 * @returns Resolves when every statement has executed.
 */
export async function migrateApiLogSchema(sql: SqlClient): Promise<void> {
  for (const statement of API_LOG_SCHEMA_SQL) {
    await sql.execute(statement);
  }
}

/**
 * Process-local {@link ApiLogStore}. Used in tests and when no database URL
 * is configured.
 */
export class InMemoryApiLogStore implements ApiLogStore {
  readonly #rows: ApiLogRow[];

  /**
   * @param seed - Optional seed rows; copied into private storage.
   */
  constructor(seed: readonly ApiLogRow[] = []) {
    this.#rows = seed.map((row) => copyRow(row));
  }

  /**
   * Append a copy of `row`.
   *
   * @param row - Audit row.
   */
  append(row: ApiLogRow): Promise<void> {
    this.#rows.push(copyRow(row));
    return Promise.resolve();
  }

  /**
   * Newest-first copy of stored rows, capped at `limit`.
   *
   * @param limit - Maximum rows.
   * @returns A new array of row copies.
   */
  listLatest(limit: number): Promise<ApiLogRow[]> {
    const sorted = [...this.#rows].sort((a, b) => {
      const byTime = b.createdAt.getTime() - a.createdAt.getTime();
      if (byTime !== 0) {
        return byTime;
      }
      return b.id.localeCompare(a.id);
    });
    return Promise.resolve(sorted.slice(0, limit).map((row) => copyRow(row)));
  }
}

/** Row shape selected from `api_log`. */
interface ApiLogSqlRow {
  id: string;
  created_at: Date | string;
  method: string;
  path: string;
  status: number | string;
  ms: number | string;
  account_id: string | null;
  auth_kind: string;
}

/**
 * Durable {@link ApiLogStore} backed by Postgres.
 */
export class PostgresApiLogStore implements ApiLogStore {
  readonly #sql: SqlClient;

  /**
   * @param sql - Parameter-bound SQL client (already migrated).
   */
  constructor(sql: SqlClient) {
    this.#sql = sql;
  }

  /**
   * Insert `row` into `api_log`.
   *
   * @param row - Fully formed audit row.
   */
  async append(row: ApiLogRow): Promise<void> {
    await this.#sql.execute(
      `INSERT INTO api_log (id, created_at, method, path, status, ms, account_id, auth_kind)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [
        row.id,
        row.createdAt,
        row.method,
        row.path,
        row.status,
        row.ms,
        row.accountId,
        row.authKind,
      ],
    );
  }

  /**
   * Newest-first list from `api_log`, capped at `limit`.
   *
   * @param limit - Maximum rows (`$1`).
   * @returns Mapped rows.
   */
  async listLatest(limit: number): Promise<ApiLogRow[]> {
    const rows = await this.#sql.query<ApiLogSqlRow>(
      `SELECT id, created_at, method, path, status, ms, account_id, auth_kind
       FROM api_log
       ORDER BY created_at DESC, id DESC
       LIMIT $1`,
      [limit],
    );
    return rows.map((row) => mapApiLogRow(row));
  }
}

function copyRow(row: ApiLogRow): ApiLogRow {
  return {
    ...row,
    createdAt: new Date(row.createdAt.getTime()),
  };
}

function parseAuthKind(raw: string): ApiLogAuthKind {
  if (raw === 'session' || raw === 'debug' || raw === 'spend' || raw === 'none') {
    return raw;
  }
  return 'none';
}

function mapApiLogRow(row: ApiLogSqlRow): ApiLogRow {
  return {
    id: row.id,
    createdAt: row.created_at instanceof Date ? row.created_at : new Date(row.created_at),
    method: row.method,
    path: row.path,
    status: Number(row.status),
    ms: Number(row.ms),
    accountId: row.account_id,
    authKind: parseAuthKind(row.auth_kind),
  };
}
