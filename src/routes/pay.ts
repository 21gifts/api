/**
 * `GET /pay/:username` — public pay-link card (display name, satoshi bounds,
 * and an open till when one is pending).
 * `POST /pay/:username/invoice` — one BOLT11 invoice via `requestGiftInvoice`,
 * plus a fee-free Spark invoice when free in-app payments are on: the open
 * till's invoice while a charge is pending, otherwise one for the posted amount.
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
import type { Account, AuthStore } from '@/lib/auth/store';
import type { LnurlServerConfig } from '@/lib/config';
import { decodeBolt11 } from '@/lib/bolt11';
import { requestGiftInvoice } from '@/lib/gift-invoice';
import type { FetchFn } from '@/lib/lnurlp';
import { resolveLnurlp } from '@/lib/lnurlp';
import { errorLogFields, logEvent } from '@/lib/log';
import type { PosCharge } from '@/lib/pos-charge';
import type { PosStore } from '@/lib/pos-store';
import { lnurlServerFetch, receivingAddress } from '@/lib/receiving-address';
import type { ShopPayments } from '@/lib/shop-payment';
import { encodeSparkInvoice, uuidV7 } from '@/lib/spark-invoice';
import { normalizeUsername } from '@/lib/username';

/** Largest Spark invoice memo the Spark operators accept, in UTF-8 bytes. */
const SPARK_INVOICE_MEMO_MAX_BYTES = 120;

/** Collaborators the `/pay` routes need. */
interface PayRouteDeps {
  auth: AuthStore;
  fetchImpl: FetchFn;
  posStore: PosStore;
  now: () => number;
  /** LNURL server; omitted when off. */
  lnurlServer?: LnurlServerConfig;
  /** `true` when free in-app payments are on (Spark invoices on `POST /:username/invoice`). */
  freePayments?: boolean;
  /** Random bytes for the Spark invoice id; default `crypto.getRandomValues`. */
  randomBytes?: (length: number) => Uint8Array;
  /** Shop payments in USDT and USDC (`POST /:username/payment`); omitted → that route answers 404. */
  shopPayments?: ShopPayments;
}

/** `POST /pay/:username/payment` 503 body (orders 6, 7, and 9). */
const STABLECOIN_UNAVAILABLE = {
  error: 'Stablecoin payment is unavailable',
  code: 'stablecoin_unavailable',
} as const;

type PayLookup =
  | {
      ok: true;
      account: Account;
      username: string;
      name: string;
      address: string;
      minSats: number;
      maxSats: number;
      metadata: { minSendable: number; maxSendable: number; commentAllowed?: number };
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
        account,
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
      account,
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
 * Memo for a Spark invoice without a charge: the trimmed comment, cut to
 * `commentAllowed` characters (missing is 0) and then to
 * {@link SPARK_INVOICE_MEMO_MAX_BYTES} UTF-8 bytes, never inside a character.
 *
 * @param comment - The posted `comment`; anything but a string is no comment.
 * @param commentAllowed - The member's LNURL-pay `commentAllowed`.
 * @returns The memo, or `undefined` when nothing is left.
 */
function sparkMemo(comment: unknown, commentAllowed: number | undefined): string | undefined {
  const maxChars = commentAllowed ?? 0;
  if (typeof comment !== 'string' || maxChars <= 0) {
    return undefined;
  }
  const encoder = new TextEncoder();
  let memo = '';
  let chars = 0;
  let bytes = 0;
  // Walk the comment lazily so a long body never becomes one array.
  for (const char of comment.trim()) {
    bytes += encoder.encode(char).byteLength;
    if (chars === maxChars || bytes > SPARK_INVOICE_MEMO_MAX_BYTES) {
      break;
    }
    memo += char;
    chars += 1;
  }
  return memo === '' ? undefined : memo;
}

/**
 * Spark invoice for an amount with no open charge, when free in-app
 * payments are on: the member's verified wallet key, exactly `amountSats`,
 * and the memo from {@link sparkMemo} (built only when the feature is on).
 * Not stored; nothing waits for it.
 *
 * @param deps - Route collaborators.
 * @param sparkPubkey - The member's verified wallet key.
 * @param amountSats - Accepted amount in whole sats.
 * @param comment - The posted `comment`, unchecked.
 * @param commentAllowed - The member's LNURL-pay `commentAllowed`.
 * @param issuedAtMs - Clock for the invoice id (epoch ms).
 * @returns The Spark invoice, or `null` when free in-app payments are off.
 */
function memberSparkInvoice(
  deps: PayRouteDeps,
  sparkPubkey: string,
  amountSats: number,
  comment: unknown,
  commentAllowed: number | undefined,
  issuedAtMs: number,
): string | null {
  if (deps.freePayments !== true) {
    return null;
  }
  const memo = sparkMemo(comment, commentAllowed);
  const randomBytes =
    deps.randomBytes ?? ((length: number) => crypto.getRandomValues(new Uint8Array(length)));
  return encodeSparkInvoice({
    identityPublicKey: sparkPubkey,
    id: uuidV7(issuedAtMs, randomBytes(10)),
    ...(memo === undefined ? {} : { memo }),
    amountSats,
  });
}

/**
 * Read the `{ amountSats, comment? }` body both payment routes take.
 *
 * @param request - Incoming request.
 * @returns The integer amount and the unchecked comment, or `null` when the
 *   body is not JSON or `amountSats` is not an integer.
 */
async function readAmountBody(
  request: Request,
): Promise<{ amountSats: number; comment: unknown } | null> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return null;
  }
  const parsed = z
    .object({ amountSats: z.number().int(), comment: z.unknown().optional() })
    .safeParse(body);
  return parsed.success
    ? { amountSats: parsed.data.amountSats, comment: parsed.data.comment }
    : null;
}

/**
 * Whether an amount lies inside the pay request's minimum and maximum, in
 * sats and in millisats (the check `POST /:username/invoice` applies).
 *
 * @param lookup - Resolved account and bounds.
 * @param amountSats - Requested sats.
 * @returns `true` when the amount is accepted.
 */
function withinPayRange(lookup: Extract<PayLookup, { ok: true }>, amountSats: number): boolean {
  const amountMsat = amountSats * 1000;
  const outsideSat = amountSats < lookup.minSats || amountSats > lookup.maxSats;
  const belowMsat = amountMsat < lookup.metadata.minSendable;
  const aboveMsat = amountMsat > lookup.metadata.maxSendable;
  return ((outsideSat ? 1 : 0) | (belowMsat ? 1 : 0) | (aboveMsat ? 1 : 0)) === 0;
}

/**
 * Build the `/pay` route group.
 *
 * @param deps - Auth store, fetch, POS store, and clock (required), the
 *   optional LNURL server (omitted when it is off), `freePayments` (Spark
 *   invoices), and optional randomness.
 * @returns Hono app with `GET /:username`, `POST /:username/invoice`, and
 *   `POST /:username/payment`.
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
      const parsed = await readAmountBody(c.req.raw);
      if (parsed === null) {
        return c.json({ error: 'Enter a whole number of sats' }, 400);
      }
      const amountSats = parsed.amountSats;
      const amountMsat = amountSats * 1000;
      const { metadata, address, username } = lookup;
      if (!withinPayRange(lookup, amountSats)) {
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
          ? memberSparkInvoice(
              deps,
              lookup.sparkPubkey,
              amountSats,
              parsed.comment,
              metadata.commentAllowed,
              issuedAtMs,
            )
          : await attachToCharge(
              deps,
              lookup.pending,
              lookup.sparkPubkey,
              decoded.paymentHash,
              issuedAtMs,
            );
      logEvent('pay.invoice', { username, amountSats });
      return c.json({ pr: invoice.pr, amountSats, sparkInvoice });
    })
    .post('/:username/payment', async (c) => {
      const shop = deps.shopPayments;
      const lookup = await lookupPayAccount(c.req.param('username'), deps);
      if (!lookup.ok) {
        return c.json({ error: lookup.error }, lookup.status);
      }
      if (shop === undefined) {
        return c.json({ error: 'Not found' }, 404);
      }
      const parsed = await readAmountBody(c.req.raw);
      if (parsed === null || parsed.amountSats < 1) {
        return c.json({ error: 'Enter a whole number of sats' }, 400);
      }
      if (lookup.pending !== null) {
        return c.json({ error: 'A payment is already open', code: 'payment_open' }, 409);
      }
      if (!withinPayRange(lookup, parsed.amountSats)) {
        return c.json({ error: 'Enter a whole number of sats' }, 400);
      }
      if (!shop.offersStablecoins(lookup.username)) {
        return c.json(STABLECOIN_UNAVAILABLE, 503);
      }
      let created: Awaited<ReturnType<ShopPayments['createForPayer']>>;
      try {
        created = await shop.createForPayer(lookup.account, lookup.username, parsed.amountSats);
      } catch (error) {
        // A store failure: the page cannot tell whether a payment opened, so
        // it repeats the request, as after any other 5xx.
        logEvent('pay.failed', { username: lookup.username, ...errorLogFields(error) });
        return c.json({ error: 'Lightning Address could not be resolved' }, 502);
      }
      switch (created.kind) {
        case 'payment':
          return c.json(
            { payment: created.payment.id, expiresAt: created.payment.windowEndsAt.toISOString() },
            200,
          );
        case 'pending_charge':
          return c.json({ error: 'A payment is already open', code: 'payment_open' }, 409);
        case 'mint_failed':
          logEvent('pay.invoice_failed', { username: lookup.username });
          return c.json({ error: 'Lightning Address could not be resolved' }, 502);
        default:
          return c.json(STABLECOIN_UNAVAILABLE, 503);
      }
    });
}
