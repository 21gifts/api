/**
 * Watcher of shop stablecoin payments (`docs/shop-stablecoin-payment.md`,
 * Watcher): a tick every 2 s, separate from the charge watch, that runs the
 * eight duties in order. Each duty has its own call budget per tick, each
 * call times out after {@link SHOP_WORKER_CALL_TIMEOUT_MS}, and each duty
 * takes its rows oldest next-try first. Duty 3 (orders) reads on odd ticks,
 * duty 8 (order status) on even ticks.
 */

import { evmGetTransactionByHash } from '@/lib/evm-rpc';
import { errorLogFields, logEvent } from '@/lib/log';
import { ORCHESTRA_FINAL_STATUSES, type OrchestraOrder } from '@/lib/orchestra';
import { verifyLightningPayment } from '@/lib/pos-paid-worker';
import {
  SHOP_ORDER_WATCH_MS,
  SHOP_UNRESOLVED_LIMIT_MS,
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
  SHOP_FIRST_STATUS_MS,
  SHOP_HEX_UNKNOWN_MS,
  applyProofOrder,
  followProofOrder,
  readProofReceipt,
  refuseHexProof,
  sendHexProof,
  shopProofContext,
  storeProof,
  submitProofAttempt,
  verifyTxProof,
} from '@/lib/shop-proof';

/** Tick period of the watcher. */
export const SHOP_WORKER_INTERVAL_MS = 2_000;
/** Timeout of every external call of a duty. */
export const SHOP_WORKER_CALL_TIMEOUT_MS = 5_000;

/** Settlement reads per tick, in parallel. */
const SETTLE_PER_TICK = 8;
/** Lookup rows per tick. */
const LOOKUPS_PER_TICK = 4;
/** Receipt rows per tick. */
const RECEIPTS_PER_TICK = 4;
/** Submits per tick. */
const SUBMITS_PER_TICK = 1;
/** Rows the stuck duty marks per tick (no external call). */
const STUCK_PER_TICK = 100;
/** Status rows one even tick may look at to find the one row that needs a read. */
const STATUS_ROWS_PER_TICK = 10;
/** Raw entries of one history page. */
const HISTORY_PAGE_SIZE = 200;
/** One history read per payment at most this often. */
const HISTORY_INTERVAL_MS = 10_000;
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
/** Status reads every 10 s for this long after the order was found, then every 60 s. */
const STATUS_FAST_WINDOW_MS = 10 * 60_000;
/** Slow status cadence. */
const STATUS_SLOW_MS = 60_000;
/** An `accepted` payment older than this logs `shop.alert.accepted_long` once. */
const ACCEPTED_LONG_MS = 60 * 60_000;

/** Payments already reported as `accepted` for long, per service (once per process). */
const acceptedLongSeen = new WeakMap<ShopPayments, Set<string>>();

/**
 * Lock the account of a payment and run `run` in one transaction.
 *
 * @param shop - Service.
 * @param paymentId - Payment id.
 * @param run - Work inside the transaction.
 * @returns The work's result.
 */
function underPaymentLock<T>(
  shop: ShopPayments,
  paymentId: string,
  run: (tx: ShopTx) => Promise<T>,
): Promise<T> {
  return shop.store.transaction(async (tx) => {
    const payment = await tx.getPayment(paymentId);
    if (payment !== null) {
      await tx.lockAccount(payment.accountId);
    }
    return run(tx);
  });
}

/**
 * Patch one proof under its payment's account lock.
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
  await underPaymentLock(shop, proof.paymentId, async (tx) => {
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
 * One order of a history page: unknown orders become `detected` proofs; an
 * order recovered from one a proof holds moves that proof to it.
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
  if (offer === undefined) {
    return;
  }
  const recovered = order.recoveredFromOperationId;
  const handled = await underPaymentLock(shop, payment.id, async (tx) => {
    if ((await tx.findProofs({ providerOrder: order.id })).length > 0) {
      return true;
    }
    if (recovered === null) {
      return false;
    }
    const [prior] = await tx.findProofs({ providerOrder: recovered });
    if (prior === undefined) {
      return false;
    }
    const nowMs = shop.deps.now();
    await tx.updateProof(prior.id, {}, { nextStatusAt: new Date(nowMs + SHOP_FIRST_STATUS_MS) });
    await applyProofOrder(tx, prior, { orderId: order.id, status: order.status }, nowMs);
    return true;
  });
  if (handled || order.sourceTxHash === null) {
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

/**
 * Duty 3 (odd ticks): one history page of the payment whose
 * `next_history_at` is due. A failed read is retried at the cadence; a
 * budget refusal waits for the next odd tick. The read stops when the order
 * watch of the payment's last offer with an issued detail has ended.
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
  const patch: ShopPaymentPatch = {
    historyOffset: full
      ? payment.historyOffset + HISTORY_PAGE_SIZE
      : page.ok
        ? 0
        : payment.historyOffset,
    nextHistoryAt: !full && watchEndMs <= afterMs ? null : new Date(afterMs + HISTORY_INTERVAL_MS),
  };
  await underPaymentLock(shop, payment.id, async (tx) => {
    await tx.updatePayment(payment.id, {}, patch);
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
 */
async function lookUp(shop: ShopPayments, row: ShopProofLookup, nowMs: number): Promise<void> {
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
 * Duty 4: lookup rows that are not done, up to 4 per tick.
 *
 * @param shop - Service.
 * @param nowMs - Clock.
 */
async function lookups(shop: ShopPayments, nowMs: number): Promise<void> {
  const rows = await shop.store.transaction((tx) => tx.dueLookups(nowMs, LOOKUPS_PER_TICK));
  for (const row of rows) {
    await lookUp(shop, row, nowMs);
  }
}

/**
 * One receipt row: send a `hex` transaction that was never sent, otherwise
 * read the receipt; a `hex` transaction without a receipt is sent again, and
 * refused when the node still does not know it 10 minutes after its first
 * send. Reading stops after 24 h.
 *
 * @param shop - Service.
 * @param proof - Proof with a due `next_receipt_at`.
 * @param nowMs - Clock.
 */
async function readReceipt(shop: ShopPayments, proof: ShopProof, nowMs: number): Promise<void> {
  const later: ShopProofPatch = { nextReceiptAt: new Date(nowMs + SLOW_READ_MS) };
  const url = shop.deps.config?.evmRpc.get(proof.chainId);
  if (nowMs - proof.createdAt.getTime() >= SHOP_UNRESOLVED_LIMIT_MS || proof.logIndex !== null) {
    await patchProof(shop, proof, { nextReceiptAt: null });
    return;
  }
  if (url === undefined) {
    await patchProof(shop, proof, later);
    return;
  }
  if (proof.source === 'hex' && proof.sentAt === null) {
    const outcome = await sendHexProof(shop, proof, url, SHOP_WORKER_CALL_TIMEOUT_MS);
    if (outcome !== 'sent') {
      await patchProof(shop, proof, outcome === 'retry' ? later : { nextReceiptAt: null });
    }
    return;
  }
  const outcome = await readProofReceipt(shop, proof, url, SHOP_WORKER_CALL_TIMEOUT_MS);
  if (outcome !== 'pending' && outcome !== 'error') {
    await patchProof(shop, proof, { nextReceiptAt: null });
    return;
  }
  if (outcome === 'pending' && proof.source === 'hex' && proof.sentAt !== null) {
    if (nowMs - proof.sentAt.getTime() >= SHOP_HEX_UNKNOWN_MS) {
      const known = await evmGetTransactionByHash(
        url,
        shop.deps.fetchImpl,
        proof.txHash,
        SHOP_WORKER_CALL_TIMEOUT_MS,
      );
      if (known.ok && !known.value) {
        await refuseHexProof(shop, proof.id);
        await patchProof(shop, proof, { nextReceiptAt: null });
        return;
      }
    } else if ((await sendHexProof(shop, proof, url, SHOP_WORKER_CALL_TIMEOUT_MS)) === 'rejected') {
      await patchProof(shop, proof, { nextReceiptAt: null });
      return;
    }
  }
  await patchProof(shop, proof, later);
}

/**
 * Duty 5: `hex` proofs not yet mined or sent and `detected` proofs without a
 * log index, up to 4 per tick.
 *
 * @param shop - Service.
 * @param nowMs - Clock.
 */
async function receipts(shop: ShopPayments, nowMs: number): Promise<void> {
  const rows = await shop.store.transaction((tx) =>
    tx.dueProofs('receipt', nowMs, RECEIPTS_PER_TICK),
  );
  for (const row of rows) {
    await readReceipt(shop, row, nowMs);
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
    const stuck = await underPaymentLock(shop, row.paymentId, async (tx) => {
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
 * One status read of a proof's order, applied under the account lock.
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
  const read = await orchestra.status(orderId, SHOP_WORKER_CALL_TIMEOUT_MS);
  if (!read.ok && read.reason === 'budget') {
    return;
  }
  await underPaymentLock(shop, proof.paymentId, async (tx) => {
    const nowMs = shop.deps.now();
    const current = await tx.getProof(proof.id);
    if (current === null || current.providerOrder !== orderId) {
      return;
    }
    const order = read.ok ? read.order : null;
    if (order === null) {
      await tx.updateProof(current.id, {}, { nextStatusAt: nextStatusAt(current, nowMs) });
      return;
    }
    if (order.supersededByOperationId !== null && order.supersededByOperationId !== orderId) {
      await followProofOrder(tx, current, order.supersededByOperationId, nowMs);
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
