/**
 * Tether Wallet 1.11.0 pays a payer-opened shop payment with USDT on each of
 * its three EVM rails and reaches settled (`docs/shop-stablecoin-payment.md`,
 * Implementation › Tests): when the first proof attempt is accepted, when it
 * gets 503 and a later attempt's resubmit is accepted, when Orchestra
 * detected the deposit and paid before the proof, and when Orchestra
 * detected the deposit and its order is still running.
 */

import { expect, test } from '@playwright/test';
import type { TransferResult } from './stand-ins/control-types';
import {
  Control,
  describeRun,
  openPayerPayment,
  paymentStatus,
  sticker,
  tetherWallet,
  verifiedShop,
} from './fixtures';

const RAILS = [
  { railId: 'ethereum-usdt', method: 'Ethereum', chainId: 1 },
  { railId: 'polygon-usdt', method: 'Polygon', chainId: 137 },
  { railId: 'arbitrum-usdt', method: 'Arbitrum', chainId: 42161 },
] as const;

test.afterEach(async ({ request }) => {
  expect(await new Control(request).violations()).toEqual([]);
});

for (const rail of RAILS) {
  test.describe(`${rail.method} USDT`, () => {
    test(`first attempt accepted reaches settled and the payment is paid`, async ({ request }) => {
      const control = new Control(request);
      const shop = await verifiedShop(request, `a-${rail.chainId}`);
      await control.behave(shop.username, { submit: 'accept', completeAfterMs: 500 });
      const opened = await openPayerPayment(request, shop.username, 2_100);
      const seen: TransferResult[] = [];
      const run = await tetherWallet(request, control, {}, seen).pay(sticker(shop.username), {
        railId: rail.railId,
      });
      expect(run.outcome, describeRun(run)).toBe('OPEN_CRYPTO_PAY_SETTLED');
      expect(run.payment?.saleId).toBe(opened.payment);
      // The rail list matched exactly: Lightning plus this USDT rail at least.
      expect(run.options?.map((option) => option.rail.id)).toContain(rail.railId);
      expect(run.options?.map((option) => option.rail.id)).toContain('lightning-btc');
      // Bundle hash, one attempt, accepted with that hash as txId.
      expect(run.sentHash).toBe(seen[0]?.txHash);
      expect(run.attempts).toEqual([
        { attempt: 1, outcome: 'accepted', status: 200, detail: run.sentHash },
      ]);
      const state = await control.state(shop.username);
      expect(state.submits.filter((s) => s.txHash === run.sentHash).map((s) => s.status)).toEqual([
        200,
      ]);
      await expect
        .poll(async () => (await paymentStatus(request, opened.payment)).paymentStatus, {
          timeout: 30_000,
        })
        .toBe('paid');
    });

    test(`first attempt 503, a later attempt's resubmit accepted, reaches settled`, async ({
      request,
    }) => {
      const control = new Control(request);
      const shop = await verifiedShop(request, `b-${rail.chainId}`);
      await control.behave(shop.username, { submit: 'fail-first', completeAfterMs: 500 });
      const opened = await openPayerPayment(request, shop.username, 3_300);
      const run = await tetherWallet(request, control).pay(sticker(shop.username), {
        railId: rail.railId,
      });
      expect(run.outcome, describeRun(run)).toBe('OPEN_CRYPTO_PAY_SETTLED');
      expect(run.attempts[0]?.outcome).toBe('thrown');
      expect(run.attempts.at(-1)).toMatchObject({ outcome: 'accepted', detail: run.sentHash });
      expect(run.attempts.length).toBeGreaterThanOrEqual(2);
      expect(run.attempts.length).toBeLessThanOrEqual(3);
      const statuses = (await control.state(shop.username)).submits
        .filter((s) => s.txHash === run.sentHash)
        .map((s) => s.status);
      expect(statuses[0]).toBe(503);
      expect(statuses).toContain(200);
      await expect
        .poll(async () => (await paymentStatus(request, opened.payment)).paymentStatus, {
          timeout: 30_000,
        })
        .toBe('paid');
    });

    test(`deposit detected and paid before the proof reaches settled`, async ({ request }) => {
      const control = new Control(request);
      const shop = await verifiedShop(request, `c-${rail.chainId}`);
      await control.behave(shop.username, { submit: 'accept', completeAfterMs: null });
      const opened = await openPayerPayment(request, shop.username, 4_400);
      const seen: TransferResult[] = [];
      const wallet = tetherWallet(request, control, { detect: 'completed' }, seen);
      const run = await wallet.pay(sticker(shop.username), { railId: rail.railId });
      expect(run.outcome, describeRun(run)).toBe('OPEN_CRYPTO_PAY_SETTLED');
      expect(seen[0]?.orderId).not.toBeNull();
      const state = await control.state(shop.username);
      // One order, made by Orchestra's own detection, completed before the proof.
      expect(state.orders).toEqual([
        expect.objectContaining({ id: seen[0]?.orderId, status: 'completed', viaSubmit: false }),
      ]);
      expect(run.attempts.at(-1)).toMatchObject({ outcome: 'accepted', detail: run.sentHash });
      await expect
        .poll(async () => (await paymentStatus(request, opened.payment)).paymentStatus, {
          timeout: 30_000,
        })
        .toBe('paid');
    });

    test(`deposit detected with its order still running reaches settled`, async ({ request }) => {
      const control = new Control(request);
      const shop = await verifiedShop(request, `d-${rail.chainId}`);
      await control.behave(shop.username, { submit: 'accept', completeAfterMs: null });
      const opened = await openPayerPayment(request, shop.username, 5_500);
      const seen: TransferResult[] = [];
      const wallet = tetherWallet(request, control, { detect: 'running' }, seen);
      const run = await wallet.pay(sticker(shop.username), { railId: rail.railId });
      expect(run.outcome, describeRun(run)).toBe('OPEN_CRYPTO_PAY_SETTLED');
      const state = await control.state(shop.username);
      expect(state.orders).toEqual([
        expect.objectContaining({ id: seen[0]?.orderId, status: 'processing', viaSubmit: false }),
      ]);
      // Accepted: on its way, not paid, and the sticker is free.
      expect((await paymentStatus(request, opened.payment)).paymentStatus).toBe('accepted');
      expect(run.polls.at(-1)?.kind).toBe('no-pending-payment');
    });
  });
}

test('a user-operation hash is proved when the bundler receipt has no transaction hash', async ({
  request,
}) => {
  const control = new Control(request);
  const shop = await verifiedShop(request, 'uop');
  await control.behave(shop.username, { submit: 'accept', completeAfterMs: 500 });
  const opened = await openPayerPayment(request, shop.username, 2_200);
  const seen: TransferResult[] = [];
  const wallet = tetherWallet(request, control, { userOpOnly: true }, seen);
  const run = await wallet.pay(sticker(shop.username), { railId: 'arbitrum-usdt' });
  expect(run.outcome, describeRun(run)).toBe('OPEN_CRYPTO_PAY_SETTLED');
  expect(run.sentHash).toBe(seen[0]?.userOpHash);
  // The api submitted the bundle hash it read from the user-operation receipt.
  const state = await control.state(shop.username);
  expect(state.submits.map((s) => s.txHash)).toContain(seen[0]?.txHash);
  expect(state.receiptReads[seen[0]?.userOpHash ?? '']).toBeGreaterThanOrEqual(1);
  await expect
    .poll(async () => (await paymentStatus(request, opened.payment)).paymentStatus, {
      timeout: 30_000,
    })
    .toBe('paid');
});
