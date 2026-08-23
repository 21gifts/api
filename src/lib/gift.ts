/**
 * Gift statistics domain: outbound gift rows and pure aggregation.
 *
 * The HTTP surface never includes invoices or other payment secrets — only
 * amounts, UTC days, and Wallet of Satoshi recipient handles.
 */

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
}

/** Totals for one recipient. */
export interface RecipientSpend {
  /** Wallet of Satoshi username. */
  recipient: string;
  /** Number of outbound gifts to this recipient. */
  giftCount: number;
  /** Sats paid to this recipient. */
  sats: number;
}

/** Totals for one UTC calendar month. */
export interface MonthSpend {
  /** UTC month `YYYY-MM`. */
  month: string;
  /** Number of outbound gifts in this month. */
  giftCount: number;
  /** Sats paid in this month. */
  sats: number;
}

/** Aggregated public gift statistics. */
export interface GiftStats {
  /** Sum of `amountSats` across all rows. */
  totalSats: number;
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
 * Empty input yields zeros, null dates, and empty series. Days between the
 * first and last gift are filled with `sats: 0` so cumulative spend is a
 * continuous UTC series.
 *
 * @param rows - Outbound gifts (order does not matter).
 * @returns Aggregated {@link GiftStats}.
 */
export function buildGiftStats(rows: readonly GiftRow[]): GiftStats {
  if (rows.length === 0) {
    return {
      totalSats: 0,
      giftCount: 0,
      recipientCount: 0,
      firstPaidAt: null,
      lastPaidAt: null,
      spendOverTime: [],
      byRecipient: [],
      byMonth: [],
    };
  }

  const sorted = [...rows].sort((a, b) => a.paidAt.getTime() - b.paidAt.getTime());
  const first = sorted[0] as GiftRow;
  const last = sorted[sorted.length - 1] as GiftRow;

  const byDay = new Map<string, number>();
  const byRecipient = new Map<string, { giftCount: number; sats: number }>();
  const byMonth = new Map<string, { giftCount: number; sats: number }>();
  let totalSats = 0;

  for (const row of sorted) {
    totalSats += row.amountSats;
    const day = utcDayString(row.paidAt);
    byDay.set(day, (byDay.get(day) ?? 0) + row.amountSats);
    const rec = byRecipient.get(row.recipientWosUser) ?? { giftCount: 0, sats: 0 };
    rec.giftCount += 1;
    rec.sats += row.amountSats;
    byRecipient.set(row.recipientWosUser, rec);
    const month = utcMonthString(row.paidAt);
    const mon = byMonth.get(month) ?? { giftCount: 0, sats: 0 };
    mon.giftCount += 1;
    mon.sats += row.amountSats;
    byMonth.set(month, mon);
  }

  const spendOverTime: SpendDay[] = [];
  let cumulativeSats = 0;
  const startMs = utcDayMs(utcDayString(first.paidAt));
  const endMs = utcDayMs(utcDayString(last.paidAt));
  for (let ms = startMs; ms <= endMs; ms += MS_PER_DAY) {
    const day = new Date(ms).toISOString().slice(0, 10);
    const sats = byDay.get(day) ?? 0;
    cumulativeSats += sats;
    spendOverTime.push({ day, sats, cumulativeSats });
  }

  const recipients: RecipientSpend[] = [...byRecipient.entries()]
    .map(([recipient, totals]) => ({
      recipient,
      giftCount: totals.giftCount,
      sats: totals.sats,
    }))
    .sort((a, b) => b.sats - a.sats || a.recipient.localeCompare(b.recipient));

  const months: MonthSpend[] = [...byMonth.entries()]
    .map(([month, totals]) => ({
      month,
      giftCount: totals.giftCount,
      sats: totals.sats,
    }))
    .sort((a, b) => a.month.localeCompare(b.month));

  return {
    totalSats,
    giftCount: sorted.length,
    recipientCount: byRecipient.size,
    firstPaidAt: first.paidAt.toISOString(),
    lastPaidAt: last.paidAt.toISOString(),
    spendOverTime,
    byRecipient: recipients,
    byMonth: months,
  };
}
