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
import { shopErrorBody, type ShopPayments } from '@/lib/shop-payment';
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
  /** Shop payments in USDT and USDC; omitted when the LNURL server is off. */
  shopPayments?: ShopPayments;
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

/** The pay link's 503 when the wallet's pay request cannot be resolved. */
const UNRESOLVED_503 = shopErrorBody(503, 'Lightning Address could not be resolved');

/**
 * Today's wallet pay request, with both sendable bounds pinned to a waiting
 * charge's amount when one applies.
 *
 * @param doc - The validated wallet pay request.
 * @param pinSats - The charge amount, or `null` for no pin.
 * @returns The response body.
 */
function pinned(doc: Record<string, unknown>, pinSats: number | null): Record<string, unknown> {
  return pinSats === null
    ? doc
    : { ...doc, minSendable: pinSats * 1000, maxSendable: pinSats * 1000 };
}

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
      const requestStartMs = now();
      const username = normalizeUsername(c.req.param('username'));
      if (username === null) {
        return c.json(shopErrorBody(404, 'Not found'), 404, LNURLP_HEADERS);
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
            return c.json(shopErrorBody(429, 'Too many requests'), 429, LNURLP_HEADERS);
          }
          const config = deps.lnurlServer;
          const result = await callLnurlServer(config, fetchImpl, {
            method: 'GET',
            segments: ['.well-known', 'lnurlp', username],
            timeoutMs: LNURL_PAY_REQUEST_TIMEOUT_MS,
          });
          if (result.ok && result.status === 404) {
            return c.json(shopErrorBody(404, 'Not found'), 404, LNURLP_HEADERS);
          }
          if (!result.ok || result.status < 200 || result.status >= 300) {
            logEvent('lnurlp.unreachable', { username });
            return c.json(UNRESOLVED_503, 503, LNURLP_HEADERS);
          }
          let parsed: unknown;
          try {
            parsed = JSON.parse(result.body);
          } catch {
            logEvent('lnurlp.unreachable', { username });
            return c.json(UNRESOLVED_503, 503, LNURLP_HEADERS);
          }
          const expectedCallback = `${config.publicBaseUrl}/lnurlp/${username}/invoice`;
          const doc = walletPayRequest(parsed, expectedCallback);
          if (doc === null) {
            logEvent('lnurlp.unreachable', { username });
            return c.json(UNRESOLVED_503, 503, LNURLP_HEADERS);
          }
          logEvent('lnurlp.resolved', { username });
          const shop = deps.shopPayments;
          if (shop !== undefined) {
            const answer = await shop.payLink(
              account,
              username,
              String(doc['metadata']),
              {
                timeout: c.req.query('timeout') ?? null,
                method: c.req.query('method') ?? null,
                asset: c.req.query('asset') ?? null,
                repeated: ['quote', 'method', 'asset'].some(
                  (key) => (c.req.queries(key) ?? []).length > 1,
                ),
              },
              requestStartMs,
            );
            if (answer.kind === 'response') {
              return answer.response;
            }
            return c.json(pinned(doc, answer.pinSats), 200, LNURLP_HEADERS);
          }
          const pending = await posStore.currentPending(account.id, now());
          return c.json(pinned(doc, pending?.amountSats ?? null), 200, LNURLP_HEADERS);
        }
        logEvent('lnurlp.unknown', { username });
        return c.json(shopErrorBody(404, 'Not found'), 404, LNURLP_HEADERS);
      } catch {
        logEvent('lnurlp.failed', { username });
        return c.json(
          shopErrorBody(502, 'Lightning Address could not be resolved'),
          502,
          LNURLP_HEADERS,
        );
      }
    });
}
