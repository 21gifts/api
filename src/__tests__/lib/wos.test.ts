import { describe, it, expect } from 'vitest';
import type { FetchFn } from '@/lib/btc-usd-rate';
import { WosClient, WOS_BASE_URL, signWosRequest } from '@/lib/wos';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

const TOKEN = 'tok';
const SECRET = 'sec';
const NONCE = 'dGVzdA==';

function client(fetchImpl: FetchFn): WosClient {
  return new WosClient({
    apiToken: TOKEN,
    apiSecret: SECRET,
    fetchImpl,
    nonce: () => NONCE,
  });
}

describe('signWosRequest', () => {
  it('is hmac-sha256 of endpoint+nonce+token+body', () => {
    expect(signWosRequest(SECRET, '/api/v1/wallet/payment', NONCE, TOKEN, '{}')).toHaveLength(64);
  });
});

describe('WosClient', () => {
  it('reads balance in sats and signs payments', async () => {
    const calls: Array<{ url: string; headers: Headers; body: string | null }> = [];
    const fetchImpl: FetchFn = async (input, init) => {
      const url = String(input);
      calls.push({
        url,
        headers: new Headers(init?.headers),
        body: typeof init?.body === 'string' ? init.body : null,
      });
      if (url.endsWith('/wallet/balance')) {
        return jsonResponse({ btc: 0.00012345 });
      }
      return jsonResponse({ status: 'PAID', transactionId: 'hash' });
    };
    const wos = client(fetchImpl);
    expect(await wos.getBalanceSats()).toEqual({ ok: true, sats: 12_345 });
    expect(await wos.payInvoice('lnbc10n1')).toEqual({
      status: 'paid',
      paymentHash: 'hash',
    });
    const pay = calls[1];
    expect(pay?.url).toBe(`${WOS_BASE_URL}/api/v1/wallet/payment`);
    expect(pay?.headers.get('Api-Token')).toBe(TOKEN);
    expect(pay?.headers.get('Nonce')).toBe(NONCE);
    expect(pay?.headers.get('Signature')).toBe(
      signWosRequest(SECRET, '/api/v1/wallet/payment', NONCE, TOKEN, pay?.body ?? ''),
    );
    expect(pay?.body).toContain('LIGHTNING');
  });

  it('treats HTTP 400 as failed and 5xx/network as uncertain', async () => {
    expect(
      await client(async () => jsonResponse({ message: 'bad invoice' }, 400)).payInvoice('x'),
    ).toEqual({ status: 'failed', reason: 'bad invoice' });
    expect(await client(async () => jsonResponse({}, 400)).payInvoice('x')).toEqual({
      status: 'failed',
      reason: 'http_400',
    });
    expect(await client(async () => new Response('x', { status: 400 })).payInvoice('x')).toEqual({
      status: 'failed',
      reason: 'http_400',
    });
    expect(await client(async () => new Response('err', { status: 503 })).payInvoice('x')).toEqual({
      status: 'uncertain',
      reason: 'http_503',
    });
    expect(
      await client(async () => {
        throw new Error('net');
      }).payInvoice('x'),
    ).toEqual({ status: 'uncertain', reason: 'network' });
    expect(await client(async () => new Response(null, { status: 401 })).payInvoice('x')).toEqual({
      status: 'uncertain',
      reason: 'http_401',
    });
  });

  it('maps PAID without hash, PENDING, and unknown status', async () => {
    expect(await client(async () => jsonResponse({ status: 'PAID' })).payInvoice('x')).toEqual({
      status: 'paid',
      paymentHash: '',
    });
    expect(
      await client(async () => jsonResponse({ status: 'PENDING', transactionId: 'h' })).payInvoice(
        'x',
      ),
    ).toEqual({ status: 'uncertain', reason: 'pending', paymentHash: 'h' });
    expect(await client(async () => jsonResponse({ status: 'PENDING' })).payInvoice('x')).toEqual({
      status: 'uncertain',
      reason: 'pending',
    });
    expect(await client(async () => jsonResponse({ status: 'NOPE' })).payInvoice('x')).toEqual({
      status: 'uncertain',
      reason: 'unknown_status',
    });
    expect(await client(async () => jsonResponse(null)).payInvoice('x')).toEqual({
      status: 'uncertain',
      reason: 'invalid_schema',
    });
    expect(await client(async () => new Response('nope', { status: 200 })).payInvoice('x')).toEqual(
      {
        status: 'uncertain',
        reason: 'invalid_json',
      },
    );
  });

  it('handles balance errors', async () => {
    expect(
      await client(async () => {
        throw new Error('down');
      }).getBalanceSats(),
    ).toEqual({ ok: false, reason: 'network' });
    expect(await client(async () => jsonResponse({}, 500)).getBalanceSats()).toEqual({
      ok: false,
      reason: 'http_500',
    });
    expect(await client(async () => new Response('x', { status: 200 })).getBalanceSats()).toEqual({
      ok: false,
      reason: 'invalid_json',
    });
    expect(await client(async () => jsonResponse(null)).getBalanceSats()).toEqual({
      ok: false,
      reason: 'invalid_schema',
    });
    expect(await client(async () => jsonResponse({ btc: -1 })).getBalanceSats()).toEqual({
      ok: false,
      reason: 'invalid_schema',
    });
  });

  it('uses a random nonce when none is injected', async () => {
    const fetchImpl: FetchFn = async () => jsonResponse({ btc: 0 });
    const wos = new WosClient({ apiToken: TOKEN, apiSecret: SECRET, fetchImpl });
    expect(await wos.getBalanceSats()).toEqual({ ok: true, sats: 0 });
  });
});
