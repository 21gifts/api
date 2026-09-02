import type { Account, AuthStore } from '@/lib/auth/store';
import { logEvent } from '@/lib/log';
import { unsignedNostrDefaults, type MessageRow } from '@/lib/message';
import type { MessageStore } from '@/lib/message-store';
import type { PushStore } from '@/lib/push-store';
import { enqueueForumPushes } from '@/lib/push-worker';

/**
 * Ensure the account has exactly one top-level profile forum note when a
 * non-blank display name is present.
 *
 * First persisted non-empty name inserts one kind:1-pipeline message and
 * stores `profileMessageId`. Rename does not insert a second note and does
 * not change the note text. A successful insert updates the account here.
 * A failed insert returns the input account (name may still be persisted by
 * the caller; worker backfill creates the missing note).
 *
 * @param args - Auth store, message store, account snapshot, clock, optional push.
 * @returns The account (unchanged, or with `profileMessageId` set after insert).
 */
export async function ensureProfileMessage(args: {
  auth: AuthStore;
  messages: MessageStore;
  account: Account;
  now: () => number;
  pushStore?: PushStore;
}): Promise<Account> {
  const trimmed = args.account.name === null ? '' : args.account.name.trim();
  if (trimmed === '') {
    return args.account;
  }

  const existingId = args.account.profileMessageId;
  if (typeof existingId === 'string' && existingId.trim() !== '') {
    const existing = await args.messages.getById(existingId);
    if (existing !== undefined) {
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
    if (winner !== undefined) {
      await args.messages.deleteById(created.id);
      return live;
    }
  }

  const updated: Account = {
    ...live,
    profileMessageId: created.id,
  };
  try {
    await args.auth.updateAccount(updated);
  } catch {
    await args.messages.deleteById(created.id);
    return live;
  }

  if (args.pushStore !== undefined) {
    try {
      await enqueueForumPushes(args.pushStore, args.account.id, created.id, args.now());
    } catch {
      logEvent('push.enqueue.failed');
    }
  }
  return updated;
}
