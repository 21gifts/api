/**
 * Daily spend ping for a member who just became payable today: after staff
 * put a grant on trial or admit it, and after the member first stores the
 * 21.gifts recovery share of the current wallet.
 */

import type { Account, AuthStore } from '@/lib/auth/store';
import type { LnurlServerConfig } from '@/lib/config';
import { fundingGrantRequired, utcDayKey } from '@/lib/funding';
import { logEvent } from '@/lib/log';
import type { MessageStore } from '@/lib/message-store';
import { receivingAddress } from '@/lib/receiving-address';
import type { SpendGrantStatus } from '@/lib/spend-instruction';
import type { SpendPing } from '@/lib/spend-ping';

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
}

/**
 * Daily spend ping for the newest live top-level photo or video posted
 * today UTC. No-op when spend ping is omitted, the account has no receiving
 * address, or there is no such post. With `requireShare` on a day the grant
 * gate is in force, an account without a 21.gifts recovery share for its
 * current verified wallet is not pinged (`spend.ping.skipped`,
 * `not_eligible`). Share read, lookup, and ping failures are logged as
 * `funding.daily_ping.failed` and swallowed, so this never throws.
 *
 * @param deps - Spend ping, LNURL server config, forum store, and auth store.
 * @param account - Account to ping, read after the write that made it payable.
 * @param nowMs - Clock of that write (epoch ms).
 * @param grantStatus - Effective grant status after the write.
 * @param requireShare - `true` when the caller has not checked the recovery
 *   share (staff trial and admit); `false` when the share was just stored.
 */
export async function pingTodayMedia(
  deps: TodayMediaPingDeps,
  account: Account,
  nowMs: number,
  grantStatus: SpendGrantStatus,
  requireShare: boolean,
): Promise<void> {
  if (deps.spendPing === undefined) {
    return;
  }
  const address = receivingAddress(account, deps.lnurlServer)?.address ?? null;
  if (address === null) {
    return;
  }
  try {
    if (
      requireShare &&
      fundingGrantRequired(nowMs) &&
      !(await deps.authStore.hasRecoveryShareForVerifiedWallet(account.id))
    ) {
      logEvent('spend.ping.skipped', { address, reason: 'not_eligible' });
      return;
    }
    const id = await deps.messageStore.latestLiveTopLevelMediaId(account.id);
    if (id === null) {
      return;
    }
    const row = await deps.messageStore.getById(id);
    if (row === undefined) {
      return;
    }
    if (utcDayKey(row.createdAt.getTime()) !== utcDayKey(nowMs)) {
      return;
    }
    await deps.spendPing.ping(address, id, 'daily', grantStatus);
  } catch {
    logEvent('funding.daily_ping.failed', { accountId: account.id });
  }
}
