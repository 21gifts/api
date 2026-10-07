import { afterEach, describe, expect, it, vi } from 'vitest';
import { BTC_USD_SPOT_TIMEOUT_MS } from '@/lib/btc-usd-spot';
import {
  FX_SPOT_REFRESH_MS,
  FX_SPOT_SOURCE_COINBASE,
  fetchFxSpot,
  resolveFxSpotUrl,
  runFxSpotTick,
  startFxSpotWorker,
} from '@/lib/fx-spot';
import { InMemoryFxSpotStore, type FxSpotStore } from '@/lib/fx-spot-store';

const NOW = Date.parse('2026-10-07T12:00:00.000Z');
const URL = 'https://rates.example/v2/exchange-rates?currency=BTC';

function response(body: unknown, ok = true): Response {
  return { ok, json: async () => body } as Response;
}

function coinbase(rates: Record<string, unknown>, currency: unknown = 'BTC'): unknown {
  return { data: { currency, rates } };
}

function eventsOf(warn: ReturnType<typeof vi.spyOn>): string[] {
  return warn.mock.calls.map((call) => {
    try {
      return String((JSON.parse(String(call[0])) as { event?: unknown }).event);
    } catch {
      return '';
    }
  });
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('resolveFxSpotUrl', () => {
  it('defaults to the Coinbase exchange-rates URL when unset or blank', () => {
    expect(resolveFxSpotUrl({})).toBe('https://api.coinbase.com/v2/exchange-rates?currency=BTC');
    expect(resolveFxSpotUrl({ BTC_FIAT_SPOT_URL: '  ' })).toBe(
      'https://api.coinbase.com/v2/exchange-rates?currency=BTC',
    );
  });

  it('uses a trimmed override', () => {
    expect(resolveFxSpotUrl({ BTC_FIAT_SPOT_URL: ` ${URL} ` })).toBe(URL);
  });
});

describe('fetchFxSpot', () => {
  it('keeps the four fiats from one response with a timeout signal', async () => {
    const fetchImpl = vi.fn(async (_input: unknown, _init?: RequestInit) =>
      response(
        coinbase({
          USD: '62345.12',
          CHF: '55000.5',
          EUR: 57000,
          PHP: '3500000.123456789',
          JPY: '9000000',
        }),
      ),
    );
    const timeout = vi.spyOn(AbortSignal, 'timeout');
    await expect(fetchFxSpot({ fetchImpl, url: URL, now: () => NOW })).resolves.toEqual({
      asOf: '2026-10-07T12:00:00.000Z',
      source: FX_SPOT_SOURCE_COINBASE,
      rates: { USD: '62345.12', CHF: '55000.5', EUR: '57000', PHP: '3500000.123456789' },
    });
    expect(fetchImpl).toHaveBeenCalledWith(
      URL,
      expect.objectContaining({ signal: expect.anything() }),
    );
    expect(timeout).toHaveBeenCalledWith(BTC_USD_SPOT_TIMEOUT_MS);
  });

  it('stamps asOf with the time the request started', async () => {
    let clock = NOW;
    const fetchImpl = vi.fn(async () => {
      clock += 4_000;
      return response(coinbase({ USD: '1' }));
    });
    const quote = await fetchFxSpot({ fetchImpl, url: URL, now: () => clock });
    expect(quote?.asOf).toBe('2026-10-07T12:00:00.000Z');
  });

  it('returns null for a clock that throws or is not a time', async () => {
    const fetchImpl = vi.fn(async () => response(coinbase({ USD: '1' })));
    const broken = (): number => {
      throw new Error('clock');
    };
    await expect(fetchFxSpot({ fetchImpl, url: URL, now: broken })).resolves.toBeNull();
    await expect(fetchFxSpot({ fetchImpl, url: URL, now: () => Number.NaN })).resolves.toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('omits a currency whose rate is missing or unusable', async () => {
    const fetchImpl = vi.fn(async () =>
      response(coinbase({ USD: '62345.12', CHF: '0', EUR: '-1', PHP: '1e5' })),
    );
    await expect(fetchFxSpot({ fetchImpl, url: URL, now: () => NOW })).resolves.toEqual({
      asOf: '2026-10-07T12:00:00.000Z',
      source: FX_SPOT_SOURCE_COINBASE,
      rates: { USD: '62345.12' },
    });
  });

  it.each([
    ['no usable rate', coinbase({ USD: true, CHF: null, EUR: 'abc', PHP: Number.NaN })],
    ['another base currency', coinbase({ USD: '1' }, 'USD')],
    ['rates not an object', { data: { currency: 'BTC', rates: null } }],
    ['rates missing', { data: { currency: 'BTC' } }],
    ['data not an object', { data: 'x' }],
    ['data missing', {}],
    ['a null body', null],
    ['a string body', 'x'],
  ])('returns null for %s', async (_label, body) => {
    const fetchImpl = vi.fn(async () => response(body));
    await expect(fetchFxSpot({ fetchImpl, url: URL, now: () => NOW })).resolves.toBeNull();
  });

  it('returns null for a non-ok response', async () => {
    const fetchImpl = vi.fn(async () => response(coinbase({ USD: '1' }), false));
    await expect(fetchFxSpot({ fetchImpl, url: URL, now: () => NOW })).resolves.toBeNull();
  });

  it('returns null when fetch throws or times out', async () => {
    const offline = vi.fn(async () => {
      throw new Error('offline');
    });
    const aborted = vi.fn(async () => {
      throw new DOMException('The operation was aborted.', 'TimeoutError');
    });
    await expect(fetchFxSpot({ fetchImpl: offline, url: URL, now: () => NOW })).resolves.toBeNull();
    await expect(fetchFxSpot({ fetchImpl: aborted, url: URL, now: () => NOW })).resolves.toBeNull();
  });
});

describe('runFxSpotTick', () => {
  it('stores a fetched quote', async () => {
    const store = new InMemoryFxSpotStore();
    const fetchImpl = vi.fn(async () => response(coinbase({ USD: '62345.12' })));
    await expect(runFxSpotTick({ store, fetchImpl, url: URL, now: () => NOW })).resolves.toBe(true);
    await expect(store.latest()).resolves.toEqual({
      asOf: '2026-10-07T12:00:00.000Z',
      source: FX_SPOT_SOURCE_COINBASE,
      rates: { USD: '62345.12' },
    });
  });

  it('keeps the last good quote when the fetch fails', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const kept = {
      asOf: '2026-10-07T11:55:00.000Z',
      source: FX_SPOT_SOURCE_COINBASE,
      rates: { USD: '62000' },
    };
    const store = new InMemoryFxSpotStore(kept);
    const fetchImpl = vi.fn(async () => response({}, false));
    await expect(runFxSpotTick({ store, fetchImpl, url: URL, now: () => NOW })).resolves.toBe(
      false,
    );
    await expect(store.latest()).resolves.toEqual(kept);
    expect(eventsOf(warn)).toContain('fx.spot.fetch_failed');
  });

  it('throws when the store write fails', async () => {
    const store: FxSpotStore = {
      latest: async () => null,
      save: async () => {
        throw new Error('db down');
      },
    };
    const fetchImpl = vi.fn(async () => response(coinbase({ USD: '1' })));
    await expect(runFxSpotTick({ store, fetchImpl, url: URL, now: () => NOW })).rejects.toThrow(
      'db down',
    );
  });
});

describe('startFxSpotWorker', () => {
  it('refreshes every five minutes by default and stops', async () => {
    vi.useFakeTimers();
    const store = new InMemoryFxSpotStore();
    let price = 100;
    const fetchImpl = vi.fn(async () => {
      price += 1;
      return response(coinbase({ USD: String(price) }));
    });
    const worker = startFxSpotWorker({ store, fetchImpl, url: URL, now: () => NOW });
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect((await store.latest())?.rates.USD).toBe('101');
    await vi.advanceTimersByTimeAsync(FX_SPOT_REFRESH_MS);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect((await store.latest())?.rates.USD).toBe('102');
    worker.stop();
    await vi.advanceTimersByTimeAsync(FX_SPOT_REFRESH_MS * 3);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('skips a tick while one is still running', async () => {
    vi.useFakeTimers();
    let release: (value: Response) => void = () => undefined;
    const fetchImpl = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          release = resolve;
        }),
    );
    const store = new InMemoryFxSpotStore();
    const worker = startFxSpotWorker({ store, fetchImpl, url: URL, now: () => NOW }, 1_000);
    await vi.advanceTimersByTimeAsync(3_000);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    release(response(coinbase({ USD: '5' })));
    await vi.advanceTimersByTimeAsync(1_000);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    worker.stop();
  });

  it('logs a failing tick and retries on the next interval', async () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const store: FxSpotStore = {
      latest: async () => null,
      save: async () => {
        throw new Error('db down');
      },
    };
    const fetchImpl = vi.fn(async () => response(coinbase({ USD: '1' })));
    const worker = startFxSpotWorker({ store, fetchImpl, url: URL, now: () => NOW }, 1_000);
    await vi.advanceTimersByTimeAsync(0);
    expect(eventsOf(warn)).toContain('fx.spot.tick.failed');
    await vi.advanceTimersByTimeAsync(1_000);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    worker.stop();
  });
});
