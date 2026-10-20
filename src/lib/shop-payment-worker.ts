/**
 * Watcher of shop stablecoin payments (`docs/shop-stablecoin-payment.md`,
 * Watcher): a tick every 2 s, separate from the charge watch, that runs the
 * eight duties in order. Each duty has its own call budget per tick, each
 * call times out after {@link SHOP_WORKER_CALL_TIMEOUT_MS}, and each duty
 * takes its rows oldest next-try first. Duty 3 (orders) reads on odd ticks,
 * duty 8 (order status) on even ticks.
 */

import type { FetchFn } from '@/lib/lnurlp';
import { errorLogFields, logEvent } from '@/lib/log';
import {
  ORCHESTRA_FINAL_STATUSES,
  ORCHESTRA_HISTORY_PAGE_SIZE,
  type OrchestraOrder,
} from '@/lib/orchestra';
import { verifyLightningPayment } from '@/lib/pos-paid-worker';
import {
  SHOP_FIRST_STATUS_MS,
  SHOP_HISTORY_INTERVAL_MS,
  SHOP_ORDER_WATCH_MS,
  SHOP_UNRESOLVED_LIMIT_MS,
  lockPaymentForProofs,
  shopMethodByName,
  type ShopPayments,
} from '@/lib/shop-payment';
import type {
  ShopOffer,
  ShopPayment,
  ShopPaymentPatch,
  ShopProof,
  ShopProofLookup,
  ShopProofPatch,
  ShopTx,
} from '@/lib/shop-payment-store';
import {
  applyProofOrder,
  readProofReceipt,
  sendHexProof,
  shopProofContext,
  storeProof,
  submitProofAttempt,
  verifyTxProof,
} from '@/lib/shop-proof';
import { SPARK_WORKER_INTERVAL_MS } from '@/lib/spark-worker';

/** Tick period of the watcher: the Spark invoice worker's {@link SPARK_WORKER_INTERVAL_MS}. */
export const SHOP_WORKER_INTERVAL_MS = SPARK_WORKER_INTERVAL_MS;
/** Timeout of every external call of a duty. */
export const SHOP_WORKER_CALL_TIMEOUT_MS = 5_000;

/** Settlement reads per tick, in parallel. */
const SETTLE_PER_TICK = 8;
/** External RPC calls of the lookups duty per tick. */
const LOOKUP_CALLS_PER_TICK = 4;
/** Most RPC calls one lookup row makes: the transaction receipt, then the user-operation receipt. */
const LOOKUP_ROW_CALLS = 2;
/** External RPC calls of the receipts duty per tick. */
const RECEIPT_CALLS_PER_TICK = 4;
/** Submits per tick. */
const SUBMITS_PER_TICK = 1;
/** Rows the stuck duty marks per tick (no external call). */
const STUCK_PER_TICK = 100;
/** Status rows one even tick may look at to find the one row that needs a read. */
const STATUS_ROWS_PER_TICK = 10;
/** A lookup row is read for this long, then expires. */
const LOOKUP_LIFETIME_MS = 60 * 60_000;
/** Delays after the first and second lookup (reads at 10 s, 30 s, 60 s), then every 2 min. */
const LOOKUP_DELAYS_MS: readonly number[] = [20_000, 30_000];
/** Lookup and receipt cadence after the first reads. */
const SLOW_READ_MS = 2 * 60_000;
/** Delays after the first and second watcher submit (10 s, 30 s, 60 s), then every 5 min. */
const SUBMIT_DELAYS_MS: readonly number[] = [20_000, 30_000];
/** Submit cadence after the first three. */
const SUBMIT_INTERVAL_MS = 5 * 60_000;
/**
 * The orders duty's cadence while only the successor wait keeps a payment
 * whose order watch has ended (Watcher, duty 3).
 */
export const SHOP_SUCCESSOR_HISTORY_INTERVAL_MS = 60_000;
/**
 * How long the orders duty waits for the successor of a replaced order
 * (`successor_wait_until`, set by the order-status duty; Calls › Status).
 */
export const SHOP_SUCCESSOR_WAIT_MS = 24 * 60 * 60_000;
/** Status reads every 10 s for this long after the order was found, then every 60 s. */
const STATUS_FAST_WINDOW_MS = 10 * 60_000;
/** Slow status cadence. */
const STATUS_SLOW_MS = 60_000;
/** An `accepted` payment older than this logs `shop.alert.accepted_long` once. */
const ACCEPTED_LONG_MS = 60 * 60_000;

/** Payments already reported as `accepted` for long, per service (once per process). */
const acceptedLongSeen = new WeakMap<ShopPayments, Set<string>>();

/** External calls a duty may still make this tick, and the fetch that counts them. */
interface CallBudget {
  /** Calls left; every call through `fetchImpl` takes one. */
  left: number;
  /** The service's fetch, counting each call against `left`. */
  fetchImpl: FetchFn;
}

/**
 * A per-tick call budget of one duty.
 *
 * @param shop - Service (its fetch).
 * @param calls - Calls the duty may make this tick.
 * @returns The budget.
 */
function callBudget(shop: ShopPayments, calls: number): CallBudget {
  const budget: CallBudget = {
    left: calls,
    fetchImpl: (input, init) => {
      budget.left -= 1;
      return shop.deps.fetchImpl(input, init);
    },
  };
  return budget;
}

/**
 * Patch the schedule of one proof (no result change) under its payment's
 * `shop_payment` row lock; no account row is locked.
 *
 * @param shop - Service.
 * @param proof - The proof.
 * @param patch - Columns to write.
 */
async function patchProof(
  shop: ShopPayments,
  proof: ShopProof,
  patch: ShopProofPatch,
): Promise<void> {
  await shop.store.transaction(async (tx) => {
    await tx.lockPayment(proof.paymentId);
    await tx.updateProof(proof.id, {}, patch);
  });
}

/**
 * Duty 1: end every `open` payment whose window has passed.
 *
 * @param shop - Service.
 * @param nowMs - Clock.
 */
async function endLapsedWindows(shop: ShopPayments, nowMs: number): Promise<void> {
  const ended = await shop.store.transaction((tx) => tx.endLapsedWindows(nowMs));
  for (const payment of ended) {
    logEvent('shop.payment.ended', { paymentId: payment.id, reason: 'window' });
  }
}

/**
 * Log `shop.alert.accepted_long` once per payment per process.
 *
 * @param shop - Service.
 * @param payments - Payments read this tick.
 * @param nowMs - Clock.
 */
function alertAcceptedLong(
  shop: ShopPayments,
  payments: readonly ShopPayment[],
  nowMs: number,
): void {
  let seen = acceptedLongSeen.get(shop);
  if (seen === undefined) {
    seen = new Set();
    acceptedLongSeen.set(shop, seen);
  }
  for (const payment of payments) {
    if (
      payment.status === 'accepted' &&
      payment.acceptedAt !== null &&
      nowMs - payment.acceptedAt.getTime() > ACCEPTED_LONG_MS &&
      !seen.has(payment.id)
    ) {
      seen.add(payment.id);
      logEvent('shop.alert.accepted_long', { paymentId: payment.id });
    }
  }
}

/**
 * Duty 2: settlement reads, up to 8 in parallel, `accepted` and
 * charge-backed payments first (the store's order).
 *
 * @param shop - Service.
 * @param nowMs - Clock.
 */
async function settle(shop: ShopPayments, nowMs: number): Promise<void> {
  const due = await shop.store.transaction((tx) =>
    tx.duePayments('settle', nowMs, SETTLE_PER_TICK),
  );
  alertAcceptedLong(shop, due, nowMs);
  const { lnurlServer, fetchImpl } = shop.deps;
  await Promise.all(
    due.map(async (payment) => {
      const outcome = await verifyLightningPayment(
        lnurlServer,
        fetchImpl,
        payment.paymentHash,
        SHOP_WORKER_CALL_TIMEOUT_MS,
      );
      const settled = outcome === 'settled' ? true : outcome === 'open' ? false : null;
      await shop.applySettlement(payment.id, settled, shop.deps.now());
    }),
  );
}

/**
 * Normalise an order's `sourceTxHash`.
 *
 * @param value - Raw hash.
 * @returns Lowercase `0x` + 64 hex, or `null`.
 */
function normalizeTxHash(value: string): string | null {
  const lower = value.toLowerCase();
  return /^0x[0-9a-f]{64}$/.test(lower) ? lower : null;
}

/**
 * One order of a history page: an order of one of the payment's offers that
 * carries a `sourceTxHash` is stored through Storing and submitting as a
 * `detected` proof with its order, unless a proof already holds it as
 * `provider_order` (`storeProof` answers from that row). An order whose
 * `recoveredFromOperationId` a proof holds is stored the same way, as its own
 * proof, so every row keeps its own transaction and order. An order without
 * `sourceTxHash` yet stores nothing and is read again.
 *
 * @param shop - Service.
 * @param payment - The payment read.
 * @param offers - Every offer of the payment.
 * @param order - The order.
 */
async function handleHistoryOrder(
  shop: ShopPayments,
  payment: ShopPayment,
  offers: readonly ShopOffer[],
  order: OrchestraOrder,
): Promise<void> {
  const offer = offers.find((row) => row.providerRef === order.quoteId);
  if (offer === undefined || order.sourceTxHash === null) {
    return;
  }
  const txHash = normalizeTxHash(order.sourceTxHash);
  if (txHash === null) {
    return;
  }
  await storeProof(shop, {
    offer,
    paymentId: payment.id,
    source: 'detected',
    txHash,
    logIndex: null,
    userOpHash: null,
    rawHex: null,
    transferAmount: null,
    order: { orderId: order.id, status: order.status },
  });
}

/** A proof whose replaced order waits for its successor. */
interface SuccessorWait {
  /** The proof of the replaced order. */
  proof: ShopProof;
  /** Its (replaced) order. */
  orderId: string;
  /** The successor order no proof holds yet. */
  successorId: string;
}

/**
 * The proof that waits for a successor: it holds a `superseded_by_order`
 * that no proof of the payment holds as `provider_order`.
 *
 * @param proofs - Every proof of the payment.
 * @returns The first such proof in the given order, or `null`.
 */
function waitingForSuccessor(proofs: readonly ShopProof[]): SuccessorWait | null {
  for (const proof of proofs) {
    const successorId = proof.supersededByOrder;
    if (
      successorId !== null &&
      proof.providerOrder !== null &&
      !proofs.some((other) => other.providerOrder === successorId)
    ) {
      return { proof, orderId: proof.providerOrder, successorId };
    }
  }
  return null;
}

/**
 * Duty 3 (odd ticks): one history page of the payment whose
 * `next_history_at` is due. A failed read is retried at the cadence and
 * keeps the offset, also after the order watch ended; a budget refusal waits
 * for the next odd tick. Once the order watch of the payment's last offer
 * with an issued detail has ended, the first successful short page decides
 * `next_history_at` under the payment row and its proof rows
 * (`lockPaymentForProofs`): while some proof waits for a successor (its
 * `superseded_by_order` is held by no proof) and `successor_wait_until` has
 * not passed, the payment is read again after
 * {@link SHOP_SUCCESSOR_HISTORY_INTERVAL_MS}; when that wait has passed, the
 * duty logs `shop.alert.successor_missing` and clears `next_history_at` and
 * `successor_wait_until` together; otherwise it clears `next_history_at`.
 * Paid and closed payments are read the same way.
 *
 * @param shop - Service.
 * @param nowMs - Clock.
 */
async function readOrders(shop: ShopPayments, nowMs: number): Promise<void> {
  const { orchestra } = shop.deps;
  if (orchestra === null) {
    return;
  }
  const loaded = await shop.store.transaction(async (tx) => {
    const [payment] = await tx.duePayments('history', nowMs, 1);
    if (payment === undefined) {
      return null;
    }
    const offers: ShopOffer[] = [];
    for (const quote of await tx.quotesOf(payment.id)) {
      offers.push(...(await tx.offersOf(quote.id)));
    }
    return { payment, offers };
  });
  if (loaded === null) {
    return;
  }
  const { payment, offers } = loaded;
  const page = await orchestra.history(
    payment.bolt11,
    payment.historyOffset,
    SHOP_WORKER_CALL_TIMEOUT_MS,
    { paymentId: payment.id },
  );
  if (!page.ok && page.reason === 'budget') {
    return;
  }
  if (page.ok) {
    for (const order of page.orders) {
      await handleHistoryOrder(shop, payment, offers, order);
    }
  }
  const afterMs = shop.deps.now();
  const watchEndMs = Math.max(
    Number.NEGATIVE_INFINITY,
    ...offers
      .filter((offer) => offer.detailIssuedAt !== null)
      .map((offer) => offer.expiresAt.getTime() + SHOP_ORDER_WATCH_MS),
  );
  const full = page.ok && page.full;
  const historyOffset = full
    ? payment.historyOffset + ORCHESTRA_HISTORY_PAGE_SIZE
    : page.ok
      ? 0
      : payment.historyOffset;
  // Only a successful short page ends the watch: a failed read changes nothing.
  const watchEnded = page.ok && !full && watchEndMs <= afterMs;
  await shop.store.transaction(async (tx) => {
    const locked = await lockPaymentForProofs(tx, payment.id);
    /* v8 ignore next 3 -- no path deletes a payment */
    if (locked === null) {
      return;
    }
    const write = (patch: ShopPaymentPatch): Promise<unknown> =>
      tx.updatePayment(payment.id, {}, { historyOffset, ...patch });
    if (!watchEnded) {
      await write({ nextHistoryAt: new Date(afterMs + SHOP_HISTORY_INTERVAL_MS) });
      return;
    }
    const waiting = waitingForSuccessor(locked.proofs);
    const waitUntil = locked.payment.successorWaitUntil;
    if (waiting === null || waitUntil === null) {
      await write({ nextHistoryAt: null });
      return;
    }
    if (waitUntil.getTime() > afterMs) {
      await write({ nextHistoryAt: new Date(afterMs + SHOP_SUCCESSOR_HISTORY_INTERVAL_MS) });
      return;
    }
    await write({ nextHistoryAt: null, successorWaitUntil: null });
    const offer = offers.find((row) => row.id === waiting.proof.offerId);
    logEvent('shop.alert.successor_missing', {
      paymentId: payment.id,
      proofId: waiting.proof.id,
      offerId: waiting.proof.offerId,
      /* v8 ignore next -- a proof's offer is one of the payment's offers read before the page */
      ...(offer === undefined ? {} : { quoteId: offer.quoteId, providerRef: offer.providerRef }),
      orderId: waiting.orderId,
      successorOrderId: waiting.successorId,
    });
  });
}

/**
 * Next lookup time after a lookup that found nothing.
 *
 * @param tries - Lookups done, including this one.
 * @param nowMs - Clock.
 * @returns The next try.
 */
function nextLookupAt(tries: number, nowMs: number): Date {
  return new Date(nowMs + (LOOKUP_DELAYS_MS[tries - 1] ?? SLOW_READ_MS));
}

/**
 * One lookup row: expire it after an hour, otherwise run the `tx`
 * verification; a found receipt stores the proof through the shared step.
 *
 * @param shop - Service.
 * @param row - Lookup row.
 * @param nowMs - Clock.
 * @param fetchImpl - Fetch that counts the duty's calls.
 */
async function lookUp(
  shop: ShopPayments,
  row: ShopProofLookup,
  nowMs: number,
  fetchImpl: FetchFn,
): Promise<void> {
  const context = await shopProofContext(shop, row.quoteId);
  const done = (): Promise<unknown> =>
    shop.store.transaction((tx) => tx.updateLookup(row.id, { doneAt: new Date(shop.deps.now()) }));
  /* v8 ignore next 4 -- a lookup's quote is a foreign key */
  if (context === null) {
    await done();
    return;
  }
  if (nowMs - row.createdAt.getTime() >= LOOKUP_LIFETIME_MS) {
    await done();
    logEvent('shop.proof.lookup_expired', {
      paymentId: context.payment.id,
      quoteId: row.quoteId,
    });
    return;
  }
  const method = shopMethodByName(row.method);
  const url = shop.deps.config?.evmRpc.get(row.chainId);
  const tries = row.tries + 1;
  if (method === undefined || url === undefined) {
    await shop.store.transaction((tx) =>
      tx.updateLookup(row.id, { tries, nextTryAt: nextLookupAt(tries, nowMs) }),
    );
    return;
  }
  const verified = await verifyTxProof(shop, {
    quoteOffers: context.offers,
    method,
    asset: row.asset,
    url,
    hash: row.hash,
    deadlineMs: Number.POSITIVE_INFINITY,
    callLimitMs: SHOP_WORKER_CALL_TIMEOUT_MS,
    fetchImpl,
  });
  if (verified.kind === 'not_found') {
    await shop.store.transaction((tx) =>
      tx.updateLookup(row.id, { tries, nextTryAt: nextLookupAt(tries, shop.deps.now()) }),
    );
    return;
  }
  if (verified.kind === 'found') {
    await storeProof(shop, {
      offer: verified.offer,
      paymentId: context.payment.id,
      source: 'tx',
      txHash: verified.txHash,
      logIndex: verified.logIndex,
      userOpHash: verified.userOpHash,
      rawHex: null,
      transferAmount: verified.transferAmount,
      order: null,
    });
  }
  await shop.store.transaction((tx) =>
    tx.updateLookup(row.id, { tries, doneAt: new Date(shop.deps.now()) }),
  );
}

/**
 * Duty 4: lookup rows that are not done, within 4 RPC calls per tick. A row
 * is taken only while the calls left cover its most calls, so the duty
 * never passes its budget; the rest waits for the next tick.
 *
 * @param shop - Service.
 * @param nowMs - Clock.
 */
async function lookups(shop: ShopPayments, nowMs: number): Promise<void> {
  const budget = callBudget(shop, LOOKUP_CALLS_PER_TICK);
  const rows = await shop.store.transaction((tx) => tx.dueLookups(nowMs, LOOKUP_CALLS_PER_TICK));
  for (const row of rows) {
    if (budget.left < LOOKUP_ROW_CALLS) {
      return;
    }
    await lookUp(shop, row, nowMs, budget.fetchImpl);
  }
}

/**
 * One receipt row: send a `hex` transaction that was never sent, otherwise
 * read the receipt. A receipt fills the log index and value (and a `hex`
 * proof that may be submitted gets `next_submit_at` now) or refuses a failed
 * `hex` transaction. A `hex` transaction without a receipt is sent again and
 * read again after 2 min while it is unresolved, however long the node does
 * not know it, so a transaction mined late is still submitted. Reading stops
 * at `give_up_at` (24 h after the proof was stored, or after an operator
 * retry moved it ahead; the stuck duty then marks an unresolved proof
 * `stuck`), once the log index is filled, and for a `hex` proof once it has a
 * result or an order. A `detected` proof is read for at most 24 h: its
 * `give_up_at`, which is never moved.
 *
 * @param shop - Service.
 * @param proof - Proof with a due `next_receipt_at`.
 * @param nowMs - Clock.
 * @param fetchImpl - Fetch that counts the duty's calls.
 */
async function readReceipt(
  shop: ShopPayments,
  proof: ShopProof,
  nowMs: number,
  fetchImpl: FetchFn,
): Promise<void> {
  const later: ShopProofPatch = { nextReceiptAt: new Date(nowMs + SLOW_READ_MS) };
  const url = shop.deps.config?.evmRpc.get(proof.chainId);
  const hexResolved =
    proof.source === 'hex' && (proof.result !== null || proof.providerOrder !== null);
  if (nowMs >= proof.giveUpAt.getTime() || proof.logIndex !== null || hexResolved) {
    await patchProof(shop, proof, { nextReceiptAt: null });
    return;
  }
  if (url === undefined) {
    await patchProof(shop, proof, later);
    return;
  }
  if (proof.source === 'hex' && proof.sentAt === null) {
    const outcome = await sendHexProof(shop, proof, url, SHOP_WORKER_CALL_TIMEOUT_MS, fetchImpl);
    if (outcome !== 'sent') {
      await patchProof(shop, proof, outcome === 'retry' ? later : { nextReceiptAt: null });
    }
    return;
  }
  const outcome = await readProofReceipt(shop, proof, url, SHOP_WORKER_CALL_TIMEOUT_MS, fetchImpl);
  if (outcome !== 'pending' && outcome !== 'error') {
    await patchProof(shop, proof, { nextReceiptAt: null });
    return;
  }
  if (
    outcome === 'pending' &&
    proof.source === 'hex' &&
    (await sendHexProof(shop, proof, url, SHOP_WORKER_CALL_TIMEOUT_MS, fetchImpl)) === 'rejected'
  ) {
    await patchProof(shop, proof, { nextReceiptAt: null });
    return;
  }
  await patchProof(shop, proof, later);
}

/**
 * Most RPC calls one receipt row makes: a `detected` proof only reads its
 * receipt; a `hex` proof never sent makes a send and its hash check; a sent
 * one reads its receipt, then resends with a hash check.
 *
 * @param proof - Receipt row.
 * @returns The calls to keep free before the row is taken.
 */
function receiptRowCalls(proof: ShopProof): number {
  if (proof.source !== 'hex') {
    return 1;
  }
  return proof.sentAt === null ? 2 : 3;
}

/**
 * Duty 5: `hex` proofs not yet mined or sent and `detected` proofs without a
 * log index, within 4 RPC calls per tick. A row is taken only while the
 * calls left cover its most calls, so the duty never passes its budget; the
 * rest waits for the next tick.
 *
 * @param shop - Service.
 * @param nowMs - Clock.
 */
async function receipts(shop: ShopPayments, nowMs: number): Promise<void> {
  const budget = callBudget(shop, RECEIPT_CALLS_PER_TICK);
  const rows = await shop.store.transaction((tx) =>
    tx.dueProofs('receipt', nowMs, RECEIPT_CALLS_PER_TICK),
  );
  for (const row of rows) {
    if (budget.left < receiptRowCalls(row)) {
      return;
    }
    await readReceipt(shop, row, nowMs, budget.fetchImpl);
  }
}

/**
 * Duty 6: one watcher submit of an unresolved proof (after 10 s, 30 s, and
 * 60 s, then every 5 min). A submit the budget or the slot did not allow
 * waits for the next tick.
 *
 * @param shop - Service.
 * @param nowMs - Clock.
 */
async function submits(shop: ShopPayments, nowMs: number): Promise<void> {
  if (shop.deps.orchestra === null) {
    return;
  }
  const rows = await shop.store.transaction((tx) =>
    tx.dueProofs('submit', nowMs, SUBMITS_PER_TICK),
  );
  for (const row of rows) {
    const attempt = await submitProofAttempt(
      shop,
      row.id,
      'watcher',
      shop.deps.now() + SHOP_WORKER_CALL_TIMEOUT_MS,
    );
    const proof = attempt.proof;
    if (!attempt.sent || proof === null) {
      continue;
    }
    const tries = row.tries + 1;
    const unresolved =
      proof.result === null && proof.providerOrder === null && !proof.submitStopped;
    const afterMs = shop.deps.now();
    await patchProof(shop, proof, {
      tries,
      nextSubmitAt: unresolved
        ? new Date(afterMs + (SUBMIT_DELAYS_MS[tries - 1] ?? SUBMIT_INTERVAL_MS))
        : null,
    });
  }
}

/**
 * Duty 7: unresolved proofs past `give_up_at` become `stuck` and log
 * `shop.alert.proof_stuck`. No external call.
 *
 * @param shop - Service.
 * @param nowMs - Clock.
 */
async function markStuck(shop: ShopPayments, nowMs: number): Promise<void> {
  const rows = await shop.store.transaction((tx) => tx.dueProofs('stuck', nowMs, STUCK_PER_TICK));
  for (const row of rows) {
    const stuck = await shop.store.transaction(async (tx) => {
      await lockPaymentForProofs(tx, row.paymentId);
      const current = await tx.getProof(row.id);
      if (current === null || current.providerOrder !== null || current.submitStopped) {
        return null;
      }
      const updated = await tx.updateProof(
        row.id,
        { results: [null] },
        { result: 'stuck', resolvedAt: new Date(nowMs), nextSubmitAt: null },
      );
      /* v8 ignore next -- a result change clashes with no unique index except accepted */
      return updated === 'conflict' ? null : updated;
    });
    if (stuck !== null) {
      logEvent('shop.alert.proof_stuck', {
        paymentId: stuck.paymentId,
        proofId: stuck.id,
        offerId: stuck.offerId,
      });
    }
  }
}

/**
 * Next status read of an order that is not final: every 10 s for 10 minutes
 * after it was found, then every 60 s.
 *
 * @param proof - Proof with an order.
 * @param nowMs - Clock.
 * @returns The next read.
 */
function nextStatusAt(proof: ShopProof, nowMs: number): Date {
  const foundMs = (proof.orderFoundAt ?? proof.createdAt).getTime();
  return new Date(
    nowMs + (nowMs - foundMs < STATUS_FAST_WINDOW_MS ? SHOP_FIRST_STATUS_MS : STATUS_SLOW_MS),
  );
}

/**
 * The order-status duty's step for a replaced order (Calls › Status): an
 * `unfulfilled` status with `supersededByOperationId`. The proof keeps its
 * order with that status (held, or still `accepted`), the duty stops for it
 * (`next_status_at` cleared, no `shop.alert.order_stuck`), the successor's id
 * becomes its `superseded_by_order`, and the payment's
 * `successor_wait_until` moves 24 h ahead when it is empty or earlier and its
 * `next_history_at` is set to now when it is empty, so the orders duty
 * stores the successor as its own proof. The caller holds the payment row
 * and its proof rows.
 *
 * @param tx - Transaction.
 * @param payment - The payment as locked.
 * @param proof - The proof whose order was replaced.
 * @param orderId - Its order id.
 * @param successorId - `supersededByOperationId`.
 * @param nowMs - Clock.
 */
async function stopReplacedOrder(
  tx: ShopTx,
  payment: ShopPayment,
  proof: ShopProof,
  orderId: string,
  successorId: string,
  nowMs: number,
): Promise<void> {
  const after = await applyProofOrder(tx, proof, { orderId, status: 'unfulfilled' }, nowMs);
  await tx.updateProof(after.id, {}, { nextStatusAt: null, supersededByOrder: successorId });
  const waitUntilMs = nowMs + SHOP_SUCCESSOR_WAIT_MS;
  const current = payment.successorWaitUntil;
  await tx.updatePayment(
    payment.id,
    {},
    {
      successorWaitUntil:
        current !== null && current.getTime() >= waitUntilMs ? current : new Date(waitUntilMs),
      nextHistoryAt: payment.nextHistoryAt ?? new Date(nowMs),
    },
  );
}

/**
 * One status read of a proof's order, applied under the payment row and its
 * proof rows (`lockPaymentForProofs`). An `unfulfilled` status with a
 * `supersededByOperationId` of another order is a replaced order
 * ({@link stopReplacedOrder}); every other status, a superseding id with
 * another status included, is applied as a status.
 *
 * @param shop - Service.
 * @param proof - Proof with an order that is not final.
 * @param orderId - Its order id.
 */
async function readStatus(shop: ShopPayments, proof: ShopProof, orderId: string): Promise<void> {
  const { orchestra } = shop.deps;
  /* v8 ignore next 3 -- the duty runs only with an Orchestra client */
  if (orchestra === null) {
    return;
  }
  const read = await orchestra.status(orderId, SHOP_WORKER_CALL_TIMEOUT_MS, {
    paymentId: proof.paymentId,
    proofId: proof.id,
    offerId: proof.offerId,
    orderId,
  });
  if (!read.ok && read.reason === 'budget') {
    return;
  }
  await shop.store.transaction(async (tx) => {
    const locked = await lockPaymentForProofs(tx, proof.paymentId);
    const nowMs = shop.deps.now();
    const current = await tx.getProof(proof.id);
    if (locked === null || current === null || current.providerOrder !== orderId) {
      return;
    }
    const order = read.ok ? read.order : null;
    if (order === null) {
      await tx.updateProof(current.id, {}, { nextStatusAt: nextStatusAt(current, nowMs) });
      return;
    }
    const successor = order.supersededByOperationId;
    if (order.status === 'unfulfilled' && successor !== null && successor !== orderId) {
      await stopReplacedOrder(tx, locked.payment, current, orderId, successor, nowMs);
      return;
    }
    const after = await applyProofOrder(tx, current, { orderId, status: order.status }, nowMs);
    if (!ORCHESTRA_FINAL_STATUSES.has(order.status)) {
      await tx.updateProof(after.id, {}, { nextStatusAt: nextStatusAt(after, nowMs) });
    }
  });
}

/**
 * Duty 8 (even ticks): one status read of an order that is not final. Rows
 * whose order is already final stop being read, and rows read for 24 h since
 * their order was found stop and log `shop.alert.order_stuck`; neither
 * costs a call.
 *
 * @param shop - Service.
 * @param nowMs - Clock.
 */
async function readStatuses(shop: ShopPayments, nowMs: number): Promise<void> {
  if (shop.deps.orchestra === null) {
    return;
  }
  const rows = await shop.store.transaction((tx) =>
    tx.dueProofs('status', nowMs, STATUS_ROWS_PER_TICK),
  );
  for (const row of rows) {
    const orderId = row.providerOrder;
    /* v8 ignore next 3 -- the status duty selects proofs with an order */
    if (orderId === null) {
      continue;
    }
    if (row.orderStatus !== null && ORCHESTRA_FINAL_STATUSES.has(row.orderStatus)) {
      await patchProof(shop, row, { nextStatusAt: null });
      continue;
    }
    if (nowMs - (row.orderFoundAt ?? row.createdAt).getTime() >= SHOP_UNRESOLVED_LIMIT_MS) {
      await patchProof(shop, row, { nextStatusAt: null });
      logEvent('shop.alert.order_stuck', {
        paymentId: row.paymentId,
        proofId: row.id,
        offerId: row.offerId,
        orderId,
      });
      continue;
    }
    await readStatus(shop, row, orderId);
    return;
  }
}

/**
 * Run the eight watcher duties once, in order: end lapsed windows,
 * settlement, orders (odd ticks), lookups, receipts, submits, stuck proofs,
 * order status (even ticks).
 *
 * @param shop - Service.
 * @param tick - Tick number; odd ticks read history, even ticks read order status.
 * @returns Resolves when every duty ran.
 * @throws Propagates store failures.
 */
export async function runShopPaymentTick(shop: ShopPayments, tick: number): Promise<void> {
  const now = (): number => shop.deps.now();
  await endLapsedWindows(shop, now());
  await settle(shop, now());
  if (tick % 2 === 1) {
    await readOrders(shop, now());
  }
  await lookups(shop, now());
  await receipts(shop, now());
  await submits(shop, now());
  await markStuck(shop, now());
  if (tick % 2 === 0) {
    await readStatuses(shop, now());
  }
}

/**
 * Start the watcher: one tick now, then one every `intervalMs`. A tick does
 * not start while the previous one runs; ticks are numbered from 1 in the
 * order they start. A rejecting tick logs `shop.worker.tick.failed`.
 *
 * @param shop - Service.
 * @param intervalMs - Tick period (default {@link SHOP_WORKER_INTERVAL_MS}).
 * @returns Stop handle.
 */
export function startShopPaymentWorker(
  shop: ShopPayments,
  intervalMs: number = SHOP_WORKER_INTERVAL_MS,
): { stop: () => void } {
  let running = false;
  let count = 0;
  const tick = (): void => {
    if (running) {
      return;
    }
    running = true;
    count += 1;
    void runShopPaymentTick(shop, count)
      .catch((error: unknown) => {
        logEvent('shop.worker.tick.failed', errorLogFields(error));
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
