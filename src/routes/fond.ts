/**
 * Routes for the Fond payout queue. Mounted always; they answer 404 unless
 * `PAYOUT_SIGNER=fond`.
 *
 * `GET /health` is public and unauthenticated. It reports whether queued
 * payouts are being paid. The other routes are the member session of the
 * single `fond` account that pays the queued instructions from its own
 * in-app wallet. The API decides every payout in the ping path. Those routes
 * only request the recipient invoice and convert the stored USD amount at the
 * current spot. The API's paid worker detects settlement itself. Never log
 * addresses, payment hashes, BOLT11, or Spark invoices.
 */

import { Hono } from 'hono';
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
import { accountByReceivingAddress } from '@/lib/receiving-address';
import { encodeSparkInvoice, uuidV7 } from '@/lib/spark-invoice';
import { normalizeUuid } from '@/lib/uuid';
import { bearerToken } from '@/routes/me';
import {
  issueGiftInvoice,
  type GiftActionDeps,
  type IssueGiftInvoiceResult,
} from '@/routes/invoices';

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
  /** `true` when free in-app payments are on (Spark invoices on the invoice route). */
  freePayments?: boolean;
  /** Random bytes for the Spark invoice id; default `crypto.getRandomValues`. */
  randomBytes?: (length: number) => Uint8Array;
  /** Extracted issue collaborators (stores, recorder, funding, gifts). */
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
 * Build the recipient's fee-free Spark invoice for one payout invoice.
 *
 * Only when free in-app payments are on and the stored address resolves to a
 * verified in-app wallet (`accountByReceivingAddress`). The memo names the
 * BOLT11 payment hash, like `zap:<paymentHash>` for zaps. An encoding or
 * account-lookup failure logs `fond.spark_invoice.issue_failed` and resolves
 * `null`, so the BOLT11 stays payable over Lightning.
 *
 * @param deps - Route collaborators.
 * @param address - Stored recipient Lightning Address.
 * @param paymentHash - BOLT11 payment hash.
 * @param amountMsat - Invoice amount in millisatoshis (whole sats).
 * @returns `spark1…`, or `null` when the feature is off, the recipient has no
 *   verified wallet, or issuing failed.
 */
async function payoutSparkInvoice(
  deps: FondRouteDeps,
  address: string,
  paymentHash: string,
  amountMsat: number,
): Promise<string | null> {
  if (deps.freePayments !== true) {
    return null;
  }
  try {
    const receiver = await accountByReceivingAddress(
      deps.actions.authStore,
      address,
      deps.lnurlServer,
    );
    if (receiver === undefined) {
      return null;
    }
    const randomBytes =
      deps.randomBytes ?? ((length: number) => crypto.getRandomValues(new Uint8Array(length)));
    return encodeSparkInvoice({
      identityPublicKey: receiver.receiving.sparkPubkey,
      id: uuidV7(deps.now(), randomBytes(10)),
      memo: `fond:${paymentHash}`,
      amountSats: Math.floor(amountMsat / 1000),
    });
  } catch {
    logEvent('fond.spark_invoice.issue_failed');
    return null;
  }
}

/**
 * Build the `/fond` route group.
 *
 * `GET /health` is public and does not read a session. The other routes are
 * the fond payer's session routes.
 *
 * @param deps - Auth, queue, switch, username, clock, fetch, LNURL config,
 *   free-payment switch, and the extracted issue collaborators.
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
        logEvent('fond.payouts.failed');
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
        return c.json(
          {
            id: row.id,
            bolt11: row.bolt11,
            paymentHash: row.paymentHash,
            sparkInvoice: row.sparkInvoice,
          },
          200,
        );
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
              {
                id: current.id,
                bolt11: current.bolt11,
                paymentHash: current.paymentHash,
                sparkInvoice: current.sparkInvoice,
              },
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
      const sparkInvoice = await payoutSparkInvoice(
        deps,
        row.address,
        result.invoice.paymentHash,
        amountMsat,
      );
      try {
        const stored = await deps.fondPayoutStore.setInvoiced(row.id, {
          invoiceId: result.invoice.id,
          paymentHash: result.invoice.paymentHash,
          bolt11: result.invoice.pr,
          sparkInvoice,
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
          sparkInvoice,
        },
        200,
      );
    });
}
