import type { Account, AuthStore } from '@/lib/auth/store';
import { unsignedNostrDefaults, type MessageRow } from '@/lib/message';
import type { MessageStore } from '@/lib/message-store';
import type { ConversationStore } from '@/lib/conversation-store';
import type { NotificationStore } from '@/lib/notification-store';
import type { PushStore } from '@/lib/push-store';

/**
 * Ensure the account has exactly one top-level profile forum note when a
 * non-blank display name and a non-blank Lightning Address are present.
 *
 * No-ops (returns the input account, no `messages.create`) when the name or
 * Lightning Address is null/blank after trim. When both are set, the first
 * insert creates one kind:1-pipeline message and claims `profileMessageId`.
 * A `profileMessageId` whose row is missing or soft-hidden (`deletedAt` set)
 * is treated as missing. Rename does not insert a second note and does not
 * change the note text when the existing note is live. A successful insert
 * claims `profileMessageId` here (`claimProfileMessageId`), then re-reads
 * the live row so a later writer's live `profileMessageId` wins and this
 * insert is deleted. A lost claim deletes the insert and adopts a live
 * winner when one exists. A hidden winner is missing: the created live note
 * is kept and `profileMessageId` is claimed onto it. A failed insert returns
 * the input account (name may still be persisted by the caller; worker
 * backfill creates the missing note once LN is linked). A won insert does
 * not fan out `notifyForumPost`: the note text is the display name.
 *
 * @param args - Auth store, message store, account snapshot, clock, optional
 *   push, notification, and conversation stores.
 * @returns The account (unchanged, or with `profileMessageId` set after insert).
 */
export async function ensureProfileMessage(args: {
  auth: AuthStore;
  messages: MessageStore;
  account: Account;
  now: () => number;
  pushStore?: PushStore;
  notifications?: NotificationStore;
  conversations?: ConversationStore;
}): Promise<Account> {
  const trimmed = args.account.name === null ? '' : args.account.name.trim();
  if (trimmed === '') {
    return args.account;
  }
  const ln = args.account.lightningAddress === null ? '' : args.account.lightningAddress.trim();
  if (ln === '') {
    return args.account;
  }

  const existingId = args.account.profileMessageId;
  if (typeof existingId === 'string' && existingId.trim() !== '') {
    const existing = await args.messages.getById(existingId);
    if (existing !== undefined && existing.deletedAt === null) {
      return args.account;
    }
  }

  const messageId = crypto.randomUUID();
  const row: MessageRow = {
    id: messageId,
    accountId: args.account.id,
    name: trimmed,
    text: trimmed,
    createdAt: new Date(args.now()),
    hasPhoto: false,
    hasVideo: false,
    videoContentType: null,
    ...unsignedNostrDefaults(),
  };

  let created: MessageRow;
  try {
    created = await args.messages.create(row);
  } catch {
    return args.account;
  }

  const live = await args.auth.getAccount(args.account.id);
  if (live === undefined) {
    await args.messages.deleteById(created.id);
    return args.account;
  }
  const liveId = live.profileMessageId;
  if (typeof liveId === 'string' && liveId.trim() !== '') {
    const winner = await args.messages.getById(liveId);
    if (winner !== undefined && winner.deletedAt === null) {
      await args.messages.deleteById(created.id);
      return live;
    }
  }

  const expectedId =
    typeof live.profileMessageId === 'string' && live.profileMessageId.trim() !== ''
      ? live.profileMessageId
      : null;
  try {
    const claimed = await args.auth.claimProfileMessageId(live.id, expectedId, created.id);
    if (!claimed) {
      await args.messages.deleteById(created.id);
      const after = await args.auth.getAccount(args.account.id);
      if (after === undefined) {
        return live;
      }
      const afterId = after.profileMessageId;
      if (typeof afterId === 'string' && afterId.trim() !== '') {
        const winner = await args.messages.getById(afterId);
        if (winner !== undefined && winner.deletedAt === null) {
          return after;
        }
      }
      return after;
    }
  } catch {
    await args.messages.deleteById(created.id);
    return live;
  }

  const confirmed = await args.auth.getAccount(args.account.id);
  if (confirmed === undefined || confirmed.profileMessageId !== created.id) {
    await args.messages.deleteById(created.id);
    return confirmed === undefined ? live : confirmed;
  }

  return { ...live, profileMessageId: created.id };
}
