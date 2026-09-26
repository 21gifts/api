/** Marker stored on the invoice attempt so a later zap is a repayment, not a new gift. */
const REPAY_DESCRIPTION =
  /^repay:(\d+):([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;

/** One giver's share of a day's repayment. */
export interface RepaymentShare {
  /** 21.gifts account that funded the credit. */
  accountId: string;
  /** Whole sats this giver is paid for the day. */
  sats: number;
}

/**
 * Invoice description that ties a paid zap to one day's share.
 *
 * @param dayIndex - Zero-based day in the term.
 * @param recipientAccountId - Giver being paid.
 * @returns The stored description.
 */
export function repaymentDescription(dayIndex: number, recipientAccountId: string): string {
  return `repay:${dayIndex}:${recipientAccountId}`;
}

/**
 * Read a repayment marker. Anything else is a normal gift invoice.
 *
 * @param description - Invoice attempt description, or null.
 * @returns The day and giver, or null.
 */
export function parseRepaymentDescription(
  description: string | null,
): { dayIndex: number; recipientAccountId: string } | null {
  if (description === null) {
    return null;
  }
  const match = REPAY_DESCRIPTION.exec(description);
  const day = match?.[1];
  const accountId = match?.[2];
  if (day === undefined || accountId === undefined) {
    return null;
  }
  return { dayIndex: Number(day), recipientAccountId: accountId };
}

/**
 * UTC midnight of the day after the credit became fully paid.
 *
 * @param fundedAtMs - When collected sats first reached the goal.
 * @returns Epoch milliseconds of that next UTC midnight.
 */
export function repaymentStartMs(fundedAtMs: number): number {
  const funded = new Date(fundedAtMs);
  return Date.UTC(funded.getUTCFullYear(), funded.getUTCMonth(), funded.getUTCDate() + 1);
}

/**
 * How many term days are already due, including today once the start day has begun.
 *
 * @param fundedAtMs - When the credit filled.
 * @param nowMs - Clock.
 * @param termDays - Stored term, 1..3650.
 * @returns A count from 0 through `termDays`.
 */
export function dueDayCount(fundedAtMs: number, nowMs: number, termDays: number): number {
  if (!Number.isInteger(termDays) || termDays < 1) {
    return 0;
  }
  const start = repaymentStartMs(fundedAtMs);
  if (nowMs < start) {
    return 0;
  }
  const elapsed = Math.floor((nowMs - start) / 86_400_000) + 1;
  return Math.min(termDays, elapsed);
}

/**
 * Whole units for one day. The last day keeps the remainder.
 *
 * @param total - Sats or cents.
 * @param days - Term length.
 * @param index - Zero-based day.
 * @returns That day's units, or null when the index is outside the term.
 */
export function dayUnits(total: bigint, days: number, index: number): bigint | null {
  if (total < 0n || !Number.isInteger(days) || days < 1 || index < 0 || index >= days) {
    return null;
  }
  const perDay = total / BigInt(days);
  const remainder = total % BigInt(days);
  return index === days - 1 ? perDay + remainder : perDay;
}

/**
 * Cents of a typed fiat ask. A trailing separator is a whole amount.
 *
 * @param amount - Canonical goal amount.
 * @returns Cents, or null when the text is not a fiat amount.
 */
export function fiatAmountToCents(amount: string): bigint | null {
  const normalized = amount.trim().replace(',', '.');
  if (!/^\d+(\.\d*)?$/.test(normalized)) {
    return null;
  }
  const parts = normalized.split('.');
  const whole = parts[0] as string;
  const frac = parts[1] ?? '';
  const head = frac.slice(0, 2).padEnd(2, '0');
  let cents = BigInt(whole) * 100n + BigInt(head);
  if (frac.length > 2 && frac[2] !== undefined && frac[2] >= '5') {
    cents += 1n;
  }
  return cents;
}

/**
 * Split a day's sats across givers in proportion to what they paid.
 * The largest giver, then the lowest account id, receives any leftover sat.
 *
 * @param dueSats - Sats due that day.
 * @param payers - Positive contributions with an account id.
 * @returns Shares that add up to `dueSats`.
 */
export function shareSats(
  dueSats: number,
  payers: readonly { accountId: string; sats: number }[],
): RepaymentShare[] {
  const usable = payers.filter((payer) => payer.sats > 0 && payer.accountId !== '');
  const total = usable.reduce((sum, payer) => sum + payer.sats, 0);
  if (!Number.isInteger(dueSats) || dueSats <= 0 || total <= 0) {
    return [];
  }
  const sorted = [...usable].sort(
    (a, b) => b.sats - a.sats || a.accountId.localeCompare(b.accountId),
  );
  const shares = sorted.map((payer) => ({
    accountId: payer.accountId,
    sats: Math.floor((dueSats * payer.sats) / total),
  }));
  const assigned = shares.reduce((sum, share) => sum + share.sats, 0);
  const largest = shares[0];
  if (largest !== undefined) {
    largest.sats += dueSats - assigned;
  }
  return shares.filter((share) => share.sats > 0);
}
