/**
 * Satoshi / BTC / USD money helpers for gift statistics.
 *
 * All USD math uses BigInt scaled integers — no IEEE division for money.
 */

/** Satoshis in one bitcoin. */
export const SATS_PER_BTC = 100_000_000;

/** `sats * usd_scaled_8 / 10^14` yields USD cents before rounding. */
const CENTS_DIVISOR = 100_000_000_000_000n; // 10^14

/**
 * Format whole satoshis as a BTC string with eight decimal places.
 *
 * @param sats - Non-negative integer satoshis.
 * @returns BTC amount, e.g. `"0.00001000"`.
 * @throws If `sats` is not a non-negative integer.
 */
export function satsToBtcString(sats: number): string {
  if (!Number.isInteger(sats) || sats < 0) {
    throw new Error('sats must be a non-negative integer');
  }
  const whole = Math.floor(sats / SATS_PER_BTC);
  const frac = sats % SATS_PER_BTC;
  return `${whole}.${String(frac).padStart(8, '0')}`;
}

/**
 * Parse a USD-per-BTC rate string into an 8-decimal scaled integer.
 *
 * Extra fractional digits beyond eight are rounded half-up. Values `<= 0`
 * and non-decimal shapes throw.
 *
 * @param rate - Decimal string, e.g. `"95000.12"`.
 * @returns `rate * 10^8` as `bigint`.
 * @throws If the rate is invalid or not strictly positive.
 */
export function parseUsdPerBtc(rate: string): bigint {
  if (!/^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(rate)) {
    throw new Error('invalid usd per btc rate');
  }
  const dot = rate.indexOf('.');
  const intPart = dot < 0 ? rate : rate.slice(0, dot);
  const fracRaw = dot < 0 ? '' : rate.slice(dot + 1);

  let scaled: bigint;
  if (fracRaw.length <= 8) {
    scaled = BigInt(intPart + fracRaw.padEnd(8, '0'));
  } else {
    const keep = fracRaw.slice(0, 8);
    const ninth = fracRaw.charCodeAt(8) - 48;
    scaled = BigInt(intPart + keep);
    if (ninth >= 5) {
      scaled += 1n;
    }
  }

  if (scaled <= 0n) {
    throw new Error('invalid usd per btc rate');
  }
  return scaled;
}

/**
 * Convert satoshis to USD cents at a given USD-per-BTC rate (half-up).
 *
 * Formula: `round_half_up(sats * usd_scaled_8 / 10^14)` using BigInt only.
 *
 * @param sats - Non-negative integer satoshis.
 * @param usdPerBtc - USD per BTC decimal string.
 * @returns USD cents as a number.
 * @throws If `sats` is invalid or the rate cannot be parsed.
 */
export function satsToUsdCents(sats: number, usdPerBtc: string): number {
  if (!Number.isInteger(sats) || sats < 0) {
    throw new Error('sats must be a non-negative integer');
  }
  const usdScaled8 = parseUsdPerBtc(usdPerBtc);
  const numer = BigInt(sats) * usdScaled8;
  const quot = numer / CENTS_DIVISOR;
  const rem = numer % CENTS_DIVISOR;
  const rounded = rem * 2n >= CENTS_DIVISOR ? quot + 1n : quot;
  return Number(rounded);
}

/**
 * Format integer USD cents as a dollar string with two decimal places.
 *
 * @param cents - Non-negative integer cents.
 * @returns Dollar amount, e.g. `"1234.56"`.
 * @throws If `cents` is not a non-negative integer.
 */
export function usdCentsToString(cents: number): string {
  if (!Number.isInteger(cents) || cents < 0) {
    throw new Error('cents must be a non-negative integer');
  }
  const dollars = Math.floor(cents / 100);
  const rem = cents % 100;
  return `${dollars}.${String(rem).padStart(2, '0')}`;
}
