/**
 * `GET /pay/:username` — public pay-link card (display name, satoshi bounds,
 * and an open till when one is pending).
 * `POST /pay/:username/invoice` — one BOLT11 invoice via `requestGiftInvoice`,
 * plus a fee-free Spark invoice for an open till when free in-app payments are on.
 *
 * Settlement goes to the member's receiving address (`receivingAddress`):
 * their verified wallet, resolved internally against the LNURL server. A
 * member without one is not found. No spend token. An unexpired pending point-of-sale
 * charge pins both returned sat bounds to that amount; provider metadata
 * used for the millisatoshi check is not mutated. Every BOLT11 minted while
 * that charge is open is recorded against it, so the paid watcher can see it
 * settle.
 */

import { Hono } from 'hono';
import { z } from 'zod';
import type { AuthStore } from '@/lib/auth/store';
import type { LnurlServerConfig } from '@/lib/config';
import { decodeBolt11 } from '@/lib/bolt11';
import { requestGiftInvoice } from '@/lib/gift-invoice';
import type { FetchFn } from '@/lib/lnurlp';
import { resolveLnurlp } from '@/lib/lnurlp';
import { logEvent } from '@/lib/log';
import type { PosCharge } from '@/lib/pos-charge';
import type { PosStore } from '@/lib/pos-store';
import { lnurlServerFetch, receivingAddress } from '@/lib/receiving-address';
import { encodeSparkInvoice, uuidV7 } from '@/lib/spark-invoice';
import { normalizeUsername } from '@/lib/username';

/** Collaborators the `/pay` routes need. */
interface PayRouteDeps {
  auth: AuthStore;
  fetchImpl: FetchFn;
  posStore: PosStore;
  now: () => number;
  /** LNURL server; omitted when off. */
  lnurlServer?: LnurlServerConfig;
  /** `true` when free in-app payments are on (Spark invoices for an open till). */
  freePayments?: boolean;
  /** Random bytes for the Spark invoice id; default `crypto.getRandomValues`. */
  randomBytes?: (length: number) => Uint8Array;
}

type PayLookup =
  | {
      ok: true;
      username: string;
      name: string;
      address: string;
      minSats: number;
      maxSats: number;
      metadata: { minSendable: number; maxSendable: number };
      charge: { amountSats: number; expiresAt: string } | null;
      sparkPubkey: string;
      pending: PosCharge | null;
    }
  | { ok: false; status: 404 | 502; error: string };

/**
 * Load the member and the LNURL-pay satoshi bounds of their receiving address.
 * After a valid wallet window, an unexpired pending point-of-sale charge
 * pins both sat bounds to that amount and sets `charge`. Provider
 * `minSendable` / `maxSendable` are left unchanged. `currentPending` is
 * not called when account or LNURL resolution already failed.
 *
 * @param rawUsername - Path parameter before normalisation.
 * @param deps - Auth store, LNURL-pay fetch, POS store, clock, and optional LNURL server.
 * @returns Display fields, bounds, and `charge`, or an HTTP error payload.
 */
async function lookupPayAccount(
  rawUsername: string,
  deps: {
    auth: AuthStore;
    fetchImpl: FetchFn;
    posStore: PosStore;
    now: () => number;
    lnurlServer?: LnurlServerConfig;
  },
): Promise<PayLookup> {
  const username = normalizeUsername(rawUsername);
  if (username === null) {
    logEvent('pay.unknown');
    return { ok: false, status: 404, error: 'Not found' };
  }
  try {
    const account = await deps.auth.getAccountByUsername(username);
    const receiving = account === undefined ? null : receivingAddress(account, deps.lnurlServer);
    if (account === undefined || receiving === null) {
      logEvent('pay.unknown', { username });
      return { ok: false, status: 404, error: 'Not found' };
    }
    const { address, sparkPubkey } = receiving;
    const resolved = await resolveLnurlp({
      address,
      fetchImpl: lnurlServerFetch(deps.lnurlServer, deps.fetchImpl, deps.auth),
    });
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
    const pending = await deps.posStore.currentPending(account.id, deps.now());
    if (pending === null) {
      return {
        ok: true,
        username,
        name,
        address,
        minSats,
        maxSats,
        metadata,
        charge: null,
        sparkPubkey,
        pending: null,
      };
    }
    return {
      ok: true,
      username,
      name,
      address,
      minSats: pending.amountSats,
      maxSats: pending.amountSats,
      metadata,
      charge: {
        amountSats: pending.amountSats,
        expiresAt: pending.expiresAt.toISOString(),
      },
      sparkPubkey,
      pending,
    };
  } catch {
    logEvent('pay.failed', { username });
    return { ok: false, status: 502, error: 'Lightning Address could not be resolved' };
  }
}

/**
 * Record a minted BOLT11 against the open charge and, when free in-app
 * payments are on, return the charge's Spark invoice (issuing it once).
 *
 * The Spark invoice charges the charge amount to the shop's verified wallet
 * key with memo `pos:<chargeId>`; a repeat call returns the stored string.
 * Store failures log `pos.invoice.record_failed` or
 * `pos.spark_invoice.issue_failed` and never fail the BOLT11 response.
 *
 * @param deps - Route collaborators.
 * @param pending - The open charge.
 * @param sparkPubkey - The shop's verified wallet key.
 * @param paymentHash - Payment hash of the minted BOLT11.
 * @param issuedAtMs - When the charge was found open, before the mint (epoch ms).
 * @returns The Spark invoice, or `null`.
 */
async function attachToCharge(
  deps: PayRouteDeps,
  pending: PosCharge,
  sparkPubkey: string,
  paymentHash: string,
  issuedAtMs: number,
): Promise<string | null> {
  try {
    await deps.posStore.recordInvoice(pending.id, paymentHash, issuedAtMs);
  } catch {
    logEvent('pos.invoice.record_failed', { accountId: pending.accountId });
  }
  if (deps.freePayments !== true) {
    return null;
  }
  const randomBytes =
    deps.randomBytes ?? ((length: number) => crypto.getRandomValues(new Uint8Array(length)));
  const invoice =
    pending.sparkInvoice ??
    encodeSparkInvoice({
      identityPublicKey: sparkPubkey,
      id: uuidV7(issuedAtMs, randomBytes(10)),
      memo: `pos:${pending.id}`,
      amountSats: pending.amountSats,
    });
  try {
    return await deps.posStore.issueSparkInvoice(pending.id, invoice, issuedAtMs);
  } catch {
    logEvent('pos.spark_invoice.issue_failed', { accountId: pending.accountId });
    return null;
  }
}

/**
 * Build the `/pay` route group.
 *
 * @param deps - Auth store, fetch, POS store, and clock (required), the
 *   optional LNURL server (omitted when it is off), `freePayments` (Spark
 *   invoices for an open till), and optional randomness.
 * @returns Hono app with `GET /:username` and `POST /:username/invoice`.
 */
export function payRoutes(deps: PayRouteDeps): Hono {
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
        charge: lookup.charge,
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
      const issuedAtMs = deps.now();
      const invoice = await requestGiftInvoice({
        address,
        amountMsat,
        fetchImpl: lnurlServerFetch(deps.lnurlServer, deps.fetchImpl, deps.auth),
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
      // The till pin makes any accepted amount the charge amount.
      const sparkInvoice =
        lookup.pending === null
          ? null
          : await attachToCharge(
              deps,
              lookup.pending,
              lookup.sparkPubkey,
              decoded.paymentHash,
              issuedAtMs,
            );
      logEvent('pay.invoice', { username, amountSats });
      return c.json({ pr: invoice.pr, amountSats, sparkInvoice });
    });
}
