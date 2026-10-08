/**
 * Decide the USD amount and memo for a spend ping from a live roster object.
 */

import { DAILY_ROSTER_DEFAULT_AMOUNT_USD } from '@/lib/daily-roster-store';
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
    const row = findCountableRow(
      record === undefined ? undefined : record['recipients'],
      input.address,
    );
    let decided: { amountUsd: number; comment: string } | { skip: 'not_listed' | 'undecided' };
    if (row !== undefined) {
      decided = { amountUsd: row.amountUsd, comment: rosterComment(record) };
    } else if (input.grantStatus === 'admitted' || input.grantStatus === 'trial') {
      const rawDefault = record === undefined ? undefined : record['defaultAmountUsd'];
      if (typeof rawDefault === 'number' && Number.isFinite(rawDefault) && rawDefault > 0) {
        decided = { amountUsd: rawDefault, comment: rosterComment(record) };
      } else {
        decided = { amountUsd: DAILY_ROSTER_DEFAULT_AMOUNT_USD, comment: rosterComment(record) };
      }
    } else if (
      input.grantStatus === 'none' ||
      input.grantStatus === 'pending' ||
      input.grantStatus === 'rejected'
    ) {
      decided = { skip: 'not_listed' };
    } else {
      decided = { skip: 'undecided' };
    }
    if ('skip' in decided) {
      return decided;
    }
    if (input.welcomePaidOnUtcDay === true && decided.comment !== 'Welcome') {
      return { skip: 'welcome_paid' };
    }
    return decided;
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
 * Decide whether the spend worker should pay a daily gift from already-known
 * facts: passkey, post, media, eligibility, and the live roster.
 *
 * @param input - Recipient address, passkey / post / media / funding facts,
 *   live roster JSON, optional daily grant status, and optional same-UTC-day
 *   welcome flag.
 * @returns A skip reason, or the amount, comment, and optional message id.
 */
export function decideCliDailyInstruction(input: {
  address: string;
  hasPasskey: boolean;
  hasPosted: boolean;
  hasMedia: boolean;
  eligible: boolean;
  messageId: string | null;
  roster: unknown;
  grantStatus?: SpendGrantStatus;
  welcomePaidOnUtcDay?: boolean;
}):
  | {
      action: 'skip';
      reason:
        | 'no_passkey'
        | 'no_post'
        | 'no_media'
        | 'not_eligible'
        | 'payments_disabled'
        | 'not_listed'
        | 'undecided'
        | 'welcome_paid';
    }
  | { action: 'pay'; amountUsd: number; comment: string; messageId?: string } {
  if (!input.hasPasskey) {
    return { action: 'skip', reason: 'no_passkey' };
  }
  if (!input.hasPosted) {
    return { action: 'skip', reason: 'no_post' };
  }
  if (!input.hasMedia) {
    return { action: 'skip', reason: 'no_media' };
  }
  if (!input.eligible) {
    return { action: 'skip', reason: 'not_eligible' };
  }
  const decided = decideSpendInstruction({
    address: input.address,
    kind: 'daily',
    roster: input.roster,
    ...(input.grantStatus === undefined ? {} : { grantStatus: input.grantStatus }),
    ...(input.welcomePaidOnUtcDay === undefined
      ? {}
      : { welcomePaidOnUtcDay: input.welcomePaidOnUtcDay }),
  });
  if ('skip' in decided) {
    return { action: 'skip', reason: decided.skip };
  }
  if (typeof input.messageId === 'string' && input.messageId !== '') {
    return {
      action: 'pay',
      amountUsd: decided.amountUsd,
      comment: decided.comment,
      messageId: input.messageId,
    };
  }
  return {
    action: 'pay',
    amountUsd: decided.amountUsd,
    comment: decided.comment,
  };
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
