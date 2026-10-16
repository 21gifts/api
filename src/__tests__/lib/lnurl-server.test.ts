import { describe, it, expect, vi, afterEach } from 'vitest';
import type { LnurlServerConfig } from '@/lib/config';
import type { FetchFn } from '@/lib/lnurlp';
import {
  LNURL_BODY_LIMIT_BYTES,
  LNURL_PAY_REQUEST_TIMEOUT_MS,
  LNURL_SERVER_TIMEOUT_MS,
  callLnurlServer,
  walletPayRequest,
} from '@/lib/lnurl-server';

const CONFIG: LnurlServerConfig = {
  baseUrl: 'http://lnurl.test',
  publicBaseUrl: 'https://example.test',
  host: 'example.test',
};

const PUBKEY = `02${'a'.repeat(64)}`;
const PAYMENT_HASH = 'b'.repeat(64);

describe('LNURL server constants', () => {
  it('exports the documented timeouts and body limit', () => {
    expect(LNURL_PAY_REQUEST_TIMEOUT_MS).toBe(5_000);
    expect(LNURL_SERVER_TIMEOUT_MS).toBe(15_000);
    expect(LNURL_BODY_LIMIT_BYTES).toBe(1024 * 1024);
  });
});

describe('callLnurlServer', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('builds the URL with allow-listed segments verbatim and appends the raw search', async () => {
    let seenUrl = '';
    const fetchImpl: FetchFn = async (input) => {
      seenUrl = String(input);
      return new Response(new TextEncoder().encode('ok'), { status: 200 });
    };
    const cases: Array<{ segments: readonly string[]; expectedPath: string }> = [
      { segments: ['.well-known', 'lnurlp', 'ada'], expectedPath: '/.well-known/lnurlp/ada' },
      { segments: ['lnurlpay', PUBKEY], expectedPath: `/lnurlpay/${PUBKEY}` },
      { segments: ['lnurlp', 'a.b_c-d', 'invoice'], expectedPath: '/lnurlp/a.b_c-d/invoice' },
      { segments: ['verify', PAYMENT_HASH], expectedPath: `/verify/${PAYMENT_HASH}` },
      { segments: ['x~y'], expectedPath: '/x~y' },
    ];
    for (const { segments, expectedPath } of cases) {
      const result = await callLnurlServer(CONFIG, fetchImpl, {
        method: 'GET',
        segments,
        search: '?amount=1000&comment=hi%20there',
        timeoutMs: 1_000,
      });
      expect(result).toEqual({ ok: true, status: 200, body: 'ok', headers: {} });
      expect(seenUrl).toBe(`http://lnurl.test${expectedPath}?amount=1000&comment=hi%20there`);
    }
  });

  it('always sends Host from config and only the allow-listed request headers', async () => {
    let seenInit: RequestInit | undefined;
    const fetchImpl: FetchFn = async (_input, init) => {
      seenInit = init;
      return new Response('{}', {
        status: 200,
        headers: {
          'content-type': 'application/json',
          'cache-control': 'no-store',
          'set-cookie': 'secret=1',
          location: 'https://evil.test',
        },
      });
    };
    const inbound = new Headers({
      host: 'client.example',
      authorization: 'Bearer tok',
      cookie: 'sid=1',
      'x-forwarded-for': '1.2.3.4',
      'content-type': 'application/json',
      'x-breez-signature': 'sig',
      'x-breez-timestamp': '123',
    });
    const result = await callLnurlServer(CONFIG, fetchImpl, {
      method: 'POST',
      segments: ['lnurlpay', PUBKEY],
      headers: inbound,
      body: '{"username":"ada"}',
      timeoutMs: 2_000,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.headers).toEqual({
      'content-type': 'application/json',
      'cache-control': 'no-store',
    });
    expect(seenInit?.method).toBe('POST');
    expect(seenInit?.redirect).toBe('error');
    expect(seenInit?.body).toBe('{"username":"ada"}');
    expect(seenInit?.headers).toEqual({
      host: 'example.test',
      'content-type': 'application/json',
      'x-breez-signature': 'sig',
      'x-breez-timestamp': '123',
    });
  });

  it('omits absent response headers and does not forward a body when omitted', async () => {
    let seenInit: RequestInit | undefined;
    const fetchImpl: FetchFn = async (_input, init) => {
      seenInit = init;
      return new Response(new TextEncoder().encode('plain'), { status: 200 });
    };
    const result = await callLnurlServer(CONFIG, fetchImpl, {
      method: 'GET',
      segments: ['verify', 'ab'],
      timeoutMs: 500,
    });
    expect(result).toEqual({ ok: true, status: 200, body: 'plain', headers: {} });
    expect(seenInit).not.toHaveProperty('body');
  });

  it('passes AbortSignal.timeout with the given timeoutMs', async () => {
    const timeoutSpy = vi.spyOn(AbortSignal, 'timeout');
    const fetchImpl: FetchFn = async (_input, init) => {
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      return new Response('ok', { status: 200 });
    };
    await callLnurlServer(CONFIG, fetchImpl, {
      method: 'GET',
      segments: ['verify', 'hash'],
      timeoutMs: 4_321,
    });
    expect(timeoutSpy).toHaveBeenCalledWith(4_321);
  });

  it('refuses empty, ".", "..", and disallowed characters without calling fetch', async () => {
    const fetchImpl: FetchFn = async () => {
      throw new Error('fetch must not be called');
    };
    const refused: readonly (readonly string[])[] = [
      [''],
      ['.'],
      ['..'],
      ['lnurlp', '..'],
      ['', 'x'],
      ['a/b'],
      ['a\\b'],
      ['a%2Fb'],
      ['a b'],
      ['a\nb'],
    ];
    for (const segments of refused) {
      const result = await callLnurlServer(CONFIG, fetchImpl, {
        method: 'GET',
        segments,
        timeoutMs: 100,
      });
      expect(result).toEqual({ ok: false, reason: 'segment' });
    }
  });

  it('returns unreachable when fetch throws', async () => {
    const result = await callLnurlServer(
      CONFIG,
      async () => {
        throw new Error('offline');
      },
      { method: 'GET', segments: ['verify', 'x'], timeoutMs: 100 },
    );
    expect(result).toEqual({ ok: false, reason: 'unreachable' });
  });

  it('returns unreachable when response.text() throws', async () => {
    const fetchImpl: FetchFn = async () =>
      ({
        status: 200,
        headers: new Headers(),
        text: async () => {
          throw new Error('body');
        },
      }) as unknown as Response;
    const result = await callLnurlServer(CONFIG, fetchImpl, {
      method: 'GET',
      segments: ['verify', 'x'],
      timeoutMs: 100,
    });
    expect(result).toEqual({ ok: false, reason: 'unreachable' });
  });

  it('defaults search to an empty string', async () => {
    let seenUrl = '';
    const fetchImpl: FetchFn = async (input) => {
      seenUrl = String(input);
      return new Response('ok', { status: 200 });
    };
    await callLnurlServer(CONFIG, fetchImpl, {
      method: 'GET',
      segments: ['verify', 'abc'],
      timeoutMs: 100,
    });
    expect(seenUrl).toBe('http://lnurl.test/verify/abc');
  });
});

describe('walletPayRequest', () => {
  const callback = 'https://example.test/lnurlp/ada/invoice';
  const valid = {
    tag: 'payRequest',
    callback,
    metadata: '[["text/plain","ada"]]',
    minSendable: 1000,
    maxSendable: 4_000_000_000,
  };

  it('returns the same object when every field is valid', () => {
    expect(walletPayRequest(valid, callback)).toBe(valid);
  });

  it('rejects non-objects, arrays, and null', () => {
    expect(walletPayRequest(null, callback)).toBeNull();
    expect(walletPayRequest('x', callback)).toBeNull();
    expect(walletPayRequest([valid], callback)).toBeNull();
  });

  it('rejects a wrong tag', () => {
    expect(walletPayRequest({ ...valid, tag: 'withdrawRequest' }, callback)).toBeNull();
  });

  it('rejects a wrong callback', () => {
    expect(walletPayRequest(valid, 'https://other.test/lnurlp/ada/invoice')).toBeNull();
  });

  it('rejects non-string metadata', () => {
    expect(walletPayRequest({ ...valid, metadata: ['x'] }, callback)).toBeNull();
  });

  it('rejects non-integer, zero, or negative minSendable', () => {
    expect(walletPayRequest({ ...valid, minSendable: 1.5 }, callback)).toBeNull();
    expect(walletPayRequest({ ...valid, minSendable: 0 }, callback)).toBeNull();
    expect(walletPayRequest({ ...valid, minSendable: -1 }, callback)).toBeNull();
    expect(walletPayRequest({ ...valid, minSendable: '1000' }, callback)).toBeNull();
  });

  it('rejects maxSendable below minSendable or a non-integer max', () => {
    expect(walletPayRequest({ ...valid, maxSendable: 500 }, callback)).toBeNull();
    expect(walletPayRequest({ ...valid, maxSendable: 1000.5 }, callback)).toBeNull();
    expect(walletPayRequest({ ...valid, maxSendable: '4000' }, callback)).toBeNull();
  });
});
