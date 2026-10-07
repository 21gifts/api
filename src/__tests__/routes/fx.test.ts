import { afterEach, describe, expect, it, vi } from 'vitest';
import { InMemoryFxSpotStore, type FxSpotStore } from '@/lib/fx-spot-store';
import { fxRoutes } from '@/routes/fx';
import { createApp } from '@/server';

const QUOTE = {
  asOf: '2026-10-07T12:00:00.000Z',
  source: 'coinbase-exchange-rates',
  rates: { USD: '62345.12', CHF: '55000.5', EUR: '57000', PHP: '3500000.12' },
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe('GET /fx/spot', () => {
  it('returns the stored quote with a public cache header', async () => {
    const app = fxRoutes({ store: new InMemoryFxSpotStore(QUOTE) });
    const res = await app.request('/spot');
    expect(res.status).toBe(200);
    expect(res.headers.get('Cache-Control')).toBe('public, max-age=60');
    expect(await res.json()).toEqual(QUOTE);
  });

  it('omits a currency without a quote', async () => {
    const app = fxRoutes({ store: new InMemoryFxSpotStore({ ...QUOTE, rates: { USD: '1' } }) });
    expect(await (await app.request('/spot')).json()).toEqual({ ...QUOTE, rates: { USD: '1' } });
  });

  it('answers an empty result when no quote was ever stored', async () => {
    const app = fxRoutes({ store: new InMemoryFxSpotStore() });
    const res = await app.request('/spot');
    expect(res.status).toBe(200);
    expect(res.headers.get('Cache-Control')).toBe('no-store');
    expect(await res.json()).toEqual({ asOf: null, source: null, rates: {} });
  });

  it('answers the empty result and logs when the store throws', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const store: FxSpotStore = {
      latest: async () => {
        throw new Error('db down');
      },
      save: async () => undefined,
    };
    const res = await fxRoutes({ store }).request('/spot');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ asOf: null, source: null, rates: {} });
    expect(warn.mock.calls.some((call) => String(call[0]).includes('fx.spot.read_failed'))).toBe(
      true,
    );
  });

  it('is mounted publicly at /fx/spot by createApp', async () => {
    const app = createApp({ fxSpotStore: new InMemoryFxSpotStore(QUOTE) });
    const res = await app.request('/fx/spot');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(QUOTE);
  });

  it('defaults to an empty store in createApp', async () => {
    const res = await createApp({}).request('/fx/spot');
    expect(await res.json()).toEqual({ asOf: null, source: null, rates: {} });
  });
});
