/**
 * Point-of-sale charge domain: public and debug JSON projection.
 *
 * One open amount in whole sats. Settlement goes to the member's receiving
 * address. The api watches the invoices it handed out for a pending charge
 * (a Spark invoice and every BOLT11 at the charge amount) and marks the
 * charge `paid` once one of them settles. Expired charges are not a live
 * invoice. A typed fiat string is stored as typed. The other three currencies
 * are frozen once at insert, or stay null.
 */

import type { FxSpotQuote } from '@/lib/fx-spot';
import { parseUsdPerBtc, usdCentsToString } from '@/lib/money';

/** Live, paid, cancelled, or TTL-expired. */
export type PosChargeStatus = 'pending' | 'paid' | 'cancelled' | 'expired';

/** How long a pending charge pins LNURL-pay min/max (five minutes). */
export const POS_CHARGE_TTL_MS = 5 * 60 * 1000;

/** `GET /pos` keeps showing a charge as `charge` this long after it was paid. */
export const POS_PAID_SHOW_MS = 60 * 1000;

/** Currencies a till operator can type. None is special. */
export type PosFiatCode = 'USD' | 'CHF' | 'EUR' | 'PHP';

/** The four currencies, in JSON order. */
export const POS_FIAT_CODES: readonly PosFiatCode[] = ['USD', 'CHF', 'EUR', 'PHP'];

/** `numeric(20,2)` holds at most 18 digits before the decimal point. */
const MAX_NUMERIC_20_2_CENTS = 10n ** 20n - 1n;

/** Amount scaled by 10^8 times a rate scaled by 10^8, divided by 10^6, is cents. */
const CROSS_CENT_SCALE = 1_000_000n;

const TYPED_AMOUNT_RE = /^\d+(\.\d{1,8})?$/;

/** The other three currencies, each a two-decimal string or null. The typed one stays null. */
export interface PosFiatNumbers {
  /** USD frozen from the spot, or null. Null when USD was the typed currency. */
  fiatUsd: string | null;
  /** CHF frozen from the spot, or null. Null when CHF was the typed currency. */
  fiatChf: string | null;
  /** EUR frozen from the spot, or null. Null when EUR was the typed currency. */
  fiatEur: string | null;
  /** PHP frozen from the spot, or null. Null when PHP was the typed currency. */
  fiatPhp: string | null;
}

/** Persisted point-of-sale row (store-internal; includes `accountId`). */
export interface PosCharge {
  /** Opaque unique charge id. */
  id: string;
  /** Owner account id. */
  accountId: string;
  /** Requested amount in whole sats. */
  amountSats: number;
  /** `pending`, `paid`, `cancelled`, or `expired`. */
  status: PosChargeStatus;
  /** Creation instant. */
  createdAt: Date;
  /** Instant after which a pending row is expired. */
  expiresAt: Date;
  /** When a payment for this charge was confirmed, or `null`. */
  paidAt: Date | null;
  /** The Spark invoice handed out for this charge (`spark1…`), or `null`. */
  sparkInvoice: string | null;
  /** Currency the operator typed, or `null` when the body was sats only. */
  amountCurrency: PosFiatCode | null;
  /** Typed decimal, kept as typed, or `null` when the body was sats only. */
  amountText: string | null;
  /** Frozen USD numeric, or `null`. Never the typed USD string. */
  fiatUsd: string | null;
  /** Frozen CHF numeric, or `null`. Never the typed CHF string. */
  fiatChf: string | null;
  /** Frozen EUR numeric, or `null`. Never the typed EUR string. */
  fiatEur: string | null;
  /** Frozen PHP numeric, or `null`. Never the typed PHP string. */
  fiatPhp: string | null;
}

/** Fiat fields on every charge JSON object. */
export interface PosFiatJson {
  /** Typed currency code, or `null`. */
  amountCurrency: PosFiatCode | null;
  /** Typed decimal, or `null`. */
  amount: string | null;
  /** Typed string when USD was typed; otherwise the frozen two-decimal string, or `null`. */
  amountUsd: string | null;
  /** Typed string when CHF was typed; otherwise the frozen two-decimal string, or `null`. */
  amountChf: string | null;
  /** Typed string when EUR was typed; otherwise the frozen two-decimal string, or `null`. */
  amountEur: string | null;
  /** Typed string when PHP was typed; otherwise the frozen two-decimal string, or `null`. */
  amountPhp: string | null;
}

/** Public JSON shape of a charge (no `accountId`, no `sparkInvoice`). */
export interface PublicPosCharge extends PosFiatJson {
  /** Opaque unique charge id. */
  id: string;
  /** Requested amount in whole sats. */
  amountSats: number;
  /** `pending`, `paid`, `cancelled`, or `expired`. */
  status: PosChargeStatus;
  /** ISO-8601 creation timestamp. */
  createdAt: string;
  /** ISO-8601 expiry timestamp. */
  expiresAt: string;
  /** ISO-8601 instant the payment was confirmed, or `null`. */
  paidAt: string | null;
}

/** Operator JSON shape of a charge (includes `accountId` and `sparkInvoice`). */
export interface DebugPosCharge extends PublicPosCharge {
  /** Owner account id. */
  accountId: string;
  /** The Spark invoice handed out for this charge, or `null`. */
  sparkInvoice: string | null;
}

/**
 * Accept a typed fiat decimal.
 *
 * Trims, replaces a comma with a dot, and keeps the typed fraction.
 * Rejects an empty string, a trailing dot, a sign, an exponent, and a value
 * that is not greater than zero.
 *
 * @param raw - Operator input.
 * @returns The stored decimal, or `null` when it is not a typed amount.
 */
export function parseTypedFiatAmount(raw: string): string | null {
  const normalized = raw.trim().replaceAll(',', '.');
  if (!TYPED_AMOUNT_RE.test(normalized)) {
    return null;
  }
  if (typedScale8(normalized) <= 0n) {
    return null;
  }
  return normalized;
}

/**
 * `true` when `value` is one of the four till currencies. No trim.
 *
 * @param value - Candidate code.
 * @returns Whether it is `USD`, `CHF`, `EUR`, or `PHP`.
 */
export function isPosFiatCode(value: string): value is PosFiatCode {
  return value === 'USD' || value === 'CHF' || value === 'EUR' || value === 'PHP';
}

/**
 * Freeze the three currencies that were not typed, from one spot quote.
 *
 * `other = typedAmount * (spot[other] / spot[typed])`, then half-up to cents
 * the same way {@link usdCentsToFiatCents} rounds. The typed currency's
 * numeric column stays null. A missing rate, a rate that cannot be parsed, or
 * a result that does not fit `numeric(20,2)` is null for that currency.
 * `amountSats` is not an input. A null quote freezes nothing.
 *
 * @param typed - Currency the operator typed.
 * @param amountText - Typed decimal already accepted by {@link parseTypedFiatAmount}.
 * @param quote - Latest spot (fiat per 1 BTC), or `null`.
 * @returns The four numeric columns.
 */
export function freezePosFiatCrosses(
  typed: PosFiatCode,
  amountText: string,
  quote: FxSpotQuote | null,
): PosFiatNumbers {
  const empty: PosFiatNumbers = { fiatUsd: null, fiatChf: null, fiatEur: null, fiatPhp: null };
  if (quote === null) {
    return empty;
  }
  const typedRate = quote.rates[typed];
  if (typedRate === undefined) {
    return empty;
  }
  let typedScaled: bigint;
  try {
    typedScaled = parseUsdPerBtc(typedRate);
  } catch {
    return empty;
  }
  const amountScaled = typedScale8(amountText);
  const out: PosFiatNumbers = { fiatUsd: null, fiatChf: null, fiatEur: null, fiatPhp: null };
  for (const code of POS_FIAT_CODES) {
    if (code === typed) {
      continue;
    }
    const otherRate = quote.rates[code];
    if (otherRate === undefined) {
      continue;
    }
    assignCross(out, code, crossAmount(amountScaled, typedScaled, otherRate));
  }
  return out;
}

/**
 * Project the six fiat fields.
 *
 * The typed currency's JSON field is `amountText`, not the numeric column.
 * Each other currency is the numeric formatted with two decimals, or `null`.
 *
 * @param row - Persisted charge.
 * @returns Fiat JSON fields.
 */
export function serializePosFiat(row: PosCharge): PosFiatJson {
  return {
    amountCurrency: row.amountCurrency,
    amount: row.amountText,
    amountUsd: displayedAmount('USD', row),
    amountChf: displayedAmount('CHF', row),
    amountEur: displayedAmount('EUR', row),
    amountPhp: displayedAmount('PHP', row),
  };
}

/**
 * Project a store row to its public JSON shape.
 *
 * @param row - Persisted charge.
 * @returns Public fields only (`accountId` and `sparkInvoice` omitted); timestamps as ISO-8601.
 */
export function serializePosCharge(row: PosCharge): PublicPosCharge {
  return {
    id: row.id,
    amountSats: row.amountSats,
    status: row.status,
    createdAt: row.createdAt.toISOString(),
    expiresAt: row.expiresAt.toISOString(),
    paidAt: row.paidAt === null ? null : row.paidAt.toISOString(),
    ...serializePosFiat(row),
  };
}

/**
 * Project a store row to its operator debug JSON shape.
 *
 * @param row - Persisted charge.
 * @returns Debug fields including `accountId` and `sparkInvoice`; timestamps as ISO-8601.
 */
export function serializeDebugPosCharge(row: PosCharge): DebugPosCharge {
  return {
    ...serializePosCharge(row),
    accountId: row.accountId,
    sparkInvoice: row.sparkInvoice,
  };
}

/** Scale a typed decimal by 10^8. The grammar already limits the fraction to eight digits. */
function typedScale8(amount: string): bigint {
  const dot = amount.indexOf('.');
  const intPart = dot < 0 ? amount : amount.slice(0, dot);
  const frac = dot < 0 ? '' : amount.slice(dot + 1);
  return BigInt(intPart + frac.padEnd(8, '0'));
}

/** Write one frozen cross. The typed currency is never written. */
function assignCross(out: PosFiatNumbers, code: PosFiatCode, value: string | null): void {
  if (code === 'USD') {
    out.fiatUsd = value;
  } else if (code === 'CHF') {
    out.fiatChf = value;
  } else if (code === 'EUR') {
    out.fiatEur = value;
  } else {
    out.fiatPhp = value;
  }
}

/**
 * One cross as a two-decimal string, or `null` when the rate or the result cannot be stored.
 *
 * @param amountScaled - Typed amount times 10^8.
 * @param typedScaled - Typed currency per 1 BTC, times 10^8.
 * @param otherRate - Other currency per 1 BTC.
 * @returns Two decimals, or `null`.
 */
function crossAmount(amountScaled: bigint, typedScaled: bigint, otherRate: string): string | null {
  let otherScaled: bigint;
  try {
    otherScaled = parseUsdPerBtc(otherRate);
  } catch {
    return null;
  }
  const numer = amountScaled * otherScaled;
  const divisor = typedScaled * CROSS_CENT_SCALE;
  const quot = numer / divisor;
  const rem = numer % divisor;
  const rounded = rem * 2n >= divisor ? quot + 1n : quot;
  return centsToTwoDecimals(rounded);
}

/** JSON amount for one currency: the typed string, or the numeric column formatted. */
function displayedAmount(code: PosFiatCode, row: PosCharge): string | null {
  if (row.amountCurrency === code) {
    return row.amountText;
  }
  const stored =
    code === 'USD'
      ? row.fiatUsd
      : code === 'CHF'
        ? row.fiatChf
        : code === 'EUR'
          ? row.fiatEur
          : row.fiatPhp;
  return formatNumericText(stored);
}

/**
 * Format a stored numeric as two decimals.
 *
 * Extra fractional digits round half-up, the same step {@link parseUsdPerBtc}
 * uses past eight places. A value that does not fit `numeric(20,2)` is null.
 *
 * @param value - Numeric text, or `null`.
 * @returns Two decimals, or `null`.
 */
function formatNumericText(value: string | null): string | null {
  if (value === null) {
    return null;
  }
  const trimmed = value.trim();
  if (!/^\d+(\.\d+)?$/.test(trimmed)) {
    return null;
  }
  return centsToTwoDecimals(decimalToCents(trimmed));
}

/** Non-negative decimal text to cents, half-up past two places. Overflow is null. */
function decimalToCents(value: string): bigint | null {
  const dot = value.indexOf('.');
  const intPart = dot < 0 ? value : value.slice(0, dot);
  const frac = dot < 0 ? '' : value.slice(dot + 1);
  let cents: bigint;
  if (frac.length <= 2) {
    cents = BigInt(intPart + frac.padEnd(2, '0'));
  } else {
    cents = BigInt(intPart + frac.slice(0, 2));
    if (frac.charCodeAt(2) - 48 >= 5) {
      cents += 1n;
    }
  }
  if (cents > MAX_NUMERIC_20_2_CENTS) {
    return null;
  }
  return cents;
}

/**
 * Format cents the way {@link usdCentsToString} does.
 *
 * A value inside `numeric(20,2)` but outside a safe JS number uses the same
 * two-decimal layout without a second rounding.
 *
 * @param cents - Rounded cents, or `null` when they do not fit.
 * @returns Two decimals, or `null`.
 */
function centsToTwoDecimals(cents: bigint | null): string | null {
  if (cents === null || cents > MAX_NUMERIC_20_2_CENTS) {
    return null;
  }
  if (cents <= BigInt(Number.MAX_SAFE_INTEGER)) {
    return usdCentsToString(Number(cents));
  }
  const rem = cents % 100n;
  return `${(cents / 100n).toString()}.${rem.toString().padStart(2, '0')}`;
}
