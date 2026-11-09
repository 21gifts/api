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
import { isFondRole } from '@/lib/auth/roles';
import { resolveSession } from '@/lib/auth/service';
import { fetchBtcUsdSpot } from '@/lib/btc-usd-spot';
import type { LnurlServerConfig, PayoutSigner } from '@/lib/config';
import type { FondPayoutRow, FondPayoutStore } from '@/lib/fond-payout-store';
import type { FetchFn } from '@/lib/lnurlp';
import { logEvent } from '@/lib/log';
import { bearerToken } from '@/routes/me';
import {
  issueGiftInvoice,
  proveGiftInvoice,
  type GiftActionDeps,
  type IssueGiftInvoiceResult,
  type ProveGiftInvoiceResult,
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

/** `503` body when the spot cannot price at least one sat. */
export const FOND_PRICE_UNAVAILABLE = 'Price unavailable';

/** `403` body for a session that is not the Fond account. */
export const FOND_ONLY = 'Fond only';

/**
 * Whether `account` may use the `/fond/*` routes: role `fond`, the configured
 * username, and not the platform account.
 *
 * @param account - Authenticated account.
 * @param fondUsername - Configured `FOND_USERNAME`.
 * @returns `true` only for the Fond payer.
 */
function isFondPayer(account: Account, fondUsername: string): boolean {
  return (
    isFondRole(account.role) &&
    account.isPlatform !== true &&
    (account.username ?? '').trim().toLowerCase() === fondUsername
  );
}

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

/** Convert a USD amount string at the spot to whole sats, or `null` when unusable. */
function usdToSats(amountUsd: string, spot: string): number | null {
  const usd = Number(amountUsd);
  const usdPerBtc = Number(spot);
  if (!(usd > 0) || !(usdPerBtc > 0)) {
    return null;
  }
  const sats = Math.round((usd / usdPerBtc) * 1e8);
  return sats >= 1 ? sats : null;
}

/**
 * Map an issue result refusal to the queue: an issue-side 4xx text is stored
 * as `failed` and returned as 409; transport/configuration failures leave the
 * row untouched and keep their status.
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
    await deps.fondPayoutStore.setFailed(id, result.error);
    return { status: 409, error: result.error };
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
    if (!isFondPayer(account, deps.fondUsername)) {
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
      const id = c.req.param('id');
      let row: Awaited<ReturnType<FondPayoutStore['get']>>;
      try {
        row = await deps.fondPayoutStore.get(id);
      } catch {
        logEvent('fond.invoice.failed');
        return c.json({ error: 'Payouts are unavailable' }, 503);
      }
      if (row === undefined) {
        return c.json({ error: 'Not found' }, 404);
      }
      if (row.utcDay !== utcDay(deps.now()) || row.status === 'paid' || row.status === 'failed') {
        return c.json({ error: 'Not payable' }, 409);
      }
      if (row.status === 'invoiced' && row.invoiceId !== null) {
        const live = deps.actions.store.get(row.invoiceId);
        if (live !== undefined && deps.now() < live.expiresAt) {
          return c.json({ id: row.id, bolt11: live.pr, paymentHash: live.paymentHash }, 200);
        }
      }

      const spot = await fetchBtcUsdSpot(deps.fetchImpl);
      const sats = spot === null ? null : usdToSats(row.amountUsd, spot);
      if (sats === null) {
        return c.json({ error: FOND_PRICE_UNAVAILABLE }, 503);
      }

      const result = await issueGiftInvoice(deps.actions, {
        address: row.address,
        amountMsat: sats * 1000,
        comment: row.comment,
        ...(row.messageId === null ? {} : { messageId: row.messageId }),
        ...(row.groupMessageId === null ? {} : { groupMessageId: row.groupMessageId }),
        amountUsd: row.amountUsd,
      });
      if (!result.ok) {
        const refusal = await refusedInvoice(deps, row.id, result);
        return c.json({ error: refusal.error }, refusal.status);
      }
      const stored = await deps.fondPayoutStore.setInvoiced(row.id, {
        invoiceId: result.invoice.id,
        paymentHash: result.invoice.paymentHash,
        bolt11: result.invoice.pr,
      });
      if (stored === undefined) {
        return c.json({ error: 'Not payable' }, 409);
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
      const id = c.req.param('id');
      let row: Awaited<ReturnType<FondPayoutStore['get']>>;
      try {
        row = await deps.fondPayoutStore.get(id);
      } catch {
        logEvent('fond.proof.failed');
        return c.json({ error: 'Payouts are unavailable' }, 503);
      }
      if (row === undefined) {
        return c.json({ error: 'Not found' }, 404);
      }
      if ((row.status !== 'invoiced' && row.status !== 'paid') || row.invoiceId === null) {
        return c.json({ error: 'Not invoiced' }, 409);
      }
      const result: ProveGiftInvoiceResult = await proveGiftInvoice(deps.actions, {
        id: row.invoiceId,
        preimage: parsed.data.preimage,
        sourceWallet: deps.fondUsername,
      });
      if (!result.ok) {
        return c.json({ error: result.error }, result.status);
      }
      if (row.status !== 'paid') {
        const stored = await deps.fondPayoutStore.setPaid(row.id);
        if (stored === undefined) {
          return c.json({ error: 'Not invoiced' }, 409);
        }
      }
      logEvent('fond.payout.paid', { id: row.id });
      return c.json({ status: 'paid', id: row.id }, 200);
    });
}
