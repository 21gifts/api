/**
 * Persistence for member point-of-sale charges.
 *
 * v1 default is in-memory. Production boot injects Postgres when
 * `DATABASE_URL` is set. Table name is `pos_charge`.
 */

import type { SqlClient } from '@/lib/auth/sql';
import { logEvent } from '@/lib/log';
import type { PosCharge, PosChargeStatus } from '@/lib/pos-charge';

/**
 * Persistence port for point-of-sale charges.
 */
export interface PosStore {
  /**
   * Expire due pending rows for `accountId`, then return the newest
   * remaining unexpired pending charge, or `null`.
   *
   * @param accountId - Owner account id.
   * @param nowMs - Clock (epoch ms); `expiresAt <= nowMs` becomes expired.
   */
  currentPending(accountId: string, nowMs: number): Promise<PosCharge | null>;

  /**
   * Persist a new charge row. Caller sets id, status, and dates.
   * A second unexpired `pending` row for the same account is rejected.
   *
   * @param row - Fully formed row.
   * @returns The stored row (a copy).
   * @throws Error `A payment is already open` when an unexpired pending row exists.
   */
  create(row: PosCharge): Promise<PosCharge>;

  /**
   * Expire due pending rows, then cancel every remaining pending charge.
   * Already-expired rows are never cancelled.
   *
   * @param accountId - Owner account id.
   * @param nowMs - Clock (epoch ms).
   * @returns The cancelled row, or `null` when nothing was open.
   */
  cancelPending(accountId: string, nowMs: number): Promise<PosCharge | null>;

  /**
   * All statuses for one account, newest first, capped at `limit`.
   *
   * @param accountId - Owner account id.
   * @param limit - Maximum rows.
   */
  listForAccount(accountId: string, limit: number): Promise<PosCharge[]>;

  /**
   * All accounts, newest first, capped at `limit`. Used by the debug dump.
   *
   * @param limit - Maximum rows.
   */
  listLatest(limit: number): Promise<PosCharge[]>;
}

/** Idempotent DDL for the pos_charge table (matches `docs/schema/pos_charge.sql`). */
export const POS_SCHEMA_SQL: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS pos_charge (
  id uuid PRIMARY KEY,
  account_id uuid NOT NULL REFERENCES account (id),
  amount_sats bigint NOT NULL CHECK (amount_sats > 0),
  status text NOT NULL CHECK (status IN ('pending', 'cancelled', 'expired')),
  created_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL
)`,
  `CREATE INDEX IF NOT EXISTS pos_charge_account_created_idx
  ON pos_charge (account_id, created_at DESC, id DESC)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS pos_charge_account_pending_idx
  ON pos_charge (account_id) WHERE status = 'pending'`,
];

/**
 * Apply {@link POS_SCHEMA_SQL} in order. Idempotent.
 *
 * @param sql - Parameter-bound SQL client.
 * @returns Resolves when every statement has executed.
 */
export async function migratePosSchema(sql: SqlClient): Promise<void> {
  for (const statement of POS_SCHEMA_SQL) {
    await sql.execute(statement);
  }
}

/** Caller-owned copy; mutating dates or the object does not change the store. */
function copyCharge(row: PosCharge): PosCharge {
  return {
    ...row,
    createdAt: new Date(row.createdAt.getTime()),
    expiresAt: new Date(row.expiresAt.getTime()),
  };
}

/** Newest `createdAt` first, then `id` descending. */
function newestFirst(rows: readonly PosCharge[]): PosCharge[] {
  return [...rows].sort((a, b) => {
    const byTime = b.createdAt.getTime() - a.createdAt.getTime();
    if (byTime !== 0) {
      return byTime;
    }
    return b.id.localeCompare(a.id);
  });
}

/**
 * Process-local {@link PosStore}. Used in tests and when no database URL
 * is configured — the process still boots. Always starts empty.
 */
export class InMemoryPosStore implements PosStore {
  readonly #rows: PosCharge[] = [];

  /**
   * Mark due pending rows expired (log `pos.expired` once when any flip).
   *
   * @param accountId - Owner account id.
   * @param nowMs - Clock (epoch ms).
   */
  #expireDue(accountId: string, nowMs: number): void {
    let expired = false;
    for (const row of this.#rows) {
      if (
        row.accountId === accountId &&
        row.status === 'pending' &&
        row.expiresAt.getTime() <= nowMs
      ) {
        row.status = 'expired';
        expired = true;
      }
    }
    if (expired) {
      logEvent('pos.expired', { accountId });
    }
  }

  /**
   * Newest remaining unexpired pending row for `accountId`, or `null`.
   *
   * @param accountId - Owner account id.
   * @param nowMs - Clock (epoch ms).
   */
  #remainingPending(accountId: string, nowMs: number): PosCharge | null {
    const remaining = newestFirst(
      this.#rows.filter(
        (row) =>
          row.accountId === accountId &&
          row.status === 'pending' &&
          row.expiresAt.getTime() > nowMs,
      ),
    );
    const newest = remaining[0];
    return newest === undefined ? null : copyCharge(newest);
  }

  /**
   * Expire due pending rows, then return the newest remaining pending charge.
   *
   * @param accountId - Owner account id.
   * @param nowMs - Clock (epoch ms).
   * @returns A copy of the open charge, or `null`.
   */
  currentPending(accountId: string, nowMs: number): Promise<PosCharge | null> {
    this.#expireDue(accountId, nowMs);
    return Promise.resolve(this.#remainingPending(accountId, nowMs));
  }

  /**
   * Append a copy of `row` and return a copy. Logs `pos.create`.
   * Refuses a second unexpired pending row for the same account.
   *
   * @param row - Charge to store.
   * @returns A copy of the stored row.
   * @throws Error `A payment is already open` when one is already open.
   */
  create(row: PosCharge): Promise<PosCharge> {
    if (row.status === 'pending') {
      this.#expireDue(row.accountId, row.createdAt.getTime());
      if (this.#remainingPending(row.accountId, row.createdAt.getTime()) !== null) {
        return Promise.reject(new Error('A payment is already open'));
      }
    }
    const stored = copyCharge(row);
    this.#rows.push(stored);
    logEvent('pos.create', { accountId: stored.accountId });
    return Promise.resolve(copyCharge(stored));
  }

  /**
   * Expire due rows, then cancel every remaining pending charge.
   *
   * @param accountId - Owner account id.
   * @param nowMs - Clock (epoch ms).
   * @returns A copy of the newest cancelled row, or `null`.
   */
  cancelPending(accountId: string, nowMs: number): Promise<PosCharge | null> {
    this.#expireDue(accountId, nowMs);
    const remaining = newestFirst(
      this.#rows.filter(
        (row) =>
          row.accountId === accountId &&
          row.status === 'pending' &&
          row.expiresAt.getTime() > nowMs,
      ),
    );
    const newest = remaining[0];
    if (newest === undefined) {
      return Promise.resolve(null);
    }
    for (const row of remaining) {
      row.status = 'cancelled';
    }
    logEvent('pos.cancel', { accountId });
    return Promise.resolve(copyCharge(newest));
  }

  /**
   * Newest-first copy of this account's rows, capped at `limit`.
   *
   * @param accountId - Owner account id.
   * @param limit - Maximum rows.
   * @returns A new array of row copies.
   */
  listForAccount(accountId: string, limit: number): Promise<PosCharge[]> {
    const sorted = newestFirst(this.#rows.filter((row) => row.accountId === accountId));
    return Promise.resolve(sorted.slice(0, limit).map((row) => copyCharge(row)));
  }

  /**
   * Newest-first copy of every row, capped at `limit`.
   *
   * @param limit - Maximum rows.
   * @returns A new array of row copies.
   */
  listLatest(limit: number): Promise<PosCharge[]> {
    const sorted = newestFirst(this.#rows);
    return Promise.resolve(sorted.slice(0, limit).map((row) => copyCharge(row)));
  }
}

/** Row shape selected from `pos_charge`. */
interface PosSqlRow {
  id: string;
  account_id: string;
  amount_sats: number | string | bigint;
  status: string;
  created_at: Date | string;
  expires_at: Date | string;
}

/** Coerce Postgres timestamps; copy so callers cannot mutate driver dates. */
function asDate(value: Date | string): Date {
  return value instanceof Date ? new Date(value.getTime()) : new Date(value);
}

/** Coerce `amount_sats`; `Number()` only when the value is not already a number. */
function asAmountSats(value: number | string | bigint): number {
  return typeof value === 'number' ? value : Number(value);
}

/** Map a SQL row onto {@link PosCharge}. Unexported. */
function mapPosRow(row: PosSqlRow): PosCharge {
  return {
    id: row.id,
    accountId: row.account_id,
    amountSats: asAmountSats(row.amount_sats),
    status: row.status as PosChargeStatus,
    createdAt: asDate(row.created_at),
    expiresAt: asDate(row.expires_at),
  };
}

/**
 * Durable {@link PosStore} backed by Postgres.
 */
export class PostgresPosStore implements PosStore {
  readonly #sql: SqlClient;

  /**
   * @param sql - Parameter-bound SQL client (already migrated).
   */
  constructor(sql: SqlClient) {
    this.#sql = sql;
  }

  /**
   * Flip due pending rows to `expired`. Logs `pos.expired` once when any
   * id is returned.
   *
   * @param accountId - Owner account id.
   * @param nowMs - Clock (epoch ms).
   */
  async #expireDue(accountId: string, nowMs: number): Promise<void> {
    const expired = await this.#sql.query<{ id: string }>(
      `UPDATE pos_charge
SET status = 'expired'
WHERE account_id = $1 AND status = 'pending' AND expires_at <= $2
RETURNING id`,
      [accountId, new Date(nowMs).toISOString()],
    );
    if (expired.length > 0) {
      logEvent('pos.expired', { accountId });
    }
  }

  /**
   * Expire due pending rows, then return the newest remaining pending charge.
   *
   * @param accountId - Owner account id (`$1`).
   * @param nowMs - Clock (epoch ms); bound as ISO on the expire statement.
   * @returns Mapped row, or `null`.
   */
  async currentPending(accountId: string, nowMs: number): Promise<PosCharge | null> {
    await this.#expireDue(accountId, nowMs);
    const rows = await this.#sql.query<PosSqlRow>(
      `SELECT id, account_id, amount_sats, status, created_at, expires_at
FROM pos_charge
WHERE account_id = $1 AND status = 'pending'
ORDER BY created_at DESC, id DESC
LIMIT 1`,
      [accountId],
    );
    const row = rows[0];
    return row === undefined ? null : mapPosRow(row);
  }

  /**
   * Expire due pending rows, then insert `row`. Logs `pos.create`.
   * A concurrent pending insert hits the partial unique index.
   *
   * @param row - Fully formed charge.
   * @returns A copy of the stored row.
   */
  async create(row: PosCharge): Promise<PosCharge> {
    if (row.status === 'pending') {
      await this.#expireDue(row.accountId, row.createdAt.getTime());
    }
    await this.#sql.execute(
      `INSERT INTO pos_charge (id, account_id, amount_sats, status, created_at, expires_at)
VALUES ($1,$2,$3,$4,$5,$6)`,
      [
        row.id,
        row.accountId,
        row.amountSats,
        row.status,
        row.createdAt.toISOString(),
        row.expiresAt.toISOString(),
      ],
    );
    logEvent('pos.create', { accountId: row.accountId });
    return copyCharge(row);
  }

  /**
   * Expire due rows, then cancel every remaining pending charge.
   *
   * @param accountId - Owner account id (`$1` on both statements).
   * @param nowMs - Clock (epoch ms).
   * @returns The newest mapped cancelled row, or `null`.
   */
  async cancelPending(accountId: string, nowMs: number): Promise<PosCharge | null> {
    await this.#expireDue(accountId, nowMs);
    const rows = await this.#sql.query<PosSqlRow>(
      `UPDATE pos_charge
SET status = 'cancelled'
WHERE account_id = $1 AND status = 'pending'
RETURNING id, account_id, amount_sats, status, created_at, expires_at`,
      [accountId],
    );
    const cancelled = newestFirst(rows.map((row) => mapPosRow(row)));
    const newest = cancelled[0];
    if (newest === undefined) {
      return null;
    }
    logEvent('pos.cancel', { accountId });
    return newest;
  }

  /**
   * Newest-first list for one account, capped at `limit`.
   *
   * @param accountId - Owner account id (`$1`).
   * @param limit - Maximum rows (`$2`).
   * @returns Mapped rows.
   */
  async listForAccount(accountId: string, limit: number): Promise<PosCharge[]> {
    const rows = await this.#sql.query<PosSqlRow>(
      `SELECT id, account_id, amount_sats, status, created_at, expires_at
FROM pos_charge
WHERE account_id = $1
ORDER BY created_at DESC, id DESC
LIMIT $2`,
      [accountId, limit],
    );
    return rows.map((row) => mapPosRow(row));
  }

  /**
   * Newest-first list from `pos_charge`, capped at `limit`.
   *
   * @param limit - Maximum rows (`$1`).
   * @returns Mapped rows.
   */
  async listLatest(limit: number): Promise<PosCharge[]> {
    const rows = await this.#sql.query<PosSqlRow>(
      `SELECT id, account_id, amount_sats, status, created_at, expires_at
FROM pos_charge
ORDER BY created_at DESC, id DESC
LIMIT $1`,
      [limit],
    );
    return rows.map((row) => mapPosRow(row));
  }
}
