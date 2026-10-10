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
import type { PosStore, PosWatch } from '@/lib/pos-store';
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
}

/** Outcome of one LUD-21 verify call. */
type VerifyOutcome = 'settled' | 'open' | 'failed';

/**
 * Ask the LNURL server whether one payment hash has settled.
 *
 * @param deps - Worker collaborators.
 * @param paymentHash - BOLT11 payment hash (64 lower-case hex).
 * @returns `settled` when the body says `settled: true`, `open` for any
 *   other 200 JSON body, otherwise `failed`.
 */
async function verifyPayment(deps: PosPaidWorkerDeps, paymentHash: string): Promise<VerifyOutcome> {
  const result = await callLnurlServer(deps.lnurlServer, deps.fetchImpl, {
    method: 'GET',
    segments: ['verify', paymentHash],
    timeoutMs: LNURL_PAY_REQUEST_TIMEOUT_MS,
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
      await deps.store.markPaid(chargeId, deps.now());
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
      const outcome = await verifyPayment(deps, paymentHash);
      if (outcome === 'failed') {
        failures += 1;
      } else if (outcome === 'settled') {
        open.delete(entry.charge.id);
        await deps.store.markPaid(entry.charge.id, deps.now());
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
 * tick logs `pos.worker.tick.failed`.
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
  return {
    stop: () => {
      clearInterval(timer);
    },
  };
}
