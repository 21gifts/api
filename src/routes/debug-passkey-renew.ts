/**
 * Operator debug action that reopens the blocking passkey-renew dialog.
 * Authenticated by an operator key token of the SSH key login (Bearer), not by an end-user session.
 */

import { Hono } from 'hono';
import type { OperatorLogin } from '@/lib/operator-login';
import type { AuthStore } from '@/lib/auth/store';
import { requireOperator } from '@/lib/operator';
import { logEvent } from '@/lib/log';

/** Collaborators the debug passkey-renew routes need. */
export interface DebugPasskeyRenewRouteDeps {
  /** Shared auth persistence port. */
  authStore: AuthStore;
  /** SSH key login whose short-lived tokens this route accepts. */
  operatorLogin?: OperatorLogin | undefined;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Build the `/debug/passkey-renew` route group.
 *
 * Mounted at `/debug/passkey-renew` so the public path is
 * `POST /debug/passkey-renew/reopen`.
 *
 * @param deps - Auth store and optional key login.
 * @returns A Hono app exposing `POST /reopen`.
 */
export function debugPasskeyRenewRoutes(deps: DebugPasskeyRenewRouteDeps): Hono {
  return new Hono().post('/reopen', requireOperator('write', deps), async (c) => {
    const body = (await c.req.json().catch(() => null)) as { accountId?: unknown } | null;
    const accountIdRaw = body?.accountId;
    if (typeof accountIdRaw !== 'string' || !UUID_RE.test(accountIdRaw.trim())) {
      return c.json({ error: 'Invalid account' }, 400);
    }
    const accountId = accountIdRaw.trim().toLowerCase();
    const account = await deps.authStore.getAccount(accountId);
    if (account === undefined) {
      return c.json({ error: 'Not found' }, 404);
    }
    if (account.walletRequired === true) {
      return c.json({ error: 'Account already has a seed' }, 409);
    }
    const deleted = await deps.authStore.deleteFailedPasskeyRenewAttempts(accountId);
    logEvent('debug.passkey_renew.reopened', { accountId, deleted });
    return c.json({ deleted }, 200);
  });
}
