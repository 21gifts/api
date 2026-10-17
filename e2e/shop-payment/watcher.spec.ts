/**
 * Orders the api learns about from Orchestra's history, not from a proof
 * (`docs/shop-stablecoin-payment.md`, Implementation › Tests, and Watcher):
 * an order created without a submit makes the payment `accepted`; a second
 * completed order moves acceptance to it; a dust transfer to the deposit
 * address does not take acceptance from the payer.
 */

import { expect, test } from '@playwright/test';
import type { TransferResult } from './stand-ins/control-types';
import {
  Control,
  describeRun,
  fetchDetail,
  openPayerPayment,
  paymentStatus,
  proofAnswer,
  sticker,
  tetherWallet,
  verifiedShop,
} from './fixtures';

/** The watcher reads history every 10 s and receipts after 30 s; leave room for both. */
const WATCHER_TIMEOUT_MS = 150_000;

test.afterEach(async ({ request }) => {
  expect(await new Control(request).violations()).toEqual([]);
});

test('an order Orchestra created without a submit makes the payment accepted', async ({
  request,
}) => {
  test.setTimeout(WATCHER_TIMEOUT_MS + 60_000);
  const control = new Control(request);
  const shop = await verifiedShop(request, 'watch');
  await control.behave(shop.username, { completeAfterMs: null });
  const opened = await openPayerPayment(request, shop.username, 3_000);
  const detail = await fetchDetail(request, shop.username, 'polygon-usdt');
  // The payer pays and never sends a proof; Orchestra detects the deposit.
  const sent = await control.transfer({
    chainId: detail.chainId,
    token: detail.token,
    to: detail.recipient,
    amount: detail.amountSmallest.toString(),
    detect: 'running',
  });
  expect(sent.orderId).not.toBeNull();
  await expect
    .poll(async () => (await paymentStatus(request, opened.payment)).paymentStatus, {
      timeout: WATCHER_TIMEOUT_MS,
      intervals: [2_000],
    })
    .toBe('accepted');
  const state = await control.state(shop.username);
  expect(state.historyReads).toBeGreaterThanOrEqual(1);
  expect(state.submits).toEqual([]);
  // The detected proof's amount came from the receipt, which the watcher read.
  expect(state.receiptReads[sent.txHash]).toBeGreaterThanOrEqual(1);
  // A late proof of the same transfer answers from the stored, accepted row.
  const late = await proofAnswer(request, detail.proof, sent.txHash);
  expect(late).toEqual({ status: 200, message: sent.txHash });
});

test('a second completed order moves acceptance to it', async ({ request }) => {
  test.setTimeout(WATCHER_TIMEOUT_MS + 60_000);
  const control = new Control(request);
  const shop = await verifiedShop(request, 'second');
  await control.behave(shop.username, { submit: 'accept', completeAfterMs: null });
  const opened = await openPayerPayment(request, shop.username, 3_100);
  // Payer B scans first and holds an Arbitrum detail of the same quote.
  const detailB = await fetchDetail(request, shop.username, 'arbitrum-usdt');
  // Payer A pays on Polygon and is accepted with a running order.
  const seenA: TransferResult[] = [];
  const runA = await tetherWallet(request, control, {}, seenA).pay(sticker(shop.username), {
    railId: 'polygon-usdt',
  });
  expect(runA.outcome, describeRun(runA)).toBe('OPEN_CRYPTO_PAY_SETTLED');
  expect((await paymentStatus(request, opened.payment)).paymentStatus).toBe('accepted');
  const railA = runA.rail;
  if (railA?.kind !== 'transfer' || runA.sentHash === undefined) {
    throw new Error('payer A did not pay');
  }
  // Payer B pays too; Orchestra detects it and its order pays the BOLT11 first.
  const sentB = await control.transfer({
    chainId: detailB.chainId,
    token: detailB.token,
    to: detailB.recipient,
    amount: detailB.amountSmallest.toString(),
    detect: 'completed',
  });
  const stateB = await control.state(shop.username);
  expect(stateB.orders.find((order) => order.id === sentB.orderId)?.status).toBe('completed');
  // Acceptance moves to B: A's repeat no longer gets 200.
  await expect
    .poll(async () => (await proofAnswer(request, railA.proof, runA.sentHash ?? '')).message, {
      timeout: WATCHER_TIMEOUT_MS,
      intervals: [2_000],
    })
    .toMatch(/^(Another transfer is paying this payment|The transfer was not completed)$/);
  expect((await proofAnswer(request, railA.proof, runA.sentHash)).status).toBe(400);
  await expect
    .poll(async () => (await paymentStatus(request, opened.payment)).paymentStatus, {
      timeout: 30_000,
    })
    .toBe('paid');
  // B's own proof answers from the accepted row.
  expect(await proofAnswer(request, detailB.proof, sentB.txHash)).toEqual({
    status: 200,
    message: sentB.txHash,
  });
  // Orchestra failed A's order with duplicate_lightning_invoice.
  const final = await control.state(shop.username);
  const orderA = final.orders.find((order) => order.sourceTxHash === runA.sentHash);
  expect(orderA?.status).toBe('failed');
});

test('a dust transfer to the deposit address does not take acceptance from the payer', async ({
  request,
}) => {
  test.setTimeout(WATCHER_TIMEOUT_MS + 60_000);
  const control = new Control(request);
  const shop = await verifiedShop(request, 'dust');
  await control.behave(shop.username, { submit: 'accept', completeAfterMs: null });
  const opened = await openPayerPayment(request, shop.username, 3_200);
  const runA = await tetherWallet(request, control).pay(sticker(shop.username), {
    railId: 'polygon-usdt',
  });
  expect(runA.outcome, describeRun(runA)).toBe('OPEN_CRYPTO_PAY_SETTLED');
  const railA = runA.rail;
  if (railA?.kind !== 'transfer' || runA.sentHash === undefined) {
    throw new Error('payer A did not pay');
  }
  // A stranger sends 1 unit to the public deposit address; Orchestra opens an order for it.
  const dust = await control.transfer({
    chainId: railA.chainId,
    token: railA.token,
    to: railA.recipient,
    amount: '1',
    detect: 'running',
  });
  expect(dust.orderId).not.toBeNull();
  // Wait until the watcher found the dust order and read its receipt (amount known).
  await expect
    .poll(
      async () => {
        const state = await control.state(shop.username);
        return {
          statusRead: (state.statusReads[dust.orderId ?? ''] ?? 0) > 0 || state.historyReads > 1,
          receiptRead: (state.receiptReads[dust.txHash] ?? 0) > 0,
        };
      },
      { timeout: WATCHER_TIMEOUT_MS, intervals: [2_000] },
    )
    .toEqual({ statusRead: true, receiptRead: true });
  // One more watcher round after the receipt.
  await new Promise((resolve) => setTimeout(resolve, 12_000));
  expect(await proofAnswer(request, railA.proof, runA.sentHash)).toEqual({
    status: 200,
    message: runA.sentHash,
  });
  expect((await paymentStatus(request, opened.payment)).paymentStatus).toBe('accepted');
  // The stranger's proof of the dust is held: 503, never 200.
  expect(await proofAnswer(request, railA.proof, dust.txHash)).toEqual({
    status: 503,
    message: 'Payment is being confirmed',
  });
});
