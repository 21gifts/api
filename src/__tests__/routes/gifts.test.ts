import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { GiftRow } from '@/lib/gift';
import { InMemoryBtcUsdStore } from '@/lib/btc-usd-store';
import { InMemoryFiatStore } from '@/lib/usd-fiat-store';
import { InMemoryGiftStore } from '@/lib/gift-store';
import { giftsRoutes } from '@/routes/gifts';
import { createApp } from '@/server';

function parsedEvents(warn: ReturnType<typeof vi.spyOn>): Array<Record<string, unknown>> {
  const events: Array<Record<string, unknown>> = [];
  for (const call of warn.mock.calls) {
    const arg = call[0];
    if (typeof arg === 'string' && arg.startsWith('{')) {
      events.push(JSON.parse(arg) as Record<string, unknown>);
    }
  }
  return events;
}

const ALICE: GiftRow = {
  paidAt: new Date('2026-06-01T12:00:00.000Z'),
  amountSats: 1000,
  recipientWosUser: 'alice',
};

const BOB: GiftRow = {
  paidAt: new Date('2026-06-01T08:00:00.000Z'),
  amountSats: 500,
  recipientWosUser: 'bob',
};

const OTHER_DAY: GiftRow = {
  paidAt: new Date('2026-06-02T12:00:00.000Z'),
  amountSats: 2000,
  recipientWosUser: 'carol',
};

const EMPTY_DAY = {
  day: '2026-06-01',
  giftCount: 0,
  totalSats: 0,
  totalBtc: '0.00000000',
  totalUsd: '0.00',
  totalChf: '0.00',
  totalEur: '0.00',
  totalPhp: '0.00',
  gifts: [],
  fx: {
    quote: 'BTC-USD',
    dayBasis: 'utc',
    source: 'coinbase-exchange-daily-close',
    quotes: [{ code: 'USD', pair: 'BTC-USD', source: 'coinbase-exchange-daily-close' }],
  },
};

describe('GET /gifts', () => {
  let warn: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    warn.mockRestore();
  });

  it('uses default rates and clock when omitted', async () => {
    const res = await giftsRoutes({ store: new InMemoryGiftStore() }).request('/?day=2026-06-01');
    expect(res.status).toBe(200);
    expect(((await res.json()) as { giftCount: number }).giftCount).toBe(0);
  });

  it('returns 400 when day is missing', async () => {
    const res = await createApp().request('/gifts');
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'Expected a UTC day (YYYY-MM-DD)' });
  });

  it('returns 400 when day is not a real UTC date', async () => {
    const res = await createApp().request('/gifts?day=2026-02-31');
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'Expected a UTC day (YYYY-MM-DD)' });
  });

  it('returns an empty day from the default store', async () => {
    const res = await createApp().request('/gifts?day=2026-06-01');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(EMPTY_DAY);
  });

  it('lists gifts on that UTC day ordered by paidAt then recipient', async () => {
    const res = await createApp({
      giftStore: new InMemoryGiftStore([ALICE, OTHER_DAY, BOB]),
      btcUsdRates: new InMemoryBtcUsdStore({ '2026-06-01': '100000' }),
    }).request('/gifts?day=2026-06-01');
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      giftCount: number;
      totalSats: number;
      gifts: Array<{ recipient: string; paidAt: string; amountSats: number }>;
    };
    expect(body.giftCount).toBe(2);
    expect(body.totalSats).toBe(1500);
    expect(body.gifts.map((g) => g.recipient)).toEqual(['bob', 'alice']);
    expect(body.gifts[0]?.paidAt).toBe('2026-06-01T08:00:00.000Z');
    expect(body.gifts[0]?.amountSats).toBe(500);
  });

  it('returns 503 when a listed gift day has no rate', async () => {
    const res = await createApp({
      giftStore: new InMemoryGiftStore([ALICE]),
      btcUsdRates: new InMemoryBtcUsdStore(),
    }).request('/gifts?day=2026-06-01');
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'Gift stats are unavailable' });
    expect(parsedEvents(warn).some((e) => e['event'] === 'gifts.day.fx_incomplete')).toBe(true);
  });

  it('returns 503 when the store throws', async () => {
    const giftStore = {
      listOutbound: async () => {
        throw new Error('db');
      },
    };
    const res = await createApp({ giftStore }).request('/gifts?day=2026-06-01');
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'Gift stats are unavailable' });
    expect(parsedEvents(warn).some((e) => e['event'] === 'gifts.day.failed')).toBe(true);
  });

  it('converts CHF/EUR/PHP from a seeded fiat book', async () => {
    const res = await createApp({
      giftStore: new InMemoryGiftStore([ALICE]),
      btcUsdRates: new InMemoryBtcUsdStore({ '2026-06-01': '100000' }),
      fiatRates: new InMemoryFiatStore({
        '2026-06-01': { CHF: '0.80', EUR: '0.90', PHP: '50' },
      }),
    }).request('/gifts?day=2026-06-01');
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      totalUsd: string;
      totalChf: string | null;
      totalEur: string | null;
      totalPhp: string | null;
    };
    expect(body.totalUsd).toBe('1.00');
    expect(body.totalChf).toBe('0.80');
    expect(body.totalEur).toBe('0.90');
    expect(body.totalPhp).toBe('50.00');
  });

  it('returns 200 with null fiat totals when fiat ensureDays throws', async () => {
    const fiatRates = {
      ensureDays: async () => {
        throw new Error('frankfurter down');
      },
    };
    const res = await createApp({
      giftStore: new InMemoryGiftStore([ALICE]),
      btcUsdRates: new InMemoryBtcUsdStore({ '2026-06-01': '100000' }),
      fiatRates,
    }).request('/gifts?day=2026-06-01');
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      totalUsd: string;
      totalChf: string | null;
      totalEur: string | null;
      totalPhp: string | null;
    };
    expect(body.totalUsd).toBe('1.00');
    expect(body.totalChf).toBeNull();
    expect(body.totalEur).toBeNull();
    expect(body.totalPhp).toBeNull();
    expect(parsedEvents(warn).some((e) => e['event'] === 'gifts.day.fiat_failed')).toBe(true);
  });

  it('does not call fiat ensureDays for an empty day', async () => {
    const ensureDays = vi.fn(async () => new Map());
    const res = await createApp({
      giftStore: new InMemoryGiftStore(),
      fiatRates: { ensureDays },
    }).request('/gifts?day=2026-06-01');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(EMPTY_DAY);
    expect(ensureDays).not.toHaveBeenCalled();
  });
});
