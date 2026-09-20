/**
 * In-app notification domain: public JSON projection, living-room fan-out,
 * and targeted `moderator_appointed` (subject only, not a fan-out).
 *
 * Living-room in-app recipients are the union of `auth.listAccounts()` (when
 * `auth` is set) and `push_subscription` account ids, except skip, then
 * filtered by each recipient's `notificationLevel` when `auth` is set.
 * Targeted `moderator_appointed` does not fan out. Web Push is still only
 * for `push_subscription` rows. Member HTTP never exposes recipient or actor
 * account ids. Callers catch failures so persist still succeeds.
 */

import { ROLE_ORDER, roleAtLeast } from '@/lib/auth/roles';
import type { AuthStore, NotificationLevel } from '@/lib/auth/store';
import { logEvent } from '@/lib/log';
import type { MessageRow } from '@/lib/message';
import type { MessageStore } from '@/lib/message-store';
import type { NotificationStore } from '@/lib/notification-store';
import {
  buildForumPushPayload,
  buildModeratorAppointedPushPayload,
  buildReplyPushPayload,
  buildZapPushPayload,
} from '@/lib/push';
import type { PushOutboxRow, PushStore } from '@/lib/push-store';

/** Cap for `GET /notifications`. */
export const NOTIFICATION_LIST_LIMIT = 200;

/** Persisted notification kind. */
export type NotificationType = 'forum_post' | 'forum_reply' | 'zap' | 'moderator_appointed';

/** Persisted notification row (store-internal; includes account ids). */
export interface NotificationRow {
  /** Opaque unique notification id. */
  id: string;
  /** Account that should see this notification. */
  recipientAccountId: string;
  /** Account that caused the notification (poster, replier, zap payer, or appointing staff). */
  actorAccountId: string;
  /** Notification kind. */
  type: NotificationType;
  /** Forum note the event refers to (the post itself for `forum_post`; subject account id for `moderator_appointed`). */
  parentId: string;
  /** Event id (`post.id`, `reply.id`, zap receipt UUID, or subject account id for `moderator_appointed`). */
  replyId: string;
  /** Actor display-name snapshot. */
  name: string;
  /** Event text; may be `""` for photo-only or `moderator_appointed`; zap amount as a decimal string. */
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
  /** Forum note the event refers to (the post itself for `forum_post`; subject account id for `moderator_appointed`). */
  parentId: string;
  /** Event id (`post.id`, `reply.id`, zap receipt UUID, or subject account id for `moderator_appointed`). */
  replyId: string;
  /** Actor display-name snapshot. */
  name: string;
  /** Event text; may be `""` for photo-only or `moderator_appointed`; zap amount as a decimal string. */
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

/** Drop `skip` from `ids` (`null` skip keeps everyone). */
function exceptSkip(ids: readonly string[], skip: string | null): string[] {
  if (skip === null) {
    return [...ids];
  }
  return ids.filter((id) => id !== skip);
}

/**
 * Parse a stored or request value into a {@link NotificationLevel}.
 *
 * @param raw - Unknown input (DB text, JSON, omitted).
 * @returns `all`, `active`, or `mentions`; anything else → `all`.
 */
export function parseNotificationLevel(raw: unknown): NotificationLevel {
  if (raw === 'all' || raw === 'active' || raw === 'mentions') {
    return raw;
  }
  return 'all';
}

/**
 * Whether this account is a staff/admin actor for `mentions` fan-out.
 * `verified` is not staff. `isPlatform === true` is staff even when `role` is `basis`.
 * Unknown role strings are not staff.
 *
 * @param account - Role plus optional platform flag.
 * @returns True when `role` is at least `moderator`, or `isPlatform` is true.
 */
export function isStaffAccount(account: { role: string; isPlatform?: boolean }): boolean {
  if (account.isPlatform === true) {
    return true;
  }
  const role = ROLE_ORDER.find((item) => item === account.role);
  return role !== undefined && roleAtLeast(role, 'moderator');
}

/**
 * Whether a recipient at `level` should receive this living-room event.
 *
 * `all` is always true. `active` is `isActive`. `mentions` is a staff actor
 * or `mentionedAccountId === recipientAccountId` (both non-null).
 *
 * @param args - Recipient level, actor staff flag, active flag, mention target, recipient id.
 * @returns True when this recipient should get an in-app row and/or Web Push.
 */
export function wantsNotification(args: {
  level: NotificationLevel;
  actorIsStaff: boolean;
  isActive: boolean;
  mentionedAccountId: string | null;
  recipientAccountId: string;
}): boolean {
  if (args.level === 'all') {
    return true;
  }
  if (args.level === 'active') {
    return args.isActive;
  }
  if (args.actorIsStaff) {
    return true;
  }
  return args.mentionedAccountId !== null && args.mentionedAccountId === args.recipientAccountId;
}

/** Fan-out match context shared by in-app rows and Web Push. */
interface NotificationMatch {
  /** True when the actor/payer is at least moderator, or platform. */
  actorIsStaff: boolean;
  /** True when the related top-level post is in the Active feed, or a zap has amount. */
  isActive: boolean;
  /** Parent/note author id for personal involvement, or `null`. */
  mentionedAccountId: string | null;
}

/**
 * Look up whether `actorId` is staff in `auth.listAccounts()`.
 *
 * @param auth - Optional auth list.
 * @param actorId - Actor/payer id, or `undefined` when there is no payer.
 * @returns False when `auth` or `actorId` is missing or the account is not listed.
 */
async function actorIsStaffFromAuth(
  auth: Pick<AuthStore, 'listAccounts'> | undefined,
  actorId: string | undefined,
): Promise<boolean> {
  if (auth === undefined || actorId === undefined) {
    return false;
  }
  const actor = (await auth.listAccounts()).find((account) => account.id === actorId);
  return actor === undefined ? false : isStaffAccount(actor);
}

/**
 * Drop ids whose stored level rejects this event. Push-only ids not in
 * `accountsById` are treated as `all`.
 *
 * @param ids - Recipients after skip.
 * @param accountsById - Auth accounts keyed by id.
 * @param match - Event match context.
 * @returns Ids that pass {@link wantsNotification}.
 */
function filterIdsByMatch(
  ids: readonly string[],
  accountsById: ReadonlyMap<string, { notificationLevel?: NotificationLevel }>,
  match: NotificationMatch,
): string[] {
  return ids.filter((recipientAccountId) => {
    const recipient = accountsById.get(recipientAccountId);
    const level =
      recipient === undefined ? 'all' : parseNotificationLevel(recipient.notificationLevel);
    return wantsNotification({
      level,
      actorIsStaff: match.actorIsStaff,
      isActive: match.isActive,
      mentionedAccountId: match.mentionedAccountId,
      recipientAccountId,
    });
  });
}

/**
 * Fan out in-app rows and optional Web Push outbox rows except `skipAccountId`.
 * In-app recipients are the union of `auth.listAccounts()` (when `auth` is
 * set) and `push_subscription` account ids. Web Push outbox rows go only to
 * `push_subscription` accounts. When `auth` is set and `match` is set, drop
 * recipients whose {@link wantsNotification} is false (level from
 * `listAccounts()` via {@link parseNotificationLevel}, omitted or unknown
 * → `all`; push-only ids not in that list are `all`).
 * When `auth` is unset, do not filter by level. Missing both `auth` and
 * `pushStore` is a no-op. Unique duplicate `create` is fine. When
 * `notifications` is set, each outbox JSON includes that recipient's current
 * unread count after in-app create (`unreadCount`, for the home-screen
 * badge) plus listed inbox unread when `inboxUnreadCount` is set. When either
 * source exists, `unreadCount` is written (missing source contributes 0).
 * When both are omitted, `payload` is enqueued unchanged.
 *
 * @param args - Optional stores, skip id, optional match, row template, outbox fields, clock.
 * @returns Resolves after each recipient is written (including no-ops).
 * @throws If recipient listing rejects. Per-recipient `create` /
 *   `unreadCount` / inbox unread / `enqueue` failures log `push.fanout.failed`,
 *   continue, then throw after the loops so callers still wrap persist.
 */
export async function fanoutToBellSubscribers(args: {
  /** Optional notification persistence. */
  notifications?: NotificationStore;
  /** Optional push outbox; also contributes `push_subscription` ids to the in-app union. */
  pushStore?: PushStore;
  /** Optional auth; when set, in-app rows go to every account except skip (then level-filtered). */
  auth?: Pick<AuthStore, 'listAccounts'>;
  /** Account id to skip (actor); `null` skips nobody. */
  skipAccountId: string | null;
  /** Optional allowlist applied to both in-app and push recipients before level matching. */
  onlyAccountIds?: readonly string[];
  /**
   * Event match context. Omitted → today's every-id-except-skip behaviour.
   * Applied only when `auth` is also set.
   */
  match?: NotificationMatch;
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
  /** Optional listed inbox unread; missing contributes 0. */
  inboxUnreadCount?: (accountId: string) => Promise<number>;
}): Promise<void> {
  const accounts = args.auth === undefined ? [] : await args.auth.listAccounts();
  const fromAuth = accounts.map((account) => account.id);
  const fromPush =
    args.pushStore === undefined ? [] : await args.pushStore.listAccountIdsWithSubscriptions();
  let inAppIds = exceptSkip([...new Set([...fromAuth, ...fromPush])], args.skipAccountId);
  let pushIds = exceptSkip(fromPush, args.skipAccountId);
  if (args.onlyAccountIds !== undefined) {
    const only = new Set(args.onlyAccountIds);
    inAppIds = inAppIds.filter((id) => only.has(id));
    pushIds = pushIds.filter((id) => only.has(id));
  }
  const match = args.match;
  if (match !== undefined && args.auth !== undefined) {
    const accountsById = new Map(accounts.map((account) => [account.id, account]));
    inAppIds = filterIdsByMatch(inAppIds, accountsById, match);
    pushIds = filterIdsByMatch(pushIds, accountsById, match);
  }
  logEvent('push.fanout', { inApp: inAppIds.length, push: pushIds.length });
  const createdAt = new Date(args.nowMs);
  let failed = false;
  if (args.notifications !== undefined) {
    for (const accountId of inAppIds) {
      try {
        await args.notifications.create({
          ...args.template,
          id: crypto.randomUUID(),
          recipientAccountId: accountId,
        });
      } catch {
        failed = true;
        logEvent('push.fanout.failed');
      }
    }
  }
  if (args.pushStore !== undefined) {
    for (const accountId of pushIds) {
      try {
        let payload = args.payload;
        const notifications = args.notifications;
        const inboxUnreadCount = args.inboxUnreadCount;
        if (notifications !== undefined || inboxUnreadCount !== undefined) {
          const notifUnread =
            notifications === undefined ? 0 : await notifications.unreadCount(accountId);
          const inboxUnread =
            inboxUnreadCount === undefined ? 0 : await inboxUnreadCount(accountId);
          let base: Record<string, unknown> = {};
          try {
            const raw: unknown = JSON.parse(args.payload);
            if (raw !== null && typeof raw === 'object' && !Array.isArray(raw)) {
              base = raw as Record<string, unknown>;
            }
          } catch {
            base = {};
          }
          payload = JSON.stringify({ ...base, unreadCount: notifUnread + inboxUnread });
        }
        const row: PushOutboxRow = {
          id: crypto.randomUUID(),
          accountId,
          type: args.outboxType,
          messageId: args.outboxMessageId,
          payload,
          status: 'pending',
          attempts: 0,
          claimedUntil: null,
          createdAt,
          deliveredEndpoints: [],
        };
        await args.pushStore.enqueue(row);
      } catch {
        failed = true;
        logEvent('push.fanout.failed');
      }
    }
  }
  if (failed) {
    throw new Error('push.fanout.failed');
  }
}

/**
 * Notify living-room members of a new top-level forum post except the actor.
 * Persist a `forum_post` row for every matching account (when `auth` is set)
 * or every bell subscriber (otherwise) when `notifications` is set, and
 * enqueue a `/notifications` Web Push when `pushStore` is set. Matching
 * uses {@link wantsNotification}: `isActive` is `created.sats > 0`,
 * `mentionedAccountId` is null (top-level posts are never personal),
 * `actorIsStaff` from the actor in `auth.listAccounts()` (false if missing).
 * When `auth` is unset, do not filter by level. Missing `pushStore` still
 * writes in-app rows when `auth` is set. This helper may throw; callers wrap
 * it.
 *
 * @param args - Optional stores, actor, persisted post.
 * @returns Resolves after the optional persist and push enqueue (including no-ops).
 * @throws If fan-out `create`, `unreadCount`, or `enqueue` rejects.
 */
export async function notifyForumPost(args: {
  /** Optional notification persistence. */
  notifications?: NotificationStore;
  /** Optional push outbox. */
  pushStore?: PushStore;
  /** Optional auth; when set, in-app rows go to every account except the actor, then level-filtered. */
  auth?: Pick<AuthStore, 'listAccounts'>;
  /** Post author (never notified). */
  account: { id: string };
  /** Persisted top-level post row. */
  created: MessageRow;
  /** Optional listed inbox unread; forwarded to fan-out. */
  inboxUnreadCount?: (accountId: string) => Promise<number>;
}): Promise<void> {
  await fanoutToBellSubscribers({
    ...(args.notifications === undefined ? {} : { notifications: args.notifications }),
    ...(args.pushStore === undefined ? {} : { pushStore: args.pushStore }),
    ...(args.auth === undefined ? {} : { auth: args.auth }),
    ...(args.inboxUnreadCount === undefined ? {} : { inboxUnreadCount: args.inboxUnreadCount }),
    skipAccountId: args.account.id,
    match: {
      actorIsStaff: await actorIsStaffFromAuth(args.auth, args.account.id),
      isActive: args.created.sats > 0,
      mentionedAccountId: null,
    },
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
 * Notify living-room members of a forum reply except the actor. Persist a
 * `forum_reply` row when `notifications` is set and enqueue a `/notifications`
 * Web Push when `pushStore` is set. No-op when the parent is missing. Damus-only
 * parents and self-replies still fan out (the actor is skipped). Photo-only
 * empty text still notifies. Matching uses {@link wantsNotification}:
 * `isActive` is `parent.sats > 0`, `mentionedAccountId` is `parent.accountId`
 * (null when the parent has no account), `actorIsStaff` from the reply actor.
 * When `auth` is unset, do not filter by level. Missing `pushStore` still
 * writes in-app rows when `auth` is set. Unique duplicate create is fine.
 * This helper may throw; callers wrap it.
 *
 * @param args - Message store, optional notification/push/auth stores, actor, reply, parent id.
 * @returns Resolves after the optional persist and push enqueue (including no-ops).
 * @throws If parent lookup, notification `create`, `unreadCount`, or outbox `enqueue` rejects.
 */
export async function notifyForumReply(args: {
  /** Forum persistence (parent lookup). */
  messages: MessageStore;
  /** Optional notification persistence. */
  notifications?: NotificationStore;
  /** Optional push outbox. */
  pushStore?: PushStore;
  /** Optional auth; when set, in-app rows go to every account except the actor, then level-filtered. */
  auth?: Pick<AuthStore, 'listAccounts'>;
  /** Reply author (never notified). */
  account: { id: string };
  /** Persisted reply row. */
  created: MessageRow;
  /** Parent forum note id. */
  parentId: string;
  /** Optional listed inbox unread; forwarded to fan-out. */
  inboxUnreadCount?: (accountId: string) => Promise<number>;
}): Promise<void> {
  const parent = await args.messages.getById(args.parentId);
  if (parent === undefined) {
    return;
  }
  await fanoutToBellSubscribers({
    ...(args.notifications === undefined ? {} : { notifications: args.notifications }),
    ...(args.pushStore === undefined ? {} : { pushStore: args.pushStore }),
    ...(args.auth === undefined ? {} : { auth: args.auth }),
    ...(args.inboxUnreadCount === undefined ? {} : { inboxUnreadCount: args.inboxUnreadCount }),
    skipAccountId: args.account.id,
    match: {
      actorIsStaff: await actorIsStaffFromAuth(args.auth, args.account.id),
      isActive: parent.sats > 0,
      mentionedAccountId: parent.accountId ?? null,
    },
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
 * Notify only the member who authored the parent of an external Nostr reply.
 *
 * A parent without an account is a no-op. The notification actor name is
 * always the generic 'Someone', never the external row's display name. The
 * parent author supplies the internal actor id required by notification
 * persistence. The targeted
 * allowlist is applied before notification-level matching to both in-app and
 * push recipients.
 *
 * @param args - Parent, persisted external reply, optional stores, auth, and inbox count.
 * @returns Resolves after the targeted fan-out, including no-op parents.
 * @throws If fan-out persistence or enqueue fails.
 */
export async function notifyExternalForumReply(args: {
  /** Parent forum note. */
  parent: MessageRow;
  /** Persisted external reply. */
  created: MessageRow;
  /** Optional notification persistence. */
  notifications?: NotificationStore;
  /** Optional push outbox. */
  pushStore?: PushStore;
  /** Optional auth account list for notification-level filtering. */
  auth?: Pick<AuthStore, 'listAccounts'>;
  /** Optional listed inbox unread; forwarded to fan-out. */
  inboxUnreadCount?: (accountId: string) => Promise<number>;
}): Promise<void> {
  const parentAccountId = args.parent.accountId;
  if (parentAccountId === null) {
    return;
  }
  await fanoutToBellSubscribers({
    ...(args.notifications === undefined ? {} : { notifications: args.notifications }),
    ...(args.pushStore === undefined ? {} : { pushStore: args.pushStore }),
    ...(args.auth === undefined ? {} : { auth: args.auth }),
    ...(args.inboxUnreadCount === undefined ? {} : { inboxUnreadCount: args.inboxUnreadCount }),
    skipAccountId: null,
    onlyAccountIds: [parentAccountId],
    match: {
      actorIsStaff: false,
      isActive: args.parent.sats > 0,
      mentionedAccountId: parentAccountId,
    },
    template: {
      actorAccountId: parentAccountId,
      type: 'forum_reply',
      parentId: args.parent.id,
      replyId: args.created.id,
      name: 'Someone',
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
 * Notify living-room members of a newly indexed zap/payment. Persist a `zap`
 * row when `notifications` is set and enqueue a `/notifications` Web Push when
 * `pushStore` is set. No-op when the note has no `accountId`. Does not skip the
 * note author unless they are also `payerAccountId`. Matching uses
 * {@link wantsNotification}: `isActive` is `note.sats > 0` or `amountSats > 0`
 * (first gift still counts), `mentionedAccountId` is `note.accountId`,
 * `actorIsStaff` from the payer account when `payerAccountId` is found
 * (otherwise false — a zap is not an admin post). When `auth` is unset, do
 * not filter by level. Missing `pushStore` still writes in-app rows when
 * `auth` is set. This helper may throw; callers wrap it.
 *
 * @param args - Optional stores, zapped note, receipt id, amount, clock, optional payer.
 * @returns Resolves after the optional persist and push enqueue (including no-ops).
 * @throws If fan-out `create`, `unreadCount`, or `enqueue` rejects.
 */
export async function notifyZap(args: {
  /** Optional notification persistence. */
  notifications?: NotificationStore;
  /** Optional push outbox. */
  pushStore?: PushStore;
  /** Optional auth; when set, in-app rows go to every account except the payer skip, then level-filtered. */
  auth?: Pick<AuthStore, 'listAccounts'>;
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
  /** Optional listed inbox unread; forwarded to fan-out. */
  inboxUnreadCount?: (accountId: string) => Promise<number>;
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
    ...(args.auth === undefined ? {} : { auth: args.auth }),
    ...(args.inboxUnreadCount === undefined ? {} : { inboxUnreadCount: args.inboxUnreadCount }),
    skipAccountId,
    match: {
      actorIsStaff: await actorIsStaffFromAuth(args.auth, args.payerAccountId),
      isActive: args.note.sats > 0 || args.amountSats > 0,
      mentionedAccountId: noteAccountId,
    },
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

/**
 * Notify the appointed subject only (not a living-room fan-out). Persist a
 * `moderator_appointed` row for `subject.id` when `notifications` is set, and
 * enqueue one Web Push (`url` `/welcome`, tag `moderator_appointed:<subjectId>`,
 * outbox `type: 'forum'`) when `pushStore` is set. Missing both stores is a
 * no-op. If only `notifications` is set, still create the in-app row. If only
 * `pushStore` is set, still enqueue (payload without `unreadCount`). Does not
 * skip the subject and does not consult `listAccountIdsWithSubscriptions`.
 * Unique duplicate create is fine. This helper may throw; callers wrap it.
 *
 * @param args - Optional stores, subject, actor, clock.
 * @returns Resolves after the optional persist and push enqueue (including no-ops).
 * @throws If recipient `create`, `unreadCount`, or `enqueue` rejects.
 */
export async function notifyModeratorAppointed(args: {
  /** Optional notification persistence. */
  notifications?: NotificationStore;
  /** Optional push outbox. */
  pushStore?: PushStore;
  /** Optional listed inbox unread; missing contributes 0. */
  inboxUnreadCount?: (accountId: string) => Promise<number>;
  /** Account that was appointed (the only recipient). */
  subject: { id: string };
  /** Staff member who confirmed or appointed. */
  actor: { id: string; name: string | null };
  /** Enqueue / row clock. */
  nowMs: number;
}): Promise<void> {
  if (args.notifications === undefined && args.pushStore === undefined) {
    return;
  }
  const createdAt = new Date(args.nowMs);
  let failed = false;
  if (args.notifications !== undefined) {
    try {
      await args.notifications.create({
        id: crypto.randomUUID(),
        recipientAccountId: args.subject.id,
        actorAccountId: args.actor.id,
        type: 'moderator_appointed',
        parentId: args.subject.id,
        replyId: args.subject.id,
        name: args.actor.name ?? 'Someone',
        text: '',
        createdAt,
        readAt: null,
      });
    } catch {
      failed = true;
      logEvent('push.fanout.failed');
    }
  }
  if (args.pushStore !== undefined) {
    try {
      const base = buildModeratorAppointedPushPayload(args.subject.id);
      let payload = JSON.stringify(base);
      if (args.notifications !== undefined || args.inboxUnreadCount !== undefined) {
        const notifUnread =
          args.notifications === undefined
            ? 0
            : await args.notifications.unreadCount(args.subject.id);
        const inboxUnread =
          args.inboxUnreadCount === undefined ? 0 : await args.inboxUnreadCount(args.subject.id);
        payload = JSON.stringify({ ...base, unreadCount: notifUnread + inboxUnread });
      }
      const row: PushOutboxRow = {
        id: crypto.randomUUID(),
        accountId: args.subject.id,
        type: 'forum',
        messageId: args.subject.id,
        payload,
        status: 'pending',
        attempts: 0,
        claimedUntil: null,
        createdAt,
        deliveredEndpoints: [],
      };
      await args.pushStore.enqueue(row);
    } catch {
      failed = true;
      logEvent('push.fanout.failed');
    }
  }
  if (failed) {
    throw new Error('push.fanout.failed');
  }
}
