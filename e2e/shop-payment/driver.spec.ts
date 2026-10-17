/**
 * The rules of the Tether Wallet 1.11.0 port that the end-to-end scenarios
 * cannot vary through the api (`docs/shop-stablecoin-payment.md`, "Tether
 * Wallet 1.11.0"): the hint and `cb` rewrite, the bundle and user-operation
 * hash, the status-code rules, the retries, and the settlement poll, run
 * against scripted answers with an instant clock.
 */

import { expect, test } from '@playwright/test';
import {
  OPEN_CRYPTO_PAY_RAILS,
  acceptsRail,
  earliestExpiry,
  encodeLnurl,
  isOpenCryptoPayPayment,
  parseOpenCryptoPayLink,
  parseTransferUri,
  proofHash,
  resolveSubmitUrl,
  submitWithRetries,
  waitForSettlement,
  withQuery,
  type AttemptLog,
  type PendingProof,
  type WalletClock,
  type WalletHttp,
  type WalletResponse,
} from './tether-client';

function rail(id: string) {
  const found = OPEN_CRYPTO_PAY_RAILS.find((candidate) => candidate.id === id);
  if (found === undefined) {
    throw new Error(id);
  }
  return found;
}

/** Clock that advances on sleep. */
function instantClock(): WalletClock & { slept: number[] } {
  let now = 1_000_000;
  const slept: number[] = [];
  return {
    slept,
    now: () => now,
    sleep: async (ms) => {
      slept.push(ms);
      now += ms;
    },
  };
}

/** HTTP that answers from a script; `'throw'` is a transport failure. */
function scripted(answers: Array<WalletResponse | 'throw'>, urls: string[] = []): WalletHttp {
  return {
    async get(url) {
      urls.push(url);
      const next = answers.shift();
      if (next === undefined || next === 'throw') {
        throw new Error('no answer');
      }
      return next;
    },
  };
}

const PROOF: PendingProof = {
  submitUrl: 'https://shop.example/lnurlp/tx/bob',
  paymentUrl: 'https://shop.example/.well-known/lnurlp/bob',
  quoteId: 'q1',
  saleId: 'p1',
  method: 'Polygon',
  asset: 'USDT',
};

test('scan: only an http(s) URL with a lightning query (any case) holding an LNURL', () => {
  const lnurl = encodeLnurl('https://shop.example/.well-known/lnurlp/bob');
  expect(parseOpenCryptoPayLink(`https://shop.example/pl/?LightNing=${lnurl}`)?.url).toBe(
    'https://shop.example/.well-known/lnurlp/bob',
  );
  expect(parseOpenCryptoPayLink(lnurl)).toBeNull();
  expect(parseOpenCryptoPayLink(`lightning:${lnurl}`)).toBeNull();
  expect(parseOpenCryptoPayLink('https://shop.example/pl/?lightning=notanlnurl')).toBeNull();
});

test('OpenCryptoPay detection and exact rail match', () => {
  expect(isOpenCryptoPayPayment({ standard: 'OpenCryptoPay' })).toBe(true);
  expect(isOpenCryptoPayPayment({ possibleStandards: ['lud16', 'OpenCryptoPay'] })).toBe(true);
  expect(isOpenCryptoPayPayment({ standard: 'opencryptopay' })).toBe(false);
  const entry = { method: 'Polygon', available: true, assets: [{ asset: 'USDT', amount: '1' }] };
  expect(acceptsRail(entry, rail('polygon-usdt'))).toBe(true);
  expect(acceptsRail({ ...entry, method: 'polygon' }, rail('polygon-usdt'))).toBe(false);
  expect(acceptsRail({ ...entry, available: false }, rail('polygon-usdt'))).toBe(false);
  expect(acceptsRail({ ...entry, assets: [{ asset: 'USDC' }] }, rail('polygon-usdt'))).toBe(false);
  expect(rail('tron-usdt').withheld).toBe(true);
});

test('detail query: callback then ? or & then quote, method, asset', () => {
  expect(withQuery('https://a/cb/bob', { quote: 'q 1', method: 'Polygon', asset: 'USDT' })).toBe(
    'https://a/cb/bob?quote=q%201&method=Polygon&asset=USDT',
  );
  expect(withQuery('https://a/cb/bob?x=1', { timeout: '0' })).toBe(
    'https://a/cb/bob?x=1&timeout=0',
  );
});

test('EIP-681: chain must be the rail chain and the token the wallet USDT contract', () => {
  const token = '0xc2132d05d31c914a87c6611c10748aeb04b58e8f';
  const to = '0x1111111111111111111111111111111111111111';
  const uri = `ethereum:${token}@137/transfer?address=${to}&uint256=1500`;
  expect(parseTransferUri(uri, rail('polygon-usdt'))).toEqual({
    recipient: to,
    amountSmallest: 1500n,
    chainId: 137,
    token,
  });
  expect(parseTransferUri(uri, rail('arbitrum-usdt'))).toBeNull();
  expect(
    parseTransferUri(
      uri.replace(token, '0x3c499c542cef5e3811e1192ce70d8cc03d5c3359'),
      rail('polygon-usdt'),
    ),
  ).toBeNull();
  expect(
    parseTransferUri(`ethereum:${token}@137/transfer?address=${to}`, rail('polygon-usdt')),
  ).toBeNull();
});

test('deadline is the earlier of quote.expiration and expiryDate; unreadable dates are skipped', () => {
  expect(earliestExpiry('2026-10-17T10:00:00.000Z', '2026-10-17T09:59:00.000Z')).toBe(
    '2026-10-17T09:59:00.000Z',
  );
  expect(earliestExpiry('not a date', '2026-10-17T10:00:00.000Z')).toBe('2026-10-17T10:00:00.000Z');
  expect(earliestExpiry(null, undefined)).toBeNull();
});

test('proof URL: hint on the same host with a tx segment, punctuation cut; else cb→tx', () => {
  const callback = 'https://shop.example/lnurlp/cb/bob';
  expect(resolveSubmitUrl('Send it to https://shop.example/lnurlp/tx/bob.', callback)).toBe(
    'https://shop.example/lnurlp/tx/bob',
  );
  expect(resolveSubmitUrl('to https://evil.example/lnurlp/tx/bob', callback)).toBe(
    'https://shop.example/lnurlp/tx/bob',
  );
  expect(resolveSubmitUrl(null, 'https://shop.example/cb/x/cb?k=1')).toBe(
    'https://shop.example/tx/x/tx?k=1',
  );
  expect(resolveSubmitUrl('no url here', 'https://shop.example/lnurlp/other/bob')).toBeNull();
});

test('bundle hash first; the user-operation hash only without hash or transactionHash', () => {
  expect(proofHash({ userOpHash: '0xu', receipt: { transactionHash: '0xt' } })).toBe('0xt');
  expect(proofHash({ userOpHash: '0xu', receipt: { hash: '0xh', transactionHash: '0xt' } })).toBe(
    '0xh',
  );
  expect(proofHash({ userOpHash: '0xu', receipt: {} })).toBe('0xu');
});

test('proof: 3 attempts, pauses 1 s and 3 s, retry only on 5xx or no answer', async () => {
  const clock = instantClock();
  const log: AttemptLog[] = [];
  const urls: string[] = [];
  const http = scripted(
    ['throw', { status: 503, body: {} }, { status: 200, body: { txId: '0xabc' } }],
    urls,
  );
  expect(await submitWithRetries(http, clock, PROOF, '0xabc', log)).toEqual({
    kind: 'accepted',
    status: 200,
    txId: '0xabc',
  });
  expect(clock.slept).toEqual([1_000, 3_000]);
  expect(urls[0]).toBe(
    'https://shop.example/lnurlp/tx/bob?quote=q1&method=Polygon&asset=USDT&tx=0xabc',
  );

  const final = instantClock();
  expect(
    await submitWithRetries(
      scripted([{ status: 429, body: { message: 'slow' } }]),
      final,
      PROOF,
      '0x1',
      [],
    ),
  ).toEqual({ kind: 'rejected', status: 429, message: 'slow' });
  expect(final.slept).toEqual([]);

  expect(
    await submitWithRetries(
      scripted([{ status: 200, body: { txId: '' } }]),
      instantClock(),
      PROOF,
      '0x1',
      [],
    ),
  ).toMatchObject({ kind: 'rejected' });

  const gaveUp = instantClock();
  expect(
    await submitWithRetries(scripted(['throw', 'throw', 'throw']), gaveUp, PROOF, '0x1', []),
  ).toBeNull();
  expect(gaveUp.slept).toEqual([1_000, 3_000]);
});

test('settlement: timeout=0 every 3 s for 30 s; settled on OCP 404 or another quote.payment', async () => {
  const pending = { status: 200, body: { standard: 'OpenCryptoPay', quote: { payment: 'p1' } } };
  const urls: string[] = [];
  const clock = instantClock();
  const http = scripted(
    [pending, pending, { status: 404, body: { standard: 'OpenCryptoPay' } }],
    urls,
  );
  expect(await waitForSettlement(http, clock, PROOF, [])).toBe('settled');
  expect(urls[0]).toBe('https://shop.example/.well-known/lnurlp/bob?timeout=0');
  expect(clock.slept).toEqual([3_000, 3_000]);

  const moved = scripted([
    { status: 200, body: { standard: 'OpenCryptoPay', quote: { payment: 'p2' } } },
  ]);
  expect(await waitForSettlement(moved, instantClock(), PROOF, [])).toBe('settled');

  // A plain 404 is not "nothing pending"; it stays unconfirmed after 30 s.
  const plain = scripted(
    Array.from({ length: 20 }, () => ({ status: 404, body: { error: 'Not found' } })),
  );
  const waited = instantClock();
  expect(await waitForSettlement(plain, waited, PROOF, [])).toBe('unconfirmed');
  expect(waited.slept.reduce((sum, ms) => sum + ms, 0)).toBeLessThan(30_000);
});
