/**
 * Forwarded LNURL routes for the self-hosted LNURL server.
 *
 * Mounted at `/` only when `LNURL_SERVER_URL` resolves. Every gate is a store
 * lookup (the wallet carries no session of this api). Rate-limited per client
 * IP; never logs a query string, body, signature header, comment, or zap request.
 */

import { Hono } from 'hono';
import type { AuthStore } from '@/lib/auth/store';
import type { LnurlServerConfig } from '@/lib/config';
import { IpRateLimiter } from '@/lib/ip-rate-limit';
import { logEvent } from '@/lib/log';
import type { FetchFn } from '@/lib/lnurlp';
import {
  LNURL_BODY_LIMIT_BYTES,
  LNURL_SERVER_TIMEOUT_MS,
  callLnurlServer,
  type LnurlServerResult,
} from '@/lib/lnurl-server';
import { readClientRequestMeta } from '@/lib/request-meta';
import { normalizeSparkPubkey } from '@/lib/spark-pubkey';
import { normalizeUsername } from '@/lib/username';

/** Collaborators for the forwarded LNURL routes. */
export interface LnurlServerRouteDeps {
  /** Auth store (usernames and wallet keys). */
  auth: AuthStore;
  /** Resolved LNURL server configuration. */
  config: LnurlServerConfig;
  /** Injected `fetch` for the LNURL server. */
  fetchImpl: FetchFn;
  /** Clock in epoch milliseconds. */
  now: () => number;
}

/** Stable 404 body when a gate fails or the upstream returns 404. */
const NOT_FOUND = { error: 'Not found' } as const;
/** Stable 503 body when the upstream is unreachable or returns an unexpected status. */
const UNAVAILABLE = { error: 'Lightning address service is unavailable' } as const;
/** Stable 429 body when a client exceeds the per-route limit. */
const TOO_MANY = { error: 'Too many requests' } as const;
/** Stable 413 body when the request body exceeds {@link LNURL_BODY_LIMIT_BYTES}. */
const TOO_LARGE = { error: 'Request body is too large' } as const;

/** Route name for diagnostic logs (never a path or query). */
type LnurlServerRouteName = 'register' | 'recover' | 'metadata' | 'invoice' | 'verify';

/**
 * Raw query substring of a request URL (`?…` inclusive), or `''`.
 *
 * @param url - Full request URL as seen by Hono.
 */
function rawSearch(url: string): string {
  const q = url.indexOf('?');
  return q === -1 ? '' : url.slice(q);
}

/** Read the request body as text, or `null` when it exceeds {@link LNURL_BODY_LIMIT_BYTES}. */
async function cappedText(request: Request): Promise<string | null> {
  const declared = Number(request.headers.get('content-length') ?? '0');
  if (declared > LNURL_BODY_LIMIT_BYTES) {
    return null;
  }
  if (request.body === null) {
    return '';
  }
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    total += value.byteLength;
    if (total > LNURL_BODY_LIMIT_BYTES) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

/**
 * Respond with an upstream success body, forwarding only allow-listed headers.
 *
 * @param result - Successful {@link callLnurlServer} outcome.
 */
function passthrough(result: Extract<LnurlServerResult, { ok: true }>): Response {
  return new Response(result.body === '' ? null : result.body, {
    status: result.status,
    headers: result.headers,
  });
}

/**
 * Map a {@link callLnurlServer} outcome to an HTTP response.
 *
 * @param result - Upstream call result.
 * @param route - Log field for unreachable / unexpected failures.
 * @param options - Registration passes every upstream 4xx through unchanged.
 */
function mapUpstream(
  result: LnurlServerResult,
  route: LnurlServerRouteName,
  options: { registration?: boolean } = {},
): Response {
  if (!result.ok) {
    logEvent('lnurl_server.unreachable', { route });
    return Response.json(UNAVAILABLE, { status: 503 });
  }
  if (result.status >= 200 && result.status < 300) {
    return passthrough(result);
  }
  if (options.registration === true && result.status >= 400 && result.status < 500) {
    return passthrough(result);
  }
  if (result.status === 404) {
    return Response.json(NOT_FOUND, { status: 404 });
  }
  logEvent('lnurl_server.unreachable', { route });
  return Response.json(UNAVAILABLE, { status: 503 });
}

/**
 * Build the forwarded LNURL route group.
 *
 * @param deps - Auth store, LNURL config, fetch, and clock.
 * @returns A Hono app with the five forwarded routes.
 */
export function lnurlServerRoutes(deps: LnurlServerRouteDeps): Hono {
  const registerLimiter = new IpRateLimiter(30);
  const recoverLimiter = new IpRateLimiter(30);
  const metadataLimiter = new IpRateLimiter(120);
  const invoiceLimiter = new IpRateLimiter(20);
  const verifyLimiter = new IpRateLimiter(120);

  return new Hono()
    .post('/lnurlpay/:pubkey', async (c) => {
      const route: LnurlServerRouteName = 'register';
      try {
        const clientIp = readClientRequestMeta(c.req.raw.headers).clientIp;
        if (!registerLimiter.allow(clientIp, deps.now())) {
          return c.json(TOO_MANY, 429);
        }
        const pubkey = normalizeSparkPubkey(c.req.param('pubkey'));
        if (pubkey === null) {
          return c.json(NOT_FOUND, 404);
        }
        const text = await cappedText(c.req.raw);
        if (text === null) {
          return c.json(TOO_LARGE, 413);
        }
        let parsed: unknown;
        try {
          parsed = JSON.parse(text);
        } catch {
          return c.json(NOT_FOUND, 404);
        }
        if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
          return c.json(NOT_FOUND, 404);
        }
        const usernameRaw = (parsed as { username?: unknown }).username;
        if (typeof usernameRaw !== 'string') {
          return c.json(NOT_FOUND, 404);
        }
        const name = normalizeUsername(usernameRaw);
        if (name === null) {
          return c.json(NOT_FOUND, 404);
        }
        const account = await deps.auth.getAccountByUsername(name);
        if (account === undefined || account.sparkPubkey !== pubkey) {
          return c.json(NOT_FOUND, 404);
        }
        const verifiedOwner = await deps.auth.getAccountByVerifiedSparkPubkey(pubkey);
        if (verifiedOwner !== undefined && verifiedOwner.id !== account.id) {
          return c.json(NOT_FOUND, 404);
        }
        const result = await callLnurlServer(deps.config, deps.fetchImpl, {
          method: 'POST',
          segments: ['lnurlpay', pubkey],
          headers: c.req.raw.headers,
          body: text,
          timeoutMs: LNURL_SERVER_TIMEOUT_MS,
        });
        if (result.ok && result.status >= 200 && result.status < 300) {
          const marked = await deps.auth.markSparkPubkeyVerified(
            account.id,
            pubkey,
            name,
            deps.now(),
          );
          if (marked) {
            logEvent('wallet.address.verified', { accountId: account.id });
          }
        }
        return mapUpstream(result, route, { registration: true });
      } catch {
        logEvent('lnurl_server.failed', { route });
        return c.json(UNAVAILABLE, 503);
      }
    })
    .post('/lnurlpay/:pubkey/recover', async (c) => {
      const route: LnurlServerRouteName = 'recover';
      try {
        const clientIp = readClientRequestMeta(c.req.raw.headers).clientIp;
        if (!recoverLimiter.allow(clientIp, deps.now())) {
          return c.json(TOO_MANY, 429);
        }
        const pubkey = normalizeSparkPubkey(c.req.param('pubkey'));
        if (pubkey === null) {
          return c.json(NOT_FOUND, 404);
        }
        const claimed = await deps.auth.isSparkPubkeyClaimed(pubkey);
        if (!claimed) {
          return c.json(NOT_FOUND, 404);
        }
        const text = await cappedText(c.req.raw);
        if (text === null) {
          return c.json(TOO_LARGE, 413);
        }
        const result = await callLnurlServer(deps.config, deps.fetchImpl, {
          method: 'POST',
          segments: ['lnurlpay', pubkey, 'recover'],
          headers: c.req.raw.headers,
          body: text,
          timeoutMs: LNURL_SERVER_TIMEOUT_MS,
        });
        return mapUpstream(result, route);
      } catch {
        logEvent('lnurl_server.failed', { route });
        return c.json(UNAVAILABLE, 503);
      }
    })
    .get('/lnurlpay/:pubkey/metadata', async (c) => {
      const route: LnurlServerRouteName = 'metadata';
      try {
        const clientIp = readClientRequestMeta(c.req.raw.headers).clientIp;
        if (!metadataLimiter.allow(clientIp, deps.now())) {
          return c.json(TOO_MANY, 429);
        }
        const pubkey = normalizeSparkPubkey(c.req.param('pubkey'));
        if (pubkey === null) {
          return c.json(NOT_FOUND, 404);
        }
        const account = await deps.auth.getAccountByVerifiedSparkPubkey(pubkey);
        if (account === undefined) {
          return c.json(NOT_FOUND, 404);
        }
        const result = await callLnurlServer(deps.config, deps.fetchImpl, {
          method: 'GET',
          segments: ['lnurlpay', pubkey, 'metadata'],
          search: rawSearch(c.req.url),
          headers: c.req.raw.headers,
          timeoutMs: LNURL_SERVER_TIMEOUT_MS,
        });
        return mapUpstream(result, route);
      } catch {
        logEvent('lnurl_server.failed', { route });
        return c.json(UNAVAILABLE, 503);
      }
    })
    .get('/lnurlp/:username/invoice', async (c) => {
      const route: LnurlServerRouteName = 'invoice';
      try {
        const clientIp = readClientRequestMeta(c.req.raw.headers).clientIp;
        if (!invoiceLimiter.allow(clientIp, deps.now())) {
          return c.json(TOO_MANY, 429);
        }
        const username = normalizeUsername(c.req.param('username'));
        if (username === null) {
          return c.json(NOT_FOUND, 404);
        }
        const account = await deps.auth.getAccountByUsername(username);
        if (account === undefined || typeof account.sparkPubkeyVerifiedAt !== 'number') {
          return c.json(NOT_FOUND, 404);
        }
        const result = await callLnurlServer(deps.config, deps.fetchImpl, {
          method: 'GET',
          segments: ['lnurlp', username, 'invoice'],
          search: rawSearch(c.req.url),
          headers: c.req.raw.headers,
          timeoutMs: LNURL_SERVER_TIMEOUT_MS,
        });
        return mapUpstream(result, route);
      } catch {
        logEvent('lnurl_server.failed', { route });
        return c.json(UNAVAILABLE, 503);
      }
    })
    .get('/verify/:paymentHash', async (c) => {
      const route: LnurlServerRouteName = 'verify';
      try {
        const clientIp = readClientRequestMeta(c.req.raw.headers).clientIp;
        if (!verifyLimiter.allow(clientIp, deps.now())) {
          return c.json(TOO_MANY, 429);
        }
        const paymentHash = c.req.param('paymentHash');
        const result = await callLnurlServer(deps.config, deps.fetchImpl, {
          method: 'GET',
          segments: ['verify', paymentHash],
          headers: c.req.raw.headers,
          timeoutMs: LNURL_SERVER_TIMEOUT_MS,
        });
        return mapUpstream(result, route);
      } catch {
        logEvent('lnurl_server.failed', { route });
        return c.json(UNAVAILABLE, 503);
      }
    });
}
