/**
 * Operator debug ping that enqueues a test Web Push for one account.
 * Authenticated by `DEBUG_TOKEN` (Bearer), not by an end-user session.
 */

import { Hono } from 'hono';
import type { MiddlewareHandler } from 'hono';
import type { AuthStore } from '@/lib/auth/store';
import { bearerMatchesDebugToken } from '@/lib/debug-token';
import type { PushStore } from '@/lib/push-store';
import { enqueueDebugPush } from '@/lib/push-worker';

/** Collaborators the debug push-ping route needs. */
export interface DebugPushRouteDeps {
  /** Shared auth persistence port. */
  authStore: AuthStore;
  /** Push subscription / outbox store. */
  pushStore: PushStore;
  /** Clock returning epoch milliseconds. */
  now: () => number;
  /** Configured operator token, or `undefined` when debug is disabled. */
  debugToken: string | undefined;
  /**
   * Public VAPID key when configured; missing/blank → 503
   * `{ error: "Push is not configured" }` after the debug gate.
   */
  vapidPublicKey: string | undefined;
}

/** Shared 503/401 gate for every `/debug/push-ping` method (before JSON). */
function requireDebugToken(deps: DebugPushRouteDeps): MiddlewareHandler {
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
 * Build the `/debug/push-ping` route group.
 *
 * Mounted at `/debug/push-ping` so the public path is `POST /debug/push-ping`.
 *
 * @param deps - Auth store, push store, clock, debug token, VAPID public key.
 * @returns A Hono app exposing `POST /`.
 */
export function debugPushRoutes(deps: DebugPushRouteDeps): Hono {
  return new Hono().use('*', requireDebugToken(deps)).post('/', async (c) => {
    if (deps.vapidPublicKey === undefined || deps.vapidPublicKey.trim() === '') {
      return c.json({ error: 'Push is not configured' }, 503);
    }
    const body = (await c.req.json().catch(() => null)) as { accountId?: unknown } | null;
    const accountId = body?.accountId;
    if (typeof accountId !== 'string' || accountId.trim() === '') {
      return c.json({ error: 'Expected a JSON body with an "accountId" string' }, 400);
    }
    const account = await deps.authStore.getAccount(accountId);
    if (account === undefined) {
      return c.json({ error: 'Not found' }, 404);
    }
    const enqueued = await enqueueDebugPush(deps.pushStore, accountId, deps.now());
    return c.json({ enqueued }, 200);
  });
}
