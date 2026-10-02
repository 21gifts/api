import { createHash } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { InspectedBolt11 } from '@/lib/bolt11';
import {
  AMOUNT_ERROR,
  COMMENT_ERROR,
  LNURL_RELAY_BODY_CAP_BYTES,
  LNURL_RELAY_CAP,
  LNURL_RELAY_TIMEOUT_MS,
  LNURL_RELAY_WINDOW_MS,
  LnurlRelayRateLimiter,
  NOT_FOUND_ERROR,
  NOT_PAYABLE_ERROR,
  UNREACHABLE_ERROR,
  requestRelayInvoice,
  resolveRelayPayRequest,
} from '@/lib/lnurl-relay';
import type { FetchFn } from '@/lib/lnurlp';

const inspectMock = vi.hoisted(() => vi.fn<(pr: string) => InspectedBolt11 | null>());
vi.mock('@/lib/bolt11', () => ({ inspectBolt11: inspectMock }));
const dnsLookupMock = vi.hoisted(() => vi.fn());
vi.mock('node:dns/promises', () => ({ lookup: dnsLookupMock }));

const METADATA = JSON.stringify([
  ['text/identifier', 'bob@example.com'],
  ['text/plain', 'Pay bob'],
]);
const METADATA_HASH = createHash('sha256').update(METADATA, 'utf8').digest('hex');
const CALLBACK = 'https://pay.example.com/cb?k=1';
const PR = 'lnbc10u1prelay';

const PAY_REQUEST = {
  tag: 'payRequest',
  callback: CALLBACK,
  metadata: METADATA,
  minSendable: 1000,
  maxSendable: 100_000_000,
  commentAllowed: 10,
};

function json(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), { status: 200, ...init });
}

type Call = { url: string; init: RequestInit | undefined };

/** Fake fetch answering by URL prefix; records each call. */
function fakeFetch(routes: Record<string, () => Response | Promise<Response>>): {
  fetchImpl: FetchFn;
  calls: Call[];
} {
  const calls: Call[] = [];
  const fetchImpl: FetchFn = async (input, init) => {
    const url = String(input);
    calls.push({ url, init });
    for (const [prefix, respond] of Object.entries(routes)) {
      if (url.startsWith(prefix)) {
        return respond();
      }
    }
    throw new Error(`unexpected ${url}`);
  };
  return { fetchImpl, calls };
}

const WELL_KNOWN = 'https://example.com/.well-known/lnurlp/bob';

function payRequestFetch(body: unknown = PAY_REQUEST): {
  fetchImpl: FetchFn;
  calls: Call[];
} {
  return fakeFetch({
    [WELL_KNOWN]: () => json(body),
    'https://pay.example.com/cb': () => json({ pr: PR, routes: [] }),
  });
}

const BECH32 = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';

/** Test-side bech32 encoder (hrp + bytes). */
function bech32(hrp: string, bytes: Uint8Array): string {
  const words: number[] = [];
  let acc = 0;
  let bits = 0;
  for (const byte of bytes) {
    acc = (acc << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      words.push((acc >> bits) & 31);
    }
  }
  if (bits > 0) {
    words.push((acc << (5 - bits)) & 31);
  }
  const gen = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
  const polymod = (values: number[]): number => {
    let chk = 1;
    for (const v of values) {
      const top = chk >> 25;
      chk = ((chk & 0x1ffffff) << 5) ^ v;
      gen.forEach((g, i) => {
        if ((top >> i) & 1) chk ^= g;
      });
    }
    return chk;
  };
  const expanded = [
    ...[...hrp].map((c) => c.charCodeAt(0) >> 5),
    0,
    ...[...hrp].map((c) => c.charCodeAt(0) & 31),
  ];
  const mod = polymod([...expanded, ...words, 0, 0, 0, 0, 0, 0]) ^ 1;
  const checksum = [0, 1, 2, 3, 4, 5].map((i) => (mod >> (5 * (5 - i))) & 31);
  return `${hrp}1${[...words, ...checksum].map((w) => BECH32[w]).join('')}`;
}

function lnurl(url: string, hrp = 'lnurl'): string {
  return bech32(hrp, new TextEncoder().encode(url));
}

const publicLookup = async (): Promise<string[]> => ['93.184.216.34'];
const DEPS = { ownHost: '21.gifts', lookupImpl: publicLookup };

beforeEach(() => {
  inspectMock.mockReset();
  inspectMock.mockReturnValue({
    paymentHash: 'a'.repeat(64),
    amountMsat: 21_000,
    description: null,
    descriptionHash: METADATA_HASH,
    expirySeconds: 600,
  });
});

describe('resolveRelayPayRequest', () => {
  it('returns the validated pay request for a Lightning Address', async () => {
    const { fetchImpl, calls } = payRequestFetch();
    const result = await resolveRelayPayRequest({
      target: ' lightning:Bob@Example.com ',
      fetchImpl,
      ...DEPS,
    });
    expect(result).toEqual({
      ok: true,
      payRequest: {
        target: 'bob@example.com',
        minSendableMsat: 1000,
        maxSendableMsat: 100_000_000,
        commentAllowed: 10,
        description: 'Pay bob',
        domain: 'example.com',
      },
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(WELL_KNOWN);
    expect(calls[0]?.init?.redirect).toBe('error');
    expect(calls[0]?.init?.signal).toBeInstanceOf(AbortSignal);
  });

  it('resolves a bech32 LNURL and normalises it to lowercase', async () => {
    const code = lnurl('https://lnurl.example.org/p/abc?x=1');
    const { fetchImpl, calls } = fakeFetch({
      'https://lnurl.example.org/p/abc?x=1': () => json(PAY_REQUEST),
    });
    const result = await resolveRelayPayRequest({ target: code.toUpperCase(), fetchImpl, ...DEPS });
    expect(result.ok && result.payRequest.target).toBe(code);
    expect(result.ok && result.payRequest.domain).toBe('lnurl.example.org');
    expect(calls).toHaveLength(1);
  });

  it.each([
    ['not an address', 'hello'],
    ['malformed address', 'bob@'],
    ['IPv4 host', 'bob@127.0.0.1'],
    ['localhost name', 'bob@foo.localhost'],
    ['.local name', 'bob@printer.local'],
    ['.internal name', 'bob@db.internal'],
    ['own host', 'bob@21.gifts'],
    ['dot-only name', '..@example.com'],
    ['single-dot name', '.@example.com'],
    ['bad bech32 checksum', `${lnurl('https://a.example.com/x').slice(0, -1)}q`],
    ['bech32 with a bad character', 'lnurl1bbbbbbbbbbbb'],
    ['bech32 too short', 'lnurl1qqqqq'],
    ['bech32 without separator', 'lnurlqqqqqqqqq'],
    ['other bech32 prefix', lnurl('https://a.example.com/x', 'lnbc')],
    ['LNURL over http', lnurl('http://a.example.com/x')],
    ['LNURL to a URL with a port', lnurl('https://a.example.com:8443/x')],
    ['LNURL with credentials', lnurl('https://u:p@a.example.com/x')],
    ['LNURL to an IPv6 literal', lnurl('https://[::1]/x')],
    ['LNURL to a single label', lnurl('https://intranet/x')],
    ['LNURL to a decimal IPv4', lnurl('https://2130706433/x')],
    ['LNURL with a trailing dot', lnurl('https://a.example.com./x')],
    ['LNURL to the own host', lnurl('https://21.gifts/x')],
    ['LNURL that is not a URL', lnurl('not a url')],
    ['LNURL that is not UTF-8', bech32('lnurl', Uint8Array.from([0xff, 0xfe, 0xfd]))],
  ])('refuses %s with 400 and does not fetch', async (_label, target) => {
    const { fetchImpl, calls } = payRequestFetch();
    const result = await resolveRelayPayRequest({ target, fetchImpl, ...DEPS });
    expect(result).toMatchObject({ ok: false, status: 400, error: NOT_PAYABLE_ERROR });
    expect(calls).toHaveLength(0);
  });

  it('allows any outside host when no own host is configured', async () => {
    const { fetchImpl } = fakeFetch({
      'https://21.gifts/.well-known/lnurlp/bob': () => json(PAY_REQUEST),
    });
    const result = await resolveRelayPayRequest({
      target: 'bob@21.gifts',
      fetchImpl,
      ownHost: null,
      lookupImpl: publicLookup,
    });
    expect(result.ok).toBe(true);
  });

  it('resolves with the system resolver when no resolver is injected', async () => {
    dnsLookupMock.mockResolvedValueOnce([{ address: '2606:2800:220:1::1', family: 6 }]);
    dnsLookupMock.mockResolvedValueOnce([{ address: '93.184.216.34', family: 4 }]);
    const { fetchImpl } = payRequestFetch();
    const result = await resolveRelayPayRequest({
      target: 'bob@example.com',
      fetchImpl,
      ownHost: '21.gifts',
    });
    expect(result.ok).toBe(true);
    expect(dnsLookupMock).toHaveBeenCalledWith('example.com', { all: true, verbatim: true });
    expect(dnsLookupMock).toHaveBeenCalledWith('pay.example.com', { all: true, verbatim: true });
  });

  it.each([
    ['0.0.0.0'],
    ['10.1.2.3'],
    ['127.0.0.1'],
    ['100.64.0.1'],
    ['100.127.255.255'],
    ['169.254.169.254'],
    ['172.16.0.1'],
    ['172.31.255.255'],
    ['192.168.1.1'],
    ['198.18.0.1'],
    ['198.19.0.1'],
    ['224.0.0.1'],
    ['255.255.255.255'],
    ['::'],
    ['::1'],
    ['::ffff:127.0.0.1'],
    ['::FFFF:10.0.0.1'],
    ['::ffff:7f00:1'],
    ['fc00::1'],
    ['fe80::1'],
    ['ff02::1'],
    ['64:ff9b::a00:1'],
    ['2002:7f00:1::'],
    ['2001:db8::1'],
    ['192.0.2.1'],
  ])('refuses a target that resolves to %s with 400 and does not fetch', async (address) => {
    const { fetchImpl, calls } = payRequestFetch();
    const result = await resolveRelayPayRequest({
      target: 'bob@example.com',
      fetchImpl,
      ...DEPS,
      lookupImpl: async () => ['93.184.216.34', address],
    });
    expect(result).toMatchObject({ ok: false, status: 400, reason: 'address' });
    expect(calls).toHaveLength(0);
  });

  it.each([
    ['100.63.255.255'],
    ['100.128.0.1'],
    ['169.253.1.1'],
    ['172.15.0.1'],
    ['172.32.0.1'],
    ['192.169.0.1'],
    ['198.17.0.1'],
    ['198.20.0.1'],
    ['223.255.255.254'],
    ['::ffff:8.8.8.8'],
    ['2001:4860:4860::8888'],
    ['2a00:1450:4001::1'],
  ])('accepts a target that resolves to %s', async (address) => {
    const { fetchImpl } = payRequestFetch();
    const result = await resolveRelayPayRequest({
      target: 'bob@example.com',
      fetchImpl,
      ...DEPS,
      lookupImpl: async () => [address],
    });
    expect(result.ok).toBe(true);
  });

  it.each([
    ['a resolver error', async (): Promise<string[]> => Promise.reject(new Error('ENOTFOUND'))],
    ['no addresses', async (): Promise<string[]> => []],
  ])('maps %s to 502 without a fetch', async (_label, lookupImpl) => {
    const { fetchImpl, calls } = payRequestFetch();
    const result = await resolveRelayPayRequest({
      target: 'bob@example.com',
      fetchImpl,
      ...DEPS,
      lookupImpl,
    });
    expect(result).toMatchObject({ ok: false, status: 502, reason: 'dns' });
    expect(calls).toHaveLength(0);
  });

  it('maps a lookup that does not answer in time to 502 without a fetch', async () => {
    const { fetchImpl, calls } = payRequestFetch();
    const result = await resolveRelayPayRequest({
      target: 'bob@example.com',
      fetchImpl,
      ...DEPS,
      timeoutMs: 5,
      lookupImpl: () => new Promise<string[]>(() => undefined),
    });
    expect(result).toMatchObject({ ok: false, status: 502, reason: 'dns' });
    expect(calls).toHaveLength(0);
  });

  it('refuses a callback host that resolves to a private address with 400', async () => {
    const { fetchImpl } = payRequestFetch();
    const result = await resolveRelayPayRequest({
      target: 'bob@example.com',
      fetchImpl,
      ...DEPS,
      lookupImpl: async (host) => (host === 'pay.example.com' ? ['10.0.0.5'] : ['93.184.216.34']),
    });
    expect(result).toMatchObject({ ok: false, status: 400, reason: 'callback_address' });
  });

  it('maps an unresolvable callback host to 502', async () => {
    const { fetchImpl } = payRequestFetch();
    const result = await resolveRelayPayRequest({
      target: 'bob@example.com',
      fetchImpl,
      ...DEPS,
      lookupImpl: async (host) => (host === 'pay.example.com' ? [] : ['93.184.216.34']),
    });
    expect(result).toMatchObject({ ok: false, status: 502, reason: 'callback_dns' });
  });

  it.each([404, 410])('maps HTTP %i to 404', async (status) => {
    const { fetchImpl } = fakeFetch({ [WELL_KNOWN]: () => json({}, { status }) });
    const result = await resolveRelayPayRequest({ target: 'bob@example.com', fetchImpl, ...DEPS });
    expect(result).toMatchObject({ ok: false, status: 404, error: NOT_FOUND_ERROR });
  });

  it('maps an LNURL ERROR body to 404', async () => {
    const { fetchImpl } = payRequestFetch({ status: 'ERROR', reason: 'no such user' });
    const result = await resolveRelayPayRequest({ target: 'bob@example.com', fetchImpl, ...DEPS });
    expect(result).toMatchObject({ ok: false, status: 404, error: NOT_FOUND_ERROR });
  });

  it.each([
    [
      'a redirect',
      () => new Response(null, { status: 302, headers: { location: 'https://x.y/' } }),
    ],
    ['a 500', () => json({}, { status: 500 })],
    ['a 204 without a body', () => new Response(null, { status: 204 })],
    ['non-JSON', () => new Response('<html>', { status: 200 })],
    ['an empty body', () => new Response(null, { status: 200 })],
    ['a JSON array', () => json([1])],
    ['JSON null', () => json(null)],
  ])('maps %s to 502', async (_label, respond) => {
    const { fetchImpl } = fakeFetch({ [WELL_KNOWN]: respond });
    const result = await resolveRelayPayRequest({ target: 'bob@example.com', fetchImpl, ...DEPS });
    expect(result).toMatchObject({ ok: false, status: 502, error: UNREACHABLE_ERROR });
  });

  it('maps a fetch that refuses a redirect to 502', async () => {
    const fetchImpl: FetchFn = async (_input, init) => {
      expect(init?.redirect).toBe('error');
      throw new TypeError('redirect mode is set to error');
    };
    const result = await resolveRelayPayRequest({ target: 'bob@example.com', fetchImpl, ...DEPS });
    expect(result).toMatchObject({ ok: false, status: 502 });
  });

  it('maps a declared oversize body to 502', async () => {
    const { fetchImpl } = fakeFetch({
      [WELL_KNOWN]: () =>
        new Response(JSON.stringify(PAY_REQUEST), {
          headers: { 'content-length': String(LNURL_RELAY_BODY_CAP_BYTES + 1) },
        }),
    });
    const result = await resolveRelayPayRequest({ target: 'bob@example.com', fetchImpl, ...DEPS });
    expect(result).toMatchObject({ ok: false, status: 502 });
  });

  it('maps a streamed oversize body to 502 and aborts the request', async () => {
    let signal: AbortSignal | undefined;
    const chunk = new Uint8Array(16 * 1024).fill(0x20);
    const fetchImpl: FetchFn = async (_input, init) => {
      signal = init?.signal ?? undefined;
      let sent = 0;
      const stream = new ReadableStream<Uint8Array>({
        pull(controller): void {
          sent += 1;
          controller.enqueue(chunk);
          if (sent > 10) controller.close();
        },
      });
      return new Response(stream, { status: 200 });
    };
    const result = await resolveRelayPayRequest({ target: 'bob@example.com', fetchImpl, ...DEPS });
    expect(result).toMatchObject({ ok: false, status: 502 });
    expect(signal?.aborted).toBe(true);
  });

  it('reads a chunked body under the cap', async () => {
    const text = JSON.stringify(PAY_REQUEST);
    const fetchImpl: FetchFn = async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller): void {
            const bytes = new TextEncoder().encode(text);
            controller.enqueue(bytes.slice(0, 10));
            controller.enqueue(bytes.slice(10));
            controller.close();
          },
        }),
      );
    const result = await resolveRelayPayRequest({ target: 'bob@example.com', fetchImpl, ...DEPS });
    expect(result.ok).toBe(true);
  });

  it('maps a timeout to 502', async () => {
    const fetchImpl: FetchFn = (_input, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
      });
    const result = await resolveRelayPayRequest({
      target: 'bob@example.com',
      fetchImpl,
      ...DEPS,
      timeoutMs: 5,
    });
    expect(result).toMatchObject({ ok: false, status: 502, reason: 'fetch' });
    expect(LNURL_RELAY_TIMEOUT_MS).toBe(5_000);
  });

  it.each([
    ['a wrong tag', { tag: 'withdrawRequest' }],
    ['a missing callback', { callback: 1 }],
    ['a non-string metadata', { metadata: [] }],
    ['an http callback', { callback: 'http://pay.example.com/cb' }],
    ['a callback on an IP', { callback: 'https://10.0.0.1/cb' }],
    ['a callback on the own host', { callback: 'https://21.gifts/cb' }],
    ['a non-integer minSendable', { minSendable: 1000.5 }],
    ['a string maxSendable', { maxSendable: '100' }],
    ['a string minSendable', { minSendable: '100' }],
    ['an unsafe maxSendable', { maxSendable: 2 ** 60 }],
    ['a zero minSendable', { minSendable: 0 }],
    ['min above max', { minSendable: 5000, maxSendable: 4000 }],
    ['a negative commentAllowed', { commentAllowed: -1 }],
    ['a fractional commentAllowed', { commentAllowed: 1.5 }],
    ['a string commentAllowed', { commentAllowed: '10' }],
  ])('refuses a pay request with %s as 400', async (_label, patch) => {
    const { fetchImpl } = payRequestFetch({ ...PAY_REQUEST, ...patch });
    const result = await resolveRelayPayRequest({ target: 'bob@example.com', fetchImpl, ...DEPS });
    expect(result).toMatchObject({ ok: false, status: 400, error: NOT_PAYABLE_ERROR });
  });

  it.each([
    ['missing', undefined],
    ['null', null],
  ])('treats a %s commentAllowed as 0', async (_label, value) => {
    const { fetchImpl } = payRequestFetch({ ...PAY_REQUEST, commentAllowed: value });
    const result = await resolveRelayPayRequest({ target: 'bob@example.com', fetchImpl, ...DEPS });
    expect(result.ok && result.payRequest.commentAllowed).toBe(0);
  });

  it.each([
    ['not JSON', 'nope'],
    ['not an array', '{"a":1}'],
    ['without text/plain', '[["text/identifier","bob@example.com"],"x",["text/plain",1]]'],
  ])('returns an empty description when metadata is %s', async (_label, metadata) => {
    const { fetchImpl } = payRequestFetch({ ...PAY_REQUEST, metadata });
    const result = await resolveRelayPayRequest({ target: 'bob@example.com', fetchImpl, ...DEPS });
    expect(result.ok && result.payRequest.description).toBe('');
  });
});

describe('requestRelayInvoice', () => {
  it('returns the invoice and sends amount and comment to the callback', async () => {
    const { fetchImpl, calls } = payRequestFetch();
    const result = await requestRelayInvoice({
      target: 'bob@example.com',
      amountMsat: 21_000,
      comment: 'thanks 🙏',
      fetchImpl,
      ...DEPS,
    });
    expect(result).toEqual({ ok: true, pr: PR });
    expect(calls).toHaveLength(2);
    const invoiceUrl = new URL(calls[1]?.url ?? '');
    expect(invoiceUrl.origin + invoiceUrl.pathname).toBe('https://pay.example.com/cb');
    expect(invoiceUrl.searchParams.get('k')).toBe('1');
    expect(invoiceUrl.searchParams.get('amount')).toBe('21000');
    expect(invoiceUrl.searchParams.get('comment')).toBe('thanks 🙏');
    expect(calls[1]?.init?.redirect).toBe('error');
    expect(inspectMock).toHaveBeenCalledWith(PR);
  });

  it('appends amount and comment to the callback query as received', async () => {
    const { fetchImpl, calls } = payRequestFetch({
      ...PAY_REQUEST,
      callback: 'https://pay.example.com/cb?t=ab/c%3D&flag&k=a+b',
    });
    const result = await requestRelayInvoice({
      target: 'bob@example.com',
      amountMsat: 21_000,
      comment: 'a b+c',
      fetchImpl,
      ...DEPS,
    });
    expect(result.ok).toBe(true);
    expect(calls[1]?.url).toBe(
      'https://pay.example.com/cb?t=ab/c%3D&flag&k=a+b&amount=21000&comment=a%20b%2Bc',
    );
  });

  it('starts the query when the callback has none', async () => {
    const { fetchImpl, calls } = payRequestFetch({
      ...PAY_REQUEST,
      callback: 'https://pay.example.com/cb',
    });
    const result = await requestRelayInvoice({
      target: 'bob@example.com',
      amountMsat: 21_000,
      fetchImpl,
      ...DEPS,
    });
    expect(result.ok).toBe(true);
    expect(calls[1]?.url).toBe('https://pay.example.com/cb?amount=21000');
  });

  it('omits an empty comment', async () => {
    const { fetchImpl, calls } = payRequestFetch();
    const result = await requestRelayInvoice({
      target: 'bob@example.com',
      amountMsat: 21_000,
      comment: '',
      fetchImpl,
      ...DEPS,
    });
    expect(result.ok).toBe(true);
    expect(new URL(calls[1]?.url ?? '').searchParams.has('comment')).toBe(false);
  });

  it('passes pay-request failures through without calling the callback', async () => {
    const { fetchImpl, calls } = payRequestFetch();
    const result = await requestRelayInvoice({
      target: 'bob@21.gifts',
      amountMsat: 21_000,
      fetchImpl,
      ...DEPS,
    });
    expect(result).toMatchObject({ ok: false, status: 400, error: NOT_PAYABLE_ERROR });
    expect(calls).toHaveLength(0);
  });

  it.each([
    ['not a whole number of millisatoshis', 1000.5],
    ['not finite', Number.NaN],
  ])('refuses an amount %s with 400 before any request', async (_label, amountMsat) => {
    const { fetchImpl, calls } = payRequestFetch();
    const result = await requestRelayInvoice({
      target: 'bob@example.com',
      amountMsat,
      fetchImpl,
      ...DEPS,
      lookupImpl: async () => {
        throw new Error('lookup must not run');
      },
    });
    expect(result).toMatchObject({ ok: false, status: 400, error: AMOUNT_ERROR });
    expect(calls).toHaveLength(0);
  });

  it.each([
    ['below the minimum', 999],
    ['above the maximum', 100_000_001],
  ])('refuses an amount %s with 400', async (_label, amountMsat) => {
    const { fetchImpl, calls } = payRequestFetch();
    const result = await requestRelayInvoice({
      target: 'bob@example.com',
      amountMsat,
      fetchImpl,
      ...DEPS,
    });
    expect(result).toMatchObject({ ok: false, status: 400, error: AMOUNT_ERROR });
    expect(calls).toHaveLength(1);
  });

  it('refuses a comment longer than commentAllowed (counted in characters)', async () => {
    const { fetchImpl, calls } = payRequestFetch();
    const ok = await requestRelayInvoice({
      target: 'bob@example.com',
      amountMsat: 21_000,
      comment: '🙏'.repeat(10),
      fetchImpl,
      ...DEPS,
    });
    expect(ok.ok).toBe(true);
    const tooLong = await requestRelayInvoice({
      target: 'bob@example.com',
      amountMsat: 21_000,
      comment: 'x'.repeat(11),
      fetchImpl,
      ...DEPS,
    });
    expect(tooLong).toMatchObject({ ok: false, status: 400, error: COMMENT_ERROR });
    expect(calls).toHaveLength(3);
  });

  it('refuses any comment when the server accepts none', async () => {
    const { fetchImpl } = payRequestFetch({ ...PAY_REQUEST, commentAllowed: 0 });
    const result = await requestRelayInvoice({
      target: 'bob@example.com',
      amountMsat: 21_000,
      comment: 'x',
      fetchImpl,
      ...DEPS,
    });
    expect(result).toMatchObject({ ok: false, status: 400, error: COMMENT_ERROR });
  });

  it.each([
    ['a failed invoice fetch', () => json({}, { status: 500 }), 'invoice_status'],
    ['an invoice redirect', () => new Response(null, { status: 307 }), 'invoice_status'],
    ['non-JSON', () => new Response('x'), 'invoice_fetch'],
    ['an array', () => json([]), 'invoice_shape'],
    ['an LNURL ERROR', () => json({ status: 'error', reason: 'x' }), 'invoice_shape'],
    ['a missing pr', () => json({ routes: [] }), 'invoice_shape'],
  ])('maps %s to 502', async (_label, respond, reason) => {
    const { fetchImpl } = fakeFetch({
      [WELL_KNOWN]: () => json(PAY_REQUEST),
      'https://pay.example.com/cb': respond,
    });
    const result = await requestRelayInvoice({
      target: 'bob@example.com',
      amountMsat: 21_000,
      fetchImpl,
      ...DEPS,
    });
    expect(result).toEqual({ ok: false, status: 502, error: UNREACHABLE_ERROR, reason });
  });

  it('maps an undecodable invoice to 502', async () => {
    inspectMock.mockReturnValue(null);
    const { fetchImpl } = payRequestFetch();
    const result = await requestRelayInvoice({
      target: 'bob@example.com',
      amountMsat: 21_000,
      fetchImpl,
      ...DEPS,
    });
    expect(result).toMatchObject({ ok: false, status: 502, reason: 'invoice_amount' });
  });

  it('maps an invoice for another amount to 502', async () => {
    const { fetchImpl } = payRequestFetch();
    const result = await requestRelayInvoice({
      target: 'bob@example.com',
      amountMsat: 22_000,
      fetchImpl,
      ...DEPS,
    });
    expect(result).toMatchObject({ ok: false, status: 502, reason: 'invoice_amount' });
  });

  it.each([
    ['another description hash', 'b'.repeat(64)],
    ['no description hash', null],
  ])('maps an invoice with %s to 502', async (_label, descriptionHash) => {
    inspectMock.mockReturnValue({
      paymentHash: 'a'.repeat(64),
      amountMsat: 21_000,
      description: 'Pay bob',
      descriptionHash,
      expirySeconds: 600,
    });
    const { fetchImpl } = payRequestFetch();
    const result = await requestRelayInvoice({
      target: 'bob@example.com',
      amountMsat: 21_000,
      fetchImpl,
      ...DEPS,
    });
    expect(result).toMatchObject({ ok: false, status: 502, reason: 'invoice_description' });
  });
});

describe('LnurlRelayRateLimiter', () => {
  it('allows the cap per window per account and slides', () => {
    const limiter = new LnurlRelayRateLimiter();
    for (let i = 0; i < LNURL_RELAY_CAP; i += 1) {
      expect(limiter.allow('a', 1000 + i)).toBe(true);
    }
    expect(limiter.allow('a', 2000)).toBe(false);
    expect(limiter.allow('b', 2000)).toBe(true);
    expect(limiter.allow('a', 1000 + LNURL_RELAY_WINDOW_MS)).toBe(true);
    expect(limiter.allow('a', 1000 + LNURL_RELAY_WINDOW_MS)).toBe(false);
  });

  it('evicts idle accounts', () => {
    const limiter = new LnurlRelayRateLimiter();
    for (let i = 0; i < LNURL_RELAY_CAP; i += 1) {
      limiter.allow('a', 0);
    }
    expect(limiter.allow('b', LNURL_RELAY_WINDOW_MS)).toBe(true);
    expect(limiter.allow('a', LNURL_RELAY_WINDOW_MS)).toBe(true);
  });
});
