/**
 * Minimum shop spending that a daily grant requires, in whole sats.
 *
 * A daily grant pays only when the member's qualifying shop payments on the
 * payout UTC day and the day before sum to at least half of the grant. The
 * grant amount and the stored BTC-USD spot are the same facts the daily
 * payout instruction uses; a missing spot or an undecided roster fails
 * closed.
 */

import type { DailyRosterDocument } from '@/lib/daily-roster';
import { usdToMsat } from '@/lib/money';
import { decideSpendInstruction, type SpendGrantStatus } from '@/lib/spend-instruction';

/**
 * Half of one daily grant, rounded up to whole sats.
 *
 * @param amountUsd - Daily grant in USD, as decided by the roster.
 * @param spotUsd - Stored USD-per-BTC decimal text, or `null` when no usable
 *   quote is stored.
 * @returns `ceil(grantSats / 2)` with `grantSats = floor(msat / 1000)`, or
 *   `null` when the spot is missing/unusable or the USD amount cannot be
 *   converted.
 */
export function dailyShopSatsRequired(amountUsd: number, spotUsd: string | null): number | null {
  if (spotUsd === null) {
    return null;
  }
  const msat = usdToMsat(String(amountUsd), spotUsd);
  if (msat === null) {
    return null;
  }
  const grantSats = Math.floor(msat / 1000);
  return Math.ceil(grantSats / 2);
}

/**
 * Minimum shop spending for one account's daily grant, from the live roster.
 *
 * The grant USD is exactly what {@link decideSpendInstruction} decides for a
 * daily payout with the account's effective grant status. A roster that
 * decides a skip, a missing spot, or an unconvertible amount returns `null`
 * so the caller can fail closed.
 *
 * @param input - Live roster document, stored USD spot, paying account id,
 *   optional receiving address (the stored roster matches by account id),
 *   and effective grant status.
 * @returns The required whole sats, or `null` when they cannot be computed.
 */
export function dailyShopSatsRequiredForGrant(input: {
  roster: DailyRosterDocument;
  spotUsd: string | null;
  accountId: string;
  address?: string;
  grantStatus: SpendGrantStatus;
}): number | null {
  const decided = decideSpendInstruction({
    address: input.address ?? '',
    accountId: input.accountId,
    kind: 'daily',
    roster: input.roster,
    grantStatus: input.grantStatus,
  });
  if ('skip' in decided) {
    return null;
  }
  return dailyShopSatsRequired(decided.amountUsd, input.spotUsd);
}
