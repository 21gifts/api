/**
 * Background worker that confirms Spark-paid zap invoices.
 *
 * Every tick it asks the Spark coordinator about the open Spark invoices
 * issued in the last {@link SPARK_INVOICE_WINDOW_MS}. For each one reported
 * `FINALIZED` it signs a kind 9735 receipt for the zap invoice with the
 * receiver's receipt key and feeds it into the receipt ingest. Once that
 * receipt is credited it publishes it to the relays named in the zap request
 * and marks the row settled; a payment hash already owned by another receipt
 * settles the row without publishing.
 */

import type { FreePaymentsConfig } from '@/lib/config';
import { errorLogFields, logEvent } from '@/lib/log';
import type { FetchFn } from '@/lib/lnurlp';
import type { MessageStore } from '@/lib/message-store';
import type { NostrPublisher } from '@/lib/nostr/publish';
import type { NostrEventFrame } from '@/lib/nostr/query';
import { buildZapReceipt, zapReceiptSecretKey } from '@/lib/nostr/zap-receipt';
import type { SparkInvoiceRow, SparkInvoiceStore } from '@/lib/spark-invoice-store';
import { SPARK_QUERY_LIMIT, querySparkInvoices } from '@/lib/spark-operator';

/** Tick interval. */
export const SPARK_WORKER_INTERVAL_MS = 2_000;

/** Only Spark invoices issued this recently are polled. */
export const SPARK_INVOICE_WINDOW_MS = 60 * 60_000;

/** Per-relay timeout when publishing a receipt. */
const RECEIPT_PUBLISH_TIMEOUT_MS = 5_000;

/** Collaborators for {@link runSparkInvoiceTick}. */
export interface SparkWorkerDeps {
  /** Issued Spark invoices. */
  store: SparkInvoiceStore;
  /** Receipt key root and coordinator URL. */
  config: FreePaymentsConfig;
  /** Fetch for the coordinator (fake in tests). */
  fetchImpl: FetchFn;
  /** Relay publisher (fake in tests). */
  publisher: NostrPublisher;
  /** Existing receipt ingest for one event; `true` when that receipt is credited. */
  ingest: (event: NostrEventFrame) => Promise<boolean>;
  /** Payment hash claims written by the receipt ingest. */
  claims: Pick<MessageStore, 'zapPaymentReceiptId'>;
  /** Clock in epoch milliseconds. */
  now: () => number;
}

/**
 * Turn one finalized Spark invoice into an ingested and published receipt.
 *
 * The row is settled when the ingest credited this receipt, or when another
 * receipt owns the zap invoice's payment hash (it was paid and credited some
 * other way). Otherwise (for example the LNURL server was briefly unreachable,
 * or crediting failed after the claim) the row stays open and the next tick
 * ingests the same receipt again; its id is stable, so a claim it already
 * holds lets that retry complete the credit.
 * The receipt is published only when it was credited and holds the payment
 * hash claim, so a zap invoice already paid over Lightning does not get a
 * second receipt (a conversation gift that already exists is reported indexed
 * without a claim). Publishing is best effort:
 * when no relay accepts the receipt (or the publisher throws) it logs
 * `spark.receipt.publish_failed`, and the row is still settled because the
 * credit is already done.
 *
 * @param deps - Worker collaborators.
 * @param row - The open row.
 * @param transferId - Paying transfer id, or `null`.
 */
async function settleRow(
  deps: SparkWorkerDeps,
  row: SparkInvoiceRow,
  transferId: string | null,
): Promise<void> {
  const built = buildZapReceipt({
    secretKey: zapReceiptSecretKey(deps.config.zapNsec, row.receiverPubkey),
    bolt11: row.bolt11,
    zapRequestJson: row.zapRequest,
  });
  if (built === null) {
    logEvent('spark.receipt.invalid', { paymentHash: row.paymentHash });
    return;
  }
  const credited = await deps.ingest(built.event);
  const owner = await deps.claims.zapPaymentReceiptId(row.paymentHash);
  if (!credited && (owner === undefined || owner === built.event.id)) {
    logEvent('spark.receipt.not_credited', { paymentHash: row.paymentHash });
    return;
  }
  if (credited && owner === built.event.id && built.relays.length > 0) {
    let accepted = false;
    try {
      const acks = await deps.publisher.publish(
        built.event as unknown as Record<string, unknown>,
        built.relays,
        RECEIPT_PUBLISH_TIMEOUT_MS,
      );
      accepted = acks.some((ack) => ack.ok);
    } catch {
      accepted = false;
    }
    if (!accepted) {
      logEvent('spark.receipt.publish_failed', { paymentHash: row.paymentHash });
    }
  }
  if (await deps.store.markSettled(row.paymentHash, transferId, built.event.id)) {
    logEvent('spark.invoice.settled', { paymentHash: row.paymentHash });
  }
}

/**
 * Poll the coordinator once for every open Spark invoice in the window.
 *
 * Rows are sent in batches of {@link SPARK_QUERY_LIMIT}. A failed batch logs
 * `spark.query.failed` and the next batch still runs. Only `finalized`
 * settles; `not_found`, `pending`, `returned`, `mismatched`, and unknown
 * statuses leave the row open. A second receipt for the same payment hash is a
 * no-op in the ingest (the payment hash is claimed once).
 *
 * @param deps - Worker collaborators.
 * @returns Resolves when every batch has been handled.
 * @throws Propagates store failures.
 */
export async function runSparkInvoiceTick(deps: SparkWorkerDeps): Promise<void> {
  const rows = await deps.store.listOpen(new Date(deps.now() - SPARK_INVOICE_WINDOW_MS));
  for (let i = 0; i < rows.length; i += SPARK_QUERY_LIMIT) {
    const batch = rows.slice(i, i + SPARK_QUERY_LIMIT);
    const result = await querySparkInvoices(
      deps.config.operatorUrl,
      deps.fetchImpl,
      batch.map((row) => row.invoice),
    );
    if (!result.ok) {
      logEvent('spark.query.failed', {
        reason: result.reason,
        ...(result.reason === 'grpc' ? { grpcStatus: result.grpcStatus } : {}),
      });
      continue;
    }
    const byInvoice = new Map(batch.map((row) => [row.invoice, row]));
    for (const state of result.invoices) {
      const row = byInvoice.get(state.invoice);
      if (state.status !== 'finalized' || row === undefined) {
        continue;
      }
      byInvoice.delete(state.invoice);
      await settleRow(deps, row, state.transferId);
    }
  }
}

/**
 * Start the worker: one tick now, then one every `intervalMs`.
 *
 * A tick does not start while the previous one is still running. A rejecting
 * tick logs `spark.worker.tick.failed`.
 *
 * @param deps - Worker collaborators.
 * @param intervalMs - Tick period (default {@link SPARK_WORKER_INTERVAL_MS}).
 * @returns Stop handle.
 */
export function startSparkInvoiceWorker(
  deps: SparkWorkerDeps,
  intervalMs: number = SPARK_WORKER_INTERVAL_MS,
): { stop: () => void } {
  let running = false;
  const tick = (): void => {
    if (running) {
      return;
    }
    running = true;
    void runSparkInvoiceTick(deps)
      .catch((error: unknown) => {
        logEvent('spark.worker.tick.failed', errorLogFields(error));
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
