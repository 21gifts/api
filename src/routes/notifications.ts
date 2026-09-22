import { Hono } from 'hono';
import { resolveSession } from '@/lib/auth/service';
import type { Account, AuthStore } from '@/lib/auth/store';
import { logEvent } from '@/lib/log';
import type { MessageRow } from '@/lib/message';
import type { MessageStore } from '@/lib/message-store';
import {
  NOTIFICATION_FILTER_SCAN_LIMIT,
  NOTIFICATION_LIST_LIMIT,
  notificationsMatchingLevel,
  parseNotificationLevel,
  serializeNotification,
  type PublicNotification,
} from '@/lib/notification';
import type { NotificationStore } from '@/lib/notification-store';
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

/**
 * Build the `/notifications` route group.
 *
 * Mount `read-all` before `/:id/read` so `read-all` is not captured as an id.
 *
 * @param deps - Notification store, auth store, message store, and clock.
 * @returns A Hono app with list / mark-one / mark-all.
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
        const accounts = await deps.authStore.listAccounts();
        const lookupIds = [...new Set(rows.flatMap((row) => [row.parentId, row.replyId]))];
        const messageById = new Map<string, MessageRow | undefined>();
        for (const id of lookupIds) {
          messageById.set(id, await deps.messages.getById(id));
        }
        const parentById = new Map<string, MessageRow>();
        for (const id of new Set(rows.map((row) => row.parentId))) {
          const parent = messageById.get(id);
          if (parent !== undefined) {
            parentById.set(id, parent);
          }
        }
        const matched = notificationsMatchingLevel({
          rows,
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
      try {
        await deps.store.markAllRead(account.id, new Date(deps.now()));
        return c.json({ ok: true }, 200);
      } catch {
        logEvent('notifications.read_all.failed');
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
      try {
        const row = await deps.store.markRead(id, account.id, new Date(deps.now()));
        if (row === undefined) {
          return c.json({ error: 'Not found' }, 404);
        }
        return c.json(serializeNotification(row), 200);
      } catch {
        logEvent('notifications.read.failed');
        return c.json({ error: 'Notifications are unavailable' }, 503);
      }
    });
}
