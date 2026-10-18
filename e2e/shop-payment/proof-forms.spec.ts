/**
 * Proof forms Tether Wallet 1.11.0 does not send but the api accepts
 * (`docs/shop-stablecoin-payment.md`, Proof › Accepted forms and
 * Verification of `hex`), and the operator retry route.
 */

import { randomBytes } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { keccak256 } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import {
  Control,
  DEBUG,
  fetchDetail,
  openPayerPayment,
  paymentStatus,
  proofAnswer,
  verifiedShop,
} from './fixtures';

test.afterEach(async ({ request }) => {
  expect(await new Control(request).violations()).toEqual([]);
});

test('a signed raw transaction (hex) is checked, broadcast, submitted, and accepted', async ({
  request,
}) => {
  const control = new Control(request);
  const shop = await verifiedShop(request, 'hex');
  await control.behave(shop.username, { submit: 'accept', completeAfterMs: 500 });
  const opened = await openPayerPayment(request, shop.username, 2_600);
  const detail = await fetchDetail(request, shop.username, 'polygon-usdt');
  const payer = privateKeyToAccount(`0x${randomBytes(32).toString('hex')}`);
  const data =
    `0xa9059cbb${detail.recipient.slice(2).toLowerCase().padStart(64, '0')}${detail.amountSmallest
      .toString(16)
      .padStart(64, '0')}` as const;
  const raw = await payer.signTransaction({
    type: 'eip1559',
    chainId: detail.chainId,
    to: detail.token as `0x${string}`,
    data,
    value: 0n,
    nonce: 0,
    gas: 100_000n,
    maxFeePerGas: 3_000_000_000n,
    maxPriorityFeePerGas: 1_500_000_000n,
  });
  // A wallet retries a 5xx; the third answer is final.
  let answer = await proofAnswer(request, detail.proof, { hex: raw });
  for (let attempt = 0; attempt < 2 && answer.status >= 500; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 2_500));
    answer = await proofAnswer(request, detail.proof, { hex: raw });
  }
  expect(answer).toEqual({ status: 200, message: keccak256(raw) });
  const state = await control.state(shop.username);
  expect(state.submits.map((s) => s.txHash)).toContain(keccak256(raw));
  // Broadcast exactly once, on the method's chain.
  expect((await control.broadcasts()).filter((b) => b.hash === keccak256(raw))).toEqual([
    { chainId: detail.chainId, hash: keccak256(raw) },
  ]);
  await expect
    .poll(async () => (await paymentStatus(request, opened.payment)).paymentStatus, {
      timeout: 30_000,
    })
    .toBe('paid');
});

test('a hex transfer to another address is refused and never broadcast', async ({ request }) => {
  const control = new Control(request);
  const shop = await verifiedShop(request, 'hexbad');
  await openPayerPayment(request, shop.username, 2_700);
  const detail = await fetchDetail(request, shop.username, 'arbitrum-usdt');
  const payer = privateKeyToAccount(`0x${randomBytes(32).toString('hex')}`);
  const elsewhere = randomBytes(20).toString('hex');
  const raw = await payer.signTransaction({
    type: 'eip1559',
    chainId: detail.chainId,
    to: detail.token as `0x${string}`,
    data: `0xa9059cbb${elsewhere.padStart(64, '0')}${detail.amountSmallest.toString(16).padStart(64, '0')}`,
    value: 0n,
    nonce: 0,
    gas: 100_000n,
    maxFeePerGas: 3_000_000_000n,
    maxPriorityFeePerGas: 1_500_000_000n,
  });
  expect(await proofAnswer(request, detail.proof, { hex: raw })).toEqual({
    status: 400,
    message: 'Payment was not accepted',
  });
  expect((await control.state(shop.username)).submits).toEqual([]);
  // Nothing is broadcast: no eth_sendRawTransaction carried this transaction.
  expect((await control.broadcasts()).filter((b) => b.hash === keccak256(raw))).toEqual([]);
});

test('POST /debug/shop-proofs/:id/retry needs the debug token and a stored proof', async ({
  request,
}) => {
  const unknown = '00000000-0000-4000-8000-000000000000';
  expect((await request.post(`/debug/shop-proofs/${unknown}/retry`)).status()).toBe(401);
  const missing = await request.post(`/debug/shop-proofs/${unknown}/retry`, { headers: DEBUG });
  expect(missing.status()).toBe(404);
  expect(await missing.json()).toEqual({ error: 'Not found' });
});
