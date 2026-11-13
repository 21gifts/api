/**
 * Public wallet totals: carried-forward balances per UTC day. No per-account
 * value leaves this module.
 */

import { utcDayKey } from '@/lib/funding';
import { addUtcDays } from '@/lib/member-habit';
import { satsToBtcString } from '@/lib/money';
import type { WalletBalanceSnapshot } from '@/lib/wallet-store';

/** One UTC day of public wallet totals. */
export interface WalletBalanceDay {
  /** `YYYY-MM-DD` in UTC. */
  day: string;
  /** Sum of every wallet balance at the end of this day. */
  totalSats: number;
  /** {@link WalletBalanceDay.totalSats} as an eight-decimal BTC string. */
  totalBtc: string;
  /** Wallets with at least one snapshot on or before this day. */
  walletCount: number;
  /** Wallets whose carried-forward balance is greater than 0. */
  fundedWalletCount: number;
}

/** Public `GET /wallets/stats` body. */
export interface WalletStats {
  /** Wallets with at least one snapshot on or before the current UTC day. */
  walletCount: number;
  /** Wallets whose carried-forward balance on the current UTC day is positive. */
  fundedWalletCount: number;
  /** Sum of every wallet's carried-forward balance on the current UTC day. */
  totalSats: number;
  /** {@link WalletStats.totalSats} as an eight-decimal BTC string. */
  totalBtc: string;
  /** Newest visible snapshot receipt instant, or null when none is visible. */
  asOf: string | null;
  /** Gap-free UTC days from the first visible snapshot through today. */
  balanceOverTime: WalletBalanceDay[];
}

/** UTF-8 byte order, the same order as Postgres `uuid` text comparison for hex ids. */
function byteOrder(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'));
}

function isLater(candidate: WalletBalanceSnapshot, current: WalletBalanceSnapshot): boolean {
  const byTime = candidate.receivedAt.getTime() - current.receivedAt.getTime();
  return byTime > 0 || (byTime === 0 && byteOrder(candidate.id, current.id) > 0);
}

function walletIdentity(row: WalletBalanceSnapshot): string {
  return `${row.accountId}\u0000${row.walletPubkey ?? ''}`;
}

function safeSatsTotal(total: bigint): number {
  const value = Number(total);
  if (!Number.isSafeInteger(value)) {
    throw new Error('wallet sats total exceeds Number.MAX_SAFE_INTEGER');
  }
  return value;
}

function emptyWalletStats(): WalletStats {
  return {
    walletCount: 0,
    fundedWalletCount: 0,
    totalSats: 0,
    totalBtc: satsToBtcString(0),
    asOf: null,
    balanceOverTime: [],
  };
}

/**
 * Build public wallet totals from the visible snapshots of each wallet identity and UTC day.
 *
 * A `(accountId, walletPubkey)` balance carries forward over days without a report. Legacy
 * null-key rows represent the account only while it has no visible keyed row; they are a
 * migration fallback, not an additional wallet beside keyed rows. A wallet exists from its
 * first snapshot day onward. A balance of 0 stays in `walletCount` but not in
 * `fundedWalletCount`. Snapshots after the current UTC day are ignored by both the series and
 * the headline values.
 *
 * @param rows - Last snapshots per account, wallet key, and UTC day. Order is ignored.
 * @param nowMs - Clock returning epoch milliseconds.
 * @returns Empty stats when no row is visible; otherwise a gap-free series through today.
 * @throws If a current or daily total exceeds `Number.MAX_SAFE_INTEGER`.
 */
export function buildWalletStats(
  rows: readonly WalletBalanceSnapshot[],
  nowMs: number,
): WalletStats {
  const endDay = utcDayKey(nowMs);
  const visibleRows = rows.filter((row) => utcDayKey(row.receivedAt.getTime()) <= endDay);
  if (visibleRows.length === 0) {
    return emptyWalletStats();
  }
  const accountsWithKeyedRows = new Set(
    visibleRows.filter((row) => typeof row.walletPubkey === 'string').map((row) => row.accountId),
  );
  const selectedRows = visibleRows.filter(
    (row) => typeof row.walletPubkey === 'string' || !accountsWithKeyedRows.has(row.accountId),
  );

  const byWalletDay = new Map<string, WalletBalanceSnapshot>();
  let firstDay: string | undefined;
  let latestVisibleRow: WalletBalanceSnapshot | undefined;
  for (const row of selectedRows) {
    const day = utcDayKey(row.receivedAt.getTime());
    firstDay = firstDay === undefined || day < firstDay ? day : firstDay;
    latestVisibleRow =
      latestVisibleRow === undefined || isLater(row, latestVisibleRow) ? row : latestVisibleRow;
    const dayKey = `${walletIdentity(row)}\u0000${day}`;
    const currentDay = byWalletDay.get(dayKey);
    if (currentDay === undefined || isLater(row, currentDay)) {
      byWalletDay.set(dayKey, row);
    }
  }

  const snapshotsByDay = new Map<string, WalletBalanceSnapshot[]>();
  for (const row of byWalletDay.values()) {
    const day = utcDayKey(row.receivedAt.getTime());
    const rowsOnDay = snapshotsByDay.get(day) ?? [];
    rowsOnDay.push(row);
    snapshotsByDay.set(day, rowsOnDay);
  }
  const balances = new Map<string, number>();
  const balanceOverTime: WalletBalanceDay[] = [];
  const first = firstDay as string;
  for (let day = first; day <= endDay; day = addUtcDays(day, 1)) {
    for (const row of snapshotsByDay.get(day) ?? []) {
      balances.set(walletIdentity(row), row.balanceSats);
    }
    let dayTotalSats = 0n;
    let dayFunded = 0;
    for (const balance of balances.values()) {
      dayTotalSats += BigInt(balance);
      if (balance > 0) {
        dayFunded += 1;
      }
    }
    const dayTotal = safeSatsTotal(dayTotalSats);
    balanceOverTime.push({
      day,
      totalSats: dayTotal,
      totalBtc: satsToBtcString(dayTotal),
      walletCount: balances.size,
      fundedWalletCount: dayFunded,
    });
  }

  const lastDay = balanceOverTime[balanceOverTime.length - 1] as WalletBalanceDay;
  return {
    walletCount: lastDay.walletCount,
    fundedWalletCount: lastDay.fundedWalletCount,
    totalSats: lastDay.totalSats,
    totalBtc: lastDay.totalBtc,
    asOf: (latestVisibleRow as WalletBalanceSnapshot).receivedAt.toISOString(),
    balanceOverTime,
  };
}
