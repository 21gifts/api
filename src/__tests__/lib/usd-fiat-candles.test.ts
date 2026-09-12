import { describe, expect, it, vi } from 'vitest';
import type { FetchFn } from '@/lib/btc-usd-candles';
import {
  DEFAULT_FRANKFURTER_RATES_URL,
  fetchFiatRates,
  parseFrankfurterRates,
  resolveFrankfurterUrl,
} from '@/lib/usd-fiat-candles';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('resolveFrankfurterUrl', () => {
  it('returns the Frankfurter ECB default when unset or blank', () => {
    expect(resolveFrankfurterUrl({})).toBe(DEFAULT_FRANKFURTER_RATES_URL);
    expect(resolveFrankfurterUrl({ FRANKFURTER_RATES_URL: '' })).toBe(
      DEFAULT_FRANKFURTER_RATES_URL,
    );
    expect(resolveFrankfurterUrl({ FRANKFURTER_RATES_URL: '   ' })).toBe(
      DEFAULT_FRANKFURTER_RATES_URL,
    );
  });

  it('trims an explicit override', () => {
    expect(resolveFrankfurterUrl({ FRANKFURTER_RATES_URL: ' https://example.test/rates ' })).toBe(
      'https://example.test/rates',
    );
  });
});

describe('parseFrankfurterRates', () => {
  it('maps USD+CHF/EUR/PHP finite positive rates and skips bad rows', () => {
    const parsed = parseFrankfurterRates([
      { date: '2026-06-01', base: 'USD', quote: 'CHF', rate: 0.8 },
      { date: '2026-06-01', base: 'usd', quote: 'eur', rate: 0.9 },
      { date: '2026-06-01', base: 'Usd', quote: 'php', rate: 50 },
      { date: '2026-06-01', base: 'USD', quote: 'GBP', rate: 0.7 },
      { date: '2026-06-01', base: 'EUR', quote: 'CHF', rate: 0.8 },
      { date: '2026-02-30', base: 'USD', quote: 'CHF', rate: 0.8 },
      { date: 'not-a-day', base: 'USD', quote: 'CHF', rate: 0.8 },
      { date: 20260601, base: 'USD', quote: 'CHF', rate: 0.8 },
      { date: '2026-06-01', base: 'USD', quote: 'CHF', rate: 0 },
      { date: '2026-06-01', base: 'USD', quote: 'CHF', rate: -1 },
      { date: '2026-06-01', base: 'USD', quote: 'CHF', rate: Number.POSITIVE_INFINITY },
      { date: '2026-06-01', base: 'USD', quote: 'CHF', rate: Number.NaN },
      { date: '2026-06-01', base: 'USD', quote: 'CHF', rate: '0.8' },
      { date: '2026-06-01', base: 'USD', quote: 1, rate: 0.8 },
      { date: '2026-06-01', base: 1, quote: 'CHF', rate: 0.8 },
      null,
      'not-a-row',
      ['2026-06-01', 'USD', 'CHF', 0.8],
      12,
    ]);
    expect(parsed).toEqual([
      { day: '2026-06-01', quote: 'CHF', rate: '0.8' },
      { day: '2026-06-01', quote: 'EUR', rate: '0.9' },
      { day: '2026-06-01', quote: 'PHP', rate: '50' },
    ]);
  });

  it('throws when the body is not an array', () => {
    expect(() => parseFrankfurterRates({ rates: [] })).toThrow('frankfurter rates: expected array');
    expect(() => parseFrankfurterRates(null)).toThrow('frankfurter rates: expected array');
  });
});

describe('fetchFiatRates', () => {
  it('GETs with base, quotes, from, to, User-Agent, and parses rates', async () => {
    let seenUrl = '';
    let seenUa = '';
    let seenSignal: AbortSignal | undefined;
    const fetchImpl: FetchFn = async (input, init) => {
      seenUrl = String(input);
      seenUa = new Headers(init?.headers).get('User-Agent') ?? '';
      seenSignal = init?.signal ?? undefined;
      return jsonResponse([
        { date: '2026-06-01', base: 'USD', quote: 'CHF', rate: 0.8 },
        { date: '2026-06-01', base: 'USD', quote: 'EUR', rate: 0.9 },
        { date: '2026-06-01', base: 'USD', quote: 'PHP', rate: 50 },
      ]);
    };

    const candles = await fetchFiatRates({
      fetchImpl,
      url: DEFAULT_FRANKFURTER_RATES_URL,
      fromDay: '2026-06-01',
      toDay: '2026-06-01',
    });

    expect(candles).toEqual([
      { day: '2026-06-01', quote: 'CHF', rate: '0.8' },
      { day: '2026-06-01', quote: 'EUR', rate: '0.9' },
      { day: '2026-06-01', quote: 'PHP', rate: '50' },
    ]);
    expect(seenUa).toBe('21.gifts-api');
    expect(seenSignal).toBeDefined();
    const url = new URL(seenUrl);
    expect(url.origin + url.pathname).toBe(new URL(DEFAULT_FRANKFURTER_RATES_URL).toString());
    expect(url.searchParams.get('base')).toBe('usd');
    expect(url.searchParams.get('quotes')).toBe('chf,eur,php');
    expect(url.searchParams.get('from')).toBe('2026-06-01');
    expect(url.searchParams.get('to')).toBe('2026-06-01');
  });

  it('chunks ranges longer than 300 days', async () => {
    const calls: string[] = [];
    const fetchImpl: FetchFn = async (input) => {
      calls.push(String(input));
      return jsonResponse([]);
    };

    await fetchFiatRates({
      fetchImpl,
      url: 'https://example.test/rates',
      fromDay: '2024-01-01',
      toDay: '2024-12-31', // 366 days → 2 chunks
    });

    expect(calls).toHaveLength(2);
    expect(new URL(calls[0] ?? '').searchParams.get('from')).toBe('2024-01-01');
    expect(new URL(calls[0] ?? '').searchParams.get('to')).toBe('2024-10-26');
    expect(new URL(calls[1] ?? '').searchParams.get('from')).toBe('2024-10-27');
    expect(new URL(calls[1] ?? '').searchParams.get('to')).toBe('2024-12-31');
  });

  it('throws on non-OK HTTP', async () => {
    const fetchImpl: FetchFn = async () => jsonResponse({ message: 'nope' }, 500);
    await expect(
      fetchFiatRates({
        fetchImpl,
        url: DEFAULT_FRANKFURTER_RATES_URL,
        fromDay: '2026-06-01',
        toDay: '2026-06-01',
      }),
    ).rejects.toThrow('frankfurter rates: HTTP 500');
  });

  it('throws on invalid JSON', async () => {
    const fetchImpl: FetchFn = async () =>
      new Response('not-json', { status: 200, headers: { 'content-type': 'application/json' } });
    await expect(
      fetchFiatRates({
        fetchImpl,
        url: DEFAULT_FRANKFURTER_RATES_URL,
        fromDay: '2026-06-01',
        toDay: '2026-06-01',
      }),
    ).rejects.toThrow('frankfurter rates: invalid JSON');
  });

  it('throws on an invalid or inverted day range', async () => {
    const fetchImpl = vi.fn<FetchFn>();
    await expect(
      fetchFiatRates({
        fetchImpl,
        url: DEFAULT_FRANKFURTER_RATES_URL,
        fromDay: '2026-06-02',
        toDay: '2026-06-01',
      }),
    ).rejects.toThrow('frankfurter rates: invalid day range');
    await expect(
      fetchFiatRates({
        fetchImpl,
        url: DEFAULT_FRANKFURTER_RATES_URL,
        fromDay: 'not-a-day',
        toDay: '2026-06-01',
      }),
    ).rejects.toThrow('frankfurter rates: invalid day range');
    await expect(
      fetchFiatRates({
        fetchImpl,
        url: DEFAULT_FRANKFURTER_RATES_URL,
        fromDay: '2026-02-30',
        toDay: '2026-03-01',
      }),
    ).rejects.toThrow('frankfurter rates: invalid day range');
    await expect(
      fetchFiatRates({
        fetchImpl,
        url: DEFAULT_FRANKFURTER_RATES_URL,
        fromDay: '2026-13-01',
        toDay: '2026-13-01',
      }),
    ).rejects.toThrow('frankfurter rates: invalid day range');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('honors an explicit timeoutMs via AbortSignal', async () => {
    const fetchImpl: FetchFn = async (_input, init) => {
      expect(init?.signal).toBeDefined();
      return jsonResponse([]);
    };
    await fetchFiatRates({
      fetchImpl,
      url: DEFAULT_FRANKFURTER_RATES_URL,
      fromDay: '2026-06-01',
      toDay: '2026-06-01',
      timeoutMs: 1_000,
    });
  });
});
