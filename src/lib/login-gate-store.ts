/**
 * Operator login switch and login allowlist (memory or Postgres).
 */

import type { SqlClient } from '@/lib/auth/sql';

/** `app_setting.key` of the operator login switch. */
const LOGINS_OPEN_KEY = 'logins_open';

/**
 * Idempotent DDL for the operator settings and the login allowlist (matches
 * `docs/schema/login_gate.sql`). Runs after `account` exists.
 */
export const LOGIN_GATE_SCHEMA_SQL: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS app_setting (
  key text PRIMARY KEY,
  value text NOT NULL,
  updated_at timestamptz NOT NULL
)`,
  `CREATE TABLE IF NOT EXISTS login_allowlist (
  account_id uuid PRIMARY KEY REFERENCES account (id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL
)`,
];

/** One allowlisted account. */
export interface LoginAllowlistEntry {
  /** Account that may start a session while logins are closed. */
  accountId: string;
  /** When the operator added it (epoch milliseconds). */
  createdAt: number;
}

/**
 * Stores the operator login switch and the accounts that may still start a
 * session while it is closed.
 */
export interface LoginGateStore {
  /**
   * Read the stored switch.
   *
   * @returns `true` (open) or `false` (closed), or `null` when the operator never set it.
   */
  loginsOpen(): Promise<boolean | null>;
  /**
   * Store the switch. The stored value wins over the boot default from then on.
   *
   * @param open - `true` opens logins, `false` closes them.
   * @param now - Epoch milliseconds.
   */
  setLoginsOpen(open: boolean, now: number): Promise<void>;
  /**
   * Every allowlisted account, oldest first (then `accountId` ascending).
   *
   * @returns Allowlist rows.
   */
  listAllowlist(): Promise<LoginAllowlistEntry[]>;
  /**
   * Whether an account is on the allowlist.
   *
   * @param accountId - Account id.
   * @returns `true` when listed.
   */
  isAllowlisted(accountId: string): Promise<boolean>;
  /**
   * Add an existing account. Adding a listed account keeps its first `createdAt`.
   *
   * @param accountId - Account id (the caller checks that the account exists).
   * @param now - Epoch milliseconds.
   * @returns `true` when a row was added, `false` when it was already listed.
   */
  addToAllowlist(accountId: string, now: number): Promise<boolean>;
  /**
   * Remove an account.
   *
   * @param accountId - Account id.
   * @returns `true` when a row was removed, `false` when it was not listed.
   */
  removeFromAllowlist(accountId: string): Promise<boolean>;
}

/**
 * Apply {@link LOGIN_GATE_SCHEMA_SQL} in order. Idempotent.
 *
 * @param sql - Parameter-bound SQL client.
 * @returns Resolves when every statement has executed.
 */
export async function migrateLoginGateSchema(sql: SqlClient): Promise<void> {
  for (const statement of LOGIN_GATE_SCHEMA_SQL) {
    await sql.execute(statement);
  }
}

/** Oldest first, then account id. */
function byCreatedThenId(a: LoginAllowlistEntry, b: LoginAllowlistEntry): number {
  return a.createdAt - b.createdAt || a.accountId.localeCompare(b.accountId);
}

/**
 * In-memory login gate store (memory boots and tests). Lost on restart, so a
 * memory boot always starts from the boot default.
 */
export class InMemoryLoginGateStore implements LoginGateStore {
  #open: boolean | null = null;
  readonly #allowlist = new Map<string, number>();

  /**
   * Read the stored switch.
   *
   * @returns The last stored value, or `null`.
   */
  loginsOpen(): Promise<boolean | null> {
    return Promise.resolve(this.#open);
  }

  /**
   * Store the switch.
   *
   * @param open - New value.
   * @returns Resolves once stored.
   */
  setLoginsOpen(open: boolean): Promise<void> {
    this.#open = open;
    return Promise.resolve();
  }

  /**
   * Every allowlisted account.
   *
   * @returns Copies, oldest first.
   */
  listAllowlist(): Promise<LoginAllowlistEntry[]> {
    const rows = [...this.#allowlist].map(([accountId, createdAt]) => ({ accountId, createdAt }));
    return Promise.resolve(rows.sort(byCreatedThenId));
  }

  /**
   * Whether an account is listed.
   *
   * @param accountId - Account id.
   * @returns `true` when listed.
   */
  isAllowlisted(accountId: string): Promise<boolean> {
    return Promise.resolve(this.#allowlist.has(accountId));
  }

  /**
   * Add an account unless it is listed.
   *
   * @param accountId - Account id.
   * @param now - Epoch milliseconds.
   * @returns `true` when added.
   */
  addToAllowlist(accountId: string, now: number): Promise<boolean> {
    if (this.#allowlist.has(accountId)) {
      return Promise.resolve(false);
    }
    this.#allowlist.set(accountId, now);
    return Promise.resolve(true);
  }

  /**
   * Remove an account.
   *
   * @param accountId - Account id.
   * @returns `true` when removed.
   */
  removeFromAllowlist(accountId: string): Promise<boolean> {
    return Promise.resolve(this.#allowlist.delete(accountId));
  }
}

/** Row shape selected from `login_allowlist`. */
interface AllowlistRow {
  account_id: string;
  created_at: Date | string;
}

/**
 * Postgres login gate store: the switch is one `app_setting` row
 * (`key = 'logins_open'`, value `open` or `closed`); the allowlist is
 * `login_allowlist`, removed with its account.
 */
export class PostgresLoginGateStore implements LoginGateStore {
  readonly #sql: SqlClient;

  /**
   * @param sql - Parameter-bound SQL client.
   */
  constructor(sql: SqlClient) {
    this.#sql = sql;
  }

  /**
   * Read the `logins_open` row.
   *
   * @returns `true` for `open`, `false` for any other stored value, `null` without a row.
   */
  async loginsOpen(): Promise<boolean | null> {
    const rows = await this.#sql.query<{ value: string }>(
      'SELECT value FROM app_setting WHERE key = $1',
      [LOGINS_OPEN_KEY],
    );
    const row = rows[0];
    if (row === undefined) {
      return null;
    }
    return row.value === 'open';
  }

  /**
   * Upsert the `logins_open` row.
   *
   * @param open - New value.
   * @param now - Epoch milliseconds.
   * @returns Resolves once written.
   */
  async setLoginsOpen(open: boolean, now: number): Promise<void> {
    await this.#sql.execute(
      `INSERT INTO app_setting (key, value, updated_at)
       VALUES ($1, $2, to_timestamp($3::double precision / 1000.0))
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at`,
      [LOGINS_OPEN_KEY, open ? 'open' : 'closed', now],
    );
  }

  /**
   * Every allowlist row.
   *
   * @returns Rows, oldest first.
   */
  async listAllowlist(): Promise<LoginAllowlistEntry[]> {
    const rows = await this.#sql.query<AllowlistRow>(
      'SELECT account_id, created_at FROM login_allowlist ORDER BY created_at ASC, account_id ASC',
    );
    return rows.map((row) => ({
      accountId: String(row.account_id),
      createdAt: (row.created_at instanceof Date
        ? row.created_at
        : new Date(row.created_at)
      ).getTime(),
    }));
  }

  /**
   * Whether an account is listed.
   *
   * @param accountId - Account id (uuid).
   * @returns `true` when a row exists.
   */
  async isAllowlisted(accountId: string): Promise<boolean> {
    const rows = await this.#sql.query<{ account_id: string }>(
      'SELECT account_id FROM login_allowlist WHERE account_id = $1::uuid',
      [accountId],
    );
    return rows.length > 0;
  }

  /**
   * Insert a row unless the account is listed.
   *
   * @param accountId - Account id (uuid).
   * @param now - Epoch milliseconds.
   * @returns `true` when a row was inserted.
   */
  async addToAllowlist(accountId: string, now: number): Promise<boolean> {
    const rows = await this.#sql.query<{ account_id: string }>(
      `INSERT INTO login_allowlist (account_id, created_at)
       VALUES ($1::uuid, to_timestamp($2::double precision / 1000.0))
       ON CONFLICT (account_id) DO NOTHING
       RETURNING account_id`,
      [accountId, now],
    );
    return rows.length > 0;
  }

  /**
   * Delete the row of an account.
   *
   * @param accountId - Account id (uuid).
   * @returns `true` when a row was deleted.
   */
  async removeFromAllowlist(accountId: string): Promise<boolean> {
    const rows = await this.#sql.query<{ account_id: string }>(
      'DELETE FROM login_allowlist WHERE account_id = $1::uuid RETURNING account_id',
      [accountId],
    );
    return rows.length > 0;
  }
}
