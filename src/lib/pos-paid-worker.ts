/**
 * Background worker that marks point-of-sale charges paid.
 *
 * Every tick it lists the charges still watched (pending, or expired within
 * {@link POS_PAID_WATCH_MS}) and checks the invoices handed out for them:
 * the charge's Spark invoice through the Spark coordinator, and each recorded
 * BOLT11 payment hash through the LNURL server's LUD-21 `/verify`. The first
 * confirmation marks the charge paid; later ones are ignored by the store.
 * No zap receipt, gift, or message is written for a till payment.
 */

import type { LnurlServerConfig } from '@/lib/config';
import { errorLogFields, logEvent } from '@/lib/log';
import { LNURL_PAY_REQUEST_TIMEOUT_MS, callLnurlServer } from '@/lib/lnurl-server';
import type { FetchFn } from '@/lib/lnurlp';
import type { PosCharge } from '@/lib/pos-charge';
import type { PosStore, PosWatch } from '@/lib/pos-store';
import type { ShopPayments } from '@/lib/shop-payment';
import { startShopPaymentWorker } from '@/lib/shop-payment-worker';
import { SPARK_QUERY_LIMIT, querySparkInvoices } from '@/lib/spark-operator';
import { SPARK_WORKER_INTERVAL_MS } from '@/lib/spark-worker';

/** Charges that expired this recently are still polled. */
export const POS_PAID_WATCH_MS = 10 * 60_000;

/** Collaborators for {@link runPosPaidTick}. */
export interface PosPaidWorkerDeps {
  /** Point-of-sale charges and their recorded invoices. */
  store: PosStore;
  /** LNURL server that answers `/verify/:paymentHash`. */
  lnurlServer: LnurlServerConfig;
  /** Spark coordinator base URL; omitted when free in-app payments are off. */
  operatorUrl?: string;
  /** Fetch for the coordinator and the LNURL server (fake in tests). */
  fetchImpl: FetchFn;
  /** Clock in epoch milliseconds. */
  now: () => number;
  /**
   * Shop payments in USDT and USDC. With it, marking a charge paid also
   * settles the charge's shop payment in the same transaction, and
   * {@link startPosPaidWorker} starts the shop payment tick.
   */
  shop?: ShopPayments;
}

/**
 * Mark a watched charge paid; with the shop payment service, in one
 * transaction with its shop payment.
 *
 * @param deps - Worker collaborators.
 * @param charge - The watched charge.
 * @param settledHash - The settled BOLT11 payment hash, or `null` for the Spark invoice.
 */
async function markChargePaid(
  deps: PosPaidWorkerDeps,
  charge: PosCharge,
  settledHash: string | null,
): Promise<void> {
  if (deps.shop === undefined) {
    await deps.store.markPaid(charge.id, deps.now());
    return;
  }
  await deps.shop.chargePaid(charge, settledHash, deps.now());
}

/** Outcome of one LUD-21 verify call. */
export type VerifyOutcome = 'settled' | 'open' | 'failed';

/**
 * Ask the LNURL server whether one payment hash has settled (LUD-21
 * `/verify`). The charge watch and the shop payment settlement read share it.
 *
 * @param lnurlServer - LNURL server configuration.
 * @param fetchImpl - Fetch for the LNURL server.
 * @param paymentHash - BOLT11 payment hash (64 lower-case hex).
 * @param timeoutMs - Abort after this many milliseconds.
 * @returns `settled` when the body says `settled: true`, `open` for any
 *   other 200 JSON body, otherwise `failed`.
 */
export async function verifyLightningPayment(
  lnurlServer: LnurlServerConfig,
  fetchImpl: FetchFn,
  paymentHash: string,
  timeoutMs: number = LNURL_PAY_REQUEST_TIMEOUT_MS,
): Promise<VerifyOutcome> {
  const result = await callLnurlServer(lnurlServer, fetchImpl, {
    method: 'GET',
    segments: ['verify', paymentHash],
    timeoutMs,
  });
  if (!result.ok || result.status !== 200) {
    return 'failed';
  }
  try {
    const body = JSON.parse(result.body) as { settled?: unknown } | null;
    return body?.settled === true ? 'settled' : 'open';
  } catch {
    return 'failed';
  }
}

/**
 * Poll the Spark coordinator for every watched charge with a Spark invoice.
 *
 * Batches of {@link SPARK_QUERY_LIMIT}; a failed batch logs
 * `pos.spark.query_failed` and the next batch still runs. Only `finalized`
 * marks a charge paid.
 *
 * @param deps - Worker collaborators.
 * @param operatorUrl - Spark coordinator base URL.
 * @param watched - Watched charges.
 * @param open - Ids of charges not yet paid in this tick; paid ids are removed.
 */
async function pollSpark(
  deps: PosPaidWorkerDeps,
  operatorUrl: string,
  watched: readonly PosWatch[],
  open: Set<string>,
): Promise<void> {
  const byInvoice = new Map<string, string>();
  for (const entry of watched) {
    if (entry.charge.sparkInvoice !== null) {
      byInvoice.set(entry.charge.sparkInvoice, entry.charge.id);
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
      logEvent('pos.spark.query_failed', {
        reason: result.reason,
        ...(result.reason === 'grpc' ? { grpcStatus: result.grpcStatus } : {}),
      });
      continue;
    }
    for (const state of result.invoices) {
      const chargeId = byInvoice.get(state.invoice);
      if (state.status !== 'finalized' || chargeId === undefined || !open.has(chargeId)) {
        continue;
      }
      open.delete(chargeId);
      const entry = watched.find((candidate) => candidate.charge.id === chargeId);
      /* v8 ignore next 3 -- byInvoice holds only watched charges */
      if (entry === undefined) {
        continue;
      }
      await markChargePaid(deps, entry.charge, null);
    }
  }
}

/**
 * Check every watched charge once.
 *
 * Spark invoices are polled first (only when `operatorUrl` is set), then the
 * recorded payment hashes of the charges still unpaid, one `/verify` call
 * each, stopping at a charge's first settled hash. Failed verify calls are
 * counted and logged once per tick as `pos.verify.failed`.
 *
 * @param deps - Worker collaborators.
 * @returns Resolves when every watched charge has been checked.
 * @throws Propagates store failures.
 */
export async function runPosPaidTick(deps: PosPaidWorkerDeps): Promise<void> {
  const watched = await deps.store.listWatched(deps.now() - POS_PAID_WATCH_MS);
  const open = new Set(watched.map((entry) => entry.charge.id));
  if (deps.operatorUrl !== undefined) {
    await pollSpark(deps, deps.operatorUrl, watched, open);
  }
  let failures = 0;
  for (const entry of watched) {
    for (const paymentHash of entry.paymentHashes) {
      if (!open.has(entry.charge.id)) {
        break;
      }
      const outcome = await verifyLightningPayment(deps.lnurlServer, deps.fetchImpl, paymentHash);
      if (outcome === 'failed') {
        failures += 1;
      } else if (outcome === 'settled') {
        open.delete(entry.charge.id);
        await markChargePaid(deps, entry.charge, paymentHash);
      }
    }
  }
  if (failures > 0) {
    logEvent('pos.verify.failed', { failures });
  }
}

/**
 * Start the worker: one tick now, then one every `intervalMs`.
 *
 * A tick does not start while the previous one is still running. A rejecting
 * tick logs `pos.worker.tick.failed`. With {@link PosPaidWorkerDeps.shop}, a
 * second tick for the shop payment duties starts too
 * (`startShopPaymentWorker`), separate from this one, so a slow shop call
 * never delays a till confirmation.
 *
 * @param deps - Worker collaborators.
 * @param intervalMs - Tick period (default the Spark invoice worker's {@link SPARK_WORKER_INTERVAL_MS}).
 * @returns Stop handle.
 */
export function startPosPaidWorker(
  deps: PosPaidWorkerDeps,
  intervalMs: number = SPARK_WORKER_INTERVAL_MS,
): { stop: () => void } {
  let running = false;
  const tick = (): void => {
    if (running) {
      return;
    }
    running = true;
    void runPosPaidTick(deps)
      .catch((error: unknown) => {
        logEvent('pos.worker.tick.failed', errorLogFields(error));
      })
      .finally(() => {
        running = false;
      });
  };
  tick();
  const timer = setInterval(tick, intervalMs);
  const shopWorker = deps.shop === undefined ? null : startShopPaymentWorker(deps.shop);
  return {
    stop: () => {
      clearInterval(timer);
      shopWorker?.stop();
    },
  };
}
