import { Hono } from 'hono';
import { z } from 'zod';
import { normalizePublicBaseUrl } from '@/lib/config';
import { claimSession, completeCallback, startChallenge } from '@/lib/auth/service';
import type { AuthStore } from '@/lib/auth/store';
import { logEvent } from '@/lib/log';

/**
 * LNURL-auth (LUD-04) HTTP surface: challenge issuance for the app, the
 * wallet-facing callback, and the app's session-polling endpoint. State is
 * held in the injected {@link AuthStore} so one store is shared with `/me`.
 */

/** Collaborators the auth routes need. */
export interface AuthRouteDeps {
  /** Shared auth persistence port. */
  store: AuthStore;
  /** Clock returning epoch milliseconds (injected for testability). */
  now: () => number;
  /** Raw `PUBLIC_BASE_URL`; the pinned callback host, `undefined` if unset. */
  publicBaseUrl: string | undefined;
}

/** Query schema for the wallet-facing LUD-04 callback. */
const callbackQuery = z.object({
  k1: z.string(),
  sig: z.string(),
  key: z.string(),
});

/**
 * Build the `/auth` route group.
 *
 * @param deps - Shared store, clock, and the pinned public base URL.
 * @returns A Hono app exposing `/lnurl`, `/lnurl/callback`, and `/session`.
 */
export function authRoutes(deps: AuthRouteDeps): Hono {
  return new Hono()
    .get('/lnurl', async (c) => {
      const baseUrl = normalizePublicBaseUrl(deps.publicBaseUrl);
      if (baseUrl === null) {
        console.error('PUBLIC_BASE_URL is not configured; cannot issue an LNURL-auth challenge.');
        return c.json({ error: 'Server auth is not configured' }, 500);
      }
      const challenge = await startChallenge(deps.store, baseUrl, deps.now());
      logEvent('auth.challenge.issued', { k1: challenge.k1 });
      return c.json(challenge, 200);
    })
    .get('/lnurl/callback', async (c) => {
      const parsed = callbackQuery.safeParse(c.req.query());
      if (!parsed.success) {
        logEvent('auth.login.denied', { reason: 'Missing k1, sig, or key' });
        return c.json({ status: 'ERROR', reason: 'Missing k1, sig, or key' }, 200);
      }
      const result = await completeCallback(deps.store, deps.now(), parsed.data);
      if (!result.ok) {
        logEvent('auth.login.denied', { reason: result.reason });
        return c.json({ status: 'ERROR', reason: result.reason }, 200);
      }
      logEvent('auth.login.ok', {
        accountId: result.accountId,
        firstLogin: result.firstLogin,
        linkingKey: parsed.data.key.toLowerCase(),
        userAgent: c.req.header('user-agent') ?? 'unknown',
      });
      return c.json({ status: 'OK' }, 200);
    })
    .get('/session', async (c) => {
      // The poll is authorized by the secret X-Poll-Token (never in the QR), not
      // by the public k1 — a header, so it stays out of the request access log.
      const pollToken = c.req.header('x-poll-token');
      if (pollToken === undefined) {
        return c.json({ status: 'expired' }, 200);
      }
      const result = await claimSession(deps.store, deps.now(), pollToken);
      if (result.status === 'authenticated') {
        logEvent('auth.session.issued', { accountId: result.account.id });
      }
      return c.json(result, 200);
    });
}
