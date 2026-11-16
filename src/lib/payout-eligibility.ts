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
import type { DailyRosterStore } from '@/lib/daily-roster-store';
import {
  effectiveStatus,
  eligibleToday,
  recoveryShareRequired,
  utcDayKey,
  type FundingGrant,
} from '@/lib/funding';
import type { FundingStore } from '@/lib/funding-store';
import type { FxSpotStore } from '@/lib/fx-spot-store';
import { addUtcDays } from '@/lib/member-habit';
import { dailyShopSatsRequiredForGrant } from '@/lib/shop-spend-minimum';
import type { WalletTransferStore } from '@/lib/wallet-transfer-store';

/** Collaborators that decide a daily grant's 50 % shop-spend minimum. */
export interface DailyShopMinimumDeps {
  /** Live daily payout roster; omitted fails closed. */
  roster?: Pick<DailyRosterStore, 'get'>;
  /** Stored BTC-USD spot quote (one row). Never fetched. */
  fxSpot?: Pick<FxSpotStore, 'latest'>;
  /** Recipient Lightning Address when known; the stored roster matches by account id. */
  address?: string;
}

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
 * @param walletTransfers - Server-verified transfer store. Production callers
 *   pass it; omitted legacy callers retain their pre-viewer behavior.
 * @param shopPaymentUtcDay - UTC payout day whose day and preceding day form
 *   the shop-payment window. Defaults to the UTC day of `nowMs`.
 * @param minShopSats - Inclusive minimum shop spending in whole sats.
 *   Defaults to 1; `null` fails closed. Ignored when `dailyShop` is passed.
 * @param dailyShop - Daily roster, stored spot, and recipient address. When
 *   passed, the minimum is half the daily grant (rounded up) and is `null`
 *   whenever it cannot be computed, so the payout fails closed.
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
  walletTransfers?: Pick<WalletTransferStore, 'hasShopPayment'>,
  shopPaymentUtcDay = utcDayKey(nowMs),
  minShopSats: number | null = 1,
  dailyShop?: DailyShopMinimumDeps,
): Promise<{
  grant: FundingGrant | undefined;
  eligible: boolean;
  reason?: 'no_shop_payment';
}> {
  const grant = await fundingStore.getByAccountId(account.id);
  const shareDecides =
    recoveryShareRequired(nowMs, recoveryShareRequiredFrom) &&
    eligibleToday(account.role, grant, nowMs, true, recoveryShareRequiredFrom, true);
  const shareStored = shareDecides
    ? await auth.hasRecoveryShareForVerifiedWallet(account.id)
    : false;
  const otherwiseEligible = eligibleToday(
    account.role,
    grant,
    nowMs,
    shareStored,
    recoveryShareRequiredFrom,
    true,
  );
  let shopPaymentRecent = true;
  if (otherwiseEligible && walletTransfers !== undefined) {
    const minimum = await shopMinimum(dailyShop, minShopSats, account.id, grant, nowMs);
    shopPaymentRecent =
      minimum !== null &&
      (await walletTransfers.hasShopPayment(
        account.id,
        addUtcDays(shopPaymentUtcDay, -1),
        shopPaymentUtcDay,
        minimum,
      ));
  }
  return {
    grant,
    eligible: eligibleToday(
      account.role,
      grant,
      nowMs,
      shareStored,
      recoveryShareRequiredFrom,
      shopPaymentRecent,
    ),
    ...(otherwiseEligible && !shopPaymentRecent ? { reason: 'no_shop_payment' as const } : {}),
  };
}

/**
 * Required shop sats for this payout.
 *
 * @param dailyShop - Optional daily roster, spot, and address.
 * @param minShopSats - Explicit minimum when `dailyShop` is omitted.
 * @param accountId - Paying account id.
 * @param grant - Stored grant.
 * @param nowMs - Epoch milliseconds (UTC day).
 * @returns The inclusive minimum, or `null` when it cannot be computed.
 * @throws Whatever the roster or spot store throws.
 */
async function shopMinimum(
  dailyShop: DailyShopMinimumDeps | undefined,
  minShopSats: number | null,
  accountId: string,
  grant: FundingGrant | undefined,
  nowMs: number,
): Promise<number | null> {
  if (dailyShop === undefined) {
    return minShopSats;
  }
  if (dailyShop.roster === undefined || dailyShop.fxSpot === undefined) {
    return null;
  }
  const roster = await dailyShop.roster.get();
  const spot = await dailyShop.fxSpot.latest();
  return dailyShopSatsRequiredForGrant({
    roster,
    spot,
    accountId,
    grantStatus: effectiveStatus(grant, nowMs),
    ...(dailyShop.address === undefined ? {} : { address: dailyShop.address }),
  });
}
