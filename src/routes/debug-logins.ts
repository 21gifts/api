/**
 * Operator login controls: the login switch, its allowlist, and ending every
 * session. Authenticated by `DEBUG_TOKEN` (Bearer), not by an end-user session.
 */

import { Hono } from 'hono';
import type { MiddlewareHandler } from 'hono';
import { z } from 'zod';
import type { AuthStore } from '@/lib/auth/store';
import { bearerMatchesDebugToken } from '@/lib/debug-token';
import type { LoginGate } from '@/lib/login-gate';
import { logEvent } from '@/lib/log';
import { MESSAGE_ID_RE } from '@/routes/messages';

/** Collaborators the operator login routes need. */
export interface DebugLoginsRouteDeps {
  /** Shared auth persistence port (account lookup, session wipe). */
  authStore: AuthStore;
  /** Login switch and allowlist. */
  loginGate: LoginGate;
  /** Clock returning epoch milliseconds. */
  now: () => number;
  /** Configured operator token, or `undefined` when debug is disabled. */
  debugToken: string | undefined;
}

/** Body of `PUT /debug/logins`. */
const switchBody = z.object({ open: z.boolean() }).strict();

/** Body of `POST /debug/logins/allowlist`. */
const allowlistBody = z.object({ accountId: z.string().regex(MESSAGE_ID_RE) }).strict();

const SWITCH_BODY_ERROR = 'Expected a JSON body with an "open" boolean';
const ALLOWLIST_BODY_ERROR = 'Expected a JSON body with an "accountId" uuid';

/** Shared 503/401 gate for every route here (before JSON). */
function requireDebugToken(deps: DebugLoginsRouteDeps): MiddlewareHandler {
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
 * Current switch plus allowlist, as every switch and allowlist route answers.
 *
 * @param gate - Login switch and allowlist.
 * @returns JSON body.
 */
async function loginsBody(gate: LoginGate): Promise<{
  open: boolean;
  source: 'stored' | 'default';
  defaultOpen: boolean;
  allowlist: { accountId: string; createdAt: string }[];
}> {
  const state = await gate.state();
  const allowlist = await gate.store.listAllowlist();
  return {
    ...state,
    allowlist: allowlist.map((row) => ({
      accountId: row.accountId,
      createdAt: new Date(row.createdAt).toISOString(),
    })),
  };
}

/**
 * Build the operator login routes.
 *
 * Mounted at `/debug`: `GET /debug/logins`, `PUT /debug/logins`,
 * `POST /debug/logins/allowlist`, `DELETE /debug/logins/allowlist/:accountId`,
 * and `DELETE /debug/sessions`.
 *
 * @param deps - Auth store, login gate, clock, debug token.
 * @returns A Hono app exposing the five routes.
 */
export function debugLoginsRoutes(deps: DebugLoginsRouteDeps): Hono {
  return new Hono()
    .use('/logins', requireDebugToken(deps))
    .use('/logins/*', requireDebugToken(deps))
    .use('/sessions', requireDebugToken(deps))
    .get('/logins', async (c) => c.json(await loginsBody(deps.loginGate), 200))
    .put('/logins', async (c) => {
      const parsed = switchBody.safeParse(await c.req.json().catch(() => null));
      if (!parsed.success) {
        return c.json({ error: SWITCH_BODY_ERROR }, 400);
      }
      await deps.loginGate.store.setLoginsOpen(parsed.data.open, deps.now());
      logEvent('debug.logins.set', { open: parsed.data.open });
      return c.json(await loginsBody(deps.loginGate), 200);
    })
    .post('/logins/allowlist', async (c) => {
      const parsed = allowlistBody.safeParse(await c.req.json().catch(() => null));
      if (!parsed.success) {
        return c.json({ error: ALLOWLIST_BODY_ERROR }, 400);
      }
      const accountId = parsed.data.accountId.toLowerCase();
      if ((await deps.authStore.getAccount(accountId)) === undefined) {
        return c.json({ error: 'Not found' }, 404);
      }
      const added = await deps.loginGate.store.addToAllowlist(accountId, deps.now());
      logEvent('debug.logins.allowlist.add', { accountId, added });
      return c.json({ added, ...(await loginsBody(deps.loginGate)) }, 200);
    })
    .delete('/logins/allowlist/:accountId', async (c) => {
      const raw = c.req.param('accountId');
      if (!MESSAGE_ID_RE.test(raw)) {
        return c.json({ error: 'Not found' }, 404);
      }
      const accountId = raw.toLowerCase();
      const removed = await deps.loginGate.store.removeFromAllowlist(accountId);
      logEvent('debug.logins.allowlist.remove', { accountId, removed });
      return c.json({ removed, ...(await loginsBody(deps.loginGate)) }, 200);
    })
    .delete('/sessions', async (c) => {
      const deleted = await deps.authStore.deleteAllSessions();
      logEvent('debug.sessions.deleted', { deleted });
      return c.json({ deleted }, 200);
    });
}
