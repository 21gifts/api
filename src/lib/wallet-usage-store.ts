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
   * A transfer pair is already merged. A completed `out` row and a completed
   * `in` row on different accounts pair when they share the same `payment_id`,
   * the same `lower(payment_hash)` (both non-null), or the same `invoice` (both
   * non-null and non-empty), and each row has exactly one such partner.
   * Unrelated completed rows that share a `payment_id` but do not form a pair
   * stay separate.
   *
   * @param sinceMs - Inclusive lower bound, epoch milliseconds.
   * @returns Merged payments. Order is not significant.
   */
  payments(sinceMs: number): Promise<WalletUsagePaymentRow[]>;
  /**
   * Successful forum invoices (`result = 'ok'`) created on or after `sinceMs`.
   * A non-heart invoice on a note authored by the platform account is the
   * compose fee and is omitted.
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
  /**
   * True when the invoice is a heart (`message_invoice.heart = true`). Default
   * false. A heart on a platform-authored note remains eligible.
   */
  heart?: boolean;
  /**
   * True when the invoice's note author is the platform account. Default false.
   * A non-heart invoice on such a note is the 1-sat compose fee: it cannot make
   * a forum gift and it excludes a zap receipt with the same hash.
   */
  platformNote?: boolean;
}

/**
 * A seeded forum-series row with the note-author detail needed to apply the
 * compose-fee exclusion in memory.
 */
interface MemoryForumRow extends WalletUsageForumRow {
  /** True when the invoice's note author is the platform account. Default false. */
  platformNote?: boolean;
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
  /**
   * Successful forum invoices. A row with `platformNote: true` is omitted from
   * {@link InMemoryWalletUsageStore.forumInvoices} unless `heart` is true.
   */
  forumInvoices: readonly MemoryForumRow[];
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
 * Postgres statement. Seeded forum-series rows with `platformNote: true` are
 * omitted unless they are hearts, matching the Postgres forum series.
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
    this.#forumInvoices = seed.forumInvoices.filter(memoryIsForumInvoice).map(copyForum);
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
   * Non-heart invoices seeded on a platform-authored note are the compose fee
   * and are not returned; hearts on that note are returned.
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
 * Filtering rows at `$1` would split a payment whose sides fall on either side
 * of the bound, so `completed_rows` reads from one day before `$1` and the
 * final bound is `min(paid_at)` of the whole group. The slack lets two sides
 * recorded just on either side of the window start pair. `bounds` still keeps
 * only groups whose earliest `paid_at` is on or after `$1`, so that slack never
 * counts a payment from before the window.
 * A completed `out` row and a completed `in` row on two different accounts form
 * one payment when they share the same `payment_id`, the same
 * `lower(payment_hash)` (both non-null), or the same `invoice` (both non-null
 * and non-empty). Each of the two rows must have exactly one such partner among
 * completed rows; an ambiguous match stays unpaired. A pair's key is
 * `'pair:' || <out row account_id> || ':' || <out row payment_id>`, which is
 * deterministic and injective because the outgoing `(account_id, payment_id)`
 * is the `wallet_payment` primary key, and it is disjoint from the `row:`
 * namespace. Every other completed row is keyed by
 * `'row:' || account_id::text || ':' || payment_id`, so unrelated rows do not
 * merge just because they share an id. The unpaired key includes the account's
 * UUID, so a payment id that begins with `row:` cannot collide with another
 * account's unpaired row. The key stays inside this statement and never reaches
 * the response.
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
 * unless a conversation or repayment invoice owns a candidate hash or a
 * non-heart invoice on a platform-authored note owns it. A non-heart invoice
 * on a note authored by the official platform account is never a forum gift;
 * that is the 1-sat compose fee, a platform payment. A heart invoice on that
 * note still qualifies. `wallet_payment.category` alone is not enough, because
 * it also covers conversation invoices and credit repayments. A `gift` or
 * `platform` category does not decide the flag, and the counterparty may be
 * any account: the claimed living-note invoice or zap receipt decides it.
 */
const PAYMENTS_SQL = `WITH completed_rows AS (
  SELECT wallet_payment.account_id,
         wallet_payment.payment_id,
         wallet_payment.direction,
         wallet_payment.amount_sats,
         wallet_payment.fee_sats,
         wallet_payment.paid_at,
         wallet_payment.category,
         wallet_payment.counterparty_account_id,
         wallet_payment.payment_hash,
         wallet_payment.invoice,
         wallet_payment.destination
  FROM wallet_payment
  WHERE wallet_payment.status = 'completed'
    AND wallet_payment.paid_at >= $1::timestamptz - interval '1 day'
),
pair_matches AS (
  SELECT out_row.account_id AS out_account_id,
         out_row.payment_id AS out_payment_id,
         in_row.account_id AS in_account_id,
         in_row.payment_id AS in_payment_id
  FROM completed_rows out_row
  JOIN completed_rows in_row
    ON out_row.direction = 'out'
   AND in_row.direction = 'in'
   AND out_row.account_id <> in_row.account_id
   AND out_row.payment_id = in_row.payment_id
  UNION
  SELECT out_row.account_id AS out_account_id,
         out_row.payment_id AS out_payment_id,
         in_row.account_id AS in_account_id,
         in_row.payment_id AS in_payment_id
  FROM completed_rows out_row
  JOIN completed_rows in_row
    ON out_row.direction = 'out'
   AND in_row.direction = 'in'
   AND out_row.account_id <> in_row.account_id
   AND out_row.payment_hash IS NOT NULL
   AND in_row.payment_hash IS NOT NULL
   AND lower(out_row.payment_hash) = lower(in_row.payment_hash)
  UNION
  SELECT out_row.account_id AS out_account_id,
         out_row.payment_id AS out_payment_id,
         in_row.account_id AS in_account_id,
         in_row.payment_id AS in_payment_id
  FROM completed_rows out_row
  JOIN completed_rows in_row
    ON out_row.direction = 'out'
   AND in_row.direction = 'in'
   AND out_row.account_id <> in_row.account_id
   AND out_row.invoice IS NOT NULL
   AND out_row.invoice <> ''
   AND in_row.invoice IS NOT NULL
   AND in_row.invoice <> ''
   AND out_row.invoice = in_row.invoice
),
unique_pairs AS (
  SELECT out_account_id,
         out_payment_id,
         in_account_id,
         in_payment_id
  FROM (
    SELECT pair_matches.*,
           count(*) OVER (PARTITION BY out_account_id, out_payment_id) AS out_match_count,
           count(*) OVER (PARTITION BY in_account_id, in_payment_id) AS in_match_count
    FROM pair_matches
  ) counted
  WHERE out_match_count = 1
    AND in_match_count = 1
),
completed AS (
  SELECT completed_rows.account_id,
         completed_rows.payment_id,
         completed_rows.direction,
         completed_rows.amount_sats,
         completed_rows.fee_sats,
         completed_rows.paid_at,
         completed_rows.category,
         completed_rows.counterparty_account_id,
         completed_rows.payment_hash,
         completed_rows.invoice,
         completed_rows.destination,
         CASE
           WHEN out_pair.out_account_id IS NOT NULL
             THEN 'pair:' || out_pair.out_account_id::text || ':' || out_pair.out_payment_id
           WHEN in_pair.out_account_id IS NOT NULL
             THEN 'pair:' || in_pair.out_account_id::text || ':' || in_pair.out_payment_id
           ELSE 'row:' || completed_rows.account_id::text || ':' || completed_rows.payment_id
         END AS group_key
  FROM completed_rows
  LEFT JOIN unique_pairs out_pair
    ON out_pair.out_account_id = completed_rows.account_id
   AND out_pair.out_payment_id = completed_rows.payment_id
  LEFT JOIN unique_pairs in_pair
    ON in_pair.in_account_id = completed_rows.account_id
   AND in_pair.in_payment_id = completed_rows.payment_id
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
  LEFT JOIN account author ON author.id = note.account_id
  WHERE EXISTS (
    SELECT 1 FROM nostr_zap_payment z
    WHERE z.payment_hash = lower(invoice.payment_hash)
  )
  AND (invoice.heart IS TRUE OR coalesce(author.is_platform, false) = false)
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
    FROM message_invoice platform_fee
    JOIN message platform_note ON platform_note.id = platform_fee.message_id
    LEFT JOIN account platform_author ON platform_author.id = platform_note.account_id
    WHERE platform_fee.result = 'ok'
      AND platform_fee.heart IS NOT TRUE
      AND platform_fee.payment_hash IS NOT NULL
      AND lower(platform_fee.payment_hash) = candidate_hashes.payment_hash
      AND platform_author.is_platform = true
  )
  AND NOT EXISTS (
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
 * A non-heart invoice whose note is authored by the platform account is the
 * 1-sat compose fee, not a forum gift; a heart on that note still follows the
 * heart rule.
 */
const FORUM_SQL = `SELECT invoice.created_at, invoice.amount_sats, COALESCE(invoice.heart, false) AS heart
FROM message_invoice invoice
JOIN message note ON note.id = invoice.message_id AND note.deleted_at IS NULL
LEFT JOIN account author ON author.id = note.account_id
WHERE invoice.result = 'ok'
  AND invoice.conversation_id IS NULL
  AND coalesce(invoice.description, '') NOT LIKE 'repay:%'
  AND coalesce(invoice.description, '') NOT LIKE 'repayp:%'
  AND (invoice.heart IS TRUE OR coalesce(author.is_platform, false) = false)
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
   * Rows from one day before `sinceMs` are read only so that a pair whose two
   * sides straddle the bound can be recognised. A group with a side before
   * `sinceMs` is still omitted, because its earliest `paid_at` is before the
   * bound.
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
   * Conversation invoices, credit repayments, unpaid mints, and non-heart
   * invoices on notes authored by the platform account are omitted. Such a
   * non-heart invoice is the compose fee; a heart on that note still counts.
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
 * or its invoice; a non-heart invoice on a note authored by the platform
 * account is the compose fee and does not qualify. A heart on such a note
 * still does. The rule also accepts a claimed zap receipt gift or paid heart
 * on a living note matching a candidate hash, unless a seeded conversation or
 * repayment invoice owns that hash, or a non-heart invoice on a
 * platform-authored note owns it, compared case-insensitively. A candidate
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
    if (!candidate.claimed || (candidate.platformNote === true && candidate.heart !== true)) {
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
  return gifts.some((gift) => {
    const hash = gift.paymentHash.toLowerCase();
    if (gift.hidden || !hashes.has(hash)) {
      return false;
    }
    if (
      invoices.some(
        (candidate) =>
          candidate.paymentHash !== null &&
          candidate.platformNote === true &&
          candidate.heart !== true &&
          candidate.paymentHash.toLowerCase() === hash,
      )
    ) {
      return false;
    }
    return !invoices.some(
      (candidate) =>
        candidate.paymentHash !== null &&
        (candidate.conversation || candidate.repayment) &&
        candidate.paymentHash.toLowerCase() === hash,
    );
  });
}

/**
 * Whether a seeded forum-series row belongs in the public forum series.
 *
 * A non-heart invoice on a platform-authored note is the compose fee. A heart
 * on that note stays eligible, matching `FORUM_SQL`.
 *
 * @param row - Seeded successful forum invoice.
 * @returns `false` only for a non-heart platform-note invoice.
 */
function memoryIsForumInvoice(row: MemoryForumRow): boolean {
  return row.platformNote !== true || row.heart === true;
}

/**
 * Copy a seeded forum row without its internal note-author flag.
 *
 * @param row - Seeded forum row.
 * @returns Public forum row with a fresh date.
 */
function copyForum(row: MemoryForumRow): WalletUsageForumRow {
  return {
    createdAt: new Date(row.createdAt.getTime()),
    amountSats: row.amountSats,
    heart: row.heart === true,
  };
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
