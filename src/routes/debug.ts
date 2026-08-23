import { Hono } from 'hono';
import type { Account, AuthStore } from '@/lib/auth/store';
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

/** Public JSON shape of an account (same fields as `/me`). */
interface AccountResponse {
  id: string;
  linkingKey: string;
  role: string;
  name: string | null;
  lightningAddress: string | null;
  lightningAddressVerified: boolean;
  createdAt: number;
}

/**
 * Project an account to its public JSON shape.
 *
 * @param account - Stored account.
 * @returns JSON fields matching `/me`.
 */
function serializeAccount(account: Account): AccountResponse {
  return {
    id: account.id,
    linkingKey: account.linkingKey,
    role: account.role,
    name: account.name,
    lightningAddress: account.lightningAddress,
    lightningAddressVerified: account.lightningAddressVerified,
    createdAt: account.createdAt,
  };
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
