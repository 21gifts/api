/**
 * `GET /.well-known/nostr.json` — NIP-05 directory (CORS `*`).
 * `GET /.well-known/lnurlp/:username` — LUD-16 payRequest (CORS `*`).
 *
 * Damus and Lightning wallets fetch these from the site apex (`21.gifts` /
 * `dev.21.gifts`); the app proxies same-origin. Direct hits on the API host
 * also work. LNURL-pay settlement stays on the account's linked Wallet of
 * Satoshi address. Callback and metadata stay on that document. While an
 * unexpired pending point-of-sale charge exists, both sendable bounds
 * become that amount in millisats.
 */

import { Hono } from 'hono';
import type { AuthStore } from '@/lib/auth/store';
import type { FetchFn } from '@/lib/lnurlp';
import { resolveLnurlpDocument } from '@/lib/lnurlp';
import { InMemoryPosStore, type PosStore } from '@/lib/pos-store';
import { buildNostrJson } from '@/lib/nip05';
import { logEvent } from '@/lib/log';
import { normalizeUsername } from '@/lib/username';

/** Collaborators for the well-known routes. */
export interface WellKnownRouteDeps {
  /** Auth store (names + pubkeys + linked Lightning Address). */
  auth: AuthStore;
  /** Process env for write-set relays. */
  env?: Record<string, string | undefined>;
  /** Injected `fetch` for Wallet of Satoshi LNURL-pay. Default `globalThis.fetch`. */
  fetchImpl?: FetchFn;
  /** Open point-of-sale charges. Default empty in-memory store. */
  posStore?: PosStore;
  /** Clock in epoch milliseconds. Default `Date.now`. */
  now?: () => number;
}

const WELL_KNOWN_CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Cache-Control': 'public, max-age=60',
};

/**
 * Build the `/.well-known` route group.
 *
 * @param deps - Auth store, env, optional fetch, optional pos store, and optional clock.
 * @returns Hono app with `GET /nostr.json` and `GET /lnurlp/:username`.
 */
export function wellKnownRoutes(deps: WellKnownRouteDeps): Hono {
  const env = deps.env ?? process.env;
  /* v8 ignore next -- createApp always injects fetchImpl */
  const fetchImpl = deps.fetchImpl ?? globalThis.fetch;
  const posStore = deps.posStore ?? new InMemoryPosStore();
  const now = deps.now ?? (() => Date.now());
  return new Hono()
    .get('/nostr.json', async (c) => {
      try {
        const name = c.req.query('name') ?? undefined;
        const body = await buildNostrJson(deps.auth, env, name);
        return c.json(body, 200, WELL_KNOWN_CORS);
      } catch {
        logEvent('nostr.nip05.failed');
        return c.json({ error: 'Directory is unavailable' }, 503, WELL_KNOWN_CORS);
      }
    })
    .get('/lnurlp/:username', async (c) => {
      const username = normalizeUsername(c.req.param('username'));
      if (username === null) {
        return c.json({ error: 'Not found' }, 404, WELL_KNOWN_CORS);
      }
      try {
        const account = await deps.auth.getAccountByUsername(username);
        const linked = account?.lightningAddress?.trim() ?? '';
        if (account === undefined || linked === '') {
          logEvent('lnurlp.unknown', { username });
          return c.json({ error: 'Not found' }, 404, WELL_KNOWN_CORS);
        }
        const resolved = await resolveLnurlpDocument({
          address: linked,
          fetchImpl,
        });
        if (!resolved.ok) {
          logEvent('lnurlp.unreachable', { username });
          return c.json({ error: 'Lightning Address could not be resolved' }, 502, WELL_KNOWN_CORS);
        }
        logEvent('lnurlp.resolved', { username });
        const pending = await posStore.currentPending(account.id, now());
        if (pending !== null) {
          const minSendable = resolved.body['minSendable'];
          const maxSendable = resolved.body['maxSendable'];
          /* v8 ignore start -- resolveLnurlpDocument only yields numeric minSendable and maxSendable */
          if (typeof minSendable !== 'number' || typeof maxSendable !== 'number') {
            return c.json(resolved.body, 200, WELL_KNOWN_CORS);
          }
          /* v8 ignore stop */
          return c.json(
            {
              ...resolved.body,
              minSendable: pending.amountSats * 1000,
              maxSendable: pending.amountSats * 1000,
            },
            200,
            WELL_KNOWN_CORS,
          );
        }
        return c.json(resolved.body, 200, WELL_KNOWN_CORS);
      } catch {
        logEvent('lnurlp.failed', { username });
        return c.json({ error: 'Lightning Address could not be resolved' }, 502, WELL_KNOWN_CORS);
      }
    });
}
