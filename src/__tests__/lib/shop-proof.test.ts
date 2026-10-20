import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { decodeSignedEvmTransaction } from '@/lib/evm-transfer';
import { lockPaymentForProofs, shopMethodByName } from '@/lib/shop-payment';
import { runShopPaymentTick } from '@/lib/shop-payment-worker';
import {
  SHOP_PROOF_BUDGET_MS,
  SHOP_RPC_TIMEOUT_MS,
  applyProofOrder,
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
  recordTxCalls,
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
      {
        paymentId: PAYMENT_ID,
        proofId: proof!.id,
        offerId: OFFER_USDT,
        quoteId: QUOTE_ID,
        providerRef: 'q-usdt-pol',
      },
    );
    expect((await getPayment(h))?.status).toBe('accepted');
    expect(events()).toEqual(
      expect.arrayContaining(['shop.proof.stored', 'shop.proof.submitted', 'shop.proof.accepted']),
    );
  });

  it('answers from the row as last read when the row disappears during its first submit', async () => {
    const h = harness();
    await seed(h);
    h.rpc['eth_getTransactionReceipt'] = receiptFor(H1, [usdtLog()]);
    h.orchestra.submit.mockImplementationOnce(async () => {
      const [row] = await proofsOf(h);
      await h.store.transaction((tx) => tx.deleteProof(row!.id));
      return { kind: 'unresolved', retryable: true };
    });
    expect(await answer(await prove(h, { tx: H1 }))).toMatchObject({
      status: 503,
      body: { reason: 'Payment is being confirmed' },
    });
    expect(h.orchestra.submit).toHaveBeenCalledTimes(1);
    expect(await proofsOf(h)).toEqual([]);
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
      {
        paymentId: PAYMENT_ID,
        proofId: proof!.id,
        offerId: OFFER_USDT,
        quoteId: QUOTE_ID,
        providerRef: 'q-usdt-pol',
      },
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

  it('sends a hex row that was never sent and does not submit it before its receipt is found', async () => {
    const h = harness();
    await seed(h);
    const hex = await signedTransfer();
    const hexHash = decodeSignedEvmTransaction(hex)!.hash;
    await insertProofs(
      h,
      proofRow({ source: 'hex', txHash: hexHash, logIndex: null, rawHex: hex }),
    );
    expect((await prove(h, { hex: `0x${hex}` })).status).toBe(503);
    expect(h.rpcCalls.map((call) => call.method)).toEqual([
      'eth_getTransactionReceipt',
      'eth_sendRawTransaction',
    ]);
    expect(await getProof(h, uid(0x401))).toMatchObject({
      sentAt: new Date(T0),
      nextSubmitAt: null,
      nextReceiptAt: new Date(T0 + 30_000),
    });
    expect(h.orchestra.submit).not.toHaveBeenCalled();
  });

  it('a repeat of a sent hex row whose receipt is now found fills it and submits it as proof-repeat', async () => {
    const h = harness();
    await seed(h);
    const hex = await signedTransfer();
    const hexHash = decodeSignedEvmTransaction(hex)!.hash;
    await insertProofs(
      h,
      proofRow({
        source: 'hex',
        txHash: hexHash,
        logIndex: null,
        rawHex: hex,
        sentAt: new Date(T0 - 60_000),
      }),
    );
    h.rpc['eth_getTransactionReceipt'] = receiptFor(hexHash, [usdtLog()]);
    h.orchestra.submit.mockResolvedValueOnce({
      kind: 'order',
      orderId: 'o1',
      status: 'processing',
    });
    expect((await prove(h, { hex })).status).toBe(200);
    expect(h.rpcCalls.map((call) => call.method)).toEqual(['eth_getTransactionReceipt']);
    expect(h.orchestra.submit.mock.calls[0]?.[3]).toBe('proof-repeat');
    expect(await getProof(h, uid(0x401))).toMatchObject({ logIndex: 3, result: 'accepted' });
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
  it('verifies an EIP-1559 transfer, stores it, sends it, reads its receipt, and only then submits it', async () => {
    const h = harness();
    await seed(h);
    const hex = await signedTransfer();
    const hash = decodeSignedEvmTransaction(hex)!.hash;
    h.rpc['eth_getTransactionReceipt'] = receiptFor(hash, [usdtLog()]);
    h.orchestra.submit.mockImplementationOnce(async () => {
      // Orchestra can see the deposit: the receipt filled the log index first.
      expect((await proofsOf(h))[0]?.logIndex).toBe(3);
      return { kind: 'order', orderId: 'o1', status: 'processing' };
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
      logIndex: 3,
      transferAmount: AMOUNT_IN,
      sentAt: new Date(T0),
      nextReceiptAt: null,
      result: 'accepted',
    });
    expect(h.rpcCalls.map((call) => call.method)).toEqual([
      'eth_gasPrice',
      'eth_sendRawTransaction',
      'eth_getTransactionReceipt',
    ]);
    expect(h.orchestra.submit.mock.calls[0]?.[3]).toBe('proof-first');
    expect(JSON.stringify(loggedEvents(warn))).not.toContain(hex);
  });

  it('answers 503 without a submit while the receipt is not found; the receipts duty reads it after 30 s', async () => {
    const h = harness();
    await seed(h);
    const hex = await signedTransfer({ type: 'legacy' });
    expect(await answer(await prove(h, { hex, asset: 'usdt' }))).toMatchObject({
      status: 503,
      body: { reason: 'Payment is being confirmed' },
    });
    expect(h.rpcCalls.map((call) => call.method)).toEqual([
      'eth_sendRawTransaction',
      'eth_getTransactionReceipt',
    ]);
    expect(h.orchestra.submit).not.toHaveBeenCalled();
    expect((await proofsOf(h))[0]).toMatchObject({
      result: null,
      logIndex: null,
      sentAt: new Date(T0),
      nextSubmitAt: null,
      nextReceiptAt: new Date(T0 + 30_000),
    });
  });

  it('reads no receipt once the budget ran out during the send', async () => {
    const h = harness();
    await seed(h);
    const hex = await signedTransfer({ type: 'legacy' });
    h.rpc['eth_sendRawTransaction'] = () => {
      h.clock.now = T0 + SHOP_PROOF_BUDGET_MS;
      return { result: txHash('ee') };
    };
    expect((await prove(h, { hex })).status).toBe(503);
    expect(h.rpcCalls.map((call) => call.method)).toEqual(['eth_sendRawTransaction']);
    expect(h.orchestra.submit).not.toHaveBeenCalled();
  });

  it('refuses a hex transaction whose receipt reverted on the first read', async () => {
    const h = harness();
    await seed(h);
    const hex = await signedTransfer({ type: 'legacy' });
    const hash = decodeSignedEvmTransaction(hex)!.hash;
    h.rpc['eth_getTransactionReceipt'] = receiptFor(hash, [], '0x0');
    expect(await answer(await prove(h, { hex }))).toMatchObject({
      status: 400,
      body: { reason: 'Payment was not accepted' },
    });
    expect((await proofsOf(h))[0]).toMatchObject({ result: 'refused', refusal: 'hex_rejected' });
    expect(h.orchestra.submit).not.toHaveBeenCalled();
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
    // No receipt yet: nothing is submitted.
    expect(h.orchestra.submit).not.toHaveBeenCalled();
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
      proofRow({
        source: 'detected',
        txHash: H1,
        logIndex: null,
        transferAmount: null,
        providerOrder: 'o1',
        orderStatus: 'processing',
        nextStatusAt: new Date(T0 + 10_000),
        nextReceiptAt: new Date(T0 + 30_000),
      }),
    );
    const { proof } = await storeProof(h.shop, candidate);
    // Its order is kept, but neither the receipts nor the order-status duty follows it.
    expect(proof).toMatchObject({
      id: uid(0x401),
      result: 'refused',
      refusal: 'tx_used',
      logIndex: null,
      providerOrder: 'o1',
      nextStatusAt: null,
      nextReceiptAt: null,
      nextSubmitAt: null,
    });
    expect((await answer(proofResponse(proof))).body['reason']).toBe('Transaction already used');
    expect(await h.store.transaction((tx) => tx.dueProofs('status', T0 + 86_400_000, 10))).toEqual(
      [],
    );
    // A later history read of its order finds the row and leaves it as it is.
    const again = await storeProof(h.shop, {
      ...candidate,
      source: 'detected',
      logIndex: null,
      transferAmount: null,
      order: { orderId: 'o1', status: 'completed' },
    });
    expect(again).toEqual({ proof, created: false });
  });

  it('a lookup that fills the log index of an unlogged hex row schedules its submit 10 s after the fill', async () => {
    const h = harness();
    await seed(h);
    await insertProofs(
      h,
      proofRow({
        source: 'hex',
        txHash: H1,
        logIndex: null,
        rawHex: 'ab',
        sentAt: new Date(T0 - 1_000),
        nextReceiptAt: new Date(T0 + 30_000),
      }),
    );
    h.clock.now = T0 + 5_000;
    const { proof } = await storeProof(h.shop, candidate);
    expect(proof).toMatchObject({
      id: uid(0x401),
      logIndex: 3,
      nextReceiptAt: null,
      nextSubmitAt: new Date(T0 + 15_000),
    });
  });

  it('takes the payment row and then its proof rows first, and no account row', async () => {
    const h = harness();
    await seed(h);
    const calls = recordTxCalls(h);
    await storeProof(h.shop, candidate);
    expect(calls.slice(0, 2)).toEqual(['lockPayment', 'lockProofs']);
    expect(calls).not.toContain('lockAccount');
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
        createdAt: new Date(T0 - 1_000),
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
    expect(await getProof(h, uid(0x4e2))).toMatchObject({ result: null, providerOrder: 'o1' });
  });

  it('refuses the submitted row when both rows were created at the same time and it has the greater id', async () => {
    const h = harness();
    await seed(h);
    await insertProofs(
      h,
      proofRow({ id: uid(0x4e3), txHash: H1 }),
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
    expect(await submitProof(h.shop, uid(0x4e3), 'watcher', T0 + 5_000)).toMatchObject({
      id: uid(0x4e3),
      result: 'refused',
      refusal: 'tx_used',
    });
    expect((await getProof(h, uid(0x4e2)))?.result).toBeNull();
  });

  it.each([
    ['a later created_at', T0 + 1_000, uid(0x4e2)],
    ['the same created_at and the greater id', T0, uid(0x4e2)],
  ])(
    'refuses the holder of another offer on a submit when it is newer (%s), and moves the order to the submitted proof',
    async (_name, createdAt, holderId) => {
      const h = harness();
      await seed(h);
      await insertProofs(
        h,
        proofRow({ id: uid(0x4e1), txHash: H1, nextSubmitAt: new Date(T0 + 5_000) }),
        proofRow({
          id: holderId,
          offerId: OFFER_USDC,
          txHash: H2,
          providerOrder: 'o1',
          orderStatus: 'processing',
          orderFoundAt: new Date(T0),
          nextStatusAt: new Date(T0 + 10_000),
          createdAt: new Date(createdAt),
        }),
      );
      h.orchestra.submit.mockResolvedValueOnce({
        kind: 'order',
        orderId: 'o1',
        status: 'processing',
      });
      // The survivor holds the order in the same transaction, and its
      // progressing order within the bounds makes it `accepted`.
      expect(await submitProof(h.shop, uid(0x4e1), 'watcher', T0 + 5_000)).toMatchObject({
        id: uid(0x4e1),
        result: 'accepted',
        providerOrder: 'o1',
        orderStatus: 'processing',
        orderFoundAt: new Date(T0),
        nextStatusAt: new Date(T0 + 10_000),
        nextSubmitAt: null,
      });
      expect(await getProof(h, holderId)).toMatchObject({
        result: 'refused',
        refusal: 'tx_used',
        providerOrder: null,
        orderStatus: null,
        nextStatusAt: null,
      });
      expect(await getPayment(h)).toMatchObject({ status: 'accepted', endReason: null });

      // The order-status duty now reads the survivor's order.
      h.clock.now = T0 + 20_000;
      h.orchestra.status.mockResolvedValueOnce({
        ok: true,
        order: { id: 'o1', status: 'completed', supersededByOperationId: null },
      });
      await runShopPaymentTick(h.shop, 2);
      expect(h.orchestra.status).toHaveBeenCalledTimes(1);
      expect(h.orchestra.status).toHaveBeenCalledWith('o1', 5_000, {
        paymentId: PAYMENT_ID,
        proofId: uid(0x4e1),
        offerId: OFFER_USDT,
        quoteId: QUOTE_ID,
        providerRef: 'q-usdt-pol',
        orderId: 'o1',
      });
      expect(await getProof(h, uid(0x4e1))).toMatchObject({
        result: 'accepted',
        orderStatus: 'completed',
        nextStatusAt: null,
      });
      expect((await getProof(h, holderId))?.result).toBe('refused');
    },
  );

  it('an accepted newer holder of another offer hands acceptance to the survivor; the payment never ends', async () => {
    const h = harness();
    await seed(h, { status: 'accepted', acceptedAt: new Date(T0) });
    await insertProofs(
      h,
      proofRow({ id: uid(0x4e1), txHash: H1, nextSubmitAt: new Date(T0 + 5_000) }),
      proofRow({
        id: uid(0x4e2),
        offerId: OFFER_USDC,
        txHash: H2,
        result: 'accepted',
        resolvedAt: new Date(T0 + 1_000),
        providerOrder: 'o1',
        orderStatus: 'processing',
        orderFoundAt: new Date(T0 + 1_000),
        nextStatusAt: new Date(T0 + 11_000),
        createdAt: new Date(T0 + 1_000),
      }),
    );
    h.orchestra.submit.mockResolvedValueOnce({
      kind: 'order',
      orderId: 'o1',
      status: 'processing',
    });
    expect(await submitProof(h.shop, uid(0x4e1), 'watcher', T0 + 5_000)).toMatchObject({
      id: uid(0x4e1),
      result: 'accepted',
      providerOrder: 'o1',
    });
    expect(await getProof(h, uid(0x4e2))).toMatchObject({
      result: 'refused',
      refusal: 'tx_used',
      providerOrder: null,
    });
    expect(await getPayment(h)).toMatchObject({ status: 'accepted', endReason: null });
    const events = loggedEvents(warn).map((entry) => entry['event']);
    expect(events).toContain('shop.proof.refused');
    expect(events).not.toContain('shop.payment.ended');
  });

  it('an accepted newer holder ends the payment with proof_refused when the survivor cannot take acceptance', async () => {
    const h = harness();
    await seed(h, { status: 'accepted', acceptedAt: new Date(T0) });
    await insertProofs(
      h,
      // Below the offer's requiredAmountIn: held, not accepted.
      proofRow({
        id: uid(0x4e1),
        txHash: H1,
        transferAmount: '1',
        nextSubmitAt: new Date(T0 + 5_000),
      }),
      proofRow({
        id: uid(0x4e2),
        offerId: OFFER_USDC,
        txHash: H2,
        result: 'accepted',
        resolvedAt: new Date(T0 + 1_000),
        providerOrder: 'o1',
        orderStatus: 'processing',
        orderFoundAt: new Date(T0 + 1_000),
        createdAt: new Date(T0 + 1_000),
      }),
    );
    h.orchestra.submit.mockResolvedValueOnce({
      kind: 'order',
      orderId: 'o1',
      status: 'processing',
    });
    expect(await submitProof(h.shop, uid(0x4e1), 'watcher', T0 + 5_000)).toMatchObject({
      id: uid(0x4e1),
      result: null,
      providerOrder: 'o1',
      nextSubmitAt: null,
      nextStatusAt: new Date(T0 + 10_000),
    });
    expect(await getPayment(h)).toMatchObject({ status: 'ended', endReason: 'proof_refused' });
  });

  const endedHolders = [
    ['refunded', { result: 'refunded' as const, orderStatus: 'refunded' }],
    ['failed', { result: 'failed' as const, orderStatus: 'fallback_delivered' }],
    [
      'refused',
      { result: 'refused' as const, refusal: 'expired_order' as const, orderStatus: 'expired' },
    ],
  ] as const;

  it.each(endedHolders)(
    'refuses the survivor tx_used on a watcher submit when the newer holder of another offer is already %s',
    async (_name, ended) => {
      const h = harness();
      await seed(h);
      await insertProofs(
        h,
        proofRow({ id: uid(0x4e1), txHash: H1, nextSubmitAt: new Date(T0 + 5_000) }),
        proofRow({
          id: uid(0x4e2),
          offerId: OFFER_USDC,
          txHash: H2,
          providerOrder: 'o1',
          orderFoundAt: new Date(T0),
          resolvedAt: new Date(T0 + 1_000),
          createdAt: new Date(T0 + 1_000),
          ...ended,
        }),
      );
      h.orchestra.submit.mockResolvedValueOnce({
        kind: 'order',
        orderId: 'o1',
        status: 'processing',
      });
      const survivor = await submitProof(h.shop, uid(0x4e1), 'watcher', T0 + 5_000);
      expect(survivor).toMatchObject({
        id: uid(0x4e1),
        result: 'refused',
        refusal: 'tx_used',
        providerOrder: null,
        nextSubmitAt: null,
        nextStatusAt: null,
      });
      expect((await answer(proofResponse(survivor!))).body['reason']).toBe(
        'Transaction already used',
      );
      expect(await getProof(h, uid(0x4e2))).toMatchObject({ ...ended, providerOrder: 'o1' });
      // Nothing is due for the survivor any more.
      h.orchestra.submit.mockClear();
      h.clock.now = T0 + 600_000;
      await runShopPaymentTick(h.shop, 2);
      expect(h.orchestra.submit).not.toHaveBeenCalled();
    },
  );

  it.each(endedHolders)(
    'answers Transaction already used on the route when the newer holder of another offer is already %s',
    async (_name, ended) => {
      const h = harness();
      await seed(h);
      await insertProofs(
        h,
        proofRow({
          id: uid(0x4e2),
          offerId: OFFER_USDC,
          txHash: H2,
          providerOrder: 'o1',
          orderFoundAt: new Date(T0),
          resolvedAt: new Date(T0 + 1_000),
          createdAt: new Date(T0 + 1_000),
          ...ended,
        }),
      );
      h.rpc['eth_getTransactionReceipt'] = receiptFor(H1, [usdtLog()]);
      h.orchestra.submit.mockResolvedValueOnce({
        kind: 'order',
        orderId: 'o1',
        status: 'processing',
      });
      expect(await answer(await prove(h, { tx: H1 }))).toMatchObject({
        status: 400,
        body: { reason: 'Transaction already used' },
      });
      const survivor = (await proofsOf(h)).find((row) => row.txHash === H1);
      expect(survivor).toMatchObject({
        result: 'refused',
        refusal: 'tx_used',
        providerOrder: null,
        nextSubmitAt: null,
      });
      expect(await getProof(h, uid(0x4e2))).toMatchObject({ ...ended, providerOrder: 'o1' });
    },
  );

  it('the survivor takes the final status and the order found time of an accepted newer holder', async () => {
    const h = harness();
    await seed(h, { status: 'paid', acceptedAt: new Date(T0), paidAt: new Date(T0 + 2_000) });
    await insertProofs(
      h,
      proofRow({ id: uid(0x4e1), txHash: H1, nextSubmitAt: new Date(T0 + 5_000) }),
      proofRow({
        id: uid(0x4e2),
        offerId: OFFER_USDC,
        txHash: H2,
        result: 'accepted',
        resolvedAt: new Date(T0 + 1_000),
        providerOrder: 'o1',
        orderStatus: 'completed',
        orderFoundAt: new Date(T0 - 60_000),
        createdAt: new Date(T0 + 1_000),
      }),
    );
    // The in-flight submit answers a status read before the holder's.
    h.orchestra.submit.mockResolvedValueOnce({
      kind: 'order',
      orderId: 'o1',
      status: 'processing',
    });
    const survivor = await submitProof(h.shop, uid(0x4e1), 'watcher', T0 + 5_000);
    expect(survivor).toMatchObject({
      id: uid(0x4e1),
      result: 'accepted',
      providerOrder: 'o1',
      orderStatus: 'completed',
      orderFoundAt: new Date(T0 - 60_000),
      nextStatusAt: null,
      nextSubmitAt: null,
    });
    expect(await answer(proofResponse(survivor!))).toEqual({
      status: 200,
      body: { txId: H1 },
    });
    expect(await getProof(h, uid(0x4e2))).toMatchObject({
      result: 'refused',
      refusal: 'tx_used',
      providerOrder: null,
    });
    expect((await getPayment(h))?.status).toBe('paid');
  });

  it('the survivor takes the answered status and finds the order now when the newer holder stored neither', async () => {
    const h = harness();
    await seed(h);
    await insertProofs(
      h,
      proofRow({ id: uid(0x4e1), txHash: H1, nextSubmitAt: new Date(T0 + 5_000) }),
      proofRow({
        id: uid(0x4e2),
        offerId: OFFER_USDC,
        txHash: H2,
        providerOrder: 'o1',
        createdAt: new Date(T0 + 1_000),
      }),
    );
    h.orchestra.submit.mockResolvedValueOnce({
      kind: 'order',
      orderId: 'o1',
      status: 'swapping',
    });
    h.clock.now = T0 + 2_000;
    expect(await submitProof(h.shop, uid(0x4e1), 'watcher', T0 + 5_000)).toMatchObject({
      id: uid(0x4e1),
      result: 'accepted',
      providerOrder: 'o1',
      orderStatus: 'swapping',
      orderFoundAt: new Date(T0 + 2_000),
    });
  });

  it('refuses the filled row on the storing path even when the holder of another offer is newer', async () => {
    const h = harness();
    await seed(h);
    const proof = proofRow({ id: uid(0x4e1), txHash: H1 });
    await insertProofs(
      h,
      proof,
      proofRow({
        id: uid(0x4e2),
        offerId: OFFER_USDC,
        txHash: H2,
        providerOrder: 'o1',
        orderStatus: 'processing',
        createdAt: new Date(T0 + 1_000),
      }),
    );
    const after = await h.store.transaction(async (tx) => {
      await lockPaymentForProofs(tx, PAYMENT_ID);
      return applyProofOrder(tx, proof, { orderId: 'o1', status: 'processing' }, T0, 'filling');
    });
    expect(after).toMatchObject({ id: uid(0x4e1), result: 'refused', refusal: 'tx_used' });
    expect((await getProof(h, uid(0x4e2)))?.result).toBeNull();
  });

  it('refuses an accepted row with tx_used when the order it takes belongs to another offer, and ends its payment', async () => {
    const h = harness();
    await seed(h, { status: 'accepted', acceptedAt: new Date(T0) });
    const accepted = proofRow({
      id: uid(0x4e1),
      txHash: H1,
      providerOrder: 'o1',
      orderStatus: 'refunding',
      result: 'accepted',
      nextReceiptAt: new Date(T0),
      nextStatusAt: new Date(T0 + 10_000),
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
    const after = await h.store.transaction(async (tx) => {
      await lockPaymentForProofs(tx, PAYMENT_ID);
      return applyProofOrder(tx, accepted, { orderId: 'o2', status: 'refunding' }, T0, 'filling');
    });
    expect(after).toMatchObject({
      id: uid(0x4e1),
      providerOrder: 'o1',
      result: 'refused',
      refusal: 'tx_used',
      nextReceiptAt: null,
      nextStatusAt: null,
    });
    expect(await getPayment(h)).toMatchObject({ status: 'ended', endReason: 'proof_refused' });
    expect((await getProof(h, uid(0x4e2)))?.providerOrder).toBe('o2');
    const kept = await h.store.transaction((tx) =>
      applyProofOrder(tx, failed, { orderId: 'o2', status: 'refunding' }, T0, 'filling'),
    );
    expect(kept).toMatchObject({ id: uid(0x4e3), providerOrder: 'o3', result: 'failed' });
  });

  it("keeps a successor order that carries the replaced proof's transaction as its own unlogged proof", async () => {
    const h = harness();
    await seed(h);
    await insertProofs(
      h,
      proofRow({
        id: uid(0x4f1),
        txHash: H1,
        logIndex: 3,
        providerOrder: 'o1',
        orderStatus: 'unfulfilled',
        orderFoundAt: new Date(T0 - 1_000),
        supersededByOrder: 'o2',
        createdAt: new Date(T0 - 1_000),
      }),
    );
    const { proof, created } = await storeProof(h.shop, {
      offer: offerRow(),
      paymentId: PAYMENT_ID,
      source: 'detected',
      txHash: H1,
      logIndex: null,
      userOpHash: null,
      rawHex: null,
      transferAmount: null,
      order: { orderId: 'o2', status: 'processing' },
    });
    expect(created).toBe(true);
    expect(proof).toMatchObject({ logIndex: null, providerOrder: 'o2' });
    h.rpc['eth_getTransactionReceipt'] = receiptFor(H1, [usdtLog()]);
    expect(await readProofReceipt(h.shop, proof, POLYGON_RPC, 1_000)).toBe('held');
    const rows = await proofsOf(h);
    expect(rows.map((row) => [row.id, row.logIndex, row.providerOrder])).toEqual(
      expect.arrayContaining([
        [uid(0x4f1), 3, 'o1'],
        [proof.id, null, 'o2'],
      ]),
    );
    expect(rows).toHaveLength(2);
    expect(await getProof(h, proof.id)).toMatchObject({ nextReceiptAt: null, result: null });
    expect(events()).not.toContain('shop.alert.detected_mismatch');
  });

  it('fills a free log of the same transaction while another order holds the other one', async () => {
    const h = harness();
    await seed(h);
    await insertProofs(
      h,
      proofRow({ id: uid(0x4f1), txHash: H1, logIndex: 3, providerOrder: 'o1' }),
      proofRow({
        id: uid(0x4f2),
        source: 'detected',
        txHash: H1,
        logIndex: null,
        transferAmount: null,
        providerOrder: 'o2',
        nextReceiptAt: new Date(T0),
      }),
    );
    h.rpc['eth_getTransactionReceipt'] = receiptFor(H1, [usdtLog(), usdtLog(BigInt(AMOUNT_IN), 5)]);
    const detected = (await getProof(h, uid(0x4f2)))!;
    expect(await readProofReceipt(h.shop, detected, POLYGON_RPC, 1_000)).toBe('filled');
    expect(await getProof(h, uid(0x4f2))).toMatchObject({ logIndex: 5, providerOrder: 'o2' });
    expect(await getProof(h, uid(0x4f1))).toMatchObject({ logIndex: 3, providerOrder: 'o1' });
  });

  it('merges a row with an order into the holder of its only log when the holder has the same order or none', async () => {
    const h = harness();
    await seed(h);
    await insertProofs(
      h,
      proofRow({ id: uid(0x4f1), txHash: H1, logIndex: 3, providerOrder: 'o1' }),
      proofRow({
        id: uid(0x4f2),
        source: 'detected',
        txHash: H1,
        logIndex: null,
        transferAmount: null,
        createdAt: new Date(T0 + 5),
      }),
    );
    h.rpc['eth_getTransactionReceipt'] = receiptFor(H1, [usdtLog()]);
    const detected = (await getProof(h, uid(0x4f2)))!;
    expect(await readProofReceipt(h.shop, detected, POLYGON_RPC, 1_000)).toBe('filled');
    expect((await proofsOf(h)).map((row) => [row.id, row.providerOrder])).toEqual([
      [uid(0x4f1), 'o1'],
    ]);
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
      applyProofOrder(tx, proof, { orderId: 'o1', status: 'swapping' }, T0, 'filling'),
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

  it('passes the proof ids to Orchestra and logs them on every submit event; the answer locks the payment row, then its proof rows', async () => {
    const h = harness();
    await seed(h);
    await insertProofs(h, proofRow());
    const ids = {
      paymentId: PAYMENT_ID,
      proofId: uid(0x401),
      offerId: OFFER_USDT,
      quoteId: QUOTE_ID,
      providerRef: 'q-usdt-pol',
    };
    h.orchestra.submit.mockResolvedValueOnce({
      kind: 'order',
      orderId: 'o1',
      status: 'processing',
    });
    const calls = recordTxCalls(h);
    await submitProofAttempt(h.shop, uid(0x401), 'watcher', T0 + 5_000);
    expect(h.orchestra.submit.mock.calls[0]?.[5]).toEqual(ids);
    // The claim writes last_submit_at; the answer's transaction locks first.
    expect(calls.slice(0, 3)).toEqual(['updateProof', 'lockPayment', 'lockProofs']);
    expect(calls).not.toContain('lockAccount');
    const logged = (event: string): Record<string, unknown>[] =>
      loggedEvents(warn)
        .filter((line) => line['event'] === event)
        .map(({ ts: _ts, event: _event, ...fields }) => fields);
    expect(logged('shop.proof.submitted')).toEqual([{ ...ids, orderId: 'o1', answer: 'order' }]);
    expect(logged('shop.proof.accepted')).toEqual([{ ...ids, orderId: 'o1' }]);
    await insertProofs(h, proofRow({ id: uid(0x403), txHash: H2, logIndex: 4 }));
    h.orchestra.submit.mockResolvedValueOnce({ kind: 'unresolved', retryable: true });
    await submitProofAttempt(h.shop, uid(0x403), 'watcher', T0 + 5_000);
    expect(logged('shop.proof.unresolved')).toEqual([{ ...ids, proofId: uid(0x403) }]);
    h.clock.now += 2_000;
    h.orchestra.submit.mockResolvedValueOnce({ kind: 'quote_expired' });
    await submitProofAttempt(h.shop, uid(0x403), 'watcher', T0 + 9_000);
    expect(logged('shop.proof.late')).toEqual([{ ...ids, proofId: uid(0x403) }]);
    expect(logged('shop.alert.late_deposit')).toEqual([{ ...ids, proofId: uid(0x403) }]);
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

  it('sets sent_at once and schedules the first receipt read, never a submit', async () => {
    const h = harness();
    await seed(h);
    const sent = proofRow({
      source: 'hex',
      rawHex: 'ab',
      logIndex: null,
      sentAt: new Date(T0 - 1_000),
    });
    const fresh = proofRow({
      id: uid(0x402),
      txHash: H2,
      source: 'hex',
      rawHex: 'ab',
      logIndex: null,
    });
    await insertProofs(h, sent, fresh);
    expect(await sendHexProof(h.shop, sent, POLYGON_RPC, 1_000)).toBe('sent');
    expect((await getProof(h, sent.id))?.sentAt?.getTime()).toBe(T0 - 1_000);
    expect(await sendHexProof(h.shop, fresh, POLYGON_RPC, 1_000)).toBe('sent');
    expect(await getProof(h, fresh.id)).toMatchObject({
      sentAt: new Date(T0),
      nextReceiptAt: new Date(T0 + 30_000),
      nextSubmitAt: null,
    });
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

  it('logs detected_mismatch with the offer, quote, provider reference, and the order of a detected proof', async () => {
    const h = harness();
    await seed(h);
    const proof = proofRow({
      source: 'detected',
      logIndex: null,
      transferAmount: null,
      providerOrder: 'o7',
      orderStatus: 'processing',
    });
    await insertProofs(h, proof);
    h.rpc['eth_getTransactionReceipt'] = receiptFor(H1, [OTHER_LOG]);
    expect(await readProofReceipt(h.shop, proof, POLYGON_RPC, 1_000)).toBe('mismatch');
    expect(
      loggedEvents(warn)
        .filter((line) => line['event'] === 'shop.alert.detected_mismatch')
        .map(({ ts: _ts, event: _event, ...fields }) => fields),
    ).toEqual([
      {
        paymentId: PAYMENT_ID,
        proofId: proof.id,
        offerId: OFFER_USDT,
        quoteId: QUOTE_ID,
        providerRef: 'q-usdt-pol',
        orderId: 'o7',
        source: 'detected',
      },
    ]);
  });

  it('reports an error when a merge deleted the row while the receipt was read', async () => {
    const h = harness();
    await seed(h);
    h.rpc['eth_getTransactionReceipt'] = receiptFor(H1, [usdtLog()]);
    const deleted = proofRow({ source: 'detected', logIndex: null, transferAmount: null });
    expect(await readProofReceipt(h.shop, deleted, POLYGON_RPC, 1_000)).toBe('error');
    expect(await proofsOf(h)).toEqual([]);
  });

  it('a filled hex proof gets next_submit_at 10 s after the fill; one with a submit scheduled or an order keeps its schedule', async () => {
    const h = harness();
    await seed(h);
    await insertProofs(
      h,
      proofRow({ source: 'hex', rawHex: 'ab', logIndex: null, sentAt: new Date(T0) }),
      proofRow({
        id: uid(0x402),
        txHash: H2,
        source: 'hex',
        rawHex: 'cd',
        logIndex: null,
        nextSubmitAt: new Date(T0 + 99_000),
      }),
      proofRow({
        id: uid(0x403),
        txHash: txHash('a3'),
        source: 'detected',
        logIndex: null,
        transferAmount: null,
        providerOrder: 'o3',
        orderStatus: 'refunding',
      }),
    );
    h.clock.now = T0 + 40_000;
    h.rpc['eth_getTransactionReceipt'] = (params) => ({
      result: receiptJson(String(params[0]), '0x1', [usdtLog()]),
    });
    const calls = recordTxCalls(h);
    for (const id of [uid(0x401), uid(0x402), uid(0x403)]) {
      expect(await readProofReceipt(h.shop, (await getProof(h, id))!, POLYGON_RPC, 1_000)).toBe(
        'filled',
      );
    }
    expect(await getProof(h, uid(0x401))).toMatchObject({
      logIndex: 3,
      nextReceiptAt: null,
      nextSubmitAt: new Date(T0 + 50_000),
    });
    expect((await getProof(h, uid(0x402)))?.nextSubmitAt).toEqual(new Date(T0 + 99_000));
    expect(await getProof(h, uid(0x403))).toMatchObject({ logIndex: 3, nextSubmitAt: null });
    // Each fill locks the payment row, then its proof rows, before any write.
    const fills = calls.join(',').split('lockPayment,lockProofs,').slice(1);
    expect(fills).toHaveLength(3);
    expect(calls).not.toContain('lockAccount');
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
      proofRow({
        id: uid(0x404),
        txHash: txHash('a4'),
        source: 'hex',
        rawHex: 'ab',
        logIndex: null,
        sentAt: new Date(T0),
        result: 'stuck',
      }),
      proofRow({
        id: uid(0x405),
        txHash: txHash('a5'),
        source: 'hex',
        rawHex: 'ab',
        logIndex: 2,
        sentAt: new Date(T0),
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
    expect(await retryStuckProof(h.shop, uid(0x404))).toBe('retried');
    // A sent hex proof without a log index reads and sends its transaction again.
    expect(await getProof(h, uid(0x404))).toMatchObject({
      result: null,
      nextSubmitAt: null,
      nextReceiptAt: new Date(T0 + 90_000_000),
    });
    expect(await retryStuckProof(h.shop, uid(0x405))).toBe('retried');
    // A hex proof whose receipt filled its log index is submitted again.
    expect(await getProof(h, uid(0x405))).toMatchObject({
      nextSubmitAt: new Date(T0 + 90_000_000),
      nextReceiptAt: null,
    });
    expect(loggedEvents(warn).filter((line) => line['event'] === 'shop.proof.retried')).toEqual([
      expect.objectContaining({
        paymentId: PAYMENT_ID,
        proofId: uid(0x401),
        offerId: OFFER_USDT,
        quoteId: QUOTE_ID,
        providerRef: 'q-usdt-pol',
      }),
      expect.objectContaining({ proofId: uid(0x403) }),
      expect.objectContaining({ proofId: uid(0x404) }),
      expect.objectContaining({ proofId: uid(0x405) }),
    ]);
  });

  it('locks the payment row, then its proof rows, and no account row', async () => {
    const h = harness();
    await seed(h);
    await insertProofs(h, proofRow({ result: 'stuck' }));
    const calls = recordTxCalls(h);
    expect(await retryStuckProof(h.shop, uid(0x401))).toBe('retried');
    expect(calls).toEqual(['lockPayment', 'lockProofs', 'updateProof']);
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
