import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { decodeSignedEvmTransaction } from '@/lib/evm-transfer';
import { shopMethodByName } from '@/lib/shop-payment';
import {
  SHOP_PROOF_BUDGET_MS,
  SHOP_RPC_TIMEOUT_MS,
  applyProofOrder,
  followProofOrder,
  handleShopProof,
  proofResponse,
  readProofReceipt,
  refuseHexProof,
  retryStuckProof,
  sendHexProof,
  shopProofContext,
  storeProof,
  submitProof,
  submitProofAttempt,
  verifyHexProof,
  verifyTxProof,
  type ShopProofQuery,
} from '@/lib/shop-proof';
import {
  ACCOUNT,
  AMOUNT_IN,
  DEPOSIT_ETH,
  DEPOSIT_OTHER,
  DEPOSIT_USDC,
  DEPOSIT_USDT,
  ETH_USDT,
  OFFER_OTHER,
  OFFER_USDC,
  OFFER_USDT,
  OTHER_LOG,
  OTHER_QUOTE_ID,
  PAYMENT_ID,
  POLYGON_RPC,
  POLYGON_USDC,
  POLYGON_USDT,
  QUOTE_ID,
  T0,
  getPayment,
  getProof,
  harness,
  insertProofs,
  loggedEvents,
  offerRow,
  proofRow,
  proofsOf,
  receiptJson,
  seed,
  signedTransfer,
  transferLog,
  txHash,
  uid,
  userOpReceiptJson,
  type Harness,
} from '../helpers/shop-proof-fixture';

const POLYGON = shopMethodByName('Polygon')!;
const H1 = txHash('a1');
const H2 = txHash('a2');
const BUNDLE = txHash('b1');

let warn: MockInstance;

beforeEach(() => {
  warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('constants', () => {
  it('gives a proof request 18 s and each of its RPC calls 3 s', () => {
    expect(SHOP_PROOF_BUDGET_MS).toBe(18_000);
    expect(SHOP_RPC_TIMEOUT_MS).toBe(3_000);
  });
});

function events(): string[] {
  return loggedEvents(warn).map((line) => String(line['event']));
}

function prove(h: Harness, query: Partial<ShopProofQuery>, overLimit = false): Promise<Response> {
  return handleShopProof(
    h.shop,
    ACCOUNT,
    'shop',
    {
      quote: QUOTE_ID,
      method: 'Polygon',
      asset: 'USDT',
      tx: null,
      hex: null,
      repeated: false,
      ...query,
    },
    overLimit,
  );
}

async function answer(
  response: Response,
): Promise<{ status: number; body: Record<string, unknown> }> {
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

function receiptFor(hash: string, logs: unknown[], status = '0x1'): Harness['rpc'][string] {
  return (params) => ({ result: params[0] === hash ? receiptJson(hash, status, logs) : null });
}

function usdtLog(value = BigInt(AMOUNT_IN), index = 3): Record<string, unknown> {
  return transferLog(POLYGON_USDT, DEPOSIT_USDT, value, index);
}

async function context(h: Harness) {
  const found = await shopProofContext(h.shop, QUOTE_ID);
  return found!;
}

describe('proofResponse', () => {
  it.each([
    [{ result: 'accepted' as const }, 200, undefined],
    [{ result: 'superseded' as const }, 400, 'Another transfer is paying this payment'],
    [{ result: 'late' as const }, 400, 'Invoice expired'],
    [{ result: 'refunded' as const }, 400, 'The transfer was refunded'],
    [{ result: 'failed' as const }, 400, 'The transfer was not completed'],
    [{ result: 'refused' as const, refusal: 'tx_used' as const }, 400, 'Transaction already used'],
    [{ result: 'refused' as const, refusal: 'mismatch' as const }, 400, 'Payment was not accepted'],
    [{ result: 'stuck' as const }, 503, 'Payment is being confirmed'],
    [{ result: null }, 503, 'Payment is being confirmed'],
  ])('answers %j', async (partial, status, text) => {
    const { status: got, body } = await answer(proofResponse(proofRow(partial)));
    expect(got).toBe(status);
    if (text === undefined) {
      expect(body).toEqual({ txId: H1 });
    } else {
      expect(body).toEqual({
        statusCode: status,
        message: text,
        error: text,
        status: 'ERROR',
        reason: text,
      });
    }
  });
});

describe('handleShopProof request checks', () => {
  it('refuses a repeated key with 400, or 503 over the limit', async () => {
    const h = harness();
    await seed(h);
    expect((await answer(await prove(h, { tx: H1, repeated: true }))).body['reason']).toBe(
      'Payment was not accepted',
    );
    const over = await answer(await prove(h, { tx: H1, repeated: true }, true));
    expect(over).toMatchObject({ status: 503, body: { reason: 'Too many requests' } });
  });

  it.each([[null], ['nope'], [uid(0x999)], [OTHER_QUOTE_ID]])(
    'answers 404 Quote expired for quote %j',
    async (quote) => {
      const h = harness();
      await seed(h);
      expect(await answer(await prove(h, { quote, tx: H1 }))).toMatchObject({
        status: 404,
        body: { reason: 'Quote expired' },
      });
      expect((await prove(h, { quote, tx: H1 }, true)).status).toBe(503);
    },
  );

  it('accepts a quote id in upper case', async () => {
    const h = harness();
    await seed(h);
    const response = await prove(h, { quote: QUOTE_ID.toUpperCase(), tx: H1 });
    expect(await answer(response)).toMatchObject({
      status: 503,
      body: { reason: 'Transfer not found yet' },
    });
  });

  it.each([
    [{ method: null, tx: H1 }],
    [{ method: 'Lightning', tx: H1 }],
    [{}],
    [{ tx: H1, hex: 'ab'.repeat(60) }],
    [{ tx: 'xyz' }],
    [{ tx: `0x${'a'.repeat(63)}` }],
    [{ hex: 'ab'.repeat(49) }],
    [{ hex: 'ab'.repeat(2049) }],
    [{ hex: 'zz'.repeat(60) }],
    [{ hex: 'abc'.repeat(40) }],
    [{ hex: `0x${'ab'.repeat(60)}` }],
  ])('answers 400 for %j', async (query) => {
    const h = harness();
    await seed(h);
    expect(await answer(await prove(h, query))).toMatchObject({
      status: 400,
      body: { reason: 'Payment was not accepted' },
    });
    expect((await prove(h, query, true)).status).toBe(503);
    expect(h.rpcCalls).toEqual([]);
  });

  it('answers 503 Too many requests over the limit when the proof is not stored', async () => {
    const h = harness();
    await seed(h);
    expect(await answer(await prove(h, { tx: H1 }, true))).toMatchObject({
      status: 503,
      body: { reason: 'Too many requests' },
    });
    expect(h.rpcCalls).toEqual([]);
  });

  it('answers a stored proof over the limit from its row without any call', async () => {
    const h = harness();
    await seed(h);
    await insertProofs(h, proofRow({ txHash: H1, result: 'accepted', providerOrder: 'o1' }));
    expect(await answer(await prove(h, { tx: H1 }, true))).toEqual({
      status: 200,
      body: { txId: H1 },
    });
    expect(h.rpcCalls).toEqual([]);
    expect(h.orchestra.submit).not.toHaveBeenCalled();
  });

  it('without shop config answers a stored row as it stands and a new proof 503', async () => {
    const h = harness({ config: false });
    await seed(h);
    await insertProofs(
      h,
      proofRow({ txHash: H1, logIndex: null, source: 'detected', transferAmount: null }),
      proofRow({ id: uid(0x402), txHash: txHash('a3'), result: 'accepted', providerOrder: 'o1' }),
    );
    expect((await prove(h, { tx: H1 })).status).toBe(503);
    expect(await answer(await prove(h, { tx: txHash('a3') }))).toEqual({
      status: 200,
      body: { txId: txHash('a3') },
    });
    expect(await answer(await prove(h, { tx: H2 }))).toMatchObject({
      status: 503,
      body: { reason: 'Payment is being confirmed' },
    });
    expect(await proofsOf(h)).toHaveLength(2);
    expect(h.rpcCalls).toEqual([]);
    expect(h.orchestra.submit).not.toHaveBeenCalled();
  });

  it('answers 503 for a new proof of a method whose chain has no RPC endpoint', async () => {
    const h = harness();
    await seed(h);
    expect(await answer(await prove(h, { method: 'base', tx: H1 }))).toMatchObject({
      status: 503,
      body: { reason: 'Payment is being confirmed' },
    });
    expect(await proofsOf(h)).toEqual([]);
    expect(h.rpcCalls).toEqual([]);
  });
});

describe('handleShopProof with tx', () => {
  it('verifies, stores, submits, and answers 200 once the order progresses', async () => {
    const h = harness();
    await seed(h);
    h.rpc['eth_getTransactionReceipt'] = receiptFor(H1, [OTHER_LOG, usdtLog()]);
    h.orchestra.submit.mockResolvedValueOnce({
      kind: 'order',
      orderId: 'o1',
      status: 'processing',
    });
    const response = await prove(h, { tx: `0X${'A1'.repeat(32)}` });
    expect(await answer(response)).toEqual({ status: 200, body: { txId: H1 } });
    expect(response.headers.get('cache-control')).toBe('no-store');
    const [proof] = await proofsOf(h);
    expect(proof).toMatchObject({
      source: 'tx',
      txHash: H1,
      logIndex: 3,
      transferAmount: AMOUNT_IN,
      result: 'accepted',
      providerOrder: 'o1',
    });
    expect(h.orchestra.submit).toHaveBeenCalledWith(
      'q-usdt-pol',
      H1,
      proof!.idempotencyKey,
      'proof-first',
      10_000,
    );
    expect((await getPayment(h))?.status).toBe('accepted');
    expect(events()).toEqual(
      expect.arrayContaining(['shop.proof.stored', 'shop.proof.submitted', 'shop.proof.accepted']),
    );
  });

  it('accepts the 64 characters without 0x', async () => {
    const h = harness();
    await seed(h);
    h.rpc['eth_getTransactionReceipt'] = receiptFor(H1, [usdtLog()]);
    expect((await prove(h, { tx: 'a1'.repeat(32) })).status).toBe(503);
    expect((await proofsOf(h))[0]?.txHash).toBe(H1);
  });

  it('prefers the log whose value is amountIn, else the first log', async () => {
    const h = harness();
    await seed(h);
    h.rpc['eth_getTransactionReceipt'] = receiptFor(H1, [
      usdtLog(5n, 1),
      usdtLog(BigInt(AMOUNT_IN), 2),
    ]);
    await prove(h, { tx: H1 });
    h.rpc['eth_getTransactionReceipt'] = receiptFor(H2, [usdtLog(5n, 1), usdtLog(7n, 2)]);
    await prove(h, { tx: H2 });
    const rows = await proofsOf(h);
    expect(rows.map((row) => [row.txHash, row.logIndex, row.transferAmount])).toEqual([
      [H1, 2, AMOUNT_IN],
      [H2, 1, '5'],
    ]);
  });

  it('takes the fallback log in receipt order across the offers of the method', async () => {
    const h = harness();
    await seed(h);
    h.rpc['eth_getTransactionReceipt'] = receiptFor(H1, [
      usdtLog(5n, 2),
      transferLog(POLYGON_USDC, DEPOSIT_USDC, 7n, 1),
    ]);
    await prove(h, { tx: H1, asset: null });
    expect(
      (await proofsOf(h)).map((row) => [row.offerId, row.logIndex, row.transferAmount]),
    ).toEqual([[OFFER_USDC, 1, '7']]);
  });

  it('counts only offers of the requested asset', async () => {
    const h = harness();
    await seed(h);
    h.rpc['eth_getTransactionReceipt'] = receiptFor(H1, [
      transferLog(POLYGON_USDC, DEPOSIT_USDC, BigInt(AMOUNT_IN), 4),
    ]);
    expect((await prove(h, { tx: H1 })).status).toBe(400);
    expect((await prove(h, { tx: H1, asset: 'usdc' })).status).toBe(503);
    expect((await proofsOf(h))[0]?.offerId).toBe(OFFER_USDC);
  });

  it('stores a lookup row and answers 503 when no receipt is found', async () => {
    const h = harness();
    await seed(h);
    expect(await answer(await prove(h, { tx: H1 }))).toMatchObject({
      status: 503,
      body: { reason: 'Transfer not found yet' },
    });
    await prove(h, { tx: H1 });
    for (const byte of ['c1', 'c2', 'c3', 'c4']) {
      await prove(h, { tx: txHash(byte), asset: null });
    }
    const lookups = await h.store.transaction((tx) => tx.dueLookups(T0 + 60_000, 10));
    expect(lookups.map((row) => row.hash)).toEqual([H1, txHash('c1'), txHash('c2'), txHash('c3')]);
    expect(lookups[0]).toMatchObject({ method: 'Polygon', asset: 'USDT', chainId: 137, tries: 0 });
    expect(lookups[1]?.asset).toBeNull();
    expect(h.rpcCalls.map((call) => call.method).slice(0, 2)).toEqual([
      'eth_getTransactionReceipt',
      'eth_getUserOperationReceipt',
    ]);
  });

  it('caps a quote at 4 lookup rows, done ones included', async () => {
    const h = harness();
    await seed(h);
    for (const byte of ['c1', 'c2', 'c3', 'c4']) {
      await prove(h, { tx: txHash(byte) });
    }
    await h.store.transaction(async (tx) => {
      for (const row of await tx.dueLookups(T0 + 60_000, 10)) {
        await tx.updateLookup(row.id, { doneAt: new Date(T0) });
      }
    });
    expect(await answer(await prove(h, { tx: txHash('c5') }))).toMatchObject({
      status: 503,
      body: { reason: 'Transfer not found yet' },
    });
    expect(
      await h.store.transaction((tx) => tx.findLookup(137, txHash('c5'), QUOTE_ID)),
    ).toBeNull();
  });

  it('counts an RPC failure as not found', async () => {
    const h = harness();
    await seed(h);
    h.rpc['eth_getTransactionReceipt'] = () => 'transport';
    expect((await answer(await prove(h, { tx: H1 }))).body['reason']).toBe(
      'Transfer not found yet',
    );
    expect(h.rpcCalls.map((call) => call.method)).toEqual(['eth_getTransactionReceipt']);
    h.rpc['eth_getTransactionReceipt'] = () => ({ result: null });
    h.rpc['eth_getUserOperationReceipt'] = () => ({ error: 'method not found' });
    expect((await answer(await prove(h, { tx: H2 }))).body['reason']).toBe(
      'Transfer not found yet',
    );
  });

  it('skips the user-operation read when the budget is used up', async () => {
    const h = harness();
    await seed(h);
    h.rpc['eth_getTransactionReceipt'] = () => {
      h.clock.now += SHOP_PROOF_BUDGET_MS;
      return { result: null };
    };
    expect((await prove(h, { tx: H1 })).status).toBe(503);
    expect(h.rpcCalls.map((call) => call.method)).toEqual(['eth_getTransactionReceipt']);
  });

  it('refuses a failed transfer, a failed user operation, and a transfer without a matching log', async () => {
    const h = harness();
    await seed(h);
    h.rpc['eth_getTransactionReceipt'] = receiptFor(H1, [usdtLog()], '0x0');
    expect((await answer(await prove(h, { tx: H1 }))).body['reason']).toBe(
      'Payment was not accepted',
    );
    h.rpc['eth_getTransactionReceipt'] = () => ({ result: null });
    h.rpc['eth_getUserOperationReceipt'] = () => ({
      result: userOpReceiptJson(BUNDLE, false, [usdtLog()]),
    });
    expect((await prove(h, { tx: H2 })).status).toBe(400);
    h.rpc['eth_getUserOperationReceipt'] = () => ({
      result: userOpReceiptJson(BUNDLE, false, [usdtLog()], {
        status: '0x1',
        logs: [usdtLog(BigInt(AMOUNT_IN), 7)],
      }),
    });
    expect(await answer(await prove(h, { tx: txHash('a4') }))).toMatchObject({
      status: 400,
      body: { reason: 'Payment was not accepted' },
    });
    h.rpc['eth_getTransactionReceipt'] = receiptFor(txHash('a3'), [
      transferLog(POLYGON_USDT, DEPOSIT_OTHER, 1n, 1),
      transferLog(ETH_USDT, DEPOSIT_USDT, 1n, 2),
    ]);
    expect((await prove(h, { tx: txHash('a3') })).status).toBe(400);
    expect(await proofsOf(h)).toEqual([]);
  });

  it('answers Transaction already used when a proof of another quote holds every log', async () => {
    const h = harness();
    await seed(h);
    await insertProofs(
      h,
      proofRow({
        id: uid(0x4f1),
        offerId: OFFER_OTHER,
        paymentId: uid(2),
        txHash: H1,
        logIndex: 3,
      }),
    );
    h.rpc['eth_getTransactionReceipt'] = receiptFor(H1, [usdtLog()]);
    expect((await answer(await prove(h, { tx: H1 }))).body['reason']).toBe(
      'Transaction already used',
    );
  });

  it('takes a successful user operation from a bundle whose own status is 0x0, with its own log', async () => {
    const h = harness();
    await seed(h);
    h.rpc['eth_getUserOperationReceipt'] = () => ({
      result: userOpReceiptJson(BUNDLE, true, [usdtLog(BigInt(AMOUNT_IN), 4)], {
        status: '0x0',
        logs: [usdtLog(BigInt(AMOUNT_IN), 9)],
      }),
    });
    expect((await prove(h, { tx: H1 })).status).toBe(503);
    expect(await proofsOf(h)).toEqual([
      expect.objectContaining({ txHash: BUNDLE, userOpHash: H1, logIndex: 4 }),
    ]);
  });

  it('verifies a user-operation hash and finds it again by user_op_hash', async () => {
    const h = harness();
    await seed(h);
    h.rpc['eth_getUserOperationReceipt'] = (params) => ({
      result: params[0] === H1 ? userOpReceiptJson(BUNDLE, true, [usdtLog()]) : null,
    });
    expect((await prove(h, { tx: H1 })).status).toBe(503);
    const [proof] = await proofsOf(h);
    expect(proof).toMatchObject({ txHash: BUNDLE, userOpHash: H1, logIndex: 3 });
    h.rpcCalls.length = 0;
    h.clock.now += 3_000;
    h.orchestra.submit.mockResolvedValueOnce({ kind: 'order', orderId: 'o1', status: 'swapping' });
    expect((await prove(h, { tx: H1 })).status).toBe(200);
    expect(h.rpcCalls).toEqual([]);
    expect(h.orchestra.submit).toHaveBeenLastCalledWith(
      'q-usdt-pol',
      BUNDLE,
      proof!.idempotencyKey,
      'proof-repeat',
      10_000,
    );
  });

  it('fills a detected proof of the same transaction and offer instead of storing a second row', async () => {
    const h = harness();
    await seed(h);
    await insertProofs(
      h,
      proofRow({
        source: 'detected',
        txHash: BUNDLE,
        logIndex: null,
        transferAmount: null,
        providerOrder: 'o-d',
        orderStatus: 'processing',
        orderFoundAt: new Date(T0),
      }),
    );
    h.rpc['eth_getUserOperationReceipt'] = () => ({
      result: userOpReceiptJson(BUNDLE, true, [usdtLog()]),
    });
    expect(await answer(await prove(h, { tx: H1 }))).toEqual({
      status: 200,
      body: { txId: BUNDLE },
    });
    const rows = await proofsOf(h);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      source: 'detected',
      logIndex: 3,
      userOpHash: H1,
      result: 'accepted',
    });
    expect(h.orchestra.submit).not.toHaveBeenCalled();
  });

  it('leaves the lookup row open when storing the proof fails', async () => {
    const h = harness();
    await seed(h);
    await prove(h, { tx: H1 });
    h.rpc['eth_getTransactionReceipt'] = receiptFor(H1, [usdtLog()]);
    const original = h.store.transaction.bind(h.store);
    vi.spyOn(h.store, 'transaction').mockImplementation((run) =>
      original((tx) =>
        run(
          new Proxy(tx, {
            get(target, key) {
              if (key === 'insertProof') {
                return () => Promise.reject(new Error('store down'));
              }
              const value: unknown = Reflect.get(target, key);
              return typeof value === 'function' ? value.bind(target) : value;
            },
          }),
        ),
      ),
    );
    await expect(prove(h, { tx: H1 })).rejects.toThrow('store down');
    vi.mocked(h.store.transaction).mockRestore();
    expect(
      (await h.store.transaction((tx) => tx.findLookup(137, H1, QUOTE_ID)))?.doneAt,
    ).toBeNull();
    expect(await proofsOf(h)).toEqual([]);
  });

  it('closes an open lookup row once the receipt is found, and leaves a done one', async () => {
    const h = harness();
    await seed(h);
    await prove(h, { tx: H1 });
    await prove(h, { tx: H2 });
    const [first] = await h.store.transaction((tx) => tx.dueLookups(T0 + 60_000, 1));
    await h.store.transaction((tx) => tx.updateLookup(first!.id, { doneAt: new Date(T0) }));
    h.clock.now += 1_000;
    h.rpc['eth_getTransactionReceipt'] = (params) => ({
      result: receiptJson(String(params[0]), '0x1', [
        usdtLog(BigInt(AMOUNT_IN), params[0] === H1 ? 1 : 2),
      ]),
    });
    await prove(h, { tx: H1 });
    await prove(h, { tx: H2 });
    const rows = await h.store.transaction(async (tx) => [
      await tx.findLookup(137, H1, QUOTE_ID),
      await tx.findLookup(137, H2, QUOTE_ID),
    ]);
    expect(rows.map((row) => row?.doneAt?.getTime())).toEqual([T0, T0 + 1_000]);
  });
});

describe('handleShopProof repeats', () => {
  it('answers from the accepted row, else the asset row, else the oldest; other quotes do not count', async () => {
    const h = harness();
    await seed(h);
    await insertProofs(
      h,
      proofRow({
        id: uid(0x4a1),
        offerId: OFFER_OTHER,
        paymentId: uid(2),
        txHash: H1,
        logIndex: 1,
        result: 'refunded',
        providerOrder: 'ox',
      }),
      proofRow({
        id: uid(0x4a2),
        txHash: H1,
        logIndex: 2,
        result: 'late',
        createdAt: new Date(T0 + 1),
      }),
      proofRow({
        id: uid(0x4a3),
        offerId: OFFER_USDC,
        txHash: H1,
        logIndex: 3,
        result: 'failed',
        providerOrder: 'oc',
        createdAt: new Date(T0 + 2),
      }),
    );
    expect((await answer(await prove(h, { tx: H1, asset: null }))).body['reason']).toBe(
      'Invoice expired',
    );
    expect((await answer(await prove(h, { tx: H1, asset: 'USDC' }))).body['reason']).toBe(
      'The transfer was not completed',
    );
    expect((await answer(await prove(h, { tx: H1, asset: 'usdt' }))).body['reason']).toBe(
      'Invoice expired',
    );
    await h.store.transaction((tx) =>
      tx.updateProof(uid(0x4a2), {}, { result: 'accepted', providerOrder: 'oa' }),
    );
    expect((await prove(h, { tx: H1, asset: 'USDC' })).status).toBe(200);
    expect(h.rpcCalls).toEqual([]);
  });

  it('finds a row by tx_hash and user_op_hash once', async () => {
    const h = harness();
    await seed(h);
    await insertProofs(
      h,
      proofRow({ id: uid(0x4b1), txHash: H1, logIndex: 1, result: 'late' }),
      proofRow({
        id: uid(0x4b2),
        txHash: BUNDLE,
        userOpHash: H1,
        logIndex: 2,
        result: 'refunded',
        providerOrder: 'o',
        createdAt: new Date(T0 + 1),
      }),
      proofRow({
        id: uid(0x4b3),
        txHash: H2,
        userOpHash: H2,
        logIndex: 4,
        result: 'failed',
        providerOrder: 'o2',
      }),
    );
    expect((await answer(await prove(h, { tx: H1, asset: null }))).body['reason']).toBe(
      'Invoice expired',
    );
    expect((await answer(await prove(h, { tx: H2, asset: null }))).body['reason']).toBe(
      'The transfer was not completed',
    );
  });

  it('reads the receipt of a row without a log index and resubmits it', async () => {
    const h = harness();
    await seed(h);
    await insertProofs(
      h,
      proofRow({ source: 'detected', txHash: H1, logIndex: null, transferAmount: null }),
    );
    h.rpc['eth_getTransactionReceipt'] = receiptFor(H1, [usdtLog()]);
    h.orchestra.submit.mockResolvedValueOnce({
      kind: 'order',
      orderId: 'o1',
      status: 'delivering',
    });
    expect((await prove(h, { tx: H1 })).status).toBe(200);
    expect(await getProof(h, uid(0x401))).toMatchObject({ logIndex: 3, result: 'accepted' });
    expect(h.orchestra.submit.mock.calls[0]?.[3]).toBe('proof-repeat');
  });

  it.each([
    ['a held kept row with 503', 'refunding', 503],
    ['an accepted kept row with 200', 'processing', 200],
  ])(
    'answers from the kept row when the receipt merged the row away: %s',
    async (_name, orderStatus, status) => {
      const h = harness();
      await seed(h);
      await insertProofs(
        h,
        proofRow({
          id: uid(0x4f1),
          source: 'detected',
          txHash: H1,
          logIndex: null,
          transferAmount: null,
        }),
        proofRow({
          id: uid(0x4f2),
          txHash: H1,
          providerOrder: 'o1',
          orderStatus,
          createdAt: new Date(T0 + 1),
        }),
      );
      h.rpc['eth_getTransactionReceipt'] = receiptFor(H1, [usdtLog()]);
      expect((await prove(h, { tx: H1 })).status).toBe(status);
      expect((await proofsOf(h)).map((row) => row.id)).toEqual([uid(0x4f2)]);
      expect(h.orchestra.submit).not.toHaveBeenCalled();
    },
  );

  it('answers from the row as last read when no row of its offer and transaction is left', async () => {
    const h = harness();
    await seed(h);
    await insertProofs(
      h,
      proofRow({ source: 'detected', txHash: H1, logIndex: null, transferAmount: null }),
    );
    h.rpc['eth_getTransactionReceipt'] = () => {
      void h.store.transaction((tx) => tx.deleteProof(uid(0x401)));
      return { result: null };
    };
    expect(await answer(await prove(h, { tx: H1 }))).toMatchObject({
      status: 503,
      body: { reason: 'Payment is being confirmed' },
    });
    expect(h.orchestra.submit).not.toHaveBeenCalled();
  });

  it('does nothing once the budget is used up', async () => {
    const h = harness();
    await seed(h);
    const hex = await signedTransfer();
    const hexHash = decodeSignedEvmTransaction(hex)!.hash;
    await insertProofs(
      h,
      proofRow({ source: 'hex', txHash: hexHash, logIndex: null, rawHex: hex }),
    );
    const readings = [T0];
    Object.defineProperty(h.clock, 'now', {
      get: () => readings.shift() ?? T0 + SHOP_PROOF_BUDGET_MS,
      configurable: true,
    });
    expect((await prove(h, { hex })).status).toBe(503);
    expect(h.rpcCalls).toEqual([]);
    expect(h.orchestra.submit).not.toHaveBeenCalled();
  });

  it('sends a hex row that was never sent, then submits it', async () => {
    const h = harness();
    await seed(h);
    const hex = await signedTransfer();
    const hexHash = decodeSignedEvmTransaction(hex)!.hash;
    await insertProofs(
      h,
      proofRow({ source: 'hex', txHash: hexHash, logIndex: null, rawHex: hex }),
    );
    h.orchestra.submit.mockResolvedValueOnce({
      kind: 'order',
      orderId: 'o1',
      status: 'processing',
    });
    expect((await prove(h, { hex: `0x${hex}` })).status).toBe(200);
    expect(h.rpcCalls.map((call) => call.method)).toEqual([
      'eth_getTransactionReceipt',
      'eth_sendRawTransaction',
    ]);
    expect((await getProof(h, uid(0x401)))?.sentAt?.getTime()).toBe(T0);
  });

  it('resubmits at most once per 2 s slot and five times per minute', async () => {
    const h = harness();
    await seed(h);
    await insertProofs(
      h,
      proofRow({ txHash: H1 }),
      proofRow({ id: uid(0x402), txHash: H2, logIndex: 5 }),
    );
    await prove(h, { tx: H1 });
    await prove(h, { tx: H1 });
    expect(h.orchestra.submit).toHaveBeenCalledTimes(1);
    for (let i = 0; i < 6; i += 1) {
      h.clock.now += 2_000;
      await prove(h, { tx: H1 });
    }
    expect(h.orchestra.submit).toHaveBeenCalledTimes(5);
    h.clock.now = T0 + 40_000;
    await prove(h, { tx: H2 });
    h.clock.now = T0 + 75_000;
    await prove(h, { tx: H2 });
    expect(h.orchestra.submit).toHaveBeenCalledTimes(7);
    await prove(h, { tx: H1 });
    expect(h.orchestra.submit).toHaveBeenCalledTimes(8);
  });
});

describe('handleShopProof with hex', () => {
  it('verifies an EIP-1559 transfer, stores it, sends it, and submits it', async () => {
    const h = harness();
    await seed(h);
    const hex = await signedTransfer();
    const hash = decodeSignedEvmTransaction(hex)!.hash;
    h.orchestra.submit.mockResolvedValueOnce({
      kind: 'order',
      orderId: 'o1',
      status: 'processing',
    });
    expect(await answer(await prove(h, { hex: `0x${hex.toUpperCase()}` }))).toEqual({
      status: 200,
      body: { txId: hash },
    });
    const [proof] = await proofsOf(h);
    expect(proof).toMatchObject({
      source: 'hex',
      rawHex: hex,
      txHash: hash,
      logIndex: null,
      transferAmount: AMOUNT_IN,
      sentAt: new Date(T0),
      nextReceiptAt: new Date(T0 + 30_000),
      result: 'accepted',
    });
    expect(h.rpcCalls.map((call) => call.method)).toEqual([
      'eth_gasPrice',
      'eth_sendRawTransaction',
    ]);
    expect(JSON.stringify(loggedEvents(warn))).not.toContain(hex);
  });

  it('accepts a legacy transfer without reading the gas price', async () => {
    const h = harness();
    await seed(h);
    const hex = await signedTransfer({ type: 'legacy' });
    expect((await prove(h, { hex, asset: 'usdt' })).status).toBe(503);
    expect(h.rpcCalls.map((call) => call.method)).toEqual(['eth_sendRawTransaction']);
    expect(h.orchestra.submit).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['another chain', { chainId: 1 }, 'USDT'],
    ['a contract that is no offer', { to: ETH_USDT }, 'USDT'],
    ['another asset', {}, 'USDC'],
    ['a native value', { value: 1n }, 'USDT'],
    ['other data', { amount: 1n }, 'USDT'],
    ['a legacy fee below minFee', { type: 'legacy' as const, gasPrice: 1_000_000_000n }, 'USDT'],
    ['an EIP-1559 fee below minFee', { maxFeePerGas: 1_000_000_000n }, 'USDT'],
  ])('refuses %s without storing or sending', async (_name, options, asset) => {
    const h = harness();
    await seed(h);
    const hex = await signedTransfer(options);
    expect(await answer(await prove(h, { hex, asset }))).toMatchObject({
      status: 400,
      body: { reason: 'Payment was not accepted' },
    });
    expect(await proofsOf(h)).toEqual([]);
    expect(h.rpcCalls.map((call) => call.method)).not.toContain('eth_sendRawTransaction');
  });

  it('answers 503 when the gas price cannot be read', async () => {
    const h = harness();
    await seed(h);
    h.rpc['eth_gasPrice'] = () => 'transport';
    expect((await answer(await prove(h, { hex: await signedTransfer() }))).body['reason']).toBe(
      'Payment is being confirmed',
    );
    expect(await proofsOf(h)).toEqual([]);
  });

  it('refuses a transaction the node rejects', async () => {
    const h = harness();
    await seed(h);
    h.rpc['eth_sendRawTransaction'] = () => ({
      error: 'Insufficient funds for gas * price + value',
    });
    expect(await answer(await prove(h, { hex: await signedTransfer() }))).toMatchObject({
      status: 400,
      body: { reason: 'Payment was not accepted' },
    });
    expect((await proofsOf(h))[0]).toMatchObject({
      result: 'refused',
      refusal: 'hex_rejected',
      nextReceiptAt: null,
    });
    expect(h.orchestra.submit).not.toHaveBeenCalled();
  });

  it.each([
    ['another error', () => ({ error: 'header not found' })],
    ['a transport error', () => 'transport' as const],
  ])('answers 503 and leaves the send to the watcher on %s', async (_name, send) => {
    const h = harness();
    await seed(h);
    h.rpc['eth_sendRawTransaction'] = send;
    expect((await prove(h, { hex: await signedTransfer() })).status).toBe(503);
    expect((await proofsOf(h))[0]).toMatchObject({
      result: null,
      sentAt: null,
      nextSubmitAt: null,
    });
    expect(h.orchestra.submit).not.toHaveBeenCalled();
  });

  it('counts already known or nonce too low as sent only when the node finds the hash', async () => {
    const h = harness();
    await seed(h);
    h.rpc['eth_sendRawTransaction'] = () => ({ error: 'already known' });
    h.rpc['eth_getTransactionByHash'] = () => ({ result: { hash: '0x' } });
    await prove(h, { hex: await signedTransfer({ nonce: 1 }) });
    h.rpc['eth_sendRawTransaction'] = () => ({ error: 'nonce too low' });
    h.rpc['eth_getTransactionByHash'] = () => ({ result: null });
    await prove(h, { hex: await signedTransfer({ nonce: 2 }) });
    h.rpc['eth_getTransactionByHash'] = () => 'transport';
    await prove(h, { hex: await signedTransfer({ nonce: 3 }) });
    expect((await proofsOf(h)).map((row) => row.sentAt?.getTime() ?? null)).toEqual([
      T0,
      null,
      null,
    ]);
    expect(h.orchestra.submit).toHaveBeenCalledTimes(1);
  });
});

describe('storeProof', () => {
  const candidate = {
    offer: offerRow(),
    paymentId: PAYMENT_ID,
    source: 'tx' as const,
    txHash: H1,
    logIndex: 3,
    userOpHash: null,
    rawHex: null,
    transferAmount: AMOUNT_IN,
    order: null,
  };

  it('inserts a row with give_up_at 24 h ahead and the first submit after 10 s', async () => {
    const h = harness();
    await seed(h);
    const { proof, created } = await storeProof(h.shop, candidate);
    expect(created).toBe(true);
    expect(proof).toMatchObject({
      giveUpAt: new Date(T0 + 86_400_000),
      nextSubmitAt: new Date(T0 + 10_000),
      nextReceiptAt: null,
    });
    const again = await storeProof(h.shop, candidate);
    expect(again).toEqual({ proof, created: false });
  });

  it('stores a detected proof with its order and reuses the row that holds the order', async () => {
    const h = harness();
    await seed(h);
    const order = { orderId: 'o1', status: 'refunding' };
    const { proof } = await storeProof(h.shop, {
      ...candidate,
      source: 'detected',
      logIndex: null,
      transferAmount: null,
      order,
    });
    expect(proof).toMatchObject({
      providerOrder: 'o1',
      orderStatus: 'refunding',
      nextSubmitAt: null,
      nextReceiptAt: new Date(T0 + 30_000),
      nextStatusAt: new Date(T0 + 10_000),
      result: null,
    });
    expect(events()).toContain('shop.proof.detected');
    expect(await storeProof(h.shop, { ...candidate, txHash: H2, order })).toEqual({
      proof,
      created: false,
    });
  });

  it('gives a stored row without an order the order the orders duty found', async () => {
    const h = harness();
    await seed(h);
    await insertProofs(h, proofRow({ txHash: H1 }));
    const { proof } = await storeProof(h.shop, {
      ...candidate,
      source: 'detected',
      logIndex: null,
      transferAmount: null,
      order: { orderId: 'o1', status: 'completed' },
    });
    expect(proof).toMatchObject({ id: uid(0x401), providerOrder: 'o1', result: 'accepted' });
  });

  it('stores a second order of the same transaction and offer in its own row', async () => {
    const h = harness();
    await seed(h);
    await insertProofs(h, proofRow({ txHash: H1, providerOrder: 'o1', orderStatus: 'processing' }));
    const detected = {
      ...candidate,
      source: 'detected' as const,
      logIndex: null,
      transferAmount: null,
      order: { orderId: 'o2', status: 'processing' },
    };
    const second = await storeProof(h.shop, detected);
    expect(second.created).toBe(true);
    expect(second.proof).toMatchObject({ logIndex: null, providerOrder: 'o2' });
    expect((await proofsOf(h)).map((row) => row.providerOrder).sort()).toEqual(['o1', 'o2']);
    const third = await storeProof(h.shop, {
      ...detected,
      order: { orderId: 'o3', status: 'processing' },
    });
    expect(third).toEqual({ proof: second.proof, created: false });
    expect((await proofsOf(h)).map((row) => row.providerOrder).sort()).toEqual(['o1', 'o2']);
  });

  it('reuses an unlogged row without an order for an order, and any unlogged row for hex', async () => {
    const h = harness();
    await seed(h);
    await insertProofs(
      h,
      proofRow({ txHash: H1, providerOrder: 'o1', orderStatus: 'processing' }),
      proofRow({
        id: uid(0x402),
        source: 'hex',
        txHash: H1,
        logIndex: null,
        rawHex: 'ab',
        createdAt: new Date(T0 + 1),
      }),
    );
    const order = { orderId: 'o2', status: 'refunding' };
    const { proof } = await storeProof(h.shop, {
      ...candidate,
      source: 'detected',
      logIndex: null,
      transferAmount: null,
      order,
    });
    expect(proof).toMatchObject({ id: uid(0x402), providerOrder: 'o2' });
    expect(
      await storeProof(h.shop, {
        ...candidate,
        source: 'hex',
        logIndex: null,
        rawHex: 'ab',
      }),
    ).toEqual({ proof, created: false });
  });

  it('answers a lost insert from the winning row', async () => {
    const h = harness();
    await seed(h);
    const winner = proofRow({
      id: uid(0x4c1),
      offerId: OFFER_OTHER,
      paymentId: uid(2),
      txHash: H1,
      logIndex: 3,
    });
    await insertProofs(h, winner);
    expect(await storeProof(h.shop, candidate)).toEqual({ proof: winner, created: false });
  });

  it('refuses the row being filled with tx_used when another offer holds the log', async () => {
    const h = harness();
    await seed(h);
    await insertProofs(
      h,
      proofRow({
        id: uid(0x4c1),
        offerId: OFFER_OTHER,
        paymentId: uid(2),
        txHash: H1,
        logIndex: 3,
      }),
      proofRow({ source: 'detected', txHash: H1, logIndex: null, transferAmount: null }),
    );
    const { proof } = await storeProof(h.shop, candidate);
    expect(proof).toMatchObject({
      id: uid(0x401),
      result: 'refused',
      refusal: 'tx_used',
      logIndex: null,
    });
    expect((await answer(proofResponse(proof))).body['reason']).toBe('Transaction already used');
  });
});

describe('merging two rows of one deposit', () => {
  it('keeps the row with an order when a receipt fills the log index another row holds', async () => {
    const h = harness();
    await seed(h);
    await insertProofs(
      h,
      proofRow({ id: uid(0x4d1), txHash: H1, logIndex: 3, userOpHash: H2 }),
      proofRow({
        id: uid(0x4d2),
        source: 'detected',
        txHash: H1,
        logIndex: null,
        transferAmount: null,
        providerOrder: 'o1',
        orderStatus: 'processing',
        orderFoundAt: new Date(T0),
        nextStatusAt: new Date(T0 + 10_000),
        createdAt: new Date(T0 + 5),
      }),
    );
    h.rpc['eth_getTransactionReceipt'] = receiptFor(H1, [usdtLog()]);
    const detected = (await getProof(h, uid(0x4d2)))!;
    expect(await readProofReceipt(h.shop, detected, POLYGON_RPC, 1_000)).toBe('filled');
    const rows = await proofsOf(h);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: uid(0x4d2),
      logIndex: 3,
      transferAmount: AMOUNT_IN,
      userOpHash: H2,
      providerOrder: 'o1',
      nextReceiptAt: null,
      nextSubmitAt: null,
      result: 'accepted',
    });
  });

  it.each([
    ['the older holder', T0 + 5, uid(0x4d1)],
    ['the older filled row', T0 - 5, uid(0x4d2)],
  ])('keeps %s when neither has an order', async (_name, createdAt, kept) => {
    const h = harness();
    await seed(h);
    await insertProofs(
      h,
      proofRow({ id: uid(0x4d1), txHash: H1, logIndex: 3 }),
      proofRow({
        id: uid(0x4d2),
        source: 'detected',
        txHash: H1,
        logIndex: null,
        transferAmount: null,
        createdAt: new Date(createdAt),
      }),
    );
    h.rpc['eth_getTransactionReceipt'] = receiptFor(H1, [usdtLog()]);
    await readProofReceipt(h.shop, (await getProof(h, uid(0x4d2)))!, POLYGON_RPC, 1_000);
    expect((await proofsOf(h)).map((row) => [row.id, row.logIndex])).toEqual([[kept, 3]]);
  });

  it('merges a submit answer whose order another row of the same offer holds', async () => {
    const h = harness();
    await seed(h);
    await insertProofs(
      h,
      proofRow({ id: uid(0x4e1), txHash: H1 }),
      proofRow({
        id: uid(0x4e2),
        source: 'detected',
        txHash: H1,
        logIndex: null,
        transferAmount: null,
        providerOrder: 'o1',
        orderStatus: 'processing',
        orderFoundAt: new Date(T0 - 1_000),
        result: 'accepted',
      }),
    );
    h.orchestra.submit.mockResolvedValueOnce({
      kind: 'order',
      orderId: 'o1',
      status: 'processing',
    });
    const proof = await submitProof(h.shop, uid(0x4e1), 'watcher', T0 + 5_000);
    expect(proof).toMatchObject({
      id: uid(0x4e2),
      logIndex: 3,
      result: 'accepted',
      providerOrder: 'o1',
    });
    expect(await proofsOf(h)).toHaveLength(1);
  });

  it('keeps a final status that the merged-away row holds for the kept order', async () => {
    const h = harness();
    await seed(h);
    await insertProofs(
      h,
      proofRow({ id: uid(0x4e1), txHash: H1 }),
      proofRow({
        id: uid(0x4e2),
        source: 'detected',
        txHash: H1,
        logIndex: null,
        transferAmount: null,
        providerOrder: 'o1',
        orderStatus: 'processing',
        orderFoundAt: new Date(T0 - 1_000),
        nextStatusAt: new Date(T0 + 10_000),
        createdAt: new Date(T0 - 1_000),
      }),
    );
    h.orchestra.submit.mockResolvedValueOnce({ kind: 'order', orderId: 'o1', status: 'completed' });
    const proof = await submitProof(h.shop, uid(0x4e1), 'watcher', T0 + 5_000);
    expect(proof).toMatchObject({
      id: uid(0x4e2),
      logIndex: 3,
      providerOrder: 'o1',
      orderStatus: 'completed',
      nextStatusAt: null,
      result: 'accepted',
    });
    expect(await proofsOf(h)).toHaveLength(1);
    expect((await getPayment(h))?.status).toBe('accepted');
  });

  it('refuses the newer row with tx_used when the order belongs to another offer', async () => {
    const h = harness();
    await seed(h);
    await insertProofs(
      h,
      proofRow({ id: uid(0x4e1), txHash: H1 }),
      proofRow({
        id: uid(0x4e2),
        offerId: OFFER_USDC,
        txHash: H2,
        providerOrder: 'o1',
        orderStatus: 'processing',
      }),
    );
    h.orchestra.submit.mockResolvedValueOnce({
      kind: 'order',
      orderId: 'o1',
      status: 'processing',
    });
    expect(await submitProof(h.shop, uid(0x4e1), 'watcher', T0 + 5_000)).toMatchObject({
      id: uid(0x4e1),
      result: 'refused',
      refusal: 'tx_used',
    });
  });

  it('refuses an accepted row with tx_used when the successor belongs to another offer, and ends its payment', async () => {
    const h = harness();
    await seed(h, { status: 'accepted', acceptedAt: new Date(T0) });
    const accepted = proofRow({
      id: uid(0x4e1),
      txHash: H1,
      providerOrder: 'o1',
      orderStatus: 'refunding',
      result: 'accepted',
      nextReceiptAt: new Date(T0),
    });
    const failed = proofRow({
      id: uid(0x4e3),
      txHash: txHash('a3'),
      providerOrder: 'o3',
      orderStatus: 'failed',
      result: 'failed',
    });
    await insertProofs(
      h,
      accepted,
      proofRow({
        id: uid(0x4e2),
        offerId: OFFER_USDC,
        txHash: H2,
        providerOrder: 'o2',
        orderStatus: 'refunding',
      }),
      failed,
    );
    const after = await h.store.transaction((tx) => followProofOrder(tx, accepted, 'o2', T0));
    expect(after).toMatchObject({
      id: uid(0x4e1),
      providerOrder: 'o1',
      result: 'refused',
      refusal: 'tx_used',
      nextReceiptAt: null,
    });
    expect(await getPayment(h)).toMatchObject({ status: 'ended', endReason: 'proof_refused' });
    expect((await getProof(h, uid(0x4e2)))?.providerOrder).toBe('o2');
    const kept = await h.store.transaction((tx) => followProofOrder(tx, failed, 'o2', T0));
    expect(kept).toMatchObject({ id: uid(0x4e3), providerOrder: 'o3', result: 'failed' });
  });

  it('follows a successor order, or merges into the row that holds it', async () => {
    const h = harness();
    await seed(h);
    const first = proofRow({
      id: uid(0x4e1),
      txHash: H1,
      providerOrder: 'o1',
      orderStatus: 'processing',
      orderFoundAt: new Date(T0),
    });
    await insertProofs(
      h,
      first,
      proofRow({
        id: uid(0x4e2),
        txHash: H2,
        logIndex: null,
        source: 'detected',
        transferAmount: null,
        providerOrder: 'o3',
        orderStatus: 'refunding',
        createdAt: new Date(T0 + 1),
      }),
    );
    const moved = await h.store.transaction((tx) => followProofOrder(tx, first, 'o2', T0 + 1_000));
    expect(moved).toMatchObject({
      providerOrder: 'o2',
      orderStatus: null,
      nextStatusAt: new Date(T0 + 1_000),
      result: null,
    });
    const merged = await h.store.transaction((tx) =>
      followProofOrder(tx, { ...moved, orderStatus: 'processing' }, 'o3', T0 + 2_000),
    );
    expect(merged).toMatchObject({
      id: uid(0x4e1),
      providerOrder: 'o3',
      orderStatus: 'refunding',
      result: null,
    });
    expect((await answer(proofResponse(merged))).status).toBe(503);
    expect(await proofsOf(h)).toHaveLength(1);
  });

  it('applyProofOrder merges with a holder that has no order found time', async () => {
    const h = harness();
    await seed(h);
    const proof = proofRow({
      id: uid(0x4e1),
      txHash: H1,
      logIndex: null,
      source: 'detected',
      transferAmount: null,
    });
    await insertProofs(
      h,
      proof,
      proofRow({
        id: uid(0x4e2),
        txHash: H1,
        providerOrder: 'o1',
        orderStatus: 'processing',
        createdAt: new Date(T0 - 1),
      }),
    );
    const merged = await h.store.transaction((tx) =>
      applyProofOrder(tx, proof, { orderId: 'o1', status: 'swapping' }, T0),
    );
    expect(merged).toMatchObject({ id: uid(0x4e2), orderStatus: 'processing', logIndex: 3 });
  });
});

describe('submitProofAttempt', () => {
  it('sends nothing for an unknown proof, without Orchestra, after the deadline, or for a resolved proof', async () => {
    const h = harness();
    await seed(h);
    await insertProofs(h, proofRow(), proofRow({ id: uid(0x402), txHash: H2, result: 'late' }));
    expect(await submitProofAttempt(h.shop, uid(0x999), 'watcher', T0 + 5_000)).toEqual({
      proof: null,
      sent: false,
    });
    expect((await submitProofAttempt(h.shop, uid(0x401), 'watcher', T0)).sent).toBe(false);
    expect((await submitProofAttempt(h.shop, uid(0x402), 'watcher', T0 + 5_000)).sent).toBe(false);
    const off = harness({ orchestra: false });
    await seed(off);
    await insertProofs(off, proofRow());
    expect((await submitProofAttempt(off.shop, uid(0x401), 'watcher', T0 + 5_000)).sent).toBe(
      false,
    );
    expect(h.orchestra.submit).not.toHaveBeenCalled();
  });

  it('starts no submit once the deadline passed during the slot claim', async () => {
    const h = harness();
    await seed(h);
    await insertProofs(h, proofRow());
    const readings = [T0];
    Object.defineProperty(h.clock, 'now', {
      get: () => readings.shift() ?? T0 + 5_000,
      configurable: true,
    });
    expect(await submitProofAttempt(h.shop, uid(0x401), 'proof-first', T0 + 5_000)).toEqual({
      proof: expect.objectContaining({ id: uid(0x401), lastSubmitAt: new Date(T0) }),
      sent: false,
    });
    expect(h.orchestra.submit).not.toHaveBeenCalled();
  });

  it('does not submit within the 2 s slot of an earlier submit', async () => {
    const h = harness();
    await seed(h);
    await insertProofs(h, proofRow({ lastSubmitAt: new Date(T0 - 1_999) }));
    expect((await submitProofAttempt(h.shop, uid(0x401), 'proof-first', T0 + 5_000)).sent).toBe(
      false,
    );
    h.clock.now += 1;
    expect((await submitProofAttempt(h.shop, uid(0x401), 'proof-first', T0 + 5_000)).sent).toBe(
      true,
    );
    expect((await getProof(h, uid(0x401)))?.lastSubmitAt?.getTime()).toBe(T0 + 1);
  });

  it('reports a budget refusal as not sent', async () => {
    const h = harness();
    await seed(h);
    await insertProofs(h, proofRow());
    h.orchestra.submit.mockResolvedValueOnce({ kind: 'budget' });
    expect((await submitProofAttempt(h.shop, uid(0x401), 'watcher', T0 + 5_000)).sent).toBe(false);
    expect(events()).not.toContain('shop.proof.submitted');
  });

  it('refuses on xchain_deposit_mismatch with a new key', async () => {
    const h = harness();
    await seed(h);
    await insertProofs(h, proofRow());
    h.orchestra.submit.mockResolvedValueOnce({ kind: 'mismatch' });
    const { proof, sent } = await submitProofAttempt(h.shop, uid(0x401), 'watcher', T0 + 5_000);
    expect(sent).toBe(true);
    expect(proof).toMatchObject({ result: 'refused', refusal: 'mismatch', nextSubmitAt: null });
    expect(proof?.idempotencyKey).not.toBe(uid(0x402));
  });

  it('makes the proof late and stops submitting on 409 quote_expired', async () => {
    const h = harness();
    await seed(h);
    await insertProofs(h, proofRow());
    h.orchestra.submit.mockResolvedValueOnce({ kind: 'quote_expired' });
    const { proof } = await submitProofAttempt(h.shop, uid(0x401), 'watcher', T0 + 5_000);
    expect(proof).toMatchObject({ result: 'late', submitStopped: true });
    expect(events()).toEqual(
      expect.arrayContaining(['shop.proof.late', 'shop.alert.late_deposit']),
    );
  });

  it('keeps the key after a retryable answer and rotates it after a definitive one', async () => {
    const h = harness();
    await seed(h);
    await insertProofs(h, proofRow());
    h.orchestra.submit.mockResolvedValueOnce({ kind: 'unresolved', retryable: true });
    expect((await submitProof(h.shop, uid(0x401), 'watcher', T0 + 5_000))?.idempotencyKey).toBe(
      uid(0x402),
    );
    h.clock.now += 2_000;
    h.orchestra.submit.mockResolvedValueOnce({ kind: 'unresolved', retryable: false });
    const rotated = await submitProof(h.shop, uid(0x401), 'watcher', T0 + 7_000);
    expect(rotated?.idempotencyKey).not.toBe(uid(0x402));
    expect(rotated?.result).toBeNull();
    expect(events()).toContain('shop.proof.unresolved');
  });

  it('leaves a proof that changed during the call', async () => {
    const h = harness();
    await seed(h);
    await insertProofs(
      h,
      proofRow(),
      proofRow({ id: uid(0x402), txHash: H2 }),
      proofRow({ id: uid(0x403), txHash: txHash('a3') }),
    );
    const giveOrder = (id: string, order: string) => async () => {
      await h.store.transaction((tx) =>
        tx.updateProof(id, {}, { providerOrder: order, orderStatus: 'processing' }),
      );
      return { kind: 'order', orderId: 'o-new', status: 'processing' };
    };
    h.orchestra.submit.mockImplementationOnce(giveOrder(uid(0x401), 'o-a'));
    expect((await submitProof(h.shop, uid(0x401), 'watcher', T0 + 5_000))?.providerOrder).toBe(
      'o-a',
    );
    h.orchestra.submit.mockImplementationOnce(async () => {
      await h.store.transaction((tx) => tx.updateProof(uid(0x402), {}, { providerOrder: 'o-b' }));
      return { kind: 'mismatch' };
    });
    expect((await submitProof(h.shop, uid(0x402), 'watcher', T0 + 5_000))?.result).toBeNull();
    h.orchestra.submit.mockImplementationOnce(async () => {
      await h.store.transaction((tx) => tx.deleteProof(uid(0x403)));
      return { kind: 'unresolved', retryable: true };
    });
    expect(await submitProofAttempt(h.shop, uid(0x403), 'watcher', T0 + 5_000)).toEqual({
      proof: null,
      sent: true,
    });
  });
});

describe('submitProofAttempt with an order recorded meanwhile', () => {
  it('applies only a final status of that same order', async () => {
    const h = harness();
    await seed(h);
    await insertProofs(
      h,
      proofRow(),
      proofRow({ id: uid(0x402), txHash: H2 }),
      proofRow({ id: uid(0x403), txHash: txHash('a3') }),
    );
    const meanwhile = (id: string, answer: string) => async () => {
      await h.store.transaction((tx) =>
        tx.updateProof(id, {}, { providerOrder: `o-${id}`, orderStatus: 'processing' }),
      );
      return { kind: 'order', orderId: `o-${id}`, status: answer };
    };
    h.orchestra.submit.mockImplementationOnce(meanwhile(uid(0x401), 'completed'));
    expect(await submitProof(h.shop, uid(0x401), 'watcher', T0 + 5_000)).toMatchObject({
      orderStatus: 'completed',
      result: 'accepted',
    });
    h.orchestra.submit.mockImplementationOnce(meanwhile(uid(0x402), 'swapping'));
    expect(await submitProof(h.shop, uid(0x402), 'watcher', T0 + 5_000)).toMatchObject({
      orderStatus: 'processing',
      result: null,
    });
    h.orchestra.submit.mockImplementationOnce(async () => {
      await h.store.transaction((tx) =>
        tx.updateProof(uid(0x403), {}, { providerOrder: 'o-other', orderStatus: 'processing' }),
      );
      return { kind: 'order', orderId: 'o-new', status: 'completed' };
    });
    expect(await submitProof(h.shop, uid(0x403), 'watcher', T0 + 5_000)).toMatchObject({
      providerOrder: 'o-other',
      orderStatus: 'processing',
      result: null,
    });
  });
});

describe('refuseHexProof and sendHexProof', () => {
  it('refuses through refuseProof, an accepted proof included, and stops its receipt reads', async () => {
    const h = harness();
    await seed(h, { status: 'accepted', acceptedAt: new Date(T0) });
    await insertProofs(
      h,
      proofRow({ source: 'hex', rawHex: 'ab', logIndex: null, nextReceiptAt: new Date(T0) }),
      proofRow({
        id: uid(0x402),
        txHash: H2,
        source: 'hex',
        rawHex: 'cd',
        providerOrder: 'o',
        orderStatus: 'refunding',
        result: 'accepted',
        nextReceiptAt: new Date(T0),
      }),
      proofRow({ id: uid(0x403), txHash: txHash('a3'), result: 'refunded', providerOrder: 'o3' }),
    );
    expect(await refuseHexProof(h.shop, uid(0x999))).toBeNull();
    expect((await refuseHexProof(h.shop, uid(0x403)))?.result).toBe('refunded');
    expect(await refuseHexProof(h.shop, uid(0x401))).toMatchObject({
      result: 'refused',
      refusal: 'hex_rejected',
      nextReceiptAt: null,
    });
    expect(await refuseHexProof(h.shop, uid(0x402))).toMatchObject({
      result: 'refused',
      refusal: 'hex_rejected',
      nextReceiptAt: null,
    });
    expect(await getPayment(h)).toMatchObject({ status: 'ended', endReason: 'proof_refused' });
    expect(events()).toContain('shop.proof.refused');
  });

  it('sets sent_at once and schedules a submit only for an unresolved proof', async () => {
    const h = harness();
    await seed(h);
    const sent = proofRow({
      source: 'hex',
      rawHex: 'ab',
      logIndex: null,
      sentAt: new Date(T0 - 1_000),
    });
    const stuck = proofRow({
      id: uid(0x402),
      txHash: H2,
      source: 'hex',
      rawHex: 'ab',
      logIndex: null,
      result: 'stuck',
    });
    await insertProofs(h, sent, stuck);
    expect(await sendHexProof(h.shop, sent, POLYGON_RPC, 1_000)).toBe('sent');
    expect((await getProof(h, sent.id))?.sentAt?.getTime()).toBe(T0 - 1_000);
    expect(await sendHexProof(h.shop, stuck, POLYGON_RPC, 1_000)).toBe('sent');
    expect(await getProof(h, stuck.id)).toMatchObject({ sentAt: new Date(T0), nextSubmitAt: null });
    expect(
      await sendHexProof(h.shop, proofRow({ id: uid(0x999), rawHex: 'ab' }), POLYGON_RPC, 1_000),
    ).toBe('sent');
  });
});

describe('readProofReceipt', () => {
  it('reports a failed call and a missing receipt', async () => {
    const h = harness();
    await seed(h);
    const proof = proofRow({ source: 'detected', logIndex: null, transferAmount: null });
    await insertProofs(h, proof);
    h.rpc['eth_getTransactionReceipt'] = () => 'transport';
    expect(await readProofReceipt(h.shop, proof, POLYGON_RPC, 1_000)).toBe('error');
    h.rpc['eth_getTransactionReceipt'] = () => ({ result: null });
    expect(await readProofReceipt(h.shop, proof, POLYGON_RPC, 1_000)).toBe('pending');
  });

  it('refuses a reverted hex transaction', async () => {
    const h = harness();
    await seed(h);
    const proof = proofRow({ source: 'hex', rawHex: 'ab', logIndex: null });
    await insertProofs(h, proof);
    h.rpc['eth_getTransactionReceipt'] = receiptFor(H1, [usdtLog()], '0x0');
    expect(await readProofReceipt(h.shop, proof, POLYGON_RPC, 1_000)).toBe('failed');
    expect((await getProof(h, proof.id))?.refusal).toBe('hex_rejected');
  });

  it('stops reading a detected proof whose receipt failed or has no transfer to its offer', async () => {
    const h = harness();
    await seed(h);
    const proof = proofRow({
      source: 'detected',
      logIndex: null,
      transferAmount: null,
      nextReceiptAt: new Date(T0),
    });
    await insertProofs(h, proof);
    h.rpc['eth_getTransactionReceipt'] = receiptFor(H1, [usdtLog()], '0x0');
    expect(await readProofReceipt(h.shop, proof, POLYGON_RPC, 1_000)).toBe('mismatch');
    h.rpc['eth_getTransactionReceipt'] = receiptFor(H1, [
      transferLog(POLYGON_USDT, DEPOSIT_ETH, 1n, 1),
    ]);
    expect(await readProofReceipt(h.shop, proof, POLYGON_RPC, 1_000)).toBe('mismatch');
    expect(await getProof(h, proof.id)).toMatchObject({
      nextReceiptAt: null,
      result: null,
      logIndex: null,
    });
    expect(events().filter((event) => event === 'shop.alert.detected_mismatch')).toHaveLength(2);
  });

  it('reports an error when a merge deleted the row while the receipt was read', async () => {
    const h = harness();
    await seed(h);
    h.rpc['eth_getTransactionReceipt'] = receiptFor(H1, [usdtLog()]);
    const deleted = proofRow({ source: 'detected', logIndex: null, transferAmount: null });
    expect(await readProofReceipt(h.shop, deleted, POLYGON_RPC, 1_000)).toBe('error');
    expect(await proofsOf(h)).toEqual([]);
  });

  it('reports filled when another call filled the row first', async () => {
    const h = harness();
    await seed(h);
    await insertProofs(h, proofRow());
    h.rpc['eth_getTransactionReceipt'] = receiptFor(H1, [usdtLog()]);
    const stale = proofRow({ logIndex: null });
    expect(await readProofReceipt(h.shop, stale, POLYGON_RPC, 1_000)).toBe('filled');
  });

  it('takes a transfer log no other row of the offer and transaction holds, so two orders keep two rows', async () => {
    const h = harness();
    await seed(h);
    await insertProofs(
      h,
      proofRow({ id: uid(0x4f1), txHash: H1, logIndex: 3 }),
      proofRow({
        id: uid(0x4f2),
        source: 'detected',
        txHash: H1,
        logIndex: null,
        transferAmount: null,
        createdAt: new Date(T0 + 5),
      }),
    );
    // Log 3 (held) and log 5 both pay the deposit address; log 7 matches amountIn but is
    // listed after a free log with another value, so the amount match still wins.
    h.rpc['eth_getTransactionReceipt'] = receiptFor(H1, [
      usdtLog(),
      usdtLog(1n, 5),
      usdtLog(BigInt(AMOUNT_IN), 7),
    ]);
    expect(
      await readProofReceipt(h.shop, (await getProof(h, uid(0x4f2)))!, POLYGON_RPC, 1_000),
    ).toBe('filled');
    expect((await proofsOf(h)).map((row) => [row.id, row.logIndex, row.transferAmount])).toEqual([
      [uid(0x4f1), 3, AMOUNT_IN],
      [uid(0x4f2), 7, AMOUNT_IN],
    ]);
  });

  it('takes the first free log when none matches amountIn', async () => {
    const h = harness();
    await seed(h);
    await insertProofs(
      h,
      proofRow({ id: uid(0x4f3), txHash: H1, logIndex: 3 }),
      proofRow({
        id: uid(0x4f4),
        source: 'detected',
        txHash: H1,
        logIndex: null,
        transferAmount: null,
        createdAt: new Date(T0 + 5),
      }),
    );
    h.rpc['eth_getTransactionReceipt'] = receiptFor(H1, [
      usdtLog(),
      usdtLog(2n, 5),
      usdtLog(1n, 6),
    ]);
    await readProofReceipt(h.shop, (await getProof(h, uid(0x4f4)))!, POLYGON_RPC, 1_000);
    expect((await proofsOf(h)).map((row) => [row.id, row.logIndex, row.transferAmount])).toEqual([
      [uid(0x4f3), 3, AMOUNT_IN],
      [uid(0x4f4), 5, '2'],
    ]);
  });
});

describe('verifyTxProof and verifyHexProof', () => {
  it('verifies directly against a context', async () => {
    const h = harness();
    await seed(h);
    const ctx = await context(h);
    h.rpc['eth_getTransactionReceipt'] = receiptFor(H1, [usdtLog()]);
    expect(
      await verifyTxProof(h.shop, {
        quoteOffers: ctx.offers,
        method: POLYGON,
        asset: null,
        url: POLYGON_RPC,
        hash: H1,
        deadlineMs: T0 + 1_000,
        callLimitMs: 1_000,
      }),
    ).toMatchObject({ kind: 'found', offer: { id: OFFER_USDT }, logIndex: 3, userOpHash: null });
    const decoded = decodeSignedEvmTransaction(await signedTransfer({ type: 'legacy' }))!;
    expect(
      await verifyHexProof(h.shop, {
        quoteOffers: ctx.offers,
        method: POLYGON,
        asset: null,
        url: POLYGON_RPC,
        decoded,
        deadlineMs: T0 + 1_000,
      }),
    ).toMatchObject({ kind: 'valid', offer: { id: OFFER_USDT } });
    expect(await shopProofContext(h.shop, uid(0x999))).toBeNull();
  });
});

describe('retryStuckProof', () => {
  it('moves a stuck proof back to unresolved with give_up_at 24 h ahead', async () => {
    const h = harness();
    await seed(h);
    await insertProofs(
      h,
      proofRow({ result: 'stuck' }),
      proofRow({ id: uid(0x402), txHash: H2, result: 'late' }),
      proofRow({
        id: uid(0x403),
        txHash: txHash('a3'),
        source: 'hex',
        rawHex: 'ab',
        logIndex: null,
        result: 'stuck',
      }),
    );
    h.clock.now = T0 + 90_000_000;
    expect(await retryStuckProof(h.shop, 'nope')).toBe('not_found');
    expect(await retryStuckProof(h.shop, uid(0x999))).toBe('not_found');
    expect(await retryStuckProof(h.shop, uid(0x402))).toBe('not_stuck');
    expect(await retryStuckProof(h.shop, uid(0x401).toUpperCase())).toBe('retried');
    expect(await getProof(h, uid(0x401))).toMatchObject({
      result: null,
      giveUpAt: new Date(T0 + 90_000_000 + 86_400_000),
      nextSubmitAt: new Date(T0 + 90_000_000),
    });
    expect(await retryStuckProof(h.shop, uid(0x403))).toBe('retried');
    expect(await getProof(h, uid(0x403))).toMatchObject({
      nextSubmitAt: null,
      nextReceiptAt: new Date(T0 + 90_000_000),
    });
    expect(loggedEvents(warn).filter((line) => line['event'] === 'shop.proof.retried')).toEqual([
      expect.objectContaining({ paymentId: PAYMENT_ID, proofId: uid(0x401), offerId: OFFER_USDT }),
      expect.objectContaining({ proofId: uid(0x403) }),
    ]);
  });
});

describe('logging', () => {
  it('never logs a key, an RPC URL, or a BOLT11', async () => {
    const h = harness();
    await seed(h);
    h.rpc['eth_getTransactionReceipt'] = receiptFor(H1, [usdtLog()]);
    h.orchestra.submit.mockResolvedValueOnce({
      kind: 'order',
      orderId: 'o1',
      status: 'processing',
    });
    await prove(h, { tx: H1 });
    const text = JSON.stringify(loggedEvents(warn));
    expect(text).not.toContain(POLYGON_RPC);
    expect(text).not.toContain('lnbc');
    expect(text).not.toContain(uid(0x1002));
  });
});
