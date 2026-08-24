/**
 * Gift statistics domain: outbound gift rows and pure aggregation.
 *
 * The HTTP surface never includes invoices or other payment secrets — only
 * amounts (sats, BTC, historical USD), UTC days, and Wallet of Satoshi
 * recipient handles.
 */

import { FX_SOURCE_COINBASE_DAILY_CLOSE } from '@/lib/btc-usd-store';
import { satsToBtcString, satsToUsdCents, usdCentsToString } from '@/lib/money';

/** One outbound gift used as stats input. No invoice fields. */
export interface GiftRow {
  /** Instant the gift was paid. */
  paidAt: Date;
  /** Amount in whole satoshis (fees excluded). */
  amountSats: number;
  /** Wallet of Satoshi username the gift was paid to. */
  recipientWosUser: string;
}

/** Daily spend point, including days with zero gifts between first and last. */
export interface SpendDay {
  /** UTC calendar day `YYYY-MM-DD`. */
  day: string;
  /** Sats paid that UTC day. */
  sats: number;
  /** Running total of sats through this day inclusive. */
  cumulativeSats: number;
  /** BTC string for `sats` (eight decimals). */
  btc: string;
  /** BTC string for `cumulativeSats`. */
  cumulativeBtc: string;
  /** USD string for that day's gifts at each gift's UTC-day rate. */
  usd: string;
  /** Running USD total through this day inclusive. */
  cumulativeUsd: string;
}

/** Totals for one recipient. */
export interface RecipientSpend {
  /** Wallet of Satoshi username. */
  recipient: string;
  /** Number of outbound gifts to this recipient. */
  giftCount: number;
  /** Sats paid to this recipient. */
  sats: number;
  /** BTC string for `sats`. */
  btc: string;
  /** USD string (sum of per-gift historical conversions). */
  usd: string;
}

/** Totals for one UTC calendar month. */
export interface MonthSpend {
  /** UTC month `YYYY-MM`. */
  month: string;
  /** Number of outbound gifts in this month. */
  giftCount: number;
  /** Sats paid in this month. */
  sats: number;
  /** BTC string for `sats`. */
  btc: string;
  /** USD string (sum of per-gift historical conversions). */
  usd: string;
}

/** FX metadata attached to every stats payload. */
export interface GiftStatsFx {
  /** Quote pair. */
  quote: 'BTC-USD';
  /** Calendar-day basis for rate lookup. */
  dayBasis: 'utc';
  /** Persisted Coinbase Exchange daily-close source tag. */
  source: typeof FX_SOURCE_COINBASE_DAILY_CLOSE;
}

/** Aggregated public gift statistics. */
export interface GiftStats {
  /** Sum of `amountSats` across all rows. */
  totalSats: number;
  /** BTC string for `totalSats`. */
  totalBtc: string;
  /** USD string (sum of per-gift historical conversions). */
  totalUsd: string;
  /** Number of outbound gifts. */
  giftCount: number;
  /** Distinct recipient handles. */
  recipientCount: number;
  /** ISO-8601 timestamp of the earliest gift, or `null` when none. */
  firstPaidAt: string | null;
  /** ISO-8601 timestamp of the latest gift, or `null` when none. */
  lastPaidAt: string | null;
  /** Cumulative spend series, UTC days from first through last inclusive. */
  spendOverTime: SpendDay[];
  /** Per-recipient totals, largest spend first. */
  byRecipient: RecipientSpend[];
  /** Per-month totals, chronological. */
  byMonth: MonthSpend[];
  /** Quote metadata (always present, including empty stats). */
  fx: GiftStatsFx;
}

/** SQL shape selected from the `gift` table for stats (no invoice columns). */
export interface GiftQueryRow {
  /** `paid_at` column. */
  paid_at: Date | string;
  /** `amount_sats` column (bigint may arrive as string or bigint). */
  amount_sats: number | string | bigint;
  /** `recipient_wos_user` column. */
  recipient_wos_user: string;
}

const MS_PER_DAY = 86_400_000;

const EMPTY_FX: GiftStatsFx = {
  quote: 'BTC-USD',
  dayBasis: 'utc',
  source: FX_SOURCE_COINBASE_DAILY_CLOSE,
};

/**
 * UTC calendar day `YYYY-MM-DD` from an instant.
 *
 * @param date - Instant to format.
 * @returns The UTC day string.
 */
function utcDayString(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/**
 * UTC calendar month `YYYY-MM` from an instant.
 *
 * @param date - Instant to format.
 * @returns The UTC month string.
 */
function utcMonthString(date: Date): string {
  return date.toISOString().slice(0, 7);
}

/**
 * Epoch milliseconds at UTC midnight for a `YYYY-MM-DD` day.
 *
 * @param day - UTC day string.
 * @returns `Date.UTC` midnight for that day.
 */
function utcDayMs(day: string): number {
  const year = Number(day.slice(0, 4));
  const month = Number(day.slice(5, 7));
  const date = Number(day.slice(8, 10));
  return Date.UTC(year, month - 1, date);
}

/**
 * Map one SQL `gift` row onto a {@link GiftRow}.
 *
 * @param row - Columns selected for stats.
 * @returns The domain row (`paidAt` is always a `Date`).
 */
export function mapGiftQueryRow(row: GiftQueryRow): GiftRow {
  const paidAt = row.paid_at instanceof Date ? row.paid_at : new Date(row.paid_at);
  return {
    paidAt,
    amountSats: Number(row.amount_sats),
    recipientWosUser: row.recipient_wos_user,
  };
}

/**
 * Aggregate outbound gifts into the public stats payload.
 *
 * Empty input yields zeros, null dates, empty series, and `fx` — no rates
 * required. Non-empty input looks up each gift's UTC-day rate; a missing
 * rate throws `Error('fx.rate.missing')`. Gap days in `spendOverTime` use
 * zero sats/BTC/USD without needing a rate.
 *
 * @param rows - Outbound gifts (order does not matter).
 * @param rates - UTC day → USD-per-BTC string for every gift day.
 * @returns Aggregated {@link GiftStats}.
 * @throws `Error('fx.rate.missing')` when a gift day has no rate.
 */
export function buildGiftStats(
  rows: readonly GiftRow[],
  rates: ReadonlyMap<string, string>,
): GiftStats {
  if (rows.length === 0) {
    return {
      totalSats: 0,
      totalBtc: satsToBtcString(0),
      totalUsd: usdCentsToString(0),
      giftCount: 0,
      recipientCount: 0,
      firstPaidAt: null,
      lastPaidAt: null,
      spendOverTime: [],
      byRecipient: [],
      byMonth: [],
      fx: EMPTY_FX,
    };
  }

  const sorted = [...rows].sort((a, b) => a.paidAt.getTime() - b.paidAt.getTime());
  const first = sorted[0] as GiftRow;
  const last = sorted[sorted.length - 1] as GiftRow;

  const byDaySats = new Map<string, number>();
  const byDayUsdCents = new Map<string, number>();
  const byRecipient = new Map<string, { giftCount: number; sats: number; usdCents: number }>();
  const byMonth = new Map<string, { giftCount: number; sats: number; usdCents: number }>();
  let totalSats = 0;
  let totalUsdCents = 0;

  for (const row of sorted) {
    const day = utcDayString(row.paidAt);
    const rate = rates.get(day);
    if (rate === undefined) {
      throw new Error('fx.rate.missing');
    }
    const usdCents = satsToUsdCents(row.amountSats, rate);
    totalSats += row.amountSats;
    totalUsdCents += usdCents;
    byDaySats.set(day, (byDaySats.get(day) ?? 0) + row.amountSats);
    byDayUsdCents.set(day, (byDayUsdCents.get(day) ?? 0) + usdCents);

    const rec = byRecipient.get(row.recipientWosUser) ?? { giftCount: 0, sats: 0, usdCents: 0 };
    rec.giftCount += 1;
    rec.sats += row.amountSats;
    rec.usdCents += usdCents;
    byRecipient.set(row.recipientWosUser, rec);

    const month = utcMonthString(row.paidAt);
    const mon = byMonth.get(month) ?? { giftCount: 0, sats: 0, usdCents: 0 };
    mon.giftCount += 1;
    mon.sats += row.amountSats;
    mon.usdCents += usdCents;
    byMonth.set(month, mon);
  }

  const spendOverTime: SpendDay[] = [];
  let cumulativeSats = 0;
  let cumulativeUsdCents = 0;
  const startMs = utcDayMs(utcDayString(first.paidAt));
  const endMs = utcDayMs(utcDayString(last.paidAt));
  for (let ms = startMs; ms <= endMs; ms += MS_PER_DAY) {
    const day = new Date(ms).toISOString().slice(0, 10);
    const sats = byDaySats.get(day) ?? 0;
    const usdCents = byDayUsdCents.get(day) ?? 0;
    cumulativeSats += sats;
    cumulativeUsdCents += usdCents;
    spendOverTime.push({
      day,
      sats,
      cumulativeSats,
      btc: satsToBtcString(sats),
      cumulativeBtc: satsToBtcString(cumulativeSats),
      usd: usdCentsToString(usdCents),
      cumulativeUsd: usdCentsToString(cumulativeUsdCents),
    });
  }

  const recipients: RecipientSpend[] = [...byRecipient.entries()]
    .map(([recipient, totals]) => ({
      recipient,
      giftCount: totals.giftCount,
      sats: totals.sats,
      btc: satsToBtcString(totals.sats),
      usd: usdCentsToString(totals.usdCents),
    }))
    .sort((a, b) => b.sats - a.sats || a.recipient.localeCompare(b.recipient));

  const months: MonthSpend[] = [...byMonth.entries()]
    .map(([month, totals]) => ({
      month,
      giftCount: totals.giftCount,
      sats: totals.sats,
      btc: satsToBtcString(totals.sats),
      usd: usdCentsToString(totals.usdCents),
    }))
    .sort((a, b) => a.month.localeCompare(b.month));

  return {
    totalSats,
    totalBtc: satsToBtcString(totalSats),
    totalUsd: usdCentsToString(totalUsdCents),
    giftCount: sorted.length,
    recipientCount: byRecipient.size,
    firstPaidAt: first.paidAt.toISOString(),
    lastPaidAt: last.paidAt.toISOString(),
    spendOverTime,
    byRecipient: recipients,
    byMonth: months,
    fx: EMPTY_FX,
  };
}
