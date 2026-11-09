/**
 * Member-session routes for the single `fond` account that pays the queued
 * payout instructions from its own in-app wallet. The routes are mounted
 * always; they answer 404 unless `PAYOUT_SIGNER=fond`.
 *
 * The API decides every payout in the ping path. These routes only request
 * the recipient invoice, convert the stored USD amount at the current spot,
 * and accept the preimage as proof. Never log addresses, preimages, or
 * invoices.
 */

import { Hono } from 'hono';
import { z } from 'zod';
import type { Account, AuthStore } from '@/lib/auth/store';
import { canSignFondPayouts } from '@/lib/auth/roles';
import { resolveSession } from '@/lib/auth/service';
import { fetchBtcUsdSpot } from '@/lib/btc-usd-spot';
import type { LnurlServerConfig, PayoutSigner } from '@/lib/config';
import type { FondPayoutRow, FondPayoutStore } from '@/lib/fond-payout-store';
import type { FetchFn } from '@/lib/lnurlp';
import { logEvent } from '@/lib/log';
import type { FiatAmounts } from '@/lib/money';
import { preimageMatchesHash } from '@/lib/proof';
import { normalizeUuid } from '@/lib/uuid';
import { bearerToken } from '@/routes/me';
import {
  GIFT_PROOF_MISMATCH,
  issueGiftInvoice,
  settleProvenGift,
  type GiftActionDeps,
  type IssueGiftInvoiceResult,
} from '@/routes/invoices';

/** Body schema for `POST /fond/payouts/:id/proof`. */
const proofBody = z.object({ preimage: z.string() });

/** Collaborators the `/fond` routes need. */
export interface FondRouteDeps {
  /** Shared auth persistence port for session resolution. */
  authStore: AuthStore;
  /** Durable payout queue. */
  fondPayoutStore: FondPayoutStore;
  /** `PAYOUT_SIGNER`; only `fond` mounts the surface. */
  payoutSigner: PayoutSigner;
  /** `FOND_USERNAME`; the one account allowed on the surface. */
  fondUsername: string;
  /** Clock, epoch milliseconds. */
  now: () => number;
  /** Injected fetch for the BTC/USD spot and LNURL-pay. */
  fetchImpl: FetchFn;
  /** LNURL server config; omitted when off. */
  lnurlServer?: LnurlServerConfig;
  /** Extracted issue/proof collaborators (stores, recorder, funding, gifts). */
  actions: GiftActionDeps;
}

/** Today's open payout row in the `GET /fond/payouts` body. */
interface FondPayoutListRow {
  id: string;
  kind: string;
  status: string;
  utcDay: string;
}

/** `503` body when the spot is missing or unusable. */
export const FOND_PRICE_UNAVAILABLE = 'Price unavailable';

/** `409` body when the priced amount rounds below one sat. */
export const FOND_AMOUNT_BELOW_ONE_SAT = 'Amount below one sat';

/** `409` body while another request owns the `issuing` claim. */
export const FOND_INVOICE_IN_PROGRESS = 'Invoice in progress';

/** `403` body for a session that is not the Fond account. */
export const FOND_ONLY = 'Fond only';

/** `503` body when a payout store read or transition throws. */
const PAYOUTS_UNAVAILABLE = 'Payouts are unavailable';

/**
 * Resolve the session account for a `/fond` request.
 *
 * @param deps - Route collaborators.
 * @param header - `Authorization` header.
 * @returns The account, or `undefined` when unauthenticated.
 */
async function sessionAccount(
  deps: FondRouteDeps,
  header: string | undefined,
): Promise<Account | undefined> {
  const token = bearerToken(header);
  if (token === null) {
    return undefined;
  }
  return (await resolveSession(deps.authStore, deps.now(), token)) ?? undefined;
}

/** Open row projection for `GET /fond/payouts`. */
function listRow(row: FondPayoutRow): FondPayoutListRow {
  return { id: row.id, kind: row.kind, status: row.status, utcDay: row.utcDay };
}

/** UTC day key `YYYY-MM-DD`. */
function utcDay(nowMs: number): string {
  return new Date(nowMs).toISOString().slice(0, 10);
}

/** Convert a USD amount string at the spot to millisatoshis, or `null` when unusable. */
function usdToMsat(amountUsd: string, spot: string): number | null {
  const usd = Number(amountUsd);
  const usdPerBtc = Number(spot);
  if (!Number.isFinite(usd) || !Number.isFinite(usdPerBtc) || !(usd > 0) || !(usdPerBtc > 0)) {
    return null;
  }
  return Math.round((usd / usdPerBtc) * 1e8) * 1000;
}

/**
 * Two-decimal display amount for the issue body.
 *
 * The display amount is cosmetic. It is the exact decided USD rounded half-up
 * to cents and formatted with exactly two decimals so `issueGiftInvoice`'s
 * two-decimal validator accepts it. A value below one cent would display as
 * `"0.00"`, so the caller omits it instead. The paid sats always come from the
 * exact value in {@link usdToMsat}.
 *
 * @param amountUsd - Exact decided USD value.
 * @returns Two-decimal USD display string, or `null` when below one cent.
 */
function displayAmountUsd(amountUsd: string): string | null {
  const display = (Math.round(Number(amountUsd) * 100) / 100).toFixed(2);
  return display === '0.00' ? null : display;
}

/**
 * Release an `issuing` claim, reporting a store failure to the caller.
 *
 * @param deps - Route collaborators.
 * @param id - Payout row id.
 * @returns `true` when the release succeeded, `false` when the store threw.
 */
async function releaseClaim(deps: FondRouteDeps, id: string): Promise<boolean> {
  try {
    await deps.fondPayoutStore.releaseClaim(id);
    return true;
  } catch {
    return false;
  }
}

/**
 * Map an issue result refusal to the queue: an issue-side 4xx text is stored
 * as `failed` and returned as 409; transport/configuration failures release
 * the claim back to `owed` and keep their status.
 *
 * @param deps - Route collaborators.
 * @param id - Payout row id.
 * @param result - Issue action result.
 * @returns Status and error text for the route response.
 */
async function refusedInvoice(
  deps: FondRouteDeps,
  id: string,
  result: Extract<IssueGiftInvoiceResult, { ok: false }>,
): Promise<{ status: 400 | 403 | 409 | 502 | 503; error: string }> {
  if (result.status < 500) {
    try {
      await deps.fondPayoutStore.markFailed(id, result.error);
    } catch {
      logEvent('fond.invoice.failed');
      return { status: 503, error: PAYOUTS_UNAVAILABLE };
    }
    return { status: 409, error: result.error };
  }
  if (!(await releaseClaim(deps, id))) {
    logEvent('fond.invoice.failed');
    return { status: 503, error: PAYOUTS_UNAVAILABLE };
  }
  return { status: result.status, error: result.error };
}

/**
 * Build the `/fond` route group for the fond payer.
 *
 * @param deps - Auth, queue, switch, username, clock, fetch, LNURL config,
 *   and the extracted issue/proof collaborators.
 * @returns Hono app mounted at `/fond`.
 */
export function fondRoutes(deps: FondRouteDeps): Hono {
  const authGate = async (
    header: string | undefined,
  ): Promise<{ status: 401 | 403; error: string } | null> => {
    const account = await sessionAccount(deps, header);
    if (account === undefined) {
      return { status: 401, error: 'Unauthorized' };
    }
    if (!canSignFondPayouts(account, deps.fondUsername)) {
      return { status: 403, error: FOND_ONLY };
    }
    return null;
  };

  return new Hono()
    .get('/payouts', async (c) => {
      if (deps.payoutSigner !== 'fond') {
        return c.json({ error: 'Not found' }, 404);
      }
      const denied = await authGate(c.req.header('authorization'));
      if (denied !== null) {
        return c.json({ error: denied.error }, denied.status);
      }
      const today = utcDay(deps.now());
      try {
        const rows = await deps.fondPayoutStore.listOpen(today);
        return c.json({ payouts: rows.map(listRow) }, 200);
      } catch {
        logEvent('fond.payouts.failed');
        return c.json({ error: 'Payouts are unavailable' }, 503);
      }
    })
    .post('/payouts/:id/invoice', async (c) => {
      if (deps.payoutSigner !== 'fond') {
        return c.json({ error: 'Not found' }, 404);
      }
      const denied = await authGate(c.req.header('authorization'));
      if (denied !== null) {
        return c.json({ error: denied.error }, denied.status);
      }
      const id = normalizeUuid(c.req.param('id'));
      if (id === null) {
        return c.json({ error: 'Not found' }, 404);
      }
      let row: Awaited<ReturnType<FondPayoutStore['get']>>;
      try {
        row = await deps.fondPayoutStore.get(id);
      } catch {
        logEvent('fond.invoice.failed');
        return c.json({ error: PAYOUTS_UNAVAILABLE }, 503);
      }
      if (row === undefined) {
        return c.json({ error: 'Not found' }, 404);
      }
      if (row.status === 'invoiced') {
        if (row.bolt11 === null || row.paymentHash === null) {
          return c.json({ error: 'Not payable' }, 409);
        }
        return c.json({ id: row.id, bolt11: row.bolt11, paymentHash: row.paymentHash }, 200);
      }
      if (row.status === 'issuing') {
        return c.json({ error: FOND_INVOICE_IN_PROGRESS }, 409);
      }
      if (row.status !== 'owed') {
        return c.json({ error: 'Not payable' }, 409);
      }
      if (row.utcDay !== utcDay(deps.now())) {
        return c.json({ error: 'Not payable' }, 409);
      }

      let claimed: FondPayoutRow | null;
      try {
        claimed = await deps.fondPayoutStore.claimForInvoice(row.id, utcDay(deps.now()));
      } catch {
        logEvent('fond.invoice.failed');
        return c.json({ error: PAYOUTS_UNAVAILABLE }, 503);
      }
      if (claimed === null) {
        let current: FondPayoutRow | undefined;
        try {
          current = await deps.fondPayoutStore.get(row.id);
        } catch {
          logEvent('fond.invoice.failed');
          return c.json({ error: PAYOUTS_UNAVAILABLE }, 503);
        }
        if (
          current?.status === 'invoiced' &&
          current.bolt11 !== null &&
          current.paymentHash !== null
        ) {
          return c.json(
            { id: current.id, bolt11: current.bolt11, paymentHash: current.paymentHash },
            200,
          );
        }
        if (current?.status === 'issuing') {
          return c.json({ error: FOND_INVOICE_IN_PROGRESS }, 409);
        }
        return c.json({ error: 'Not payable' }, 409);
      }
      row = claimed;

      let spot: string | null;
      try {
        spot = await fetchBtcUsdSpot(deps.fetchImpl);
      } catch {
        spot = null;
      }
      const amountMsat = spot === null ? null : usdToMsat(row.amountUsd, spot);
      if (amountMsat === null) {
        if (!(await releaseClaim(deps, row.id))) {
          logEvent('fond.invoice.failed');
          return c.json({ error: PAYOUTS_UNAVAILABLE }, 503);
        }
        return c.json({ error: FOND_PRICE_UNAVAILABLE }, 503);
      }
      if (amountMsat < 1000) {
        if (!(await releaseClaim(deps, row.id))) {
          logEvent('fond.invoice.failed');
          return c.json({ error: PAYOUTS_UNAVAILABLE }, 503);
        }
        return c.json({ error: FOND_AMOUNT_BELOW_ONE_SAT }, 409);
      }

      const displayUsd = displayAmountUsd(row.amountUsd);
      let result: IssueGiftInvoiceResult;
      try {
        result = await issueGiftInvoice(deps.actions, {
          address: row.address,
          amountMsat,
          comment: row.comment,
          ...(row.messageId === null ? {} : { messageId: row.messageId }),
          ...(row.groupMessageId === null ? {} : { groupMessageId: row.groupMessageId }),
          ...(displayUsd === null ? {} : { amountUsd: displayUsd }),
        });
      } catch {
        await releaseClaim(deps, row.id);
        logEvent('fond.invoice.failed');
        return c.json({ error: PAYOUTS_UNAVAILABLE }, 503);
      }
      if (!result.ok) {
        const refusal = await refusedInvoice(deps, row.id, result);
        return c.json({ error: refusal.error }, refusal.status);
      }
      try {
        const stored = await deps.fondPayoutStore.setInvoiced(row.id, {
          invoiceId: result.invoice.id,
          paymentHash: result.invoice.paymentHash,
          bolt11: result.invoice.pr,
          amountMsat,
        });
        if (stored === undefined) {
          logEvent('fond.invoice.failed');
          return c.json({ error: 'Not payable' }, 409);
        }
      } catch {
        logEvent('fond.invoice.failed');
        return c.json({ error: PAYOUTS_UNAVAILABLE }, 503);
      }
      return c.json(
        {
          id: row.id,
          bolt11: result.invoice.pr,
          paymentHash: result.invoice.paymentHash,
        },
        200,
      );
    })
    .post('/payouts/:id/proof', async (c) => {
      if (deps.payoutSigner !== 'fond') {
        return c.json({ error: 'Not found' }, 404);
      }
      const denied = await authGate(c.req.header('authorization'));
      if (denied !== null) {
        return c.json({ error: denied.error }, denied.status);
      }
      const id = normalizeUuid(c.req.param('id'));
      if (id === null) {
        return c.json({ error: 'Not found' }, 404);
      }
      let raw: unknown;
      try {
        raw = await c.req.json();
      } catch {
        return c.json({ error: 'Expected a JSON body with preimage' }, 400);
      }
      const parsed = proofBody.safeParse(raw);
      if (!parsed.success) {
        return c.json({ error: 'Expected a JSON body with preimage' }, 400);
      }
      let row: Awaited<ReturnType<FondPayoutStore['get']>>;
      try {
        row = await deps.fondPayoutStore.get(id);
      } catch {
        logEvent('fond.proof.failed');
        return c.json({ error: PAYOUTS_UNAVAILABLE }, 503);
      }
      if (row === undefined) {
        return c.json({ error: 'Not found' }, 404);
      }
      if (
        (row.status !== 'invoiced' && row.status !== 'paid') ||
        row.invoiceId === null ||
        row.paymentHash === null ||
        row.bolt11 === null ||
        row.amountMsat === null
      ) {
        return c.json({ error: 'Not invoiced' }, 409);
      }
      if (!preimageMatchesHash(parsed.data.preimage, row.paymentHash)) {
        return c.json({ error: GIFT_PROOF_MISMATCH }, 400);
      }
      const paidAt = deps.now();
      const fiat: FiatAmounts = { usd: row.amountUsd, chf: null, eur: null, php: null };
      await settleProvenGift(
        deps.actions,
        {
          id: row.invoiceId,
          address: row.address,
          pr: row.bolt11,
          paymentHash: row.paymentHash,
          amountMsat: row.amountMsat,
          createdAt: paidAt,
          expiresAt: paidAt,
          comment: row.comment,
          ...(row.messageId === null ? {} : { messageId: row.messageId }),
          ...(row.groupMessageId === null ? {} : { groupMessageId: row.groupMessageId }),
          amountUsd: row.amountUsd,
        },
        paidAt,
        deps.fondUsername,
        fiat,
        row.kind,
      );
      if (row.status !== 'paid') {
        try {
          const stored = await deps.fondPayoutStore.markPaid(row.id);
          if (stored === undefined) {
            return c.json({ error: 'Not invoiced' }, 409);
          }
        } catch {
          logEvent('fond.proof.failed');
          return c.json({ error: PAYOUTS_UNAVAILABLE }, 503);
        }
      }
      logEvent('fond.payout.paid', { id: row.id });
      return c.json({ status: 'paid', id: row.id }, 200);
    });
}
