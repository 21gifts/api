import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import type { FetchFn } from '@/lib/lnurlp';
import {
  ORCHESTRA_FINAL_STATUSES,
  ORCHESTRA_PROGRESSING_STATUSES,
  ORCHESTRA_PROOF_SUBMITS_PER_MINUTE,
  ORCHESTRA_QUOTES_PER_MINUTE,
  ORCHESTRA_ROUTES_PER_MINUTE,
  ORCHESTRA_STATUS_READS_PER_MINUTE,
  ORCHESTRA_SUBMITS_PER_MINUTE,
  OrchestraClient,
  type OrchestraQuoteRequest,
  type OrchestraSubmitCaller,
} from '@/lib/orchestra';

const BASE = 'https://orchestra.example';
const KEY = 'fn_secret';
const T0 = Date.parse('2026-10-17T12:00:00.000Z');
const BOLT11 = 'lnbc10u1pexample';

interface Call {
  url: string;
  init: RequestInit;
}

type Responder = () => Promise<Response> | Response;

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

function err(status: number, code: string, headers: Record<string, string> = {}): Response {
  return json({ error: { code, message: 'nope' } }, status, headers);
}

function named(name: string): Error {
  const error = new Error(name);
  error.name = name;
  return error;
}

/** Fake Orchestra: answers from `responders` in order, then 200 `{}`. */
function harness(responders: Responder[] = [], fallback?: Responder) {
  const calls: Call[] = [];
  const clock = { t: T0 };
  const queue = [...responders];
  const fetchImpl: FetchFn = async (input, init) => {
    calls.push({ url: String(input), init: init ?? {} });
    const next = queue.shift() ?? fallback ?? (() => json({}));
    return next();
  };
  const client = new OrchestraClient({ baseUrl: BASE, apiKey: KEY, fetchImpl, now: () => clock.t });
  return { client, calls, clock };
}

function headersOf(call: Call | undefined): Record<string, string> {
  return (call?.init.headers ?? {}) as Record<string, string>;
}

let warn: MockInstance<typeof console.warn>;

function events(): Array<Record<string, unknown>> {
  return warn.mock.calls.map((args) => JSON.parse(String(args[0])) as Record<string, unknown>);
}

function eventsNamed(name: string): Array<Record<string, unknown>> {
  return events()
    .filter((e) => e['event'] === name)
    .map(({ ts: _ts, event: _event, ...rest }) => rest);
}

beforeEach(() => {
  warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

const REQUEST: OrchestraQuoteRequest = {
  sourceChain: 'polygon',
  sourceAsset: 'USDT',
  amountSats: 1234,
  bolt11: BOLT11,
  tag: 'pay_1',
  refundAddress: '0xrefund',
};

const QUOTE_BODY = {
  quoteId: 'q_1',
  depositAddress: '0xABCDEF',
  amountIn: '1000000',
  requiredAmountIn: '990000',
  maxAcceptedAmountIn: '1010000',
  targetAmountOut: '1234',
  expiresAt: '2026-10-17T12:02:00.000Z',
  estimatedOut: '1234',
  transaction: { chainId: 137, to: '0xC2132D05', data: '0xA9059CBB00', value: '0' },
};

describe('constants', () => {
  it('lists the final and progressing statuses and the budgets', () => {
    expect([...ORCHESTRA_FINAL_STATUSES]).toEqual([
      'completed',
      'refunded',
      'failed',
      'fallback_delivered',
      'expired',
    ]);
    expect([...ORCHESTRA_PROGRESSING_STATUSES]).toEqual([
      'processing',
      'confirming',
      'awaiting_approval',
      'swapping',
      'bridging',
      'delivering',
    ]);
    expect([
      ORCHESTRA_STATUS_READS_PER_MINUTE,
      ORCHESTRA_SUBMITS_PER_MINUTE,
      ORCHESTRA_PROOF_SUBMITS_PER_MINUTE,
      ORCHESTRA_QUOTES_PER_MINUTE,
      ORCHESTRA_ROUTES_PER_MINUTE,
    ]).toEqual([50, 30, 20, 240, 25]);
  });
});

describe('OrchestraClient.routes', () => {
  it('parses assets and sends the server key on a GET', async () => {
    const timeout = vi.spyOn(AbortSignal, 'timeout');
    const { client, calls } = harness([
      () =>
        json({
          validForMs: 9971,
          assets: [
            {
              chain: 'polygon',
              asset: 'USDT',
              contractAddress: '0xC2132D05',
              decimals: 6,
              route: { to: 'all', exactOutTo: ['lightning:BTC'] },
            },
            {
              chain: 'bitcoin',
              asset: 'BTC',
              contractAddress: null,
              decimals: 8,
              route: { exactOutTo: 'all' },
            },
            {
              chain: 'a',
              asset: 'A',
              decimals: 0,
              route: { exactOutTo: { except: ['spark:BTC'] } },
            },
            {
              chain: 'b',
              asset: 'B',
              decimals: 1,
              route: { exactOutTo: { except: ['lightning:BTC'] } },
            },
            {
              chain: 'c',
              asset: 'C',
              decimals: 2,
              route: { exactOutTo: { except: 'lightning:BTC' } },
            },
            { chain: 'd', asset: 'D', decimals: 3, route: { exactOutTo: ['spark:USDB'] } },
            { chain: 'e', asset: 'E', decimals: 4 },
            { chain: 'f', asset: 'F', decimals: 5, route: { exactOutTo: 'none' } },
            'garbage',
            null,
            { asset: 'X', decimals: 6 },
            { chain: 'x', decimals: 6 },
            { chain: 'x', asset: 'X', decimals: '6' },
            { chain: 'x', asset: 'X', decimals: 1.5 },
            { chain: 'x', asset: 'X', decimals: -1 },
            { chain: 'x', asset: 'X', decimals: 6, contractAddress: 7 },
          ],
        }),
    ]);

    const result = await client.routes(5000);

    expect(result).toEqual({
      ok: true,
      validForMs: 9971,
      assets: [
        {
          chain: 'polygon',
          asset: 'USDT',
          contractAddress: '0xc2132d05',
          decimals: 6,
          exactOutToLightning: true,
        },
        {
          chain: 'bitcoin',
          asset: 'BTC',
          contractAddress: null,
          decimals: 8,
          exactOutToLightning: true,
        },
        { chain: 'a', asset: 'A', contractAddress: null, decimals: 0, exactOutToLightning: true },
        { chain: 'b', asset: 'B', contractAddress: null, decimals: 1, exactOutToLightning: false },
        { chain: 'c', asset: 'C', contractAddress: null, decimals: 2, exactOutToLightning: false },
        { chain: 'd', asset: 'D', contractAddress: null, decimals: 3, exactOutToLightning: false },
        { chain: 'e', asset: 'E', contractAddress: null, decimals: 4, exactOutToLightning: false },
        { chain: 'f', asset: 'F', contractAddress: null, decimals: 5, exactOutToLightning: false },
      ],
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(`${BASE}/v2/orchestration/routes`);
    expect(calls[0]?.init).toMatchObject({ method: 'GET', redirect: 'error' });
    expect(calls[0]?.init.signal).toBeInstanceOf(AbortSignal);
    expect(calls[0]?.init.body).toBeUndefined();
    expect(headersOf(calls[0])).toEqual({ Authorization: `Bearer ${KEY}` });
    expect(timeout).toHaveBeenCalledWith(5000);
    expect(events()).toEqual([]);
  });

  it.each([
    ['a non-object body', () => json('nope')],
    ['assets missing', () => json({ validForMs: 1 })],
    ['validForMs missing', () => json({ assets: [] })],
    ['validForMs negative', () => json({ assets: [], validForMs: -1 })],
    ['a non-JSON body', () => new Response('<html>', { status: 200 })],
  ])('fails on %s', async (_label, responder) => {
    const { client } = harness([responder]);
    expect(await client.routes(5000)).toEqual({ ok: false });
  });

  it('fails and logs on a non-2xx answer and on a transport error', async () => {
    const { client } = harness([
      () => err(500, 'internal'),
      () => {
        throw new TypeError('fetch failed');
      },
    ]);
    expect(await client.routes(5000)).toEqual({ ok: false });
    expect(await client.routes(5000)).toEqual({ ok: false });
    expect(eventsNamed('shop.orchestra.error')).toEqual([
      { endpoint: 'routes', status: 500 },
      { endpoint: 'routes', status: 'transport' },
    ]);
  });

  it('is paused by a 429 and sends nothing while paused', async () => {
    const { client, calls, clock } = harness([
      () => err(429, 'rate_limited', { 'Retry-After': '2' }),
      () => json({ assets: [], validForMs: 0 }),
    ]);
    expect(await client.routes(5000)).toEqual({ ok: false });
    clock.t += 1999;
    expect(await client.routes(5000)).toEqual({ ok: false });
    expect(calls).toHaveLength(1);
    clock.t += 1;
    expect(await client.routes(5000)).toEqual({ ok: true, assets: [], validForMs: 0 });
    expect(eventsNamed('shop.orchestra.rate_limited')).toEqual([{ endpoint: 'routes' }]);
    expect(eventsNamed('shop.orchestra.error')).toEqual([{ endpoint: 'routes', status: 429 }]);
  });
});

describe('OrchestraClient.routes budget', () => {
  it('sends 25 route-list fetches per sliding minute; the 26th is not sent and logs budget_exhausted', async () => {
    const { client, calls, clock } = harness([], () => json({ assets: [], validForMs: 0 }));
    for (let i = 0; i < ORCHESTRA_ROUTES_PER_MINUTE; i += 1) {
      expect((await client.routes(5000)).ok).toBe(true);
    }
    expect(await client.routes(5000)).toEqual({ ok: false });
    expect(calls).toHaveLength(25);
    expect(eventsNamed('shop.orchestra.budget_exhausted')).toEqual([{ endpoint: 'routes' }]);
    // The window slides: the first fetch leaves it 60 s after it was sent.
    clock.t += 59_999;
    expect(await client.routes(5000)).toEqual({ ok: false });
    expect(calls).toHaveLength(25);
    clock.t += 1;
    expect((await client.routes(5000)).ok).toBe(true);
    expect(calls).toHaveLength(26);
  });

  it('counts failed fetches, and the routes budget leaves the quote budget alone', async () => {
    const { client, calls } = harness([], () => err(500, 'internal'));
    for (let i = 0; i < ORCHESTRA_ROUTES_PER_MINUTE; i += 1) {
      expect(await client.routes(5000)).toEqual({ ok: false });
    }
    expect(calls).toHaveLength(25);
    await client.routes(5000);
    expect(calls).toHaveLength(25);
    expect(client.quoteBudgetLeft()).toBe(ORCHESTRA_QUOTES_PER_MINUTE);
  });

  it('a 429 on routes pauses only routes', async () => {
    const { client, calls, clock } = harness(
      [() => err(429, 'rate_limited', { 'Retry-After': '10' })],
      () => json(QUOTE_BODY),
    );
    expect(await client.routes(5000)).toEqual({ ok: false });
    clock.t += 1_000;
    expect(await client.routes(5000)).toEqual({ ok: false });
    expect(calls).toHaveLength(1);
    expect((await client.quote(REQUEST, 'k-after-429', clock.t + 5000)).ok).toBe(true);
    expect(calls).toHaveLength(2);
    expect(eventsNamed('shop.orchestra.budget_exhausted')).toEqual([]);
  });
});

describe('OrchestraClient.quote', () => {
  it('sends the exact-out body with the key headers and parses the flat answer', async () => {
    const timeout = vi.spyOn(AbortSignal, 'timeout');
    const { client, calls } = harness([() => json(QUOTE_BODY)]);

    const result = await client.quote(REQUEST, 'idem-1', T0 + 3000.4);

    expect(result).toEqual({
      ok: true,
      quote: {
        quoteId: 'q_1',
        depositAddress: '0xabcdef',
        amountIn: '1000000',
        requiredAmountIn: '990000',
        maxAcceptedAmountIn: '1010000',
        targetAmountOut: '1234',
        expiresAt: '2026-10-17T12:02:00.000Z',
        transaction: { chainId: 137, to: '0xc2132d05', data: '0xa9059cbb00', value: '0' },
      },
    });
    expect(calls[0]?.url).toBe(`${BASE}/v1/orchestration/quote`);
    expect(calls[0]?.init).toMatchObject({ method: 'POST', redirect: 'error' });
    expect(headersOf(calls[0])).toEqual({
      Authorization: `Bearer ${KEY}`,
      'Content-Type': 'application/json',
      'X-Idempotency-Key': 'idem-1',
    });
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({
      sourceChain: 'polygon',
      sourceAsset: 'USDT',
      destinationChain: 'lightning',
      destinationAsset: 'BTC',
      amount: '1234',
      amountMode: 'exact_out',
      recipientAddress: BOLT11,
      tag: 'pay_1',
      refundAddress: '0xrefund',
      includeCalldata: true,
    });
    expect(timeout).toHaveBeenCalledWith(3001);
  });

  it('maps missing optional fields to null', async () => {
    const { client } = harness([
      () =>
        json({
          quoteId: 'q_2',
          depositAddress: '0xD',
          amountIn: '5',
          requiredAmountIn: null,
          expiresAt: '2026-10-17T12:02:00Z',
          transaction: null,
        }),
    ]);
    expect(await client.quote(REQUEST, 'k', T0 + 5000)).toEqual({
      ok: true,
      quote: {
        quoteId: 'q_2',
        depositAddress: '0xd',
        amountIn: '5',
        requiredAmountIn: null,
        maxAcceptedAmountIn: null,
        targetAmountOut: null,
        expiresAt: '2026-10-17T12:02:00Z',
        transaction: null,
      },
    });
  });

  const tx = QUOTE_BODY.transaction;
  it.each([
    ['a non-object body', 'x'],
    ['an empty quoteId', { ...QUOTE_BODY, quoteId: '' }],
    ['a missing quoteId', { ...QUOTE_BODY, quoteId: undefined }],
    ['a numeric depositAddress', { ...QUOTE_BODY, depositAddress: 1 }],
    ['a missing amountIn', { ...QUOTE_BODY, amountIn: undefined }],
    ['a numeric expiresAt', { ...QUOTE_BODY, expiresAt: 1 }],
    ['an unparsable expiresAt', { ...QUOTE_BODY, expiresAt: 'soon' }],
    ['a numeric requiredAmountIn', { ...QUOTE_BODY, requiredAmountIn: 1 }],
    ['a numeric maxAcceptedAmountIn', { ...QUOTE_BODY, maxAcceptedAmountIn: 1 }],
    ['a numeric targetAmountOut', { ...QUOTE_BODY, targetAmountOut: 1 }],
    ['a string transaction', { ...QUOTE_BODY, transaction: 'tx' }],
    ['an array transaction', { ...QUOTE_BODY, transaction: [] }],
    ['a string chainId', { ...QUOTE_BODY, transaction: { ...tx, chainId: '137' } }],
    ['a fractional chainId', { ...QUOTE_BODY, transaction: { ...tx, chainId: 1.5 } }],
    ['a zero chainId', { ...QUOTE_BODY, transaction: { ...tx, chainId: 0 } }],
    ['a missing to', { ...QUOTE_BODY, transaction: { ...tx, to: undefined } }],
    ['a numeric data', { ...QUOTE_BODY, transaction: { ...tx, data: 1 } }],
    ['a numeric value', { ...QUOTE_BODY, transaction: { ...tx, value: 0 } }],
  ])('refuses a 200 with %s', async (_label, body) => {
    const { client } = harness([() => json(body)]);
    expect(await client.quote(REQUEST, 'k', T0 + 5000)).toEqual({ ok: false, reason: 'refused' });
  });

  it('refuses a 200 that is not JSON', async () => {
    const { client } = harness([() => new Response('ok', { status: 200 })]);
    expect(await client.quote(REQUEST, 'k', T0 + 5000)).toEqual({ ok: false, reason: 'refused' });
  });

  it.each([
    ['400 unsupported_route', () => err(400, 'unsupported_route')],
    ['403 sanctioned_address', () => err(403, 'sanctioned_address')],
    ['409 idempotency_conflict', () => err(409, 'idempotency_conflict')],
    ['404 without a body', () => new Response('', { status: 404 })],
  ])('refuses %s without a retry', async (_label, responder) => {
    const { client, calls } = harness([responder]);
    expect(await client.quote(REQUEST, 'k', T0 + 5000)).toEqual({ ok: false, reason: 'refused' });
    expect(calls).toHaveLength(1);
    expect(eventsNamed('shop.alert.orchestra_request')).toEqual([]);
  });

  it.each([
    ['a transport error', () => Promise.reject(new TypeError('down'))],
    ['a timeout', () => Promise.reject(named('TimeoutError'))],
    ['HTTP 503', () => err(503, 'quote_preparation_pending')],
    ['HTTP 500', () => err(500, 'internal')],
    ['HTTP 409 idempotency_in_progress', () => err(409, 'idempotency_in_progress')],
    ['HTTP 429 without pause headers', () => err(429, 'rate_limited')],
  ])('retries once after %s with the same key and body', async (_label, responder) => {
    const { client, calls } = harness([responder, () => json(QUOTE_BODY)]);
    const result = await client.quote(REQUEST, 'idem-r', T0 + 5000);
    expect(result.ok).toBe(true);
    expect(calls).toHaveLength(2);
    expect(calls[1]?.init.body).toBe(calls[0]?.init.body);
    expect(headersOf(calls[1])).toEqual(headersOf(calls[0]));
  });

  it('is unavailable when both attempts are retryable failures', async () => {
    const { client, calls } = harness([
      () => err(502, 'calldata_unavailable'),
      () => err(503, 'x'),
    ]);
    expect(await client.quote(REQUEST, 'k', T0 + 5000)).toEqual({
      ok: false,
      reason: 'unavailable',
    });
    expect(calls).toHaveLength(2);
    expect(eventsNamed('shop.orchestra.error')).toEqual([
      { endpoint: 'quote', status: 502 },
      { endpoint: 'quote', status: 503 },
    ]);
  });

  it('sends nothing once the deadline has passed', async () => {
    const { client, calls } = harness();
    expect(await client.quote(REQUEST, 'k', T0)).toEqual({ ok: false, reason: 'unavailable' });
    expect(calls).toHaveLength(0);
  });

  it('does not retry after the deadline passed during the first attempt', async () => {
    const h = harness([
      () => {
        h.clock.t += 6000;
        return err(503, 'x');
      },
    ]);
    expect(await h.client.quote(REQUEST, 'k', T0 + 5000)).toEqual({
      ok: false,
      reason: 'unavailable',
    });
    expect(h.calls).toHaveLength(1);
  });

  it('gives each attempt the time left as its timeout', async () => {
    const timeout = vi.spyOn(AbortSignal, 'timeout');
    const h = harness([
      () => {
        h.clock.t += 1500;
        return err(500, 'x');
      },
      () => json(QUOTE_BODY),
    ]);
    await h.client.quote(REQUEST, 'k', T0 + 4000);
    expect(timeout.mock.calls).toEqual([[4000], [2500]]);
  });

  it('answers paused when a 429 paused the retry, and while paused', async () => {
    const { client, calls, clock } = harness([
      () => err(429, 'rate_limited', { 'X-RateLimit-Reset': String(T0 + 10_000) }),
    ]);
    expect(await client.quote(REQUEST, 'k', T0 + 5000)).toEqual({ ok: false, reason: 'paused' });
    expect(await client.quote(REQUEST, 'k2', T0 + 5000)).toEqual({ ok: false, reason: 'paused' });
    expect(client.quoteBudgetLeft()).toBe(0);
    expect(calls).toHaveLength(1);
    clock.t = T0 + 10_000;
    expect(client.quoteBudgetLeft()).toBe(ORCHESTRA_QUOTES_PER_MINUTE - 1);
    expect(eventsNamed('shop.orchestra.rate_limited')).toEqual([{ endpoint: 'quote' }]);
  });

  it('sends the retry of a 429 once its pause ends before the deadline, with the same key', async () => {
    const calls: Call[] = [];
    const clock = { t: T0 };
    const slept: number[] = [];
    const queue: Responder[] = [
      () => err(429, 'rate_limited', { 'Retry-After': '1' }),
      () => json(QUOTE_BODY),
    ];
    const client = new OrchestraClient({
      baseUrl: BASE,
      apiKey: KEY,
      fetchImpl: async (input, init) => {
        calls.push({ url: String(input), init: init ?? {} });
        return queue.shift()!();
      },
      now: () => clock.t,
      sleep: async (ms) => {
        slept.push(ms);
        clock.t += ms;
      },
    });
    expect((await client.quote(REQUEST, 'idem-p', T0 + 3000)).ok).toBe(true);
    expect(slept).toEqual([1000]);
    expect(calls).toHaveLength(2);
    expect(headersOf(calls[1])).toEqual(headersOf(calls[0]));
    expect(calls[1]?.init.body).toBe(calls[0]?.init.body);
  });

  it('waits for the pause with the default sleep', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'Date'], now: T0 });
    try {
      const queue: Responder[] = [
        () => err(429, 'rate_limited', { 'Retry-After': '1' }),
        () => json(QUOTE_BODY),
      ];
      const client = new OrchestraClient({
        baseUrl: BASE,
        apiKey: KEY,
        fetchImpl: async () => queue.shift()!(),
        now: () => Date.now(),
      });
      const pending = client.quote(REQUEST, 'idem-d', T0 + 3000);
      await vi.advanceTimersByTimeAsync(1000);
      expect((await pending).ok).toBe(true);
      expect(queue).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps 240 quote calls per sliding minute', async () => {
    const { client, calls, clock } = harness([], () => json(QUOTE_BODY));
    expect(client.quoteBudgetLeft()).toBe(240);
    for (let i = 0; i < ORCHESTRA_QUOTES_PER_MINUTE; i += 1) {
      expect((await client.quote(REQUEST, `k${i}`, clock.t + 5000)).ok).toBe(true);
    }
    expect(client.quoteBudgetLeft()).toBe(0);
    expect(await client.quote(REQUEST, 'over', clock.t + 5000)).toEqual({
      ok: false,
      reason: 'budget',
    });
    expect(calls).toHaveLength(ORCHESTRA_QUOTES_PER_MINUTE);
    expect(eventsNamed('shop.orchestra.budget_exhausted')).toEqual([{ endpoint: 'quote' }]);
    clock.t += 59_999;
    expect(client.quoteBudgetLeft()).toBe(0);
    clock.t += 1;
    expect(client.quoteBudgetLeft()).toBe(240);
  });

  it('counts a retry against the budget and answers budget when it has no slot', async () => {
    const calls: Call[] = [];
    const client = new OrchestraClient({
      baseUrl: BASE,
      apiKey: KEY,
      now: () => T0,
      fetchImpl: async (input, init) => {
        calls.push({ url: String(input), init: init ?? {} });
        return calls.length === ORCHESTRA_QUOTES_PER_MINUTE ? err(503, 'x') : json(QUOTE_BODY);
      },
    });
    for (let i = 0; i < ORCHESTRA_QUOTES_PER_MINUTE - 1; i += 1) {
      await client.quote(REQUEST, `r${i}`, T0 + 5000);
    }
    expect(await client.quote(REQUEST, 'last', T0 + 5000)).toEqual({
      ok: false,
      reason: 'budget',
    });
    expect(calls).toHaveLength(ORCHESTRA_QUOTES_PER_MINUTE);
  });
});

describe('OrchestraClient.submit', () => {
  it('sends only quoteId and txHash and returns the order', async () => {
    const { client, calls } = harness([() => json({ orderId: 'ord_1', status: 'confirming' })]);
    expect(await client.submit('q_1', '0xhash', 'sub-1', 'proof-first', 5000)).toEqual({
      kind: 'order',
      orderId: 'ord_1',
      status: 'confirming',
    });
    expect(calls[0]?.url).toBe(`${BASE}/v1/orchestration/submit`);
    expect(calls[0]?.init).toMatchObject({ method: 'POST', redirect: 'error' });
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({ quoteId: 'q_1', txHash: '0xhash' });
    expect(headersOf(calls[0])).toEqual({
      Authorization: `Bearer ${KEY}`,
      'Content-Type': 'application/json',
      'X-Idempotency-Key': 'sub-1',
    });
  });

  it('stores an empty status when the 200 has none', async () => {
    const { client } = harness([() => json({ orderId: 'ord_2', status: 7 })]);
    expect(await client.submit('q', 'h', 'k', 'watcher', 5000)).toEqual({
      kind: 'order',
      orderId: 'ord_2',
      status: '',
    });
  });

  it.each([
    [
      '400 xchain_deposit_mismatch',
      () => err(400, 'xchain_deposit_mismatch'),
      { kind: 'mismatch' },
    ],
    ['409 quote_expired', () => err(409, 'quote_expired'), { kind: 'quote_expired' }],
    [
      '200 without orderId',
      () => json({ status: 'confirming' }),
      { kind: 'unresolved', retryable: false },
    ],
    [
      '200 with an empty orderId',
      () => json({ orderId: '' }),
      { kind: 'unresolved', retryable: false },
    ],
    ['200 that is not JSON', () => new Response('ok'), { kind: 'unresolved', retryable: false }],
    ['200 with an array', () => json([]), { kind: 'unresolved', retryable: false }],
    [
      '409 idempotency_in_progress',
      () => err(409, 'idempotency_in_progress'),
      { kind: 'unresolved', retryable: true },
    ],
    [
      '503 xchain_deposit_pending',
      () => err(503, 'xchain_deposit_pending'),
      { kind: 'unresolved', retryable: true },
    ],
    ['404', () => err(404, 'not_found'), { kind: 'unresolved', retryable: false }],
    ['429', () => err(429, 'rate_limited'), { kind: 'unresolved', retryable: true }],
    [
      'a timeout',
      () => Promise.reject(named('AbortError')),
      { kind: 'unresolved', retryable: true },
    ],
    [
      'a transport error',
      () => Promise.reject(new TypeError('down')),
      { kind: 'unresolved', retryable: true },
    ],
    ['500', () => err(500, 'internal'), { kind: 'unresolved', retryable: true }],
    [
      '502 without a body',
      () => new Response('', { status: 502 }),
      { kind: 'unresolved', retryable: true },
    ],
    [
      '409 idempotency_conflict',
      () => err(409, 'idempotency_conflict'),
      { kind: 'unresolved', retryable: false },
    ],
    [
      '409 xchain_lightning_submissionless',
      () => err(409, 'xchain_lightning_submissionless'),
      { kind: 'unresolved', retryable: false },
    ],
  ])('maps %s without an alert', async (_label, responder, expected) => {
    const { client } = harness([responder]);
    expect(await client.submit('q', 'h', 'k', 'proof-repeat', 5000)).toEqual(expected);
    expect(eventsNamed('shop.alert.orchestra_request')).toEqual([]);
  });

  it.each([
    [401, 'unauthorized'],
    [403, 'forbidden'],
    [400, 'invalid_tx_hash'],
  ])('leaves HTTP %i unresolved, not retryable, and alerts', async (status, code) => {
    const { client } = harness([() => err(status, code)]);
    expect(await client.submit('q', 'h', 'k', 'watcher', 5000)).toEqual({
      kind: 'unresolved',
      retryable: false,
    });
    expect(eventsNamed('shop.alert.orchestra_request')).toEqual([
      { endpoint: 'submit', status, code },
    ]);
  });

  it('alerts with an empty code when the 400 has no error body', async () => {
    const { client } = harness([() => new Response('bad', { status: 400 })]);
    expect(await client.submit('q', 'h', 'k', 'watcher', 5000)).toEqual({
      kind: 'unresolved',
      retryable: false,
    });
    expect(eventsNamed('shop.alert.orchestra_request')).toEqual([
      { endpoint: 'submit', status: 400, code: '' },
    ]);
  });

  async function run(
    client: OrchestraClient,
    caller: OrchestraSubmitCaller,
    times: number,
  ): Promise<string[]> {
    const kinds: string[] = [];
    for (let i = 0; i < times; i += 1) {
      kinds.push((await client.submit('q', 'h', `${caller}${i}`, caller, 5000)).kind);
    }
    return kinds;
  }

  it('gives proof requests at most 20 and keeps the rest for the watcher', async () => {
    const { client, calls, clock } = harness([], () => json({ orderId: 'o', status: 's' }));
    expect(await run(client, 'proof-first', 20)).toEqual(Array(20).fill('order'));
    expect(await run(client, 'proof-first', 1)).toEqual(['budget']);
    expect(await run(client, 'proof-repeat', 1)).toEqual(['budget']);
    expect(await run(client, 'watcher', 10)).toEqual(Array(10).fill('order'));
    expect(await run(client, 'watcher', 1)).toEqual(['budget']);
    expect(calls).toHaveLength(30);
    expect(eventsNamed('shop.orchestra.budget_exhausted')).toEqual([
      { endpoint: 'submit' },
      { endpoint: 'submit' },
      { endpoint: 'submit' },
    ]);
    clock.t += 60_000;
    expect(await run(client, 'proof-first', 1)).toEqual(['order']);
  });

  it('lets a repeat through only while a first submit keeps a proof slot', async () => {
    const { client } = harness([], () => json({ orderId: 'o', status: 's' }));
    expect(await run(client, 'proof-repeat', 19)).toEqual(Array(19).fill('order'));
    expect(await run(client, 'proof-repeat', 1)).toEqual(['budget']);
    expect(await run(client, 'proof-first', 1)).toEqual(['order']);
  });

  it('lets a repeat through only while a first submit keeps an overall slot', async () => {
    const { client } = harness([], () => json({ orderId: 'o', status: 's' }));
    expect(await run(client, 'watcher', 28)).toEqual(Array(28).fill('order'));
    expect(await run(client, 'proof-repeat', 1)).toEqual(['order']);
    expect(await run(client, 'proof-repeat', 1)).toEqual(['budget']);
    expect(await run(client, 'proof-first', 1)).toEqual(['order']);
    expect(await run(client, 'watcher', 1)).toEqual(['budget']);
  });

  it('lets the watcher use the whole window', async () => {
    const { client } = harness([], () => json({ orderId: 'o', status: 's' }));
    expect(await run(client, 'watcher', 30)).toEqual(Array(30).fill('order'));
    expect(await run(client, 'proof-first', 1)).toEqual(['budget']);
  });

  it('pauses submits after a 429 until X-RateLimit-Reset when Retry-After is unusable', async () => {
    const { client, calls, clock } = harness([
      () =>
        err(429, 'rate_limited', { 'Retry-After': 'soon', 'X-RateLimit-Reset': String(T0 + 3000) }),
      () => json({ orderId: 'o', status: 's' }),
    ]);
    expect(await client.submit('q', 'h', 'k', 'watcher', 5000)).toEqual({
      kind: 'unresolved',
      retryable: true,
    });
    clock.t = T0 + 2999;
    expect(await client.submit('q', 'h', 'k', 'watcher', 5000)).toEqual({ kind: 'budget' });
    expect(calls).toHaveLength(1);
    clock.t = T0 + 3000;
    expect((await client.submit('q', 'h', 'k', 'watcher', 5000)).kind).toBe('order');
  });

  it('does not pause on a 429 whose reset header is not a time', async () => {
    const { client, calls } = harness([
      () => err(429, 'rate_limited', { 'X-RateLimit-Reset': 'later' }),
      () => json({ orderId: 'o', status: 's' }),
    ]);
    expect(await client.submit('q', 'h', 'k', 'watcher', 5000)).toEqual({
      kind: 'unresolved',
      retryable: true,
    });
    expect((await client.submit('q', 'h', 'k', 'watcher', 5000)).kind).toBe('order');
    expect(calls).toHaveLength(2);
  });

  it('pauses for a fractional Retry-After in seconds', async () => {
    const { client, clock } = harness([() => err(429, 'r', { 'Retry-After': '1.5' })]);
    expect(await client.submit('q', 'h', 'k', 'watcher', 5000)).toEqual({
      kind: 'unresolved',
      retryable: true,
    });
    clock.t = T0 + 1499;
    expect(await client.submit('q', 'h', 'k', 'watcher', 5000)).toEqual({ kind: 'budget' });
    clock.t = T0 + 1500;
    expect(await client.submit('q', 'h', 'k', 'watcher', 5000)).toEqual({
      kind: 'unresolved',
      retryable: false,
    });
  });
});

describe('OrchestraClient.history', () => {
  it('reads one page by address with limit 200 and maps the orders', async () => {
    const { client, calls } = harness([
      () =>
        json({
          orders: [
            {
              id: 'ord_1',
              type: 'order',
              quoteId: 'q_1',
              status: 'completed',
              sourceTxHash: '0xabc',
              recoveredFromOperationId: null,
              supersededByOperationId: 'ord_2',
            },
            { id: 'ord_3', recoveredFromOperationId: 'ord_1', quoteId: 5 },
            { id: '' },
            { quoteId: 'q' },
            'junk',
          ],
        }),
    ]);
    expect(await client.history('lnbc1 x&y', 400, 5000)).toEqual({
      ok: true,
      full: false,
      orders: [
        {
          id: 'ord_1',
          quoteId: 'q_1',
          status: 'completed',
          sourceTxHash: '0xabc',
          recoveredFromOperationId: null,
          supersededByOperationId: 'ord_2',
        },
        {
          id: 'ord_3',
          quoteId: null,
          status: '',
          sourceTxHash: null,
          recoveredFromOperationId: 'ord_1',
          supersededByOperationId: null,
        },
      ],
    });
    const url = new URL(calls[0]?.url ?? '');
    expect(`${url.origin}${url.pathname}`).toBe(`${BASE}/v1/orchestration/history`);
    expect(Object.fromEntries(url.searchParams)).toEqual({
      address: 'lnbc1 x&y',
      limit: '200',
      offset: '400',
    });
    expect(calls[0]?.init).toMatchObject({ method: 'GET', redirect: 'error' });
    expect(headersOf(calls[0])).toEqual({ Authorization: `Bearer ${KEY}` });
  });

  it('reports a page of 200 entries as full', async () => {
    const orders = Array.from({ length: 200 }, (_, i) => ({ id: `o${i}`, status: 'completed' }));
    const { client } = harness([() => json({ orders })]);
    const result = await client.history(BOLT11, 0, 5000);
    expect(result.ok && result.full).toBe(true);
  });

  it.each([400, 401, 403])('fails and alerts on HTTP %i', async (status) => {
    const { client } = harness([() => err(status, 'validation_error')]);
    expect(await client.history(BOLT11, 0, 5000)).toEqual({ ok: false, reason: 'error' });
    expect(eventsNamed('shop.alert.orchestra_request')).toEqual([
      { endpoint: 'history', status, code: 'validation_error' },
    ]);
  });

  it.each([
    ['HTTP 500', () => err(500, 'internal')],
    ['a body without orders', () => json({ items: [] })],
    ['a non-object body', () => json(null)],
    ['a timeout', () => Promise.reject(named('TimeoutError'))],
  ])('fails without an alert on %s', async (_label, responder) => {
    const { client } = harness([responder]);
    expect(await client.history(BOLT11, 0, 5000)).toEqual({ ok: false, reason: 'error' });
    expect(eventsNamed('shop.alert.orchestra_request')).toEqual([]);
  });

  it('shares 50 reads per minute with status', async () => {
    const { client, calls } = harness([], () => json({ orders: [], order: null }));
    for (let i = 0; i < 25; i += 1) {
      expect((await client.history(BOLT11, 0, 5000)).ok).toBe(true);
      expect((await client.status('ord', 5000)).ok).toBe(true);
    }
    expect(await client.history(BOLT11, 0, 5000)).toEqual({ ok: false, reason: 'budget' });
    expect(await client.status('ord', 5000)).toEqual({ ok: false, reason: 'budget' });
    expect(calls).toHaveLength(ORCHESTRA_STATUS_READS_PER_MINUTE);
    expect(eventsNamed('shop.orchestra.budget_exhausted')).toEqual([
      { endpoint: 'history' },
      { endpoint: 'status' },
    ]);
  });

  it('pauses only status after a status 429; history is still sent', async () => {
    const { client, calls, clock } = harness([
      () => err(429, 'r', { 'Retry-After': '30' }),
      () => json({ orders: [] }),
      () => json({ order: null }),
    ]);
    expect(await client.status('ord', 5000)).toEqual({ ok: false, reason: 'error' });
    expect(await client.status('ord', 5000)).toEqual({ ok: false, reason: 'budget' });
    expect(await client.history(BOLT11, 0, 5000)).toEqual({ ok: true, orders: [], full: false });
    expect(calls.map((call) => new URL(call.url).pathname)).toEqual([
      '/v1/orchestration/status',
      '/v1/orchestration/history',
    ]);
    clock.t = T0 + 30_000;
    expect(await client.status('ord', 5000)).toEqual({ ok: true, order: null });
    expect(calls).toHaveLength(3);
  });

  it('pauses only history after a history 429; status is still sent', async () => {
    const { client, calls } = harness([
      () => err(429, 'r', { 'Retry-After': '30' }),
      () => json({ order: null }),
    ]);
    expect(await client.history(BOLT11, 0, 5000)).toEqual({ ok: false, reason: 'error' });
    expect(await client.history(BOLT11, 0, 5000)).toEqual({ ok: false, reason: 'budget' });
    expect(await client.status('ord', 5000)).toEqual({ ok: true, order: null });
    expect(calls.map((call) => new URL(call.url).pathname)).toEqual([
      '/v1/orchestration/history',
      '/v1/orchestration/status',
    ]);
  });

  it('still counts both paused and unpaused reads against the shared budget', async () => {
    const { client, calls } = harness([() => err(429, 'r', { 'Retry-After': '30' })], () =>
      json({ orders: [] }),
    );
    await client.status('ord', 5000);
    for (let i = 1; i < ORCHESTRA_STATUS_READS_PER_MINUTE; i += 1) {
      expect((await client.history(BOLT11, 0, 5000)).ok).toBe(true);
    }
    expect(await client.history(BOLT11, 0, 5000)).toEqual({ ok: false, reason: 'budget' });
    expect(calls).toHaveLength(ORCHESTRA_STATUS_READS_PER_MINUTE);
  });
});

describe('OrchestraClient.status', () => {
  it('reads by id and maps the order', async () => {
    const { client, calls } = harness([
      () =>
        json({
          order: {
            id: 'ord_1',
            quoteId: 'q_1',
            status: 'unfulfilled',
            supersededByOperationId: 'ord_9',
          },
          stages: [],
        }),
    ]);
    expect(await client.status('ord_1', 5000)).toEqual({
      ok: true,
      order: {
        id: 'ord_1',
        quoteId: 'q_1',
        status: 'unfulfilled',
        sourceTxHash: null,
        recoveredFromOperationId: null,
        supersededByOperationId: 'ord_9',
      },
    });
    expect(calls[0]?.url).toBe(`${BASE}/v1/orchestration/status?id=ord_1`);
    expect(headersOf(calls[0])).toEqual({ Authorization: `Bearer ${KEY}` });
  });

  it('answers no order for 404 not_found without an error log', async () => {
    const { client } = harness([() => err(404, 'not_found')]);
    expect(await client.status('ord_x', 5000)).toEqual({ ok: true, order: null });
    expect(events()).toEqual([]);
  });

  it('answers no order for a null order', async () => {
    const { client } = harness([() => json({ order: null, stages: [] })]);
    expect(await client.status('ord_x', 5000)).toEqual({ ok: true, order: null });
  });

  it.each([401, 403, 400])('fails and alerts on HTTP %i', async (status) => {
    const { client } = harness([() => err(status, 'unauthorized')]);
    expect(await client.status('ord', 5000)).toEqual({ ok: false, reason: 'error' });
    expect(eventsNamed('shop.alert.orchestra_request')).toEqual([
      { endpoint: 'status', status, code: 'unauthorized' },
    ]);
    expect(eventsNamed('shop.orchestra.error')).toEqual([{ endpoint: 'status', status }]);
  });

  it.each([
    ['404 with another code', () => err(404, 'route_not_found')],
    ['HTTP 503', () => err(503, 'x')],
    ['a body without order', () => json({ stages: [] })],
    ['a non-object body', () => json([1])],
    ['an order without id', () => json({ order: { status: 'completed' } })],
    [
      'an unreadable body',
      () =>
        ({
          status: 200,
          headers: new Headers(),
          text: () => Promise.reject(new Error('reset')),
        }) as unknown as Response,
    ],
    ['a thrown non-Error', () => Promise.reject('boom')],
  ])('fails on %s', async (_label, responder) => {
    const { client } = harness([responder]);
    expect(await client.status('ord', 5000)).toEqual({ ok: false, reason: 'error' });
    expect(eventsNamed('shop.alert.orchestra_request')).toEqual([]);
  });

  it('logs a 404 with another code as an error', async () => {
    const { client } = harness([() => err(404, 'route_not_found')]);
    await client.status('ord', 5000);
    expect(eventsNamed('shop.orchestra.error')).toEqual([{ endpoint: 'status', status: 404 }]);
  });

  it('logs neither the key nor the address', async () => {
    const { client } = harness([], () => err(401, 'unauthorized'));
    await client.history(BOLT11, 0, 5000);
    await client.submit('q', 'h', 'k', 'watcher', 5000);
    const lines = warn.mock.calls.map((args) => String(args[0])).join('\n');
    expect(lines).not.toContain(KEY);
    expect(lines).not.toContain(BOLT11);
    expect(lines).not.toContain(BASE);
  });
});
