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
        const parentIds = [...new Set(rows.map((row) => row.parentId))];
        const parentById = new Map<string, MessageRow>();
        for (const id of parentIds) {
          const parent = await deps.messages.getById(id);
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
        const notifications: PublicNotification[] = matched
          .slice(0, NOTIFICATION_LIST_LIMIT)
          .map(serializeNotification);
        const unreadCount = matched.filter((row) => row.readAt === null).length;
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
