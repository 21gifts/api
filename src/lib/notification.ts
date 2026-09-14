/**
 * In-app notification domain: public JSON projection and bell fan-out.
 *
 * Bell subscribers (accounts with ≥1 `push_subscription` row) get an in-app
 * row and a Web Push for every living-room event: top-level post, reply, and
 * newly indexed zap. Member HTTP never exposes recipient or actor account
 * ids. Callers catch failures so persist still succeeds.
 */

import type { MessageRow } from '@/lib/message';
import type { MessageStore } from '@/lib/message-store';
import type { NotificationStore } from '@/lib/notification-store';
import { buildForumPushPayload, buildReplyPushPayload, buildZapPushPayload } from '@/lib/push';
import type { PushOutboxRow, PushStore } from '@/lib/push-store';

/** Cap for `GET /notifications`. */
export const NOTIFICATION_LIST_LIMIT = 200;

/** Persisted notification kind. */
export type NotificationType = 'forum_post' | 'forum_reply' | 'zap';

/** Persisted notification row (store-internal; includes account ids). */
export interface NotificationRow {
  /** Opaque unique notification id. */
  id: string;
  /** Account that should see this notification. */
  recipientAccountId: string;
  /** Account that caused the notification (poster, replier, or zap payer). */
  actorAccountId: string;
  /** Notification kind. */
  type: NotificationType;
  /** Forum note the event refers to (the post itself for `forum_post`). */
  parentId: string;
  /** Event id (`post.id`, `reply.id`, or zap receipt UUID). */
  replyId: string;
  /** Actor display-name snapshot. */
  name: string;
  /** Event text; may be `""` for photo-only; zap amount as a decimal string. */
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
  type: NotificationType;
  /** Forum note the event refers to (the post itself for `forum_post`). */
  parentId: string;
  /** Event id (`post.id`, `reply.id`, or zap receipt UUID). */
  replyId: string;
  /** Actor display-name snapshot. */
  name: string;
  /** Event text; may be `""` for photo-only; zap amount as a decimal string. */
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

/** UUID-shaped id from a 64-hex kind:9735 event id (first 32 hex, 8-4-4-4-12). */
function zapReplyIdFromReceipt(receiptId: string): string {
  const hex = receiptId.slice(0, 32);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

/**
 * Fan out one in-app row and one pending outbox row to every bell subscriber
 * except `skipAccountId`. Recipients come from the subscription table; missing
 * `pushStore` is a no-op. Unique duplicate `create` is fine.
 *
 * @param args - Optional stores, skip id, row template, outbox fields, clock.
 * @returns Resolves after each recipient is written (including no-ops).
 * @throws If `listAccountIdsWithSubscriptions`, `create`, or `enqueue` rejects.
 */
export async function fanoutToBellSubscribers(args: {
  /** Optional notification persistence. */
  notifications?: NotificationStore;
  /** Optional push outbox; also the bell-subscriber list. */
  pushStore?: PushStore;
  /** Account id to skip (actor); `null` skips nobody. */
  skipAccountId: string | null;
  /** Row fields copied to each recipient (`id` / `recipientAccountId` filled here). */
  template: Omit<NotificationRow, 'id' | 'recipientAccountId'>;
  /** Outbox `type`. */
  outboxType: 'forum' | 'zap';
  /** Outbox `messageId` (forum note id for zaps; event id otherwise). */
  outboxMessageId: string | null;
  /** JSON payload string (already stringified). */
  payload: string;
  /** Enqueue clock. */
  nowMs: number;
}): Promise<void> {
  if (args.pushStore === undefined) {
    return;
  }
  const accountIds = await args.pushStore.listAccountIdsWithSubscriptions();
  const createdAt = new Date(args.nowMs);
  for (const accountId of accountIds) {
    if (args.skipAccountId !== null && accountId === args.skipAccountId) {
      continue;
    }
    if (args.notifications !== undefined) {
      await args.notifications.create({
        ...args.template,
        id: crypto.randomUUID(),
        recipientAccountId: accountId,
      });
    }
    const row: PushOutboxRow = {
      id: crypto.randomUUID(),
      accountId,
      type: args.outboxType,
      messageId: args.outboxMessageId,
      payload: args.payload,
      status: 'pending',
      attempts: 0,
      claimedUntil: null,
      createdAt,
      deliveredEndpoints: [],
    };
    await args.pushStore.enqueue(row);
  }
}

/**
 * Notify every bell subscriber of a new top-level forum post except the
 * actor. Persist a `forum_post` row when `notifications` is set and enqueue a
 * `/notifications` Web Push when `pushStore` is set. Missing `pushStore` is a
 * no-op (the subscription table is the recipient list). This helper may throw;
 * callers wrap it.
 *
 * @param args - Optional stores, actor, persisted post.
 * @returns Resolves after the optional persist and push enqueue (including no-ops).
 * @throws If fan-out `create` or `enqueue` rejects.
 */
export async function notifyForumPost(args: {
  /** Optional notification persistence. */
  notifications?: NotificationStore;
  /** Optional push outbox. */
  pushStore?: PushStore;
  /** Post author (never notified). */
  account: { id: string };
  /** Persisted top-level post row. */
  created: MessageRow;
}): Promise<void> {
  await fanoutToBellSubscribers({
    ...(args.notifications === undefined ? {} : { notifications: args.notifications }),
    ...(args.pushStore === undefined ? {} : { pushStore: args.pushStore }),
    skipAccountId: args.account.id,
    template: {
      actorAccountId: args.account.id,
      type: 'forum_post',
      parentId: args.created.id,
      replyId: args.created.id,
      name: args.created.name,
      text: args.created.text,
      createdAt: args.created.createdAt,
      readAt: null,
    },
    outboxType: 'forum',
    outboxMessageId: args.created.id,
    payload: JSON.stringify(buildForumPushPayload(args.created.id)),
    nowMs: args.created.createdAt.getTime(),
  });
}

/**
 * Notify every bell subscriber of a forum reply except the actor. Persist a
 * `forum_reply` row when `notifications` is set and enqueue a `/notifications`
 * Web Push when `pushStore` is set. No-op when the parent is missing. Damus-only
 * parents and self-replies still fan out (the actor is skipped). Photo-only
 * empty text still notifies. Unique duplicate create is fine. This helper may
 * throw; callers wrap it.
 *
 * @param args - Message store, optional notification/push stores, actor, reply, parent id.
 * @returns Resolves after the optional persist and push enqueue (including no-ops).
 * @throws If parent lookup, notification `create`, or outbox `enqueue` rejects.
 */
export async function notifyForumReply(args: {
  /** Forum persistence (parent lookup). */
  messages: MessageStore;
  /** Optional notification persistence. */
  notifications?: NotificationStore;
  /** Optional push outbox. */
  pushStore?: PushStore;
  /** Reply author (never notified). */
  account: { id: string };
  /** Persisted reply row. */
  created: MessageRow;
  /** Parent forum note id. */
  parentId: string;
}): Promise<void> {
  const parent = await args.messages.getById(args.parentId);
  if (parent === undefined) {
    return;
  }
  await fanoutToBellSubscribers({
    ...(args.notifications === undefined ? {} : { notifications: args.notifications }),
    ...(args.pushStore === undefined ? {} : { pushStore: args.pushStore }),
    skipAccountId: args.account.id,
    template: {
      actorAccountId: args.account.id,
      type: 'forum_reply',
      parentId: parent.id,
      replyId: args.created.id,
      name: args.created.name,
      text: args.created.text,
      createdAt: args.created.createdAt,
      readAt: null,
    },
    outboxType: 'forum',
    outboxMessageId: args.created.id,
    payload: JSON.stringify(buildReplyPushPayload(args.created.id)),
    nowMs: args.created.createdAt.getTime(),
  });
}

/**
 * Notify every bell subscriber of a newly indexed zap/payment. Persist a `zap`
 * row when `notifications` is set and enqueue a `/notifications` Web Push when
 * `pushStore` is set. No-op when the note has no `accountId`. Does not skip the
 * note author unless they are also `payerAccountId`. Missing `pushStore` is a
 * no-op. This helper may throw; callers wrap it.
 *
 * @param args - Optional stores, zapped note, receipt id, amount, clock, optional payer.
 * @returns Resolves after the optional persist and push enqueue (including no-ops).
 * @throws If fan-out `create` or `enqueue` rejects.
 */
export async function notifyZap(args: {
  /** Optional notification persistence. */
  notifications?: NotificationStore;
  /** Optional push outbox. */
  pushStore?: PushStore;
  /** Zapped forum note; requires `note.accountId`. */
  note: MessageRow;
  /** Kind:9735 event id (64 hex). */
  receiptId: string;
  /** Indexed amount in sats (stored as `text`). */
  amountSats: number;
  /** Enqueue / row clock. */
  nowMs: number;
  /** Skip this id when set; do not skip the note author unless they are the payer. */
  payerAccountId?: string;
  /** Actor display-name snapshot; default `'Someone'`. */
  payerName?: string;
}): Promise<void> {
  const noteAccountId = args.note.accountId;
  if (noteAccountId === null) {
    return;
  }
  const replyId = zapReplyIdFromReceipt(args.receiptId);
  const skipAccountId = args.payerAccountId ?? null;
  const actorAccountId = args.payerAccountId ?? noteAccountId;
  await fanoutToBellSubscribers({
    ...(args.notifications === undefined ? {} : { notifications: args.notifications }),
    ...(args.pushStore === undefined ? {} : { pushStore: args.pushStore }),
    skipAccountId,
    template: {
      actorAccountId,
      type: 'zap',
      parentId: args.note.id,
      replyId,
      name: args.payerName ?? 'Someone',
      text: String(args.amountSats),
      createdAt: new Date(args.nowMs),
      readAt: null,
    },
    outboxType: 'zap',
    outboxMessageId: args.note.id,
    payload: JSON.stringify(buildZapPushPayload(replyId)),
    nowMs: args.nowMs,
  });
}
