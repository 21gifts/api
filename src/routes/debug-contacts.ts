import { Hono } from 'hono';
import { serializeDebugContact } from '@/lib/contact';
import type { ContactStore } from '@/lib/contact-store';
import { bearerMatchesDebugToken } from '@/lib/debug-token';
import { logEvent } from '@/lib/log';
import { MESSAGE_LIST_LIMIT } from '@/lib/message';

/**
 * Operator debug surface. Read-only listing of private contact messages.
 * Authenticated by `DEBUG_TOKEN` (Bearer), not by an end-user session.
 */

/** Collaborators the debug contact routes need. */
export interface DebugContactsRouteDeps {
  /** Contact persistence port. */
  store: ContactStore;
  /** Configured operator token, or `undefined` when debug is disabled. */
  debugToken: string | undefined;
}

/**
 * Build the `/debug/contacts` route group.
 *
 * @param deps - Contact store and optional debug token.
 * @returns A Hono app exposing `GET /`.
 */
export function debugContactsRoutes(deps: DebugContactsRouteDeps): Hono {
  return new Hono().get('/', async (c) => {
    const token = deps.debugToken;
    if (token === undefined || token.trim() === '') {
      return c.json({ error: 'Debug is not configured' }, 503);
    }
    if (!bearerMatchesDebugToken(token, c.req.header('authorization'))) {
      return c.json({ error: 'Unauthorized' }, 401);
    }
    try {
      const rows = await deps.store.listLatest(MESSAGE_LIST_LIMIT);
      logEvent('debug.contacts.listed', { count: rows.length });
      return c.json({ contacts: rows.map((row) => serializeDebugContact(row)) }, 200);
    } catch {
      logEvent('contact.list.failed');
      return c.json({ error: 'Contact is unavailable' }, 503);
    }
  });
}
