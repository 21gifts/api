import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchBtcUsdSpot, BTC_USD_SPOT_TIMEOUT_MS } from '@/lib/btc-usd-spot';

function response(body: unknown, ok = true): Response {
  return { ok, json: async () => body } as Response;
}

describe('fetchBtcUsdSpot', () => {
  const original = process.env['BTC_USD_SPOT_URL'];

  afterEach(() => {
    if (original === undefined) delete process.env['BTC_USD_SPOT_URL'];
    else process.env['BTC_USD_SPOT_URL'] = original;
  });

  it('accepts a positive string amount', async () => {
    const fetchImpl = vi.fn(async () => response({ data: { amount: '100000.25' } }));
    await expect(fetchBtcUsdSpot(fetchImpl)).resolves.toBe('100000.25');
  });

  it('accepts a positive numeric amount', async () => {
    const fetchImpl = vi.fn(async () => response({ data: { amount: 100000 } }));
    await expect(fetchBtcUsdSpot(fetchImpl)).resolves.toBe('100000');
  });

  it.each([0, -1, Number.POSITIVE_INFINITY])('rejects %s', async (amount) => {
    const fetchImpl = vi.fn(async () => response({ data: { amount } }));
    await expect(fetchBtcUsdSpot(fetchImpl)).resolves.toBeNull();
  });

  it.each([{}, { data: null }, { data: {} }, { data: { amount: true } }])(
    'rejects a bad shape',
    async (body) => {
      const fetchImpl = vi.fn(async () => response(body));
      await expect(fetchBtcUsdSpot(fetchImpl)).resolves.toBeNull();
    },
  );

  it('returns null for a non-ok response', async () => {
    const fetchImpl = vi.fn(async () => response({}, false));
    await expect(fetchBtcUsdSpot(fetchImpl)).resolves.toBeNull();
  });

  it('returns null when fetch throws', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('offline');
    });
    await expect(fetchBtcUsdSpot(fetchImpl)).resolves.toBeNull();
  });

  it('returns null when fetch times out', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new DOMException('The operation was aborted.', 'TimeoutError');
    });
    await expect(fetchBtcUsdSpot(fetchImpl)).resolves.toBeNull();
  });

  it('prefers the explicit URL', async () => {
    process.env['BTC_USD_SPOT_URL'] = 'https://env.example/spot';
    const fetchImpl = vi.fn(async () => response({ data: { amount: '1' } }));
    await fetchBtcUsdSpot(fetchImpl, ' https://explicit.example/spot ');
    expect(fetchImpl).toHaveBeenCalledWith('https://explicit.example/spot', {
      signal: expect.any(AbortSignal),
    });
  });

  it('uses BTC_USD_SPOT_URL', async () => {
    process.env['BTC_USD_SPOT_URL'] = ' https://env.example/spot ';
    const fetchImpl = vi.fn(async () => response({ data: { amount: '1' } }));
    await fetchBtcUsdSpot(fetchImpl);
    expect(fetchImpl).toHaveBeenCalledWith('https://env.example/spot', {
      signal: expect.any(AbortSignal),
    });
  });

  it('uses Coinbase when BTC_USD_SPOT_URL is blank', async () => {
    process.env['BTC_USD_SPOT_URL'] = '   ';
    const fetchImpl = vi.fn(async () => response({ data: { amount: '1' } }));
    await fetchBtcUsdSpot(fetchImpl);
    expect(fetchImpl).toHaveBeenCalledWith('https://api.coinbase.com/v2/prices/BTC-USD/spot', {
      signal: expect.any(AbortSignal),
    });
  });

  it('uses AbortSignal.timeout of BTC_USD_SPOT_TIMEOUT_MS', async () => {
    const timeoutSpy = vi.spyOn(AbortSignal, 'timeout');
    const fetchImpl = vi.fn(async () => response({ data: { amount: '100000.25' } }));
    await fetchBtcUsdSpot(fetchImpl);
    expect(timeoutSpy).toHaveBeenCalledWith(BTC_USD_SPOT_TIMEOUT_MS);
    expect(BTC_USD_SPOT_TIMEOUT_MS).toBe(10_000);
    timeoutSpy.mockRestore();
  });

  it('resolves a hanging fetch via the abort signal to null', async () => {
    const timeoutSpy = vi
      .spyOn(AbortSignal, 'timeout')
      .mockReturnValue(
        AbortSignal.abort(new DOMException('The operation timed out.', 'TimeoutError')),
      );
    try {
      const fetchImpl = vi.fn(
        (_input: string | URL | Request, init?: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            const signal = init?.signal;
            if (signal?.aborted) {
              reject(signal.reason);
              return;
            }
            signal?.addEventListener('abort', () => reject(signal.reason));
          }),
      );
      await expect(fetchBtcUsdSpot(fetchImpl)).resolves.toBeNull();
    } finally {
      timeoutSpy.mockRestore();
    }
  });
});
