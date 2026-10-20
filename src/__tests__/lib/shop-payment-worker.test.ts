import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import {
  SHOP_SUCCESSOR_HISTORY_INTERVAL_MS,
  SHOP_SUCCESSOR_WAIT_MS,
  SHOP_WORKER_CALL_TIMEOUT_MS,
  SHOP_WORKER_INTERVAL_MS,
  runShopPaymentTick,
  startShopPaymentWorker,
} from '@/lib/shop-payment-worker';
import { proofResponse, retryStuckProof } from '@/lib/shop-proof';
import type { ShopProofDuty, ShopProofLookup, ShopTx } from '@/lib/shop-payment-store';
import {
  AMOUNT_IN,
  DEPOSIT_USDT,
  OFFER_ETH,
  OFFER_USDT,
  OFFER_USDC,
  PAYMENT_HASH,
  PAYMENT_ID,
  POLYGON_USDT,
  QUOTE_ID,
  T0,
  getPayment,
  getProof,
  harness,
  insertProofs,
  loggedEvents,
  paymentRow,
  proofRow,
  proofsOf,
  receiptJson,
  recordTxCalls,
  seed,
  transferLog,
  txHash,
  uid,
  type Harness,
} from '../helpers/shop-proof-fixture';

const H1 = txHash('a1');
const H2 = txHash('a2');

let warn: MockInstance;

beforeEach(() => {
  warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function events(): string[] {
  return loggedEvents(warn).map((line) => String(line['event']));
}

function usdtLog(index = 3): Record<string, unknown> {
  return transferLog(POLYGON_USDT, DEPOSIT_USDT, BigInt(AMOUNT_IN), index);
}

function lookupRow(partial: Partial<ShopProofLookup> = {}): ShopProofLookup {
  return {
    id: uid(0x501),
    quoteId: QUOTE_ID,
    method: 'Polygon',
    asset: 'USDT',
    chainId: 137,
    hash: H1,
    nextTryAt: new Date(T0),
    tries: 0,
    doneAt: null,
    createdAt: new Date(T0 - 10_000),
    ...partial,
  };
}

async function insertLookups(h: Harness, ...rows: ShopProofLookup[]): Promise<void> {
  await h.store.transaction(async (tx) => {
    for (const row of rows) {
      await tx.insertLookup(row);
    }
  });
}

function lookup(h: Harness, id: string): Promise<ShopProofLookup | null> {
  return h.store.transaction(
    async (tx) =>
      (await tx.dueLookups(Number.MAX_SAFE_INTEGER, 50)).find((row) => row.id === id) ?? null,
  );
}

async function lookupDone(h: Harness, hash: string): Promise<ShopProofLookup | null> {
  return h.store.transaction((tx) => tx.findLookup(137, hash, QUOTE_ID));
}

/**
 * Run `meanwhile` once, right after the transaction that selects the proofs
 * due for `duty` commits: another writer (an operator, another container)
 * acting between a duty's selection and its write.
 *
 * @returns The proof ids passed to `updateProof` after `meanwhile` ended.
 */
function afterSelection(
  h: Harness,
  duty: ShopProofDuty,
  meanwhile: () => Promise<unknown>,
): string[] {
  const writes: string[] = [];
  let ran = false;
  let recording = false;
  const original = h.store.transaction.bind(h.store);
  const wrapped = async <T>(run: (tx: ShopTx) => Promise<T>): Promise<T> => {
    let selects = false;
    const result = await original((tx) =>
      run(
        new Proxy(tx, {
          get: (target, prop) => {
            const value = (target as unknown as Record<string | symbol, unknown>)[prop];
            if (typeof value !== 'function') {
              return value;
            }
            return (...args: unknown[]) => {
              if (prop === 'dueProofs' && args[0] === duty) {
                selects = true;
              }
              if (prop === 'updateProof' && recording) {
                writes.push(String(args[0]));
              }
              return (value as (...a: unknown[]) => unknown).apply(target, args);
            };
          },
        }),
      ),
    );
    if (selects && !ran) {
      ran = true;
      await meanwhile();
      recording = true;
    }
    return result;
  };
  vi.spyOn(h.store, 'transaction').mockImplementation(wrapped as never);
  return writes;
}

describe('constants', () => {
  it('ticks every 2 s with 5 s calls', () => {
    expect(SHOP_WORKER_INTERVAL_MS).toBe(2_000);
    expect(SHOP_WORKER_CALL_TIMEOUT_MS).toBe(5_000);
  });
});

describe('duty 1: lapsed windows', () => {
  it('ends open payments whose window has passed', async () => {
    const h = harness();
    await seed(h, { windowEndsAt: new Date(T0) });
    await runShopPaymentTick(h.shop, 2);
    expect(await getPayment(h)).toMatchObject({ status: 'ended', endReason: 'window' });
    expect(loggedEvents(warn)).toContainEqual(
      expect.objectContaining({
        event: 'shop.payment.ended',
        paymentId: PAYMENT_ID,
        reason: 'window',
      }),
    );
  });
});

describe('duty 2: settlement', () => {
  it('marks a settled payment paid and schedules the next read of an open or failed one', async () => {
    const h = harness();
    await seed(h, { nextSettleAt: new Date(T0) });
    await h.store.transaction((tx) => tx.updatePayment(uid(2), {}, { nextSettleAt: new Date(T0) }));
    h.verify.set('cd'.repeat(32), 'failed');
    await runShopPaymentTick(h.shop, 2);
    expect((await getPayment(h))?.nextSettleAt?.getTime()).toBe(T0 + 5_000);
    expect((await getPayment(h, uid(2)))?.nextSettleAt?.getTime()).toBe(T0 + 5_000);
    h.clock.now += 5_000;
    h.verify.set(PAYMENT_HASH, 'settled');
    await runShopPaymentTick(h.shop, 2);
    expect(await getPayment(h)).toMatchObject({ status: 'paid', nextSettleAt: null });
  });

  it('logs shop.alert.accepted_long once per payment per process', async () => {
    const h = harness();
    await seed(h, {
      status: 'accepted',
      acceptedAt: new Date(T0 - 3_600_001),
      nextSettleAt: new Date(T0),
    });
    await h.store.transaction((tx) =>
      tx.updatePayment(
        uid(2),
        {},
        { status: 'accepted', acceptedAt: new Date(T0 - 60_000), nextSettleAt: new Date(T0) },
      ),
    );
    await runShopPaymentTick(h.shop, 2);
    h.clock.now += 30_000;
    await runShopPaymentTick(h.shop, 2);
    const alerts = loggedEvents(warn).filter(
      (line) => line['event'] === 'shop.alert.accepted_long',
    );
    expect(alerts).toEqual([expect.objectContaining({ paymentId: PAYMENT_ID })]);
  });
});

describe('duty 2: a failing settlement read', () => {
  it('waits for every read and its write before the tick rejects with the first failure', async () => {
    const h = harness();
    await seed(h, { nextSettleAt: new Date(T0) });
    await h.store.transaction((tx) => tx.updatePayment(uid(2), {}, { nextSettleAt: new Date(T0) }));
    const apply = h.shop.applySettlement.bind(h.shop);
    const finished: string[] = [];
    let release: () => void = () => undefined;
    const slow = new Promise<void>((resolve) => {
      release = resolve;
    });
    vi.spyOn(h.shop, 'applySettlement').mockImplementation(async (paymentId, settled, nowMs) => {
      if (paymentId === PAYMENT_ID) {
        throw new Error('first failed');
      }
      await slow;
      await apply(paymentId, settled, nowMs);
      finished.push(paymentId);
    });
    let settledTick = false;
    const tick = runShopPaymentTick(h.shop, 2).finally(() => {
      settledTick = true;
    });
    for (let i = 0; i < 10; i += 1) {
      await Promise.resolve();
    }
    expect(settledTick).toBe(false);
    release();
    await expect(tick).rejects.toThrow('first failed');
    expect(finished).toEqual([uid(2)]);
    expect((await getPayment(h, uid(2)))?.nextSettleAt?.getTime()).toBe(T0 + 5_000);
  });
});

describe('duty 2: settlement limit', () => {
  it('reads at most 8 payments per tick, all 8 in parallel, and leaves the rest for the next tick', async () => {
    const h = harness();
    await seed(h, { status: 'ended', endReason: 'window', endedAt: new Date(T0 - 1) });
    await h.store.transaction(async (tx) => {
      for (let i = 0; i < 9; i += 1) {
        await tx.insertPayment(
          paymentRow({
            id: uid(0x600 + i),
            paymentHash: (i + 0x10).toString(16).repeat(32),
            bolt11: `lnbc21u1extra${i}`,
            status: 'ended',
            endReason: 'window',
            endedAt: new Date(T0 - 1),
            nextSettleAt: new Date(T0),
            createdAt: new Date(T0 + i),
          }),
        );
      }
    });
    await runShopPaymentTick(h.shop, 2);
    expect(h.verifyReads).toEqual({ calls: 8, running: 0, maxRunning: 8 });
    await runShopPaymentTick(h.shop, 2);
    expect(h.verifyReads.calls).toBe(9);
  });
});

describe('duty 3: orders', () => {
  it('reads only on odd ticks and only with Orchestra', async () => {
    const h = harness();
    await seed(h, { nextHistoryAt: new Date(T0) });
    await runShopPaymentTick(h.shop, 2);
    expect(h.orchestra.history).not.toHaveBeenCalled();
    const off = harness({ orchestra: false });
    await seed(off, { nextHistoryAt: new Date(T0) });
    await runShopPaymentTick(off.shop, 1);
    expect((await getPayment(off))?.nextHistoryAt?.getTime()).toBe(T0);
    await runShopPaymentTick(harness().shop, 1);
  });

  it('stores an unknown order as a detected proof and ignores what it cannot place', async () => {
    const h = harness();
    await seed(h, { nextHistoryAt: new Date(T0) });
    await h.store.transaction((tx) => tx.markDetailIssued(OFFER_USDT, T0));
    await insertProofs(
      h,
      proofRow({ txHash: H2, providerOrder: 'o-known', orderStatus: 'processing' }),
    );
    h.orchestra.history.mockResolvedValueOnce({
      ok: true,
      full: false,
      orders: [
        {
          id: 'o-foreign',
          quoteId: 'q-unknown',
          status: 'processing',
          sourceTxHash: H1,
          recoveredFromOperationId: null,
          supersededByOperationId: null,
        },
        {
          id: 'o-known',
          quoteId: 'q-usdt-pol',
          status: 'processing',
          sourceTxHash: H2,
          recoveredFromOperationId: null,
          supersededByOperationId: null,
        },
        {
          id: 'o-nohash',
          quoteId: 'q-usdt-pol',
          status: 'processing',
          sourceTxHash: null,
          recoveredFromOperationId: null,
          supersededByOperationId: null,
        },
        {
          id: 'o-bad',
          quoteId: 'q-usdt-pol',
          status: 'processing',
          sourceTxHash: 'nope',
          recoveredFromOperationId: null,
          supersededByOperationId: null,
        },
        {
          id: 'o-new',
          quoteId: 'q-usdt-eth',
          status: 'confirming',
          sourceTxHash: H1.toUpperCase().replace('0X', '0x'),
          recoveredFromOperationId: 'o-none',
          supersededByOperationId: null,
        },
      ],
    });
    await runShopPaymentTick(h.shop, 1);
    expect(h.orchestra.history).toHaveBeenCalledWith(
      'lnbc21u1test',
      0,
      SHOP_WORKER_CALL_TIMEOUT_MS,
      { paymentId: PAYMENT_ID },
    );
    const detected = (await proofsOf(h)).find((row) => row.providerOrder === 'o-new');
    expect(detected).toMatchObject({
      source: 'detected',
      offerId: OFFER_ETH,
      chainId: 1,
      txHash: H1,
      logIndex: null,
      orderStatus: 'confirming',
      result: null,
    });
    expect(await proofsOf(h)).toHaveLength(2);
    expect(events()).toContain('shop.proof.detected');
    expect(await getPayment(h)).toMatchObject({
      historyOffset: 0,
      nextHistoryAt: new Date(T0 + 10_000),
    });
  });

  it('stores an order recovered from an order a proof holds as its own proof; the proof keeps its order', async () => {
    const h = harness();
    await seed(h, { nextHistoryAt: new Date(T0) });
    await insertProofs(
      h,
      proofRow({
        providerOrder: 'o-old',
        orderStatus: 'unfulfilled',
        orderFoundAt: new Date(T0 - 1_000),
      }),
    );
    h.orchestra.history.mockResolvedValueOnce({
      ok: true,
      full: true,
      orders: [
        {
          id: 'o-next',
          quoteId: 'q-usdt-pol',
          status: 'processing',
          sourceTxHash: H2,
          recoveredFromOperationId: 'o-old',
          supersededByOperationId: null,
        },
      ],
    });
    await runShopPaymentTick(h.shop, 1);
    expect(await proofsOf(h)).toEqual([
      expect.objectContaining({
        id: uid(0x401),
        txHash: H1,
        providerOrder: 'o-old',
        orderStatus: 'unfulfilled',
        result: null,
      }),
      expect.objectContaining({
        source: 'detected',
        offerId: OFFER_USDT,
        txHash: H2,
        logIndex: null,
        providerOrder: 'o-next',
        orderStatus: 'processing',
        nextStatusAt: new Date(T0 + 10_000),
        nextReceiptAt: new Date(T0 + 30_000),
      }),
    ]);
    expect(await getPayment(h)).toMatchObject({
      historyOffset: 200,
      nextHistoryAt: new Date(T0 + 10_000),
    });
  });

  it('stores nothing more for an order a proof already holds, recovered or not', async () => {
    const h = harness();
    await seed(h, { nextHistoryAt: new Date(T0) });
    const held = [
      proofRow({ txHash: H1, providerOrder: 'o-old', orderStatus: 'unfulfilled' }),
      proofRow({
        id: uid(0x402),
        source: 'detected',
        txHash: H2,
        logIndex: null,
        transferAmount: null,
        providerOrder: 'o-next',
        orderStatus: 'confirming',
        createdAt: new Date(T0 + 1),
      }),
    ];
    await insertProofs(h, ...held);
    h.orchestra.history.mockResolvedValueOnce({
      ok: true,
      full: false,
      orders: [
        {
          id: 'o-next',
          quoteId: 'q-usdt-pol',
          status: 'swapping',
          sourceTxHash: H2,
          recoveredFromOperationId: 'o-old',
          supersededByOperationId: null,
        },
        {
          id: 'o-old',
          quoteId: 'q-usdt-pol',
          status: 'refunded',
          sourceTxHash: H1,
          recoveredFromOperationId: 'o-old',
          supersededByOperationId: 'o-next',
        },
      ],
    });
    await runShopPaymentTick(h.shop, 1);
    // The history read changes no stored row; the order-status duty follows each order.
    expect(await proofsOf(h)).toEqual(held);
    expect(events()).not.toContain('shop.proof.detected');
  });

  it('stops after the order watch of the last detailed offer, waits on budget, and retries an error', async () => {
    const h = harness();
    await seed(h, { nextHistoryAt: new Date(T0), historyOffset: 200 });
    h.orchestra.history.mockResolvedValueOnce({ ok: false, reason: 'budget' });
    await runShopPaymentTick(h.shop, 1);
    expect(await getPayment(h)).toMatchObject({ historyOffset: 200, nextHistoryAt: new Date(T0) });
    await h.store.transaction((tx) => tx.markDetailIssued(OFFER_USDT, T0));
    h.orchestra.history.mockResolvedValueOnce({ ok: false, reason: 'error' });
    await runShopPaymentTick(h.shop, 1);
    expect(await getPayment(h)).toMatchObject({
      historyOffset: 200,
      nextHistoryAt: new Date(T0 + 10_000),
    });
    const ended = T0 + 120_000 + 30 * 60_000;
    h.clock.now = ended;
    // The offers alone end the watch: a failed read after it keeps the
    // offset and clears next_history_at when no successor wait keeps it.
    h.orchestra.history.mockResolvedValueOnce({ ok: false, reason: 'error' });
    await runShopPaymentTick(h.shop, 1);
    expect(await getPayment(h)).toMatchObject({ historyOffset: 200, nextHistoryAt: null });
    // A full page is still read on at 10 s; the next short page ends the reads.
    await h.store.transaction((tx) =>
      tx.updatePayment(PAYMENT_ID, {}, { nextHistoryAt: new Date(ended) }),
    );
    h.clock.now = ended + 10_000;
    h.orchestra.history.mockResolvedValueOnce({ ok: true, orders: [], full: true });
    await runShopPaymentTick(h.shop, 1);
    expect(await getPayment(h)).toMatchObject({
      historyOffset: 400,
      nextHistoryAt: new Date(ended + 20_000),
    });
    h.clock.now = ended + 20_000;
    await runShopPaymentTick(h.shop, 1);
    expect(await getPayment(h)).toMatchObject({ historyOffset: 0, nextHistoryAt: null });
  });
});

describe('duty 3: the successor wait', () => {
  const watchEnded = T0 + 120_000 + 30 * 60_000;
  const replaced = {
    providerOrder: 'o-a',
    orderStatus: 'unfulfilled',
    supersededByOrder: 'o-b',
    orderFoundAt: new Date(T0),
  };

  async function waiting(h: Harness, payment: Parameters<typeof seed>[1] = {}): Promise<void> {
    await seed(h, {
      nextHistoryAt: new Date(watchEnded),
      successorWaitUntil: new Date(watchEnded + 1),
      ...payment,
    });
    await h.store.transaction((tx) => tx.markDetailIssued(OFFER_USDT, T0));
    await insertProofs(h, proofRow({ ...replaced, result: 'accepted' }));
    h.clock.now = watchEnded;
  }

  it('reads a payment whose order watch ended every 60 s while only the successor wait keeps it, paid ones included', async () => {
    const h = harness();
    await waiting(h, { status: 'paid', paidAt: new Date(T0) });
    const calls = recordTxCalls(h);
    await runShopPaymentTick(h.shop, 1);
    expect(h.orchestra.history).toHaveBeenCalledTimes(1);
    expect(await getPayment(h)).toMatchObject({
      historyOffset: 0,
      nextHistoryAt: new Date(watchEnded + SHOP_SUCCESSOR_HISTORY_INTERVAL_MS),
      successorWaitUntil: new Date(watchEnded + 1),
    });
    expect(SHOP_SUCCESSOR_HISTORY_INTERVAL_MS).toBe(60_000);
    // The decision runs under the payment row and its proof rows.
    expect(calls).toEqual(['lockPayment', 'lockProofs', 'updatePayment']);
    expect(events()).not.toContain('shop.alert.successor_missing');
  });

  it('keeps the 10 s cadence while the order watch runs or a page is full', async () => {
    const h = harness();
    await waiting(h);
    h.orchestra.history.mockResolvedValueOnce({ ok: true, orders: [], full: true });
    await runShopPaymentTick(h.shop, 1);
    expect((await getPayment(h))?.nextHistoryAt).toEqual(new Date(watchEnded + 10_000));
  });

  it('ends the wait once the successor is stored as its own proof, which takes the place when its order completes', async () => {
    const h = harness();
    await waiting(h, { status: 'accepted', acceptedAt: new Date(T0) });
    h.orchestra.history.mockResolvedValueOnce({
      ok: true,
      full: false,
      orders: [
        {
          id: 'o-b',
          quoteId: 'q-usdt-pol',
          status: 'completed',
          sourceTxHash: H2,
          recoveredFromOperationId: 'o-a',
          supersededByOperationId: null,
        },
      ],
    });
    await runShopPaymentTick(h.shop, 1);
    const [a, b] = await proofsOf(h);
    expect(a).toMatchObject({ id: uid(0x401), providerOrder: 'o-a', result: 'superseded' });
    expect(b).toMatchObject({ providerOrder: 'o-b', txHash: H2, result: 'accepted' });
    expect(await getPayment(h)).toMatchObject({ status: 'accepted', nextHistoryAt: null });
    expect(events()).not.toContain('shop.alert.successor_missing');
  });

  it('logs shop.alert.successor_missing and clears both columns when the wait passes first', async () => {
    const h = harness();
    await waiting(h, { successorWaitUntil: new Date(watchEnded) });
    await runShopPaymentTick(h.shop, 1);
    expect(await getPayment(h)).toMatchObject({ nextHistoryAt: null, successorWaitUntil: null });
    expect(
      loggedEvents(warn)
        .filter((line) => line['event'] === 'shop.alert.successor_missing')
        .map(({ ts: _ts, event: _event, ...fields }) => fields),
    ).toEqual([
      {
        paymentId: PAYMENT_ID,
        proofId: uid(0x401),
        offerId: OFFER_USDT,
        quoteId: QUOTE_ID,
        providerRef: 'q-usdt-pol',
        orderId: 'o-a',
        successorOrderId: 'o-b',
      },
    ]);
  });

  it('reads again after 60 s when a read fails while only the successor wait keeps the payment', async () => {
    const h = harness();
    await waiting(h);
    h.orchestra.history.mockResolvedValueOnce({ ok: false, reason: 'error' });
    await runShopPaymentTick(h.shop, 1);
    expect(await getPayment(h)).toMatchObject({
      historyOffset: 0,
      nextHistoryAt: new Date(watchEnded + SHOP_SUCCESSOR_HISTORY_INTERVAL_MS),
      successorWaitUntil: new Date(watchEnded + 1),
    });
    expect(events()).not.toContain('shop.alert.successor_missing');
  });

  it('logs shop.alert.successor_missing when the wait has passed, also after a failed read', async () => {
    const h = harness();
    await waiting(h, { successorWaitUntil: new Date(watchEnded), historyOffset: 200 });
    h.orchestra.history.mockResolvedValueOnce({ ok: false, reason: 'error' });
    await runShopPaymentTick(h.shop, 1);
    expect(await getPayment(h)).toMatchObject({
      historyOffset: 200,
      nextHistoryAt: null,
      successorWaitUntil: null,
    });
    expect(events()).toContain('shop.alert.successor_missing');
  });

  it('clears next_history_at without an alert when no wait is set', async () => {
    const h = harness();
    await waiting(h, { successorWaitUntil: null });
    await runShopPaymentTick(h.shop, 1);
    expect(await getPayment(h)).toMatchObject({ nextHistoryAt: null, successorWaitUntil: null });
    expect(events()).not.toContain('shop.alert.successor_missing');
  });
});

describe('duty 4: lookups', () => {
  it('stores the proof once the receipt is found', async () => {
    const h = harness();
    await seed(h);
    await insertLookups(h, lookupRow());
    h.rpc['eth_getTransactionReceipt'] = () => ({ result: receiptJson(H1, '0x1', [usdtLog()]) });
    await runShopPaymentTick(h.shop, 2);
    expect(await proofsOf(h)).toEqual([
      expect.objectContaining({
        source: 'tx',
        txHash: H1,
        logIndex: 3,
        nextSubmitAt: new Date(T0 + 10_000),
      }),
    ]);
    expect((await lookupDone(h, H1))?.doneAt?.getTime()).toBe(T0);
    expect(h.orchestra.submit).not.toHaveBeenCalled();
  });

  it('reads again after 10 s, 30 s, and 60 s, then every 2 min, and ends a refused lookup', async () => {
    const h = harness();
    await seed(h);
    await insertLookups(
      h,
      lookupRow(),
      lookupRow({ id: uid(0x502), hash: H2, tries: 2 }),
      lookupRow({ id: uid(0x503), hash: txHash('a3') }),
    );
    h.rpc['eth_getTransactionReceipt'] = (params) => ({
      result: params[0] === txHash('a3') ? receiptJson(txHash('a3'), '0x0', []) : null,
    });
    await runShopPaymentTick(h.shop, 2);
    expect(await lookup(h, uid(0x501))).toMatchObject({
      tries: 1,
      nextTryAt: new Date(T0 + 20_000),
    });
    expect(await lookup(h, uid(0x502))).toMatchObject({
      tries: 3,
      nextTryAt: new Date(T0 + 120_000),
    });
    // Two rows of two calls used the tick's 4 calls; the third waits for the next tick.
    expect(await lookupDone(h, txHash('a3'))).toMatchObject({ tries: 0, doneAt: null });
    await runShopPaymentTick(h.shop, 2);
    expect((await lookupDone(h, txHash('a3')))?.doneAt?.getTime()).toBe(T0);
    expect(await proofsOf(h)).toEqual([]);
  });

  it('postpones a lookup without a method or endpoint and expires one after an hour', async () => {
    const h = harness();
    await seed(h);
    await insertLookups(
      h,
      lookupRow({ method: 'Tron' }),
      lookupRow({ id: uid(0x502), hash: H2, chainId: 10, method: 'Optimism' }),
      lookupRow({ id: uid(0x503), hash: txHash('a3'), createdAt: new Date(T0 - 3_600_000) }),
    );
    await runShopPaymentTick(h.shop, 2);
    expect(await lookup(h, uid(0x501))).toMatchObject({
      tries: 1,
      nextTryAt: new Date(T0 + 20_000),
    });
    expect(await lookup(h, uid(0x502))).toMatchObject({ tries: 1 });
    expect((await lookupDone(h, txHash('a3')))?.doneAt?.getTime()).toBe(T0);
    expect(loggedEvents(warn)).toContainEqual(
      expect.objectContaining({
        event: 'shop.proof.lookup_expired',
        paymentId: PAYMENT_ID,
        quoteId: QUOTE_ID,
      }),
    );
    expect(h.rpcCalls).toEqual([]);
  });
});

describe('duty 4: lookup call budget', () => {
  const rows = (): ShopProofLookup[] =>
    [1, 2, 3, 4, 5].map((i) =>
      lookupRow({ id: uid(0x510 + i), hash: txHash(`c${i}`), nextTryAt: new Date(T0 - 10 + i) }),
    );

  it('takes rows while 2 calls are left: two rows of two calls each', async () => {
    const h = harness();
    await seed(h);
    await insertLookups(h, ...rows());
    await runShopPaymentTick(h.shop, 2);
    expect(h.rpcCalls.map((call) => call.method)).toEqual([
      'eth_getTransactionReceipt',
      'eth_getUserOperationReceipt',
      'eth_getTransactionReceipt',
      'eth_getUserOperationReceipt',
    ]);
    expect((await lookup(h, uid(0x513)))?.tries).toBe(0);
  });

  it('stops with one call left: three rows of one call each', async () => {
    const h = harness();
    await seed(h);
    await insertLookups(h, ...rows());
    h.rpc['eth_getTransactionReceipt'] = () => 'transport';
    await runShopPaymentTick(h.shop, 2);
    expect(h.rpcCalls).toHaveLength(3);
    expect((await lookup(h, uid(0x513)))?.tries).toBe(1);
    expect((await lookup(h, uid(0x514)))?.tries).toBe(0);
  });
});

describe('duty 5: receipts', () => {
  const due = { nextReceiptAt: new Date(T0) };

  it('reads at most 4 detected proofs per tick, one call each', async () => {
    const h = harness();
    await seed(h);
    await insertProofs(
      h,
      ...[1, 2, 3, 4, 5].map((i) =>
        proofRow({
          ...due,
          id: uid(0x410 + i),
          txHash: txHash(`d${i}`),
          source: 'detected',
          logIndex: null,
          transferAmount: null,
          createdAt: new Date(T0 + i),
        }),
      ),
    );
    await runShopPaymentTick(h.shop, 2);
    expect(h.rpcCalls).toHaveLength(4);
    const next = await Promise.all(
      [1, 2, 3, 4, 5].map(async (i) =>
        (await getProof(h, uid(0x410 + i)))?.nextReceiptAt?.getTime(),
      ),
    );
    expect(next.filter((at) => at === T0 + 120_000)).toHaveLength(4);
    expect(next.filter((at) => at === T0)).toHaveLength(1);
  });

  it('takes a sent hex proof only while 3 calls are left', async () => {
    const h = harness();
    await seed(h);
    const sent = { ...due, source: 'hex' as const, logIndex: null, sentAt: new Date(T0 - 60_000) };
    await insertProofs(
      h,
      proofRow({ ...sent, rawHex: 'ab' }),
      proofRow({ ...sent, id: uid(0x402), txHash: H2, rawHex: 'cd', createdAt: new Date(T0 + 1) }),
    );
    await runShopPaymentTick(h.shop, 2);
    // Receipt read and resend of the first row; 2 calls left are fewer than 3.
    expect(h.rpcCalls.map((call) => call.method)).toEqual([
      'eth_getTransactionReceipt',
      'eth_sendRawTransaction',
    ]);
    expect((await getProof(h, uid(0x402)))?.nextReceiptAt?.getTime()).toBe(T0);
  });

  it('fills a detected proof, stops after 24 h or once filled, and postpones without an endpoint', async () => {
    const h = harness();
    await seed(h);
    await insertProofs(
      h,
      proofRow({ ...due, source: 'detected', logIndex: null, transferAmount: null }),
      proofRow({
        ...due,
        id: uid(0x402),
        txHash: H2,
        source: 'detected',
        logIndex: null,
        transferAmount: null,
        createdAt: new Date(T0 - 86_400_000),
        giveUpAt: new Date(T0),
      }),
      proofRow({ ...due, id: uid(0x403), txHash: txHash('a3'), source: 'hex', rawHex: 'ab' }),
      proofRow({
        ...due,
        id: uid(0x404),
        txHash: txHash('a4'),
        chainId: 10,
        source: 'detected',
        logIndex: null,
        transferAmount: null,
      }),
    );
    h.rpc['eth_getTransactionReceipt'] = () => ({ result: receiptJson(H1, '0x1', [usdtLog()]) });
    await runShopPaymentTick(h.shop, 2);
    expect(await getProof(h, uid(0x401))).toMatchObject({ logIndex: 3, nextReceiptAt: null });
    expect((await getProof(h, uid(0x402)))?.nextReceiptAt).toBeNull();
    expect((await getProof(h, uid(0x403)))?.nextReceiptAt).toBeNull();
    expect((await getProof(h, uid(0x404)))?.nextReceiptAt?.getTime()).toBe(T0 + 120_000);
    expect(h.rpcCalls).toHaveLength(1);
  });

  it('sends a hex transaction that was never sent', async () => {
    const h = harness();
    await seed(h);
    await insertProofs(
      h,
      proofRow({ ...due, source: 'hex', rawHex: 'ab', logIndex: null }),
      proofRow({ ...due, id: uid(0x402), txHash: H2, source: 'hex', rawHex: 'cd', logIndex: null }),
      proofRow({
        ...due,
        id: uid(0x403),
        txHash: txHash('a3'),
        source: 'hex',
        rawHex: 'ef',
        logIndex: null,
      }),
    );
    h.rpc['eth_sendRawTransaction'] = (params) =>
      params[0] === '0xab'
        ? { result: H1 }
        : params[0] === '0xcd'
          ? { error: 'intrinsic gas too low' }
          : 'transport';
    await runShopPaymentTick(h.shop, 2);
    // Sent, but not submitted until its receipt fills the log index.
    expect(await getProof(h, uid(0x401))).toMatchObject({
      sentAt: new Date(T0),
      nextReceiptAt: new Date(T0 + 30_000),
      nextSubmitAt: null,
    });
    expect(h.orchestra.submit).not.toHaveBeenCalled();
    expect(await getProof(h, uid(0x402))).toMatchObject({ result: 'refused', nextReceiptAt: null });
    expect(await getProof(h, uid(0x403))).toMatchObject({
      sentAt: null,
      nextReceiptAt: new Date(T0 + 120_000),
    });
  });

  it('sends a retried stuck hex proof that was never sent, also when it was stored more than 24 h ago', async () => {
    const h = harness();
    await seed(h);
    await insertProofs(
      h,
      proofRow({
        source: 'hex',
        rawHex: 'ab',
        logIndex: null,
        result: 'stuck',
        createdAt: new Date(T0 - 90_000_000),
        giveUpAt: new Date(T0 - 3_600_000),
        nextReceiptAt: null,
      }),
    );
    expect(await retryStuckProof(h.shop, uid(0x401))).toBe('retried');
    h.rpc['eth_sendRawTransaction'] = () => ({ result: H1 });
    await runShopPaymentTick(h.shop, 2);
    expect(h.rpcCalls.map((call) => call.method)).toEqual(['eth_sendRawTransaction']);
    expect(await getProof(h, uid(0x401))).toMatchObject({
      result: null,
      sentAt: new Date(T0),
      nextReceiptAt: new Date(T0 + 30_000),
    });
  });

  it('resends a hex transaction without a receipt every 2 min however long the node does not know it, and refuses a rejected resend', async () => {
    const h = harness();
    await seed(h);
    const sent = { ...due, source: 'hex' as const, logIndex: null };
    await insertProofs(
      h,
      proofRow({ ...sent, rawHex: 'ab', sentAt: new Date(T0 - 11 * 60_000) }),
      proofRow({
        ...sent,
        id: uid(0x402),
        txHash: H2,
        rawHex: 'cd',
        sentAt: new Date(T0 - 60_000),
        createdAt: new Date(T0 + 1),
      }),
    );
    h.rpc['eth_sendRawTransaction'] = (params) =>
      params[0] === '0xcd' ? { error: 'invalid sender' } : { error: 'already known' };
    // The node does not know the first transaction 11 minutes after its first send.
    h.rpc['eth_getTransactionByHash'] = () => ({ result: null });
    // A sent row may take 3 calls, so each tick takes one row within its 4 calls.
    await runShopPaymentTick(h.shop, 2);
    expect(h.rpcCalls.map((call) => call.method)).toEqual([
      'eth_getTransactionReceipt',
      'eth_sendRawTransaction',
      'eth_getTransactionByHash',
    ]);
    await runShopPaymentTick(h.shop, 2);
    expect(await getProof(h, uid(0x401))).toMatchObject({
      result: null,
      refusal: null,
      nextReceiptAt: new Date(T0 + 120_000),
    });
    expect(await getProof(h, uid(0x402))).toMatchObject({
      result: 'refused',
      refusal: 'hex_rejected',
      nextReceiptAt: null,
    });
    expect(h.orchestra.submit).not.toHaveBeenCalled();
  });

  it('fills a hex transaction mined 30 min after its first send; the watcher submits it 10 s, 30 s, and 60 s after the fill, then every 5 min', async () => {
    const h = harness();
    await seed(h);
    await insertProofs(
      h,
      proofRow({
        ...due,
        source: 'hex',
        rawHex: 'ab',
        logIndex: null,
        sentAt: new Date(T0 - 30 * 60_000),
      }),
    );
    h.rpc['eth_getTransactionReceipt'] = () => ({ result: receiptJson(H1, '0x1', [usdtLog()]) });
    await runShopPaymentTick(h.shop, 2);
    expect(h.rpcCalls.map((call) => call.method)).toEqual(['eth_getTransactionReceipt']);
    // The fill schedules the first submit 10 s later, as storing a proof
    // with its log index does; nothing is submitted on the fill's tick.
    expect(h.orchestra.submit).not.toHaveBeenCalled();
    expect(await getProof(h, uid(0x401))).toMatchObject({
      logIndex: 3,
      nextReceiptAt: null,
      tries: 0,
      nextSubmitAt: new Date(T0 + 10_000),
    });
    h.clock.now = T0 + 9_999;
    await runShopPaymentTick(h.shop, 2);
    expect(h.orchestra.submit).not.toHaveBeenCalled();
    h.clock.now = T0 + 10_000;
    await runShopPaymentTick(h.shop, 2);
    expect(h.orchestra.submit).toHaveBeenCalledTimes(1);
    expect(h.orchestra.submit.mock.calls[0]?.slice(0, 4)).toEqual([
      'q-usdt-pol',
      H1,
      uid(0x402),
      'watcher',
    ]);
    expect(await getProof(h, uid(0x401))).toMatchObject({
      tries: 1,
      nextSubmitAt: new Date(T0 + 30_000),
    });
    h.clock.now = T0 + 30_000;
    await runShopPaymentTick(h.shop, 2);
    expect(h.orchestra.submit).toHaveBeenCalledTimes(2);
    expect(await getProof(h, uid(0x401))).toMatchObject({
      tries: 2,
      nextSubmitAt: new Date(T0 + 60_000),
    });
    h.clock.now = T0 + 60_000;
    await runShopPaymentTick(h.shop, 2);
    expect(h.orchestra.submit).toHaveBeenCalledTimes(3);
    expect(await getProof(h, uid(0x401))).toMatchObject({
      tries: 3,
      nextSubmitAt: new Date(T0 + 360_000),
    });
    h.clock.now = T0 + 360_000;
    await runShopPaymentTick(h.shop, 2);
    expect(h.orchestra.submit).toHaveBeenCalledTimes(4);
    expect(await getProof(h, uid(0x401))).toMatchObject({
      tries: 4,
      nextSubmitAt: new Date(T0 + 660_000),
    });
  });

  it('reads an unknown hex transaction until give_up_at; then the stuck duty marks it stuck', async () => {
    const h = harness();
    await seed(h);
    await insertProofs(
      h,
      proofRow({
        ...due,
        source: 'hex',
        rawHex: 'ab',
        logIndex: null,
        sentAt: new Date(T0 - 86_000_000),
        giveUpAt: new Date(T0),
      }),
    );
    await runShopPaymentTick(h.shop, 2);
    expect(h.rpcCalls).toEqual([]);
    expect(await getProof(h, uid(0x401))).toMatchObject({
      result: 'stuck',
      nextReceiptAt: null,
    });
    expect(events()).toContain('shop.alert.proof_stuck');
  });

  it('stops reading a hex proof that has a result or an order, without a call', async () => {
    const h = harness();
    await seed(h);
    const hex = { ...due, source: 'hex' as const, rawHex: 'ab', logIndex: null };
    await insertProofs(
      h,
      proofRow({ ...hex, sentAt: new Date(T0), result: 'refused', refusal: 'mismatch' }),
      proofRow({
        ...hex,
        id: uid(0x402),
        txHash: H2,
        sentAt: new Date(T0),
        providerOrder: 'o2',
        orderStatus: 'processing',
      }),
    );
    await runShopPaymentTick(h.shop, 2);
    expect(h.rpcCalls).toEqual([]);
    expect((await getProof(h, uid(0x401)))?.nextReceiptAt).toBeNull();
    expect((await getProof(h, uid(0x402)))?.nextReceiptAt).toBeNull();
  });

  it('reads a detected proof again after a failed or empty read', async () => {
    const h = harness();
    await seed(h);
    await insertProofs(
      h,
      proofRow({ ...due, source: 'detected', logIndex: null, transferAmount: null }),
      proofRow({
        ...due,
        id: uid(0x402),
        txHash: H2,
        source: 'detected',
        logIndex: null,
        transferAmount: null,
      }),
    );
    h.rpc['eth_getTransactionReceipt'] = (params) =>
      params[0] === H1 ? 'transport' : { result: null };
    await runShopPaymentTick(h.shop, 2);
    expect((await getProof(h, uid(0x401)))?.nextReceiptAt?.getTime()).toBe(T0 + 120_000);
    expect((await getProof(h, uid(0x402)))?.nextReceiptAt?.getTime()).toBe(T0 + 120_000);
  });
  it('keeps what another writer stored between the selection and the write', async () => {
    const h = harness();
    await seed(h);
    const detected = {
      ...due,
      source: 'detected' as const,
      logIndex: null,
      transferAmount: null,
      giveUpAt: new Date(T0),
    };
    await insertProofs(
      h,
      proofRow(detected),
      proofRow({ ...detected, id: uid(0x402), txHash: H2, createdAt: new Date(T0 + 1) }),
    );
    // An operator retry moves the read ahead; a merge deletes the other row.
    const writes = afterSelection(h, 'receipt', () =>
      h.store.transaction(async (tx) => {
        await tx.updateProof(
          uid(0x401),
          {},
          { giveUpAt: new Date(T0 + 86_400_000), nextReceiptAt: new Date(T0 + 5) },
        );
        await tx.deleteProof(uid(0x402));
      }),
    );
    await runShopPaymentTick(h.shop, 2);
    expect(writes).toEqual([]);
    expect((await getProof(h, uid(0x401)))?.nextReceiptAt?.getTime()).toBe(T0 + 5);
    expect(await getProof(h, uid(0x402))).toBeNull();
  });
});

describe('duty 6: submits', () => {
  it('submits after 10 s, 30 s, and 60 s, then every 5 min, until resolved', async () => {
    const h = harness();
    await seed(h);
    await insertProofs(h, proofRow({ nextSubmitAt: new Date(T0) }));
    await runShopPaymentTick(h.shop, 2);
    expect(h.orchestra.submit).toHaveBeenCalledWith(
      'q-usdt-pol',
      H1,
      uid(0x402),
      'watcher',
      5_000,
      {
        paymentId: PAYMENT_ID,
        proofId: uid(0x401),
        offerId: OFFER_USDT,
        quoteId: QUOTE_ID,
        providerRef: 'q-usdt-pol',
      },
    );
    expect(await getProof(h, uid(0x401))).toMatchObject({
      tries: 1,
      nextSubmitAt: new Date(T0 + 20_000),
    });
    h.clock.now = T0 + 20_000;
    await runShopPaymentTick(h.shop, 2);
    expect(await getProof(h, uid(0x401))).toMatchObject({
      tries: 2,
      nextSubmitAt: new Date(T0 + 50_000),
    });
    h.clock.now = T0 + 50_000;
    await runShopPaymentTick(h.shop, 2);
    expect(await getProof(h, uid(0x401))).toMatchObject({
      tries: 3,
      nextSubmitAt: new Date(T0 + 350_000),
    });
    h.clock.now = T0 + 350_000;
    h.orchestra.submit.mockResolvedValueOnce({
      kind: 'order',
      orderId: 'o1',
      status: 'processing',
    });
    await runShopPaymentTick(h.shop, 2);
    expect(await getProof(h, uid(0x401))).toMatchObject({
      tries: 4,
      nextSubmitAt: null,
      result: 'accepted',
    });
  });

  it('waits for the next tick when the budget refuses, and does nothing without Orchestra', async () => {
    const h = harness();
    await seed(h);
    await insertProofs(h, proofRow({ nextSubmitAt: new Date(T0) }));
    h.orchestra.submit.mockResolvedValueOnce({ kind: 'budget' });
    await runShopPaymentTick(h.shop, 2);
    expect(await getProof(h, uid(0x401))).toMatchObject({ tries: 0, nextSubmitAt: new Date(T0) });
    const off = harness({ orchestra: false });
    await seed(off);
    await insertProofs(off, proofRow({ nextSubmitAt: new Date(T0) }));
    await runShopPaymentTick(off.shop, 2);
    expect((await getProof(off, uid(0x401)))?.nextSubmitAt?.getTime()).toBe(T0);
  });

  it('skips a proof that disappeared during its submit', async () => {
    const h = harness();
    await seed(h);
    await insertProofs(h, proofRow({ nextSubmitAt: new Date(T0) }));
    h.orchestra.submit.mockImplementationOnce(async () => {
      await h.store.transaction((tx) => tx.deleteProof(uid(0x401)));
      return { kind: 'unresolved', retryable: true };
    });
    await runShopPaymentTick(h.shop, 2);
    expect(await proofsOf(h)).toEqual([]);
  });
});

describe('duty 7: stuck proofs', () => {
  it('marks unresolved proofs past give_up_at stuck and leaves inconsistent rows', async () => {
    const h = harness();
    await seed(h);
    await insertProofs(
      h,
      proofRow({ giveUpAt: new Date(T0), nextSubmitAt: new Date(T0 + 60_000) }),
      proofRow({ id: uid(0x402), txHash: H2, giveUpAt: new Date(T0), submitStopped: true }),
    );
    const calls = recordTxCalls(h);
    await runShopPaymentTick(h.shop, 2);
    // Each row: the payment row, then its proof rows, then the write; no account row.
    expect(calls).toEqual([
      'lockPayment',
      'lockProofs',
      'updateProof',
      'lockPayment',
      'lockProofs',
    ]);
    expect(await getProof(h, uid(0x401))).toMatchObject({
      result: 'stuck',
      nextSubmitAt: null,
      resolvedAt: new Date(T0),
    });
    expect((await getProof(h, uid(0x402)))?.result).toBeNull();
    expect(loggedEvents(warn).filter((line) => line['event'] === 'shop.alert.proof_stuck')).toEqual(
      [
        expect.objectContaining({
          paymentId: PAYMENT_ID,
          proofId: uid(0x401),
          offerId: OFFER_USDT,
          quoteId: QUOTE_ID,
          providerRef: 'q-usdt-pol',
        }),
      ],
    );
    expect(
      loggedEvents(warn).find((line) => line['event'] === 'shop.alert.proof_stuck'),
    ).not.toHaveProperty('orderId');
  });
});

describe('duty 8: order status', () => {
  const ordered = {
    providerOrder: 'o1',
    orderStatus: 'processing',
    orderFoundAt: new Date(T0 - 1_000),
    nextStatusAt: new Date(T0),
  };

  it('reads only on even ticks and only with Orchestra', async () => {
    const h = harness();
    await seed(h);
    await insertProofs(h, proofRow(ordered));
    await runShopPaymentTick(h.shop, 1);
    expect(h.orchestra.status).not.toHaveBeenCalled();
    const off = harness({ orchestra: false });
    await seed(off);
    await insertProofs(off, proofRow(ordered));
    await runShopPaymentTick(off.shop, 2);
    expect((await getProof(off, uid(0x401)))?.nextStatusAt?.getTime()).toBe(T0);
  });

  it('applies a status, every 10 s for 10 min and then every 60 s, until final', async () => {
    const h = harness();
    await seed(h);
    await insertProofs(h, proofRow(ordered));
    h.orchestra.status.mockResolvedValue({
      ok: true,
      order: { id: 'o1', status: 'swapping', supersededByOperationId: 'o1' },
    });
    await runShopPaymentTick(h.shop, 2);
    expect(h.orchestra.status).toHaveBeenCalledWith('o1', 5_000, {
      paymentId: PAYMENT_ID,
      proofId: uid(0x401),
      offerId: OFFER_USDT,
      quoteId: QUOTE_ID,
      providerRef: 'q-usdt-pol',
      orderId: 'o1',
    });
    expect(await getProof(h, uid(0x401))).toMatchObject({
      orderStatus: 'swapping',
      result: 'accepted',
      nextStatusAt: new Date(T0 + 10_000),
    });
    expect(await getPayment(h)).toMatchObject({
      status: 'accepted',
      acceptedAt: new Date(T0),
      endReason: null,
    });
    h.clock.now = T0 + 600_000;
    await runShopPaymentTick(h.shop, 2);
    expect((await getProof(h, uid(0x401)))?.nextStatusAt?.getTime()).toBe(T0 + 660_000);
    h.clock.now = T0 + 660_000;
    h.orchestra.status.mockResolvedValue({
      ok: true,
      order: { id: 'o1', status: 'refunded', supersededByOperationId: null },
    });
    await runShopPaymentTick(h.shop, 2);
    expect(await getProof(h, uid(0x401))).toMatchObject({ result: 'refunded', nextStatusAt: null });
    expect(await getPayment(h)).toMatchObject({
      status: 'ended',
      endReason: 'orchestra_refunded',
      endedAt: new Date(T0 + 660_000),
    });
  });

  it('stops reading a final order or one followed for 24 h without a call', async () => {
    const h = harness();
    await seed(h);
    await insertProofs(
      h,
      proofRow({ ...ordered, orderStatus: 'completed' }),
      proofRow({
        ...ordered,
        id: uid(0x402),
        txHash: H2,
        providerOrder: 'o2',
        orderFoundAt: null,
        createdAt: new Date(T0 - 86_400_000),
      }),
      proofRow({
        ...ordered,
        id: uid(0x403),
        txHash: txHash('a3'),
        providerOrder: 'o3',
        orderFoundAt: null,
        nextStatusAt: new Date(T0 + 1),
      }),
    );
    h.clock.now = T0 + 1;
    h.orchestra.status.mockResolvedValue({ ok: true, order: null });
    await runShopPaymentTick(h.shop, 2);
    expect((await getProof(h, uid(0x401)))?.nextStatusAt).toBeNull();
    expect((await getProof(h, uid(0x402)))?.nextStatusAt).toBeNull();
    expect(loggedEvents(warn)).toContainEqual(
      expect.objectContaining({
        event: 'shop.alert.order_stuck',
        paymentId: PAYMENT_ID,
        proofId: uid(0x402),
        offerId: OFFER_USDT,
        quoteId: QUOTE_ID,
        providerRef: 'q-usdt-pol',
        orderId: 'o2',
      }),
    );
    expect(h.orchestra.status).toHaveBeenCalledTimes(1);
    expect((await getProof(h, uid(0x403)))?.nextStatusAt?.getTime()).toBe(T0 + 10_001);
  });

  it('waits on budget, retries an error, and applies a final status that names a superseding order', async () => {
    const h = harness();
    await seed(h);
    await insertProofs(h, proofRow(ordered));
    h.orchestra.status.mockResolvedValueOnce({ ok: false, reason: 'budget' });
    await runShopPaymentTick(h.shop, 2);
    expect((await getProof(h, uid(0x401)))?.nextStatusAt?.getTime()).toBe(T0);
    h.orchestra.status.mockResolvedValueOnce({ ok: false, reason: 'error' });
    await runShopPaymentTick(h.shop, 2);
    expect((await getProof(h, uid(0x401)))?.nextStatusAt?.getTime()).toBe(T0 + 10_000);
    h.clock.now = T0 + 10_000;
    h.orchestra.status.mockResolvedValueOnce({
      ok: true,
      order: { id: 'o1', status: 'failed', supersededByOperationId: 'o9' },
    });
    await runShopPaymentTick(h.shop, 2);
    // Only an unfulfilled status with a successor is a replaced order.
    expect(await getProof(h, uid(0x401))).toMatchObject({
      providerOrder: 'o1',
      orderStatus: 'failed',
      supersededByOrder: null,
      result: 'failed',
      nextStatusAt: null,
    });
  });

  it('a replaced order: an accepted proof keeps its order and stays accepted, the duty stops without order_stuck, and the successor wait starts', async () => {
    const h = harness();
    await seed(h, { status: 'accepted', acceptedAt: new Date(T0) });
    await insertProofs(h, proofRow({ ...ordered, result: 'accepted' }));
    h.orchestra.status.mockResolvedValueOnce({
      ok: true,
      order: { id: 'o1', status: 'unfulfilled', supersededByOperationId: 'o9' },
    });
    const calls = recordTxCalls(h);
    await runShopPaymentTick(h.shop, 2);
    expect(calls.slice(0, 2)).toEqual(['lockPayment', 'lockProofs']);
    expect(calls).not.toContain('lockAccount');
    expect(await getProof(h, uid(0x401))).toMatchObject({
      providerOrder: 'o1',
      orderStatus: 'unfulfilled',
      supersededByOrder: 'o9',
      result: 'accepted',
      nextStatusAt: null,
    });
    expect(await getPayment(h)).toMatchObject({
      status: 'accepted',
      successorWaitUntil: new Date(T0 + SHOP_SUCCESSOR_WAIT_MS),
      nextHistoryAt: new Date(T0),
    });
    expect(SHOP_SUCCESSOR_WAIT_MS).toBe(86_400_000);
    expect(events()).not.toContain('shop.alert.order_stuck');
    // The duty no longer reads it.
    h.clock.now = T0 + 86_400_000;
    await runShopPaymentTick(h.shop, 2);
    expect(h.orchestra.status).toHaveBeenCalledTimes(1);
    expect(events()).not.toContain('shop.alert.order_stuck');
  });

  it('a replaced order: a proof never accepted stays held and answers 503; a later wait and a set next_history_at are kept', async () => {
    const h = harness();
    const later = new Date(T0 + 2 * SHOP_SUCCESSOR_WAIT_MS);
    await seed(h, { successorWaitUntil: later, nextHistoryAt: new Date(T0 + 5_000) });
    await insertProofs(h, proofRow(ordered));
    h.orchestra.status.mockResolvedValueOnce({
      ok: true,
      order: { id: 'o1', status: 'unfulfilled', supersededByOperationId: 'o9' },
    });
    await runShopPaymentTick(h.shop, 2);
    const proof = await getProof(h, uid(0x401));
    expect(proof).toMatchObject({ result: null, supersededByOrder: 'o9', nextStatusAt: null });
    expect(proofResponse(proof!).status).toBe(503);
    expect(await getPayment(h)).toMatchObject({
      successorWaitUntil: later,
      nextHistoryAt: new Date(T0 + 5_000),
    });
    // A held proof is not marked stuck.
    h.clock.now = T0 + 86_400_001;
    await runShopPaymentTick(h.shop, 2);
    expect((await getProof(h, uid(0x401)))?.result).toBeNull();
  });

  it('a replaced order moves an earlier successor wait 24 h ahead', async () => {
    const h = harness();
    await seed(h, { successorWaitUntil: new Date(T0 - 1) });
    await insertProofs(h, proofRow(ordered));
    h.orchestra.status.mockResolvedValueOnce({
      ok: true,
      order: { id: 'o1', status: 'unfulfilled', supersededByOperationId: 'o9' },
    });
    await runShopPaymentTick(h.shop, 2);
    expect((await getPayment(h))?.successorWaitUntil).toEqual(
      new Date(T0 + SHOP_SUCCESSOR_WAIT_MS),
    );
  });

  it.each([
    ['a progressing status with a successor', 'processing', 'o9'],
    ['unfulfilled naming itself', 'unfulfilled', 'o1'],
    ['unfulfilled without a successor', 'unfulfilled', null],
  ])('treats %s as a status in progress', async (_name, status, successor) => {
    const h = harness();
    await seed(h);
    await insertProofs(h, proofRow(ordered));
    h.orchestra.status.mockResolvedValueOnce({
      ok: true,
      order: { id: 'o1', status, supersededByOperationId: successor },
    });
    await runShopPaymentTick(h.shop, 2);
    expect(await getProof(h, uid(0x401))).toMatchObject({
      providerOrder: 'o1',
      orderStatus: status,
      supersededByOrder: null,
      nextStatusAt: new Date(T0 + 10_000),
    });
    expect((await getPayment(h))?.successorWaitUntil).toBeNull();
  });

  it('stops following a proof refused as tx_used', async () => {
    const h = harness();
    await seed(h);
    await insertProofs(
      h,
      proofRow({ ...ordered, offerId: OFFER_USDC, result: 'refused', refusal: 'tx_used' }),
    );
    await runShopPaymentTick(h.shop, 2);
    expect(h.orchestra.status).not.toHaveBeenCalled();
  });

  it('ignores a read whose proof changed or disappeared meanwhile', async () => {
    const h = harness();
    await seed(h);
    await insertProofs(
      h,
      proofRow(ordered),
      proofRow({
        ...ordered,
        id: uid(0x402),
        txHash: H2,
        providerOrder: 'o2',
        nextStatusAt: new Date(T0 + 1),
      }),
    );
    h.orchestra.status.mockImplementationOnce(async () => {
      await h.store.transaction((tx) =>
        tx.updateProof(uid(0x401), {}, { providerOrder: 'ox', nextStatusAt: null }),
      );
      return { ok: true, order: { id: 'o1', status: 'completed', supersededByOperationId: null } };
    });
    await runShopPaymentTick(h.shop, 2);
    expect(await getProof(h, uid(0x401))).toMatchObject({
      providerOrder: 'ox',
      orderStatus: 'processing',
    });
    h.clock.now = T0 + 1;
    h.orchestra.status.mockImplementationOnce(async () => {
      await h.store.transaction((tx) => tx.deleteProof(uid(0x402)));
      return { ok: true, order: null };
    });
    await runShopPaymentTick(h.shop, 2);
    expect(await getProof(h, uid(0x402))).toBeNull();
  });
  describe('a stop decided on the selection holds only while the proof is unchanged', () => {
    const lapsed = { ...ordered, orderFoundAt: new Date(T0 - 86_400_000) };

    function stuckAlerts(): Record<string, unknown>[] {
      return loggedEvents(warn).filter((line) => line['event'] === 'shop.alert.order_stuck');
    }

    it('a proof whose order was finalised meanwhile: no alert, no write', async () => {
      const h = harness();
      await seed(h);
      await insertProofs(h, proofRow(lapsed));
      const writes = afterSelection(h, 'status', () =>
        h.store.transaction((tx) =>
          tx.updateProof(uid(0x401), {}, { orderStatus: 'completed', nextStatusAt: null }),
        ),
      );
      await runShopPaymentTick(h.shop, 2);
      expect(writes).toEqual([]);
      expect(stuckAlerts()).toEqual([]);
      expect(h.orchestra.status).not.toHaveBeenCalled();
    });

    it.each([
      [
        'another order',
        {
          providerOrder: 'o9',
          orderFoundAt: new Date(T0),
          nextStatusAt: new Date(T0 + 10_000),
        },
      ],
      ['a successor', { orderStatus: 'unfulfilled', supersededByOrder: 'o9', nextStatusAt: null }],
      ['a later found order', { orderFoundAt: new Date(T0 - 1_000) }],
    ])('a proof that meanwhile holds %s: no alert, no write', async (_name, patch) => {
      const h = harness();
      await seed(h);
      await insertProofs(h, proofRow(lapsed));
      const before = { ...proofRow(lapsed), ...patch };
      const writes = afterSelection(h, 'status', () =>
        h.store.transaction((tx) => tx.updateProof(uid(0x401), {}, patch)),
      );
      await runShopPaymentTick(h.shop, 2);
      expect(writes).toEqual([]);
      expect(stuckAlerts()).toEqual([]);
      expect((await getProof(h, uid(0x401)))?.nextStatusAt).toEqual(before.nextStatusAt);
    });

    it('a final order replaced by another meanwhile keeps its new schedule', async () => {
      const h = harness();
      await seed(h);
      await insertProofs(h, proofRow({ ...ordered, orderStatus: 'completed' }));
      const writes = afterSelection(h, 'status', () =>
        h.store.transaction((tx) =>
          tx.updateProof(
            uid(0x401),
            {},
            { providerOrder: 'o9', orderStatus: 'processing', nextStatusAt: new Date(T0 + 10_000) },
          ),
        ),
      );
      await runShopPaymentTick(h.shop, 2);
      expect(writes).toEqual([]);
      expect((await getProof(h, uid(0x401)))?.nextStatusAt?.getTime()).toBe(T0 + 10_000);
    });

    it('two containers that selected the same lapsed row log one alert', async () => {
      const h = harness();
      await seed(h);
      await insertProofs(h, proofRow(lapsed));
      // The second container runs its whole tick between the first one's
      // selection and its write.
      const writes = afterSelection(h, 'status', () => runShopPaymentTick(h.shop, 2));
      await runShopPaymentTick(h.shop, 2);
      expect(writes).toEqual([]);
      expect(stuckAlerts()).toEqual([
        expect.objectContaining({ proofId: uid(0x401), orderId: 'o1' }),
      ]);
      expect((await getProof(h, uid(0x401)))?.nextStatusAt).toBeNull();
    });
  });
});

describe('startShopPaymentWorker', () => {
  it('ticks now and on the interval, numbering ticks from 1, without overlap', async () => {
    vi.useFakeTimers();
    const h = harness();
    await seed(h, { nextHistoryAt: new Date(T0) });
    await h.store.transaction((tx) => tx.markDetailIssued(OFFER_USDT, T0));
    let release: () => void = () => undefined;
    h.orchestra.history.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = () => resolve({ ok: true, orders: [], full: false });
        }),
    );
    const worker = startShopPaymentWorker(h.shop, 1_000);
    await vi.advanceTimersByTimeAsync(0);
    expect(h.orchestra.history).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(3_000);
    expect(h.orchestra.history).toHaveBeenCalledTimes(1);
    release();
    await vi.advanceTimersByTimeAsync(0);
    h.clock.now += 60_000;
    await vi.advanceTimersByTimeAsync(1_000);
    expect(h.orchestra.history).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(h.orchestra.history).toHaveBeenCalledTimes(2);
    worker.stop();
    h.clock.now += 10_000;
    await vi.advanceTimersByTimeAsync(5_000);
    expect(h.orchestra.history).toHaveBeenCalledTimes(2);
  });

  it('logs a rejected tick and uses the 2 s default interval', async () => {
    vi.useFakeTimers();
    const h = harness();
    const spy = vi
      .spyOn(h.store, 'transaction')
      .mockRejectedValue(Object.assign(new Error('db down'), { code: 'ECONNRESET' }));
    const worker = startShopPaymentWorker(h.shop);
    await vi.advanceTimersByTimeAsync(0);
    expect(loggedEvents(warn)).toContainEqual(
      expect.objectContaining({ event: 'shop.worker.tick.failed', code: 'ECONNRESET' }),
    );
    await vi.advanceTimersByTimeAsync(1_999);
    expect(spy).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(spy).toHaveBeenCalledTimes(2);
    worker.stop();
  });
});
