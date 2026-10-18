/**
 * Forwarded LNURL routes for the self-hosted LNURL server.
 *
 * Mounted at `/` only when `LNURL_SERVER_URL` and `PUBLIC_BASE_URL` resolve.
 * Every gate is a store lookup (the wallet carries no session of this api).
 * Rate-limited per client IP; never logs a query string, body, signature header,
 * comment, or zap request. A BOLT11 minted for a shop at the amount of its
 * open point-of-sale charge is recorded against that charge.
 */

import { Hono } from 'hono';
import type { Account, AuthStore } from '@/lib/auth/store';
import { readCappedText } from '@/lib/capped-body';
import { decodeBolt11 } from '@/lib/bolt11';
import type { LnurlServerConfig } from '@/lib/config';
import { IpRateLimiter } from '@/lib/ip-rate-limit';
import { errorLogFields, logEvent } from '@/lib/log';
import type { FetchFn } from '@/lib/lnurlp';
import {
  LNURL_BODY_LIMIT_BYTES,
  LNURL_SERVER_TIMEOUT_MS,
  callLnurlServer,
  type LnurlServerResult,
} from '@/lib/lnurl-server';
import { WAIT_SATS_TIMEOUT_MS } from '@/lib/message';
import type { PosCharge } from '@/lib/pos-charge';
import type { PosStore } from '@/lib/pos-store';
import { readClientRequestMeta } from '@/lib/request-meta';
import { shopError, shopResponse, type ShopPayments } from '@/lib/shop-payment';
import { handleShopProof } from '@/lib/shop-proof';
import { normalizeSparkPubkey } from '@/lib/spark-pubkey';
import { normalizeUsername } from '@/lib/username';
import { normalizeUuid } from '@/lib/uuid';

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
  /** Point-of-sale charges; a minted BOLT11 at the open charge amount is recorded. */
  posStore: PosStore;
  /** Shop payments in USDT and USDC (callback, proof, and wait routes); omitted → not mounted. */
  shopPayments?: ShopPayments;
  /** Hold limit of `GET /lnurlp/wait/:payment` (default {@link WAIT_SATS_TIMEOUT_MS}). */
  waitTimeoutMs?: number;
}

/** Stable 404 body when a gate fails or the upstream returns 404. */
const NOT_FOUND = { error: 'Not found' } as const;
/** Stable 503 body when the upstream is unreachable or returns an unexpected status. */
const UNAVAILABLE = { error: 'Lightning address service is unavailable' } as const;
/** Stable 429 body when a client exceeds the per-route limit. */
const TOO_MANY = { error: 'Too many requests' } as const;
/** Stable 413 body when the request body exceeds {@link LNURL_BODY_LIMIT_BYTES}. */
const TOO_LARGE = { error: 'Request body is too large' } as const;
/** Stable 409 body when upstream accepted registration but the account is not verified on the key. */
const UNCONFIRMED = { error: 'Wallet registration could not be confirmed' } as const;

/** Route name for diagnostic logs (never a path or query). */
type LnurlServerRouteName = 'register' | 'recover' | 'metadata' | 'invoice' | 'verify';

/** Shop route name for diagnostic logs (never a path or query). */
type ShopRouteName = 'callback' | 'proof' | 'wait';

/**
 * Log a store or service failure on a shop route and answer it with the
 * shared error body, so CORS and `no-store` still apply.
 *
 * @param route - Shop route name.
 * @param error - What was thrown.
 * @param text - Error text of the 503.
 * @returns The 503 response.
 */
function shopRouteFailed(route: ShopRouteName, error: unknown, text: string): Response {
  logEvent('lnurl_server.failed', { route, ...errorLogFields(error) });
  return shopError(503, text);
}

/**
 * Raw query substring of a request URL (`?…` inclusive), or `''`.
 *
 * @param url - Full request URL as seen by Hono.
 */
function rawSearch(url: string): string {
  const q = url.indexOf('?');
  return q === -1 ? '' : url.slice(q);
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
    if (result.reason === 'segment') {
      return Response.json(NOT_FOUND, { status: 404 });
    }
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
 * The account's open point-of-sale charge before an invoice is minted, or
 * `null`. A store failure logs `pos.invoice.record_failed` and resolves
 * `null`, so the invoice is still forwarded.
 *
 * @param deps - Route collaborators.
 * @param accountId - Shop account id.
 * @param issuedAtMs - Issue time (epoch ms).
 */
async function pendingCharge(
  deps: LnurlServerRouteDeps,
  accountId: string,
  issuedAtMs: number,
): Promise<PosCharge | null> {
  try {
    return await deps.posStore.currentPending(accountId, issuedAtMs);
  } catch {
    logEvent('pos.invoice.record_failed', { accountId });
    return null;
  }
}

/**
 * Record the BOLT11 in a successful upstream invoice body against the charge
 * that was open before the mint, when its amount is the charge amount.
 *
 * Best effort: an unparsable body, a BOLT11 that does not decode, or another
 * amount records nothing; a store failure logs `pos.invoice.record_failed`.
 * Never changes the response.
 *
 * @param deps - Route collaborators.
 * @param pending - The charge open before the mint.
 * @param issuedAtMs - When that charge was found open (epoch ms).
 * @param body - Upstream response body.
 */
async function recordPosInvoice(
  deps: LnurlServerRouteDeps,
  pending: PosCharge,
  issuedAtMs: number,
  body: string,
): Promise<void> {
  let pr: unknown;
  try {
    pr = (JSON.parse(body) as { pr?: unknown } | null)?.pr;
  } catch {
    return;
  }
  const decoded = typeof pr === 'string' ? decodeBolt11(pr) : null;
  if (decoded === null || decoded.amountMsat !== pending.amountSats * 1000) {
    return;
  }
  try {
    await deps.posStore.recordInvoice(pending.id, decoded.paymentHash, issuedAtMs);
  } catch {
    logEvent('pos.invoice.record_failed', { accountId: pending.accountId });
  }
}

/**
 * Whether any of `keys` appears more than once in the request query.
 *
 * @param queries - All values per key (`c.req.queries()`).
 * @param keys - Keys to check.
 * @returns `true` when a key is repeated.
 */
function repeatedKey(queries: Record<string, string[]>, keys: readonly string[]): boolean {
  return keys.some((key) => (queries[key] ?? []).length > 1);
}

/**
 * The shop account of a username: a verified wallet and a username that is
 * not `invoice` (the invoice forward keeps that path segment).
 *
 * @param deps - Route collaborators.
 * @param raw - Path parameter.
 * @returns The account and its username, or `null`.
 */
async function shopAccount(
  deps: LnurlServerRouteDeps,
  raw: string,
): Promise<{ account: Account; username: string } | null> {
  const username = normalizeUsername(raw);
  if (username === null || username === 'invoice') {
    return null;
  }
  const account = await deps.auth.getAccountByUsername(username);
  if (account === undefined || typeof account.sparkPubkeyVerifiedAt !== 'number') {
    return null;
  }
  return { account, username };
}

/**
 * Build the forwarded LNURL route group, plus the shop payment callback,
 * proof, and wait routes when {@link LnurlServerRouteDeps.shopPayments} is set.
 *
 * @param deps - Auth store, LNURL config, fetch, clock, POS store, and the
 *   optional shop payment service.
 * @returns A Hono app with the five forwarded routes and the shop routes.
 */
export function lnurlServerRoutes(deps: LnurlServerRouteDeps): Hono {
  const registerLimiter = new IpRateLimiter(30);
  const recoverLimiter = new IpRateLimiter(30);
  const metadataLimiter = new IpRateLimiter(120);
  const invoiceLimiter = new IpRateLimiter(20);
  const verifyLimiter = new IpRateLimiter(120);
  const callbackLimiter = new IpRateLimiter(120);
  const proofLimiter = new IpRateLimiter(120);
  const waitLimiter = new IpRateLimiter(120);

  const app = new Hono()
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
        const text = await readCappedText(c.req.raw, LNURL_BODY_LIMIT_BYTES);
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
        const parsedObject = parsed as Record<string, unknown>;
        for (const key of Object.keys(parsedObject)) {
          if (key !== 'username' && key.normalize('NFKC').toLowerCase() === 'username') {
            return c.json(NOT_FOUND, 404);
          }
        }
        const usernameRaw = parsedObject['username'];
        if (typeof usernameRaw !== 'string') {
          return c.json(NOT_FOUND, 404);
        }
        if (!/^[\x20-\x7e]*$/.test(usernameRaw)) {
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
          body: JSON.stringify(parsedObject),
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
            logEvent('account.wallet.verified', { accountId: account.id });
          } else {
            const current = await deps.auth.getAccount(account.id);
            if (
              current === undefined ||
              current.sparkPubkey !== pubkey ||
              typeof current.sparkPubkeyVerifiedAt !== 'number'
            ) {
              logEvent('account.wallet.unconfirmed', { accountId: account.id });
              return c.json(UNCONFIRMED, 409);
            }
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
        const text = await readCappedText(c.req.raw, LNURL_BODY_LIMIT_BYTES);
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
      if (c.req.method !== 'GET') {
        return c.notFound();
      }
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
      if (c.req.method !== 'GET') {
        return c.notFound();
      }
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
        const issuedAtMs = deps.now();
        const pending = await pendingCharge(deps, account.id, issuedAtMs);
        const result = await callLnurlServer(deps.config, deps.fetchImpl, {
          method: 'GET',
          segments: ['lnurlp', username, 'invoice'],
          search: rawSearch(c.req.url),
          headers: c.req.raw.headers,
          timeoutMs: LNURL_SERVER_TIMEOUT_MS,
        });
        if (pending !== null && result.ok && result.status >= 200 && result.status < 300) {
          await recordPosInvoice(deps, pending, issuedAtMs, result.body);
        }
        return mapUpstream(result, route);
      } catch {
        logEvent('lnurl_server.failed', { route });
        return c.json(UNAVAILABLE, 503);
      }
    })
    .get('/verify/:paymentHash', async (c) => {
      if (c.req.method !== 'GET') {
        return c.notFound();
      }
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
  const shop = deps.shopPayments;
  if (shop === undefined) {
    return app;
  }
  // Registered after `/lnurlp/:username/invoice`, which keeps the literal
  // segment `invoice` (`/lnurlp/cb/invoice` stays the forward of user `cb`).
  return app
    .get('/lnurlp/cb/:username', async (c) => {
      if (c.req.method !== 'GET') {
        return c.notFound();
      }
      try {
        const clientIp = readClientRequestMeta(c.req.raw.headers).clientIp;
        if (!callbackLimiter.allow(clientIp, deps.now())) {
          return shopError(503, 'Too many requests');
        }
        const found = await shopAccount(deps, c.req.param('username'));
        if (found === null) {
          return shopError(404, 'Not found');
        }
        return await shop.callback(found.account, found.username, {
          amount: c.req.query('amount') ?? null,
          quote: c.req.query('quote') ?? null,
          method: c.req.query('method') ?? null,
          asset: c.req.query('asset') ?? null,
          repeated: repeatedKey(c.req.queries(), ['quote', 'method', 'asset', 'amount']),
        });
      } catch (error) {
        return shopRouteFailed('callback', error, UNAVAILABLE.error);
      }
    })
    .get('/lnurlp/tx/:username', async (c) => {
      if (c.req.method !== 'GET') {
        return c.notFound();
      }
      try {
        const clientIp = readClientRequestMeta(c.req.raw.headers).clientIp;
        const overLimit = !proofLimiter.allow(clientIp, deps.now());
        const found = await shopAccount(deps, c.req.param('username'));
        if (found === null) {
          return overLimit ? shopError(503, 'Too many requests') : shopError(404, 'Not found');
        }
        return await handleShopProof(
          shop,
          found.account,
          found.username,
          {
            quote: c.req.query('quote') ?? null,
            method: c.req.query('method') ?? null,
            asset: c.req.query('asset') ?? null,
            tx: c.req.query('tx') ?? null,
            hex: c.req.query('hex') ?? null,
            repeated: repeatedKey(c.req.queries(), ['quote', 'method', 'asset', 'tx', 'hex']),
          },
          overLimit,
        );
      } catch (error) {
        // A 5xx, so the wallet repeats the proof, as it does after any 5xx.
        return shopRouteFailed('proof', error, 'Payment is being confirmed');
      }
    })
    .get('/lnurlp/wait/:payment', async (c) => {
      if (c.req.method !== 'GET') {
        return c.notFound();
      }
      try {
        const clientIp = readClientRequestMeta(c.req.raw.headers).clientIp;
        if (!waitLimiter.allow(clientIp, deps.now())) {
          return shopError(429, 'Too many requests');
        }
        const paymentId = normalizeUuid(c.req.param('payment'));
        const body =
          paymentId === null
            ? null
            : await shop.wait(
                paymentId,
                c.req.query('since') ?? null,
                deps.waitTimeoutMs ?? WAIT_SATS_TIMEOUT_MS,
              );
        return body === null ? shopError(404, 'Not found') : shopResponse(body, 200);
      } catch (error) {
        return shopRouteFailed('wait', error, UNAVAILABLE.error);
      }
    });
}
