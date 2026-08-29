import { Hono } from 'hono';
import { serializeAccount } from '@/lib/auth/account-json';
import type { AuthStore } from '@/lib/auth/store';
import { bearerMatchesDebugToken } from '@/lib/debug-token';
import { logEvent } from '@/lib/log';

/**
 * Operator debug surface. Read-only listing of registered accounts.
 * Authenticated by `DEBUG_TOKEN` (Bearer), not by an end-user session.
 */

/** Collaborators the debug routes need. */
export interface DebugRouteDeps {
  /** Shared auth persistence port. */
  store: AuthStore;
  /** Configured operator token, or `undefined` when debug is disabled. */
  debugToken: string | undefined;
}

/**
 * Build the `/debug/accounts` route group.
 *
 * @param deps - Shared store and optional debug token.
 * @returns A Hono app exposing `GET /`.
 */
export function debugRoutes(deps: DebugRouteDeps): Hono {
  return new Hono().get('/', async (c) => {
    const token = deps.debugToken;
    if (token === undefined || token.trim() === '') {
      return c.json({ error: 'Debug is not configured' }, 503);
    }
    if (!bearerMatchesDebugToken(token, c.req.header('authorization'))) {
      return c.json({ error: 'Unauthorized' }, 401);
    }
    const accounts = await deps.store.listAccounts();
    logEvent('debug.accounts.listed', { count: accounts.length });
    return c.json({ accounts: accounts.map(serializeAccount) }, 200);
  });
}
