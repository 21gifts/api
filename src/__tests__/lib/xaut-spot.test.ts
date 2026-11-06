import { afterEach, describe, expect, it, vi } from 'vitest';
import { BTC_USD_SPOT_TIMEOUT_MS } from '@/lib/btc-usd-spot';
import { FX_SPOT_REFRESH_MS } from '@/lib/fx-spot';
import { fetchXautSpot, startXautSpotWorker } from '@/lib/xaut-spot';

const good = { error: [], result: { XAUTUSD: { c: ['2000.25', '1'] } } };
const response = (body: unknown, ok = true): Response =>
  ({ ok, json: async () => body }) as Response;
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('fetchXautSpot', () => {
  it('uses the Kraken last price and a ten second timeout', async () => {
    const timeout = vi.spyOn(AbortSignal, 'timeout');
    const fetchImpl = vi.fn(async () => response(good));
    expect(await fetchXautSpot({ url: 'https://example.test', fetchImpl, now: () => 123 })).toEqual(
      { rate: '2000.25', asOfMs: 123 },
    );
    expect(timeout).toHaveBeenCalledWith(BTC_USD_SPOT_TIMEOUT_MS);
    expect(fetchImpl).toHaveBeenCalledWith('https://example.test', {
      signal: expect.any(AbortSignal),
    });
  });
  it.each([
    [response(good, false)],
    [response({ error: ['bad'], result: good.result })],
    [response({ error: [], result: { pair: {} } })],
    [response({ error: [], result: { pair: { c: ['0', '1'] } } })],
    [response({ error: [], result: {} })],
    [response({ error: [], result: { a: {}, b: {} } })],
    [response({ error: [], result: { pair: null } })],
    [response({ error: [], result: { pair: [] } })],
    [response({ error: [], result: { pair: 'invalid' } })],
    [response(null)],
  ])('rejects malformed and unsuccessful responses', async (answer) => {
    expect(
      await fetchXautSpot({ url: 'x', fetchImpl: async () => answer, now: () => 1 }),
    ).toBeNull();
  });
  it('returns null when fetch times out', async () => {
    expect(
      await fetchXautSpot({
        url: 'x',
        fetchImpl: async () => {
          throw new DOMException('timeout', 'TimeoutError');
        },
        now: () => 1,
      }),
    ).toBeNull();
  });
  it('rejects a non-finite fetch time without requesting a price', async () => {
    const fetchImpl = vi.fn(async () => response(good));
    expect(await fetchXautSpot({ url: 'x', fetchImpl, now: () => Number.NaN })).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('startXautSpotWorker', () => {
  it('keeps the last good quote on failure and stops refreshing', async () => {
    vi.useFakeTimers();
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(response(good))
      .mockResolvedValue(response(good, false));
    const worker = startXautSpotWorker({ url: 'x', fetchImpl, now: () => 123 });
    await vi.waitFor(() => expect(worker.latest()).toEqual({ rate: '2000.25', asOfMs: 123 }));
    await vi.advanceTimersByTimeAsync(FX_SPOT_REFRESH_MS);
    expect(worker.latest()).toEqual({ rate: '2000.25', asOfMs: 123 });
    worker.stop();
    await vi.advanceTimersByTimeAsync(FX_SPOT_REFRESH_MS);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
  it('does not overlap a still-pending fetch with the next tick', async () => {
    vi.useFakeTimers();
    let resolveFetch!: (value: Response) => void;
    const fetchImpl = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          resolveFetch = resolve;
        }),
    );
    const worker = startXautSpotWorker({ url: 'x', fetchImpl, now: () => 123 });
    await vi.advanceTimersByTimeAsync(FX_SPOT_REFRESH_MS);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(worker.latest()).toBeNull();
    resolveFetch(response(good));
    await vi.waitFor(() => expect(worker.latest()?.rate).toBe('2000.25'));
    await vi.advanceTimersByTimeAsync(FX_SPOT_REFRESH_MS);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    worker.stop();
  });
});
