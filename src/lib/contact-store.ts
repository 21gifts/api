/**
 * Persistence for the private in-app contact mailbox.
 *
 * v1 default is in-memory. Production boot injects Postgres when
 * `DATABASE_URL` is set. Column layout matches `message`; table name is
 * `contact`.
 */

import type { SqlClient } from '@/lib/auth/sql';
import type { ContactRow } from '@/lib/contact';

/**
 * Persistence port for private contact messages.
 */
export interface ContactStore {
  /**
   * Newest contacts first (`createdAt` desc, then `id` desc), capped at
   * `limit`.
   *
   * @param limit - Maximum rows to return.
   * @returns Contact rows (caller-owned copies).
   */
  listLatest(limit: number): Promise<ContactRow[]>;

  /**
   * Persist a new contact row.
   *
   * @param row - Fully formed row (id, account, name snapshot, text, time).
   * @returns The stored row (a copy is fine).
   */
  create(row: ContactRow): Promise<ContactRow>;
}

/** Idempotent DDL for the contact table (matches `docs/schema/contact.sql`). */
export const CONTACT_SCHEMA_SQL: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS contact (
  id uuid PRIMARY KEY,
  account_id uuid NOT NULL REFERENCES account (id),
  name text NOT NULL,
  text text NOT NULL,
  created_at timestamptz NOT NULL
)`,
  `CREATE INDEX IF NOT EXISTS contact_created_at_idx ON contact (created_at DESC, id DESC)`,
];

/**
 * Apply {@link CONTACT_SCHEMA_SQL} in order. Idempotent.
 *
 * @param sql - Parameter-bound SQL client.
 * @returns Resolves when every statement has executed.
 */
export async function migrateContactSchema(sql: SqlClient): Promise<void> {
  for (const statement of CONTACT_SCHEMA_SQL) {
    await sql.execute(statement);
  }
}

/**
 * Process-local {@link ContactStore}. Used in tests and when no database URL
 * is configured — the process still boots.
 */
export class InMemoryContactStore implements ContactStore {
  readonly #rows: ContactRow[];

  /**
   * @param seed - Optional seed rows; copied into private storage.
   */
  constructor(seed: readonly ContactRow[] = []) {
    this.#rows = seed.map((row) => ({ ...row, createdAt: new Date(row.createdAt.getTime()) }));
  }

  /**
   * Newest-first copy of stored rows, capped at `limit`.
   *
   * @param limit - Maximum rows.
   * @returns A new array of row copies; mutating it does not change the store.
   */
  listLatest(limit: number): Promise<ContactRow[]> {
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
   * @param row - Contact to store.
   * @returns A copy of the stored row.
   */
  create(row: ContactRow): Promise<ContactRow> {
    const stored: ContactRow = {
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

/** Row shape selected from `contact`. */
interface ContactSqlRow {
  id: string;
  account_id: string;
  name: string;
  text: string;
  created_at: Date | string;
}

/** Map a SQL row onto {@link ContactRow}. Unexported. */
function mapContactRow(row: ContactSqlRow): ContactRow {
  return {
    id: row.id,
    accountId: row.account_id,
    name: row.name,
    text: row.text,
    createdAt: row.created_at instanceof Date ? row.created_at : new Date(row.created_at),
  };
}

/**
 * Durable {@link ContactStore} backed by Postgres.
 */
export class PostgresContactStore implements ContactStore {
  readonly #sql: SqlClient;

  /**
   * @param sql - Parameter-bound SQL client (already migrated).
   */
  constructor(sql: SqlClient) {
    this.#sql = sql;
  }

  /**
   * Newest-first list from `contact`, capped at `limit`.
   *
   * @param limit - Maximum rows (`$1`).
   * @returns Mapped rows.
   */
  async listLatest(limit: number): Promise<ContactRow[]> {
    const rows = await this.#sql.query<ContactSqlRow>(
      `SELECT id, account_id, name, text, created_at FROM contact ORDER BY created_at DESC, id DESC LIMIT $1`,
      [limit],
    );
    return rows.map((row) => mapContactRow(row));
  }

  /**
   * Insert `row` into `contact` and return it.
   *
   * @param row - Fully formed contact.
   * @returns The input row after a successful insert (a copy).
   */
  async create(row: ContactRow): Promise<ContactRow> {
    await this.#sql.execute(
      `INSERT INTO contact (id, account_id, name, text, created_at) VALUES ($1,$2,$3,$4,$5)`,
      [row.id, row.accountId, row.name, row.text, row.createdAt],
    );
    return {
      ...row,
      createdAt: new Date(row.createdAt.getTime()),
    };
  }
}
