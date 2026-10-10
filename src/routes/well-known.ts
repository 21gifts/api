/**
 * `GET /.well-known/nostr.json` — NIP-05 directory (CORS `*`).
 * `GET /.well-known/lnurlp/:username` — LUD-16 payRequest (CORS `*`).
 *
 * Damus and Lightning wallets fetch these from the site apex (`21.gifts` /
 * `dev.21.gifts`); the app proxies same-origin. Direct hits on the API host
 * also work.
 *
 * A member receives only on their in-app wallet: with the self-hosted LNURL
 * server configured and a verified wallet key, this route serves that
 * server's payRequest (callback under this api's public base URL). Any other
 * username is not found. While an unexpired pending point-of-sale charge
 * exists, both sendable bounds become that amount in millisats.
 */

import { Hono } from 'hono';
import type { AuthStore } from '@/lib/auth/store';
import type { LnurlServerConfig } from '@/lib/config';
import { IpRateLimiter } from '@/lib/ip-rate-limit';
import type { FetchFn } from '@/lib/lnurlp';
import {
  LNURL_PAY_REQUEST_TIMEOUT_MS,
  callLnurlServer,
  walletPayRequest,
} from '@/lib/lnurl-server';
import { InMemoryPosStore, type PosStore } from '@/lib/pos-store';
import { buildNostrJson } from '@/lib/nip05';
import { logEvent } from '@/lib/log';
import { readClientRequestMeta } from '@/lib/request-meta';
import { normalizeUsername } from '@/lib/username';

/** Collaborators for the well-known routes. */
export interface WellKnownRouteDeps {
  /** Auth store (names, pubkeys, and wallet verification). */
  auth: AuthStore;
  /** Process env for write-set relays. */
  env?: Record<string, string | undefined>;
  /** Injected `fetch` for the LNURL server. Default `globalThis.fetch`. */
  fetchImpl?: FetchFn;
  /** Open point-of-sale charges. Default empty in-memory store. */
  posStore?: PosStore;
  /** Clock in epoch milliseconds. Default `Date.now`. */
  now?: () => number;
  /** LNURL server configuration; omitted when the feature is off. */
  lnurlServer?: LnurlServerConfig;
}

const WELL_KNOWN_CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Cache-Control': 'public, max-age=60',
};

/** LNURL-pay must not be cached: a till pin appears and disappears within minutes. */
const LNURLP_HEADERS = {
  ...WELL_KNOWN_CORS,
  'Cache-Control': 'no-store',
};

/**
 * Build the `/.well-known` route group.
 *
 * @param deps - Auth store, env, optional fetch, optional pos store, optional clock,
 *   and optional LNURL server config for the wallet-backed payRequest branch.
 * @returns Hono app with `GET /nostr.json` and `GET /lnurlp/:username`.
 */
export function wellKnownRoutes(deps: WellKnownRouteDeps): Hono {
  const env = deps.env ?? process.env;
  /* v8 ignore next -- createApp always injects fetchImpl */
  const fetchImpl = deps.fetchImpl ?? globalThis.fetch;
  const posStore = deps.posStore ?? new InMemoryPosStore();
  const now = deps.now ?? (() => Date.now());
  const walletPayLimiter = new IpRateLimiter(120);
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
        return c.json({ error: 'Not found' }, 404, LNURLP_HEADERS);
      }
      try {
        const account = await deps.auth.getAccountByUsername(username);
        if (
          deps.lnurlServer !== undefined &&
          account !== undefined &&
          typeof account.sparkPubkeyVerifiedAt === 'number'
        ) {
          const clientIp = readClientRequestMeta(c.req.raw.headers).clientIp;
          if (!walletPayLimiter.allow(clientIp, now())) {
            return c.json({ error: 'Too many requests' }, 429, LNURLP_HEADERS);
          }
          const config = deps.lnurlServer;
          const result = await callLnurlServer(config, fetchImpl, {
            method: 'GET',
            segments: ['.well-known', 'lnurlp', username],
            timeoutMs: LNURL_PAY_REQUEST_TIMEOUT_MS,
          });
          if (result.ok && result.status === 404) {
            return c.json({ error: 'Not found' }, 404, LNURLP_HEADERS);
          }
          if (!result.ok || result.status < 200 || result.status >= 300) {
            logEvent('lnurlp.unreachable', { username });
            return c.json(
              { error: 'Lightning Address could not be resolved' },
              503,
              LNURLP_HEADERS,
            );
          }
          let parsed: unknown;
          try {
            parsed = JSON.parse(result.body);
          } catch {
            logEvent('lnurlp.unreachable', { username });
            return c.json(
              { error: 'Lightning Address could not be resolved' },
              503,
              LNURLP_HEADERS,
            );
          }
          const expectedCallback = `${config.publicBaseUrl}/lnurlp/${username}/invoice`;
          const doc = walletPayRequest(parsed, expectedCallback);
          if (doc === null) {
            logEvent('lnurlp.unreachable', { username });
            return c.json(
              { error: 'Lightning Address could not be resolved' },
              503,
              LNURLP_HEADERS,
            );
          }
          logEvent('lnurlp.resolved', { username });
          const pending = await posStore.currentPending(account.id, now());
          if (pending !== null) {
            return c.json(
              {
                ...doc,
                minSendable: pending.amountSats * 1000,
                maxSendable: pending.amountSats * 1000,
              },
              200,
              LNURLP_HEADERS,
            );
          }
          return c.json(doc, 200, LNURLP_HEADERS);
        }
        logEvent('lnurlp.unknown', { username });
        return c.json({ error: 'Not found' }, 404, LNURLP_HEADERS);
      } catch {
        logEvent('lnurlp.failed', { username });
        return c.json({ error: 'Lightning Address could not be resolved' }, 502, LNURLP_HEADERS);
      }
    });
}
