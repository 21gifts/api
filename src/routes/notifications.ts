import { Hono } from 'hono';
import { resolveSession } from '@/lib/auth/service';
import type { Account, AuthStore } from '@/lib/auth/store';
import { logEvent } from '@/lib/log';
import type { MessageRow } from '@/lib/message';
import type { MessageStore } from '@/lib/message-store';
import {
  enqueueNotificationDismiss,
  NOTIFICATION_FILTER_SCAN_LIMIT,
  NOTIFICATION_LIST_LIMIT,
  notificationsMatchingLevel,
  parseNotificationLevel,
  serializeNotification,
  type NotificationRow,
  type PublicNotification,
} from '@/lib/notification';
import type { NotificationStore } from '@/lib/notification-store';
import { pushTagForNotification } from '@/lib/push';
import type { PushStore } from '@/lib/push-store';
import { bearerToken } from '@/routes/me';

/**
 * `/notifications` — signed-in in-app notification list and mark-read.
 * Nothing public. DEBUG_TOKEN cannot read member notifications.
 */

/** Collaborators the `/notifications` routes need. */
export interface NotificationRouteDeps {
  /** Notification persistence. */
  store: NotificationStore;
  /** Shared auth persistence port. */
  authStore: AuthStore;
  /** Forum notes for reconstructing Active/Mentions match on stored rows. */
  messages: Pick<MessageStore, 'getById'>;
  /** Clock returning epoch milliseconds (injected for testability). */
  now: () => number;
  /** Optional push outbox; omitted skips dismiss enqueue. */
  pushStore?: PushStore;
  /** Optional listed inbox unread; omitted contributes 0 to dismiss badge. */
  inboxUnreadCount?: (accountId: string) => Promise<number>;
}

const NOTIFICATION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Resolve the account behind a request's bearer session, or `null`. */
async function authedAccount(
  deps: NotificationRouteDeps,
  header: string | undefined,
): Promise<Account | null> {
  const token = bearerToken(header);
  if (token === null) {
    return null;
  }
  return resolveSession(deps.authStore, deps.now(), token);
}

/** First-seen unique collapse tags from newly stamped rows. */
function tagsFromRows(rows: readonly NotificationRow[]): string[] {
  const tags: string[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    const tag = pushTagForNotification(row);
    if (tag === null || seen.has(tag)) {
      continue;
    }
    seen.add(tag);
    tags.push(tag);
  }
  return tags;
}

/** Optional `endpoint` string from a JSON object body. */
function endpointFromBody(body: unknown): string | undefined {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return undefined;
  }
  const endpoint = (body as Record<string, unknown>)['endpoint'];
  if (typeof endpoint !== 'string' || endpoint === '') {
    return undefined;
  }
  return endpoint;
}

/**
 * Enqueue dismiss pushes for newly stamped tags. Never throws.
 *
 * @param args - Route deps, recipient, tags, and optional request body.
 * @returns Resolves after dismiss is attempted or skipped.
 */
async function enqueueDismissForAccount(args: {
  deps: NotificationRouteDeps;
  accountId: string;
  tags: readonly string[];
  body: unknown;
}): Promise<void> {
  const pushStore = args.deps.pushStore;
  if (pushStore === undefined || args.tags.length === 0) {
    return;
  }
  try {
    let skipEndpoint: string | undefined;
    const candidate = endpointFromBody(args.body);
    if (candidate !== undefined) {
      const subs = await pushStore.listByAccount(args.accountId);
      for (const sub of subs) {
        if (sub.endpoint === candidate) {
          skipEndpoint = candidate;
          break;
        }
      }
    }
    let unreadCount = await args.deps.store.unreadCount(args.accountId);
    const inboxUnreadCount = args.deps.inboxUnreadCount;
    if (inboxUnreadCount !== undefined) {
      try {
        unreadCount += await inboxUnreadCount(args.accountId);
      } catch {
        logEvent('push.dismiss.failed');
      }
    }
    await enqueueNotificationDismiss({
      pushStore,
      accountId: args.accountId,
      tags: args.tags,
      nowMs: args.deps.now(),
      unreadCount,
      ...(skipEndpoint === undefined ? {} : { skipEndpoint }),
    });
  } catch {
    logEvent('push.dismiss.failed');
  }
}

/**
 * Build the `/notifications` route group.
 *
 * Mount `read-all` and `read-by-message` before `/:id/read` so those paths
 * are not captured as an id.
 *
 * @param deps - Notification store, auth store, message store, clock, and optional push.
 * @returns A Hono app with list / mark-one / mark-all / mark-by-message.
 */
export function notificationRoutes(deps: NotificationRouteDeps): Hono {
  return new Hono()
    .get('/', async (c) => {
      const account = await authedAccount(deps, c.req.header('authorization'));
      if (account === null) {
        return c.json({ error: 'Unauthorized' }, 401);
      }
      try {
        const rows = await deps.store.listByRecipient(account.id, NOTIFICATION_FILTER_SCAN_LIMIT);
        const mentionReplyIds = new Set<string>();
        for (const row of rows) {
          if (row.type === 'forum_mention') {
            mentionReplyIds.add(row.replyId);
          }
        }
        const duplicateIds: string[] = [];
        const deduped: NotificationRow[] = [];
        for (const row of rows) {
          if (
            (row.type === 'forum_post' || row.type === 'forum_reply') &&
            mentionReplyIds.has(row.replyId)
          ) {
            duplicateIds.push(row.id);
            continue;
          }
          deduped.push(row);
        }
        if (duplicateIds.length > 0) {
          try {
            await deps.store.deleteForRecipient(account.id, duplicateIds);
            logEvent('notifications.duplicate.purged', { count: duplicateIds.length });
          } catch {
            logEvent('notifications.duplicate.purge_failed');
          }
        }
        const accounts = await deps.authStore.listAccounts();
        const lookupIds = [...new Set(deduped.flatMap((row) => [row.parentId, row.replyId]))];
        const messageById = new Map<string, MessageRow | undefined>();
        for (const id of lookupIds) {
          messageById.set(id, await deps.messages.getById(id));
        }
        const parentById = new Map<string, MessageRow>();
        for (const id of new Set(deduped.map((row) => row.parentId))) {
          const parent = messageById.get(id);
          if (parent !== undefined) {
            parentById.set(id, parent);
          }
        }
        const matched = notificationsMatchingLevel({
          rows: deduped,
          level: parseNotificationLevel(account.notificationLevel),
          recipientAccountId: account.id,
          accounts,
          parentById,
        });
        const kept = [];
        const droppedMessageIds = new Set<string>();
        for (const row of matched) {
          if (row.type === 'moderator_appointed' || row.type === 'moderator_proposal') {
            kept.push(row);
            continue;
          }
          const parent = messageById.get(row.parentId);
          if (parent === undefined || parent.deletedAt !== null) {
            droppedMessageIds.add(row.parentId);
            continue;
          }
          // zap replyId is a receipt-derived UUID, not a message id.
          if (row.type === 'forum_reply' && row.replyId !== row.parentId) {
            const reply = messageById.get(row.replyId);
            if (reply === undefined || reply.deletedAt !== null) {
              droppedMessageIds.add(row.replyId);
              continue;
            }
          }
          kept.push(row);
        }
        if (droppedMessageIds.size > 0) {
          try {
            await deps.store.deleteByMessageIds([...droppedMessageIds]);
            logEvent('notifications.hidden.purged', { count: droppedMessageIds.size });
          } catch {
            logEvent('notifications.hidden.purge_failed');
          }
        }
        const notifications: PublicNotification[] = kept
          .slice(0, NOTIFICATION_LIST_LIMIT)
          .map(serializeNotification);
        const unreadCount = kept.filter((row) => row.readAt === null).length;
        return c.json({ notifications, unreadCount }, 200);
      } catch {
        logEvent('notifications.list.failed');
        return c.json({ error: 'Notifications are unavailable' }, 503);
      }
    })
    .post('/read-all', async (c) => {
      const account = await authedAccount(deps, c.req.header('authorization'));
      if (account === null) {
        return c.json({ error: 'Unauthorized' }, 401);
      }
      const body = await c.req.json().catch(() => null);
      try {
        const stamped = await deps.store.markAllRead(account.id, new Date(deps.now()));
        const tags = tagsFromRows(stamped);
        await enqueueDismissForAccount({
          deps,
          accountId: account.id,
          tags,
          body,
        });
        return c.json({ ok: true, tags }, 200);
      } catch {
        logEvent('notifications.read_all.failed');
        return c.json({ error: 'Notifications are unavailable' }, 503);
      }
    })
    .post('/read-by-message', async (c) => {
      const account = await authedAccount(deps, c.req.header('authorization'));
      if (account === null) {
        return c.json({ error: 'Unauthorized' }, 401);
      }
      const body = await c.req.json().catch(() => null);
      if (body === null || typeof body !== 'object' || Array.isArray(body)) {
        return c.json({ error: 'Not found' }, 404);
      }
      const messageId = (body as Record<string, unknown>)['messageId'];
      if (typeof messageId !== 'string' || !NOTIFICATION_ID_RE.test(messageId)) {
        return c.json({ error: 'Not found' }, 404);
      }
      try {
        const stamped = await deps.store.markReadByMessage(
          account.id,
          messageId,
          new Date(deps.now()),
        );
        const tags = tagsFromRows(stamped);
        await enqueueDismissForAccount({
          deps,
          accountId: account.id,
          tags,
          body,
        });
        return c.json({ ok: true, tags }, 200);
      } catch {
        logEvent('notifications.read_message.failed');
        return c.json({ error: 'Notifications are unavailable' }, 503);
      }
    })
    .post('/:id/read', async (c) => {
      const account = await authedAccount(deps, c.req.header('authorization'));
      if (account === null) {
        return c.json({ error: 'Unauthorized' }, 401);
      }
      const id = c.req.param('id');
      if (!NOTIFICATION_ID_RE.test(id)) {
        return c.json({ error: 'Not found' }, 404);
      }
      const body = await c.req.json().catch(() => null);
      try {
        const outcome = await deps.store.markRead(id, account.id, new Date(deps.now()));
        if (outcome.row === undefined) {
          return c.json({ error: 'Not found' }, 404);
        }
        if (outcome.stamped) {
          const tag = pushTagForNotification(outcome.row);
          if (tag !== null) {
            await enqueueDismissForAccount({
              deps,
              accountId: account.id,
              tags: [tag],
              body,
            });
          }
        }
        return c.json(serializeNotification(outcome.row), 200);
      } catch {
        logEvent('notifications.read.failed');
        return c.json({ error: 'Notifications are unavailable' }, 503);
      }
    });
}
