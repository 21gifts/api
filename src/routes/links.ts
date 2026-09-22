import { Hono } from 'hono';
import type { AuthStore } from '@/lib/auth/store';
import type { MessageStore } from '@/lib/message-store';

/**
 * Build the `/links` route group.
 *
 * @param deps - Message and account prefix lookups.
 * @returns A Hono app with `GET /:code`.
 */
export function linksRoutes(deps: {
  messages: Pick<MessageStore, 'listIdsByPrefix'>;
  accounts: Pick<AuthStore, 'listIdsByPrefix'>;
}): Hono {
  return new Hono().get('/:code', async (c) => {
    const code = c.req.param('code').toLowerCase();
    if (/^[0-9a-f]{8}$/.test(code) !== true) {
      return c.json({ error: 'invalid_code' }, 400);
    }
    const messageIds = await deps.messages.listIdsByPrefix(code);
    const accountIds = await deps.accounts.listIdsByPrefix(code);
    const total = messageIds.length + accountIds.length;
    if (total === 0) {
      return c.json({ error: 'not_found' }, 404);
    }
    if (total !== 1) {
      return c.json({ error: 'ambiguous' }, 409);
    }
    if (messageIds.length === 1) {
      const id = messageIds[0];
      /* v8 ignore next 3 -- length === 1 on a dense array has an id */
      if (id === undefined) {
        return c.json({ error: 'not_found' }, 404);
      }
      return c.json({ kind: 'message', id: id.toLowerCase() }, 200);
    }
    const id = accountIds[0];
    /* v8 ignore next 3 -- length === 1 on a dense array has an id */
    if (id === undefined) {
      return c.json({ error: 'not_found' }, 404);
    }
    return c.json({ kind: 'member', id: id.toLowerCase() }, 200);
  });
}
