/**
 * Member Web Push routes: VAPID public key and subscription CRUD.
 *
 * Mounted at `/` so discovery sees the full public paths
 * `/push/vapid-public` and `/me/push-subscriptions`.
 */

import { Hono } from 'hono';
import { resolveSession } from '@/lib/auth/service';
import type { Account, AuthStore } from '@/lib/auth/store';
import { parsePushSubscription } from '@/lib/push';
import type { PushStore } from '@/lib/push-store';
import { bearerToken } from '@/routes/me';

/** Collaborators the push routes need. */
export interface PushRouteDeps {
  /** Shared auth persistence port. */
  authStore: AuthStore;
  /** Push subscription / outbox store. */
  pushStore: PushStore;
  /** Clock returning epoch milliseconds. */
  now: () => number;
  /**
   * Public VAPID key when configured; missing/blank → 503 on push HTTP
   * (session check still runs first).
   */
  vapidPublicKey: string | undefined;
}

/** Resolve the account and token behind a request's bearer session, or `null`. */
async function authedSession(
  deps: PushRouteDeps,
  header: string | undefined,
): Promise<{ account: Account; token: string } | null> {
  const token = bearerToken(header);
  if (token === null) {
    return null;
  }
  const account = await resolveSession(deps.authStore, deps.now(), token);
  return account === null ? null : { account, token };
}

/** Resolve the account behind a request's bearer session, or `null`. */
async function authedAccount(
  deps: PushRouteDeps,
  header: string | undefined,
): Promise<Account | null> {
  const session = await authedSession(deps, header);
  return session === null ? null : session.account;
}

/** Whether push HTTP may proceed past the configured gate. */
function pushConfigured(deps: PushRouteDeps): boolean {
  return deps.vapidPublicKey !== undefined && deps.vapidPublicKey.trim() !== '';
}

/**
 * Build the Web Push route group (full public path strings for handbook discovery).
 *
 * @param deps - Auth store, push store, clock, optional VAPID public key.
 * @returns A Hono app with GET/POST/DELETE on the public paths.
 */
export function pushRoutes(deps: PushRouteDeps): Hono {
  return new Hono()
    .get('/push/vapid-public', async (c) => {
      const account = await authedAccount(deps, c.req.header('authorization'));
      if (account === null) {
        return c.json({ error: 'Unauthorized' }, 401);
      }
      if (!pushConfigured(deps)) {
        return c.json({ error: 'Push is not configured' }, 503);
      }
      return c.json({ publicKey: deps.vapidPublicKey }, 200);
    })
    .post('/me/push-subscriptions', async (c) => {
      const session = await authedSession(deps, c.req.header('authorization'));
      if (session === null) {
        return c.json({ error: 'Unauthorized' }, 401);
      }
      if (!pushConfigured(deps)) {
        return c.json({ error: 'Push is not configured' }, 503);
      }
      const parsed = parsePushSubscription(await c.req.json().catch(() => null));
      if (parsed === null) {
        return c.json({ error: 'Invalid subscription' }, 400);
      }
      const createdAt = new Date(deps.now());
      const stored = await deps.pushStore.upsertSubscription({
        endpoint: parsed.endpoint,
        accountId: session.account.id,
        p256dh: parsed.p256dh,
        auth: parsed.auth,
        createdAt,
        sessionToken: session.token,
      });
      return c.json({ endpoint: stored.endpoint, createdAt: stored.createdAt.toISOString() }, 200);
    })
    .delete('/me/push-subscriptions', async (c) => {
      const account = await authedAccount(deps, c.req.header('authorization'));
      if (account === null) {
        return c.json({ error: 'Unauthorized' }, 401);
      }
      if (!pushConfigured(deps)) {
        return c.json({ error: 'Push is not configured' }, 503);
      }
      const body = (await c.req.json().catch(() => null)) as { endpoint?: unknown } | null;
      const endpoint = body?.endpoint;
      if (typeof endpoint !== 'string' || endpoint.trim() === '') {
        return c.json({ error: 'Invalid subscription' }, 400);
      }
      const removed = await deps.pushStore.deleteSubscription(account.id, endpoint);
      if (!removed) {
        return c.json({ error: 'Not found' }, 404);
      }
      return c.json({ ok: true }, 200);
    });
}
