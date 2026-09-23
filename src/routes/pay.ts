/**
 * `GET /pay/:username` — public pay-link card (display name and satoshi bounds).
 * `POST /pay/:username/invoice` — one BOLT11 invoice via `requestGiftInvoice`.
 *
 * Settlement stays on the member's linked Lightning Address, never
 * `username@21.gifts`. No spend token.
 */

import { Hono } from 'hono';
import { z } from 'zod';
import type { AuthStore } from '@/lib/auth/store';
import { decodeBolt11 } from '@/lib/bolt11';
import { requestGiftInvoice } from '@/lib/gift-invoice';
import { normalizeLightningAddress } from '@/lib/lightning-address';
import type { FetchFn } from '@/lib/lnurlp';
import { resolveLnurlp } from '@/lib/lnurlp';
import { logEvent } from '@/lib/log';
import { normalizeUsername } from '@/lib/username';

type PayLookup =
  | {
      ok: true;
      username: string;
      name: string;
      address: string;
      minSats: number;
      maxSats: number;
      metadata: { minSendable: number; maxSendable: number };
    }
  | { ok: false; status: 404 | 502; error: string };

/**
 * Load the member and the linked Lightning Address LNURL-pay satoshi bounds.
 *
 * @param rawUsername - Path parameter before normalisation.
 * @param deps - Auth store and LNURL-pay fetch.
 * @returns Display fields and bounds, or an HTTP error payload.
 */
async function lookupPayAccount(
  rawUsername: string,
  deps: { auth: AuthStore; fetchImpl: FetchFn },
): Promise<PayLookup> {
  const username = normalizeUsername(rawUsername);
  if (username === null) {
    logEvent('pay.unknown');
    return { ok: false, status: 404, error: 'Not found' };
  }
  try {
    const account = await deps.auth.getAccountByUsername(username);
    const linked = account?.lightningAddress?.trim() ?? '';
    if (account === undefined || linked === '') {
      logEvent('pay.unknown', { username });
      return { ok: false, status: 404, error: 'Not found' };
    }
    const address = normalizeLightningAddress(linked);
    if (address === null) {
      logEvent('pay.unreachable', { username });
      return { ok: false, status: 502, error: 'Lightning Address could not be resolved' };
    }
    const resolved = await resolveLnurlp({ address, fetchImpl: deps.fetchImpl });
    if (!resolved.ok) {
      logEvent('pay.unreachable', { username });
      return { ok: false, status: 502, error: 'Lightning Address could not be resolved' };
    }
    const metadata = resolved.metadata;
    if (
      !Number.isSafeInteger(metadata.minSendable) ||
      !Number.isSafeInteger(metadata.maxSendable)
    ) {
      logEvent('pay.unreachable', { username });
      return { ok: false, status: 502, error: 'Lightning Address could not be resolved' };
    }
    const minSats = Math.max(1, Math.ceil(metadata.minSendable / 1000));
    const maxSats = Math.floor(metadata.maxSendable / 1000);
    if (maxSats < minSats) {
      logEvent('pay.unreachable', { username });
      return { ok: false, status: 502, error: 'Lightning Address could not be resolved' };
    }
    const trimmedName = account.name?.trim() ?? '';
    const name = trimmedName === '' ? username : trimmedName;
    return { ok: true, username, name, address, minSats, maxSats, metadata };
  } catch {
    logEvent('pay.failed', { username });
    return { ok: false, status: 502, error: 'Lightning Address could not be resolved' };
  }
}

/**
 * Build the `/pay` route group.
 *
 * @param deps - Auth store and fetch.
 * @returns Hono app with `GET /:username` and `POST /:username/invoice`.
 */
export function payRoutes(deps: { auth: AuthStore; fetchImpl: FetchFn }): Hono {
  return new Hono()
    .get('/:username', async (c) => {
      const lookup = await lookupPayAccount(c.req.param('username'), deps);
      if (!lookup.ok) {
        return c.json({ error: lookup.error }, lookup.status);
      }
      return c.json({
        name: lookup.name,
        username: lookup.username,
        minSats: lookup.minSats,
        maxSats: lookup.maxSats,
      });
    })
    .post('/:username/invoice', async (c) => {
      const lookup = await lookupPayAccount(c.req.param('username'), deps);
      if (!lookup.ok) {
        return c.json({ error: lookup.error }, lookup.status);
      }
      let body: unknown;
      try {
        body = await c.req.json();
      } catch {
        return c.json({ error: 'Enter a whole number of sats' }, 400);
      }
      const parsed = z.object({ amountSats: z.number().int() }).safeParse(body);
      if (!parsed.success) {
        return c.json({ error: 'Enter a whole number of sats' }, 400);
      }
      const amountSats = parsed.data.amountSats;
      const amountMsat = amountSats * 1000;
      const { minSats, maxSats, metadata, address, username } = lookup;
      const outsideSat = amountSats < minSats || amountSats > maxSats;
      const belowMsat = amountMsat < metadata.minSendable;
      const aboveMsat = amountMsat > metadata.maxSendable;
      if (((outsideSat ? 1 : 0) | (belowMsat ? 1 : 0) | (aboveMsat ? 1 : 0)) !== 0) {
        return c.json({ error: 'Enter a whole number of sats' }, 400);
      }
      const invoice = await requestGiftInvoice({
        address,
        amountMsat,
        fetchImpl: deps.fetchImpl,
      });
      if (!invoice.ok) {
        logEvent('pay.invoice_failed', { username });
        return c.json({ error: 'Lightning Address could not be resolved' }, 502);
      }
      const decoded = decodeBolt11(invoice.pr);
      if (decoded === null || decoded.amountMsat !== amountMsat) {
        logEvent('pay.invoice_failed', { username });
        return c.json({ error: 'Lightning Address could not be resolved' }, 502);
      }
      logEvent('pay.invoice', { username, amountSats });
      return c.json({ pr: invoice.pr, amountSats });
    });
}
