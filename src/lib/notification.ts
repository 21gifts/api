/**
 * In-app notification domain: public JSON projection and forum-reply notify.
 *
 * v1 is forum-reply only. Member HTTP never exposes recipient or actor
 * account ids. Push enqueue lives here so HTTP and inbound Nostr share one
 * path; callers catch failures so persist still succeeds.
 */

import type { MessageRow } from '@/lib/message';
import type { MessageStore } from '@/lib/message-store';
import type { NotificationStore } from '@/lib/notification-store';
import type { PushStore } from '@/lib/push-store';
import { enqueueReplyPush } from '@/lib/push-worker';

/** Cap for `GET /notifications`. */
export const NOTIFICATION_LIST_LIMIT = 200;

/** Persisted notification kind. */
export type NotificationType = 'forum_reply';

/** Persisted notification row (store-internal; includes account ids). */
export interface NotificationRow {
  /** Opaque unique notification id. */
  id: string;
  /** Account that should see this notification. */
  recipientAccountId: string;
  /** Account that caused the notification (the replier). */
  actorAccountId: string;
  /** Notification kind. */
  type: NotificationType;
  /** Forum note that was replied to. */
  parentId: string;
  /** The reply message id. */
  replyId: string;
  /** Actor display-name snapshot (from the reply row). */
  name: string;
  /** Reply text; may be `""` for photo-only. */
  text: string;
  /** Creation instant. */
  createdAt: Date;
  /** When the recipient marked it read, or `null`. */
  readAt: Date | null;
}

/** Member-facing notification JSON (no account ids). */
export interface PublicNotification {
  /** Opaque unique notification id. */
  id: string;
  /** Notification kind. */
  type: 'forum_reply';
  /** Forum note that was replied to. */
  parentId: string;
  /** The reply message id. */
  replyId: string;
  /** Actor display-name snapshot. */
  name: string;
  /** Reply text; may be `""` for photo-only. */
  text: string;
  /** ISO-8601 creation timestamp. */
  createdAt: string;
  /** ISO-8601 read timestamp, or `null`. */
  readAt: string | null;
}

/**
 * Project a store row to its public JSON shape.
 *
 * @param row - Persisted notification.
 * @returns Public fields only (`recipientAccountId` / `actorAccountId` omitted).
 */
export function serializeNotification(row: NotificationRow): PublicNotification {
  return {
    id: row.id,
    type: row.type,
    parentId: row.parentId,
    replyId: row.replyId,
    name: row.name,
    text: row.text,
    createdAt: row.createdAt.toISOString(),
    readAt: row.readAt === null ? null : row.readAt.toISOString(),
  };
}

/**
 * Persist a forum-reply notification for the parent author and enqueue a
 * targeted Web Push to `/notifications`. No-op when the parent is missing,
 * Damus-only, or authored by the replier. Photo-only empty text still
 * notifies. Unique duplicate create is fine (`create` returns the existing
 * row). Push does not require a notification store. This helper may throw;
 * callers wrap it.
 *
 * @param args - Message store, optional notification/push stores, actor, reply, parent id.
 */
export async function notifyForumReply(args: {
  /** Forum persistence (parent lookup). */
  messages: MessageStore;
  /** Optional notification persistence. */
  notifications?: NotificationStore;
  /** Optional push outbox. */
  pushStore?: PushStore;
  /** Reply author. */
  account: { id: string };
  /** Persisted reply row. */
  created: MessageRow;
  /** Parent forum note id. */
  parentId: string;
}): Promise<void> {
  const parent = await args.messages.getById(args.parentId);
  const parentAccountId = parent?.accountId;
  if (
    parent === undefined ||
    parentAccountId === null ||
    parentAccountId === undefined ||
    parentAccountId === args.account.id
  ) {
    return;
  }
  if (args.notifications !== undefined) {
    await args.notifications.create({
      id: crypto.randomUUID(),
      recipientAccountId: parentAccountId,
      actorAccountId: args.account.id,
      type: 'forum_reply',
      parentId: parent.id,
      replyId: args.created.id,
      name: args.created.name,
      text: args.created.text,
      createdAt: args.created.createdAt,
      readAt: null,
    });
  }
  if (args.pushStore !== undefined) {
    await enqueueReplyPush(
      args.pushStore,
      parentAccountId,
      args.created.id,
      parent.id,
      args.created.createdAt.getTime(),
    );
  }
}
