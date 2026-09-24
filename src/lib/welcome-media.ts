import type { Account, AuthStore } from '@/lib/auth/store';
import { logEvent } from '@/lib/log';
import { MESSAGE_LIST_LIMIT } from '@/lib/message';
import type { MessageStore } from '@/lib/message-store';
import type { SpendPing } from '@/lib/spend-ping';

/**
 * Whether a listed note has a photo, extra stills, or a video.
 *
 * @param row - Live top-level row from the message store.
 * @returns `true` when the note has media.
 */
function noteHasMedia(row: {
  hasPhoto: boolean;
  hasVideo?: boolean;
  photoCount?: number;
}): boolean {
  if (row.hasPhoto === true) {
    return true;
  }
  if (row.hasVideo === true) {
    return true;
  }
  return (row.photoCount ?? 0) > 0;
}

/**
 * Newest live top-level photo or video for a verified account, including
 * the About-me note. The list is newest-first and capped; an older About-me
 * photo still counts when it is the profile note.
 *
 * @param messages - Forum store.
 * @param account - Account whose media would earn the welcome gift.
 * @returns Message id, or `null` when the role is not `verified` or no live
 *   top-level media exists. The caller checks the Lightning Address.
 */
async function welcomeMediaMessageId(
  messages: MessageStore,
  account: Account,
): Promise<string | null> {
  if (account.role !== 'verified') {
    return null;
  }
  const posts = await messages.listPostsByAccount(account.id, MESSAGE_LIST_LIMIT);
  const listed = posts.find((row) => noteHasMedia(row));
  if (listed !== undefined) {
    return listed.id;
  }
  const profileId = account.profileMessageId;
  if (typeof profileId !== 'string' || profileId.trim() === '') {
    return null;
  }
  const profile = await messages.getById(profileId);
  if (
    profile === undefined ||
    profile.deletedAt !== null ||
    profile.parentId !== null ||
    profile.accountId !== account.id ||
    !noteHasMedia(profile)
  ) {
    return null;
  }
  return profile.id;
}

/**
 * Ping spend once for `account` when a welcome photo or video exists.
 * Failures are logged. Does not throw.
 *
 * @param args - Spend ping, forum store, and account.
 */
async function pingOne(args: {
  spendPing: SpendPing | undefined;
  messages: MessageStore;
  account: Account;
}): Promise<void> {
  if (args.spendPing === undefined) {
    return;
  }
  const address =
    args.account.lightningAddress === null ? '' : args.account.lightningAddress.trim();
  if (address === '') {
    return;
  }
  try {
    const messageId = await welcomeMediaMessageId(args.messages, args.account);
    if (messageId === null) {
      return;
    }
    await args.spendPing.ping(address, messageId, 'welcome');
  } catch {
    logEvent('spend.ping.failed');
  }
}

/**
 * Welcome-ping every verified account that already has a live top-level
 * photo or video, including About me and a living-room post. Spend pays
 * once per address. Failures are logged per account.
 *
 * @param args - Spend ping, auth store, and forum store.
 */
async function catchUpVerifiedMedia(args: {
  spendPing: SpendPing | undefined;
  auth: AuthStore;
  messages: MessageStore;
}): Promise<void> {
  if (args.spendPing === undefined) {
    return;
  }
  let accounts: Account[];
  try {
    accounts = await args.auth.listAccounts();
  } catch {
    logEvent('spend.ping.failed');
    return;
  }
  for (const account of accounts) {
    if (account.role !== 'verified') {
      continue;
    }
    try {
      const hasMedia = await args.messages.accountHasLiveTopLevelMediaPost(account.id, null);
      if (!hasMedia) {
        continue;
      }
      await pingOne({ spendPing: args.spendPing, messages: args.messages, account });
    } catch {
      logEvent('spend.ping.failed');
    }
  }
}

/**
 * Tell spend a verified account is owed the one-time welcome gift.
 *
 * Pass `account` after a new top-level post, an About-me save, or a
 * verification. Pass `auth` (and no `account`) to catch up people who are
 * already verified and already have a photo or video post. Omitted spend
 * ping, a role other than `verified`, a blank Lightning Address, or no
 * photo/video is a no-op. Spend pays once per address.
 *
 * @param args - Spend ping plus either one account or the auth store.
 */
export async function syncWelcomePing(args: {
  spendPing?: SpendPing;
  messages: MessageStore;
  account?: Account;
  auth?: AuthStore;
}): Promise<void> {
  if (args.account !== undefined) {
    await pingOne({
      spendPing: args.spendPing,
      messages: args.messages,
      account: args.account,
    });
    return;
  }
  if (args.auth !== undefined) {
    await catchUpVerifiedMedia({
      spendPing: args.spendPing,
      auth: args.auth,
      messages: args.messages,
    });
  }
}
