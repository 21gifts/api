/** One owner-facing explanation of today's daily grant payout. */

import type { Account, AuthStore } from '@/lib/auth/store';
import { roleAtLeast } from '@/lib/auth/roles';
import type { DailyRosterStore } from '@/lib/daily-roster-store';
import {
  effectiveStatus,
  inGrantProgramToday,
  recoveryShareRequired,
  utcDayKey,
} from '@/lib/funding';
import type { FundingStore } from '@/lib/funding-store';
import type { FxSpotStore } from '@/lib/fx-spot-store';
import type { GiftRow } from '@/lib/gift';
import type { GiftStore } from '@/lib/gift-store';
import { latestTodayMediaPostId } from '@/lib/funding-ping';
import { addUtcDays } from '@/lib/member-habit';
import type { MessageStore } from '@/lib/message-store';
import { dailyShopSatsRequiredForGrant } from '@/lib/shop-spend-minimum';
import type { WalletTransferStore } from '@/lib/wallet-transfer-store';
import { isWelcomeRecipient } from '@/lib/welcome-media';

/**
 * Stable owner-facing reason codes for today's grant payout.
 *
 * `payments_paused` remains part of the wire contract for older clients, but
 * a disabled daily roster now fails closed as `shop_payment` before it can be
 * returned.
 */
export type FundingPayoutTodayReason =
  | 'welcome'
  | 'verify'
  | 'admission'
  | 'wallet'
  | 'recovery_share'
  | 'shop_payment'
  | 'media_post'
  | 'payments_paused';

/** Exactly one state and, when useful, one reason for today's grant payout. */
export interface FundingPayoutToday {
  state: 'paid' | 'due' | 'blocked';
  reason: FundingPayoutTodayReason | null;
}

/** Store collaborators read by {@link loadFundingPayoutToday}. */
export interface FundingPayoutTodayDeps {
  gifts: Pick<GiftStore, 'listOutbound'>;
  funding: Pick<FundingStore, 'getByAccountId'>;
  auth: Pick<AuthStore, 'hasRecoveryShareForVerifiedWallet'>;
  transfers: Pick<WalletTransferStore, 'hasShopPayment'>;
  messages: Pick<MessageStore, 'latestLiveTopLevelMediaId' | 'getById'>;
  roster: Pick<DailyRosterStore, 'get'>;
  /** Stored BTC-USD spot for the daily grant's 50 % shop-spend minimum. */
  fxSpot: Pick<FxSpotStore, 'latest'>;
  recoveryShareRequiredFrom: string | null;
}

function handleOf(value: string): string {
  const trimmed = value.trim().toLowerCase();
  const at = trimmed.indexOf('@');
  return at === -1 ? trimmed : trimmed.slice(0, at).trim();
}

function paidKindToday(
  gifts: readonly GiftRow[],
  username: string | null | undefined,
  day: string,
  kind: 'daily' | 'welcome',
): boolean {
  const recipient = handleOf(username ?? '');
  return (
    recipient !== '' &&
    gifts.some(
      (gift) =>
        gift.kind === kind &&
        handleOf(gift.recipientWosUser) === recipient &&
        utcDayKey(gift.paidAt.getTime()) === day,
    )
  );
}

/**
 * Compute the first applicable explanation for today's daily grant payout.
 *
 * Reads are deliberately serialized in product order. A recorded daily gift
 * wins first, followed by a same-day welcome gift. That welcome row has the
 * `welcome` reason only for an eligible welcome recipient; for any other
 * account it remains paid with no reason and still suppresses a daily payout.
 * Each later store is read only when every preceding condition holds. Store
 * errors propagate so the owner route can return `null` without failing the
 * rest of `GET /me`.
 *
 * @param deps - Gift, grant, recovery, transfer, forum, and roster reads.
 * @param account - Current owner account.
 * @param nowMs - Current epoch milliseconds; its UTC day is evaluated.
 * @returns Today's paid, blocked, or due state and its single reason.
 */
export async function loadFundingPayoutToday(
  deps: FundingPayoutTodayDeps,
  account: Pick<Account, 'id' | 'role' | 'username' | 'sparkPubkeyVerifiedAt' | 'isPlatform'>,
  nowMs: number,
): Promise<FundingPayoutToday> {
  const today = utcDayKey(nowMs);
  const gifts = await deps.gifts.listOutbound();
  if (paidKindToday(gifts, account.username, today, 'daily')) {
    return { state: 'paid', reason: null };
  }
  if (paidKindToday(gifts, account.username, today, 'welcome')) {
    return {
      state: 'paid',
      reason: isWelcomeRecipient(account) ? 'welcome' : null,
    };
  }
  if (!roleAtLeast(account.role, 'verified')) {
    return { state: 'blocked', reason: 'verify' };
  }
  const grant = await deps.funding.getByAccountId(account.id);
  if (!inGrantProgramToday(grant, nowMs)) {
    return { state: 'blocked', reason: 'admission' };
  }
  if (typeof account.sparkPubkeyVerifiedAt !== 'number') {
    return { state: 'blocked', reason: 'wallet' };
  }
  if (
    recoveryShareRequired(nowMs, deps.recoveryShareRequiredFrom) &&
    !(await deps.auth.hasRecoveryShareForVerifiedWallet(account.id))
  ) {
    return { state: 'blocked', reason: 'recovery_share' };
  }
  const roster = await deps.roster.get();
  const spot = await deps.fxSpot.latest();
  const minimum = dailyShopSatsRequiredForGrant({
    roster,
    spotUsd: spot?.rates.USD ?? null,
    accountId: account.id,
    grantStatus: effectiveStatus(grant, nowMs),
  });
  if (
    minimum === null ||
    !(await deps.transfers.hasShopPayment(account.id, addUtcDays(today, -1), today, minimum))
  ) {
    return { state: 'blocked', reason: 'shop_payment' };
  }
  if ((await latestTodayMediaPostId(deps.messages, account.id, nowMs)) === null) {
    return { state: 'blocked', reason: 'media_post' };
  }
  return { state: 'due', reason: null };
}
