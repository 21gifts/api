import { Hono } from 'hono';
import type { MiddlewareHandler } from 'hono';
import { z } from 'zod';
import { serializeAccount } from '@/lib/auth/account-json';
import type { AuthStore } from '@/lib/auth/store';
import { bearerMatchesDebugToken } from '@/lib/debug-token';
import { logEvent } from '@/lib/log';

/**
 * Operator debug surface for registered accounts.
 * Authenticated by `DEBUG_TOKEN` (Bearer), not by an end-user session.
 * Exposes `GET /` (list) and `PATCH /:id` (set role).
 */

/** Collaborators the debug routes need. */
export interface DebugRouteDeps {
  /** Shared auth persistence port. */
  store: AuthStore;
  /** Configured operator token, or `undefined` when debug is disabled. */
  debugToken: string | undefined;
}

/** Body schema for operator role assignment. */
const roleBody = z.object({
  role: z.enum(['basis', 'verified', 'moderator', 'founder']),
});

/** Shared 503/401 gate for every `/debug/accounts` method. */
function requireDebugToken(deps: DebugRouteDeps): MiddlewareHandler {
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

/**
 * Build the `/debug/accounts` route group.
 *
 * @param deps - Shared store and optional debug token.
 * @returns A Hono app exposing `GET /` and `PATCH /:id`.
 */
export function debugRoutes(deps: DebugRouteDeps): Hono {
  return new Hono()
    .use('*', requireDebugToken(deps))
    .get('/', async (c) => {
      const accounts = await deps.store.listAccounts();
      logEvent('debug.accounts.listed', { count: accounts.length });
      return c.json({ accounts: accounts.map(serializeAccount) }, 200);
    })
    .patch('/:id', async (c) => {
      const parsed = roleBody.safeParse(await c.req.json().catch(() => null));
      if (!parsed.success) {
        return c.json({ error: 'Expected a JSON body with a "role" string' }, 400);
      }
      const existing = await deps.store.getAccount(c.req.param('id'));
      if (existing === undefined) {
        return c.json({ error: 'Not found' }, 404);
      }
      const updated = { ...existing, role: parsed.data.role };
      await deps.store.updateAccount(updated);
      logEvent('debug.accounts.role_set', { accountId: updated.id, role: updated.role });
      return c.json(serializeAccount(updated), 200);
    });
}
