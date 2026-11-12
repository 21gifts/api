/**
 * Read side of the public wallet-usage aggregates.
 * Account ids stay on the rows the builder counts. They are not part of the
 * HTTP body.
 */

import type { SqlClient } from '@/lib/auth/sql';
import type {
  WalletUsageChargeRow,
  WalletUsageForumRow,
  WalletUsageParty,
  WalletUsagePaymentRow,
} from '@/lib/wallet-usage';

/** Rows {@link buildWalletUsage} needs. Account ids never leave the builder. */
export interface WalletUsageStore {
  /**
   * Completed payments whose earliest `paid_at` is on or after `sinceMs`.
   *
   * Both wallet sides of one `payment_id` are already merged.
   *
   * @param sinceMs - Inclusive lower bound, epoch milliseconds.
   * @returns Merged payments. Order is not significant.
   */
  payments(sinceMs: number): Promise<WalletUsagePaymentRow[]>;
  /**
   * Successful forum invoices (`result = 'ok'`) created on or after `sinceMs`.
   *
   * @param sinceMs - Inclusive lower bound, epoch milliseconds.
   * @returns Invoice rows. A null `heart` is false. Order is not significant.
   */
  forumInvoices(sinceMs: number): Promise<WalletUsageForumRow[]>;
  /**
   * Point-of-sale charges created on or after `sinceMs`.
   *
   * @param sinceMs - Inclusive lower bound, epoch milliseconds.
   * @returns Charge rows. Order is not significant.
   */
  shopCharges(sinceMs: number): Promise<WalletUsageChargeRow[]>;
}

/** Optional rows for {@link InMemoryWalletUsageStore}. */
interface WalletUsageSeed {
  /** Completed payments. */
  payments: readonly WalletUsagePaymentRow[];
  /** Successful forum invoices. */
  forumInvoices: readonly WalletUsageForumRow[];
  /** Point-of-sale charges. */
  shopCharges: readonly WalletUsageChargeRow[];
}

/**
 * Process-local usage reads for a boot without `DATABASE_URL`, and for tests.
 * The default seed is empty.
 */
export class InMemoryWalletUsageStore implements WalletUsageStore {
  readonly #payments: WalletUsagePaymentRow[];
  readonly #forumInvoices: WalletUsageForumRow[];
  readonly #shopCharges: WalletUsageChargeRow[];

  /**
   * @param seed - Rows to keep. Omitted means every read returns an empty list.
   */
  constructor(seed?: WalletUsageSeed) {
    if (seed === undefined) {
      this.#payments = [];
      this.#forumInvoices = [];
      this.#shopCharges = [];
      return;
    }
    this.#payments = seed.payments.map(copyPayment);
    this.#forumInvoices = seed.forumInvoices.map(copyForum);
    this.#shopCharges = seed.shopCharges.map(copyCharge);
  }

  /**
   * Payments with `paidAt` on or after `sinceMs`, as copies.
   *
   * @param sinceMs - Inclusive lower bound, epoch milliseconds.
   * @returns A new array. Mutating a returned `Date` does not change the store.
   */
  payments(sinceMs: number): Promise<WalletUsagePaymentRow[]> {
    return Promise.resolve(
      this.#payments.filter((row) => row.paidAt.getTime() >= sinceMs).map(copyPayment),
    );
  }

  /**
   * Forum invoices with `createdAt` on or after `sinceMs`, as copies.
   *
   * @param sinceMs - Inclusive lower bound, epoch milliseconds.
   * @returns A new array. Mutating a returned `Date` does not change the store.
   */
  forumInvoices(sinceMs: number): Promise<WalletUsageForumRow[]> {
    return Promise.resolve(
      this.#forumInvoices.filter((row) => row.createdAt.getTime() >= sinceMs).map(copyForum),
    );
  }

  /**
   * Charges with `createdAt` on or after `sinceMs`, as copies.
   *
   * @param sinceMs - Inclusive lower bound, epoch milliseconds.
   * @returns A new array. Mutating a returned `Date` does not change the store.
   */
  shopCharges(sinceMs: number): Promise<WalletUsageChargeRow[]> {
    return Promise.resolve(
      this.#shopCharges.filter((row) => row.createdAt.getTime() >= sinceMs).map(copyCharge),
    );
  }
}

interface PaymentSqlRow {
  paid_at: Date | string;
  amount_sats: number | string | bigint | null;
  fee_sats: number | string | bigint | null;
  category: unknown;
  payer_account_id: string | null;
  payee_account_id: string | null;
  payer_party: string;
  payee_party: string;
  is_fund_payout: boolean | null;
}

interface ForumSqlRow {
  created_at: Date | string;
  amount_sats: number | string | bigint | null;
  heart: boolean | null;
}

interface ChargeSqlRow {
  created_at: Date | string;
  status: unknown;
}

/**
 * One grouped read of completed `wallet_payment` rows.
 *
 * A row filter on `paid_at` would split a payment whose sides fall on either
 * side of the bound, so the bound is `min(paid_at)` of the whole group.
 */
const PAYMENTS_SQL = `WITH completed AS (
  SELECT payment_id, account_id, direction, amount_sats, fee_sats, paid_at,
         category, counterparty_account_id, invoice
  FROM wallet_payment
  WHERE status = 'completed'
),
bounds AS (
  SELECT payment_id,
         min(paid_at) AS paid_at,
         max(amount_sats)::bigint AS amount_sats,
         sum(coalesce(fee_sats, 0))::bigint AS fee_sats
  FROM completed
  GROUP BY payment_id
  HAVING min(paid_at) >= $1
),
outs AS (
  SELECT DISTINCT ON (payment_id)
         payment_id,
         account_id AS payer_account_id,
         category AS out_category,
         counterparty_account_id
  FROM completed
  WHERE direction = 'out'
  ORDER BY payment_id, account_id
),
ins AS (
  SELECT DISTINCT ON (payment_id)
         payment_id,
         account_id AS payee_account_id
  FROM completed
  WHERE direction = 'in'
  ORDER BY payment_id, account_id
),
fallback_category AS (
  SELECT DISTINCT ON (payment_id)
         payment_id,
         category AS fallback_category
  FROM completed
  WHERE category <> 'unknown'
  ORDER BY payment_id, CASE WHEN direction = 'out' THEN 0 ELSE 1 END, account_id
),
fund_hits AS (
  SELECT DISTINCT completed.payment_id
  FROM completed
  JOIN fond_payout
    ON fond_payout.status = 'paid'
   AND completed.invoice IS NOT NULL
   AND completed.invoice <> ''
   AND (fond_payout.bolt11 = completed.invoice
        OR fond_payout.spark_invoice = completed.invoice)
)
SELECT bounds.paid_at,
       bounds.amount_sats,
       bounds.fee_sats,
       CASE
         WHEN outs.out_category IS NOT NULL AND outs.out_category <> 'unknown'
           THEN outs.out_category
         WHEN fallback_category.fallback_category IS NOT NULL
           THEN fallback_category.fallback_category
         ELSE 'unknown'
       END AS category,
       outs.payer_account_id,
       COALESCE(ins.payee_account_id, outs.counterparty_account_id) AS payee_account_id,
       CASE
         WHEN outs.payer_account_id IS NULL THEN 'outside'
         WHEN payer.is_platform THEN 'platform'
         WHEN payer.role = 'fond' THEN 'fund'
         ELSE 'members'
       END AS payer_party,
       CASE
         WHEN COALESCE(ins.payee_account_id, outs.counterparty_account_id) IS NULL
           THEN 'outside'
         WHEN payee.is_platform THEN 'platform'
         WHEN payee.role = 'fond' THEN 'fund'
         ELSE 'members'
       END AS payee_party,
       (fund_hits.payment_id IS NOT NULL) AS is_fund_payout
FROM bounds
LEFT JOIN outs ON outs.payment_id = bounds.payment_id
LEFT JOIN ins ON ins.payment_id = bounds.payment_id
LEFT JOIN fallback_category ON fallback_category.payment_id = bounds.payment_id
LEFT JOIN fund_hits ON fund_hits.payment_id = bounds.payment_id
LEFT JOIN account payer ON payer.id = outs.payer_account_id
LEFT JOIN account payee
  ON payee.id = COALESCE(ins.payee_account_id, outs.counterparty_account_id)`;

const FORUM_SQL = `SELECT created_at, amount_sats, COALESCE(heart, false) AS heart
FROM message_invoice
WHERE result = 'ok' AND created_at >= $1`;

const CHARGES_SQL = `SELECT created_at, status
FROM pos_charge
WHERE created_at >= $1`;

/**
 * Postgres reads for `GET /wallets/usage`.
 * One statement per method. The constructor does not query.
 */
export class PostgresWalletUsageStore implements WalletUsageStore {
  /**
   * @param sql - Parameter-bound SQL client. Tables already exist; this store
   *   does not migrate them.
   */
  constructor(private readonly sql: SqlClient) {}

  /**
   * Merge completed payments and keep groups whose earliest `paid_at` is on
   * or after `sinceMs`.
   *
   * @param sinceMs - Inclusive lower bound, epoch milliseconds (`$1`).
   * @returns Mapped rows. Query failures, bad parties, and unsafe amounts throw.
   */
  async payments(sinceMs: number): Promise<WalletUsagePaymentRow[]> {
    const rows = await this.sql.query<PaymentSqlRow>(PAYMENTS_SQL, [new Date(sinceMs)]);
    return rows.map(mapPayment);
  }

  /**
   * Read successful forum invoices created on or after `sinceMs`.
   *
   * @param sinceMs - Inclusive lower bound, epoch milliseconds (`$1`).
   * @returns Mapped rows. A null heart is false. Query failures throw.
   */
  async forumInvoices(sinceMs: number): Promise<WalletUsageForumRow[]> {
    const rows = await this.sql.query<ForumSqlRow>(FORUM_SQL, [new Date(sinceMs)]);
    return rows.map(mapForum);
  }

  /**
   * Read point-of-sale charges created on or after `sinceMs`.
   *
   * @param sinceMs - Inclusive lower bound, epoch milliseconds (`$1`).
   * @returns Mapped rows. Query failures throw.
   */
  async shopCharges(sinceMs: number): Promise<WalletUsageChargeRow[]> {
    const rows = await this.sql.query<ChargeSqlRow>(CHARGES_SQL, [new Date(sinceMs)]);
    return rows.map(mapCharge);
  }
}

function copyPayment(row: WalletUsagePaymentRow): WalletUsagePaymentRow {
  return { ...row, paidAt: new Date(row.paidAt.getTime()) };
}

function copyForum(row: WalletUsageForumRow): WalletUsageForumRow {
  return { ...row, createdAt: new Date(row.createdAt.getTime()) };
}

function copyCharge(row: WalletUsageChargeRow): WalletUsageChargeRow {
  return { ...row, createdAt: new Date(row.createdAt.getTime()) };
}

function sqlInstant(value: Date | string): Date {
  const date = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new Error('wallet usage time is invalid');
  }
  return date;
}

function sqlSats(value: number | string | bigint | null): number {
  if (value === null) {
    throw new Error('wallet usage sats are missing');
  }
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0) {
    throw new Error('wallet usage sats are not a safe integer');
  }
  return number;
}

function sqlText(value: unknown, label: string): string {
  if (typeof value !== 'string') {
    throw new Error(`wallet usage ${label} is invalid`);
  }
  return value;
}

function sqlAccountId(value: string | null): string | null {
  if (value === null) {
    return null;
  }
  if (typeof value !== 'string') {
    throw new Error('wallet usage account id is invalid');
  }
  return value;
}

function sqlParty(value: string): WalletUsageParty {
  if (value === 'outside' || value === 'members' || value === 'fund' || value === 'platform') {
    return value;
  }
  throw new Error('wallet usage party is invalid');
}

function mapPayment(row: PaymentSqlRow): WalletUsagePaymentRow {
  if (row.is_fund_payout !== true && row.is_fund_payout !== false) {
    throw new Error('wallet usage fund payout flag is invalid');
  }
  return {
    paidAt: sqlInstant(row.paid_at),
    amountSats: sqlSats(row.amount_sats),
    feeSats: sqlSats(row.fee_sats),
    category: sqlText(row.category, 'category'),
    payerAccountId: sqlAccountId(row.payer_account_id),
    payeeAccountId: sqlAccountId(row.payee_account_id),
    payerParty: sqlParty(row.payer_party),
    payeeParty: sqlParty(row.payee_party),
    isFundPayout: row.is_fund_payout,
  };
}

function mapForum(row: ForumSqlRow): WalletUsageForumRow {
  return {
    createdAt: sqlInstant(row.created_at),
    amountSats: sqlSats(row.amount_sats),
    heart: row.heart === true,
  };
}

function mapCharge(row: ChargeSqlRow): WalletUsageChargeRow {
  return {
    createdAt: sqlInstant(row.created_at),
    status: sqlText(row.status, 'charge status'),
  };
}
