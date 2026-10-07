import type { SqlClient } from '@/lib/auth/sql';
import type { MemberEventPropValue } from '@/lib/member-event';

/** Persisted member interaction-log row. */
export interface MemberEvent {
  /** Opaque unique row id. */
  id: string;
  /** Owning account id. */
  accountId: string;
  /** Allow-listed event name. */
  name: string;
  /** Client instant. */
  at: Date;
  /** Path with query/fragment stripped, or `null`. */
  path: string | null;
  /** Allow-listed scalar props. */
  props: Record<string, MemberEventPropValue>;
  /** Server receive instant. */
  receivedAt: Date;
}

/**
 * Persistence port for member interaction events.
 */
export interface MemberEventStore {
  /**
   * Insert all rows atomically (one statement). An empty array is a no-op.
   *
   * @param rows - Fully formed rows.
   */
  appendMany(rows: readonly MemberEvent[]): Promise<void>;

  /**
   * Newest first (`at` desc, then `id` desc), capped at `limit`, for one account.
   *
   * @param accountId - Owning account.
   * @param limit - Maximum rows.
   * @returns Row copies.
   */
  listForAccount(accountId: string, limit: number): Promise<MemberEvent[]>;
}

/** Idempotent DDL (matches `docs/schema/member_event.sql`). */
export const MEMBER_EVENT_SCHEMA_SQL: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS member_event (
  id uuid PRIMARY KEY,
  account_id uuid NOT NULL REFERENCES account (id),
  name text NOT NULL,
  at timestamptz NOT NULL,
  path text,
  props jsonb NOT NULL DEFAULT '{}',
  received_at timestamptz NOT NULL
)`,
  `CREATE INDEX IF NOT EXISTS member_event_account_at_idx ON member_event (account_id, at DESC, id DESC)`,
];

/**
 * Apply {@link MEMBER_EVENT_SCHEMA_SQL} in order. Idempotent.
 *
 * @param sql - Parameter-bound SQL client.
 * @returns Resolves when every statement has executed.
 * @throws Propagates SQL failures.
 */
export async function migrateMemberEventSchema(sql: SqlClient): Promise<void> {
  for (const statement of MEMBER_EVENT_SCHEMA_SQL) {
    await sql.execute(statement);
  }
}

function copyProps(
  props: Record<string, MemberEventPropValue>,
): Record<string, MemberEventPropValue> {
  return { ...props };
}

function copyRow(row: MemberEvent): MemberEvent {
  return {
    id: row.id,
    accountId: row.accountId,
    name: row.name,
    at: new Date(row.at.getTime()),
    path: row.path,
    props: copyProps(row.props),
    receivedAt: new Date(row.receivedAt.getTime()),
  };
}

function parseProps(value: unknown): Record<string, MemberEventPropValue> {
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
  const out: Record<string, MemberEventPropValue> = {};
  for (const [key, entry] of Object.entries(parsed as Record<string, unknown>)) {
    if (entry === null || typeof entry === 'boolean' || typeof entry === 'string') {
      out[key] = entry;
    } else if (typeof entry === 'number' && Number.isFinite(entry)) {
      out[key] = entry;
    }
  }
  return out;
}

function mapMemberEventRow(row: {
  id: unknown;
  account_id: unknown;
  name: unknown;
  at: unknown;
  path: unknown;
  props: unknown;
  received_at: unknown;
}): MemberEvent {
  const at = row.at instanceof Date ? row.at : new Date(String(row.at));
  const receivedAt =
    row.received_at instanceof Date ? row.received_at : new Date(String(row.received_at));
  return {
    id: String(row.id),
    accountId: String(row.account_id),
    name: String(row.name),
    at,
    path: row.path === null || row.path === undefined ? null : String(row.path),
    props: parseProps(row.props),
    receivedAt,
  };
}

/** Newest-first in-process store. Callers receive copies and cannot mutate storage. */
export class InMemoryMemberEventStore implements MemberEventStore {
  private readonly rows: MemberEvent[] = [];

  /**
   * Insert copies of `rows`. Empty input is a no-op.
   *
   * @param rows - Rows to store.
   */
  async appendMany(rows: readonly MemberEvent[]): Promise<void> {
    for (const row of rows) {
      this.rows.push(copyRow(row));
    }
  }

  /**
   * Newest-first copy of stored rows for `accountId`, capped at `limit`.
   *
   * @param accountId - Owning account.
   * @param limit - Maximum rows.
   * @returns A new array of row copies.
   */
  async listForAccount(accountId: string, limit: number): Promise<MemberEvent[]> {
    return this.rows
      .filter((row) => row.accountId === accountId)
      .sort((a, b) => {
        const byTime = b.at.getTime() - a.at.getTime();
        if (byTime !== 0) {
          return byTime;
        }
        return b.id.localeCompare(a.id);
      })
      .slice(0, limit)
      .map(copyRow);
  }
}

/** Postgres-backed `member_event` store. Query and execute failures propagate. */
export class PostgresMemberEventStore implements MemberEventStore {
  /**
   * @param sql - Parameter-bound SQL client (already migrated).
   */
  constructor(private readonly sql: SqlClient) {}

  /**
   * Insert `rows` in one multi-row statement. Empty input is a no-op.
   *
   * @param rows - Fully formed rows.
   */
  async appendMany(rows: readonly MemberEvent[]): Promise<void> {
    if (rows.length === 0) {
      return;
    }
    const values: string[] = [];
    const params: unknown[] = [];
    let index = 0;
    for (const row of rows) {
      const base = index * 7;
      index += 1;
      values.push(
        `($${base + 1},$${base + 2},$${base + 3},$${base + 4},$${base + 5},$${base + 6}::jsonb,$${base + 7})`,
      );
      params.push(
        row.id,
        row.accountId,
        row.name,
        row.at,
        row.path,
        JSON.stringify(row.props),
        row.receivedAt,
      );
    }
    await this.sql.execute(
      `INSERT INTO member_event (id, account_id, name, at, path, props, received_at) VALUES ${values.join(', ')}`,
      params,
    );
  }

  /**
   * Newest-first list from `member_event` for one account, capped at `limit`.
   *
   * @param accountId - Owning account (`$1`).
   * @param limit - Maximum rows (`$2`).
   * @returns Mapped rows.
   */
  async listForAccount(accountId: string, limit: number): Promise<MemberEvent[]> {
    const rows = await this.sql.query<{
      id: unknown;
      account_id: unknown;
      name: unknown;
      at: unknown;
      path: unknown;
      props: unknown;
      received_at: unknown;
    }>(
      'SELECT id, account_id, name, at, path, props, received_at FROM member_event WHERE account_id = $1 ORDER BY at DESC, id DESC LIMIT $2',
      [accountId, limit],
    );
    return rows.map((row) => mapMemberEventRow(row));
  }
}
