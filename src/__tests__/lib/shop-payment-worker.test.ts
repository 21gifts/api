import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import {
  SHOP_WORKER_CALL_TIMEOUT_MS,
  SHOP_WORKER_INTERVAL_MS,
  runShopPaymentTick,
  startShopPaymentWorker,
} from '@/lib/shop-payment-worker';
import type { ShopProofLookup } from '@/lib/shop-payment-store';
import {
  AMOUNT_IN,
  DEPOSIT_USDT,
  OFFER_ETH,
  OFFER_USDT,
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

  it('moves a proof to the order recovered from its order', async () => {
    const h = harness();
    await seed(h, { nextHistoryAt: new Date(T0) });
    await insertProofs(
      h,
      proofRow({
        providerOrder: 'o-old',
        orderStatus: 'failed',
        result: 'failed',
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
          sourceTxHash: H1,
          recoveredFromOperationId: 'o-old',
          supersededByOperationId: null,
        },
      ],
    });
    await runShopPaymentTick(h.shop, 1);
    expect(await proofsOf(h)).toEqual([
      expect.objectContaining({
        id: uid(0x401),
        providerOrder: 'o-next',
        orderStatus: 'processing',
        nextStatusAt: new Date(T0 + 10_000),
      }),
    ]);
    expect(await getPayment(h)).toMatchObject({
      historyOffset: 200,
      nextHistoryAt: new Date(T0 + 10_000),
    });
  });

  it('merges a moved proof into the row that already holds the recovered order', async () => {
    const h = harness();
    await seed(h, { nextHistoryAt: new Date(T0), status: 'accepted', acceptedAt: new Date(T0) });
    await insertProofs(
      h,
      proofRow({
        txHash: H1,
        providerOrder: 'o-old',
        orderStatus: 'processing',
        orderFoundAt: new Date(T0 - 1_000),
        result: 'accepted',
      }),
      proofRow({
        id: uid(0x402),
        source: 'detected',
        txHash: H1,
        logIndex: null,
        transferAmount: null,
        providerOrder: 'o-next',
        orderStatus: 'confirming',
        orderFoundAt: new Date(T0 - 500),
        createdAt: new Date(T0 + 1),
      }),
      proofRow({
        id: uid(0x403),
        txHash: H2,
        providerOrder: 'o-self',
        orderStatus: 'processing',
        createdAt: new Date(T0 + 2),
      }),
    );
    h.orchestra.history.mockResolvedValueOnce({
      ok: true,
      full: false,
      orders: [
        {
          id: 'o-next',
          quoteId: 'q-usdt-pol',
          status: 'swapping',
          sourceTxHash: H1,
          recoveredFromOperationId: 'o-old',
          supersededByOperationId: null,
        },
        {
          id: 'o-self',
          quoteId: 'q-usdt-pol',
          status: 'refunded',
          sourceTxHash: H2,
          recoveredFromOperationId: 'o-self',
          supersededByOperationId: null,
        },
      ],
    });
    await runShopPaymentTick(h.shop, 1);
    expect(await proofsOf(h)).toEqual([
      expect.objectContaining({
        id: uid(0x401),
        logIndex: 3,
        providerOrder: 'o-next',
        orderStatus: 'swapping',
        result: 'accepted',
      }),
      expect.objectContaining({
        id: uid(0x403),
        providerOrder: 'o-self',
        orderStatus: 'processing',
      }),
    ]);
    expect((await getPayment(h))?.status).toBe('accepted');
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
    // A failed read after the watch ended keeps the offset and reads again.
    h.orchestra.history.mockResolvedValueOnce({ ok: false, reason: 'error' });
    await runShopPaymentTick(h.shop, 1);
    expect(await getPayment(h)).toMatchObject({
      historyOffset: 200,
      nextHistoryAt: new Date(ended + 10_000),
    });
    // So does a full page; the first successful short page ends the watch.
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
    expect(await getProof(h, uid(0x401))).toMatchObject({
      sentAt: new Date(T0),
      nextReceiptAt: new Date(T0 + 30_000),
      nextSubmitAt: new Date(T0 + 10_000),
    });
    expect(await getProof(h, uid(0x402))).toMatchObject({ result: 'refused', nextReceiptAt: null });
    expect(await getProof(h, uid(0x403))).toMatchObject({
      sentAt: null,
      nextReceiptAt: new Date(T0 + 120_000),
    });
  });

  it('resends a hex transaction without a receipt and refuses it once unknown for 10 minutes', async () => {
    const h = harness();
    await seed(h);
    const sent = { ...due, source: 'hex' as const, logIndex: null };
    await insertProofs(
      h,
      proofRow({ ...sent, rawHex: 'ab', sentAt: new Date(T0 - 60_000) }),
      proofRow({
        ...sent,
        id: uid(0x402),
        txHash: H2,
        rawHex: 'cd',
        sentAt: new Date(T0 - 60_000),
      }),
      proofRow({
        ...sent,
        id: uid(0x403),
        txHash: txHash('a3'),
        rawHex: 'ef',
        sentAt: new Date(T0 - 600_000),
      }),
      proofRow({
        ...sent,
        id: uid(0x404),
        txHash: txHash('a4'),
        rawHex: 'ef',
        sentAt: new Date(T0 - 600_000),
      }),
    );
    h.rpc['eth_sendRawTransaction'] = (params) =>
      params[0] === '0xcd' ? { error: 'invalid sender' } : { error: 'already known' };
    h.rpc['eth_getTransactionByHash'] = (params) => ({
      result: params[0] === txHash('a4') ? { hash: params[0] } : null,
    });
    // A sent row may take 3 calls, so each tick takes one row within its 4 calls.
    const perTick: number[] = [];
    for (let tick = 0; tick < 4; tick += 1) {
      const before = h.rpcCalls.length;
      await runShopPaymentTick(h.shop, 2);
      perTick.push(h.rpcCalls.length - before);
    }
    expect([...perTick].sort()).toEqual([2, 2, 2, 3]);
    expect(await getProof(h, uid(0x401))).toMatchObject({
      result: null,
      nextReceiptAt: new Date(T0 + 120_000),
    });
    expect(await getProof(h, uid(0x402))).toMatchObject({ result: 'refused', nextReceiptAt: null });
    expect(await getProof(h, uid(0x403))).toMatchObject({
      result: 'refused',
      refusal: 'hex_rejected',
      nextReceiptAt: null,
    });
    expect(await getProof(h, uid(0x404))).toMatchObject({
      result: null,
      nextReceiptAt: new Date(T0 + 120_000),
    });
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
});

describe('duty 6: submits', () => {
  it('submits after 10 s, 30 s, and 60 s, then every 5 min, until resolved', async () => {
    const h = harness();
    await seed(h);
    await insertProofs(h, proofRow({ nextSubmitAt: new Date(T0) }));
    await runShopPaymentTick(h.shop, 2);
    expect(h.orchestra.submit).toHaveBeenCalledWith('q-usdt-pol', H1, uid(0x402), 'watcher', 5_000);
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
    await runShopPaymentTick(h.shop, 2);
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
        }),
      ],
    );
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
    expect(h.orchestra.status).toHaveBeenCalledWith('o1', 5_000);
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
        proofId: uid(0x402),
        orderId: 'o2',
      }),
    );
    expect(h.orchestra.status).toHaveBeenCalledTimes(1);
    expect((await getProof(h, uid(0x403)))?.nextStatusAt?.getTime()).toBe(T0 + 10_001);
  });

  it('waits on budget, retries an error, and follows a superseding order', async () => {
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
    expect(await getProof(h, uid(0x401))).toMatchObject({
      providerOrder: 'o9',
      orderStatus: null,
      result: null,
      nextStatusAt: new Date(T0 + 10_000),
    });
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
