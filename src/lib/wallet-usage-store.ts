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
   * A transfer pair is already merged. Unrelated completed rows that share a
   * `payment_id` but do not form a pair stay separate.
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

/**
 * Merged payment plus the hash and invoice a forum-gift match needs in memory.
 * An explicit `isForumGift` wins; otherwise the store derives it.
 */
interface MemoryPaymentRow extends Omit<WalletUsagePaymentRow, 'isForumGift'> {
  /** Forum-gift flag. Omitted means the store derives it. */
  isForumGift?: boolean;
  /** `wallet_payment.payment_hash`, or null. */
  paymentHash?: string | null;
  /** `wallet_payment.invoice`, or null. */
  invoice?: string | null;
  /** `wallet_payment.destination`, or null. */
  destination?: string | null;
}

/**
 * A seeded forum invoice that can make a payment a forum gift or paid heart,
 * or exclude a zap receipt with the same hash.
 */
interface MemoryForumInvoice {
  /** `message_invoice.payment_hash`, any case, or null. */
  paymentHash: string | null;
  /** `message_invoice.pr` (the BOLT11 the payer paid), or null. */
  pr: string | null;
  /** True when `conversation_id` is set. */
  conversation: boolean;
  /** True when `description` starts with `repay:` or `repayp:`. */
  repayment: boolean;
  /** True when the invoice's note has `message.deleted_at` set. */
  hidden: boolean;
  /** True when `nostr_zap_payment` has claimed `paymentHash`. */
  claimed: boolean;
}

/**
 * A claimed zap receipt gift or paid heart: its hash and its note's hidden
 * state.
 */
interface MemoryZapGift {
  /** Claimed payment hash, any case. */
  paymentHash: string;
  /** True when the receipt's note has `message.deleted_at` set. */
  hidden: boolean;
}

/** Optional rows for {@link InMemoryWalletUsageStore}. */
interface WalletUsageSeed {
  /** Completed payments. */
  payments: readonly MemoryPaymentRow[];
  /** Successful forum invoices. */
  forumInvoices: readonly WalletUsageForumRow[];
  /** Point-of-sale charges. */
  shopCharges: readonly WalletUsageChargeRow[];
  /** Seeded forum invoices that can mark or exclude a payment. Default none. */
  forumGiftInvoices?: readonly MemoryForumInvoice[];
  /** Claimed zap receipt gifts. Default none. */
  zapGifts?: readonly MemoryZapGift[];
  /** `spark_invoice.invoice` to `spark_invoice.payment_hash`. Default none. */
  sparkInvoiceHashes?: ReadonlyMap<string, string>;
}

/**
 * Process-local usage reads for a boot without `DATABASE_URL`, and for tests.
 * The default seed is empty. `isForumGift` is derived from the seed's claimed
 * forum invoices, zap gifts, and `sparkInvoiceHashes` with the same rule as the
 * Postgres statement.
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
    const invoices = seed.forumGiftInvoices ?? [];
    const gifts = seed.zapGifts ?? [];
    const sparkInvoiceHashes = seed.sparkInvoiceHashes ?? new Map<string, string>();
    this.#payments = seed.payments.map((row) =>
      copyPayment({
        ...row,
        isForumGift: row.isForumGift ?? memoryIsForumGift(row, invoices, gifts, sparkInvoiceHashes),
      }),
    );
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
  is_forum_gift: boolean | null;
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
 * A completed group uses `'pair:' || payment_id` only when that id has exactly
 * two completed rows, the id has exactly two rows overall, and the directions
 * and accounts differ, matching `pairFillSql` in `wallet-store.ts`. Every other
 * completed row is keyed by
 * `'row:' || account_id::text || ':' || payment_id`, so unrelated rows do not
 * merge just because they share an id. The `pair:` and `row:` prefixes keep the
 * two namespaces apart, and the unpaired key includes the account's UUID, so a
 * paired id that begins with `row:` cannot collide with an unpaired row. The
 * key stays inside this statement and never reaches the response.
 *
 * `spark_invoice` maps a Spark invoice text to the zap payment hash it settles.
 * A row's candidate hashes are its own `payment_hash` plus every
 * `spark_invoice.payment_hash` whose `invoice` equals the row's `invoice` or
 * `destination`, all lowercased.
 *
 * `is_forum_gift` is a paid forum gift or paid heart: a claimed, successful
 * invoice with no conversation and no `repay:` / `repayp:` description, on a
 * note whose `deleted_at` is null, matching a candidate hash or any row's
 * `invoice`; or a claimed zap receipt gift or paid heart on such a note,
 * unless a conversation or repayment invoice owns a candidate hash.
 * `wallet_payment.category` alone is not enough, because it also covers
 * conversation invoices and credit repayments. A `gift` or `platform` category
 * does not decide the flag, and the counterparty may be any account: the
 * claimed living-note invoice or zap receipt decides it.
 */
const PAYMENTS_SQL = `WITH id_totals AS (
  SELECT payment_id,
         count(*) AS row_count,
         count(*) FILTER (WHERE status = 'completed') AS completed_count,
         count(DISTINCT account_id) FILTER (WHERE status = 'completed') AS completed_account_count,
         count(DISTINCT direction) FILTER (WHERE status = 'completed') AS completed_direction_count
  FROM wallet_payment
  GROUP BY payment_id
),
completed AS (
  SELECT wallet_payment.payment_id,
         wallet_payment.account_id,
         wallet_payment.direction,
         wallet_payment.amount_sats,
         wallet_payment.fee_sats,
         wallet_payment.paid_at,
         category,
         counterparty_account_id,
         payment_hash,
         invoice,
         destination,
         CASE
           WHEN id_totals.row_count = 2
             AND id_totals.completed_count = 2
             AND id_totals.completed_account_count = 2
             AND id_totals.completed_direction_count = 2
             THEN 'pair:' || wallet_payment.payment_id
           ELSE 'row:' || wallet_payment.account_id::text || ':' || wallet_payment.payment_id
         END AS group_key
  FROM wallet_payment
  JOIN id_totals ON id_totals.payment_id = wallet_payment.payment_id
  WHERE wallet_payment.status = 'completed'
),
candidate_hashes AS (
  SELECT group_key, lower(payment_hash) AS payment_hash
  FROM completed
  WHERE payment_hash IS NOT NULL
  UNION
  SELECT completed.group_key, lower(spark_invoice.payment_hash)
  FROM completed
  JOIN spark_invoice
    ON spark_invoice.invoice = completed.invoice
    OR spark_invoice.invoice = completed.destination
),
bounds AS (
  SELECT group_key,
         min(paid_at) AS paid_at,
         max(amount_sats)::bigint AS amount_sats,
         sum(coalesce(fee_sats, 0))::bigint AS fee_sats
  FROM completed
  GROUP BY group_key
  HAVING min(paid_at) >= $1
),
outs AS (
  SELECT DISTINCT ON (group_key)
         group_key,
         account_id AS payer_account_id,
         category AS out_category,
         counterparty_account_id
  FROM completed
  WHERE direction = 'out'
  ORDER BY group_key, account_id
),
ins AS (
  SELECT DISTINCT ON (group_key)
         group_key,
         account_id AS payee_account_id
  FROM completed
  WHERE direction = 'in'
  ORDER BY group_key, account_id
),
fallback_category AS (
  SELECT DISTINCT ON (group_key)
         group_key,
         category AS fallback_category
  FROM completed
  WHERE category <> 'unknown'
  ORDER BY group_key, CASE WHEN direction = 'out' THEN 0 ELSE 1 END, account_id
),
fund_hits AS (
  SELECT DISTINCT completed.group_key
  FROM completed
  JOIN fond_payout
    ON fond_payout.status = 'paid'
   AND completed.invoice IS NOT NULL
   AND completed.invoice <> ''
   AND (fond_payout.bolt11 = completed.invoice
        OR fond_payout.spark_invoice = completed.invoice)
),
forum_gifts AS (
  SELECT DISTINCT completed.group_key
  FROM completed
  LEFT JOIN candidate_hashes ON candidate_hashes.group_key = completed.group_key
  JOIN message_invoice invoice
    ON invoice.result = 'ok'
   AND invoice.conversation_id IS NULL
   AND coalesce(invoice.description, '') NOT LIKE 'repay:%'
   AND coalesce(invoice.description, '') NOT LIKE 'repayp:%'
   AND (
     (invoice.payment_hash IS NOT NULL
      AND lower(invoice.payment_hash) = candidate_hashes.payment_hash)
     OR (completed.invoice IS NOT NULL
         AND invoice.pr IS NOT NULL
         AND invoice.pr = completed.invoice)
   )
  JOIN message note ON note.id = invoice.message_id AND note.deleted_at IS NULL
  WHERE EXISTS (
    SELECT 1 FROM nostr_zap_payment z
    WHERE z.payment_hash = lower(invoice.payment_hash)
  )
  UNION
  SELECT DISTINCT completed.group_key
  FROM completed
  LEFT JOIN candidate_hashes ON candidate_hashes.group_key = completed.group_key
  JOIN nostr_zap_payment z
    ON z.payment_hash = candidate_hashes.payment_hash
  JOIN nostr_zap_receipt receipt ON receipt.event_id = z.receipt_event_id
  JOIN message note ON note.id = receipt.message_id AND note.deleted_at IS NULL
  WHERE NOT EXISTS (
    SELECT 1
    FROM message_invoice other_invoice
    WHERE other_invoice.result = 'ok'
      AND other_invoice.payment_hash IS NOT NULL
      AND lower(other_invoice.payment_hash) = candidate_hashes.payment_hash
      AND (
        other_invoice.conversation_id IS NOT NULL
        OR coalesce(other_invoice.description, '') LIKE 'repay:%'
        OR coalesce(other_invoice.description, '') LIKE 'repayp:%'
      )
  )
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
       (fund_hits.group_key IS NOT NULL) AS is_fund_payout,
       (forum_gifts.group_key IS NOT NULL) AS is_forum_gift
FROM bounds
LEFT JOIN outs ON outs.group_key = bounds.group_key
LEFT JOIN ins ON ins.group_key = bounds.group_key
LEFT JOIN fallback_category ON fallback_category.group_key = bounds.group_key
LEFT JOIN fund_hits ON fund_hits.group_key = bounds.group_key
LEFT JOIN forum_gifts ON forum_gifts.group_key = bounds.group_key
LEFT JOIN account payer ON payer.id = outs.payer_account_id
LEFT JOIN account payee
  ON payee.id = COALESCE(ins.payee_account_id, outs.counterparty_account_id)`;

/**
 * Paid forum gifts and hearts on or after `$1`.
 *
 * A mint writes `result = 'ok'` before anyone pays, so a row counts only when
 * `nostr_zap_payment` has claimed the hash. The claim matches
 * `PostgresMessageStore.heartSenders`: the stored hash equals
 * `lower(message_invoice.payment_hash)`. Conversation invoices and credit
 * repayments (`repay:` / `repayp:`) stay out. The invoice's note must also be
 * living (`message.deleted_at IS NULL`), joined through
 * `message_invoice.message_id = message.id`; a gift or heart on a note hidden
 * by staff is not public application data.
 */
const FORUM_SQL = `SELECT invoice.created_at, invoice.amount_sats, COALESCE(invoice.heart, false) AS heart
FROM message_invoice invoice
JOIN message note ON note.id = invoice.message_id AND note.deleted_at IS NULL
WHERE invoice.result = 'ok'
  AND invoice.conversation_id IS NULL
  AND coalesce(invoice.description, '') NOT LIKE 'repay:%'
  AND coalesce(invoice.description, '') NOT LIKE 'repayp:%'
  AND invoice.created_at >= $1
  AND EXISTS (
    SELECT 1 FROM nostr_zap_payment z
    WHERE z.payment_hash = lower(invoice.payment_hash)
  )`;

const CHARGES_SQL = `SELECT created_at, status
FROM pos_charge
WHERE created_at >= $1`;

/**
 * Postgres reads for `GET /wallets/usage`.
 * One statement per method. The constructor does not query. Reads
 * `wallet_payment`, `account`, `spark_invoice`, `fond_payout`,
 * `message_invoice`, `message`, `nostr_zap_payment`, `nostr_zap_receipt`, and
 * `pos_charge`; it does not write or migrate.
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
   * Read paid forum gifts and hearts created on or after `sinceMs`.
   *
   * Conversation invoices, credit repayments, and unpaid mints are omitted.
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

function copyPayment(row: MemoryPaymentRow): WalletUsagePaymentRow {
  return {
    paidAt: new Date(row.paidAt.getTime()),
    amountSats: row.amountSats,
    feeSats: row.feeSats,
    category: row.category,
    payerAccountId: row.payerAccountId,
    payeeAccountId: row.payeeAccountId,
    payerParty: row.payerParty,
    payeeParty: row.payeeParty,
    isFundPayout: row.isFundPayout,
    isForumGift: row.isForumGift === true,
  };
}

/**
 * Same forum-gift rule as the Postgres `forum_gifts` CTE, over seeded rows.
 *
 * A payment is a forum gift when a claimed, successful, non-conversation,
 * non-repayment invoice on a living note matches one of its candidate hashes
 * or its invoice; or when a claimed zap receipt gift or paid heart on a living
 * note matches one of its candidate hashes and no seeded conversation or
 * repayment invoice owns that hash, compared case-insensitively. A candidate
 * hash is the row's own `payment_hash`, plus every `sparkInvoiceHashes` value
 * for a Spark invoice equal to the row's `invoice` or `destination`.
 *
 * @param row - Merged payment with its optional `paymentHash`, `invoice`, and
 *   `destination` details.
 * @param invoices - Seeded `message_invoice` rows that can make or exclude a
 *   forum gift.
 * @param gifts - Seeded claimed zap receipt gifts.
 * @param sparkInvoiceHashes - Stored Spark invoice text to the zap payment hash
 *   it settles. Lookups use the invoice text exactly as stored.
 * @returns `true` for a paid forum gift or paid heart.
 */
function memoryIsForumGift(
  row: MemoryPaymentRow,
  invoices: readonly MemoryForumInvoice[],
  gifts: readonly MemoryZapGift[],
  sparkInvoiceHashes: ReadonlyMap<string, string>,
): boolean {
  const hashes = new Set<string>();
  if (row.paymentHash !== null && row.paymentHash !== undefined) {
    hashes.add(row.paymentHash.toLowerCase());
  }
  const invoice = row.invoice ?? null;
  for (const sparkInvoice of [invoice, row.destination ?? null]) {
    if (sparkInvoice === null) {
      continue;
    }
    const sparkHash = sparkInvoiceHashes.get(sparkInvoice);
    if (sparkHash !== undefined) {
      hashes.add(sparkHash.toLowerCase());
    }
  }
  const giftInvoice = invoices.some((candidate) => {
    if (candidate.conversation || candidate.repayment || candidate.hidden) {
      return false;
    }
    if (!candidate.claimed) {
      return false;
    }
    const hash = candidate.paymentHash === null ? null : candidate.paymentHash.toLowerCase();
    if (hash !== null && hashes.has(hash)) {
      return true;
    }
    return candidate.pr !== null && invoice !== null && candidate.pr === invoice;
  });
  if (giftInvoice) {
    return true;
  }
  const ownedByConversationOrRepayment = invoices.some(
    (candidate) =>
      candidate.paymentHash !== null &&
      (candidate.conversation || candidate.repayment) &&
      hashes.has(candidate.paymentHash.toLowerCase()),
  );
  return (
    !ownedByConversationOrRepayment &&
    gifts.some((gift) => !gift.hidden && hashes.has(gift.paymentHash.toLowerCase()))
  );
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
  if (row.is_forum_gift !== true && row.is_forum_gift !== false) {
    throw new Error('wallet usage forum gift flag is invalid');
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
    isForumGift: row.is_forum_gift,
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
