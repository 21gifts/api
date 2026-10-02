/**
 * `POST /lnurl/pay-request` and `POST /lnurl/invoice` — fetch the pay
 * request and a BOLT11 invoice of a Lightning Address or LNURL on another
 * host for a signed-in member, so the app can pay it with its own wallet.
 *
 * The client never sends a callback URL: the invoice route resolves the
 * target again. Logs carry the target domain and a short reason only.
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
} from '@/lib/lnurl-relay';
import { logEvent } from '@/lib/log';
import { bearerToken } from '@/routes/me';

/** Collaborators the `/lnurl` routes need. */
interface LnurlRouteDeps {
  /** Shared auth persistence port. */
  auth: AuthStore;
  /** Injected fetch for the outside LNURL server. */
  fetchImpl: FetchFn;
  /** Clock returning epoch milliseconds. */
  now: () => number;
  /** Process env (`PUBLIC_BASE_URL`). */
  env: Record<string, string | undefined>;
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
    return new URL(base).hostname.toLowerCase();
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
 * Build the `/lnurl` route group.
 *
 * Both routes need a member Bearer session (401 otherwise) and share one
 * per-member limit (429 with `Retry-After: 60`).
 *
 * @param deps - Auth store, fetch, clock, and env.
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
        return c.json({ error: NOT_PAYABLE_ERROR }, 400);
      }
      const result = await resolveRelayPayRequest({
        target,
        fetchImpl: deps.fetchImpl,
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
        return c.json({ error: NOT_PAYABLE_ERROR }, 400);
      }
      if (typeof amountMsat !== 'number') {
        return c.json({ error: AMOUNT_ERROR }, 400);
      }
      if (comment !== undefined && comment !== null && typeof comment !== 'string') {
        return c.json({ error: COMMENT_ERROR }, 400);
      }
      const result = await requestRelayInvoice({
        target,
        amountMsat,
        ...(typeof comment === 'string' ? { comment } : {}),
        fetchImpl: deps.fetchImpl,
        ownHost: host,
      });
      if (!result.ok) {
        return failed(c, 'lnurl.invoice.failed', result);
      }
      logEvent('lnurl.invoice.ok', { amountMsat });
      return c.json({ pr: result.pr });
    });
}
