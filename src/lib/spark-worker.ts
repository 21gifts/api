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
 *
 * The same tick watches the member Spark invoices of `POST /pay/:username/invoice`:
 * one reported `FINALIZED` gets the "You received N sats" push through
 * `notifyPaymentReceived`, keyed by the SHA-256 of the invoice string.
 *
 * A boot with a database but without free in-app payments does not run the
 * worker; {@link startMemberSparkInvoicePrune} still deletes the expired
 * member rows stored while the feature was on.
 */

import { createHash } from 'node:crypto';
import type { FreePaymentsConfig } from '@/lib/config';
import { errorLogFields, logEvent } from '@/lib/log';
import type { FetchFn } from '@/lib/lnurlp';
import type { MessageStore } from '@/lib/message-store';
import type { NostrPublisher } from '@/lib/nostr/publish';
import type { NostrEventFrame } from '@/lib/nostr/query';
import { buildZapReceipt, zapReceiptSecretKey } from '@/lib/nostr/zap-receipt';
import type { PaymentReceived, PaymentReceivedOutcome } from '@/lib/payment-received';
import type {
  MemberSparkInvoiceRow,
  SparkInvoiceRow,
  SparkInvoiceStore,
} from '@/lib/spark-invoice-store';
import { SPARK_QUERY_LIMIT, querySparkInvoices } from '@/lib/spark-operator';

/** Tick interval. */
export const SPARK_WORKER_INTERVAL_MS = 2_000;

/** Only Spark invoices issued this recently are polled. */
export const SPARK_INVOICE_WINDOW_MS = 60 * 60_000;

/** Prune interval of {@link startMemberSparkInvoicePrune}. */
export const MEMBER_SPARK_INVOICE_PRUNE_INTERVAL_MS = 60 * 60_000;

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
  /** The receive push of one paid member invoice (`notifyPaymentReceived` with its stores). */
  notifyPayment: (payment: PaymentReceived) => Promise<PaymentReceivedOutcome>;
  /** Clock in epoch milliseconds. */
  now: () => number;
}

/**
 * Turn one finalized Spark invoice into an ingested and published receipt.
 *
 * The row is settled when the ingest credited this receipt and it holds the
 * payment hash claim, or when another receipt owns the zap invoice's payment
 * hash (it was paid and credited some other way). Otherwise (for example the LNURL server was briefly unreachable,
 * or crediting failed after the claim) the row stays open and the next tick
 * ingests the same receipt again; its id is stable, so a claim it already
 * holds lets that retry complete the credit.
 * The receipt is published only in the first case, so a zap invoice already
 * paid over Lightning does not get a second receipt (a conversation gift that
 * already exists is reported indexed without a claim). Publishing is best effort:
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
  const ownsClaim = owner === built.event.id;
  if (owner === undefined || (ownsClaim && !credited)) {
    logEvent('spark.receipt.not_credited', { paymentHash: row.paymentHash });
    return;
  }
  if (ownsClaim && built.relays.length > 0) {
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
 * Push for one finalized member invoice, then mark it notified.
 *
 * The push goes through `notifyPaymentReceived` with no zap request and the
 * SHA-256 hex of the invoice string as its payment key, so the
 * once-per-payment claim holds across ticks and restarts. Every outcome marks
 * the row notified and logs `payment_received` with that outcome; a rejecting
 * call logs `payment_received.failed` and leaves the row open for the next tick.
 *
 * @param deps - Worker collaborators.
 * @param row - The open member row.
 */
async function notifyMemberRow(deps: SparkWorkerDeps, row: MemberSparkInvoiceRow): Promise<void> {
  let outcome: PaymentReceivedOutcome;
  try {
    outcome = await deps.notifyPayment({
      paymentHash: createHash('sha256').update(row.invoice, 'utf8').digest('hex'),
      userPubkey: row.receiverPubkey,
      amountSats: row.amountSats,
      zapRequest: null,
    });
  } catch (error) {
    logEvent('payment_received.failed', { kind: row.kind, ...errorLogFields(error) });
    return;
  }
  logEvent('payment_received', { outcome, kind: row.kind });
  await deps.store.markMemberNotified(row.invoice);
}

/**
 * Ask the coordinator about `rows` in batches of {@link SPARK_QUERY_LIMIT}
 * and hand each row reported `finalized` to `onFinalized`, once.
 *
 * A failed batch logs `spark.query.failed` and the next batch still runs.
 * `not_found`, `pending`, `returned`, `mismatched`, and unknown statuses are
 * skipped.
 *
 * @param deps - Worker collaborators.
 * @param rows - Rows to poll.
 * @param onFinalized - Handler of a finalized row and its transfer id.
 * @returns Resolves when every batch has been handled.
 */
async function pollFinalized<Row extends { invoice: string }>(
  deps: SparkWorkerDeps,
  rows: readonly Row[],
  onFinalized: (row: Row, transferId: string | null) => Promise<void>,
): Promise<void> {
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
      await onFinalized(row, state.transferId);
    }
  }
}

/**
 * Poll the coordinator once for every open Spark invoice in the window, then
 * for every open member invoice.
 *
 * Zap rows issued in the last {@link SPARK_INVOICE_WINDOW_MS} are settled
 * when `finalized`; a second receipt for the same payment hash is a no-op in
 * the ingest (the payment hash is claimed once). Member rows whose
 * `expiresAt` has passed are deleted first, so an unpaid member invoice is
 * never pushed for after its window; an open one reported `finalized` gets
 * one push. Rows reported in any other status stay open.
 *
 * @param deps - Worker collaborators.
 * @returns Resolves when every batch has been handled.
 * @throws Propagates store failures.
 */
export async function runSparkInvoiceTick(deps: SparkWorkerDeps): Promise<void> {
  const now = deps.now();
  const rows = await deps.store.listOpen(new Date(now - SPARK_INVOICE_WINDOW_MS));
  await pollFinalized(deps, rows, (row, transferId) => settleRow(deps, row, transferId));
  await deps.store.pruneMember(new Date(now));
  const members = await deps.store.listOpenMember(new Date(now));
  await pollFinalized(deps, members, (row) => notifyMemberRow(deps, row));
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

/**
 * Delete expired member Spark invoices now and then every `intervalMs`,
 * without asking the coordinator.
 *
 * The entry point starts it on a boot with a database whose Spark invoice
 * worker is off (free in-app payments or the LNURL server not configured), so
 * rows stored while the feature was on are still deleted once `expiresAt`
 * passes. A prune does not start while the previous one is still running. A
 * rejecting prune logs `spark.member_invoice.prune_failed`.
 *
 * @param deps - The store and the clock in epoch milliseconds.
 * @param intervalMs - Prune period (default {@link MEMBER_SPARK_INVOICE_PRUNE_INTERVAL_MS}).
 * @returns Stop handle.
 */
export function startMemberSparkInvoicePrune(
  deps: { store: Pick<SparkInvoiceStore, 'pruneMember'>; now: () => number },
  intervalMs: number = MEMBER_SPARK_INVOICE_PRUNE_INTERVAL_MS,
): { stop: () => void } {
  let running = false;
  const prune = (): void => {
    if (running) {
      return;
    }
    running = true;
    void deps.store
      .pruneMember(new Date(deps.now()))
      .catch((error: unknown) => {
        logEvent('spark.member_invoice.prune_failed', errorLogFields(error));
      })
      .finally(() => {
        running = false;
      });
  };
  prune();
  const timer = setInterval(prune, intervalMs);
  return {
    stop: () => {
      clearInterval(timer);
    },
  };
}
