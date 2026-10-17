/**
 * What Tether Wallet 1.11.0 shows when it scans a sticker that is not
 * waiting for a stablecoin payment (`docs/shop-stablecoin-payment.md`,
 * Implementation › Tests): the plain LNURL path with no open amount,
 * `QUOTE_EXPIRED` on an expired quote, `RAIL_UNAVAILABLE` on a pair that is
 * not offered, and the Lightning rail of an open amount.
 */

import { expect, test } from '@playwright/test';
import { PUBLIC_BASE_URL } from './stand-ins/ports';
import {
  Control,
  describeRun,
  openPayerPayment,
  paymentStatus,
  sticker,
  tetherWallet,
  verifiedShop,
  walletHttp,
} from './fixtures';
import { getOpenCryptoPayPayment, parseOpenCryptoPayLink, withQuery } from './tether-client';

test.afterEach(async ({ request }) => {
  expect(await new Control(request).violations()).toEqual([]);
});

test('no open amount: the wallet takes the plain LNURL path and gets an invoice', async ({
  request,
}) => {
  const control = new Control(request);
  const shop = await verifiedShop(request, 'plain');
  const wallet = tetherWallet(request, control);
  const run = await wallet.pay(sticker(shop.username), { railId: 'polygon-usdt' });
  expect(run.outcome).toBe('LNURL_PLAIN');
  const plain = run.plain ?? {};
  expect(plain['callback']).toBe(`${PUBLIC_BASE_URL}/lnurlp/${shop.username}/invoice`);
  expect(plain['standard']).toBeUndefined();
  expect(plain['minSendable']).not.toBe(plain['maxSendable']);
  const paid = await wallet.payPlainLnurl(plain, 1_234);
  expect(paid).toMatchObject({ kind: 'invoice', amountMsat: 1_234_000 });
  // A wallet that polls with `timeout` (an OpenCryptoPay wallet) is told nothing waits.
  const link = parseOpenCryptoPayLink(sticker(shop.username));
  expect(link).not.toBeNull();
  const polled = await getOpenCryptoPayPayment(
    walletHttp(request),
    withQuery(link?.url ?? '', { timeout: '0' }),
  );
  expect(polled.kind).toBe('no-pending-payment');
});

test('an expired quote is QUOTE_EXPIRED', async ({ request }) => {
  const control = new Control(request);
  const shop = await verifiedShop(request, 'expired');
  // Orchestra's expiresAt 78 s ahead: quote.expiration is 48 s ahead (30 s funding margin),
  // which passes the offer check's 45 s.
  await control.behave(shop.username, { quoteTtlMs: 78_000 });
  await openPayerPayment(request, shop.username, 2_000);
  const run = await tetherWallet(request, control).pay(sticker(shop.username), {
    railId: 'ethereum-usdt',
    beforeDetail: async (payment) => {
      const expiration = Date.parse(payment.quoteExpiration ?? '');
      expect(expiration - Date.now()).toBeGreaterThan(40_000);
      expect(expiration - Date.now()).toBeLessThanOrEqual(48_000);
      await new Promise((resolve) => setTimeout(resolve, expiration - Date.now() + 1_000));
    },
  });
  expect(run.outcome, describeRun(run)).toBe('OPEN_CRYPTO_PAY_QUOTE_EXPIRED');
  expect(run.detail).toBe('HTTP 404');
});

test('a pair that is not offered is RAIL_UNAVAILABLE', async ({ request }) => {
  const control = new Control(request);
  const shop = await verifiedShop(request, 'norail');
  await control.behave(shop.username, { refusePairs: ['polygon:USDT'] });
  await openPayerPayment(request, shop.username, 2_000);
  const run = await tetherWallet(request, control).pay(sticker(shop.username), {
    railId: 'polygon-usdt',
  });
  // The screen would not list Polygon; a wallet that asks anyway gets 400.
  expect(run.options?.map((option) => option.rail.id)).not.toContain('polygon-usdt');
  expect(run.options?.map((option) => option.rail.id)).toContain('arbitrum-usdt');
  expect(run.outcome, describeRun(run)).toBe('OPEN_CRYPTO_PAY_RAIL_UNAVAILABLE');
  expect(run.detail).toBe('HTTP 400');
});

test('the Lightning rail of an open amount is its BOLT11, and paying it marks the payment paid', async ({
  request,
}) => {
  const control = new Control(request);
  const shop = await verifiedShop(request, 'ln');
  const opened = await openPayerPayment(request, shop.username, 2_500);
  const run = await tetherWallet(request, control).pay(sticker(shop.username), {
    railId: 'lightning-btc',
  });
  expect(run.outcome).toBe('INVOICE');
  expect(run.rail?.kind).toBe('invoice');
  const invoices = (await control.state(shop.username)).invoices;
  expect(invoices).toHaveLength(1);
  expect(invoices[0]?.amountMsat).toBe(2_500_000);
  await control.settleInvoice(invoices[0]?.paymentHash ?? '');
  await expect
    .poll(async () => (await paymentStatus(request, opened.payment)).paymentStatus, {
      timeout: 30_000,
    })
    .toBe('paid');
});

test('the pay request and a detail of an open amount are the bodies the contract states', async ({
  request,
}) => {
  const control = new Control(request);
  const shop = await verifiedShop(request, 'body');
  const opened = await openPayerPayment(request, shop.username, 1_500);
  const http = walletHttp(request);
  const link = parseOpenCryptoPayLink(sticker(shop.username));
  const answer = await http.get(link?.url ?? '', 20_000);
  expect(answer.status).toBe(200);
  const body = answer.body as Record<string, unknown>;
  const name = ((await (await request.get(`/pay/${shop.username}`)).json()) as { name: string })
    .name;
  expect(Object.keys(body).sort()).toEqual(
    [
      'id',
      'tag',
      'callback',
      'minSendable',
      'maxSendable',
      'metadata',
      'displayName',
      'standard',
      'possibleStandards',
      'displayQr',
      'recipient',
      'quote',
      'requestedAmount',
      'transferAmounts',
    ].sort(),
  );
  expect(body).toMatchObject({
    id: shop.username,
    tag: 'payRequest',
    callback: `${PUBLIC_BASE_URL}/lnurlp/cb/${shop.username}`,
    minSendable: 1_500_000,
    maxSendable: 1_500_000,
    displayName: name,
    standard: 'OpenCryptoPay',
    possibleStandards: ['OpenCryptoPay'],
    displayQr: false,
    recipient: { name },
    requestedAmount: { asset: 'BTC', amount: 0.000015 },
  });
  const quote = body['quote'] as { id: string; expiration: string; payment: string };
  expect(quote.payment).toBe(opened.payment);
  expect(quote.expiration).toBe(new Date(Date.parse(quote.expiration)).toISOString());
  // Lightning first, then the offered methods in table order, USDT before USDC.
  const offered = (await control.state(shop.username)).quotes;
  const units = (method: string, asset: string) => {
    const row = offered.find((q) => q.sourceChain === method.toLowerCase() && q.asset === asset);
    const amountIn = BigInt(row?.amountIn ?? '0');
    const fraction = (amountIn % 1_000_000n).toString().padStart(6, '0').replace(/0+$/, '');
    return `${amountIn / 1_000_000n}${fraction === '' ? '' : `.${fraction}`}`;
  };
  const stable = (method: string) => ({
    method,
    minFee: 1_200_000_000,
    assets: [
      { asset: 'USDT', amount: units(method, 'USDT') },
      { asset: 'USDC', amount: units(method, 'USDC') },
    ],
    available: true,
  });
  expect(body['transferAmounts']).toEqual([
    {
      method: 'Lightning',
      minFee: 0,
      assets: [{ asset: 'BTC', amount: '0.000015' }],
      available: true,
    },
    stable('Ethereum'),
    stable('Arbitrum'),
    stable('Polygon'),
  ]);
  // The Arbitrum USDT detail: the four EVM fields, URI in lowercase, hint ends with the proof URL.
  const offer = offered.find((q) => q.sourceChain === 'arbitrum' && q.asset === 'USDT');
  const detail = await http.get(
    withQuery(String(body['callback']), { quote: quote.id, method: 'Arbitrum', asset: 'USDT' }),
    20_000,
  );
  expect(detail.status).toBe(200);
  expect(detail.body).toEqual({
    expiryDate: quote.expiration,
    blockchain: 'Arbitrum',
    uri: `ethereum:${offer?.token}@42161/transfer?address=${offer?.depositAddress}&uint256=${offer?.amountIn}`,
    hint: `Pay this URI. Then send the transaction hash as tx, or the signed raw transaction as hex, with quote and method, to ${PUBLIC_BASE_URL}/lnurlp/tx/${shop.username}`,
  });
});
