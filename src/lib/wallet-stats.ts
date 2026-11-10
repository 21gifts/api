/**
 * Public wallet totals: carried-forward balances per UTC day. No per-account
 * value leaves this module.
 */

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
  /** Wallets with at least one snapshot overall. */
  walletCount: number;
  /** Wallets whose newest snapshot overall has a positive balance. */
  fundedWalletCount: number;
  /** Sum of every wallet's newest snapshot overall. */
  totalSats: number;
  /** {@link WalletStats.totalSats} as an eight-decimal BTC string. */
  totalBtc: string;
  /** Newest snapshot receipt instant, or null for an empty table. */
  asOf: string | null;
  /** Gap-free UTC days from the first snapshot through today. */
  balanceOverTime: WalletBalanceDay[];
}

function utcDay(instant: Date): string {
  return instant.toISOString().slice(0, 10);
}

function nextUtcDay(day: string): string {
  const year = Number(day.slice(0, 4));
  const month = Number(day.slice(5, 7));
  const date = Number(day.slice(8, 10));
  return new Date(Date.UTC(year, month - 1, date + 1)).toISOString().slice(0, 10);
}

/** UTF-8 byte order, the same order as Postgres `uuid` text comparison for hex ids. */
function byteOrder(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'));
}

function isLater(candidate: WalletBalanceSnapshot, current: WalletBalanceSnapshot): boolean {
  const byTime = candidate.receivedAt.getTime() - current.receivedAt.getTime();
  return byTime > 0 || (byTime === 0 && byteOrder(candidate.id, current.id) > 0);
}

function safeSatsTotal(total: bigint): number {
  const value = Number(total);
  if (!Number.isSafeInteger(value)) {
    throw new Error('wallet sats total exceeds Number.MAX_SAFE_INTEGER');
  }
  return value;
}

/**
 * Build public wallet totals from the last snapshot of each account and UTC day.
 *
 * An account's balance carries forward over days without a report. A wallet
 * exists from its first snapshot day onward. A balance of 0 stays in
 * `walletCount` but not in `fundedWalletCount`.
 *
 * @param rows - Last snapshots per account and UTC day. Order is ignored.
 * @param nowMs - Clock returning epoch milliseconds.
 * @returns Empty stats for no rows; otherwise a gap-free series through today.
 * @throws If a current or daily total exceeds `Number.MAX_SAFE_INTEGER`.
 */
export function buildWalletStats(
  rows: readonly WalletBalanceSnapshot[],
  nowMs: number,
): WalletStats {
  if (rows.length === 0) {
    return {
      walletCount: 0,
      fundedWalletCount: 0,
      totalSats: 0,
      totalBtc: satsToBtcString(0),
      asOf: null,
      balanceOverTime: [],
    };
  }

  const byAccountDay = new Map<string, WalletBalanceSnapshot>();
  const latestByAccount = new Map<string, WalletBalanceSnapshot>();
  let firstDay: string | undefined;
  let latestRow: WalletBalanceSnapshot | undefined;
  for (const row of rows) {
    const day = utcDay(row.receivedAt);
    firstDay = firstDay === undefined || day < firstDay ? day : firstDay;
    latestRow = latestRow === undefined || isLater(row, latestRow) ? row : latestRow;
    const dayKey = `${row.accountId}\u0000${day}`;
    const currentDay = byAccountDay.get(dayKey);
    if (currentDay === undefined || isLater(row, currentDay)) {
      byAccountDay.set(dayKey, row);
    }
    const currentAccount = latestByAccount.get(row.accountId);
    if (currentAccount === undefined || isLater(row, currentAccount)) {
      latestByAccount.set(row.accountId, row);
    }
  }

  let totalSats = 0n;
  let fundedWalletCount = 0;
  for (const row of latestByAccount.values()) {
    totalSats += BigInt(row.balanceSats);
    if (row.balanceSats > 0) {
      fundedWalletCount += 1;
    }
  }
  const currentTotalSats = safeSatsTotal(totalSats);

  const snapshotsByDay = new Map<string, WalletBalanceSnapshot[]>();
  for (const row of byAccountDay.values()) {
    const day = utcDay(row.receivedAt);
    const rowsOnDay = snapshotsByDay.get(day) ?? [];
    rowsOnDay.push(row);
    snapshotsByDay.set(day, rowsOnDay);
  }
  const endDay = new Date(nowMs).toISOString().slice(0, 10);
  const balances = new Map<string, number>();
  const balanceOverTime: WalletBalanceDay[] = [];
  const first = firstDay as string;
  for (let day = first; day <= endDay; day = nextUtcDay(day)) {
    for (const row of snapshotsByDay.get(day) ?? []) {
      balances.set(row.accountId, row.balanceSats);
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

  return {
    walletCount: latestByAccount.size,
    fundedWalletCount,
    totalSats: currentTotalSats,
    totalBtc: satsToBtcString(currentTotalSats),
    asOf: (latestRow as WalletBalanceSnapshot).receivedAt.toISOString(),
    balanceOverTime,
  };
}
