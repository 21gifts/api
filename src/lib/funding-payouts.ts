import type { AccountRole } from '@/lib/auth/store';
import type { FundingGrant } from '@/lib/funding';
import type { GiftRow } from '@/lib/gift';

/**
 * One cell of the staff payout matrix.
 *
 * `blocked` is not entitled that UTC day. `missed` is entitled and no daily
 * payout was recorded. `paid` is a `daily` gift that UTC day. This is the
 * post-gate grant rule. Cleared trial or admission history and the spend
 * roster are not reconstructed. Welcome gifts and moderator stipends are
 * ignored.
 */
export type PayoutDayCell = 'blocked' | 'missed' | 'paid';

/** Account fields the matrix needs. No other profile data. */
export interface PayoutMatrixAccount {
  /** Account id. */
  id: string;
  /** Display name, possibly blank. */
  name: string | null;
  /** Live role. `basis` is never entitled. */
  role: AccountRole;
  /** Lightning address used to match `gift.recipient_wos_user`, or null. */
  lightningAddress: string | null;
}

/** One person across the seven UTC days, oldest first. */
export interface PayoutMatrixRow {
  /** Account id, or null when a daily gift matches no account. */
  accountId: string | null;
  /** Trimmed display name, or the lowercased handle when there is no account. */
  name: string | null;
  /** Seven cells, same order as {@link PayoutMatrix.days}. */
  days: readonly [
    PayoutDayCell,
    PayoutDayCell,
    PayoutDayCell,
    PayoutDayCell,
    PayoutDayCell,
    PayoutDayCell,
    PayoutDayCell,
  ];
}

/** Seven UTC days and the people who were entitled or paid in that window. */
export interface PayoutMatrix {
  /** Oldest first. The last entry is the UTC day of `nowMs`. */
  days: readonly [string, string, string, string, string, string, string];
  /** Named rows first, then unnamed. */
  rows: readonly PayoutMatrixRow[];
}

const MS_PER_DAY = 86_400_000;

/**
 * UTC calendar day `YYYY-MM-DD`.
 *
 * @param ms - Epoch milliseconds.
 * @returns The UTC day key.
 */
function utcDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/**
 * Local part of a Lightning address or Wallet of Satoshi handle.
 *
 * @param value - Raw address or handle.
 * @returns Trimmed lowercase text before the first `@`, or the whole string.
 */
function localPart(value: string): string {
  const trimmed = value.trim().toLowerCase();
  const at = trimmed.indexOf('@');
  return at === -1 ? trimmed : trimmed.slice(0, at);
}

/**
 * Seven UTC days ending on `nowMs`, oldest first.
 *
 * @param nowMs - Epoch milliseconds.
 * @returns The window.
 */
function weekDays(nowMs: number): PayoutMatrix['days'] {
  const start = Date.parse(`${utcDay(nowMs)}T00:00:00.000Z`) - 6 * MS_PER_DAY;
  const at = (offset: number): string =>
    new Date(start + offset * MS_PER_DAY).toISOString().slice(0, 10);
  return [at(0), at(1), at(2), at(3), at(4), at(5), at(6)];
}

/**
 * Whether the stored grant entitles this role on `day`.
 *
 * `basis` is never entitled. Admitted is entitled from `admittedAt`'s UTC
 * day (or every day when `admittedAt` is null). A stored `trialUtcDate`
 * entitles that one day even when the status is no longer `trial`.
 *
 * @param role - Live role.
 * @param grant - Stored grant, if any.
 * @param day - UTC day `YYYY-MM-DD`.
 * @returns `true` when the day is entitled.
 */
function entitled(role: AccountRole, grant: FundingGrant | undefined, day: string): boolean {
  if (role === 'basis' || grant === undefined) {
    return false;
  }
  const admitted =
    grant.status === 'admitted' && (grant.admittedAt === null || utcDay(grant.admittedAt) <= day);
  return admitted || grant.trialUtcDate === day;
}

/**
 * Cell color token. A recorded daily payout wins over entitlement.
 *
 * @param paid - A daily gift exists that day.
 * @param isEntitled - The grant rule entitles that day.
 * @returns The cell.
 */
function cell(paid: boolean, isEntitled: boolean): PayoutDayCell {
  if (paid) {
    return 'paid';
  }
  if (isEntitled) {
    return 'missed';
  }
  return 'blocked';
}

/**
 * Seven cells for one person.
 *
 * @param days - Window, oldest first.
 * @param paidDays - UTC days with a daily gift.
 * @param role - Live role.
 * @param grant - Stored grant, if any.
 * @returns The week.
 */
function weekCells(
  days: PayoutMatrix['days'],
  paidDays: ReadonlySet<string>,
  role: AccountRole,
  grant: FundingGrant | undefined,
): PayoutMatrixRow['days'] {
  return [
    cell(paidDays.has(days[0]), entitled(role, grant, days[0])),
    cell(paidDays.has(days[1]), entitled(role, grant, days[1])),
    cell(paidDays.has(days[2]), entitled(role, grant, days[2])),
    cell(paidDays.has(days[3]), entitled(role, grant, days[3])),
    cell(paidDays.has(days[4]), entitled(role, grant, days[4])),
    cell(paidDays.has(days[5]), entitled(role, grant, days[5])),
    cell(paidDays.has(days[6]), entitled(role, grant, days[6])),
  ];
}

/**
 * True when the row should appear (entitled or paid on at least one day).
 *
 * @param days - Seven cells.
 * @returns `true` when any cell is `missed` or `paid`.
 */
function visible(days: readonly PayoutDayCell[]): boolean {
  return days.some((day) => day === 'missed' || day === 'paid');
}

/**
 * Order rows: named first (base English), then account id, unmatched handles last.
 *
 * @param a - Left row.
 * @param b - Right row.
 * @returns Negative when `a` comes first, positive when `b` does, else 0.
 */
export function comparePayoutRows(a: PayoutMatrixRow, b: PayoutMatrixRow): number {
  const aNamed = a.name !== null;
  const bNamed = b.name !== null;
  if (aNamed !== bNamed) {
    return aNamed ? -1 : 1;
  }
  if (a.name !== null && b.name !== null) {
    const cmp = a.name.localeCompare(b.name, 'en', { sensitivity: 'base' });
    if (cmp !== 0) {
      return cmp;
    }
  }
  const aLoose = a.accountId === null ? 1 : 0;
  const bLoose = b.accountId === null ? 1 : 0;
  if (aLoose !== bLoose) {
    return aLoose - bLoose;
  }
  if (a.accountId !== null && b.accountId !== null && a.accountId !== b.accountId) {
    return a.accountId < b.accountId ? -1 : 1;
  }
  return 0;
}

/**
 * Staff matrix of theoretical grant entitlement and collected daily payouts.
 *
 * @param input - Clock, accounts, stored grants, and outbound gifts. The last
 *   column is the UTC day of `nowMs`. Grants are not passed through lazy trial
 *   expiry. Only `kind === 'daily'` inside the window marks a day paid.
 * @returns Seven days and the included rows, named first.
 */
export function buildFundingPayoutMatrix(input: {
  nowMs: number;
  accounts: readonly PayoutMatrixAccount[];
  grants: readonly FundingGrant[];
  gifts: readonly GiftRow[];
}): PayoutMatrix {
  const days = weekDays(input.nowMs);
  const daySet = new Set<string>(days);
  const grantsById = new Map<string, FundingGrant>();
  for (const grant of input.grants) {
    grantsById.set(grant.accountId, grant);
  }
  const byPart = new Map<string, PayoutMatrixAccount[]>();
  for (const account of input.accounts) {
    if (account.lightningAddress === null) {
      continue;
    }
    const part = localPart(account.lightningAddress);
    if (part === '') {
      continue;
    }
    const list = byPart.get(part) ?? [];
    list.push(account);
    byPart.set(part, list);
  }
  for (const list of byPart.values()) {
    list.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  }

  const paidByAccount = new Map<string, Set<string>>();
  const unmatched = new Map<string, Set<string>>();
  for (const gift of input.gifts) {
    if (gift.kind !== 'daily') {
      continue;
    }
    const day = utcDay(gift.paidAt.getTime());
    if (!daySet.has(day)) {
      continue;
    }
    const part = localPart(gift.recipientWosUser);
    if (part === '') {
      continue;
    }
    const owners = byPart.get(part);
    if (owners === undefined) {
      const set = unmatched.get(part) ?? new Set<string>();
      set.add(day);
      unmatched.set(part, set);
    } else {
      const winner = owners[0] as PayoutMatrixAccount;
      const set = paidByAccount.get(winner.id) ?? new Set<string>();
      set.add(day);
      paidByAccount.set(winner.id, set);
    }
  }

  const rows: PayoutMatrixRow[] = [];
  for (const account of input.accounts) {
    const paid = paidByAccount.get(account.id) ?? new Set<string>();
    const cells = weekCells(days, paid, account.role, grantsById.get(account.id));
    if (!visible(cells)) {
      continue;
    }
    const trimmed = (account.name ?? '').trim();
    rows.push({
      accountId: account.id,
      name: trimmed === '' ? null : trimmed,
      days: cells,
    });
  }
  for (const [part, paid] of unmatched) {
    rows.push({
      accountId: null,
      name: part,
      days: weekCells(days, paid, 'verified', undefined),
    });
  }

  rows.sort(comparePayoutRows);

  return { days, rows };
}
