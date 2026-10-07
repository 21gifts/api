/**
 * Decide the USD amount and memo for a spend ping from a live roster object.
 */

/** Effective funding status used when an unlisted daily address is paid. */
export type SpendGrantStatus = 'none' | 'pending' | 'trial' | 'admitted' | 'rejected';

/**
 * Decide whether this ping carries a USD amount and comment.
 *
 * @param input - Recipient address, ping kind, live roster JSON, and
 *   optional daily grant status.
 * @returns The amount and comment to POST, or a skip reason.
 */
export function decideSpendInstruction(input: {
  address: string;
  kind: 'daily' | 'moderator' | 'welcome';
  roster: unknown;
  grantStatus?: SpendGrantStatus;
}):
  | { amountUsd: number; comment: string }
  | { skip: 'payments_disabled' | 'not_listed' | 'undecided' } {
  const record = asRosterRecord(input.roster);
  if (input.kind === 'daily') {
    if (record !== undefined && record['paymentsEnabled'] === false) {
      return { skip: 'payments_disabled' };
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
