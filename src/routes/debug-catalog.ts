import { Hono } from 'hono';
import type { MiddlewareHandler } from 'hono';
import type { AuthStore } from '@/lib/auth/store';
import type { ContactStore } from '@/lib/contact-store';
import type { ConversationStore } from '@/lib/conversation-store';
import { bearerMatchesDebugToken } from '@/lib/debug-token';
import { isDebugCatalogTable, loadDebugTables, type DebugCatalogDeps } from '@/lib/debug-catalog';
import type { GiftStore } from '@/lib/gift-store';
import { logEvent } from '@/lib/log';
import type { MessageStore } from '@/lib/message-store';
import type { NotificationStore } from '@/lib/notification-store';
import type { PushStore } from '@/lib/push-store';
import type { TrustStore } from '@/lib/trust-store';

/** Collaborators for GET `/debug/dump`. */
export interface DebugCatalogRouteDeps {
  /** Auth persistence. */
  auth: AuthStore;
  /** Forum persistence. */
  messages: MessageStore;
  /** Contact mailbox. */
  contacts: ContactStore;
  /** Optional private threads. */
  conversations?: ConversationStore;
  /** Optional notifications. */
  notifications?: NotificationStore;
  /** Optional Web Push. */
  push?: PushStore;
  /** Optional trust edges. */
  trust?: TrustStore;
  /** Optional house gifts. */
  gifts?: GiftStore;
  /** Configured operator token, or `undefined` when debug is disabled. */
  debugToken: string | undefined;
}

function requireDebugToken(deps: DebugCatalogRouteDeps): MiddlewareHandler {
  return async (c, next) => {
    const token = deps.debugToken;
    if (token === undefined || token.trim() === '') {
      return c.json({ error: 'Debug is not configured' }, 503);
    }
    if (!bearerMatchesDebugToken(token, c.req.header('authorization'))) {
      return c.json({ error: 'Unauthorized' }, 401);
    }
    await next();
  };
}

function catalogDeps(deps: DebugCatalogRouteDeps): DebugCatalogDeps {
  const catalog: DebugCatalogDeps = {
    auth: deps.auth,
    messages: deps.messages,
    contacts: deps.contacts,
  };
  if (deps.conversations !== undefined) {
    catalog.conversations = deps.conversations;
  }
  if (deps.notifications !== undefined) {
    catalog.notifications = deps.notifications;
  }
  if (deps.push !== undefined) {
    catalog.push = deps.push;
  }
  if (deps.trust !== undefined) {
    catalog.trust = deps.trust;
  }
  if (deps.gifts !== undefined) {
    catalog.gifts = deps.gifts;
  }
  return catalog;
}

/**
 * Build the `/debug/dump` route group (GET-only operator catalog).
 *
 * @param deps - Stores and optional debug token.
 * @returns A Hono app exposing `GET /` and `GET /:table`.
 */
export function debugCatalogRoutes(deps: DebugCatalogRouteDeps): Hono {
  return new Hono()
    .use('*', requireDebugToken(deps))
    .get('/', async (c) => {
      try {
        const tables = await loadDebugTables(catalogDeps(deps));
        logEvent('debug.dump.listed', { tables: Object.keys(tables).length });
        return c.json({ tables }, 200);
      } catch {
        logEvent('debug.dump.failed');
        return c.json({ error: 'Dump is unavailable' }, 503);
      }
    })
    .get('/:table', async (c) => {
      const table = c.req.param('table');
      if (!isDebugCatalogTable(table)) {
        return c.json({ error: 'Not found' }, 404);
      }
      try {
        const tables = await loadDebugTables(catalogDeps(deps), table);
        logEvent('debug.dump.table', { table });
        return c.json({ table, rows: tables[table] }, 200);
      } catch {
        logEvent('debug.dump.table_failed', { table });
        return c.json({ error: 'Dump is unavailable' }, 503);
      }
    });
}
