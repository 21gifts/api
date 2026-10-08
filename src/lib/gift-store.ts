import type { GiftKind, GiftRow } from '@/lib/gift';
import type { SqlClient } from '@/lib/auth/sql';
import {
  crossForPaymentDay,
  fiatFromUsd,
  paymentRateDays,
  quoteFromLargestSibling,
  satsToUsdCents,
  usdCentsToString,
  type FiatCrossRates,
} from '@/lib/money';

const GIFT_FIAT_COLUMNS_SQL: readonly string[] = [
  `ALTER TABLE gift ADD COLUMN IF NOT EXISTS fiat_usd numeric(20, 2)`,
  `ALTER TABLE gift ADD COLUMN IF NOT EXISTS fiat_chf numeric(20, 2)`,
  `ALTER TABLE gift ADD COLUMN IF NOT EXISTS fiat_eur numeric(20, 2)`,
  `ALTER TABLE gift ADD COLUMN IF NOT EXISTS fiat_php numeric(20, 2)`,
];

interface GiftBackfillRow {
  id: number | string;
  paid_at: Date | string;
  amount_sats: number | string | bigint;
  fiat_usd?: string | number | null;
  fiat_chf?: string | number | null;
  fiat_eur?: string | number | null;
  fiat_php?: string | number | null;
}

interface GiftBackfillRateRow {
  day: Date | string;
  usd_per_btc: string | number | null;
  quote: string | null;
  rate: string | number | null;
}

/** Stored numeric text, or `null` when the column was not selected. */
function textOrNull(value: string | number | null | undefined): string | null {
  if (value === null || value === undefined) {
    return null;
  }
  return String(value);
}

/** Copy one stored quote onto a cross. Unknown quotes and null rates are skipped. */
function assignStoredCross(cross: FiatCrossRates, quote: string | null, rate: string | null): void {
  if (quote === null || rate === null) {
    return;
  }
  if (quote === 'CHF') {
    cross.CHF = rate;
  } else if (quote === 'EUR') {
    cross.EUR = rate;
  } else if (quote === 'PHP') {
    cross.PHP = rate;
  }
}

interface GiftKindMatchRow {
  gift_id: number | string;
  message_id: string;
  message_text: string;
  abs_seconds: number | string;
}

/** UTC day, or `null` when `paid_at` is not a real timestamp. */
function utcDayOrNull(value: Date | string): string | null {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    return null;
  }
  return date.toISOString().slice(0, 10);
}

const GIFT_KIND_MATCH_SQL = `SELECT g.id AS gift_id, m.id AS message_id, trim(m.text) AS message_text,
            abs(extract(epoch from (m.created_at - g.paid_at))) AS abs_seconds
     FROM gift g
     INNER JOIN message m
       ON m.parent_id IS NOT NULL
      AND trim(m.text) IN ('Welcome', '21gifts daily')
      AND m.sats = g.amount_sats
      AND abs(extract(epoch from (m.created_at - g.paid_at))) <= 3
     INNER JOIN account platform_account
       ON platform_account.id = m.account_id
      AND platform_account.is_platform IS TRUE
     INNER JOIN message parent_message
       ON parent_message.id = m.parent_id
     INNER JOIN account parent_author
       ON parent_author.id = parent_message.account_id
      AND lower(split_part(parent_author.lightning_address, '@', 1)) = lower(g.recipient_wos_user)
     WHERE g.kind IS NULL`;

const GIFT_KIND_TRIGGER_SQL = `SELECT 1
     FROM pg_trigger
     WHERE tgrelid = 'gift'::regclass
       AND tgname = 'trg_db_change'
       AND NOT tgisinternal`;

/**
 * Classify NULL `gift.kind` rows, then require the column.
 *
 * Skips until `trg_db_change` is attached to `gift`, so the UPDATEs land in
 * `db_change` and a boot that is still attaching the trigger retries next time.
 * Description `21gifts moderator` is moderator. Remaining NULL rows are matched
 * one-to-one against platform replies whose text is `Welcome` or `21gifts daily`;
 * only an assigned Welcome sets `welcome`. Welcome and every other still-NULL row
 * are one UPDATE, so a stopped boot cannot reuse that Welcome reply. The check
 * constraint counts only when it is on `gift`.
 *
 * @param sql - Parameter-bound SQL client.
 */
export async function repairGiftKind(sql: SqlClient): Promise<void> {
  const trigger = await sql.query<{ present: number }>(GIFT_KIND_TRIGGER_SQL);
  if (trigger.length === 0) {
    return;
  }
  await sql.execute(
    `UPDATE gift SET kind = 'moderator' WHERE kind IS NULL AND description = '21gifts moderator'`,
  );
  const remaining = await sql.query<{ id: number | string }>(
    `SELECT id FROM gift WHERE kind IS NULL LIMIT 1`,
  );
  let classified = false;
  if (remaining.length > 0) {
    const matches = await sql.query<GiftKindMatchRow>(GIFT_KIND_MATCH_SQL);
    const sorted = [...matches].sort((a, b) => Number(a.abs_seconds) - Number(b.abs_seconds));
    const usedGifts = new Set<string>();
    const usedMessages = new Set<string>();
    const welcomeIds: string[] = [];
    for (const row of sorted) {
      const giftId = String(row.gift_id);
      const messageId = String(row.message_id);
      if (usedGifts.has(giftId) || usedMessages.has(messageId)) {
        continue;
      }
      usedGifts.add(giftId);
      usedMessages.add(messageId);
      if (row.message_text === 'Welcome') {
        welcomeIds.push(giftId);
      }
    }
    if (welcomeIds.length > 0) {
      // Bun SQL sends a JS array as a malformed array literal, so the ids are `{1,2}`.
      await sql.execute(
        `UPDATE gift SET kind = CASE WHEN id = ANY($1::bigint[]) THEN 'welcome' ELSE 'daily' END WHERE kind IS NULL`,
        [`{${welcomeIds.join(',')}}`],
      );
      classified = true;
    }
  }
  if (!classified) {
    await sql.execute(`UPDATE gift SET kind = 'daily' WHERE kind IS NULL`);
  }
  const existing = await sql.query<{ conname: string }>(
    `SELECT conname FROM pg_constraint
     WHERE conname = 'gift_kind_check'
       AND conrelid = 'gift'::regclass
       AND contype = 'c'`,
  );
  if (existing.length === 0) {
    await sql.execute(
      `ALTER TABLE gift ADD CONSTRAINT gift_kind_check CHECK (kind IN ('daily','welcome','moderator'))`,
    );
  }
  await sql.execute(`ALTER TABLE gift ALTER COLUMN kind SET NOT NULL`);
}

interface GiftSiblingRow {
  paid_at: Date | string;
  fiat_usd?: string | number | null;
  fiat_chf?: string | number | null;
  fiat_eur?: string | number | null;
  fiat_php?: string | number | null;
}

interface SiblingQuotes {
  chf: { usd: string; quote: string }[];
  eur: { usd: string; quote: string }[];
  php: { usd: string; quote: string }[];
}

/** Same-day gifts that already store a USD amount and at least one cross. */
const GIFT_SIBLING_SQL = `SELECT paid_at, fiat_usd::text AS fiat_usd,
            fiat_chf::text AS fiat_chf, fiat_eur::text AS fiat_eur,
            fiat_php::text AS fiat_php
     FROM gift
     WHERE fiat_usd IS NOT NULL
       AND (fiat_chf IS NOT NULL OR fiat_eur IS NOT NULL OR fiat_php IS NOT NULL)
       AND paid_at >= $1::timestamptz
       AND paid_at < $2::timestamptz`;

/**
 * Quotes already stored on the candidate days, grouped by UTC day.
 *
 * The window is the first candidate day through the start of the day after
 * the last. A row outside those days is ignored. The statement does not
 * select rows whose USD amount is null.
 *
 * @param sql - Parameter-bound SQL client.
 * @param days - UTC days that have a gift still missing a cross.
 * @returns Per-day CHF, EUR, and PHP references.
 */
async function loadSiblingQuotes(
  sql: SqlClient,
  days: readonly string[],
): Promise<Map<string, SiblingQuotes>> {
  const out = new Map<string, SiblingQuotes>();
  const sorted = [...days].sort();
  const first = sorted[0] as string;
  const last = sorted[sorted.length - 1] as string;
  const year = Number(last.slice(0, 4));
  const month = Number(last.slice(5, 7));
  const date = Number(last.slice(8, 10));
  const rows = await sql.query<GiftSiblingRow>(GIFT_SIBLING_SQL, [
    `${first}T00:00:00.000Z`,
    new Date(Date.UTC(year, month - 1, date + 1)).toISOString(),
  ]);
  const wanted = new Set(days);
  for (const row of rows) {
    const day = utcDayOrNull(row.paid_at);
    const usd = textOrNull(row.fiat_usd);
    if (day === null || usd === null || !wanted.has(day)) {
      continue;
    }
    const bucket = out.get(day) ?? { chf: [], eur: [], php: [] };
    const chf = textOrNull(row.fiat_chf);
    const eur = textOrNull(row.fiat_eur);
    const php = textOrNull(row.fiat_php);
    if (chf !== null) {
      bucket.chf.push({ usd, quote: chf });
    }
    if (eur !== null) {
      bucket.eur.push({ usd, quote: eur });
    }
    if (php !== null) {
      bucket.php.push({ usd, quote: php });
    }
    out.set(day, bucket);
  }
  return out;
}

/**
 * Add stored fiat columns and backfill priceable gifts from daily tables.
 *
 * The backfill is network-free and idempotent. A row with no `fiat_usd` is
 * priced from that UTC day's BTC-USD rate and is left alone when that day
 * has none; an earlier day's bitcoin price is not reused. A row that already
 * has `fiat_usd` keeps that USD. A null CHF, EUR, or PHP cross is filled from
 * the largest same-day gift that already has that cross. When that day has no
 * such gift, the nearest published quote on or before the payment day is used,
 * within 10 days. A `paid_at` that is not a real timestamp is skipped. `kind` is added here
 * as a nullable column. {@link repairGiftKind} classifies it after the audit
 * trigger.
 *
 * @param sql - Parameter-bound SQL client.
 */
export async function migrateGiftSchema(sql: SqlClient): Promise<void> {
  for (const statement of GIFT_FIAT_COLUMNS_SQL) {
    await sql.execute(statement);
  }
  await sql.execute(`ALTER TABLE gift ADD COLUMN IF NOT EXISTS kind text`);
  const candidates = await sql.query<GiftBackfillRow>(
    `SELECT id, paid_at, amount_sats,
            fiat_usd::text AS fiat_usd, fiat_chf::text AS fiat_chf,
            fiat_eur::text AS fiat_eur, fiat_php::text AS fiat_php
     FROM gift
     WHERE amount_sats > 0
       AND (fiat_usd IS NULL OR fiat_chf IS NULL OR fiat_eur IS NULL OR fiat_php IS NULL)`,
  );
  const days = [
    ...new Set(
      candidates.flatMap((row) => {
        const day = utcDayOrNull(row.paid_at);
        return day === null ? [] : [day];
      }),
    ),
  ];
  if (days.length === 0) {
    return;
  }
  const lookup = [...new Set(days.flatMap((day) => paymentRateDays(day)))];
  const placeholders = lookup.map((_, index) => `($${index + 1}::date)`).join(', ');
  const rateRows = await sql.query<GiftBackfillRateRow>(
    `SELECT days.day::text AS day, b.usd_per_btc::text AS usd_per_btc,
            f.quote, f.rate::text AS rate
     FROM (VALUES ${placeholders}) AS days(day)
     LEFT JOIN btc_usd_daily b ON b.day = days.day
     LEFT JOIN usd_fiat_daily f ON f.day = days.day AND f.quote IN ('CHF', 'EUR', 'PHP')`,
    lookup,
  );
  const rates = new Map<string, { usdPerBtc: string | null; crosses: FiatCrossRates }>();
  for (const row of rateRows) {
    const day = String(row.day).slice(0, 10);
    const value = rates.get(day) ?? { usdPerBtc: null, crosses: {} };
    const usdPerBtc = textOrNull(row.usd_per_btc);
    if (usdPerBtc !== null) {
      value.usdPerBtc = usdPerBtc;
    }
    assignStoredCross(value.crosses, row.quote, textOrNull(row.rate));
    rates.set(day, value);
  }
  const crossBook = new Map<string, FiatCrossRates>();
  for (const [day, value] of rates) {
    crossBook.set(day, value.crosses);
  }
  const siblings = await loadSiblingQuotes(sql, days);
  for (const row of candidates) {
    const day = utcDayOrNull(row.paid_at);
    if (day === null) {
      continue;
    }
    const storedUsd = textOrNull(row.fiat_usd);
    try {
      if (storedUsd === null) {
        const own = rates.get(day);
        if (own === undefined || own.usdPerBtc === null) {
          continue;
        }
        const usd = usdCentsToString(satsToUsdCents(Number(row.amount_sats), own.usdPerBtc));
        const fiat = fiatFromUsd(usd, crossForPaymentDay(crossBook, day));
        await sql.execute(
          `UPDATE gift SET fiat_usd = $2::numeric, fiat_chf = $3::numeric,
             fiat_eur = $4::numeric, fiat_php = $5::numeric
           WHERE id = $1 AND fiat_usd IS NULL`,
          [row.id, usd, fiat.chf, fiat.eur, fiat.php],
        );
        continue;
      }
      const book = fiatFromUsd(storedUsd, crossForPaymentDay(crossBook, day));
      const sameDay = siblings.get(day);
      const fiat = {
        chf: quoteFromLargestSibling(storedUsd, sameDay?.chf ?? []) ?? book.chf,
        eur: quoteFromLargestSibling(storedUsd, sameDay?.eur ?? []) ?? book.eur,
        php: quoteFromLargestSibling(storedUsd, sameDay?.php ?? []) ?? book.php,
      };
      const fillsChf = textOrNull(row.fiat_chf) === null && fiat.chf !== null;
      const fillsEur = textOrNull(row.fiat_eur) === null && fiat.eur !== null;
      const fillsPhp = textOrNull(row.fiat_php) === null && fiat.php !== null;
      if (!fillsChf && !fillsEur && !fillsPhp) {
        continue;
      }
      await sql.execute(
        `UPDATE gift SET fiat_chf = COALESCE(fiat_chf, $2::numeric),
           fiat_eur = COALESCE(fiat_eur, $3::numeric),
           fiat_php = COALESCE(fiat_php, $4::numeric)
         WHERE id = $1 AND fiat_usd IS NOT NULL`,
        [row.id, fiat.chf, fiat.eur, fiat.php],
      );
    } catch {
      // One bad amount or rate must not stop the other rows.
      continue;
    }
  }
}

/** Operator dump of one `gift` row (every stored column). */
export interface GiftDebugRow {
  /** Serial id, or `null` when the adapter does not store one. */
  id: number | null;
  /** Paid-at ISO-8601. */
  paidAt: string;
  /** Always `outbound` in v1. */
  direction: string;
  /** Currency code, or `null` when the adapter does not store one. */
  currency: string | null;
  /** Whole sats. */
  amountSats: number;
  /** Stored USD snapshot. */
  amountUsd: string | null;
  /** Stored CHF snapshot. */
  amountChf: string | null;
  /** Stored EUR snapshot. */
  amountEur: string | null;
  /** Stored PHP snapshot. */
  amountPhp: string | null;
  /** Fee sats, or `null` when the adapter does not store one. */
  feeSats: number | null;
  /** Wallet of Satoshi username. */
  recipientWosUser: string;
  /** Daily funding, welcome gift, or moderator stipend. */
  kind: GiftKind;
  /** BOLT11, or `null` when the adapter does not store one. */
  lightningInvoice: string | null;
  /** Wallet of Satoshi tx id. */
  wosTransactionId: string | null;
  /** Description, or `null` when the adapter does not store one. */
  description: string | null;
  /** Point-of-sale flag. */
  pointOfSale: boolean;
  /** Wallet of Satoshi status. */
  wosStatus: string | null;
  /** Source wallet, or `null` when the adapter does not store one. */
  sourceWallet: string | null;
  /** Import ISO-8601, or `null` when the adapter does not store one. */
  importedAt: string | null;
}

/**
 * Persistence for outbound gifts used by public statistics.
 *
 * v1 default is in-memory (empty). Production boot injects a query against
 * the `gift` table when `DATABASE_URL` is set.
 */
export interface GiftStore {
  /**
   * Every outbound gift, without invoice fields.
   *
   * @returns Gift rows (any order; stats sorting is the aggregator's job).
   */
  listOutbound(): Promise<GiftRow[]>;

  /**
   * Operator dump of stored gift columns, newest `paidAt` first, capped at `limit`.
   *
   * @param limit - Maximum rows.
   * @returns Debug rows.
   */
  listDebug?(limit: number): Promise<GiftDebugRow[]>;
}

/**
 * Process-local {@link GiftStore}. Used in tests and when no database URL is
 * configured — the process still boots.
 */
export class InMemoryGiftStore implements GiftStore {
  /**
   * @param rows - Seed gifts; stored as-is and copied on read.
   */
  constructor(private readonly rows: readonly GiftRow[] = []) {}

  /**
   * Copy of the seed rows sorted by `paidAt` ascending.
   *
   * @returns A new array; the constructor input is not mutated.
   */
  listOutbound(): Promise<GiftRow[]> {
    return Promise.resolve([...this.rows].sort((a, b) => a.paidAt.getTime() - b.paidAt.getTime()));
  }

  /**
   * Operator dump of stored gift columns, newest `paidAt` first.
   *
   * @param limit - Maximum rows.
   * @returns Debug rows.
   */
  listDebug(limit: number): Promise<GiftDebugRow[]> {
    return this.listOutbound().then((rows) =>
      [...rows]
        .sort((a, b) => b.paidAt.getTime() - a.paidAt.getTime())
        .slice(0, limit)
        .map((row) => ({
          id: null,
          paidAt: row.paidAt.toISOString(),
          direction: 'outbound',
          currency: null,
          amountSats: row.amountSats,
          amountUsd: row.amountUsd ?? null,
          amountChf: row.amountChf ?? null,
          amountEur: row.amountEur ?? null,
          amountPhp: row.amountPhp ?? null,
          feeSats: null,
          recipientWosUser: row.recipientWosUser,
          kind: row.kind as GiftKind,
          lightningInvoice: null,
          wosTransactionId: null,
          description: null,
          pointOfSale: false,
          wosStatus: null,
          sourceWallet: null,
          importedAt: null,
        })),
    );
  }
}

/**
 * {@link GiftStore} that delegates listing to an injected query.
 *
 * Production boot passes a Postgres SELECT; tests pass a stub.
 */
export class QueryGiftStore implements GiftStore {
  /**
   * @param query - Loader that returns outbound gift rows.
   * @param debugQuery - Optional full-column dump loader.
   */
  constructor(
    private readonly query: () => Promise<GiftRow[]>,
    private readonly debugQuery?: () => Promise<GiftDebugRow[]>,
  ) {}

  /**
   * Runs the injected query.
   *
   * @returns The query result unchanged.
   */
  listOutbound(): Promise<GiftRow[]> {
    return this.query();
  }

  /**
   * Operator dump of stored gift columns, newest `paidAt` first.
   *
   * @param limit - Maximum rows.
   * @returns Debug rows from `debugQuery` when set, otherwise mapped outbound gifts.
   */
  listDebug(limit: number): Promise<GiftDebugRow[]> {
    if (this.debugQuery !== undefined) {
      return this.debugQuery().then((rows) => rows.slice(0, limit));
    }
    return this.listOutbound().then((rows) =>
      [...rows]
        .sort((a, b) => b.paidAt.getTime() - a.paidAt.getTime())
        .slice(0, limit)
        .map((row) => ({
          id: null,
          paidAt: row.paidAt.toISOString(),
          direction: 'outbound',
          currency: null,
          amountSats: row.amountSats,
          amountUsd: row.amountUsd ?? null,
          amountChf: row.amountChf ?? null,
          amountEur: row.amountEur ?? null,
          amountPhp: row.amountPhp ?? null,
          feeSats: null,
          recipientWosUser: row.recipientWosUser,
          kind: row.kind as GiftKind,
          lightningInvoice: null,
          wosTransactionId: null,
          description: null,
          pointOfSale: false,
          wosStatus: null,
          sourceWallet: null,
          importedAt: null,
        })),
    );
  }
}
