import { describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_BTC_USD_CANDLES_URL,
  fetchDailyCloses,
  parseCoinbaseCandles,
  resolveCandlesUrl,
  type FetchFn,
} from '@/lib/btc-usd-candles';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('resolveCandlesUrl', () => {
  it('returns the Coinbase default when unset or blank', () => {
    expect(resolveCandlesUrl({})).toBe(DEFAULT_BTC_USD_CANDLES_URL);
    expect(resolveCandlesUrl({ BTC_USD_CANDLES_URL: '' })).toBe(DEFAULT_BTC_USD_CANDLES_URL);
    expect(resolveCandlesUrl({ BTC_USD_CANDLES_URL: '   ' })).toBe(DEFAULT_BTC_USD_CANDLES_URL);
  });

  it('trims an explicit override', () => {
    expect(resolveCandlesUrl({ BTC_USD_CANDLES_URL: ' https://example.test/candles ' })).toBe(
      'https://example.test/candles',
    );
  });
});

describe('parseCoinbaseCandles', () => {
  it('maps valid rows and skips bad shape or non-positive close', () => {
    const dayMs = Date.parse('2026-06-01T00:00:00.000Z') / 1000;
    const parsed = parseCoinbaseCandles([
      [dayMs, 1, 2, 3, 95000.12, 10],
      [dayMs + 86_400, 1, 2, 3, 0, 10],
      [dayMs + 172_800, 1, 2, 3, -1, 10],
      'not-a-row',
      [dayMs],
      [NaN, 1, 2, 3, 1, 1],
      [-1, 1, 2, 3, 1, 1],
      [dayMs + 259_200, 1, 2, 3, Number.POSITIVE_INFINITY, 1],
    ]);
    expect(parsed).toEqual([{ day: '2026-06-01', usdPerBtc: '95000.12' }]);
  });

  it('throws when the body is not an array', () => {
    expect(() => parseCoinbaseCandles({ candles: [] })).toThrow(/expected array/);
  });
});

describe('fetchDailyCloses', () => {
  it('GETs with granularity, User-Agent, and parses closes', async () => {
    const dayMs = Date.parse('2026-06-01T00:00:00.000Z') / 1000;
    let seenUrl = '';
    let seenUa = '';
    const fetchImpl: FetchFn = async (input, init) => {
      seenUrl = String(input);
      seenUa = new Headers(init?.headers).get('User-Agent') ?? '';
      return jsonResponse([[dayMs, 1, 2, 3, 100000, 1]]);
    };

    const closes = await fetchDailyCloses({
      fetchImpl,
      url: DEFAULT_BTC_USD_CANDLES_URL,
      fromDay: '2026-06-01',
      toDay: '2026-06-01',
    });

    expect(closes).toEqual([{ day: '2026-06-01', usdPerBtc: '100000' }]);
    expect(seenUa).toBe('21.gifts-api');
    const url = new URL(seenUrl);
    expect(url.searchParams.get('granularity')).toBe('86400');
    expect(url.searchParams.get('start')).toBe('2026-06-01T00:00:00.000Z');
    expect(url.searchParams.get('end')).toBe('2026-06-01T00:00:00.000Z');
  });

  it('chunks ranges longer than 300 days', async () => {
    const calls: string[] = [];
    const fetchImpl: FetchFn = async (input) => {
      calls.push(String(input));
      return jsonResponse([]);
    };

    await fetchDailyCloses({
      fetchImpl,
      url: 'https://example.test/candles',
      fromDay: '2024-01-01',
      toDay: '2024-12-31', // 366 days → 2 chunks
    });

    expect(calls).toHaveLength(2);
    expect(new URL(calls[0] ?? '').searchParams.get('start')).toBe('2024-01-01T00:00:00.000Z');
    expect(new URL(calls[0] ?? '').searchParams.get('end')).toBe('2024-10-26T00:00:00.000Z');
    expect(new URL(calls[1] ?? '').searchParams.get('start')).toBe('2024-10-27T00:00:00.000Z');
    expect(new URL(calls[1] ?? '').searchParams.get('end')).toBe('2024-12-31T00:00:00.000Z');
  });

  it('throws on non-OK HTTP', async () => {
    const fetchImpl: FetchFn = async () => jsonResponse({ message: 'nope' }, 500);
    await expect(
      fetchDailyCloses({
        fetchImpl,
        url: DEFAULT_BTC_USD_CANDLES_URL,
        fromDay: '2026-06-01',
        toDay: '2026-06-01',
      }),
    ).rejects.toThrow(/HTTP 500/);
  });

  it('throws on invalid JSON', async () => {
    const fetchImpl: FetchFn = async () =>
      new Response('not-json', { status: 200, headers: { 'content-type': 'application/json' } });
    await expect(
      fetchDailyCloses({
        fetchImpl,
        url: DEFAULT_BTC_USD_CANDLES_URL,
        fromDay: '2026-06-01',
        toDay: '2026-06-01',
      }),
    ).rejects.toThrow(/invalid JSON/);
  });

  it('throws on an invalid day range', async () => {
    const fetchImpl = vi.fn<FetchFn>();
    await expect(
      fetchDailyCloses({
        fetchImpl,
        url: DEFAULT_BTC_USD_CANDLES_URL,
        fromDay: '2026-06-02',
        toDay: '2026-06-01',
      }),
    ).rejects.toThrow(/invalid day range/);
    await expect(
      fetchDailyCloses({
        fetchImpl,
        url: DEFAULT_BTC_USD_CANDLES_URL,
        fromDay: 'not-a-day',
        toDay: '2026-06-01',
      }),
    ).rejects.toThrow(/invalid day range/);
    await expect(
      fetchDailyCloses({
        fetchImpl,
        url: DEFAULT_BTC_USD_CANDLES_URL,
        fromDay: '2026-02-30',
        toDay: '2026-03-01',
      }),
    ).rejects.toThrow(/invalid day range/);
    await expect(
      fetchDailyCloses({
        fetchImpl,
        url: DEFAULT_BTC_USD_CANDLES_URL,
        fromDay: '2026-13-01',
        toDay: '2026-13-01',
      }),
    ).rejects.toThrow(/invalid day range/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('honors an explicit timeoutMs via AbortSignal', async () => {
    const fetchImpl: FetchFn = async (_input, init) => {
      expect(init?.signal).toBeDefined();
      return jsonResponse([]);
    };
    await fetchDailyCloses({
      fetchImpl,
      url: DEFAULT_BTC_USD_CANDLES_URL,
      fromDay: '2026-06-01',
      toDay: '2026-06-01',
      timeoutMs: 1_000,
    });
  });
});
