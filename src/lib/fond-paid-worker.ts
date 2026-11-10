/**
 * Background worker that detects paid Fond payouts and records their gifts.
 *
 * Every tick lists today's and yesterday's `invoiced` rows plus any `settling`
 * row whose claim lease expired. For the Spark invoices it asks the Spark
 * coordinator (`querySparkInvoices`); for the remaining rows it asks the LNURL
 * server's LUD-21 `/verify` (`verifyLightningPayment`). The first confirmation
 * runs the existing guarded settlement once: `claimSettlement`,
 * `settleProvenGift`, `markPaid`, with `releaseSettlement` on failure. A stale
 * `settling` row is recovered through `hasOutboundInvoice`: a recorded gift
 * becomes `paid`, otherwise the row returns to `invoiced` and can settle again.
 *
 * No log line carries an address, BOLT11, Spark invoice, payment hash, or
 * preimage.
 */

import type { LnurlServerConfig } from '@/lib/config';
import { utcDayKey } from '@/lib/funding';
import {
  FOND_CLAIM_LEASE_MS,
  type FondPayoutRow,
  type FondPayoutStore,
} from '@/lib/fond-payout-store';
import type { FetchFn } from '@/lib/lnurlp';
import { addUtcDays } from '@/lib/member-habit';
import type { FiatAmounts } from '@/lib/money';
import { verifyLightningPayment } from '@/lib/pos-paid-worker';
import { errorLogFields, logEvent } from '@/lib/log';
import type { GiftActionDeps } from '@/routes/invoices';
import { settleProvenGift } from '@/routes/invoices';
import { SPARK_QUERY_LIMIT, querySparkInvoices } from '@/lib/spark-operator';
import { SPARK_WORKER_INTERVAL_MS } from '@/lib/spark-worker';

/** Collaborators for {@link runFondPaidTick}. */
export interface FondPaidWorkerDeps {
  /** Durable payout queue. */
  store: FondPayoutStore;
  /** LNURL server that answers `/verify/:paymentHash`. */
  lnurlServer: LnurlServerConfig;
  /** Spark coordinator base URL; omitted when free in-app payments are off. */
  operatorUrl?: string;
  /** Fetch for the coordinator and the LNURL server (fake in tests). */
  fetchImpl: FetchFn;
  /** Clock in epoch milliseconds. */
  now: () => number;
  /** `FOND_USERNAME`; recorded as the paying wallet. */
  fondUsername: string;
  /** Gift, forum, and group settlement collaborators. */
  actions: GiftActionDeps;
}

/** Rows this tick may settle: today's and yesterday's invoiced or settling rows. */
async function watchedRows(deps: FondPaidWorkerDeps): Promise<FondPayoutRow[]> {
  const today = utcDayKey(deps.now());
  const yesterday = addUtcDays(today, -1);
  const rows = [...(await deps.store.listOpen(today)), ...(await deps.store.listOpen(yesterday))];
  return rows.filter((row) => row.status === 'invoiced' || row.status === 'settling');
}

/**
 * Recover one stale `settling` row: a recorded gift means the earlier
 * settlement completed; otherwise the row may settle again. A lookup or
 * transition failure leaves the row for the next tick.
 *
 * @param deps - Worker collaborators.
 * @param row - Stale `settling` row.
 * @param cutoff - Exclusive claim-time cutoff.
 * @returns The now-`invoiced` row when it may settle in this tick, otherwise `undefined`.
 */
async function recoverStaleSettling(
  deps: FondPaidWorkerDeps,
  row: FondPayoutRow,
  cutoff: Date,
): Promise<FondPayoutRow | undefined> {
  let giftExists: boolean;
  try {
    giftExists = (await deps.actions.giftStore?.hasOutboundInvoice?.(row.bolt11 ?? '')) ?? false;
  } catch {
    logEvent('fond.proof.failed', { id: row.id });
    return undefined;
  }
  if (giftExists) {
    try {
      const recovered = await deps.store.markStaleSettlingPaid(row.id, cutoff);
      if (recovered === undefined) {
        logEvent('fond.proof.failed', { id: row.id });
        return undefined;
      }
      logEvent('fond.payout.paid', { id: row.id });
    } catch {
      logEvent('fond.proof.failed', { id: row.id });
    }
    return undefined;
  }
  try {
    const restored = await deps.store.restoreStaleSettling(row.id, cutoff);
    if (restored === undefined) {
      logEvent('fond.proof.failed', { id: row.id });
      return undefined;
    }
    return restored;
  } catch {
    logEvent('fond.proof.failed', { id: row.id });
    return undefined;
  }
}

/**
 * Release a claimed row after a failed settlement and report that no retry can
 * be scheduled from this tick when the release itself misses.
 *
 * @param deps - Worker collaborators.
 * @param id - Payout row id.
 */
async function releaseAfterFailure(deps: FondPaidWorkerDeps, id: string): Promise<void> {
  try {
    const released = await deps.store.releaseSettlement(id);
    if (released === undefined) {
      logEvent('fond.proof.revert_failed', { id });
    }
  } catch {
    logEvent('fond.proof.revert_failed', { id });
  }
}

/**
 * Settle one confirmed row through the guarded transition. The claim makes a
 * concurrent tick or worker settlement impossible; the loser re-reads and
 * leaves the winner's row alone. A settlement failure releases the row back to
 * `invoiced`; a failed `markPaid` leaves the recorded gift recoverable by the
 * stale-`settling` path on a later tick.
 *
 * @param deps - Worker collaborators.
 * @param row - Confirmed `invoiced` row.
 */
async function settleConfirmed(deps: FondPaidWorkerDeps, row: FondPayoutRow): Promise<void> {
  let claimed: FondPayoutRow | undefined;
  try {
    claimed = await deps.store.claimSettlement(row.id);
  } catch {
    logEvent('fond.proof.failed', { id: row.id });
    return;
  }
  if (claimed === undefined) {
    let current: FondPayoutRow | undefined;
    try {
      current = await deps.store.get(row.id);
    } catch {
      logEvent('fond.proof.failed', { id: row.id });
      return;
    }
    if (current?.status === 'paid') {
      logEvent('fond.payout.paid', { id: row.id });
    }
    return;
  }
  const invoiceId = claimed.invoiceId;
  const bolt11 = claimed.bolt11;
  const paymentHash = claimed.paymentHash;
  const amountMsat = claimed.amountMsat;
  if (invoiceId === null || bolt11 === null || paymentHash === null || amountMsat === null) {
    await releaseAfterFailure(deps, claimed.id);
    logEvent('fond.proof.failed', { id: claimed.id });
    return;
  }
  const paidAt = deps.now();
  const fiat: FiatAmounts = { usd: claimed.amountUsd, chf: null, eur: null, php: null };
  try {
    await settleProvenGift(
      deps.actions,
      {
        id: invoiceId,
        address: claimed.address,
        pr: bolt11,
        paymentHash,
        amountMsat,
        createdAt: paidAt,
        expiresAt: paidAt,
        comment: claimed.comment,
        ...(claimed.messageId === null ? {} : { messageId: claimed.messageId }),
        ...(claimed.groupMessageId === null ? {} : { groupMessageId: claimed.groupMessageId }),
        amountUsd: claimed.amountUsd,
      },
      paidAt,
      deps.fondUsername,
      fiat,
      claimed.kind,
    );
  } catch {
    await releaseAfterFailure(deps, claimed.id);
    logEvent('fond.proof.failed', { id: claimed.id });
    return;
  }
  try {
    const stored = await deps.store.markPaid(claimed.id);
    if (stored === undefined) {
      logEvent('fond.proof.failed', { id: claimed.id });
      return;
    }
  } catch {
    logEvent('fond.proof.failed', { id: claimed.id });
    return;
  }
  logEvent('fond.payout.paid', { id: claimed.id });
}

/**
 * Poll the Spark coordinator for the watched rows that have a Spark invoice.
 *
 * Batches of {@link SPARK_QUERY_LIMIT}; a failed batch logs
 * `fond.paid.spark_query_failed` and the next batch still runs. Only
 * `finalized` confirms a payout. The id is removed from `open` before
 * settlement, so the LUD-21 pass does not try the same row again.
 *
 * @param deps - Worker collaborators.
 * @param operatorUrl - Spark coordinator base URL.
 * @param watched - Rows checked this tick.
 * @param open - Ids still eligible for the LUD-21 pass.
 */
async function pollSpark(
  deps: FondPaidWorkerDeps,
  operatorUrl: string,
  watched: readonly FondPayoutRow[],
  open: Set<string>,
): Promise<void> {
  const byInvoice = new Map<string, FondPayoutRow>();
  for (const row of watched) {
    if (row.sparkInvoice !== null) {
      byInvoice.set(row.sparkInvoice, row);
    }
  }
  const invoices = [...byInvoice.keys()];
  for (let i = 0; i < invoices.length; i += SPARK_QUERY_LIMIT) {
    const result = await querySparkInvoices(
      operatorUrl,
      deps.fetchImpl,
      invoices.slice(i, i + SPARK_QUERY_LIMIT),
    );
    if (!result.ok) {
      logEvent('fond.paid.spark_query_failed', {
        reason: result.reason,
        ...(result.reason === 'grpc' ? { grpcStatus: result.grpcStatus } : {}),
      });
      continue;
    }
    for (const state of result.invoices) {
      const row = byInvoice.get(state.invoice);
      if (state.status !== 'finalized' || row === undefined || !open.has(row.id)) {
        continue;
      }
      open.delete(row.id);
      await settleConfirmed(deps, row);
    }
  }
}

/**
 * Check every watched Fond payout once.
 *
 * A stale `settling` row is recovered first (paid when its gift exists,
 * otherwise returned to `invoiced`). Spark invoices are polled next when
 * `operatorUrl` is set, then the recorded payment hashes of the rows still
 * unpaid, one `/verify` call each, stopping at a row's first settled hash.
 * Failed verify calls are counted and logged once per tick as
 * `fond.paid.verify_failed`. Store list failures propagate to the start
 * wrapper, which logs `fond.paid.tick.failed`; every other failure is contained
 * to its row or batch so the next tick retries.
 *
 * @param deps - Worker collaborators.
 * @returns Resolves when every watched row has been checked.
 * @throws Propagates a `listOpen` failure.
 */
export async function runFondPaidTick(deps: FondPaidWorkerDeps): Promise<void> {
  const cutoff = new Date(deps.now() - FOND_CLAIM_LEASE_MS);
  const candidates = await watchedRows(deps);
  const open = new Set<string>();
  const watched: FondPayoutRow[] = [];
  for (const row of candidates) {
    if (row.status === 'settling') {
      if (row.claimedAt === null || row.claimedAt >= cutoff) {
        continue;
      }
      const restored = await recoverStaleSettling(deps, row, cutoff);
      if (restored === undefined) {
        continue;
      }
      watched.push(restored);
      open.add(restored.id);
      continue;
    }
    watched.push(row);
    open.add(row.id);
  }
  if (deps.operatorUrl !== undefined) {
    await pollSpark(deps, deps.operatorUrl, watched, open);
  }
  let failures = 0;
  for (const row of watched) {
    if (!open.has(row.id) || row.paymentHash === null) {
      continue;
    }
    const outcome = await verifyLightningPayment(deps.lnurlServer, deps.fetchImpl, row.paymentHash);
    if (outcome === 'failed') {
      failures += 1;
    } else if (outcome === 'settled') {
      open.delete(row.id);
      await settleConfirmed(deps, row);
    }
  }
  if (failures > 0) {
    logEvent('fond.paid.verify_failed', { failures });
  }
}

/**
 * Start the worker: one tick now, then one every `intervalMs`.
 *
 * A tick does not start while the previous one is still running, so a slow
 * coordinator or LNURL call cannot stack requests. A rejecting tick logs
 * `fond.paid.tick.failed` with the error fields.
 *
 * @param deps - Worker collaborators.
 * @param intervalMs - Tick period (default {@link SPARK_WORKER_INTERVAL_MS}).
 * @returns Stop handle.
 */
export function startFondPaidWorker(
  deps: FondPaidWorkerDeps,
  intervalMs: number = SPARK_WORKER_INTERVAL_MS,
): { stop: () => void } {
  let running = false;
  const tick = (): void => {
    if (running) {
      return;
    }
    running = true;
    void runFondPaidTick(deps)
      .catch((error: unknown) => {
        logEvent('fond.paid.tick.failed', errorLogFields(error));
      })
      .finally(() => {
        running = false;
      });
  };
  tick();
  const timer = setInterval(tick, intervalMs);
  return {
    stop: () => {
      clearInterval(timer);
    },
  };
}
