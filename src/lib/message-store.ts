/**
 * Persistence for the public member forum.
 *
 * v1 default is in-memory. Production boot injects Postgres when
 * `DATABASE_URL` is set.
 */

import type { SqlClient } from '@/lib/auth/sql';
import type { MessageRow } from '@/lib/message';

/**
 * Persistence port for forum messages.
 */
export interface MessageStore {
  /**
   * Newest messages first (`createdAt` desc, then `id` desc), capped at
   * `limit`.
   *
   * @param limit - Maximum rows to return.
   * @returns Message rows (caller-owned copies).
   */
  listLatest(limit: number): Promise<MessageRow[]>;

  /**
   * Persist a new message row.
   *
   * @param row - Fully formed row (id, account, name snapshot, text, time).
   * @returns The stored row (a copy is fine).
   */
  create(row: MessageRow): Promise<MessageRow>;
}

/** Idempotent DDL for the forum table (matches `docs/schema/message.sql`). */
export const MESSAGE_SCHEMA_SQL: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS message (
  id uuid PRIMARY KEY,
  account_id uuid NOT NULL REFERENCES account (id),
  name text NOT NULL,
  text text NOT NULL,
  created_at timestamptz NOT NULL
)`,
  `CREATE INDEX IF NOT EXISTS message_created_at_idx ON message (created_at DESC, id DESC)`,
];

/**
 * Apply {@link MESSAGE_SCHEMA_SQL} in order. Idempotent.
 *
 * @param sql - Parameter-bound SQL client.
 * @returns Resolves when every statement has executed.
 */
export async function migrateMessageSchema(sql: SqlClient): Promise<void> {
  for (const statement of MESSAGE_SCHEMA_SQL) {
    await sql.execute(statement);
  }
}

/**
 * Process-local {@link MessageStore}. Used in tests and when no database URL
 * is configured — the process still boots.
 */
export class InMemoryMessageStore implements MessageStore {
  readonly #rows: MessageRow[];

  /**
   * @param seed - Optional seed rows; copied into private storage.
   */
  constructor(seed: readonly MessageRow[] = []) {
    this.#rows = seed.map((row) => ({ ...row, createdAt: new Date(row.createdAt.getTime()) }));
  }

  /**
   * Newest-first copy of stored rows, capped at `limit`.
   *
   * @param limit - Maximum rows.
   * @returns A new array of row copies; mutating it does not change the store.
   */
  listLatest(limit: number): Promise<MessageRow[]> {
    const sorted = [...this.#rows].sort((a, b) => {
      const byTime = b.createdAt.getTime() - a.createdAt.getTime();
      if (byTime !== 0) {
        return byTime;
      }
      return b.id.localeCompare(a.id);
    });
    return Promise.resolve(
      sorted
        .slice(0, limit)
        .map((row) => ({ ...row, createdAt: new Date(row.createdAt.getTime()) })),
    );
  }

  /**
   * Append a copy of `row` and return a copy.
   *
   * @param row - Message to store.
   * @returns A copy of the stored row.
   */
  create(row: MessageRow): Promise<MessageRow> {
    const stored: MessageRow = {
      ...row,
      createdAt: new Date(row.createdAt.getTime()),
    };
    this.#rows.push(stored);
    return Promise.resolve({
      ...stored,
      createdAt: new Date(stored.createdAt.getTime()),
    });
  }
}

/** Row shape selected from `message`. */
interface MessageSqlRow {
  id: string;
  account_id: string;
  name: string;
  text: string;
  created_at: Date | string;
}

/** Map a SQL row onto {@link MessageRow}. Unexported. */
function mapMessageRow(row: MessageSqlRow): MessageRow {
  return {
    id: row.id,
    accountId: row.account_id,
    name: row.name,
    text: row.text,
    createdAt: row.created_at instanceof Date ? row.created_at : new Date(row.created_at),
  };
}

/**
 * Durable {@link MessageStore} backed by Postgres.
 */
export class PostgresMessageStore implements MessageStore {
  readonly #sql: SqlClient;

  /**
   * @param sql - Parameter-bound SQL client (already migrated).
   */
  constructor(sql: SqlClient) {
    this.#sql = sql;
  }

  /**
   * Newest-first list from `message`, capped at `limit`.
   *
   * @param limit - Maximum rows (`$1`).
   * @returns Mapped rows.
   */
  async listLatest(limit: number): Promise<MessageRow[]> {
    const rows = await this.#sql.query<MessageSqlRow>(
      `SELECT id, account_id, name, text, created_at FROM message ORDER BY created_at DESC, id DESC LIMIT $1`,
      [limit],
    );
    return rows.map((row) => mapMessageRow(row));
  }

  /**
   * Insert `row` into `message` and return it.
   *
   * @param row - Fully formed message.
   * @returns The input row after a successful insert (a copy).
   */
  async create(row: MessageRow): Promise<MessageRow> {
    await this.#sql.execute(
      `INSERT INTO message (id, account_id, name, text, created_at) VALUES ($1,$2,$3,$4,$5)`,
      [row.id, row.accountId, row.name, row.text, row.createdAt],
    );
    return {
      ...row,
      createdAt: new Date(row.createdAt.getTime()),
    };
  }
}
