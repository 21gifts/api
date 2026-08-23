import { describe, it, expect } from 'vitest';
import { fetchKrakenXbtUsd, usdToSats, type FetchFn } from '@/lib/btc-usd-rate';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function ticker(price: string | number, error: unknown = []): unknown {
  return {
    error,
    result: {
      XXBTZUSD: {
        c: [price, '1'],
      },
    },
  };
}

describe('usdToSats', () => {
  it('rounds usd / rate * 1e8', () => {
    expect(usdToSats(1, 50_000)).toBe(2000);
    expect(usdToSats(2.5, 100_000)).toBe(2500);
  });
});

describe('fetchKrakenXbtUsd', () => {
  it('returns the last trade price inside the corridor', async () => {
    const fetchImpl: FetchFn = async () => jsonResponse(ticker('65000.5'));
    const result = await fetchKrakenXbtUsd({
      fetchImpl,
      minUsd: 10_000,
      maxUsd: 200_000,
    });
    expect(result).toEqual({ ok: true, usdPerBtc: 65000.5 });
  });

  it('accepts numeric close price and missing error field', async () => {
    const fetchImpl: FetchFn = async () =>
      jsonResponse({
        result: { XXBTZUSD: { c: [70000] } },
      });
    const result = await fetchKrakenXbtUsd({
      fetchImpl,
      minUsd: 10_000,
      maxUsd: 200_000,
    });
    expect(result).toEqual({ ok: true, usdPerBtc: 70000 });
  });

  it('returns implausible when outside corridor', async () => {
    const fetchImpl: FetchFn = async () => jsonResponse(ticker('500'));
    const result = await fetchKrakenXbtUsd({
      fetchImpl,
      minUsd: 10_000,
      maxUsd: 200_000,
    });
    expect(result).toEqual({ ok: false, reason: 'implausible' });
  });

  it('returns unavailable on network error', async () => {
    const fetchImpl: FetchFn = async () => {
      throw new Error('down');
    };
    const result = await fetchKrakenXbtUsd({
      fetchImpl,
      minUsd: 1,
      maxUsd: 1_000_000,
    });
    expect(result).toEqual({ ok: false, reason: 'unavailable' });
  });

  it('returns unavailable on non-OK HTTP', async () => {
    const fetchImpl: FetchFn = async () => jsonResponse({}, 500);
    const result = await fetchKrakenXbtUsd({
      fetchImpl,
      minUsd: 1,
      maxUsd: 1_000_000,
    });
    expect(result).toEqual({ ok: false, reason: 'unavailable' });
  });

  it('returns unavailable on bad JSON', async () => {
    const fetchImpl: FetchFn = async () => new Response('nope', { status: 200 });
    const result = await fetchKrakenXbtUsd({
      fetchImpl,
      minUsd: 1,
      maxUsd: 1_000_000,
    });
    expect(result).toEqual({ ok: false, reason: 'unavailable' });
  });

  it('returns unavailable on schema failures', async () => {
    const cases: unknown[] = [
      null,
      { error: ['x'] },
      { error: [], result: null },
      { error: [], result: {} },
      { error: [], result: { XXBTZUSD: null } },
      { error: [], result: { XXBTZUSD: { c: [] } } },
      { error: [], result: { XXBTZUSD: { c: [true] } } },
      { error: [], result: { XXBTZUSD: { c: ['0'] } } },
      { error: [], result: { XXBTZUSD: { c: ['-1'] } } },
    ];
    for (const body of cases) {
      const fetchImpl: FetchFn = async () => jsonResponse(body);
      const result = await fetchKrakenXbtUsd({
        fetchImpl,
        minUsd: 1,
        maxUsd: 1_000_000,
      });
      expect(result).toEqual({ ok: false, reason: 'unavailable' });
    }
  });

  it('passes a 15s abort signal', async () => {
    let signal: AbortSignal | undefined;
    const fetchImpl: FetchFn = async (_input, init) => {
      signal = init?.signal ?? undefined;
      return jsonResponse(ticker(60_000));
    };
    await fetchKrakenXbtUsd({ fetchImpl, minUsd: 1, maxUsd: 1_000_000 });
    expect(signal).toBeDefined();
  });
});
