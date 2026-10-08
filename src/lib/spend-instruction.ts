/**
 * Decide the USD amount and memo for a spend ping from a live roster object.
 */

import type { GiftRow } from '@/lib/gift';

/** Effective funding status used when an unlisted daily address is paid. */
export type SpendGrantStatus = 'none' | 'pending' | 'trial' | 'admitted' | 'rejected';

/**
 * Decide whether this ping carries a USD amount and comment.
 *
 * @param input - Recipient address, ping kind, live roster JSON,
 *   optional daily grant status, and optional same-UTC-day welcome flag.
 * @returns The amount and comment to POST, or a skip reason.
 */
export function decideSpendInstruction(input: {
  address: string;
  kind: 'daily' | 'moderator' | 'welcome';
  roster: unknown;
  grantStatus?: SpendGrantStatus;
  welcomePaidOnUtcDay?: boolean;
}):
  | { amountUsd: number; comment: string }
  | { skip: 'payments_disabled' | 'not_listed' | 'undecided' | 'welcome_paid' } {
  const record = asRosterRecord(input.roster);
  if (input.kind === 'daily') {
    if (record !== undefined && record['paymentsEnabled'] === false) {
      return { skip: 'payments_disabled' };
    }
    if (input.welcomePaidOnUtcDay === true) {
      return { skip: 'welcome_paid' };
    }
    const row = findCountableRow(
      record === undefined ? undefined : record['recipients'],
      input.address,
    );
    if (row !== undefined) {
      return { amountUsd: row.amountUsd, comment: rosterComment(record) };
    }
    if (input.grantStatus === 'admitted' || input.grantStatus === 'trial') {
      const rawDefault = record === undefined ? undefined : record['defaultAmountUsd'];
      if (typeof rawDefault === 'number' && Number.isFinite(rawDefault) && rawDefault > 0) {
        return { amountUsd: rawDefault, comment: rosterComment(record) };
      }
      return { amountUsd: 1, comment: rosterComment(record) };
    }
    if (
      input.grantStatus === 'none' ||
      input.grantStatus === 'pending' ||
      input.grantStatus === 'rejected'
    ) {
      return { skip: 'not_listed' };
    }
    return { skip: 'undecided' };
  }
  if (input.kind === 'welcome') {
    if (record !== undefined && record['paymentsEnabled'] === false) {
      return { skip: 'payments_disabled' };
    }
    return { amountUsd: 1, comment: 'Welcome' };
  }
  if (record === undefined || !('moderators' in record)) {
    return { skip: 'undecided' };
  }
  if (record['moderatorPaymentsEnabled'] === false) {
    return { skip: 'payments_disabled' };
  }
  const row = findCountableRow(record['moderators'], input.address);
  if (row === undefined) {
    return { skip: 'not_listed' };
  }
  return { amountUsd: row.amountUsd, comment: '21gifts moderator' };
}

/**
 * Whether `gifts` already records a welcome gift for `address` on `utcDay`.
 *
 * Matches `kind === 'welcome'` only. Handles are the trimmed local part
 * before the first `@` (or the whole trimmed string when there is no `@`),
 * compared case-insensitively. Empty handles and invalid `paidAt` values
 * do not match. `utcDay` is the caller's `YYYY-MM-DD` and is not recomputed.
 *
 * @param gifts - Outbound gift rows.
 * @param address - Lightning Address or handle to match.
 * @param utcDay - UTC calendar day `YYYY-MM-DD`.
 * @returns `true` when at least one gift matches kind, handle, and day.
 */
export function welcomeGiftPaidOnUtcDay(
  gifts: readonly GiftRow[],
  address: string,
  utcDay: string,
): boolean {
  const addressHandle = handleOf(address);
  if (addressHandle === '') {
    return false;
  }
  return gifts.some((gift) => {
    if (gift.kind !== 'welcome') {
      return false;
    }
    const recipientHandle = handleOf(gift.recipientWosUser);
    if (recipientHandle === '') {
      return false;
    }
    if (recipientHandle.toLowerCase() !== addressHandle.toLowerCase()) {
      return false;
    }
    const paidAt: unknown = gift.paidAt;
    if (!(paidAt instanceof Date) || Number.isNaN(paidAt.getTime())) {
      return false;
    }
    return paidAt.toISOString().slice(0, 10) === utcDay;
  });
}

/** Trimmed local part before the first `@`, or the whole trimmed string. */
function handleOf(value: string): string {
  const trimmed = value.trim();
  const at = trimmed.indexOf('@');
  if (at === -1) {
    return trimmed;
  }
  return trimmed.slice(0, at).trim();
}

function asRosterRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

function rosterComment(record: Record<string, unknown> | undefined): string {
  if (record === undefined) {
    return '';
  }
  const comment = record['comment'];
  if (typeof comment === 'string') {
    return comment;
  }
  return '';
}

function findCountableRow(
  value: unknown,
  address: string,
): { address: string; amountUsd: number } | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const needle = address.toLowerCase();
  for (const item of value) {
    if (typeof item !== 'object' || item === null) {
      continue;
    }
    const row = item as Record<string, unknown>;
    const rowAddress = row['address'];
    const amountUsd = row['amountUsd'];
    if (typeof rowAddress !== 'string') {
      continue;
    }
    if (typeof amountUsd !== 'number' || !Number.isFinite(amountUsd) || amountUsd <= 0) {
      continue;
    }
    if (rowAddress.toLowerCase() === needle) {
      return { address: rowAddress, amountUsd };
    }
  }
  return undefined;
}
