import type { Account, AuthStore } from '@/lib/auth/store';
import type { LnurlServerConfig } from '@/lib/config';
import type { GiftStore } from '@/lib/gift-store';
import { logEvent } from '@/lib/log';
import type { MessageStore } from '@/lib/message-store';
import { receivingAddress } from '@/lib/receiving-address';
import type { SpendPing } from '@/lib/spend-ping';

/**
 * Newest live top-level photo or video for a verified account, including
 * the About-me note. Not limited to the newest page of notes.
 *
 * @param messages - Forum store.
 * @param account - Account whose media would earn the welcome gift.
 * @returns Message id, or `null` when the role is not `verified` or no live
 *   top-level media exists. The caller checks the receiving address.
 */
async function welcomeMediaMessageId(
  messages: MessageStore,
  account: Account,
): Promise<string | null> {
  if (account.role !== 'verified') {
    return null;
  }
  return messages.latestLiveTopLevelMediaId(account.id);
}

/**
 * Id of the official platform account, or `null` when none is configured.
 *
 * @param accounts - Every stored account.
 * @returns The platform account id, or `null`.
 */
function platformAccountId(accounts: readonly Account[]): string | null {
  return accounts.find((account) => account.isPlatform === true)?.id ?? null;
}

/**
 * Lower-case recipient handles of every recorded welcome gift. A welcome paid
 * to a wallet address is recorded under the member's username.
 *
 * @param gifts - Outbound gift store, or `undefined` (no gift records read).
 * @returns The handle set (empty without a store).
 */
async function welcomedHandles(
  gifts: Pick<GiftStore, 'listOutbound'> | undefined,
): Promise<ReadonlySet<string>> {
  if (gifts === undefined) {
    return new Set();
  }
  return new Set(
    (await gifts.listOutbound())
      .filter((row) => row.kind === 'welcome')
      .map((row) => row.recipientWosUser.trim().toLowerCase()),
  );
}

/**
 * Ping spend once for `account` when a welcome photo or video exists and the
 * account has not received the welcome gift yet. Failures are logged. Does
 * not throw.
 *
 * The welcome gift is once per account: a platform `Welcome` reply under one
 * of the account's notes, or a recorded welcome gift under its username, means
 * it was paid, whichever address it went to.
 *
 * @param args - Spend ping, forum store, account, platform account id, the
 *   recorded welcome handles, and LNURL server config.
 */
async function pingOne(args: {
  spendPing: SpendPing;
  messages: MessageStore;
  account: Account;
  platformId: string | null;
  welcomed: ReadonlySet<string>;
  lnurlServer: LnurlServerConfig | undefined;
}): Promise<void> {
  const address = receivingAddress(args.account, args.lnurlServer)?.address ?? null;
  if (address === null) {
    return;
  }
  try {
    const messageId = await welcomeMediaMessageId(args.messages, args.account);
    if (messageId === null) {
      return;
    }
    if (
      args.welcomed.has(address.slice(0, address.lastIndexOf('@'))) ||
      (args.platformId !== null &&
        (await args.messages.accountHasWelcomeGift(args.account.id, args.platformId)))
    ) {
      logEvent('spend.ping.skipped', { reason: 'welcomed' });
      return;
    }
    await args.spendPing.ping(address, messageId, 'welcome');
  } catch {
    logEvent('spend.ping.failed');
  }
}

/**
 * Welcome-ping every verified account that already has a live top-level
 * photo or video, including About me and a living-room post, and has not
 * received the welcome gift yet. Failures are logged per account.
 *
 * @param args - Spend ping, auth store, forum store, optional gift store, and
 *   LNURL server config.
 */
async function catchUpVerifiedMedia(args: {
  spendPing: SpendPing | undefined;
  auth: Pick<AuthStore, 'listAccounts'>;
  messages: MessageStore;
  gifts: Pick<GiftStore, 'listOutbound'> | undefined;
  lnurlServer: LnurlServerConfig | undefined;
}): Promise<void> {
  if (args.spendPing === undefined) {
    return;
  }
  let accounts: Account[];
  let welcomed: ReadonlySet<string>;
  try {
    accounts = await args.auth.listAccounts();
    welcomed = await welcomedHandles(args.gifts);
  } catch {
    logEvent('spend.ping.failed');
    return;
  }
  const platformId = platformAccountId(accounts);
  for (const account of accounts) {
    if (account.role !== 'verified') {
      continue;
    }
    try {
      const mediaId = await args.messages.latestLiveTopLevelMediaId(account.id);
      if (mediaId === null) {
        continue;
      }
      await pingOne({
        spendPing: args.spendPing,
        messages: args.messages,
        account,
        platformId,
        welcomed,
        lnurlServer: args.lnurlServer,
      });
    } catch {
      logEvent('spend.ping.failed');
    }
  }
}

/**
 * Tell spend a verified account is owed the one-time welcome gift.
 *
 * Pass `account` after a new top-level post, an About-me save, or a
 * verification. Omit `account` to catch up people who are already verified
 * and already have a photo or video post. `auth` is always required: it finds
 * the platform account whose `Welcome` reply marks a paid welcome gift.
 * Omitted spend ping, a role other than `verified`, no receiving address (no
 * verified wallet, or the LNURL server off), no photo/video, or a welcome gift
 * already paid to the account (a platform `Welcome` reply under one of its
 * notes, or a recorded `welcome` gift under its username in `gifts`) is a
 * no-op. The gift is once per account, not
 * once per address, so a member whose receiving address changed is not paid
 * twice.
 *
 * @param args - Spend ping, forum store, auth store, optional gift store,
 *   optional LNURL server config, and optionally one account.
 */
export async function syncWelcomePing(args: {
  spendPing?: SpendPing;
  messages: MessageStore;
  auth: Pick<AuthStore, 'listAccounts'>;
  gifts?: Pick<GiftStore, 'listOutbound'> | undefined;
  account?: Account;
  lnurlServer?: LnurlServerConfig;
}): Promise<void> {
  if (args.account !== undefined) {
    if (args.spendPing === undefined) {
      return;
    }
    let platformId: string | null;
    let welcomed: ReadonlySet<string>;
    try {
      platformId = platformAccountId(await args.auth.listAccounts());
      welcomed = await welcomedHandles(args.gifts);
    } catch {
      logEvent('spend.ping.failed');
      return;
    }
    await pingOne({
      spendPing: args.spendPing,
      messages: args.messages,
      account: args.account,
      platformId,
      welcomed,
      lnurlServer: args.lnurlServer,
    });
    return;
  }
  await catchUpVerifiedMedia({
    spendPing: args.spendPing,
    auth: args.auth,
    messages: args.messages,
    gifts: args.gifts,
    lnurlServer: args.lnurlServer,
  });
}
