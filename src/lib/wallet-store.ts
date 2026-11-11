/** Persistence ports and adapters for wallet balance snapshots and payments. */

import type { SqlClient } from '@/lib/auth/sql';
import { utcDayKey } from '@/lib/funding';
import type {
  WalletAccountKind,
  WalletPaymentClass,
  WalletPaymentCategory,
} from '@/lib/wallet-category';
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
  /** Observation instant of the report that first stored this account/payment id. */
  firstSeenAt: Date;
  /** Last server receipt instant that changed a stored value. */
  updatedAt: Date;
}

/** Completed wallet movement totals for one account. */
export interface WalletPaymentTotals {
  /** Sum of `amount_sats` on completed incoming payments. */
  receivedSats: bigint;
  /** Sum of `amount_sats` on completed outgoing payments. */
  paidOutSats: bigint;
  /** Sum of `fee_sats` on completed outgoing payments. */
  feesSats: bigint;
}

/** Keyset position after the last row of a payment page. */
export interface WalletPaymentCursor {
  /** Paid instant of the last returned row. */
  paidAt: Date;
  /** Payment id of the last returned row. */
  paymentId: string;
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
   * After each row, the two sides of an internal transfer are paired by payment id: when the
   * payment id is held by exactly two rows of opposite direction on different accounts, a row
   * whose own fields resolved nothing (`unknown`, no counterparty) takes its category from the
   * other, resolved row and that row's account as counterparty.
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
   * Return the newest received balance snapshot of every account and UTC day.
   *
   * @returns One caller-owned snapshot per account and UTC day, ordered by account then time.
   */
  dailyBalances(): Promise<WalletBalanceSnapshot[]>;

  /**
   * Aggregate completed payments by direction for one account.
   *
   * @param accountId - Reporting account id.
   * @returns Incoming, outgoing, and outgoing-fee sats.
   */
  paymentTotals(accountId: string): Promise<WalletPaymentTotals>;

  /**
   * List an account's payments by paid time then payment id, newest first.
   *
   * @param accountId - Reporting account id.
   * @param limit - Maximum rows.
   * @param after - Optional keyset position; only rows strictly after it are returned.
   * @param status - Restrict to one stored status. Omitted lists every status.
   * @returns Caller-owned payment rows.
   */
  listPayments(
    accountId: string,
    limit: number,
    after?: WalletPaymentCursor,
    status?: WalletPaymentStatus,
  ): Promise<WalletPaymentRecord[]>;
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
  `ALTER TABLE wallet_payment ADD COLUMN IF NOT EXISTS last_observed_at timestamptz`,
  `CREATE INDEX IF NOT EXISTS wallet_payment_account_paid_idx ON wallet_payment (account_id, paid_at DESC, payment_id DESC)`,
  `CREATE INDEX IF NOT EXISTS wallet_payment_payment_id_idx ON wallet_payment (payment_id)`,
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

/** Whether a row's own fields resolved neither a category nor a counterparty. */
function unresolved(row: WalletPaymentRecord): boolean {
  return row.category === 'unknown' && row.counterpartyAccountId === null;
}

/**
 * Category of the unresolved side of a transfer, from its resolved other side `source`.
 *
 * Mirrors `PAIRED_CATEGORY` in `pairFillSql`: the platform account is `platform`; a `gift`
 * (forum invoice or zap) is a gift on both sides; a `shop` row without a counterparty is the
 * shop's own point-of-sale receipt, so its account is the shop; otherwise the source account is
 * named like any resolved counterparty.
 */
function pairedCategory(
  source: WalletPaymentRecord,
  kind: WalletAccountKind,
): WalletPaymentCategory {
  if (kind === 'platform') {
    return 'platform';
  }
  if (source.category === 'gift') {
    return 'gift';
  }
  if (source.category === 'shop' && source.counterpartyAccountId === null) {
    return 'shop';
  }
  return kind;
}

function updatePayment(existing: WalletPaymentRecord, row: WalletPaymentRecord): void {
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
  /** Stored row plus the latest accepted observation, also one that changed nothing (the staleness watermark). */
  readonly #payments = new Map<string, { row: WalletPaymentRecord; observedMs: number }>();
  readonly #accountKind: (accountId: string) => Promise<WalletAccountKind>;

  /**
   * Create an empty in-memory wallet store.
   *
   * @param accountKind - Names the account on the resolved side of a paired transfer (default:
   *   every account is a `member`); `createApp` passes `walletAccountKind`.
   */
  constructor(accountKind?: (accountId: string) => Promise<WalletAccountKind>) {
    this.#accountKind =
      accountKind ?? ((): Promise<WalletAccountKind> => Promise.resolve('member'));
  }

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
   * Upsert rows sequentially using account id plus payment id as the key, pairing each
   * payment's two sides after its row.
   *
   * @param rows - Classified payment observations.
   */
  async upsertPayments(rows: readonly WalletPaymentRecord[]): Promise<void> {
    for (const row of rows) {
      const key = `${row.accountId}\u0000${row.paymentId}`;
      const stored = this.#payments.get(key);
      const observedMs = row.updatedAt.getTime();
      if (stored === undefined) {
        this.#payments.set(key, { row: copyPayment(row), observedMs });
      } else if (observedMs >= stored.observedMs) {
        // A report observed before the latest accepted one (a slower concurrent request) never overwrites it.
        stored.observedMs = observedMs;
        updatePayment(stored.row, row);
      }
      await this.#pair(row.paymentId, row.updatedAt);
    }
  }

  /**
   * Fill the unresolved side of a payment id held by exactly two rows of opposite direction
   * (distinct accounts by key) from its resolved side, like `pairFillSql`.
   */
  async #pair(paymentId: string, at: Date): Promise<void> {
    const rows = [...this.#payments.values()]
      .map((entry) => entry.row)
      .filter((row) => row.paymentId === paymentId);
    if (rows.length !== 2) {
      return;
    }
    const [first, second] = rows as [WalletPaymentRecord, WalletPaymentRecord];
    const [target, source] = unresolved(first) ? [first, second] : [second, first];
    if (
      target.direction === source.direction ||
      !unresolved(target) ||
      source.category === 'unknown'
    ) {
      return;
    }
    const kind = await this.#accountKind(source.accountId);
    // Another write may have resolved the row while the account kind was looked up.
    if (!unresolved(target)) {
      return;
    }
    target.category = pairedCategory(source, kind);
    target.counterpartyAccountId = source.accountId;
    target.updatedAt = new Date(Math.max(target.updatedAt.getTime(), at.getTime()));
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
   * Return the newest snapshot of every account and UTC day.
   *
   * @returns One snapshot copy per account and UTC day, oldest received time first per account.
   */
  dailyBalances(): Promise<WalletBalanceSnapshot[]> {
    const byAccountDay = new Map<string, WalletBalanceSnapshot>();
    for (const row of this.#balances) {
      const key = `${row.accountId}\u0000${utcDayKey(row.receivedAt.getTime())}`;
      const current = byAccountDay.get(key);
      if (current === undefined || isLaterBalance(row, current)) {
        byAccountDay.set(key, row);
      }
    }
    return Promise.resolve(
      [...byAccountDay.values()]
        .sort((left, right) => {
          const byAccount = left.accountId.localeCompare(right.accountId);
          if (byAccount !== 0) {
            return byAccount;
          }
          return left.receivedAt.getTime() - right.receivedAt.getTime();
        })
        .map(copyBalance),
    );
  }

  /**
   * Sum completed payments by direction over stored rows.
   *
   * @param accountId - Reporting account id.
   * @returns Incoming and outgoing totals in whole sats.
   */
  paymentTotals(accountId: string): Promise<WalletPaymentTotals> {
    const totals: WalletPaymentTotals = { receivedSats: 0n, paidOutSats: 0n, feesSats: 0n };
    for (const entry of this.#payments.values()) {
      const row = entry.row;
      if (row.accountId !== accountId || row.status !== 'completed') {
        continue;
      }
      if (row.direction === 'in') {
        totals.receivedSats += BigInt(row.amountSats);
      } else {
        totals.paidOutSats += BigInt(row.amountSats);
        totals.feesSats += BigInt(row.feeSats);
      }
    }
    return Promise.resolve(totals);
  }

  /**
   * List payment copies newest first.
   *
   * @param accountId - Reporting account id.
   * @param limit - Maximum rows.
   * @param after - Optional keyset position after the last row of the previous page.
   * @param status - Restrict to one stored status. Omitted lists every status.
   * @returns Sorted payment copies.
   */
  listPayments(
    accountId: string,
    limit: number,
    after?: WalletPaymentCursor,
    status?: WalletPaymentStatus,
  ): Promise<WalletPaymentRecord[]> {
    return Promise.resolve(
      [...this.#payments.values()]
        .map((entry) => entry.row)
        .filter((row) => row.accountId === accountId)
        .filter((row) => status === undefined || row.status === status)
        .filter(
          (row) =>
            after === undefined ||
            row.paidAt.getTime() < after.paidAt.getTime() ||
            (row.paidAt.getTime() === after.paidAt.getTime() &&
              byteOrder(row.paymentId, after.paymentId) < 0),
        )
        .sort((a, b) => {
          const byTime = b.paidAt.getTime() - a.paidAt.getTime();
          return byTime === 0 ? byteOrder(b.paymentId, a.paymentId) : byTime;
        })
        .slice(0, limit)
        .map(copyPayment),
    );
  }
}

function isLaterBalance(candidate: WalletBalanceSnapshot, current: WalletBalanceSnapshot): boolean {
  const byTime = candidate.receivedAt.getTime() - current.receivedAt.getTime();
  return byTime > 0 || (byTime === 0 && byteOrder(candidate.id, current.id) > 0);
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

interface WalletPaymentTotalsSqlRow {
  direction: WalletPaymentDirection;
  amount_sats: number | string | bigint | null;
  fee_sats: number | string | bigint | null;
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

/** Payments written at the same time by one `upsertPayments` call. */
const UPSERT_CONCURRENCY = 8;

/** A later row with only a fallback category keeps the stored resolved category and counterparty. */
const KEEP_RESOLVED_CATEGORY = `(EXCLUDED.category IN ('outside_lightning', 'onchain', 'unknown') AND wallet_payment.category NOT IN ('outside_lightning', 'onchain', 'unknown'))`;

/** Whether the incoming row changes any stored value (after coalescing details and keeping resolved categories). */
const PAYMENT_VALUES_CHANGE = `(wallet_payment.direction, wallet_payment.status, wallet_payment.amount_sats,
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
       CASE WHEN ${KEEP_RESOLVED_CATEGORY} THEN wallet_payment.category ELSE EXCLUDED.category END,
       CASE WHEN ${KEEP_RESOLVED_CATEGORY} THEN wallet_payment.counterparty_account_id ELSE EXCLUDED.counterparty_account_id END)`;

/** Latest accepted observation of the stored row; rows written before the column existed fall back to `updated_at`. */
const OBSERVED_WATERMARK = 'COALESCE(wallet_payment.last_observed_at, wallet_payment.updated_at)';

/**
 * Category of the unresolved side `t` from its resolved other side `s` (account `a`), the same
 * rule as `pairedCategory`: platform account, then `gift`, then the shop's own point-of-sale
 * receipt, then the classifier's step 4 (`shop` for a live assigned `#21GiftsShop` note, the
 * pattern of `textHasHashtagToken`, else `member`).
 */
const PAIRED_CATEGORY = `CASE
  WHEN a.is_platform IS TRUE THEN 'platform'
  WHEN s.category = 'gift' THEN 'gift'
  WHEN s.category = 'shop' AND s.counterparty_account_id IS NULL THEN 'shop'
  WHEN EXISTS (
    SELECT 1 FROM message AS m
    WHERE m.parent_id IS NULL AND m.deleted_at IS NULL
      AND m.shop_account_id = s.account_id
      AND m.text ~* '#21GiftsShop(?![A-Za-z0-9_])'
  ) THEN 'shop'
  ELSE 'member'
END`;

/**
 * Pair the two sides of internal transfers by payment id.
 *
 * A row whose own fields resolved nothing (`category = 'unknown'`, no counterparty) takes its
 * category from the other side's row ({@link PAIRED_CATEGORY}) and that row's account as
 * counterparty. Only a payment id held by exactly two rows counts, of opposite direction and
 * different accounts, and only when the other side's category is not `unknown`. A resolved row
 * is never changed. `updated_at` moves forward to `$1` at most; the staleness watermark
 * `last_observed_at` keeps its value (pinned from `updated_at` for rows written before the
 * column existed). Scoped, the statement touches payment id `$2` only; unscoped, every eligible
 * row (the boot repair). Returns one row per changed row.
 */
function pairFillSql(scoped: boolean): string {
  return `UPDATE wallet_payment AS t
SET category = ${PAIRED_CATEGORY},
    counterparty_account_id = s.account_id,
    updated_at = GREATEST(t.updated_at, $1::timestamptz),
    last_observed_at = COALESCE(t.last_observed_at, t.updated_at)
FROM wallet_payment AS s
JOIN account AS a ON a.id = s.account_id
WHERE ${scoped ? 't.payment_id = $2 AND ' : ''}s.payment_id = t.payment_id
  AND s.account_id <> t.account_id
  AND s.direction <> t.direction
  AND t.category = 'unknown'
  AND t.counterparty_account_id IS NULL
  AND s.category <> 'unknown'
  AND (SELECT count(*) FROM wallet_payment AS c WHERE c.payment_id = t.payment_id) = 2
RETURNING t.account_id`;
}

/** Pairing of one payment id, run after each upserted row. */
const PAIR_FILL_ONE_SQL = pairFillSql(true);

/**
 * Fill every unresolved `wallet_payment` row from the resolved other side of its transfer
 * (the pairing of `upsertPayments`, over the whole table), for rows stored before pairing existed.
 *
 * Idempotent: a filled row is resolved, so a second run changes nothing. Runs after
 * `migrateDbChangeSchema`, so `trg_db_change` logs every changed row.
 *
 * @param sql - Parameter-bound SQL client for a migrated database.
 * @param now - Time written to `updated_at` of each changed row (never moved backwards).
 * @returns How many rows this run changed.
 * @throws Propagates SQL failures.
 */
export async function repairWalletPaymentPairs(sql: SqlClient, now: Date): Promise<number> {
  const changed = await sql.query<{ account_id: string }>(pairFillSql(false), [now]);
  return changed.length;
}

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
   * Upsert each payment with one ordered statement and a no-op update guard, then pair the
   * two sides of its payment id (see {@link WalletStore.upsertPayments}).
   *
   * @param rows - Classified payment observations.
   */
  async upsertPayments(rows: readonly WalletPaymentRecord[]): Promise<void> {
    // Distinct payments are written UPSERT_CONCURRENCY at a time; a key repeated in one call keeps its order.
    const byKey = new Map<string, WalletPaymentRecord[]>();
    for (const row of rows) {
      const key = `${row.accountId}\u0000${row.paymentId}`;
      byKey.set(key, [...(byKey.get(key) ?? []), row]);
    }
    const groups = [...byKey.values()];
    for (let start = 0; start < groups.length; start += UPSERT_CONCURRENCY) {
      await Promise.all(
        groups.slice(start, start + UPSERT_CONCURRENCY).map(async (group) => {
          for (const row of group) {
            await this.upsertPayment(row);
            // Runs after the row's own statement committed, so of two concurrent reports of the
            // same transfer at least the later one sees both rows.
            await this.sql.execute(PAIR_FILL_ONE_SQL, [row.updatedAt, row.paymentId]);
          }
        }),
      );
    }
  }

  /** Upsert one payment row with the guarded conflict update. */
  private async upsertPayment(row: WalletPaymentRecord): Promise<void> {
    await this.sql.execute(
      `INSERT INTO wallet_payment (${PAYMENT_COLUMNS}, last_observed_at)
VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$17)
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
category = CASE WHEN ${KEEP_RESOLVED_CATEGORY} THEN wallet_payment.category ELSE EXCLUDED.category END,
counterparty_account_id = CASE WHEN ${KEEP_RESOLVED_CATEGORY} THEN wallet_payment.counterparty_account_id ELSE EXCLUDED.counterparty_account_id END,
updated_at = CASE WHEN ${PAYMENT_VALUES_CHANGE} THEN EXCLUDED.updated_at ELSE wallet_payment.updated_at END,
last_observed_at = EXCLUDED.last_observed_at
WHERE EXCLUDED.last_observed_at >= ${OBSERVED_WATERMARK}
  AND (${PAYMENT_VALUES_CHANGE} OR EXCLUDED.last_observed_at > ${OBSERVED_WATERMARK})`,
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
   * Read the last snapshot of every account and UTC day in one query.
   *
   * The existing `(account_id, received_at DESC, id DESC)` index supplies the
   * account and received-time order. The derived day can still need a sort, but
   * the query returns only one row per account and day, never the whole table.
   *
   * @returns Mapped snapshots, at most one per account and UTC day.
   */
  async dailyBalances(): Promise<WalletBalanceSnapshot[]> {
    const rows = await this.sql.query<WalletBalanceSqlRow>(
      `SELECT DISTINCT ON (account_id, ((received_at AT TIME ZONE 'UTC')::date))
id, account_id, balance_sats, synced_at, received_at
FROM wallet_balance_snapshot
ORDER BY account_id, ((received_at AT TIME ZONE 'UTC')::date), received_at DESC, id DESC`,
    );
    return rows.map(mapBalance);
  }

  /**
   * Aggregate completed payments by direction in one grouped query.
   *
   * @param accountId - Reporting account id (`$1`).
   * @returns Incoming and outgoing totals in whole sats.
   */
  async paymentTotals(accountId: string): Promise<WalletPaymentTotals> {
    const rows = await this.sql.query<WalletPaymentTotalsSqlRow>(
      `SELECT direction,
       COALESCE(SUM(amount_sats), 0)::bigint AS amount_sats,
       COALESCE(SUM(fee_sats), 0)::bigint AS fee_sats
FROM wallet_payment
WHERE account_id = $1 AND status = 'completed'
GROUP BY direction`,
      [accountId],
    );
    const totals: WalletPaymentTotals = { receivedSats: 0n, paidOutSats: 0n, feesSats: 0n };
    for (const row of rows) {
      if (row.direction === 'in') {
        totals.receivedSats = BigInt(row.amount_sats ?? 0);
      } else if (row.direction === 'out') {
        totals.paidOutSats = BigInt(row.amount_sats ?? 0);
        totals.feesSats = BigInt(row.fee_sats ?? 0);
      }
    }
    return totals;
  }

  /**
   * Read newest payments for an account.
   *
   * @param accountId - Reporting account id (`$1`).
   * @param limit - Maximum rows (`$2`).
   * @param after - Optional keyset position after the last row of the previous page.
   * @param status - Restrict to one stored status. Omitted lists every status.
   * @returns Mapped payment rows.
   */
  async listPayments(
    accountId: string,
    limit: number,
    after?: WalletPaymentCursor,
    status?: WalletPaymentStatus,
  ): Promise<WalletPaymentRecord[]> {
    const keyset =
      after === undefined
        ? ''
        : ' AND (paid_at < $3 OR (paid_at = $3 AND payment_id COLLATE "C" < $4))';
    const params: unknown[] = [accountId, limit];
    if (after !== undefined) {
      params.push(after.paidAt, after.paymentId);
    }
    const statusFilter = status === undefined ? '' : ` AND status = $${params.length + 1}`;
    if (status !== undefined) {
      params.push(status);
    }
    const rows = await this.sql.query<WalletPaymentSqlRow>(
      `SELECT ${PAYMENT_COLUMNS}
FROM wallet_payment
WHERE account_id = $1${keyset}${statusFilter}
ORDER BY paid_at DESC, payment_id COLLATE "C" DESC
LIMIT $2`,
      params,
    );
    return rows.map(mapPayment);
  }
}
