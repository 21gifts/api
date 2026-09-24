import type { GiftKind, GiftRow } from '@/lib/gift';
import type { SqlClient } from '@/lib/auth/sql';
import { satsToUsdCents, usdCentsToFiatCents, usdCentsToString } from '@/lib/money';

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
}

interface GiftBackfillRateRow {
  day: Date | string;
  usd_per_btc: string | number;
  quote: string | null;
  rate: string | number | null;
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

/**
 * Classify NULL `gift.kind` rows, then require the column.
 *
 * Description `21gifts moderator` is moderator. Remaining NULL rows are matched
 * one-to-one against platform Welcome / `21gifts daily` replies; only an assigned
 * Welcome sets `welcome`. Everything still NULL becomes `daily`.
 *
 * @param sql - Parameter-bound SQL client.
 */
async function backfillGiftKind(sql: SqlClient): Promise<void> {
  await sql.execute(
    `UPDATE gift SET kind = 'moderator' WHERE kind IS NULL AND description = '21gifts moderator'`,
  );
  const remaining = await sql.query<{ id: number | string }>(
    `SELECT id FROM gift WHERE kind IS NULL LIMIT 1`,
  );
  if (remaining.length > 0) {
    const matches = await sql.query<GiftKindMatchRow>(GIFT_KIND_MATCH_SQL);
    const sorted = [...matches].sort((a, b) => Number(a.abs_seconds) - Number(b.abs_seconds));
    const usedGifts = new Set<string>();
    const usedMessages = new Set<string>();
    for (const row of sorted) {
      const giftId = String(row.gift_id);
      const messageId = String(row.message_id);
      if (usedGifts.has(giftId) || usedMessages.has(messageId)) {
        continue;
      }
      usedGifts.add(giftId);
      usedMessages.add(messageId);
      if (row.message_text === 'Welcome') {
        await sql.execute(`UPDATE gift SET kind = 'welcome' WHERE id = $1 AND kind IS NULL`, [
          row.gift_id,
        ]);
      }
    }
  }
  await sql.execute(`UPDATE gift SET kind = 'daily' WHERE kind IS NULL`);
  const existing = await sql.query<{ conname: string }>(
    `SELECT conname FROM pg_constraint WHERE conname = 'gift_kind_check'`,
  );
  if (existing.length === 0) {
    await sql.execute(
      `ALTER TABLE gift ADD CONSTRAINT gift_kind_check CHECK (kind IN ('daily','welcome','moderator'))`,
    );
  }
  await sql.execute(`ALTER TABLE gift ALTER COLUMN kind SET NOT NULL`);
}

/**
 * Add stored fiat columns and backfill priceable legacy gifts from daily tables.
 *
 * The backfill is network-free and idempotent: rows whose `fiat_usd` is already
 * set are never selected or rewritten, and rows without a BTC daily rate remain null.
 * A `paid_at` that is not a real timestamp is skipped. `kind` is added, backfilled,
 * constrained, and set NOT NULL before the fiat freeze.
 *
 * @param sql - Parameter-bound SQL client.
 */
export async function migrateGiftSchema(sql: SqlClient): Promise<void> {
  for (const statement of GIFT_FIAT_COLUMNS_SQL) {
    await sql.execute(statement);
  }
  await sql.execute(`ALTER TABLE gift ADD COLUMN IF NOT EXISTS kind text`);
  await backfillGiftKind(sql);
  const candidates = await sql.query<GiftBackfillRow>(
    `SELECT id, paid_at, amount_sats FROM gift WHERE amount_sats > 0 AND fiat_usd IS NULL`,
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
  const placeholders = days.map((_, index) => `$${index + 1}::date`).join(', ');
  const rateRows = await sql.query<GiftBackfillRateRow>(
    `SELECT b.day::text AS day, b.usd_per_btc::text AS usd_per_btc,
            f.quote, f.rate::text AS rate
     FROM btc_usd_daily b
     LEFT JOIN usd_fiat_daily f ON f.day = b.day AND f.quote IN ('CHF', 'EUR', 'PHP')
     WHERE b.day IN (${placeholders})`,
    days,
  );
  const rates = new Map<string, { usdPerBtc: string; crosses: Record<string, string> }>();
  for (const row of rateRows) {
    const day = String(row.day).slice(0, 10);
    const value = rates.get(day) ?? { usdPerBtc: String(row.usd_per_btc), crosses: {} };
    if (row.quote !== null && row.rate !== null) {
      value.crosses[row.quote] = String(row.rate);
    }
    rates.set(day, value);
  }
  for (const row of candidates) {
    const day = utcDayOrNull(row.paid_at);
    if (day === null) {
      continue;
    }
    const rate = rates.get(day);
    if (rate === undefined) {
      continue;
    }
    const usdCents = satsToUsdCents(Number(row.amount_sats), rate.usdPerBtc);
    const quote = (code: 'CHF' | 'EUR' | 'PHP'): string | null => {
      const cross = rate.crosses[code];
      return cross === undefined ? null : usdCentsToString(usdCentsToFiatCents(usdCents, cross));
    };
    await sql.execute(
      `UPDATE gift SET fiat_usd = $2::numeric, fiat_chf = $3::numeric,
         fiat_eur = $4::numeric, fiat_php = $5::numeric
       WHERE id = $1 AND fiat_usd IS NULL`,
      [row.id, usdCentsToString(usdCents), quote('CHF'), quote('EUR'), quote('PHP')],
    );
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
