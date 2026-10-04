/**
 * Persistence for member point-of-sale charges.
 *
 * v1 default is in-memory. Production boot injects Postgres when
 * `DATABASE_URL` is set. Tables are `pos_charge` and `pos_charge_invoice`
 * (the BOLT11 payment hashes handed out for a pending charge).
 */

import type { SqlClient } from '@/lib/auth/sql';
import { logEvent } from '@/lib/log';
import type { PosCharge, PosChargeStatus } from '@/lib/pos-charge';

/** POS charge used to mark an account as active on a UTC day. */
export type PosChargeRef = { accountId: string; createdAtMs: number };

/** A charge the paid watcher still polls, with the BOLT11 payment hashes recorded for it. */
export interface PosWatch {
  /** The pending or expired charge (its `sparkInvoice` is polled too). */
  charge: PosCharge;
  /** Payment hashes (64 lower-case hex) recorded for this charge, oldest first. */
  paymentHashes: string[];
}

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

  /**
   * Charges whose `created_at` is in `[startMs, endMs)`, every status.
   *
   * @param startMs - Inclusive window start (epoch ms).
   * @param endMs - Exclusive window end (epoch ms).
   * @returns Account id and created-at epoch ms.
   */
  listCreatedBetween(startMs: number, endMs: number): Promise<PosChargeRef[]>;

  /**
   * Store `invoice` as the charge's Spark invoice unless it already has one.
   * Only a pending charge whose `expiresAt` is after `nowMs` gets one.
   *
   * @param chargeId - Charge id.
   * @param invoice - New `spark1…` string.
   * @param nowMs - Clock (epoch ms).
   * @returns The stored Spark invoice (the existing one when present), or
   *   `null` when the charge is not pending and unexpired.
   */
  issueSparkInvoice(chargeId: string, invoice: string, nowMs: number): Promise<string | null>;

  /**
   * Record a BOLT11 payment hash handed out for a charge. Only a pending
   * charge whose `expiresAt` is after `nowMs` records; a hash already
   * recorded is left unchanged.
   *
   * @param chargeId - Charge id.
   * @param paymentHash - Payment hash of the BOLT11 (64 lower-case hex).
   * @param nowMs - Clock (epoch ms); stored as the issue time.
   * @returns `true` when this call recorded the hash.
   */
  recordInvoice(chargeId: string, paymentHash: string, nowMs: number): Promise<boolean>;

  /**
   * Charges still watched for a payment: `pending` or `expired` with
   * `expiresAt` after `sinceMs`, oldest first, each with its recorded
   * payment hashes. Paid and cancelled charges are never listed.
   *
   * @param sinceMs - Watch window start (epoch ms).
   * @returns Watched charges.
   */
  listWatched(sinceMs: number): Promise<PosWatch[]>;

  /**
   * Mark a pending or expired charge paid. Atomic and once only: a charge
   * that is already paid or cancelled is left unchanged. Logs `pos.paid`.
   *
   * @param chargeId - Charge id.
   * @param paidAtMs - Confirmation instant (epoch ms).
   * @returns The paid row, or `null` when this call did not change it.
   */
  markPaid(chargeId: string, paidAtMs: number): Promise<PosCharge | null>;
}

/**
 * Idempotent DDL for the `pos_charge` and `pos_charge_invoice` tables
 * (matches `docs/schema/pos_charge.sql`). Existing tables gain `paid_at`,
 * `spark_invoice`, and the `paid` status.
 */
export const POS_SCHEMA_SQL: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS pos_charge (
  id uuid PRIMARY KEY,
  account_id uuid NOT NULL REFERENCES account (id),
  amount_sats bigint NOT NULL CHECK (amount_sats > 0),
  status text NOT NULL CHECK (status IN ('pending', 'paid', 'cancelled', 'expired')),
  created_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  paid_at timestamptz,
  spark_invoice text
)`,
  `CREATE INDEX IF NOT EXISTS pos_charge_account_created_idx
  ON pos_charge (account_id, created_at DESC, id DESC)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS pos_charge_account_pending_idx
  ON pos_charge (account_id) WHERE status = 'pending'`,
  `ALTER TABLE pos_charge ADD COLUMN IF NOT EXISTS paid_at timestamptz`,
  `ALTER TABLE pos_charge ADD COLUMN IF NOT EXISTS spark_invoice text`,
  `ALTER TABLE pos_charge DROP CONSTRAINT IF EXISTS pos_charge_status_check`,
  `ALTER TABLE pos_charge ADD CONSTRAINT pos_charge_status_check
  CHECK (status IN ('pending', 'paid', 'cancelled', 'expired'))`,
  `CREATE INDEX IF NOT EXISTS pos_charge_watch_idx
  ON pos_charge (expires_at) WHERE status IN ('pending', 'expired')`,
  `CREATE TABLE IF NOT EXISTS pos_charge_invoice (
  payment_hash text PRIMARY KEY,
  charge_id uuid NOT NULL REFERENCES pos_charge (id),
  created_at timestamptz NOT NULL
)`,
  `CREATE INDEX IF NOT EXISTS pos_charge_invoice_charge_idx
  ON pos_charge_invoice (charge_id, created_at)`,
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
    paidAt: row.paidAt === null ? null : new Date(row.paidAt.getTime()),
  };
}

/** Oldest `createdAt` first, then `id` ascending. */
function oldestFirst(rows: readonly PosCharge[]): PosCharge[] {
  return newestFirst(rows).reverse();
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
  readonly #invoices: { paymentHash: string; chargeId: string; createdAtMs: number }[] = [];

  /**
   * The stored row with `id` when it is pending and `expiresAt` is after `nowMs`.
   *
   * @param id - Charge id.
   * @param nowMs - Clock (epoch ms).
   */
  #openRow(id: string, nowMs: number): PosCharge | undefined {
    return this.#rows.find(
      (row) => row.id === id && row.status === 'pending' && row.expiresAt.getTime() > nowMs,
    );
  }

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

  /**
   * Charges whose `createdAt` is in `[startMs, endMs)`, every status.
   *
   * @param startMs - Inclusive window start (epoch ms).
   * @param endMs - Exclusive window end (epoch ms).
   * @returns Account id and created-at epoch ms.
   */
  listCreatedBetween(startMs: number, endMs: number): Promise<PosChargeRef[]> {
    const listed: PosChargeRef[] = [];
    for (const row of this.#rows) {
      const createdAtMs = row.createdAt.getTime();
      if (createdAtMs >= startMs && createdAtMs < endMs) {
        listed.push({ accountId: row.accountId, createdAtMs });
      }
    }
    return Promise.resolve(listed);
  }

  /**
   * Store the charge's Spark invoice unless it has one.
   *
   * @param chargeId - Charge id.
   * @param invoice - New `spark1…` string.
   * @param nowMs - Clock (epoch ms).
   * @returns The stored Spark invoice, or `null` when the charge is not pending and unexpired.
   */
  issueSparkInvoice(chargeId: string, invoice: string, nowMs: number): Promise<string | null> {
    const row = this.#openRow(chargeId, nowMs);
    if (row === undefined) {
      return Promise.resolve(null);
    }
    row.sparkInvoice ??= invoice;
    return Promise.resolve(row.sparkInvoice);
  }

  /**
   * Record a payment hash for a pending, unexpired charge once.
   *
   * @param chargeId - Charge id.
   * @param paymentHash - BOLT11 payment hash.
   * @param nowMs - Clock (epoch ms).
   * @returns `true` when this call recorded the hash.
   */
  recordInvoice(chargeId: string, paymentHash: string, nowMs: number): Promise<boolean> {
    if (
      this.#openRow(chargeId, nowMs) === undefined ||
      this.#invoices.some((invoice) => invoice.paymentHash === paymentHash)
    ) {
      return Promise.resolve(false);
    }
    this.#invoices.push({ paymentHash, chargeId, createdAtMs: nowMs });
    return Promise.resolve(true);
  }

  /**
   * Pending or expired charges with `expiresAt` after `sinceMs`, oldest first.
   *
   * @param sinceMs - Watch window start (epoch ms).
   * @returns Copies of the watched charges with their payment hashes.
   */
  listWatched(sinceMs: number): Promise<PosWatch[]> {
    const watched = oldestFirst(
      this.#rows.filter(
        (row) =>
          (row.status === 'pending' || row.status === 'expired') &&
          row.expiresAt.getTime() > sinceMs,
      ),
    );
    return Promise.resolve(
      watched.map((row) => ({
        charge: copyCharge(row),
        paymentHashes: this.#invoices
          .filter((invoice) => invoice.chargeId === row.id)
          .map((invoice) => invoice.paymentHash),
      })),
    );
  }

  /**
   * Mark a pending or expired charge paid once. Logs `pos.paid`.
   *
   * @param chargeId - Charge id.
   * @param paidAtMs - Confirmation instant (epoch ms).
   * @returns A copy of the paid row, or `null` when nothing changed.
   */
  markPaid(chargeId: string, paidAtMs: number): Promise<PosCharge | null> {
    const row = this.#rows.find(
      (candidate) =>
        candidate.id === chargeId &&
        (candidate.status === 'pending' || candidate.status === 'expired'),
    );
    if (row === undefined) {
      return Promise.resolve(null);
    }
    row.status = 'paid';
    row.paidAt = new Date(paidAtMs);
    logEvent('pos.paid', { accountId: row.accountId });
    return Promise.resolve(copyCharge(row));
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
  paid_at: Date | string | null;
  spark_invoice: string | null;
}

/** Columns selected into {@link PosSqlRow}. */
const POS_COLUMNS =
  'id, account_id, amount_sats, status, created_at, expires_at, paid_at, spark_invoice';

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
    paidAt: row.paid_at === null ? null : asDate(row.paid_at),
    sparkInvoice: row.spark_invoice,
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
      `SELECT ${POS_COLUMNS}
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
      `INSERT INTO pos_charge (${POS_COLUMNS})
VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [
        row.id,
        row.accountId,
        row.amountSats,
        row.status,
        row.createdAt.toISOString(),
        row.expiresAt.toISOString(),
        row.paidAt === null ? null : row.paidAt.toISOString(),
        row.sparkInvoice,
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
RETURNING ${POS_COLUMNS}`,
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
      `SELECT ${POS_COLUMNS}
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
      `SELECT ${POS_COLUMNS}
FROM pos_charge
ORDER BY created_at DESC, id DESC
LIMIT $1`,
      [limit],
    );
    return rows.map((row) => mapPosRow(row));
  }

  /**
   * Charges whose `created_at` is in `[startMs, endMs)`, every status.
   *
   * @param startMs - Inclusive window start (epoch ms); bound as ISO `$1`.
   * @param endMs - Exclusive window end (epoch ms); bound as ISO `$2`.
   * @returns Account id and created-at epoch ms.
   */
  async listCreatedBetween(startMs: number, endMs: number): Promise<PosChargeRef[]> {
    const rows = await this.#sql.query<{
      account_id: string;
      created_at: Date | string;
    }>(
      `SELECT account_id, created_at
FROM pos_charge
WHERE created_at >= $1 AND created_at < $2`,
      [new Date(startMs).toISOString(), new Date(endMs).toISOString()],
    );
    return rows.map((row) => ({
      accountId: row.account_id,
      createdAtMs: asDate(row.created_at).getTime(),
    }));
  }

  /**
   * One conditional `UPDATE` that keeps an existing `spark_invoice`.
   *
   * @param chargeId - Charge id (`$1`).
   * @param invoice - New `spark1…` string (`$2`).
   * @param nowMs - Clock (epoch ms); bound as ISO `$3`.
   * @returns The stored Spark invoice, or `null` when the charge is not pending and unexpired.
   */
  async issueSparkInvoice(
    chargeId: string,
    invoice: string,
    nowMs: number,
  ): Promise<string | null> {
    const rows = await this.#sql.query<{ spark_invoice: string }>(
      `UPDATE pos_charge
SET spark_invoice = COALESCE(spark_invoice, $2)
WHERE id = $1 AND status = 'pending' AND expires_at > $3
RETURNING spark_invoice`,
      [chargeId, invoice, new Date(nowMs).toISOString()],
    );
    return rows[0]?.spark_invoice ?? null;
  }

  /**
   * Insert the payment hash when the charge is pending and unexpired; a
   * conflicting hash is left unchanged.
   *
   * @param chargeId - Charge id (`$1`).
   * @param paymentHash - BOLT11 payment hash (`$2`).
   * @param nowMs - Clock (epoch ms); bound as ISO `$3`.
   * @returns `true` when this call inserted the row.
   */
  async recordInvoice(chargeId: string, paymentHash: string, nowMs: number): Promise<boolean> {
    const rows = await this.#sql.query<{ payment_hash: string }>(
      `INSERT INTO pos_charge_invoice (payment_hash, charge_id, created_at)
SELECT $2::text, id, $3::timestamptz
FROM pos_charge
WHERE id = $1 AND status = 'pending' AND expires_at > $3::timestamptz
ON CONFLICT (payment_hash) DO NOTHING
RETURNING payment_hash`,
      [chargeId, paymentHash, new Date(nowMs).toISOString()],
    );
    return rows.length > 0;
  }

  /**
   * Pending or expired charges with `expires_at` after `sinceMs`, joined to
   * their recorded payment hashes, oldest first.
   *
   * @param sinceMs - Watch window start (epoch ms); bound as ISO `$1`.
   * @returns Watched charges with their payment hashes.
   */
  async listWatched(sinceMs: number): Promise<PosWatch[]> {
    const rows = await this.#sql.query<PosSqlRow & { payment_hash: string | null }>(
      `SELECT c.id, c.account_id, c.amount_sats, c.status, c.created_at, c.expires_at,
       c.paid_at, c.spark_invoice, i.payment_hash
FROM pos_charge c
LEFT JOIN pos_charge_invoice i ON i.charge_id = c.id
WHERE c.status IN ('pending', 'expired') AND c.expires_at > $1
ORDER BY c.created_at ASC, c.id ASC, i.created_at ASC, i.payment_hash ASC`,
      [new Date(sinceMs).toISOString()],
    );
    const watched = new Map<string, PosWatch>();
    for (const row of rows) {
      let entry = watched.get(row.id);
      if (entry === undefined) {
        entry = { charge: mapPosRow(row), paymentHashes: [] };
        watched.set(row.id, entry);
      }
      if (row.payment_hash !== null) {
        entry.paymentHashes.push(row.payment_hash);
      }
    }
    return [...watched.values()];
  }

  /**
   * One conditional `UPDATE … WHERE status IN ('pending', 'expired')`. Logs
   * `pos.paid` when a row is returned.
   *
   * @param chargeId - Charge id (`$1`).
   * @param paidAtMs - Confirmation instant (epoch ms); bound as ISO `$2`.
   * @returns The mapped paid row, or `null` when nothing changed.
   */
  async markPaid(chargeId: string, paidAtMs: number): Promise<PosCharge | null> {
    const rows = await this.#sql.query<PosSqlRow>(
      `UPDATE pos_charge
SET status = 'paid', paid_at = $2
WHERE id = $1 AND status IN ('pending', 'expired')
RETURNING ${POS_COLUMNS}`,
      [chargeId, new Date(paidAtMs).toISOString()],
    );
    const row = rows[0];
    if (row === undefined) {
      return null;
    }
    const paid = mapPosRow(row);
    logEvent('pos.paid', { accountId: paid.accountId });
    return paid;
  }
}
