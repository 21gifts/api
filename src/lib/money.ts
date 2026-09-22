/**
 * Satoshi / BTC / USD / fiat money helpers for gift statistics.
 *
 * All USD and fiat math uses BigInt scaled integers — no IEEE division for money.
 */

/** Satoshis in one bitcoin. */
export const SATS_PER_BTC = 100_000_000;

/** `sats * usd_scaled_8 / 10^14` yields USD cents before rounding. */
const CENTS_DIVISOR = 100_000_000_000_000n; // 10^14

/** `usdCents * rate_scaled_8 / 10^8` yields quote cents before rounding. */
const FIAT_CENTS_DIVISOR = 100_000_000n; // 10^8

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
 * @throws If `sats` is invalid, the rate cannot be parsed, or rounded cents exceed `Number.MAX_SAFE_INTEGER`.
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
  if (rounded > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error('usd cents overflow');
  }
  return Number(rounded);
}

/**
 * Convert USD cents to quote cents at a quote-per-USD rate (half-up).
 *
 * Formula: `round_half_up(usdCents * rate_scaled_8 / 10^8)` using BigInt
 * only. `rate_scaled_8` is {@link parseUsdPerBtc} (same decimal grammar).
 *
 * @param usdCents - Non-negative integer USD cents.
 * @param quotePerUsd - Quote per 1 USD decimal string (e.g. `"0.80"` CHF).
 * @returns Quote cents as a number.
 * @throws If `usdCents` is invalid, the rate cannot be parsed, or rounded
 *   cents exceed `Number.MAX_SAFE_INTEGER`.
 */
export function usdCentsToFiatCents(usdCents: number, quotePerUsd: string): number {
  if (!Number.isInteger(usdCents) || usdCents < 0) {
    throw new Error('cents must be a non-negative integer');
  }
  const rateScaled8 = parseUsdPerBtc(quotePerUsd);
  const numer = BigInt(usdCents) * rateScaled8;
  const quot = numer / FIAT_CENTS_DIVISOR;
  const rem = numer % FIAT_CENTS_DIVISOR;
  const rounded = rem * 2n >= FIAT_CENTS_DIVISOR ? quot + 1n : quot;
  if (rounded > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error('fiat cents overflow');
  }
  return Number(rounded);
}

/**
 * Format integer USD cents as a dollar string with two decimal places.
 *
 * Also used for CHF/EUR/PHP display strings (all two decimal places).
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

/**
 * USD plus optional CHF/EUR/PHP strings stored at payment time.
 *
 * `usd` is a two-decimal string, or `null` when nothing was stored. A missing cross is `null`, not `"0.00"`.
 */
export interface FiatAmounts {
  /** Already-normalized USD, two decimals (e.g. `"5.00"`), or `null` when none was stored. */
  usd: string | null;
  /** CHF at the stored USD, or `null` when that cross is missing. */
  chf: string | null;
  /** EUR at the stored USD, or `null` when that cross is missing. */
  eur: string | null;
  /** PHP at the stored USD, or `null` when that cross is missing. */
  php: string | null;
}

/** Quote-per-USD crosses used when freezing a snapshot. Missing keys stay null. */
export interface FiatCrossRates {
  /** CHF per 1 USD. */
  CHF?: string;
  /** EUR per 1 USD. */
  EUR?: string;
  /** PHP per 1 USD. */
  PHP?: string;
}

const AMOUNT_USD_RE = /^(?:0|[1-9]\d*)(?:\.\d{1,2})?$/;
const MAX_AMOUNT_USD_CENTS = 10_000_000;

/**
 * Parse a two-decimal money string into integer cents without IEEE float.
 *
 * @param raw - Decimal text (`"5.00"`, `"5.1"`, `"5"`).
 * @returns Integer cents, or `null` when the shape is not integer cents.
 */
function centsFromAmount(raw: string): number | null {
  if (!AMOUNT_USD_RE.test(raw)) {
    return null;
  }
  const dot = raw.indexOf('.');
  const dollars = dot < 0 ? raw : raw.slice(0, dot);
  const frac = (dot < 0 ? '' : raw.slice(dot + 1)).padEnd(2, '0');
  return Number(dollars) * 100 + Number(frac);
}

/**
 * Normalize a spend-worker USD amount to two decimals.
 *
 * Accepts `"5"` / `"5.1"` / `"5.00"` with value `> 0` and `<= 100000`.
 * Integer cents only — no IEEE float.
 *
 * @param raw - Caller-supplied USD text.
 * @returns `"5.00"`-style string, or `null` when the value is unusable.
 */
export function normalizeAmountUsd(raw: string): string | null {
  const cents = centsFromAmount(raw);
  if (cents === null || cents <= 0 || cents > MAX_AMOUNT_USD_CENTS) {
    return null;
  }
  return usdCentsToString(cents);
}

/** Optional shown amounts on an invoice body. A missing key is not the same as null. */
export interface ShownFiatBody {
  amountUsd?: string | null | undefined;
  amountChf?: string | null | undefined;
  amountEur?: string | null | undefined;
  amountPhp?: string | null | undefined;
}

/**
 * Read the four amounts the payer was shown.
 *
 * No key present means the client did not pin a price. Any present key pins
 * all four: a missing sibling is null, and a bad string is rejected.
 *
 * @param body - Parsed invoice fields.
 * @returns Pinned snapshot, an unpinned marker, or `null` when a string is unusable.
 */
export function shownFiatFromBody(
  body: ShownFiatBody,
): { pinned: false } | { pinned: true; fiat: FiatAmounts } | null {
  const pinned =
    body.amountUsd !== undefined ||
    body.amountChf !== undefined ||
    body.amountEur !== undefined ||
    body.amountPhp !== undefined;
  if (!pinned) {
    return { pinned: false };
  }
  const one = (value: string | null | undefined): string | null | 'bad' => {
    if (value === undefined || value === null) {
      return null;
    }
    if (value === '0' || value === '0.0' || value === '0.00') {
      return '0.00';
    }
    return normalizeAmountUsd(value) ?? 'bad';
  };
  const usd = one(body.amountUsd);
  const chf = one(body.amountChf);
  const eur = one(body.amountEur);
  const php = one(body.amountPhp);
  if (usd === 'bad' || chf === 'bad' || eur === 'bad' || php === 'bad') {
    return null;
  }
  return { pinned: true, fiat: { usd, chf, eur, php } };
}

/**
 * Convert one quote, or `null` when that cross is missing.
 *
 * @param usdCents - Integer USD cents.
 * @param rate - Quote-per-USD decimal, or `undefined`.
 * @returns Two-decimal quote string, or `null`.
 */
function quoteFromUsdCents(usdCents: number, rate: string | undefined): string | null {
  if (rate === undefined) {
    return null;
  }
  return usdCentsToString(usdCentsToFiatCents(usdCents, rate));
}

/**
 * Freeze CHF/EUR/PHP from an already-normalized USD amount.
 *
 * The USD string is the value stored at payment time (the caller-supplied
 * spend amount), not a later UTC-day close. A missing cross is `null`; this
 * function does not throw when a cross is missing.
 *
 * @param amountUsd - Already-normalized two-decimal USD (e.g. `"5.00"`).
 * @param crosses - Optional CHF/EUR/PHP per 1 USD.
 * @returns Snapshot whose `usd` is `amountUsd`.
 */
export function fiatFromUsd(amountUsd: string, crosses: FiatCrossRates): FiatAmounts {
  const usdCents = centsFromAmount(amountUsd);
  if (usdCents === null) {
    throw new Error('amountUsd must be normalized');
  }
  return {
    usd: amountUsd,
    chf: quoteFromUsdCents(usdCents, crosses.CHF),
    eur: quoteFromUsdCents(usdCents, crosses.EUR),
    php: quoteFromUsdCents(usdCents, crosses.PHP),
  };
}

/**
 * Freeze USD/CHF/EUR/PHP from sats at one Coinbase spot.
 *
 * The USD is the spot conversion stored at payment time, not a later UTC-day
 * close. Zero sats is not called. A missing cross is `null`; this function
 * does not throw when a cross is missing.
 *
 * @param sats - Whole sats (`> 0`).
 * @param usdPerBtc - Coinbase `data.amount` decimal text.
 * @param crosses - Optional CHF/EUR/PHP per 1 USD.
 * @returns Snapshot at this spot.
 */
export function fiatFromSats(
  sats: number,
  usdPerBtc: string,
  crosses: FiatCrossRates,
): FiatAmounts {
  const usdCents = satsToUsdCents(sats, usdPerBtc);
  const usd = usdCentsToString(usdCents);
  return {
    usd,
    chf: quoteFromUsdCents(usdCents, crosses.CHF),
    eur: quoteFromUsdCents(usdCents, crosses.EUR),
    php: quoteFromUsdCents(usdCents, crosses.PHP),
  };
}
