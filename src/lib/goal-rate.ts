/**
 * Fiat conversion helpers used by asks and repayment shares.
 *
 * A forum ask uses its precision-preserving BigInt spot helper; a repayment
 * uses the same stored quote with `Math.round`. This module does not call a
 * provider or `fiatFromSats`.
 */

import { GIFT_INVOICE_MAX_MSAT } from '@/lib/config';
import { canonicalDecimal } from '@/lib/decimal';
import type { FxSpotQuote } from '@/lib/fx-spot';

/** Whole-sat ceiling for a frozen ask (`GIFT_INVOICE_MAX_MSAT / 1000`). */
export const GOAL_SATS_MAX = GIFT_INVOICE_MAX_MSAT / 1000;

/** Fiat codes a currency ask may name. */
export type GoalFiatCode = 'USD' | 'CHF' | 'EUR' | 'PHP';

/** Stored `goal_currency` when a note asks in one of the five codes. */
export type GoalCurrency = 'BTC' | GoalFiatCode;

/**
 * Historical gift-day proportion accepted by {@link satsToFiatAmount}.
 * `usd` is `string | null` (a missing quote stays null).
 */
export interface GoalRateDay {
  /** Sats paid that UTC day. */
  sats: number;
  /** USD string for that day, or `null` when unusable. */
  usd: string | null;
  /** CHF string for that day, or `null` when unusable. */
  chf: string | null;
  /** EUR string for that day, or `null` when unusable. */
  eur: string | null;
  /** PHP string for that day, or `null` when unusable. */
  php: string | null;
}

/**
 * Edit a BTC ask amount into the whole-sat stored string.
 *
 * Trim, then accept comma or dot with at most eight fractional digits.
 * The result drops trailing fractional zeros (`10.0` → `10`). A fiat ask
 * does not use this function; it keeps the typed fraction.
 * String editing only — not `parseFloat`; the trimming is
 * {@link canonicalDecimal} with eight decimals.
 *
 * @param raw - JSON or multipart BTC `goalAmount`.
 * @returns The canonical string, or `null` when the grammar fails.
 */
export function canonicalGoalAmount(raw: string): string | null {
  return canonicalDecimal(raw, 8);
}

/** A day is usable when it is present, `sats` is finite, and `sats > 0`. */
function dayIsUsable(day: GoalRateDay | null): day is GoalRateDay {
  return day !== null && Number.isFinite(day.sats) && day.sats > 0;
}

/**
 * Map a fiat code onto the day's quote. Unusable when the field is null, not a
 * finite number, or `0`.
 */
function dayFiat(day: GoalRateDay, currency: GoalFiatCode): number | null {
  const raw =
    currency === 'USD'
      ? day.usd
      : currency === 'CHF'
        ? day.chf
        : currency === 'EUR'
          ? day.eur
          : day.php;
  if (raw === null) {
    return null;
  }
  const value = Number(raw);
  if (!Number.isFinite(value) || value === 0) {
    return null;
  }
  return value;
}

/**
 * Convert a fiat amount to whole sats on the current spot quote.
 *
 * Missing quote, non-finite amount, or amount `< 0` → unusable. Missing,
 * non-finite, or non-positive currency rate → unusable. Amount `0` → `0`
 * sats. Otherwise `Math.round(amount * 1e8 / fiatPerBtc)`; a product that
 * rounds to `0` becomes `1`.
 *
 * @param amount - Canonical amount as `Number(canonical)`.
 * @param quote - Current BTC spot quote, or `null`.
 * @param currency - USD/CHF/EUR/PHP field on `quote`.
 * @returns Whole sats, or `null` when unusable.
 */
export function fiatToSats(
  amount: number,
  quote: FxSpotQuote | null,
  currency: GoalFiatCode,
): number | null {
  if (quote === null || !Number.isFinite(amount) || amount < 0) {
    return null;
  }
  const rate = Number(quote.rates[currency]);
  if (!Number.isFinite(rate) || rate <= 0) {
    return null;
  }
  if (amount === 0) {
    return 0;
  }
  const rounded = Math.round((amount * 100_000_000) / rate);
  return rounded === 0 ? 1 : rounded;
}

/**
 * Convert whole sats to a two-decimal fiat string on a gift-day proportion.
 *
 * `null` when the day or that currency is unusable or `sats < 0`.
 * `cents = Math.round(dayFiat * 100 * sats / day.sats)`.
 *
 * @param sats - Whole sats (may be zero).
 * @param day - Latest gift-day, or `null`.
 * @param currency - USD/CHF/EUR/PHP field on `day`.
 * @returns Two-decimal string, or `null`.
 */
export function satsToFiatAmount(
  sats: number,
  day: GoalRateDay | null,
  currency: GoalFiatCode,
): string | null {
  if (!dayIsUsable(day) || sats < 0) {
    return null;
  }
  const quote = dayFiat(day, currency);
  if (quote === null) {
    return null;
  }
  const cents = Math.round((quote * 100 * sats) / day.sats);
  return (cents / 100).toFixed(2);
}
