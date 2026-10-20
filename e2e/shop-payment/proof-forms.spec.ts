/**
 * Proof forms Tether Wallet 1.11.0 does not send but the api accepts
 * (`docs/shop-stablecoin-payment.md`, Proof › Accepted forms and
 * Verification of `hex`: submitted only once its receipt is found), and the
 * operator retry route.
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
  // Includes the stand-in's check that no hex transaction is submitted before its receipt.
  expect(await new Control(request).violations()).toEqual([]);
});

/**
 * Sign the detail's ERC-20 transfer as an EIP-1559 transaction of a fresh payer.
 *
 * @param detail - The rail detail.
 * @returns The signed raw transaction.
 */
async function signedTransfer(
  detail: Awaited<ReturnType<typeof fetchDetail>>,
): Promise<`0x${string}`> {
  const payer = privateKeyToAccount(`0x${randomBytes(32).toString('hex')}`);
  const data =
    `0xa9059cbb${detail.recipient.slice(2).toLowerCase().padStart(64, '0')}${detail.amountSmallest
      .toString(16)
      .padStart(64, '0')}` as const;
  return payer.signTransaction({
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
}

test('a signed raw transaction (hex) is checked, broadcast, its receipt read, then submitted and accepted', async ({
  request,
}) => {
  const control = new Control(request);
  const shop = await verifiedShop(request, 'hex');
  await control.behave(shop.username, { submit: 'accept', completeAfterMs: 500 });
  const opened = await openPayerPayment(request, shop.username, 2_600);
  const detail = await fetchDetail(request, shop.username, 'polygon-usdt');
  const raw = await signedTransfer(detail);
  // A wallet retries a 5xx; the third answer is final.
  let answer = await proofAnswer(request, detail.proof, { hex: raw });
  for (let attempt = 0; attempt < 2 && answer.status >= 500; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 2_500));
    answer = await proofAnswer(request, detail.proof, { hex: raw });
  }
  expect(answer).toEqual({ status: 200, message: keccak256(raw) });
  const state = await control.state(shop.username);
  expect(state.submits.map((s) => s.txHash)).toContain(keccak256(raw));
  // Submitted only after the api read its receipt (the stand-in checks the order).
  expect(state.receiptReads[keccak256(raw)]).toBeGreaterThanOrEqual(1);
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

test('a hex transaction mined after the proof request is not submitted until the watcher finds its receipt', async ({
  request,
}) => {
  test.setTimeout(150_000);
  const control = new Control(request);
  const shop = await verifiedShop(request, 'hexlate');
  // The node keeps the broadcast transaction unmined for 20 s.
  await control.behave(shop.username, {
    submit: 'accept',
    completeAfterMs: 500,
    mineAfterMs: 20_000,
  });
  const opened = await openPayerPayment(request, shop.username, 2_650);
  const detail = await fetchDetail(request, shop.username, 'polygon-usdt');
  const raw = await signedTransfer(detail);
  const hash = keccak256(raw);
  const waiting = { status: 503, message: 'Payment is being confirmed' };
  // Broadcast, receipt not found yet: no submit, 503.
  expect(await proofAnswer(request, detail.proof, { hex: raw })).toEqual(waiting);
  await new Promise((resolve) => setTimeout(resolve, 2_500));
  // A repeat reads the receipt again and still submits nothing.
  expect(await proofAnswer(request, detail.proof, { hex: raw })).toEqual(waiting);
  const unmined = await control.state(shop.username);
  expect(unmined.submits.filter((entry) => entry.txHash === hash)).toEqual([]);
  expect(unmined.receiptReads[hash]).toBeGreaterThanOrEqual(2);
  // Mined at 20 s; the receipts duty (30 s after the send) fills it, and the
  // submits duty submits it 10 s after the fill, so the order pays the BOLT11.
  await expect
    .poll(async () => (await paymentStatus(request, opened.payment)).paymentStatus, {
      timeout: 120_000,
      intervals: [2_000],
    })
    .toBe('paid');
  const final = await control.state(shop.username);
  expect(final.submits.filter((entry) => entry.txHash === hash).length).toBeGreaterThanOrEqual(1);
  expect((await control.broadcasts()).filter((entry) => entry.hash === hash)).not.toEqual([]);
  expect(await proofAnswer(request, detail.proof, { hex: raw })).toEqual({
    status: 200,
    message: hash,
  });
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
