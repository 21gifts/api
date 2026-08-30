/**
 * `GET /.well-known/nostr.json` — NIP-05 directory (CORS `*`).
 *
 * Damus fetches this from the site apex (`21.gifts` / `dev.21.gifts`); the
 * app proxies same-origin. Direct hits on the API host also work.
 */

import { Hono } from 'hono';
import type { AuthStore } from '@/lib/auth/store';
import { buildNostrJson } from '@/lib/nip05';
import { logEvent } from '@/lib/log';

/** Collaborators for the well-known routes. */
export interface WellKnownRouteDeps {
  /** Auth store (names + pubkeys). */
  auth: AuthStore;
  /** Process env for write-set relays. */
  env?: Record<string, string | undefined>;
}

/**
 * Build the `/.well-known` route group.
 *
 * @param deps - Auth store and env.
 * @returns Hono app with `GET /nostr.json`.
 */
export function wellKnownRoutes(deps: WellKnownRouteDeps): Hono {
  const env = deps.env ?? process.env;
  return new Hono().get('/nostr.json', async (c) => {
    const cors = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Cache-Control': 'public, max-age=60',
    };
    try {
      const name = c.req.query('name') ?? undefined;
      const body = await buildNostrJson(deps.auth, env, name);
      return c.json(body, 200, cors);
    } catch {
      logEvent('nostr.nip05.failed');
      return c.json({ error: 'Directory is unavailable' }, 503, cors);
    }
  });
}
