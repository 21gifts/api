/**
 * Daily spend ping for a member who just became payable today: after staff
 * put a grant on trial or admit it, and after the member first stores the
 * 21.gifts recovery share of the current wallet.
 */

import type { Account, AuthStore } from '@/lib/auth/store';
import type { LnurlServerConfig } from '@/lib/config';
import { recoveryShareRequired, utcDayKey } from '@/lib/funding';
import { logEvent } from '@/lib/log';
import { addUtcDays } from '@/lib/member-habit';
import type { MessageStore } from '@/lib/message-store';
import { receivingAddress } from '@/lib/receiving-address';
import type { SpendGrantStatus } from '@/lib/spend-instruction';
import type { SpendPing } from '@/lib/spend-ping';
import type { WalletTransferStore } from '@/lib/wallet-transfer-store';

/** Collaborators of {@link pingTodayMedia}. */
export interface TodayMediaPingDeps {
  /** Spend ping. Omitted → no ping. */
  spendPing?: SpendPing;
  /** LNURL server config for the receiving address. Omitted → no address, no ping. */
  lnurlServer?: LnurlServerConfig;
  /** Forum store for the newest live top-level photo or video. */
  messageStore: Pick<MessageStore, 'latestLiveTopLevelMediaId' | 'getById'>;
  /** Auth store for the recovery share check when `requireShare` is set. */
  authStore: Pick<AuthStore, 'hasRecoveryShareForVerifiedWallet'>;
  /** First UTC day the 21.gifts recovery share is required for a payout (`RECOVERY_SHARE_REQUIRED_FROM`). Omitted or `null` → not required yet. */
  recoveryShareRequiredFrom?: string | null;
  /** Server-verified transfers for the mandatory recent shop payment. */
  walletTransfers?: Pick<WalletTransferStore, 'hasShopPayment'>;
}

/**
 * Newest live top-level photo or video by an account when it was posted on
 * the supplied UTC day.
 *
 * @param messages - Forum lookups used by the payout trigger.
 * @param accountId - Author account id.
 * @param nowMs - Epoch milliseconds whose UTC day must match.
 * @returns The post id, or `null` when today's qualifying post is absent.
 */
export async function latestTodayMediaPostId(
  messages: Pick<MessageStore, 'latestLiveTopLevelMediaId' | 'getById'>,
  accountId: string,
  nowMs: number,
): Promise<string | null> {
  const id = await messages.latestLiveTopLevelMediaId(accountId);
  if (id === null) {
    return null;
  }
  const row = await messages.getById(id);
  if (row === undefined || utcDayKey(row.createdAt.getTime()) !== utcDayKey(nowMs)) {
    return null;
  }
  return id;
}

/**
 * Daily spend ping for the newest live top-level photo or video posted
 * today UTC. No-op when spend ping is omitted, the account has no receiving
 * address, or there is no such post. With `requireShare` on a day the share is
 * required ({@link recoveryShareRequired}), an account without a 21.gifts recovery share for its
 * current verified wallet is not pinged (`spend.ping.skipped`,
 * `not_eligible`). Share read, lookup, and ping failures are logged as
 * `funding.daily_ping.failed` and returned as `failed`, so this never throws.
 *
 * @param deps - Spend ping, LNURL server config, forum store, and auth store.
 * @param account - Account to ping, read after the write that made it payable.
 * @param nowMs - Clock of that write (epoch ms).
 * @param grantStatus - Effective grant status after the write.
 * @param requireShare - `true` when the caller has not checked the recovery
 *   share (staff trial and admit); `false` when the share was just stored.
 * @returns Whether the ping was sent, skipped, or failed. Failures are logged
 *   and returned rather than thrown.
 */
export async function pingTodayMedia(
  deps: TodayMediaPingDeps,
  account: Account,
  nowMs: number,
  grantStatus: SpendGrantStatus,
  requireShare: boolean,
): Promise<'sent' | 'skipped' | 'failed'> {
  if (deps.spendPing === undefined) {
    return 'skipped';
  }
  const address = receivingAddress(account, deps.lnurlServer)?.address ?? null;
  if (address === null) {
    return 'skipped';
  }
  try {
    if (
      deps.walletTransfers !== undefined &&
      !(await deps.walletTransfers.hasShopPayment(
        account.id,
        addUtcDays(utcDayKey(nowMs), -1),
        utcDayKey(nowMs),
      ))
    ) {
      logEvent('spend.ping.skipped', { reason: 'no_shop_payment' });
      return 'skipped';
    }
    if (
      requireShare &&
      recoveryShareRequired(nowMs, deps.recoveryShareRequiredFrom ?? null) &&
      !(await deps.authStore.hasRecoveryShareForVerifiedWallet(account.id))
    ) {
      logEvent('spend.ping.skipped', { reason: 'not_eligible' });
      return 'skipped';
    }
    const id = await latestTodayMediaPostId(deps.messageStore, account.id, nowMs);
    if (id === null) {
      return 'skipped';
    }
    const outcome = await deps.spendPing.ping(address, id, 'daily', grantStatus);
    if (outcome?.status === 'failed') {
      logEvent('funding.daily_ping.failed', { accountId: account.id });
      return 'failed';
    }
    if (outcome?.status === 'skipped') return 'skipped';
    return 'sent';
  } catch {
    logEvent('funding.daily_ping.failed', { accountId: account.id });
    return 'failed';
  }
}
