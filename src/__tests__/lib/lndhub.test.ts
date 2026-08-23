import { describe, it, expect } from 'vitest';
import type { FetchFn } from '@/lib/btc-usd-rate';
import { LndhubClient, parseLndhubBaseUrl } from '@/lib/lndhub';

const BASE = 'https://lightning.space/lndhub/ext';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('parseLndhubBaseUrl', () => {
  it('accepts https lightning.space and strips trailing slashes', () => {
    const url = parseLndhubBaseUrl('https://lightning.space/lndhub/ext/');
    expect(url).not.toBeNull();
    expect(url?.hostname).toBe('lightning.space');
    expect(url?.pathname).toBe('/lndhub/ext');
  });

  it('rejects other hosts and protocols', () => {
    expect(parseLndhubBaseUrl('http://lightning.space/')).toBeNull();
    expect(parseLndhubBaseUrl('https://evil.example/')).toBeNull();
    expect(parseLndhubBaseUrl('')).toBeNull();
    expect(parseLndhubBaseUrl('not a url')).toBeNull();
  });
});

describe('LndhubClient', () => {
  it('throws on invalid base URL', () => {
    expect(
      () =>
        new LndhubClient({
          baseUrl: 'https://evil.example',
          login: 'a',
          password: 'b',
          fetchImpl: async () => jsonResponse({}),
        }),
    ).toThrow('invalid_lndhub_url');
  });

  it('auths with access_token, reads balance, pays invoice', async () => {
    const calls: string[] = [];
    const fetchImpl: FetchFn = async (input, init) => {
      const url = String(input);
      calls.push(`${init?.method ?? 'GET'} ${url}`);
      if (url.endsWith('/auth')) {
        return jsonResponse({ access_token: 'tok' });
      }
      if (url.endsWith('/getbalance')) {
        expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer tok');
        return jsonResponse({ BTC: { AvailableBalance: 12_345 } });
      }
      if (url.endsWith('/payinvoice')) {
        return jsonResponse({ payment_preimage: 'pre', payment_hash: 'hash' });
      }
      return jsonResponse({}, 404);
    };
    const client = new LndhubClient({
      baseUrl: BASE,
      login: 'u',
      password: 'p',
      fetchImpl,
      clock: () => 1,
    });
    expect(await client.getBalanceSats()).toEqual({ ok: true, sats: 12_345 });
    expect(await client.payInvoice('lnbc10n1')).toEqual({
      status: 'paid',
      preimage: 'pre',
      paymentHash: 'hash',
    });
    expect(calls.some((c) => c.includes('/auth'))).toBe(true);
  });

  it('accepts token field and empty payment_hash on paid', async () => {
    const fetchImpl: FetchFn = async (input) => {
      const url = String(input);
      if (url.endsWith('/auth')) {
        return jsonResponse({ token: 'tok2' });
      }
      return jsonResponse({ payment_preimage: 'pre', payment_error: null });
    };
    const client = new LndhubClient({
      baseUrl: BASE,
      login: 'u',
      password: 'p',
      fetchImpl,
    });
    expect(await client.payInvoice('lnbc10n1')).toEqual({
      status: 'paid',
      preimage: 'pre',
      paymentHash: '',
    });
  });

  it('re-auths once on 401 and retries', async () => {
    let authCount = 0;
    let balanceCalls = 0;
    const fetchImpl: FetchFn = async (input) => {
      const url = String(input);
      if (url.endsWith('/auth')) {
        authCount += 1;
        return jsonResponse({ access_token: `tok${authCount}` });
      }
      balanceCalls += 1;
      if (balanceCalls === 1) {
        return new Response(null, { status: 401 });
      }
      return jsonResponse({ BTC: { AvailableBalance: 1 } });
    };
    const client = new LndhubClient({
      baseUrl: BASE,
      login: 'u',
      password: 'p',
      fetchImpl,
    });
    expect(await client.getBalanceSats()).toEqual({ ok: true, sats: 1 });
    expect(authCount).toBe(2);
  });

  it('returns failed for Invalid invoice', async () => {
    const fetchImpl: FetchFn = async (input) => {
      if (String(input).endsWith('/auth')) {
        return jsonResponse({ access_token: 't' });
      }
      return jsonResponse({ payment_error: 'Invalid invoice' });
    };
    const client = new LndhubClient({
      baseUrl: BASE,
      login: 'u',
      password: 'p',
      fetchImpl,
    });
    expect(await client.payInvoice('x')).toEqual({
      status: 'failed',
      reason: 'Invalid invoice',
    });
  });

  it('returns uncertain for other payment_error with and without hash', async () => {
    const withHash: FetchFn = async (input) => {
      if (String(input).endsWith('/auth')) {
        return jsonResponse({ access_token: 't' });
      }
      return jsonResponse({ payment_error: 'route fail', payment_hash: 'h' });
    };
    expect(
      await new LndhubClient({
        baseUrl: BASE,
        login: 'u',
        password: 'p',
        fetchImpl: withHash,
      }).payInvoice('x'),
    ).toEqual({ status: 'uncertain', reason: 'route fail', paymentHash: 'h' });

    const noHash: FetchFn = async (input) => {
      if (String(input).endsWith('/auth')) {
        return jsonResponse({ access_token: 't' });
      }
      return jsonResponse({ payment_error: 'route fail' });
    };
    expect(
      await new LndhubClient({
        baseUrl: BASE,
        login: 'u',
        password: 'p',
        fetchImpl: noHash,
      }).payInvoice('x'),
    ).toEqual({ status: 'uncertain', reason: 'route fail' });
  });

  it('returns uncertain on network/5xx/missing preimage/auth failure', async () => {
    const authOk: FetchFn = async (input) => {
      if (String(input).endsWith('/auth')) {
        return jsonResponse({ access_token: 't' });
      }
      throw new Error('net');
    };
    expect(
      await new LndhubClient({
        baseUrl: BASE,
        login: 'u',
        password: 'p',
        fetchImpl: authOk,
      }).payInvoice('x'),
    ).toEqual({ status: 'uncertain', reason: 'network' });

    const five: FetchFn = async (input) => {
      if (String(input).endsWith('/auth')) {
        return jsonResponse({ access_token: 't' });
      }
      return new Response('err', { status: 503 });
    };
    expect(
      await new LndhubClient({
        baseUrl: BASE,
        login: 'u',
        password: 'p',
        fetchImpl: five,
      }).payInvoice('x'),
    ).toEqual({ status: 'uncertain', reason: 'http_503' });

    const noPre: FetchFn = async (input) => {
      if (String(input).endsWith('/auth')) {
        return jsonResponse({ access_token: 't' });
      }
      return jsonResponse({ payment_preimage: '' });
    };
    expect(
      await new LndhubClient({
        baseUrl: BASE,
        login: 'u',
        password: 'p',
        fetchImpl: noPre,
      }).payInvoice('x'),
    ).toEqual({ status: 'uncertain', reason: 'missing_preimage' });

    const authFail: FetchFn = async () => new Response(null, { status: 401 });
    expect(
      await new LndhubClient({
        baseUrl: BASE,
        login: 'u',
        password: 'p',
        fetchImpl: authFail,
      }).getBalanceSats(),
    ).toEqual({ ok: false, reason: 'http_401' });
  });

  it('handles balance schema and network failures', async () => {
    const badJson: FetchFn = async (input) => {
      if (String(input).endsWith('/auth')) {
        return jsonResponse({ access_token: 't' });
      }
      return new Response('x', { status: 200 });
    };
    expect(
      await new LndhubClient({
        baseUrl: BASE,
        login: 'u',
        password: 'p',
        fetchImpl: badJson,
      }).getBalanceSats(),
    ).toEqual({ ok: false, reason: 'invalid_json' });

    const badSchema: FetchFn = async (input) => {
      if (String(input).endsWith('/auth')) {
        return jsonResponse({ access_token: 't' });
      }
      return jsonResponse({ BTC: { AvailableBalance: 1.5 } });
    };
    expect(
      await new LndhubClient({
        baseUrl: BASE,
        login: 'u',
        password: 'p',
        fetchImpl: badSchema,
      }).getBalanceSats(),
    ).toEqual({ ok: false, reason: 'invalid_schema' });

    const net: FetchFn = async (input) => {
      if (String(input).endsWith('/auth')) {
        return jsonResponse({ access_token: 't' });
      }
      throw new Error('down');
    };
    expect(
      await new LndhubClient({
        baseUrl: BASE,
        login: 'u',
        password: 'p',
        fetchImpl: net,
      }).getBalanceSats(),
    ).toEqual({ ok: false, reason: 'network' });

    const noBtc: FetchFn = async (input) => {
      if (String(input).endsWith('/auth')) {
        return jsonResponse({ access_token: 't' });
      }
      return jsonResponse({ BTC: null });
    };
    expect(
      await new LndhubClient({
        baseUrl: BASE,
        login: 'u',
        password: 'p',
        fetchImpl: noBtc,
      }).getBalanceSats(),
    ).toEqual({ ok: false, reason: 'invalid_schema' });

    const notObj: FetchFn = async (input) => {
      if (String(input).endsWith('/auth')) {
        return jsonResponse({ access_token: 't' });
      }
      return jsonResponse(null);
    };
    expect(
      await new LndhubClient({
        baseUrl: BASE,
        login: 'u',
        password: 'p',
        fetchImpl: notObj,
      }).getBalanceSats(),
    ).toEqual({ ok: false, reason: 'invalid_schema' });
  });

  it('returns uncertain on 4xx payinvoice and bad pay body', async () => {
    const four: FetchFn = async (input) => {
      if (String(input).endsWith('/auth')) {
        return jsonResponse({ access_token: 't' });
      }
      return new Response(null, { status: 404 });
    };
    expect(
      await new LndhubClient({
        baseUrl: BASE,
        login: 'u',
        password: 'p',
        fetchImpl: four,
      }).payInvoice('x'),
    ).toEqual({ status: 'uncertain', reason: 'http_404' });

    const badBody: FetchFn = async (input) => {
      if (String(input).endsWith('/auth')) {
        return jsonResponse({ access_token: 't' });
      }
      return new Response('nope', { status: 200 });
    };
    expect(
      await new LndhubClient({
        baseUrl: BASE,
        login: 'u',
        password: 'p',
        fetchImpl: badBody,
      }).payInvoice('x'),
    ).toEqual({ status: 'uncertain', reason: 'invalid_json' });

    const nullBody: FetchFn = async (input) => {
      if (String(input).endsWith('/auth')) {
        return jsonResponse({ access_token: 't' });
      }
      return jsonResponse(null);
    };
    expect(
      await new LndhubClient({
        baseUrl: BASE,
        login: 'u',
        password: 'p',
        fetchImpl: nullBody,
      }).payInvoice('x'),
    ).toEqual({ status: 'uncertain', reason: 'invalid_schema' });
  });

  it('caches token across calls', async () => {
    let authCount = 0;
    const fetchImpl: FetchFn = async (input) => {
      if (String(input).endsWith('/auth')) {
        authCount += 1;
        return jsonResponse({ access_token: 't' });
      }
      return jsonResponse({ BTC: { AvailableBalance: 0 } });
    };
    const client = new LndhubClient({
      baseUrl: `${BASE}/`,
      login: 'u',
      password: 'p',
      fetchImpl,
    });
    await client.getBalanceSats();
    await client.getBalanceSats();
    expect(authCount).toBe(1);
  });

  it('returns uncertain when auth succeeds but retry auth fails after 401', async () => {
    let authCount = 0;
    const fetchImpl: FetchFn = async (input) => {
      if (String(input).endsWith('/auth')) {
        authCount += 1;
        if (authCount === 1) {
          return jsonResponse({ access_token: 't' });
        }
        return new Response(null, { status: 500 });
      }
      return new Response(null, { status: 401 });
    };
    expect(
      await new LndhubClient({
        baseUrl: BASE,
        login: 'u',
        password: 'p',
        fetchImpl,
      }).payInvoice('x'),
    ).toEqual({ status: 'uncertain', reason: 'unauthorized' });
  });

  it('treats non-string payment_error as uncertain', async () => {
    const fetchImpl: FetchFn = async (input) => {
      if (String(input).endsWith('/auth')) {
        return jsonResponse({ access_token: 't' });
      }
      return jsonResponse({ payment_error: { code: 1 }, payment_preimage: 'p' });
    };
    expect(
      await new LndhubClient({
        baseUrl: BASE,
        login: 'u',
        password: 'p',
        fetchImpl,
      }).payInvoice('x'),
    ).toEqual({ status: 'uncertain', reason: 'payment_error' });
  });

  it('handles auth JSON failures', async () => {
    const cases: FetchFn[] = [
      async () => {
        throw new Error('auth down');
      },
      async () => new Response('x', { status: 200 }),
      async () => jsonResponse(null),
      async () => jsonResponse({}),
    ];
    for (const fetchImpl of cases) {
      expect(
        await new LndhubClient({
          baseUrl: BASE,
          login: 'u',
          password: 'p',
          fetchImpl,
        }).getBalanceSats(),
      ).toEqual({ ok: false, reason: 'http_401' });
    }
  });
});
