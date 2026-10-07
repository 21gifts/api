/** Persistence ports and adapters for wallet balance snapshots and payments. */

import type { SqlClient } from '@/lib/auth/sql';
import type { WalletPaymentClass, WalletPaymentCategory } from '@/lib/wallet-category';
import type {
  ReportedWalletPayment,
  WalletPaymentDirection,
  WalletPaymentStatus,
} from '@/lib/wallet-report';

/** One immutable balance observation submitted by a member wallet. */
export interface WalletBalanceSnapshot {
  /** Server-generated snapshot id. */
  id: string;
  /** Reporting account id. */
  accountId: string;
  /** Balance in whole sats. */
  balanceSats: number;
  /** Client-reported sync instant. */
  syncedAt: Date;
  /** Server receipt instant. */
  receivedAt: Date;
}

/** Stored reported payment including server classification and observation times. */
export interface WalletPaymentRecord extends ReportedWalletPayment, WalletPaymentClass {
  /** Reporting account id. */
  accountId: string;
  /** First server receipt instant for this account/payment id. */
  firstSeenAt: Date;
  /** Last server receipt instant that changed a stored value. */
  updatedAt: Date;
}

/** Persistence contract for wallet report data. */
export interface WalletStore {
  /**
   * Append one balance snapshot.
   *
   * @param snapshot - Fully formed immutable snapshot.
   */
  recordBalance(snapshot: WalletBalanceSnapshot): Promise<void>;

  /**
   * Upsert payment rows, preserving first-seen time and non-null details. Rows for the same
   * payment are applied in the given order; distinct payments may be written concurrently.
   *
   * @param rows - Classified payment observations.
   */
  upsertPayments(rows: readonly WalletPaymentRecord[]): Promise<void>;

  /**
   * Return the newest received balance snapshot for an account.
   *
   * @param accountId - Reporting account id.
   * @returns A caller-owned snapshot, or `undefined`.
   */
  latestBalance(accountId: string): Promise<WalletBalanceSnapshot | undefined>;

  /**
   * List an account's payments by paid time then payment id, newest first.
   *
   * @param accountId - Reporting account id.
   * @param limit - Maximum rows.
   * @returns Caller-owned payment rows.
   */
  listPayments(accountId: string, limit: number): Promise<WalletPaymentRecord[]>;
}

/** Idempotent DDL for wallet balance snapshots and reported payments. */
export const WALLET_SCHEMA_SQL: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS wallet_balance_snapshot (
  id uuid PRIMARY KEY,
  account_id uuid NOT NULL REFERENCES account (id),
  balance_sats bigint NOT NULL CHECK (balance_sats >= 0),
  synced_at timestamptz NOT NULL,
  received_at timestamptz NOT NULL
)`,
  `CREATE INDEX IF NOT EXISTS wallet_balance_snapshot_account_received_idx ON wallet_balance_snapshot (account_id, received_at DESC, id DESC)`,
  `CREATE TABLE IF NOT EXISTS wallet_payment (
  account_id uuid NOT NULL REFERENCES account (id),
  payment_id text NOT NULL,
  direction text NOT NULL CHECK (direction IN ('in', 'out')),
  status text NOT NULL CHECK (status IN ('pending', 'completed', 'failed')),
  amount_sats bigint NOT NULL CHECK (amount_sats >= 0),
  fee_sats bigint NOT NULL CHECK (fee_sats >= 0),
  paid_at timestamptz NOT NULL,
  method text NOT NULL,
  payment_hash text,
  invoice text,
  destination text,
  description text,
  lnurl_comment text,
  category text NOT NULL CHECK (category IN ('member', 'shop', 'platform', 'gift', 'outside_lightning', 'onchain', 'unknown')),
  counterparty_account_id uuid REFERENCES account (id),
  first_seen_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  PRIMARY KEY (account_id, payment_id)
)`,
  `ALTER TABLE wallet_payment ADD COLUMN IF NOT EXISTS invoice text`,
  `CREATE INDEX IF NOT EXISTS wallet_payment_account_paid_idx ON wallet_payment (account_id, paid_at DESC, payment_id DESC)`,
];

/**
 * Apply {@link WALLET_SCHEMA_SQL} in order.
 *
 * @param sql - Parameter-bound SQL client.
 * @returns Resolves after every statement succeeds.
 * @throws Propagates SQL failures.
 */
export async function migrateWalletSchema(sql: SqlClient): Promise<void> {
  for (const statement of WALLET_SCHEMA_SQL) {
    await sql.execute(statement);
  }
}

function copyBalance(row: WalletBalanceSnapshot): WalletBalanceSnapshot {
  return {
    ...row,
    syncedAt: new Date(row.syncedAt.getTime()),
    receivedAt: new Date(row.receivedAt.getTime()),
  };
}

function copyPayment(row: WalletPaymentRecord): WalletPaymentRecord {
  return {
    ...row,
    paidAt: new Date(row.paidAt.getTime()),
    firstSeenAt: new Date(row.firstSeenAt.getTime()),
    updatedAt: new Date(row.updatedAt.getTime()),
  };
}

const REQUIRED_PAYMENT_FIELDS = ['direction', 'status', 'amountSats', 'feeSats', 'method'] as const;

/** Categories the classifier falls back to when nothing in the report names the other side. */
const FALLBACK_CATEGORIES: ReadonlySet<WalletPaymentCategory> = new Set([
  'outside_lightning',
  'onchain',
  'unknown',
]);

const DETAIL_PAYMENT_FIELDS = [
  'paymentHash',
  'invoice',
  'destination',
  'description',
  'lnurlComment',
] as const;

function updatePayment(existing: WalletPaymentRecord, row: WalletPaymentRecord): void {
  // A report observed before the stored state (a slower concurrent request) never overwrites it.
  if (row.updatedAt.getTime() < existing.updatedAt.getTime()) {
    return;
  }
  let changed = existing.paidAt.getTime() !== row.paidAt.getTime();
  existing.paidAt = new Date(row.paidAt.getTime());
  for (const field of REQUIRED_PAYMENT_FIELDS) {
    if (existing[field] !== row[field]) {
      changed = true;
      Object.assign(existing, { [field]: row[field] });
    }
  }
  for (const field of DETAIL_PAYMENT_FIELDS) {
    const next = row[field] ?? existing[field];
    if (existing[field] !== next) {
      changed = true;
      Object.assign(existing, { [field]: next });
    }
  }
  // A later report with less detail never turns a resolved category back into a fallback one.
  const keepClass =
    FALLBACK_CATEGORIES.has(row.category) && !FALLBACK_CATEGORIES.has(existing.category);
  if (
    !keepClass &&
    (existing.category !== row.category ||
      existing.counterpartyAccountId !== row.counterpartyAccountId)
  ) {
    changed = true;
    existing.category = row.category;
    existing.counterpartyAccountId = row.counterpartyAccountId;
  }
  if (changed) {
    existing.updatedAt = new Date(row.updatedAt.getTime());
  }
}

/** UTF-8 byte order, the same order as Postgres `COLLATE "C"`. */
function byteOrder(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'));
}

/** Process-local wallet store used by tests and database-free boots. */
export class InMemoryWalletStore implements WalletStore {
  readonly #balances: WalletBalanceSnapshot[] = [];
  readonly #payments = new Map<string, WalletPaymentRecord>();

  /**
   * Append a copy of a balance snapshot.
   *
   * @param snapshot - Balance observation.
   */
  recordBalance(snapshot: WalletBalanceSnapshot): Promise<void> {
    this.#balances.push(copyBalance(snapshot));
    return Promise.resolve();
  }

  /**
   * Upsert rows sequentially using account id plus payment id as the key.
   *
   * @param rows - Classified payment observations.
   */
  upsertPayments(rows: readonly WalletPaymentRecord[]): Promise<void> {
    for (const row of rows) {
      const key = `${row.accountId}\u0000${row.paymentId}`;
      const existing = this.#payments.get(key);
      if (existing === undefined) {
        this.#payments.set(key, copyPayment(row));
      } else {
        updatePayment(existing, row);
      }
    }
    return Promise.resolve();
  }

  /**
   * Return the newest snapshot by receive time and id.
   *
   * @param accountId - Reporting account id.
   * @returns A snapshot copy, or `undefined`.
   */
  latestBalance(accountId: string): Promise<WalletBalanceSnapshot | undefined> {
    const row = this.#balances
      .filter((candidate) => candidate.accountId === accountId)
      .sort((a, b) => {
        const byTime = b.receivedAt.getTime() - a.receivedAt.getTime();
        return byTime === 0 ? b.id.localeCompare(a.id) : byTime;
      })[0];
    return Promise.resolve(row === undefined ? undefined : copyBalance(row));
  }

  /**
   * List payment copies newest first.
   *
   * @param accountId - Reporting account id.
   * @param limit - Maximum rows.
   * @returns Sorted payment copies.
   */
  listPayments(accountId: string, limit: number): Promise<WalletPaymentRecord[]> {
    return Promise.resolve(
      [...this.#payments.values()]
        .filter((row) => row.accountId === accountId)
        .sort((a, b) => {
          const byTime = b.paidAt.getTime() - a.paidAt.getTime();
          return byTime === 0 ? byteOrder(b.paymentId, a.paymentId) : byTime;
        })
        .slice(0, limit)
        .map(copyPayment),
    );
  }
}

interface WalletBalanceSqlRow {
  id: string;
  account_id: string;
  balance_sats: number | string | bigint;
  synced_at: Date | string;
  received_at: Date | string;
}

interface WalletPaymentSqlRow {
  account_id: string;
  payment_id: string;
  direction: string;
  status: string;
  amount_sats: number | string | bigint;
  fee_sats: number | string | bigint;
  paid_at: Date | string;
  method: string;
  payment_hash: string | null;
  invoice: string | null;
  destination: string | null;
  description: string | null;
  lnurl_comment: string | null;
  category: string;
  counterparty_account_id: string | null;
  first_seen_at: Date | string;
  updated_at: Date | string;
}

function sqlDate(value: Date | string): Date {
  return value instanceof Date ? new Date(value.getTime()) : new Date(value);
}

function mapBalance(row: WalletBalanceSqlRow): WalletBalanceSnapshot {
  return {
    id: row.id,
    accountId: row.account_id,
    balanceSats: Number(row.balance_sats),
    syncedAt: sqlDate(row.synced_at),
    receivedAt: sqlDate(row.received_at),
  };
}

function mapPayment(row: WalletPaymentSqlRow): WalletPaymentRecord {
  return {
    accountId: row.account_id,
    paymentId: row.payment_id,
    direction: row.direction as WalletPaymentDirection,
    status: row.status as WalletPaymentStatus,
    amountSats: Number(row.amount_sats),
    feeSats: Number(row.fee_sats),
    paidAt: sqlDate(row.paid_at),
    method: row.method,
    paymentHash: row.payment_hash,
    invoice: row.invoice,
    destination: row.destination,
    description: row.description,
    lnurlComment: row.lnurl_comment,
    category: row.category as WalletPaymentCategory,
    counterpartyAccountId: row.counterparty_account_id,
    firstSeenAt: sqlDate(row.first_seen_at),
    updatedAt: sqlDate(row.updated_at),
  };
}

const PAYMENT_COLUMNS = `account_id, payment_id, direction, status, amount_sats, fee_sats,
paid_at, method, payment_hash, invoice, destination, description, lnurl_comment, category,
counterparty_account_id, first_seen_at, updated_at`;

/** Durable wallet store backed by Postgres. */
export class PostgresWalletStore implements WalletStore {
  /**
   * @param sql - Parameter-bound SQL client for an already migrated database.
   */
  constructor(private readonly sql: SqlClient) {}

  /**
   * Insert one immutable balance snapshot.
   *
   * @param snapshot - Balance observation.
   */
  async recordBalance(snapshot: WalletBalanceSnapshot): Promise<void> {
    await this.sql.execute(
      `INSERT INTO wallet_balance_snapshot (id, account_id, balance_sats, synced_at, received_at)
VALUES ($1,$2,$3,$4,$5)`,
      [
        snapshot.id,
        snapshot.accountId,
        snapshot.balanceSats,
        snapshot.syncedAt,
        snapshot.receivedAt,
      ],
    );
  }

  /**
   * Upsert each payment with one ordered statement and a no-op update guard.
   *
   * @param rows - Classified payment observations.
   */
  async upsertPayments(rows: readonly WalletPaymentRecord[]): Promise<void> {
    // Distinct payments are written concurrently (the pool bounds it); a key repeated in one call keeps its order.
    const byKey = new Map<string, WalletPaymentRecord[]>();
    for (const row of rows) {
      const key = `${row.accountId}\u0000${row.paymentId}`;
      byKey.set(key, [...(byKey.get(key) ?? []), row]);
    }
    await Promise.all(
      [...byKey.values()].map(async (group) => {
        for (const row of group) {
          await this.upsertPayment(row);
        }
      }),
    );
  }

  /** Upsert one payment row with the guarded conflict update. */
  private async upsertPayment(row: WalletPaymentRecord): Promise<void> {
    await this.sql.execute(
      `INSERT INTO wallet_payment (${PAYMENT_COLUMNS})
VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
ON CONFLICT (account_id, payment_id) DO UPDATE SET
direction = EXCLUDED.direction,
status = EXCLUDED.status,
amount_sats = EXCLUDED.amount_sats,
fee_sats = EXCLUDED.fee_sats,
paid_at = EXCLUDED.paid_at,
method = EXCLUDED.method,
payment_hash = COALESCE(EXCLUDED.payment_hash, wallet_payment.payment_hash),
invoice = COALESCE(EXCLUDED.invoice, wallet_payment.invoice),
destination = COALESCE(EXCLUDED.destination, wallet_payment.destination),
description = COALESCE(EXCLUDED.description, wallet_payment.description),
lnurl_comment = COALESCE(EXCLUDED.lnurl_comment, wallet_payment.lnurl_comment),
category = CASE WHEN (EXCLUDED.category IN ('outside_lightning', 'onchain', 'unknown') AND wallet_payment.category NOT IN ('outside_lightning', 'onchain', 'unknown')) THEN wallet_payment.category ELSE EXCLUDED.category END,
counterparty_account_id = CASE WHEN (EXCLUDED.category IN ('outside_lightning', 'onchain', 'unknown') AND wallet_payment.category NOT IN ('outside_lightning', 'onchain', 'unknown')) THEN wallet_payment.counterparty_account_id ELSE EXCLUDED.counterparty_account_id END,
updated_at = EXCLUDED.updated_at
WHERE (wallet_payment.direction, wallet_payment.status, wallet_payment.amount_sats,
       wallet_payment.fee_sats, wallet_payment.paid_at, wallet_payment.method,
       wallet_payment.payment_hash, wallet_payment.invoice, wallet_payment.destination,
       wallet_payment.description, wallet_payment.lnurl_comment, wallet_payment.category,
       wallet_payment.counterparty_account_id)
IS DISTINCT FROM
      (EXCLUDED.direction, EXCLUDED.status, EXCLUDED.amount_sats,
       EXCLUDED.fee_sats, EXCLUDED.paid_at, EXCLUDED.method,
       COALESCE(EXCLUDED.payment_hash, wallet_payment.payment_hash),
       COALESCE(EXCLUDED.invoice, wallet_payment.invoice),
       COALESCE(EXCLUDED.destination, wallet_payment.destination),
       COALESCE(EXCLUDED.description, wallet_payment.description),
       COALESCE(EXCLUDED.lnurl_comment, wallet_payment.lnurl_comment),
       CASE WHEN (EXCLUDED.category IN ('outside_lightning', 'onchain', 'unknown') AND wallet_payment.category NOT IN ('outside_lightning', 'onchain', 'unknown')) THEN wallet_payment.category ELSE EXCLUDED.category END,
       CASE WHEN (EXCLUDED.category IN ('outside_lightning', 'onchain', 'unknown') AND wallet_payment.category NOT IN ('outside_lightning', 'onchain', 'unknown')) THEN wallet_payment.counterparty_account_id ELSE EXCLUDED.counterparty_account_id END)
  AND EXCLUDED.updated_at >= wallet_payment.updated_at`,
      [
        row.accountId,
        row.paymentId,
        row.direction,
        row.status,
        row.amountSats,
        row.feeSats,
        row.paidAt,
        row.method,
        row.paymentHash,
        row.invoice,
        row.destination,
        row.description,
        row.lnurlComment,
        row.category,
        row.counterpartyAccountId,
        row.firstSeenAt,
        row.updatedAt,
      ],
    );
  }

  /**
   * Read the latest balance snapshot for an account.
   *
   * @param accountId - Reporting account id (`$1`).
   * @returns A mapped snapshot, or `undefined`.
   */
  async latestBalance(accountId: string): Promise<WalletBalanceSnapshot | undefined> {
    const rows = await this.sql.query<WalletBalanceSqlRow>(
      `SELECT id, account_id, balance_sats, synced_at, received_at
FROM wallet_balance_snapshot
WHERE account_id = $1
ORDER BY received_at DESC, id DESC
LIMIT 1`,
      [accountId],
    );
    const row = rows[0];
    return row === undefined ? undefined : mapBalance(row);
  }

  /**
   * Read newest payments for an account.
   *
   * @param accountId - Reporting account id (`$1`).
   * @param limit - Maximum rows (`$2`).
   * @returns Mapped payment rows.
   */
  async listPayments(accountId: string, limit: number): Promise<WalletPaymentRecord[]> {
    const rows = await this.sql.query<WalletPaymentSqlRow>(
      `SELECT ${PAYMENT_COLUMNS}
FROM wallet_payment
WHERE account_id = $1
ORDER BY paid_at DESC, payment_id COLLATE "C" DESC
LIMIT $2`,
      [accountId, limit],
    );
    return rows.map(mapPayment);
  }
}
