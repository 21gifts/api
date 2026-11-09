/**
 * `POST /lnurl/pay-request` and `POST /lnurl/invoice` — fetch the pay
 * request and a BOLT11 invoice of a Lightning Address or LNURL on another
 * host for a signed-in member, so the app can pay it with its own wallet.
 *
 * The client never sends a callback URL: the invoice route resolves the
 * target again. A pay request logs its domain, an invoice its amount, and a
 * failure its reason and status; the target, comment, and invoice are never
 * logged.
 */

import { Hono, type Context } from 'hono';
import { resolveSession } from '@/lib/auth/service';
import type { Account, AuthStore } from '@/lib/auth/store';
import type { FetchFn } from '@/lib/lnurlp';
import {
  AMOUNT_ERROR,
  COMMENT_ERROR,
  LnurlRelayRateLimiter,
  NOT_PAYABLE_ERROR,
  requestRelayInvoice,
  resolveRelayPayRequest,
  type RelayFailure,
  type RelayLookup,
} from '@/lib/lnurl-relay';
import { logEvent } from '@/lib/log';
import { bearerToken } from '@/routes/me';

/** Collaborators the `/lnurl` routes need. */
export interface LnurlRouteDeps {
  /** Shared auth persistence port. */
  auth: AuthStore;
  /** Injected fetch for the outside LNURL server. */
  fetchImpl: FetchFn;
  /** Clock returning epoch milliseconds. */
  now: () => number;
  /** Process env (`PUBLIC_BASE_URL`). */
  env: Record<string, string | undefined>;
  /** Host name resolver (tests supply a fake); omitted → system resolver. */
  lookupImpl?: RelayLookup;
}

/**
 * Host of `PUBLIC_BASE_URL`, lowercase, or `null` when unset or not a URL.
 *
 * @param env - Process env.
 * @returns The own host, or `null`.
 */
function ownHost(env: Record<string, string | undefined>): string | null {
  const base = env['PUBLIC_BASE_URL']?.trim() ?? '';
  try {
    // A trailing dot names the same host; compare without it.
    return new URL(base).hostname.toLowerCase().replace(/\.$/, '');
  } catch {
    return null;
  }
}

/**
 * Read the JSON body as an object, or `null`.
 *
 * @param c - Request.
 * @returns The object body, or `null` when missing or not an object.
 */
async function jsonObject(c: Context): Promise<Record<string, unknown> | null> {
  try {
    const body: unknown = await c.req.json();
    return body !== null && typeof body === 'object' && !Array.isArray(body)
      ? (body as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/**
 * A 400 failure for a request body that fails validation before any lookup.
 *
 * @param error - Response body text.
 * @param reason - Short reason for the log.
 * @returns The failure to answer and log.
 */
function invalid(error: string, reason: string): RelayFailure {
  return { ok: false, status: 400, error, reason };
}

/**
 * Build the `/lnurl` route group.
 *
 * Both routes need a member Bearer session (401 otherwise) and share one
 * per-member limit (429 with `Retry-After: 60`).
 *
 * @param deps - Auth store, fetch, clock, env, and optional resolver.
 * @returns Hono app with `POST /pay-request` and `POST /invoice`.
 */
export function lnurlRoutes(deps: LnurlRouteDeps): Hono {
  const limiter = new LnurlRelayRateLimiter();
  const host = ownHost(deps.env);

  const gate = async (c: Context): Promise<Account | Response> => {
    const token = bearerToken(c.req.header('authorization'));
    const nowMs = deps.now();
    const account = token === null ? null : await resolveSession(deps.auth, nowMs, token);
    if (account === null) {
      return c.json({ error: 'Unauthorized' }, 401);
    }
    if (!limiter.allow(account.id, nowMs)) {
      c.header('Retry-After', '60');
      return c.json({ error: 'Too many requests' }, 429);
    }
    return account;
  };

  const failed = (c: Context, event: string, result: RelayFailure): Response => {
    logEvent(event, { reason: result.reason, status: result.status });
    return c.json({ error: result.error }, result.status);
  };

  return new Hono()
    .post('/pay-request', async (c) => {
      const caller = await gate(c);
      if (caller instanceof Response) {
        return caller;
      }
      const body = await jsonObject(c);
      const target = body?.['target'];
      if (typeof target !== 'string') {
        return failed(c, 'lnurl.pay_request.failed', invalid(NOT_PAYABLE_ERROR, 'target'));
      }
      const result = await resolveRelayPayRequest({
        target,
        fetchImpl: deps.fetchImpl,
        lookupImpl: deps.lookupImpl,
        ownHost: host,
      });
      if (!result.ok) {
        return failed(c, 'lnurl.pay_request.failed', result);
      }
      logEvent('lnurl.pay_request.ok', { domain: result.payRequest.domain });
      return c.json(result.payRequest);
    })
    .post('/invoice', async (c) => {
      const caller = await gate(c);
      if (caller instanceof Response) {
        return caller;
      }
      const body = await jsonObject(c);
      const target = body?.['target'];
      const amountMsat = body?.['amountMsat'];
      const comment = body?.['comment'];
      if (typeof target !== 'string') {
        return failed(c, 'lnurl.invoice.failed', invalid(NOT_PAYABLE_ERROR, 'target'));
      }
      if (typeof amountMsat !== 'number') {
        return failed(c, 'lnurl.invoice.failed', invalid(AMOUNT_ERROR, 'amount'));
      }
      if (comment !== undefined && comment !== null && typeof comment !== 'string') {
        return failed(c, 'lnurl.invoice.failed', invalid(COMMENT_ERROR, 'comment'));
      }
      const result = await requestRelayInvoice({
        target,
        amountMsat,
        ...(typeof comment === 'string' ? { comment } : {}),
        fetchImpl: deps.fetchImpl,
        lookupImpl: deps.lookupImpl,
        ownHost: host,
      });
      if (!result.ok) {
        return failed(c, 'lnurl.invoice.failed', result);
      }
      logEvent('lnurl.invoice.ok', { amountMsat });
      return c.json({ pr: result.pr });
    });
}
