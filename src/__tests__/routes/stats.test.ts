import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { GiftRow } from '@/lib/gift';
import { InMemoryBtcUsdStore } from '@/lib/btc-usd-store';
import { InMemoryGiftStore, type GiftStore } from '@/lib/gift-store';
import { giftsStatsRoutes } from '@/routes/stats';
import { createApp } from '@/server';

function parsedEvents(warn: ReturnType<typeof vi.spyOn>): Array<Record<string, unknown>> {
  return warn.mock.calls
    .map((call) => call[0])
    .filter((arg): arg is string => typeof arg === 'string' && arg.startsWith('{'))
    .map((arg) => JSON.parse(arg) as Record<string, unknown>);
}

const GIFT: GiftRow = {
  paidAt: new Date('2026-06-01T12:00:00.000Z'),
  amountSats: 1000,
  recipientWosUser: 'alice',
};

const EMPTY_STATS = {
  totalSats: 0,
  totalBtc: '0.00000000',
  totalUsd: '0.00',
  giftCount: 0,
  recipientCount: 0,
  firstPaidAt: null,
  lastPaidAt: null,
  spendOverTime: [],
  byRecipient: [],
  byMonth: [],
  fx: {
    quote: 'BTC-USD',
    dayBasis: 'utc',
    source: 'coinbase-exchange-daily-close',
  },
};

describe('GET /gifts/stats', () => {
  let warn: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    warn.mockRestore();
  });

  it('returns empty stats from the default store without calling rates', async () => {
    const res = await createApp().request('/gifts/stats');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(EMPTY_STATS);
  });

  it('aggregates gifts when rates cover every gift day', async () => {
    const res = await createApp({
      giftStore: new InMemoryGiftStore([GIFT]),
      btcUsdRates: new InMemoryBtcUsdStore({ '2026-06-01': '100000' }),
    }).request('/gifts/stats');
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      giftCount: number;
      totalSats: number;
      totalBtc: string;
      totalUsd: string;
    };
    expect(body.giftCount).toBe(1);
    expect(body.totalSats).toBe(1000);
    expect(body.totalBtc).toBe('0.00001000');
    expect(body.totalUsd).toBe('1.00');
  });

  it('returns 503 when a gift day has no rate after ensureDays', async () => {
    const res = await createApp({
      giftStore: new InMemoryGiftStore([GIFT]),
      btcUsdRates: new InMemoryBtcUsdStore(),
    }).request('/gifts/stats');
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'Gift stats are unavailable' });
    expect(parsedEvents(warn).some((e) => e['event'] === 'gifts.stats.fx_incomplete')).toBe(true);
  });

  it('returns 503 when the store throws', async () => {
    const giftStore: GiftStore = {
      listOutbound: async () => {
        throw new Error('db down');
      },
    };
    const res = await createApp({ giftStore }).request('/gifts/stats');
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'Gift stats are unavailable' });
    expect(parsedEvents(warn).some((e) => e['event'] === 'gifts.stats.failed')).toBe(true);
  });

  it('returns 503 when ensureDays throws', async () => {
    const rates = {
      ensureDays: async () => {
        throw new Error('upstream down');
      },
    };
    const res = await createApp({
      giftStore: new InMemoryGiftStore([GIFT]),
      btcUsdRates: rates,
    }).request('/gifts/stats');
    expect(res.status).toBe(503);
    expect(parsedEvents(warn).some((e) => e['event'] === 'gifts.stats.failed')).toBe(true);
  });

  it('defaults rates and clock when the route factory omits them', async () => {
    const app = giftsStatsRoutes({ store: new InMemoryGiftStore() });
    const res = await app.request('/');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(EMPTY_STATS);
  });
});
