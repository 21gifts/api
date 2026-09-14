/**
 * Gift statistics domain: outbound gift rows and pure aggregation.
 *
 * The HTTP surface never includes invoices or other payment secrets — only
 * amounts (sats, BTC, historical USD/CHF/EUR/PHP), UTC days, and Wallet of
 * Satoshi recipient handles.
 */

import { FX_SOURCE_COINBASE_DAILY_CLOSE } from '@/lib/btc-usd-store';
import {
  satsToBtcString,
  satsToUsdCents,
  usdCentsToFiatCents,
  usdCentsToString,
} from '@/lib/money';
import { FX_SOURCE_FRANKFURTER_ECB, type FiatCross } from '@/lib/usd-fiat-store';

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
  /** CHF string for that day's gifts, or `null` if any gift that day lacks CHF. */
  chf: string | null;
  /** Running CHF total through this day inclusive, or `null` once a gap appears. */
  cumulativeChf: string | null;
  /** EUR string for that day's gifts, or `null` if any gift that day lacks EUR. */
  eur: string | null;
  /** Running EUR total through this day inclusive, or `null` once a gap appears. */
  cumulativeEur: string | null;
  /** PHP string for that day's gifts, or `null` if any gift that day lacks PHP. */
  php: string | null;
  /** Running PHP total through this day inclusive, or `null` once a gap appears. */
  cumulativePhp: string | null;
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
  /** CHF string, or `null` if any gift to this recipient lacks CHF. */
  chf: string | null;
  /** EUR string, or `null` if any gift to this recipient lacks EUR. */
  eur: string | null;
  /** PHP string, or `null` if any gift to this recipient lacks PHP. */
  php: string | null;
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
  /** CHF string, or `null` if any gift in this month lacks CHF. Zero-sats gap months are `"0.00"`. */
  chf: string | null;
  /** EUR string, or `null` if any gift in this month lacks EUR. Zero-sats gap months are `"0.00"`. */
  eur: string | null;
  /** PHP string, or `null` if any gift in this month lacks PHP. Zero-sats gap months are `"0.00"`. */
  php: string | null;
}

/** One FX quote listed on `fx.quotes`. */
export interface GiftFxQuote {
  /** Display / ISO code. */
  code: 'USD' | 'CHF' | 'EUR' | 'PHP';
  /** Pair used to produce this code. */
  pair: string;
  /** Upstream source tag. */
  source: string;
}

/** FX metadata attached to every stats payload. */
export interface GiftStatsFx {
  /** Quote pair. */
  quote: 'BTC-USD';
  /** Calendar-day basis for rate lookup. */
  dayBasis: 'utc';
  /** Persisted Coinbase Exchange daily-close source tag. */
  source: typeof FX_SOURCE_COINBASE_DAILY_CLOSE;
  /** USD always; CHF/EUR/PHP when at least one selected gift day has that cross. */
  quotes: GiftFxQuote[];
}

/** Aggregated public gift statistics. */
export interface GiftStats {
  /** Sum of `amountSats` across all rows. */
  totalSats: number;
  /** BTC string for `totalSats`. */
  totalBtc: string;
  /** USD string (sum of per-gift historical conversions). */
  totalUsd: string;
  /** CHF string, or `null` if any gift lacks CHF. Empty input is `"0.00"`. */
  totalChf: string | null;
  /** EUR string, or `null` if any gift lacks EUR. Empty input is `"0.00"`. */
  totalEur: string | null;
  /** PHP string, or `null` if any gift lacks PHP. Empty input is `"0.00"`. */
  totalPhp: string | null;
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
  /** Per-month totals, UTC months from first through last inclusive (gap months included). */
  byMonth: MonthSpend[];
  /** Quote metadata (always present, including empty stats). */
  fx: GiftStatsFx;
}

/** One outbound gift in a per-day public list. */
export interface GiftDayGift {
  /** ISO-8601 paid instant. */
  paidAt: string;
  /** Amount in whole satoshis (fees excluded). */
  amountSats: number;
  /** BTC string for `amountSats`. */
  amountBtc: string;
  /** USD string at this gift's UTC-day close. */
  amountUsd: string;
  /** CHF string at this gift's UTC-day ECB cross, or `null` when missing. */
  amountChf: string | null;
  /** EUR string at this gift's UTC-day ECB cross, or `null` when missing. */
  amountEur: string | null;
  /** PHP string at this gift's UTC-day ECB cross, or `null` when missing. */
  amountPhp: string | null;
  /** Wallet of Satoshi username. */
  recipient: string;
}

/** Public list of outbound gifts for one UTC calendar day. */
export interface GiftDay {
  /** UTC calendar day `YYYY-MM-DD`. */
  day: string;
  /** Number of gifts that UTC day. */
  giftCount: number;
  /** Sum of `amountSats` that UTC day. */
  totalSats: number;
  /** BTC string for `totalSats`. */
  totalBtc: string;
  /** USD string for that day's gifts. */
  totalUsd: string;
  /** CHF string, or `null` if any gift that day lacks CHF. Empty day is `"0.00"`. */
  totalChf: string | null;
  /** EUR string, or `null` if any gift that day lacks EUR. Empty day is `"0.00"`. */
  totalEur: string | null;
  /** PHP string, or `null` if any gift that day lacks PHP. Empty day is `"0.00"`. */
  totalPhp: string | null;
  /** Gifts that UTC day, `paidAt` then `recipient` ascending. */
  gifts: GiftDayGift[];
  /** Quote metadata (always present, including an empty day). */
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

/** Per-gift historical quote cents (null when that cross is missing). */
interface GiftFiatCents {
  chf: number | null;
  eur: number | null;
  php: number | null;
}

/** Running / bucket totals that go null once any gift in the bucket lacks a cross. */
interface FiatBucket {
  giftCount: number;
  sats: number;
  usdCents: number;
  chfCents: number | null;
  eurCents: number | null;
  phpCents: number | null;
}

const MS_PER_DAY = 86_400_000;

const USD_FX_QUOTE: GiftFxQuote = {
  code: 'USD',
  pair: 'BTC-USD',
  source: FX_SOURCE_COINBASE_DAILY_CLOSE,
};

const EMPTY_FX: GiftStatsFx = {
  quote: 'BTC-USD',
  dayBasis: 'utc',
  source: FX_SOURCE_COINBASE_DAILY_CLOSE,
  quotes: [USD_FX_QUOTE],
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
 * UTC calendar day `YYYY-MM-DD` from an instant.
 *
 * @param paidAt - Instant the gift was paid.
 * @returns The UTC day string.
 */
export function utcDayFromPaidAt(paidAt: Date): string {
  return utcDayString(paidAt);
}

/**
 * Whether `day` is a real UTC calendar date as `YYYY-MM-DD`.
 *
 * @param day - Candidate day string.
 * @returns `true` only for a valid calendar day.
 */
export function isUtcDay(day: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) {
    return false;
  }
  const year = Number(day.slice(0, 4));
  const month = Number(day.slice(5, 7));
  const date = Number(day.slice(8, 10));
  const instant = new Date(Date.UTC(year, month - 1, date));
  return (
    instant.getUTCFullYear() === year &&
    instant.getUTCMonth() === month - 1 &&
    instant.getUTCDate() === date
  );
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
 * Inclusive UTC month list from `fromMonth` through `toMonth`.
 *
 * @param fromMonth - Start `YYYY-MM`.
 * @param toMonth - End `YYYY-MM`.
 * @returns Every UTC month in the range.
 */
function enumerateUtcMonths(fromMonth: string, toMonth: string): string[] {
  const months: string[] = [];
  const year = Number(fromMonth.slice(0, 4));
  let monthIndex = Number(fromMonth.slice(5, 7)) - 1;
  for (;;) {
    const key = new Date(Date.UTC(year, monthIndex, 1)).toISOString().slice(0, 7);
    months.push(key);
    if (key === toMonth) {
      break;
    }
    monthIndex += 1;
  }
  return months;
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
 * Gifts whose Wallet of Satoshi handle matches `recipient` case-insensitively.
 *
 * Trims `recipient`. When `indexOf('@') > 0`, compares the local-part before `@`;
 * otherwise the whole trimmed string. Empty after trim matches nothing
 * (returns `[]`), never "all gifts".
 *
 * @param rows - Outbound gifts to filter.
 * @param recipient - Handle or Lightning Address to match.
 * @returns Matching rows (order preserved); `[]` when the needle is empty.
 */
export function giftsForRecipient(rows: readonly GiftRow[], recipient: string): GiftRow[] {
  const trimmed = recipient.trim();
  if (trimmed === '') {
    return [];
  }
  const at = trimmed.indexOf('@');
  const needle = at > 0 ? trimmed.slice(0, at) : trimmed;
  const target = needle.toLowerCase();
  return rows.filter((row) => row.recipientWosUser.toLowerCase() === target);
}

/**
 * Convert USD cents to one quote, or `null` when that day's cross is missing.
 *
 * @param usdCents - Historical USD cents for the gift.
 * @param rate - Quote-per-USD decimal string, or `undefined` when missing.
 * @returns Quote cents, or `null`.
 */
function quoteCents(usdCents: number, rate: string | undefined): number | null {
  if (rate === undefined) {
    return null;
  }
  return usdCentsToFiatCents(usdCents, rate);
}

/**
 * Per-gift CHF/EUR/PHP cents from that UTC day's USD-cross book.
 *
 * Missing keys are omitted on {@link FiatCross}; those quotes are `null`.
 * Does not throw.
 *
 * @param usdCents - Historical USD cents for the gift.
 * @param day - Gift UTC day.
 * @param fiatRates - Optional day → cross map.
 * @returns Quote cents (`null` when that currency cannot be converted).
 */
function giftFiatCents(
  usdCents: number,
  day: string,
  fiatRates: ReadonlyMap<string, FiatCross>,
): GiftFiatCents {
  const cross = fiatRates.get(day);
  return {
    chf: quoteCents(usdCents, cross?.CHF),
    eur: quoteCents(usdCents, cross?.EUR),
    php: quoteCents(usdCents, cross?.PHP),
  };
}

/**
 * Add quote cents. A missing addend makes the sum `null` (do not under-count).
 *
 * @param acc - Running total.
 * @param next - Next gift's cents.
 * @returns Sum, or `null` if either side is missing.
 */
function addMaybe(acc: number | null, next: number | null): number | null {
  if (acc === null || next === null) {
    return null;
  }
  return acc + next;
}

/**
 * Format quote cents, or `null` when the sum is incomplete.
 *
 * @param cents - Cents, or `null`.
 * @returns Two-decimal string, or `null`.
 */
function formatMaybeCents(cents: number | null): string | null {
  return cents === null ? null : usdCentsToString(cents);
}

/**
 * `fx.quotes` for a non-empty selection: USD always, then CHF/EUR/PHP when at
 * least one gift day has that cross (even if another day is missing).
 *
 * @param giftDays - UTC days that actually have gifts (not gap days).
 * @param fiatRates - Optional day → cross map.
 * @returns Quotes in USD, CHF, EUR, PHP order.
 */
function quotesForGiftDays(
  giftDays: readonly string[],
  fiatRates: ReadonlyMap<string, FiatCross>,
): GiftFxQuote[] {
  const quotes: GiftFxQuote[] = [USD_FX_QUOTE];
  let hasChf = false;
  let hasEur = false;
  let hasPhp = false;
  for (const day of giftDays) {
    const cross = fiatRates.get(day);
    if (typeof cross?.CHF === 'string') {
      hasChf = true;
    }
    if (typeof cross?.EUR === 'string') {
      hasEur = true;
    }
    if (typeof cross?.PHP === 'string') {
      hasPhp = true;
    }
  }
  if (hasChf) {
    quotes.push({ code: 'CHF', pair: 'USD-CHF', source: FX_SOURCE_FRANKFURTER_ECB });
  }
  if (hasEur) {
    quotes.push({ code: 'EUR', pair: 'USD-EUR', source: FX_SOURCE_FRANKFURTER_ECB });
  }
  if (hasPhp) {
    quotes.push({ code: 'PHP', pair: 'USD-PHP', source: FX_SOURCE_FRANKFURTER_ECB });
  }
  return quotes;
}

/**
 * Empty fiat bucket used when first inserting a recipient or month.
 *
 * @returns Zeroed bucket with numeric (not null) quote cents.
 */
function emptyFiatBucket(): FiatBucket {
  return { giftCount: 0, sats: 0, usdCents: 0, chfCents: 0, eurCents: 0, phpCents: 0 };
}

/**
 * Add one gift into a recipient/month bucket.
 *
 * @param bucket - Mutable bucket.
 * @param amountSats - Gift sats.
 * @param usdCents - Gift USD cents.
 * @param fiat - Gift quote cents.
 */
function addToBucket(
  bucket: FiatBucket,
  amountSats: number,
  usdCents: number,
  fiat: GiftFiatCents,
): void {
  bucket.giftCount += 1;
  bucket.sats += amountSats;
  bucket.usdCents += usdCents;
  bucket.chfCents = addMaybe(bucket.chfCents, fiat.chf);
  bucket.eurCents = addMaybe(bucket.eurCents, fiat.eur);
  bucket.phpCents = addMaybe(bucket.phpCents, fiat.php);
}

/**
 * Day/month series value: days/months with **no gifts** are `"0.00"` without
 * a fiat rate; days/months that have gifts (including zero-sat gifts) use
 * the converted cents, or `null` when a gift lacked that cross.
 *
 * @param hasGifts - Whether any gift landed in this bucket.
 * @param cents - Quote cents when gifts exist.
 * @returns Display string or `null`.
 */
function seriesFiat(hasGifts: boolean, cents: number | null | undefined): string | null {
  if (!hasGifts) {
    return usdCentsToString(0);
  }
  return formatMaybeCents(cents ?? null);
}

/**
 * Cumulative quote string. A null running total stays null; a zero-sats gap
 * keeps the previous running string when it is still a number.
 *
 * @param running - Running cents, or `null` once a gift lacked this quote.
 * @returns Display string or `null`.
 */
function cumulativeFiat(running: number | null): string | null {
  return formatMaybeCents(running);
}

/**
 * Aggregate outbound gifts into the public stats payload.
 *
 * Empty input yields zeros (including `totalChf`/`totalEur`/`totalPhp`
 * `"0.00"`), null dates, empty series, and `fx` with USD-only `quotes` — no
 * rates required. Non-empty input looks up each gift's UTC-day BTC-USD rate;
 * a missing BTC-USD rate throws `Error('fx.rate.missing')`. Missing CHF/EUR/PHP
 * does **not** throw: those fields are `null`. Gap days in `spendOverTime` and
 * gap months in `byMonth` use zero sats/BTC/USD and `"0.00"` fiat without
 * needing a rate.
 *
 * @param rows - Outbound gifts (order does not matter).
 * @param rates - UTC day → USD-per-BTC string for every gift day.
 * @param fiatRates - Optional UTC day → USD-cross map. Omitted/empty is allowed.
 * @returns Aggregated {@link GiftStats}.
 * @throws `Error('fx.rate.missing')` when a gift day has no BTC-USD rate.
 */
export function buildGiftStats(
  rows: readonly GiftRow[],
  rates: ReadonlyMap<string, string>,
  fiatRates?: ReadonlyMap<string, FiatCross>,
): GiftStats {
  const fiat = fiatRates ?? new Map<string, FiatCross>();
  if (rows.length === 0) {
    return {
      totalSats: 0,
      totalBtc: satsToBtcString(0),
      totalUsd: usdCentsToString(0),
      totalChf: usdCentsToString(0),
      totalEur: usdCentsToString(0),
      totalPhp: usdCentsToString(0),
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
  const byDayChfCents = new Map<string, number | null>();
  const byDayEurCents = new Map<string, number | null>();
  const byDayPhpCents = new Map<string, number | null>();
  const byRecipient = new Map<string, FiatBucket>();
  const byMonth = new Map<string, FiatBucket>();
  let totalSats = 0;
  let totalUsdCents = 0;
  let totalChfCents: number | null = 0;
  let totalEurCents: number | null = 0;
  let totalPhpCents: number | null = 0;

  for (const row of sorted) {
    const day = utcDayString(row.paidAt);
    const rate = rates.get(day);
    if (rate === undefined) {
      throw new Error('fx.rate.missing');
    }
    const usdCents = satsToUsdCents(row.amountSats, rate);
    const converted = giftFiatCents(usdCents, day, fiat);
    totalSats += row.amountSats;
    totalUsdCents += usdCents;
    totalChfCents = addMaybe(totalChfCents, converted.chf);
    totalEurCents = addMaybe(totalEurCents, converted.eur);
    totalPhpCents = addMaybe(totalPhpCents, converted.php);
    byDaySats.set(day, (byDaySats.get(day) ?? 0) + row.amountSats);
    byDayUsdCents.set(day, (byDayUsdCents.get(day) ?? 0) + usdCents);
    byDayChfCents.set(day, addMaybe(byDayChfCents.get(day) ?? 0, converted.chf));
    byDayEurCents.set(day, addMaybe(byDayEurCents.get(day) ?? 0, converted.eur));
    byDayPhpCents.set(day, addMaybe(byDayPhpCents.get(day) ?? 0, converted.php));

    const rec = byRecipient.get(row.recipientWosUser) ?? emptyFiatBucket();
    addToBucket(rec, row.amountSats, usdCents, converted);
    byRecipient.set(row.recipientWosUser, rec);

    const month = utcMonthString(row.paidAt);
    const mon = byMonth.get(month) ?? emptyFiatBucket();
    addToBucket(mon, row.amountSats, usdCents, converted);
    byMonth.set(month, mon);
  }

  const spendOverTime: SpendDay[] = [];
  let cumulativeSats = 0;
  let cumulativeUsdCents = 0;
  let cumulativeChfCents: number | null = 0;
  let cumulativeEurCents: number | null = 0;
  let cumulativePhpCents: number | null = 0;
  const startMs = utcDayMs(utcDayString(first.paidAt));
  const endMs = utcDayMs(utcDayString(last.paidAt));
  for (let ms = startMs; ms <= endMs; ms += MS_PER_DAY) {
    const day = new Date(ms).toISOString().slice(0, 10);
    const sats = byDaySats.get(day) ?? 0;
    const usdCents = byDayUsdCents.get(day) ?? 0;
    cumulativeSats += sats;
    cumulativeUsdCents += usdCents;
    const hasGifts = byDaySats.has(day);
    if (hasGifts) {
      const dayChf = byDayChfCents.get(day) ?? null;
      const dayEur = byDayEurCents.get(day) ?? null;
      const dayPhp = byDayPhpCents.get(day) ?? null;
      cumulativeChfCents = addMaybe(cumulativeChfCents, dayChf);
      cumulativeEurCents = addMaybe(cumulativeEurCents, dayEur);
      cumulativePhpCents = addMaybe(cumulativePhpCents, dayPhp);
    }
    spendOverTime.push({
      day,
      sats,
      cumulativeSats,
      btc: satsToBtcString(sats),
      cumulativeBtc: satsToBtcString(cumulativeSats),
      usd: usdCentsToString(usdCents),
      cumulativeUsd: usdCentsToString(cumulativeUsdCents),
      chf: seriesFiat(hasGifts, byDayChfCents.get(day)),
      cumulativeChf: cumulativeFiat(cumulativeChfCents),
      eur: seriesFiat(hasGifts, byDayEurCents.get(day)),
      cumulativeEur: cumulativeFiat(cumulativeEurCents),
      php: seriesFiat(hasGifts, byDayPhpCents.get(day)),
      cumulativePhp: cumulativeFiat(cumulativePhpCents),
    });
  }

  const recipients: RecipientSpend[] = [...byRecipient.entries()]
    .map(([recipient, totals]) => ({
      recipient,
      giftCount: totals.giftCount,
      sats: totals.sats,
      btc: satsToBtcString(totals.sats),
      usd: usdCentsToString(totals.usdCents),
      chf: formatMaybeCents(totals.chfCents),
      eur: formatMaybeCents(totals.eurCents),
      php: formatMaybeCents(totals.phpCents),
    }))
    .sort((a, b) => b.sats - a.sats || a.recipient.localeCompare(b.recipient));

  const months: MonthSpend[] = enumerateUtcMonths(
    utcMonthString(first.paidAt),
    utcMonthString(last.paidAt),
  ).map((month) => {
    const totals = byMonth.get(month);
    const sats = totals?.sats ?? 0;
    const giftCount = totals?.giftCount ?? 0;
    const usdCents = totals?.usdCents ?? 0;
    return {
      month,
      giftCount,
      sats,
      btc: satsToBtcString(sats),
      usd: usdCentsToString(usdCents),
      chf: seriesFiat(totals !== undefined, totals?.chfCents),
      eur: seriesFiat(totals !== undefined, totals?.eurCents),
      php: seriesFiat(totals !== undefined, totals?.phpCents),
    };
  });

  return {
    totalSats,
    totalBtc: satsToBtcString(totalSats),
    totalUsd: usdCentsToString(totalUsdCents),
    totalChf: formatMaybeCents(totalChfCents),
    totalEur: formatMaybeCents(totalEurCents),
    totalPhp: formatMaybeCents(totalPhpCents),
    giftCount: sorted.length,
    recipientCount: byRecipient.size,
    firstPaidAt: first.paidAt.toISOString(),
    lastPaidAt: last.paidAt.toISOString(),
    spendOverTime,
    byRecipient: recipients,
    byMonth: months,
    fx: {
      quote: 'BTC-USD',
      dayBasis: 'utc',
      source: FX_SOURCE_COINBASE_DAILY_CLOSE,
      quotes: quotesForGiftDays([...byDaySats.keys()], fiat),
    },
  };
}

/**
 * List outbound gifts that fall on one UTC calendar day.
 *
 * Empty (no rows that day) yields zeros (including `totalChf`/`totalEur`/
 * `totalPhp` `"0.00"`) and `gifts: []` with no rates required. Non-empty looks
 * up `day`'s BTC-USD rate; a missing BTC-USD rate throws
 * `Error('fx.rate.missing')`. Missing CHF/EUR/PHP does **not** throw: those
 * fields are `null`.
 *
 * @param day - UTC `YYYY-MM-DD` (caller already validated).
 * @param rows - Outbound gifts (any days; other days are ignored).
 * @param rates - UTC day → USD-per-BTC string.
 * @param fiatRates - Optional UTC day → USD-cross map. Omitted/empty is allowed.
 * @returns {@link GiftDay} for `day`.
 * @throws `Error('fx.rate.missing')` when a listed gift has no BTC-USD rate.
 */
export function buildGiftDay(
  day: string,
  rows: readonly GiftRow[],
  rates: ReadonlyMap<string, string>,
  fiatRates?: ReadonlyMap<string, FiatCross>,
): GiftDay {
  const fiat = fiatRates ?? new Map<string, FiatCross>();
  const matching = rows
    .filter((row) => utcDayFromPaidAt(row.paidAt) === day)
    .sort(
      (a, b) =>
        a.paidAt.getTime() - b.paidAt.getTime() ||
        a.recipientWosUser.localeCompare(b.recipientWosUser),
    );
  if (matching.length === 0) {
    return {
      day,
      giftCount: 0,
      totalSats: 0,
      totalBtc: satsToBtcString(0),
      totalUsd: usdCentsToString(0),
      totalChf: usdCentsToString(0),
      totalEur: usdCentsToString(0),
      totalPhp: usdCentsToString(0),
      gifts: [],
      fx: EMPTY_FX,
    };
  }

  let totalSats = 0;
  let totalUsdCents = 0;
  let totalChfCents: number | null = 0;
  let totalEurCents: number | null = 0;
  let totalPhpCents: number | null = 0;
  const gifts: GiftDayGift[] = [];
  for (const row of matching) {
    const rate = rates.get(day);
    if (rate === undefined) {
      throw new Error('fx.rate.missing');
    }
    const usdCents = satsToUsdCents(row.amountSats, rate);
    const converted = giftFiatCents(usdCents, day, fiat);
    totalSats += row.amountSats;
    totalUsdCents += usdCents;
    totalChfCents = addMaybe(totalChfCents, converted.chf);
    totalEurCents = addMaybe(totalEurCents, converted.eur);
    totalPhpCents = addMaybe(totalPhpCents, converted.php);
    gifts.push({
      paidAt: row.paidAt.toISOString(),
      amountSats: row.amountSats,
      amountBtc: satsToBtcString(row.amountSats),
      amountUsd: usdCentsToString(usdCents),
      amountChf: formatMaybeCents(converted.chf),
      amountEur: formatMaybeCents(converted.eur),
      amountPhp: formatMaybeCents(converted.php),
      recipient: row.recipientWosUser,
    });
  }

  return {
    day,
    giftCount: matching.length,
    totalSats,
    totalBtc: satsToBtcString(totalSats),
    totalUsd: usdCentsToString(totalUsdCents),
    totalChf: formatMaybeCents(totalChfCents),
    totalEur: formatMaybeCents(totalEurCents),
    totalPhp: formatMaybeCents(totalPhpCents),
    gifts,
    fx: {
      quote: 'BTC-USD',
      dayBasis: 'utc',
      source: FX_SOURCE_COINBASE_DAILY_CLOSE,
      quotes: quotesForGiftDays([day], fiat),
    },
  };
}
