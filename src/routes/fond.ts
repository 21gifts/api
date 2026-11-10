/**
 * Routes for the Fond payout queue. Mounted always; they answer 404 unless
 * `PAYOUT_SIGNER=fond`.
 *
 * `GET /health` is public and unauthenticated. It reports whether queued
 * payouts are being paid. The other routes are the member session of the
 * single `fond` account that pays the queued instructions from its own
 * in-app wallet. The API decides every payout in the ping path. Those routes
 * only request the recipient invoice, convert the stored USD amount at the
 * current spot, and accept the preimage as proof. Never log addresses,
 * preimages, or invoices.
 */

import { Hono } from 'hono';
import { z } from 'zod';
import type { Account, AuthStore } from '@/lib/auth/store';
import { canSignFondPayouts } from '@/lib/auth/roles';
import { resolveSession } from '@/lib/auth/service';
import { fetchBtcUsdSpot } from '@/lib/btc-usd-spot';
import type { LnurlServerConfig, PayoutSigner } from '@/lib/config';
import {
  FOND_CLAIM_LEASE_MS,
  FOND_OVERDUE_MS,
  type FondPayoutRow,
  type FondPayoutStore,
} from '@/lib/fond-payout-store';
import type { FetchFn } from '@/lib/lnurlp';
import { logEvent } from '@/lib/log';
import { addUtcDays } from '@/lib/member-habit';
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
  paymentHash: string | null;
}

/** `503` body when the spot is missing or unusable. */
export const FOND_PRICE_UNAVAILABLE = 'Price unavailable';

/** `409` body when the priced amount rounds below one sat. */
export const FOND_AMOUNT_BELOW_ONE_SAT = 'Amount below one sat';

/** `409` body while another request owns the `issuing` claim. */
export const FOND_INVOICE_IN_PROGRESS = 'Invoice in progress';

/** `409` body while another proof owns the `settling` claim. */
export const FOND_PROOF_IN_PROGRESS = 'Proof in progress';

/** `403` body for a session that is not the Fond account. */
export const FOND_ONLY = 'Fond only';

/** `503` body when a payout store read or transition throws. */
const PAYOUTS_UNAVAILABLE = 'Payouts are unavailable';

/** `Cache-Control` for every `GET /fond/health` answer. The probe must not be cached. */
const HEALTH_NO_STORE = { 'Cache-Control': 'no-store' } as const;

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
  const paymentHash =
    row.status === 'invoiced' || row.status === 'settling' ? row.paymentHash : null;
  return { id: row.id, kind: row.kind, status: row.status, utcDay: row.utcDay, paymentHash };
}

/** UTC day key `YYYY-MM-DD`. */
function utcDay(nowMs: number): string {
  return new Date(nowMs).toISOString().slice(0, 10);
}

/** Positive decimal text accepted for the spot and committed USD strings. */
const DECIMAL_RE = /^(?:0|[1-9]\d*)(?:\.\d+)?$/;

/** Split decimal text into an integer numerator and a power-of-ten scale. */
function decimalParts(text: string): { numerator: bigint; scale: number } | null {
  const value = text.trim();
  if (!DECIMAL_RE.test(value)) {
    return null;
  }
  const dot = value.indexOf('.');
  const whole = dot < 0 ? value : value.slice(0, dot);
  const fraction = dot < 0 ? '' : value.slice(dot + 1);
  return { numerator: BigInt(`${whole}${fraction}`), scale: fraction.length };
}

/** Round a non-negative fraction half up, using integer division only. */
function roundHalfUp(numerator: bigint, denominator: bigint): bigint {
  const quotient = numerator / denominator;
  return (numerator % denominator) * 2n >= denominator ? quotient + 1n : quotient;
}

/** Convert a USD amount string at the spot to millisatoshis, or `null` when unusable. */
function usdToMsat(amountUsd: string, spot: string): number | null {
  const usd = decimalParts(amountUsd);
  const btc = decimalParts(spot);
  if (usd === null || btc === null || usd.numerator <= 0n || btc.numerator <= 0n) {
    return null;
  }
  const scale = Math.max(usd.scale, btc.scale);
  const usdScaled = usd.numerator * 10n ** BigInt(scale - usd.scale);
  const spotScaled = btc.numerator * 10n ** BigInt(scale - btc.scale);
  const sats = roundHalfUp(usdScaled * 100_000_000n, spotScaled);
  const amountMsat = sats * 1000n;
  if (amountMsat > BigInt(Number.MAX_SAFE_INTEGER)) {
    return null;
  }
  return Number(amountMsat);
}

/**
 * Release an `issuing` claim, reporting a store failure to the caller.
 *
 * @param deps - Route collaborators.
 * @param id - Payout row id.
 * @returns `true` when the guarded transition moved the row, `false` when it
 *   threw or the row was no longer `issuing`.
 */
async function releaseClaim(deps: FondRouteDeps, id: string): Promise<boolean> {
  try {
    return (await deps.fondPayoutStore.releaseClaim(id)) !== undefined;
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
      const failed = await deps.fondPayoutStore.markFailed(id, result.error);
      if (failed === undefined) {
        logEvent('fond.invoice.failed');
        return { status: 503, error: PAYOUTS_UNAVAILABLE };
      }
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
 * Build the `/fond` route group.
 *
 * `GET /health` is public and does not read a session. The other routes are
 * the fond payer's session routes.
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
    .get('/health', async (c) => {
      if (deps.payoutSigner !== 'fond') {
        return c.json({ error: 'Not found' }, 404, HEALTH_NO_STORE);
      }
      const nowMs = deps.now();
      const today = utcDay(nowMs);
      const yesterday = addUtcDays(today, -1);
      let todayRows: FondPayoutRow[];
      let yesterdayRows: FondPayoutRow[];
      try {
        todayRows = await deps.fondPayoutStore.listOpen(today);
        yesterdayRows = await deps.fondPayoutStore.listOpen(yesterday);
      } catch {
        logEvent('fond.health.failed');
        return c.json({ status: 'unavailable' }, 503, HEALTH_NO_STORE);
      }
      const open = todayRows.length;
      const overdue =
        todayRows.filter((row) => nowMs - row.createdAt.getTime() > FOND_OVERDUE_MS).length +
        yesterdayRows.length;
      if (overdue > 0) {
        return c.json({ status: 'overdue', open, overdue }, 503, HEALTH_NO_STORE);
      }
      return c.json({ status: 'ok', open }, 200, HEALTH_NO_STORE);
    })
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
        const cutoff = new Date(deps.now() - FOND_CLAIM_LEASE_MS);
        if (row.claimedAt === null || row.claimedAt >= cutoff) {
          return c.json({ error: FOND_INVOICE_IN_PROGRESS }, 409);
        }
        let reclaimed: FondPayoutRow | undefined;
        try {
          reclaimed = await deps.fondPayoutStore.claimStaleIssuing(row.id, cutoff);
        } catch {
          logEvent('fond.invoice.failed');
          return c.json({ error: PAYOUTS_UNAVAILABLE }, 503);
        }
        if (reclaimed === undefined) {
          return c.json({ error: FOND_INVOICE_IN_PROGRESS }, 409);
        }
        row = reclaimed;
      } else {
        if (row.status !== 'owed') {
          return c.json({ error: 'Not payable' }, 409);
        }
        if (row.utcDay !== utcDay(deps.now())) {
          return c.json({ error: 'Not payable' }, 409);
        }
      }

      if (row.status === 'owed') {
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
      }

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

      let result: IssueGiftInvoiceResult;
      try {
        result = await issueGiftInvoice(deps.actions, {
          address: row.address,
          amountMsat,
          comment: row.comment,
          ...(row.messageId === null ? {} : { messageId: row.messageId }),
          ...(row.groupMessageId === null ? {} : { groupMessageId: row.groupMessageId }),
          amountUsd: row.amountUsd,
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
          return c.json({ error: PAYOUTS_UNAVAILABLE }, 503);
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
        (row.status !== 'invoiced' && row.status !== 'settling' && row.status !== 'paid') ||
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
      if (row.status === 'paid') {
        logEvent('fond.payout.paid', { id: row.id });
        return c.json({ status: 'paid', id: row.id }, 200);
      }
      if (row.status === 'settling') {
        const cutoff = new Date(deps.now() - FOND_CLAIM_LEASE_MS);
        if (row.claimedAt === null || row.claimedAt >= cutoff) {
          return c.json({ error: FOND_PROOF_IN_PROGRESS }, 409);
        }
        let giftExists: boolean;
        try {
          giftExists = (await deps.actions.giftStore?.hasOutboundInvoice?.(row.bolt11)) ?? false;
        } catch {
          logEvent('fond.proof.failed');
          return c.json({ error: PAYOUTS_UNAVAILABLE }, 503);
        }
        if (giftExists) {
          let recovered: FondPayoutRow | undefined;
          try {
            recovered = await deps.fondPayoutStore.markStaleSettlingPaid(row.id, cutoff);
          } catch {
            logEvent('fond.proof.failed');
            return c.json({ error: PAYOUTS_UNAVAILABLE }, 503);
          }
          if (recovered === undefined) {
            logEvent('fond.proof.failed');
            return c.json({ error: PAYOUTS_UNAVAILABLE }, 503);
          }
          logEvent('fond.payout.paid', { id: row.id });
          return c.json({ status: 'paid', id: row.id }, 200);
        }
        let restored: FondPayoutRow | undefined;
        try {
          restored = await deps.fondPayoutStore.restoreStaleSettling(row.id, cutoff);
        } catch {
          logEvent('fond.proof.failed');
          return c.json({ error: PAYOUTS_UNAVAILABLE }, 503);
        }
        if (restored === undefined) {
          logEvent('fond.proof.failed');
          return c.json({ error: PAYOUTS_UNAVAILABLE }, 503);
        }
        row = restored;
      }
      let claimed: FondPayoutRow | undefined;
      try {
        claimed = await deps.fondPayoutStore.claimSettlement(row.id);
      } catch {
        logEvent('fond.proof.failed');
        return c.json({ error: PAYOUTS_UNAVAILABLE }, 503);
      }
      if (claimed === undefined) {
        let current: FondPayoutRow | undefined;
        try {
          current = await deps.fondPayoutStore.get(row.id);
        } catch {
          logEvent('fond.proof.failed');
          return c.json({ error: PAYOUTS_UNAVAILABLE }, 503);
        }
        if (current?.status === 'paid') {
          logEvent('fond.payout.paid', { id: row.id });
          return c.json({ status: 'paid', id: row.id }, 200);
        }
        if (current?.status === 'settling') {
          return c.json({ error: FOND_PROOF_IN_PROGRESS }, 409);
        }
        return c.json({ error: 'Not invoiced' }, 409);
      }
      const paidAt = deps.now();
      const fiat: FiatAmounts = { usd: row.amountUsd, chf: null, eur: null, php: null };
      const invoiceId = row.invoiceId;
      const bolt11 = row.bolt11;
      const paymentHash = row.paymentHash;
      const amountMsat = row.amountMsat;
      if (invoiceId === null || bolt11 === null || paymentHash === null || amountMsat === null) {
        try {
          const released = await deps.fondPayoutStore.releaseSettlement(row.id);
          if (released === undefined) {
            logEvent('fond.proof.revert_failed', { id: row.id });
          }
        } catch {
          logEvent('fond.proof.revert_failed', { id: row.id });
        }
        logEvent('fond.proof.failed');
        return c.json({ error: PAYOUTS_UNAVAILABLE }, 503);
      }
      try {
        await settleProvenGift(
          deps.actions,
          {
            id: invoiceId,
            address: row.address,
            pr: bolt11,
            paymentHash,
            amountMsat,
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
      } catch {
        try {
          const released = await deps.fondPayoutStore.releaseSettlement(row.id);
          if (released === undefined) {
            logEvent('fond.proof.revert_failed', { id: row.id });
          }
        } catch {
          logEvent('fond.proof.revert_failed', { id: row.id });
        }
        logEvent('fond.proof.failed');
        return c.json({ error: PAYOUTS_UNAVAILABLE }, 503);
      }
      let stored: FondPayoutRow | undefined;
      try {
        stored = await deps.fondPayoutStore.markPaid(row.id);
      } catch {
        stored = undefined;
      }
      if (stored === undefined) {
        logEvent('fond.proof.failed');
        return c.json({ error: PAYOUTS_UNAVAILABLE }, 503);
      }
      logEvent('fond.payout.paid', { id: row.id });
      return c.json({ status: 'paid', id: row.id }, 200);
    });
}
