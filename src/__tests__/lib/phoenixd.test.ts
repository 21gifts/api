import { describe, it, expect } from 'vitest';
import type { FetchFn } from '@/lib/btc-usd-rate';
import { parsePhoenixdBaseUrl, PhoenixdClient } from '@/lib/phoenixd';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

const BASE = 'http://127.0.0.1:9740';
const PASSWORD = 'pw';
const HASH = 'ab'.repeat(32);
const PREIMAGE = 'cd'.repeat(32);

function client(fetchImpl: FetchFn): PhoenixdClient {
  return new PhoenixdClient({ baseUrl: BASE, password: PASSWORD, fetchImpl });
}

describe('parsePhoenixdBaseUrl', () => {
  it('normalizes http(s) URLs and strips trailing slashes', () => {
    expect(parsePhoenixdBaseUrl('http://127.0.0.1:9740')).toEqual({
      ok: true,
      baseUrl: 'http://127.0.0.1:9740',
    });
    expect(parsePhoenixdBaseUrl(' https://phoenix.example/prefix/ ')).toEqual({
      ok: true,
      baseUrl: 'https://phoenix.example/prefix',
    });
    expect(parsePhoenixdBaseUrl('http://127.0.0.1:9740/')).toEqual({
      ok: true,
      baseUrl: 'http://127.0.0.1:9740',
    });
  });

  it('rejects empty, non-http, userinfo, query, and hash', () => {
    expect(parsePhoenixdBaseUrl('')).toEqual({ ok: false, reason: 'invalid_url' });
    expect(parsePhoenixdBaseUrl('   ')).toEqual({ ok: false, reason: 'invalid_url' });
    expect(parsePhoenixdBaseUrl('not a url')).toEqual({ ok: false, reason: 'invalid_url' });
    expect(parsePhoenixdBaseUrl('ftp://127.0.0.1:9740')).toEqual({
      ok: false,
      reason: 'invalid_url',
    });
    expect(parsePhoenixdBaseUrl('http://user:pass@127.0.0.1:9740')).toEqual({
      ok: false,
      reason: 'invalid_url',
    });
    expect(parsePhoenixdBaseUrl('http://127.0.0.1:9740?x=1')).toEqual({
      ok: false,
      reason: 'invalid_url',
    });
    expect(parsePhoenixdBaseUrl('http://127.0.0.1:9740#frag')).toEqual({
      ok: false,
      reason: 'invalid_url',
    });
    expect(parsePhoenixdBaseUrl('http:///')).toEqual({ ok: false, reason: 'invalid_url' });
  });
});

describe('PhoenixdClient', () => {
  it('reads balanceSat and pays with Basic auth + form body', async () => {
    const calls: Array<{ url: string; method: string; headers: Headers; body: string | null }> = [];
    const fetchImpl: FetchFn = async (input, init) => {
      const url = String(input);
      calls.push({
        url,
        method: init?.method ?? 'GET',
        headers: new Headers(init?.headers),
        body: typeof init?.body === 'string' ? init.body : null,
      });
      if (url.endsWith('/getbalance')) {
        return jsonResponse({ balanceSat: 12_345.9, feeCreditSat: 3 });
      }
      return jsonResponse({
        paymentHash: HASH,
        paymentPreimage: PREIMAGE,
        recipientAmountSat: 1,
        routingFeeSat: 1,
      });
    };
    const phoenixd = client(fetchImpl);
    expect(await phoenixd.getBalanceSats()).toEqual({ ok: true, sats: 12_345 });
    expect(await phoenixd.payInvoice('lnbc10n1+x')).toEqual({
      status: 'paid',
      paymentHash: HASH,
      preimage: PREIMAGE,
    });
    expect(calls[0]?.url).toBe(`${BASE}/getbalance`);
    expect(calls[0]?.headers.get('Authorization')).toBe(
      `Basic ${Buffer.from(':pw', 'utf8').toString('base64')}`,
    );
    expect(calls[1]?.url).toBe(`${BASE}/payinvoice`);
    expect(calls[1]?.method).toBe('POST');
    expect(calls[1]?.headers.get('Content-Type')).toBe('application/x-www-form-urlencoded');
    expect(calls[1]?.body).toBe(`invoice=${encodeURIComponent('lnbc10n1+x')}`);
  });

  it('treats 4xx as failed and 408/429/5xx/network as uncertain', async () => {
    expect(
      await client(async () => jsonResponse({ reason: 'bad invoice' }, 400)).payInvoice('x'),
    ).toEqual({ status: 'failed', reason: 'bad invoice' });
    expect(await client(async () => jsonResponse({ error: 'nope' }, 400)).payInvoice('x')).toEqual({
      status: 'failed',
      reason: 'nope',
    });
    expect(
      await client(async () => jsonResponse({ message: 'Invalid invoice' }, 400)).payInvoice('x'),
    ).toEqual({ status: 'failed', reason: 'Invalid invoice' });
    expect(await client(async () => jsonResponse({}, 400)).payInvoice('x')).toEqual({
      status: 'failed',
      reason: 'http_400',
    });
    expect(await client(async () => jsonResponse({ message: '' }, 400)).payInvoice('x')).toEqual({
      status: 'failed',
      reason: 'http_400',
    });
    expect(await client(async () => new Response('x', { status: 400 })).payInvoice('x')).toEqual({
      status: 'failed',
      reason: 'http_400',
    });
    expect(await client(async () => new Response(null, { status: 401 })).payInvoice('x')).toEqual({
      status: 'failed',
      reason: 'http_401',
    });
    expect(await client(async () => new Response('err', { status: 408 })).payInvoice('x')).toEqual({
      status: 'uncertain',
      reason: 'http_408',
    });
    expect(await client(async () => new Response('err', { status: 429 })).payInvoice('x')).toEqual({
      status: 'uncertain',
      reason: 'http_429',
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
  });

  it('maps incomplete 2xx pay bodies to uncertain', async () => {
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
    expect(await client(async () => jsonResponse({ paymentHash: HASH })).payInvoice('x')).toEqual({
      status: 'uncertain',
      reason: 'invalid_schema',
    });
    expect(
      await client(async () =>
        jsonResponse({ paymentHash: 'short', paymentPreimage: PREIMAGE }),
      ).payInvoice('x'),
    ).toEqual({ status: 'uncertain', reason: 'invalid_schema' });
    expect(
      await client(async () =>
        jsonResponse({ paymentHash: HASH, paymentPreimage: 'not-hex' }),
      ).payInvoice('x'),
    ).toEqual({ status: 'uncertain', reason: 'invalid_schema' });
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
    expect(await client(async () => jsonResponse({ balanceSat: -1 })).getBalanceSats()).toEqual({
      ok: false,
      reason: 'invalid_schema',
    });
    expect(await client(async () => jsonResponse({})).getBalanceSats()).toEqual({
      ok: false,
      reason: 'invalid_schema',
    });
  });
});
