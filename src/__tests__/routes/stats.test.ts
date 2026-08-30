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

const BOB_GIFT: GiftRow = {
  paidAt: new Date('2026-06-03T12:00:00.000Z'),
  amountSats: 2000,
  recipientWosUser: 'bob',
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

  it('treats missing or whitespace-only recipient as unfiltered', async () => {
    const app = createApp({
      giftStore: new InMemoryGiftStore([GIFT, BOB_GIFT]),
      btcUsdRates: new InMemoryBtcUsdStore({
        '2026-06-01': '100000',
        '2026-06-03': '100000',
      }),
    });
    const missing = await app.request('/gifts/stats');
    const blank = await app.request('/gifts/stats?recipient=');
    const spaces = await app.request('/gifts/stats?recipient=%20%20');
    expect(missing.status).toBe(200);
    expect(blank.status).toBe(200);
    expect(spaces.status).toBe(200);
    const missingBody = (await missing.json()) as { giftCount: number; totalSats: number };
    const blankBody = (await blank.json()) as { giftCount: number; totalSats: number };
    const spacesBody = (await spaces.json()) as { giftCount: number; totalSats: number };
    expect(missingBody.giftCount).toBe(2);
    expect(missingBody.totalSats).toBe(3000);
    expect(blankBody.giftCount).toBe(2);
    expect(blankBody.totalSats).toBe(3000);
    expect(spacesBody.giftCount).toBe(2);
    expect(spacesBody.totalSats).toBe(3000);
  });

  it('filters stats to one recipient handle case-insensitively', async () => {
    const res = await createApp({
      giftStore: new InMemoryGiftStore([GIFT, BOB_GIFT]),
      btcUsdRates: new InMemoryBtcUsdStore({
        '2026-06-01': '100000',
        '2026-06-03': '100000',
      }),
    }).request('/gifts/stats?recipient=Alice');
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      giftCount: number;
      totalSats: number;
      recipientCount: number;
      byRecipient: Array<{ recipient: string }>;
      spendOverTime: Array<{ day: string; sats: number }>;
    };
    expect(body.giftCount).toBe(1);
    expect(body.totalSats).toBe(1000);
    expect(body.recipientCount).toBe(1);
    expect(body.byRecipient.map((r) => r.recipient)).toEqual(['alice']);
    expect(body.spendOverTime).toEqual([
      expect.objectContaining({ day: '2026-06-01', sats: 1000 }),
    ]);
  });

  it('accepts a Lightning Address local-part as recipient', async () => {
    const res = await createApp({
      giftStore: new InMemoryGiftStore([GIFT, BOB_GIFT]),
      btcUsdRates: new InMemoryBtcUsdStore({
        '2026-06-01': '100000',
        '2026-06-03': '100000',
      }),
    }).request('/gifts/stats?recipient=alice@walletofsatoshi.com');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { giftCount: number; totalSats: number };
    expect(body.giftCount).toBe(1);
    expect(body.totalSats).toBe(1000);
  });

  it('returns empty stats without ensureDays when recipient matches nothing', async () => {
    const ensureDays = vi.fn(async () => new Map<string, string>());
    const res = await createApp({
      giftStore: new InMemoryGiftStore([GIFT, BOB_GIFT]),
      btcUsdRates: { ensureDays },
    }).request('/gifts/stats?recipient=carol');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(EMPTY_STATS);
    expect(ensureDays).not.toHaveBeenCalled();
  });

  it('does not match @alice against handle alice', async () => {
    const ensureDays = vi.fn(async () => new Map<string, string>());
    const res = await createApp({
      giftStore: new InMemoryGiftStore([GIFT]),
      btcUsdRates: { ensureDays },
    }).request('/gifts/stats?recipient=%40alice');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(EMPTY_STATS);
    expect(ensureDays).not.toHaveBeenCalled();
  });

  it('ensures rates only for the selected recipient days', async () => {
    const res = await createApp({
      giftStore: new InMemoryGiftStore([GIFT, BOB_GIFT]),
      btcUsdRates: new InMemoryBtcUsdStore({ '2026-06-01': '100000' }),
    }).request('/gifts/stats?recipient=alice');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { giftCount: number; totalSats: number };
    expect(body.giftCount).toBe(1);
    expect(body.totalSats).toBe(1000);
  });
});
