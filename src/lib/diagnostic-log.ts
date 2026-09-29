import type { SqlClient } from '@/lib/auth/sql';

/** Where a diagnostic row was recorded. */
export type DiagnosticSource = 'server' | 'client';

/** Persisted diagnostic row. `fields` holds allowlisted scalars only. */
export interface DiagnosticEvent {
  /** Opaque unique row id. */
  id: string;
  /** Instant the row was recorded. */
  createdAt: Date;
  /** `server` for `logEvent`, `client` for `POST /diagnostics`. */
  source: DiagnosticSource;
  /** Dotted event name. */
  event: string;
  /** Allowlisted scalar fields. No nested objects. */
  fields: Record<string, string | number | boolean>;
}

/**
 * Persistence port for diagnostic rows.
 */
export interface DiagnosticStore {
  /**
   * Append one diagnostic row.
   *
   * @param row - Fully formed row.
   */
  append(row: DiagnosticEvent): Promise<void>;

  /**
   * Newest rows first (`createdAt` desc, then `id` desc), capped at `limit`.
   *
   * @param limit - Maximum rows.
   * @returns Row copies.
   */
  listLatest(limit: number): Promise<DiagnosticEvent[]>;
}

/** Cap for `GET /debug/diagnostics`. */
export const DIAGNOSTIC_LIST_LIMIT = 200;

/** Idempotent DDL (matches `docs/schema/diagnostic_event.sql`). */
export const DIAGNOSTIC_SCHEMA_SQL: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS diagnostic_event (
  id uuid PRIMARY KEY,
  created_at timestamptz NOT NULL,
  source text NOT NULL CHECK (source IN ('server', 'client')),
  event text NOT NULL,
  fields jsonb NOT NULL
)`,
  `CREATE INDEX IF NOT EXISTS diagnostic_event_created_at_idx
  ON diagnostic_event (created_at DESC, id DESC)`,
];

type DiagnosticFieldValue = string | number | boolean;

function copyFields(
  fields: Record<string, DiagnosticFieldValue>,
): Record<string, DiagnosticFieldValue> {
  return { ...fields };
}

function copyRow(row: DiagnosticEvent): DiagnosticEvent {
  return {
    id: row.id,
    createdAt: new Date(row.createdAt.getTime()),
    source: row.source,
    event: row.event,
    fields: copyFields(row.fields),
  };
}

function parseFields(value: unknown): Record<string, DiagnosticFieldValue> {
  let parsed: unknown = value;
  if (typeof value === 'string') {
    try {
      parsed = JSON.parse(value) as unknown;
    } catch {
      return {};
    }
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return {};
  }
  const out: Record<string, DiagnosticFieldValue> = {};
  for (const [key, entry] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof entry === 'string' || typeof entry === 'number' || typeof entry === 'boolean') {
      out[key] = entry;
    }
  }
  return out;
}

function mapDiagnosticRow(row: {
  id: unknown;
  created_at: unknown;
  source: unknown;
  event: unknown;
  fields: unknown;
}): DiagnosticEvent | undefined {
  if (row.source !== 'server' && row.source !== 'client') {
    return undefined;
  }
  const createdAt =
    row.created_at instanceof Date ? row.created_at : new Date(String(row.created_at));
  return {
    id: String(row.id),
    createdAt,
    source: row.source,
    event: String(row.event),
    fields: parseFields(row.fields),
  };
}

/**
 * Apply {@link DIAGNOSTIC_SCHEMA_SQL} in order. Idempotent.
 *
 * @param sql - Parameter-bound SQL client.
 * @returns Resolves when every statement has executed.
 */
export async function migrateDiagnosticSchema(sql: SqlClient): Promise<void> {
  for (const statement of DIAGNOSTIC_SCHEMA_SQL) {
    await sql.execute(statement);
  }
}

/** Newest-first in-process store. Callers receive copies and cannot mutate storage. */
export class InMemoryDiagnosticStore implements DiagnosticStore {
  private readonly rows: DiagnosticEvent[] = [];

  /**
   * Append a copy of `row`.
   *
   * @param row - Diagnostic row.
   */
  async append(row: DiagnosticEvent): Promise<void> {
    this.rows.push(copyRow(row));
  }

  /**
   * Newest-first copy of stored rows, capped at `limit`.
   *
   * @param limit - Maximum rows.
   * @returns A new array of row copies.
   */
  async listLatest(limit: number): Promise<DiagnosticEvent[]> {
    return this.rows
      .slice()
      .sort((a, b) => {
        const byTime = b.createdAt.getTime() - a.createdAt.getTime();
        if (byTime !== 0) {
          return byTime;
        }
        return b.id.localeCompare(a.id);
      })
      .slice(0, limit)
      .map(copyRow);
  }
}

/** Postgres-backed diagnostic_event store. Query and execute failures propagate. */
export class PostgresDiagnosticStore implements DiagnosticStore {
  /**
   * @param sql - Parameter-bound SQL client (already migrated).
   */
  constructor(private readonly sql: SqlClient) {}

  /**
   * Insert `row` into `diagnostic_event`.
   *
   * @param row - Fully formed diagnostic row.
   */
  async append(row: DiagnosticEvent): Promise<void> {
    await this.sql.execute(
      'INSERT INTO diagnostic_event (id, created_at, source, event, fields) VALUES ($1,$2,$3,$4,$5::jsonb)',
      [row.id, row.createdAt, row.source, row.event, JSON.stringify(row.fields)],
    );
  }

  /**
   * Newest-first list from `diagnostic_event`, capped at `limit`.
   *
   * @param limit - Maximum rows (`$1`).
   * @returns Mapped rows.
   */
  async listLatest(limit: number): Promise<DiagnosticEvent[]> {
    const rows = await this.sql.query<{
      id: unknown;
      created_at: unknown;
      source: unknown;
      event: unknown;
      fields: unknown;
    }>(
      'SELECT id, created_at, source, event, fields FROM diagnostic_event ORDER BY created_at DESC, id DESC LIMIT $1',
      [limit],
    );
    const mapped: DiagnosticEvent[] = [];
    for (const row of rows) {
      const event = mapDiagnosticRow(row);
      if (event !== undefined) {
        mapped.push(event);
      }
    }
    return mapped;
  }
}

/**
 * Project a store row to operator JSON.
 *
 * @param row - Persisted diagnostic row.
 * @returns Debug fields; `createdAt` as ISO-8601.
 */
export function serializeDebugDiagnostic(row: DiagnosticEvent): {
  id: string;
  createdAt: string;
  source: DiagnosticSource;
  event: string;
  fields: Record<string, string | number | boolean>;
} {
  return {
    id: row.id,
    createdAt: row.createdAt.toISOString(),
    source: row.source,
    event: row.event,
    fields: copyFields(row.fields),
  };
}
