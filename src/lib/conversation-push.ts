/**
 * Web Push for inbound private messages (bell subscribers only).
 *
 * Does not write in-app Notification rows. Inbox stays the DM surface;
 * the closed Moderators group opens `/moderate/group`.
 */

import { isModeratorGroupMember, roleAtLeast } from '@/lib/auth/roles';
import type { SqlClient } from '@/lib/auth/sql';
import type { AuthStore } from '@/lib/auth/store';
import {
  conversationPushRecipientIds,
  type ConversationMessageRow,
  type ConversationThread,
} from '@/lib/conversation';
import type { ConversationStore, RemovedDamusThreads } from '@/lib/conversation-store';
import { logEvent } from '@/lib/log';
import type { MessageStore } from '@/lib/message-store';
import { enqueueNotificationDismiss } from '@/lib/notification';
import type { NotificationStore } from '@/lib/notification-store';
import { buildConversationPushPayload } from '@/lib/push';
import type { PushOutboxRow, PushStore } from '@/lib/push-store';

/**
 * Inbox unread callback for forum/zap fan-out.
 *
 * Staff comes from `getAccount` + `roleAtLeast(role, 'moderator')`, the
 * `moderator` flag from `isModeratorGroupMember` (at least moderator and not
 * the platform account), so any account that is at least a moderator is
 * treated alike. GET `/conversations` never lists `moderator_group` (fifth
 * argument always false); this helper still pins that thread in the badge
 * unread count for every group member. Platform id from `listAccounts` /
 * `isPlatform`. Lookup failure yields staff false, `moderator` false, and
 * `platformId` null.
 *
 * @param conversations - Conversation store.
 * @param auth - Account lookup.
 * @returns Per-account listed inbox unread count.
 */
export function inboxUnreadCountFor(
  conversations: ConversationStore,
  auth: Pick<AuthStore, 'getAccount' | 'listAccounts'>,
): (accountId: string) => Promise<number> {
  return async (accountId) => {
    let staff = false;
    let moderator = false;
    let platformId: string | null = null;
    try {
      const account = await auth.getAccount(accountId);
      const atLeastModerator = account !== undefined && roleAtLeast(account.role, 'moderator');
      staff = atLeastModerator;
      moderator = account !== undefined && isModeratorGroupMember(account);
      const accounts = await auth.listAccounts();
      const platform = accounts.find((item) => item.isPlatform === true);
      platformId = platform === undefined ? null : platform.id;
    } catch {
      staff = false;
      moderator = false;
      platformId = null;
    }
    return conversations.unreadCount(accountId, staff, platformId, moderator);
  };
}

/**
 * Enqueue one conversation Web Push per 21.gifts recipient with a bell
 * subscription. No-op when `pushStore` is omitted. Does not persist
 * in-app notification rows. `moderator_group` opens `/moderate/group`;
 * other kinds keep `/messages?c=<id>`. Per-recipient failures log
 * `conversations.push.failed` and continue; throws after the loop when
 * any failed (same as forum fan-out). Callers still catch so HTTP/Nostr
 * ingest stays 200.
 *
 * @param args - Optional push/notification stores, conversation store,
 *   auth, thread, persisted message, clock.
 * @returns Resolves after each recipient is considered (including no-ops).
 * @throws If any per-recipient `listByAccount` / `unreadCount` / `enqueue`
 *   rejects after logging.
 */
export async function notifyConversationMessage(args: {
  /** Optional push outbox; omitted is a no-op. */
  pushStore?: PushStore;
  /** Optional in-app unread source; missing contributes 0. */
  notifications?: Pick<NotificationStore, 'unreadCount'>;
  /** Inbox unread source (listed GET `/conversations` rules). */
  conversations: ConversationStore;
  /** Account lookup for staff/platform. */
  authStore: AuthStore;
  /** Thread the message belongs to. */
  thread: ConversationThread;
  /** Persisted message (sender + body). */
  message: ConversationMessageRow;
  /** Enqueue clock. */
  nowMs: number;
}): Promise<void> {
  if (args.pushStore === undefined) {
    return;
  }
  let moderatorIds: string[] = [];
  if (args.thread.kind === 'moderator_group') {
    const accounts = await args.authStore.listAccounts();
    moderatorIds = accounts.filter((item) => isModeratorGroupMember(item)).map((item) => item.id);
  }
  const recipientIds = conversationPushRecipientIds(
    args.thread,
    args.message.senderAccountId,
    moderatorIds,
  );
  const inboxUnreadOf = inboxUnreadCountFor(args.conversations, args.authStore);
  const createdAt = new Date(args.nowMs);
  let failed = false;
  for (const accountId of recipientIds) {
    try {
      const subs = await args.pushStore.listByAccount(accountId);
      if (subs.length === 0) {
        continue;
      }
      const notifUnread =
        args.notifications === undefined ? 0 : await args.notifications.unreadCount(accountId);
      const inboxUnread = await inboxUnreadOf(accountId);
      const unreadCount = notifUnread + inboxUnread;
      const payload = JSON.stringify({
        ...buildConversationPushPayload({
          conversationId: args.thread.id,
          name: args.message.name,
          text: args.message.text,
          ...(args.thread.kind === 'moderator_group' ? { url: '/moderate/group' } : {}),
        }),
        unreadCount,
      });
      const row: PushOutboxRow = {
        id: crypto.randomUUID(),
        accountId,
        type: 'conversation',
        messageId: args.message.id,
        payload,
        status: 'pending',
        attempts: 0,
        claimedUntil: null,
        finishedAt: null,
        createdAt,
        deliveredEndpoints: [],
        skipEndpoints: [],
      };
      await args.pushStore.enqueue(row);
    } catch {
      failed = true;
      logEvent('conversations.push.failed');
    }
  }
  if (failed) {
    throw new Error('conversations.push.failed');
  }
}

/** Stores the cleanup's dismiss step reads and writes. */
interface DamusCleanupStores {
  conversations: ConversationStore;
  pushStore: PushStore;
  notifications?: Pick<NotificationStore, 'unreadCount'>;
}

/**
 * Enqueue one strict dismiss push per member with a push subscription for the
 * tags `conversation:<id>` of the removed threads, carrying that member's
 * badge after the removal. Throws on the first failure.
 */
async function enqueueRemovedThreadDismissals(
  removed: RemovedDamusThreads,
  stores: DamusCleanupStores,
  auth: Pick<AuthStore, 'getAccount' | 'listAccounts'>,
  nowMs: number,
): Promise<void> {
  const tagsByMember = new Map<string, string[]>();
  for (const thread of removed.threads) {
    const tags = tagsByMember.get(thread.memberId) ?? [];
    tags.push(`conversation:${thread.id}`);
    tagsByMember.set(thread.memberId, tags);
  }
  const inboxUnreadOf = inboxUnreadCountFor(stores.conversations, auth);
  for (const [memberId, tags] of tagsByMember) {
    const subs = await stores.pushStore.listByAccount(memberId);
    if (subs.length === 0) {
      continue;
    }
    const notifUnread =
      stores.notifications === undefined ? 0 : await stores.notifications.unreadCount(memberId);
    await enqueueNotificationDismiss({
      pushStore: stores.pushStore,
      accountId: memberId,
      tags,
      nowMs,
      unreadCount: notifUnread + (await inboxUnreadOf(memberId)),
      strict: true,
    });
  }
}

/**
 * Boot step: one-time removal of the member↔Damus threads whose counterpart
 * the inbound direct-message admission rule would not admit, through
 * {@link ConversationStore.removeDamusThreadsWithoutMemberMessage}: threads
 * that hold no message sent by the member and whose counterpart pubkey is not
 * an entitled external zapper (`listZapperPubkeys`, the source the admission
 * rule reads).
 *
 * For each member with a push subscription who lost a thread, one dismiss
 * push for the tags `conversation:<id>` of the removed threads is written
 * before the removal commits, carrying the member's badge count after the
 * removal (in-app notification unread plus listed inbox unread), so a device
 * closes notifications of a removed thread and its badge drops. On Postgres
 * the store hands its transaction client to `storesFor`, so the badge is read
 * from the state after the deletes and the dismiss rows commit or roll back
 * together with them; without `storesFor` (memory) the given stores are used.
 *
 * Logs one `conversations.damus_cleanup` event with the number of removed
 * threads and messages (both 0 when the run already happened). Any failure,
 * including a failed zapper read or dismiss write, logs
 * `conversations.damus_cleanup.failed`, removes nothing on Postgres (the
 * transaction rolls back, the run marker included), and the boot continues;
 * the next boot runs it again. Does not throw.
 *
 * @param args - Conversation, push and optional notification stores, the
 *   zapper source, account lookup for the badge count, the clock, and an
 *   optional factory of the same stores on a transaction client.
 * @returns Removed thread and message counts.
 */
export async function removeUnadmittedDamusThreads(args: {
  conversations: ConversationStore;
  pushStore: PushStore;
  notifications?: Pick<NotificationStore, 'unreadCount'>;
  zappers: Pick<MessageStore, 'listZapperPubkeys'>;
  auth: Pick<AuthStore, 'getAccount' | 'listAccounts'>;
  nowMs: number;
  storesFor?: (tx: SqlClient) => DamusCleanupStores;
}): Promise<{ threads: number; messages: number }> {
  let removed: RemovedDamusThreads;
  try {
    const keep = new Set(
      (await args.zappers.listZapperPubkeys()).map((value) => value.toLowerCase()),
    );
    removed = await args.conversations.removeDamusThreadsWithoutMemberMessage(
      new Date(args.nowMs),
      keep,
      async (done, tx) => {
        const stores = tx !== null && args.storesFor !== undefined ? args.storesFor(tx) : args;
        await enqueueRemovedThreadDismissals(done, stores, args.auth, args.nowMs);
      },
    );
  } catch {
    logEvent('conversations.damus_cleanup.failed');
    return { threads: 0, messages: 0 };
  }
  const counts = { threads: removed.threads.length, messages: removed.messages };
  logEvent('conversations.damus_cleanup', counts);
  return counts;
}
