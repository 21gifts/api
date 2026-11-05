/**
 * The payout gate as one read: the funding grant plus, only when it can
 * change the answer, whether a 21.gifts recovery share is stored for the
 * account's current verified wallet. Every payout path calls this instead of
 * reading the grant and calling {@link eligibleToday} itself, except two pings
 * that follow a write. The staff trial and admit ping checks the share inside
 * `pingTodayMedia` (`requireShare: true`). The first-share ping of
 * `PUT /me/recovery-share` calls {@link eligibleToday} with `true` directly,
 * because the share was just stored. Before the share's start day
 * ({@link recoveryShareRequired}) the share is neither read nor needed.
 */

import type { Account, AuthStore } from '@/lib/auth/store';
import { eligibleToday, recoveryShareRequired, type FundingGrant } from '@/lib/funding';
import type { FundingStore } from '@/lib/funding-store';

/**
 * Load the grant and decide whether the account may be paid today.
 *
 * The share is read only on a day it is required
 * ({@link recoveryShareRequired}) and only for a non-`basis` account in the
 * grant program today (`inGrantProgramToday`). Otherwise the share cannot
 * change the answer and is not read.
 *
 * @param fundingStore - Grant persistence (`getByAccountId`, no lazy trial persist).
 * @param auth - Auth store for {@link AuthStore.hasRecoveryShareForVerifiedWallet}.
 * @param account - Account to pay (id and live role).
 * @param nowMs - Epoch milliseconds (UTC day).
 * @param recoveryShareRequiredFrom - First UTC day the share is required, or
 *   `null` when it is not required yet.
 * @returns The stored grant (for `effectiveStatus`) and {@link eligibleToday}
 *   with the share fact.
 * @throws Whatever either store throws.
 */
export async function loadPayoutEligibility(
  fundingStore: Pick<FundingStore, 'getByAccountId'>,
  auth: Pick<AuthStore, 'hasRecoveryShareForVerifiedWallet'>,
  account: Pick<Account, 'id' | 'role'>,
  nowMs: number,
  recoveryShareRequiredFrom: string | null,
): Promise<{ grant: FundingGrant | undefined; eligible: boolean }> {
  const grant = await fundingStore.getByAccountId(account.id);
  const shareDecides =
    recoveryShareRequired(nowMs, recoveryShareRequiredFrom) &&
    eligibleToday(account.role, grant, nowMs, true, recoveryShareRequiredFrom);
  const shareStored = shareDecides
    ? await auth.hasRecoveryShareForVerifiedWallet(account.id)
    : false;
  return {
    grant,
    eligible: eligibleToday(account.role, grant, nowMs, shareStored, recoveryShareRequiredFrom),
  };
}
