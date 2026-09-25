/**
 * Gift-day ask conversion used when a forum note freezes a currency goal.
 *
 * Same float math as the app composer (`Math.round`, not BigInt spot helpers).
 * Payment snapshots stay on the gift-day pin; this module does not call
 * Coinbase or fiatFromSats.
 */

import { GIFT_INVOICE_MAX_MSAT } from '@/lib/config';

/** Whole-sat ceiling for a frozen ask (`GIFT_INVOICE_MAX_MSAT / 1000`). */
export const GOAL_SATS_MAX = GIFT_INVOICE_MAX_MSAT / 1000;

/** Fiat codes a currency ask may name. */
export type GoalFiatCode = 'USD' | 'CHF' | 'EUR' | 'PHP';

/** Stored `goal_currency` when a note asks in one of the five codes. */
export type GoalCurrency = 'BTC' | GoalFiatCode;

/**
 * Latest gift-day proportion used to freeze an ask. `usd` is `string | null`
 * (a missing quote stays null; it does not invent a rate).
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
 * Edit a typed ask amount into the canonical stored string.
 *
 * Trim, then accept comma or dot with at most eight fractional digits.
 * The result is a dot decimal with no exponent, no leading zeros, and no
 * trailing fractional zeros (`00010.10` → `10.1`, `0.10` → `0.1`, `10.` → `10`).
 * String editing only — not `parseFloat`.
 *
 * @param raw - JSON or multipart `goalAmount`.
 * @returns The canonical string, or `null` when the grammar fails.
 */
export function canonicalGoalAmount(raw: string): string | null {
  const trimmed = raw.trim();
  if (!/^\d+([.,]\d{0,8})?$/.test(trimmed)) {
    return null;
  }
  const normalized = trimmed.replace(',', '.');
  const dot = normalized.indexOf('.');
  const wholeRaw = dot === -1 ? normalized : normalized.slice(0, dot);
  const fracRaw = dot === -1 ? '' : normalized.slice(dot + 1);
  const whole = wholeRaw.replace(/^0+(?=\d)/, '');
  const frac = fracRaw.replace(/0+$/, '');
  return frac === '' ? whole : `${whole}.${frac}`;
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
 * Convert a fiat amount to whole sats on a gift-day proportion.
 *
 * Unusable day, non-finite amount, or amount `< 0` → unusable. Unusable
 * currency field → unusable. Amount `0` → `0` sats. Otherwise
 * `Math.round(amount * day.sats / dayFiat)`; a product that rounds to `0`
 * becomes `1`.
 *
 * @param amount - Canonical amount as `Number(canonical)`.
 * @param day - Latest gift-day, or `null`.
 * @param currency - USD/CHF/EUR/PHP field on `day`.
 * @returns Whole sats, or `null` when unusable.
 */
export function fiatToSats(
  amount: number,
  day: GoalRateDay | null,
  currency: GoalFiatCode,
): number | null {
  if (!dayIsUsable(day) || !Number.isFinite(amount) || amount < 0) {
    return null;
  }
  const quote = dayFiat(day, currency);
  if (quote === null) {
    return null;
  }
  if (amount === 0) {
    return 0;
  }
  const rounded = Math.round((amount * day.sats) / quote);
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
