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

/** One giver's exact repayment on one day, in sats or cents. */
export interface RepaymentSlice {
  /** Zero-based day in the term. */
  dayIndex: number;
  /** Giver account id. */
  accountId: string;
  /** Whole sats or whole cents. Never zero. */
  units: bigint;
}

/**
 * Schedule that pays every giver back exactly what they gave.
 *
 * Each day pays `dayUnits` of the total. A giver's fraction is carried to
 * the next day until it reaches one whole unit, so a 1-sat or 1-cent gift
 * is returned in full over the term.
 *
 * @param days - Term length.
 * @param payers - Positive contributions. Their units are the debt.
 * @returns The non-zero payments, in day order.
 */
export function repaymentSchedule(
  days: number,
  payers: readonly { accountId: string; units: bigint }[],
): RepaymentSlice[] {
  const usable = payers.filter((payer) => payer.units > 0n && payer.accountId !== '');
  const total = usable.reduce((sum, payer) => sum + payer.units, 0n);
  if (total <= 0n || !Number.isInteger(days) || days < 1) {
    return [];
  }
  const ordered = [...usable].sort((a, b) => {
    if (a.units !== b.units) {
      return a.units > b.units ? -1 : 1;
    }
    return a.accountId.localeCompare(b.accountId);
  });
  const numer = new Map<string, bigint>(ordered.map((payer) => [payer.accountId, 0n]));
  const slices: RepaymentSlice[] = [];
  for (let day = 0; day < days; day += 1) {
    const due = dayUnits(total, days, day) as bigint;
    if (due === 0n) {
      continue;
    }
    const pays = ordered.map((payer) => {
      const next = (numer.get(payer.accountId) as bigint) + due * payer.units;
      const units = next / total;
      const rem = next % total;
      numer.set(payer.accountId, rem);
      return { accountId: payer.accountId, units, rem };
    });
    let leftover = due - pays.reduce((sum, pay) => sum + pay.units, 0n);
    while (leftover > 0n) {
      pays.sort((a, b) => {
        if (a.rem !== b.rem) {
          return a.rem > b.rem ? -1 : 1;
        }
        return a.accountId.localeCompare(b.accountId);
      });
      const winner = pays[0] as (typeof pays)[number];
      winner.units += 1n;
      winner.rem -= total;
      numer.set(winner.accountId, winner.rem);
      leftover -= 1n;
    }
    const byAccount = new Map(pays.map((pay) => [pay.accountId, pay]));
    for (const payer of ordered) {
      const pay = byAccount.get(payer.accountId) as (typeof pays)[number];
      if (pay.units > 0n) {
        slices.push({ dayIndex: day, accountId: payer.accountId, units: pay.units });
      }
    }
  }
  return slices;
}

/** One giver's recorded payment, used to decide what they are owed. */
export interface PayerContribution {
  /** 21.gifts account id. Empty ids are not payable. */
  accountId: string;
  /** Sats this giver paid. */
  sats: number;
  /** Recorded USD of those payments, or null when a snapshot is missing. */
  usd?: string | null;
  /** Recorded CHF of those payments, or null when a snapshot is missing. */
  chf?: string | null;
  /** Recorded EUR of those payments, or null when a snapshot is missing. */
  eur?: string | null;
  /** Recorded PHP of those payments, or null when a snapshot is missing. */
  php?: string | null;
}

const FIAT_CENTS = {
  USD: 'usd',
  CHF: 'chf',
  EUR: 'eur',
  PHP: 'php',
} as const;

type FiatCode = keyof typeof FIAT_CENTS;

/**
 * Whole units each giver is owed.
 *
 * Bitcoin asks use the sats they paid. Fiat asks use the cents recorded in
 * the goal currency, including a 1-cent gift. When a snapshot is missing,
 * the typed amount is split by sat weight so the shares still add up.
 *
 * @param goalCurrency - Ask currency, or null.
 * @param goalAmount - Typed fiat amount, used only when a snapshot is missing.
 * @param payers - Contributions with an account id.
 * @returns Units per giver, or `unavailable` when a fiat ask has no amount.
 */
export function payerDebtUnits(
  goalCurrency: string | null | undefined,
  goalAmount: string | null | undefined,
  payers: readonly PayerContribution[],
): { accountId: string; units: bigint }[] | 'unavailable' {
  if (goalCurrency !== null && goalCurrency !== undefined && goalCurrency in FIAT_CENTS) {
    const field = FIAT_CENTS[goalCurrency as FiatCode];
    const priced = payers.map((payer) => ({
      accountId: payer.accountId,
      cents: payer[field],
    }));
    if (priced.every((payer) => typeof payer.cents === 'string')) {
      const parsed = priced.map((payer) => ({
        accountId: payer.accountId,
        units: fiatAmountToCents(payer.cents as string),
      }));
      if (parsed.every((payer) => payer.units !== null)) {
        return parsed.map((payer) => ({
          accountId: payer.accountId,
          units: payer.units as bigint,
        }));
      }
    }
    if (goalAmount === null || goalAmount === undefined) {
      return 'unavailable';
    }
    const goal = fiatAmountToCents(goalAmount);
    if (goal === null) {
      return 'unavailable';
    }
    return allocateByWeight(
      goal,
      payers.map((payer) => ({ accountId: payer.accountId, units: BigInt(payer.sats) })),
    );
  }
  return payers.map((payer) => ({ accountId: payer.accountId, units: BigInt(payer.sats) }));
}

function allocateByWeight(
  total: bigint,
  weights: readonly { accountId: string; units: bigint }[],
): { accountId: string; units: bigint }[] {
  const usable = weights.filter((weight) => weight.units > 0n && weight.accountId !== '');
  const sum = usable.reduce((acc, weight) => acc + weight.units, 0n);
  if (sum <= 0n || total <= 0n) {
    return [];
  }
  const shares = usable.map((weight) => ({
    accountId: weight.accountId,
    units: (total * weight.units) / sum,
    rem: (total * weight.units) % sum,
  }));
  let leftover = total - shares.reduce((acc, share) => acc + share.units, 0n);
  const order = [...shares].sort((a, b) => {
    if (a.rem !== b.rem) {
      return a.rem > b.rem ? -1 : 1;
    }
    return a.accountId.localeCompare(b.accountId);
  });
  for (const share of order) {
    if (leftover <= 0n) {
      break;
    }
    share.units += 1n;
    leftover -= 1n;
  }
  return shares
    .filter((share) => share.units > 0n)
    .map((share) => ({ accountId: share.accountId, units: share.units }));
}

/** Whether a planned share is still ahead, due, or already paid. */
export type RepaymentLineStatus = 'scheduled' | 'due' | 'paid';

/** One giver's repayment on one day of the term. */
export interface RepaymentLedgerLine {
  /** Zero-based day. */
  dayIndex: number;
  /** UTC calendar day `YYYY-MM-DD`, or null before the credit is fully given. */
  dueOn: string | null;
  /** Giver account id. */
  accountId: string;
  /** Whole sats or whole cents. */
  units: bigint;
  /** Paid, due today or earlier, or not yet due. */
  status: RepaymentLineStatus;
}

/**
 * UTC date of one repayment day. Day 0 is the UTC day after the credit filled.
 *
 * @param fundedAtMs - When collected sats first reached the goal.
 * @param dayIndex - Zero-based day in the term.
 * @returns `YYYY-MM-DD` in UTC.
 */
export function repaymentDueDate(fundedAtMs: number, dayIndex: number): string {
  const ms = repaymentStartMs(fundedAtMs) + dayIndex * 86_400_000;
  return new Date(ms).toISOString().slice(0, 10);
}

/**
 * Cents as a two-decimal amount. The caller passes a non-negative total.
 *
 * @param cents - Whole cents.
 * @returns `whole.frac`.
 */
export function formatCents(cents: bigint): string {
  const whole = cents / 100n;
  const frac = (cents % 100n).toString().padStart(2, '0');
  return `${whole}.${frac}`;
}

/**
 * Every repayment share, in day order, with a date once the credit has filled.
 *
 * @param days - Term length.
 * @param payers - Positive contributions. Their units are the debt.
 * @param paid - Shares already stored.
 * @param fundedAtMs - When the credit filled, or null while it is still open.
 * @param nowMs - Clock.
 * @returns One row per non-zero share.
 */
export function repaymentLedger(
  days: number,
  payers: readonly { accountId: string; units: bigint }[],
  paid: readonly { dayIndex: number; accountId: string }[],
  fundedAtMs: number | null,
  nowMs: number,
): RepaymentLedgerLine[] {
  const slices = repaymentSchedule(days, payers);
  const settled = new Set(paid.map((row) => `${row.dayIndex}:${row.accountId}`));
  const daysDue = fundedAtMs === null ? 0 : dueDayCount(fundedAtMs, nowMs, days);
  return slices.map((slice) => ({
    dayIndex: slice.dayIndex,
    dueOn: fundedAtMs === null ? null : repaymentDueDate(fundedAtMs, slice.dayIndex),
    accountId: slice.accountId,
    units: slice.units,
    status: settled.has(`${slice.dayIndex}:${slice.accountId}`)
      ? 'paid'
      : slice.dayIndex < daysDue
        ? 'due'
        : 'scheduled',
  }));
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
