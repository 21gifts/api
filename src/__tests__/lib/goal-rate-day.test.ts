import { describe, expect, it, vi } from 'vitest';
import { buildGiftStats, type GiftRow } from '@/lib/gift';
import { InMemoryBtcUsdStore } from '@/lib/btc-usd-store';
import { InMemoryFiatStore } from '@/lib/usd-fiat-store';
import { InMemoryGiftStore } from '@/lib/gift-store';
import { bindGoalRateDay, loadLatestGoalRateDay } from '@/routes/stats';

const priced = (day: string, sats: number): GiftRow => ({
  paidAt: new Date(`${day}T12:00:00.000Z`),
  amountSats: sats,
  kind: 'daily',
  recipientWosUser: 'ada',
  amountUsd: '1.00',
  amountChf: '0.90',
  amountEur: '0.80',
  amountPhp: '50.00',
});

describe('loadLatestGoalRateDay', () => {
  it('binds the same loader createApp passes to messages', async () => {
    const day = await bindGoalRateDay({
      store: new InMemoryGiftStore(),
      rates: new InMemoryBtcUsdStore(),
      fiatRates: new InMemoryFiatStore(),
      now: () => Date.parse('2026-06-04T00:00:00.000Z'),
    })();
    expect(day).toBeNull();
  });

  it('returns null when there are no gifts', async () => {
    const day = await loadLatestGoalRateDay({
      store: new InMemoryGiftStore(),
      rates: new InMemoryBtcUsdStore(),
      fiatRates: new InMemoryFiatStore(),
      now: () => Date.parse('2026-06-04T00:00:00.000Z'),
    });
    expect(day).toBeNull();
  });

  it('uses the last day with sats greater than zero', async () => {
    const day = await loadLatestGoalRateDay({
      store: new InMemoryGiftStore([priced('2026-06-01', 1000), priced('2026-06-03', 0)]),
      rates: new InMemoryBtcUsdStore(),
      fiatRates: new InMemoryFiatStore(),
      now: () => Date.parse('2026-06-04T00:00:00.000Z'),
    });
    expect(day).toEqual({
      sats: 1000,
      usd: '1.00',
      chf: '0.90',
      eur: '0.80',
      php: '50.00',
    });
  });

  it('returns null fiat for a legacy day that stored only sats', async () => {
    const legacy: GiftRow = {
      paidAt: new Date('2026-06-01T12:00:00.000Z'),
      amountSats: 1000,
      kind: 'daily',
      recipientWosUser: 'ada',
    };
    const day = await loadLatestGoalRateDay({
      store: new InMemoryGiftStore([legacy]),
      rates: new InMemoryBtcUsdStore(),
      fiatRates: new InMemoryFiatStore(),
      now: () => Date.parse('2026-06-01T00:00:00.000Z'),
    });
    expect(day).toEqual({
      sats: 1000,
      usd: null,
      chf: null,
      eur: null,
      php: null,
    });
  });

  it('keeps the day when the fiat book throws', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const legacy: GiftRow = {
        paidAt: new Date('2026-06-01T12:00:00.000Z'),
        amountSats: 1000,
        kind: 'daily',
        recipientWosUser: 'ada',
      };
      const day = await loadLatestGoalRateDay({
        store: new InMemoryGiftStore([legacy]),
        rates: new InMemoryBtcUsdStore({ '2026-06-01': '100000' }),
        fiatRates: {
          ensureDays: async () => {
            throw new Error('frankfurter down');
          },
        },
        now: () => Date.parse('2026-06-01T00:00:00.000Z'),
      });
      expect(day?.sats).toBe(1000);
      expect(day?.usd).toBeNull();
      expect(day?.chf).toBeNull();
      expect(day?.eur).toBeNull();
      expect(day?.php).toBeNull();
    } finally {
      warn.mockRestore();
    }
  });

  it('nulls every currency when each gift stored a different one', async () => {
    const day = await loadLatestGoalRateDay({
      store: new InMemoryGiftStore(SPLIT_USD_CHF),
      rates: new InMemoryBtcUsdStore(),
      fiatRates: new InMemoryFiatStore(),
      now: () => Date.parse('2026-06-04T00:00:00.000Z'),
    });
    expect(day).toEqual({
      sats: 2000,
      usd: null,
      chf: null,
      eur: null,
      php: null,
    });
  });

  it('keeps a currency only when every gift that day stored a string', async () => {
    const day = await loadLatestGoalRateDay({
      store: new InMemoryGiftStore([
        gift('2026-06-02', 1000, { amountUsd: '1.00', amountChf: '0.90' }),
        gift('2026-06-02', 1000, { amountUsd: '2.00', amountChf: '0.10' }),
      ]),
      rates: new InMemoryBtcUsdStore(),
      fiatRates: new InMemoryFiatStore(),
      now: () => Date.parse('2026-06-04T00:00:00.000Z'),
    });
    expect(day).toEqual({
      sats: 2000,
      usd: '3.00',
      chf: '1.00',
      eur: null,
      php: null,
    });
  });

  it('nulls only the currency a sibling gift omitted', async () => {
    const day = await loadLatestGoalRateDay({
      store: new InMemoryGiftStore([
        priced('2026-06-02', 1000),
        gift('2026-06-02', 1000, { amountUsd: '1.00', amountChf: '0.90', amountEur: '0.80' }),
      ]),
      rates: new InMemoryBtcUsdStore(),
      fiatRates: new InMemoryFiatStore(),
      now: () => Date.parse('2026-06-04T00:00:00.000Z'),
    });
    expect(day).toEqual({
      sats: 2000,
      usd: '2.00',
      chf: '1.80',
      eur: '1.60',
      php: null,
    });
  });

  it('uses the later legacy day instead of an earlier complete day', async () => {
    const legacy: GiftRow = {
      paidAt: new Date('2026-06-02T12:00:00.000Z'),
      amountSats: 1000,
      kind: 'daily',
      recipientWosUser: 'ada',
    };
    const day = await loadLatestGoalRateDay({
      store: new InMemoryGiftStore([priced('2026-06-01', 1000), legacy]),
      rates: new InMemoryBtcUsdStore(),
      fiatRates: new InMemoryFiatStore(),
      now: () => Date.parse('2026-06-04T00:00:00.000Z'),
    });
    expect(day).toEqual({
      sats: 1000,
      usd: null,
      chf: null,
      eur: null,
      php: null,
    });
  });

  it('counts a zero-sat gift on that day as lacking every currency string', async () => {
    const zero: GiftRow = {
      paidAt: new Date('2026-06-02T18:00:00.000Z'),
      amountSats: 0,
      kind: 'daily',
      recipientWosUser: 'ada',
    };
    const day = await loadLatestGoalRateDay({
      store: new InMemoryGiftStore([priced('2026-06-02', 1000), zero]),
      rates: new InMemoryBtcUsdStore(),
      fiatRates: new InMemoryFiatStore(),
      now: () => Date.parse('2026-06-04T00:00:00.000Z'),
    });
    expect(day).toEqual({
      sats: 1000,
      usd: null,
      chf: null,
      eur: null,
      php: null,
    });
  });

  it('keeps the public partial sum while the ask rate is null', async () => {
    expect(buildGiftStats(SPLIT_USD_CHF, new Map()).spendOverTime).toMatchObject([
      {
        day: '2026-06-02',
        sats: 2000,
        usd: '1.00',
        chf: '0.90',
        eur: null,
        php: null,
      },
    ]);
    const day = await loadLatestGoalRateDay({
      store: new InMemoryGiftStore(SPLIT_USD_CHF),
      rates: new InMemoryBtcUsdStore(),
      fiatRates: new InMemoryFiatStore(),
      now: () => Date.parse('2026-06-04T00:00:00.000Z'),
    });
    expect(day).toEqual({
      sats: 2000,
      usd: null,
      chf: null,
      eur: null,
      php: null,
    });
  });
});

const SPLIT_USD_CHF: GiftRow[] = [
  gift('2026-06-02', 1000, { amountUsd: '1.00' }),
  gift('2026-06-02', 1000, { amountChf: '0.90' }),
];

function gift(
  day: string,
  sats: number,
  fiat: {
    amountUsd?: string;
    amountChf?: string;
    amountEur?: string;
    amountPhp?: string;
  },
): GiftRow {
  const row: GiftRow = {
    paidAt: new Date(`${day}T12:00:00.000Z`),
    amountSats: sats,
    kind: 'daily',
    recipientWosUser: 'ada',
  };
  if (typeof fiat.amountUsd === 'string') {
    row.amountUsd = fiat.amountUsd;
  }
  if (typeof fiat.amountChf === 'string') {
    row.amountChf = fiat.amountChf;
  }
  if (typeof fiat.amountEur === 'string') {
    row.amountEur = fiat.amountEur;
  }
  if (typeof fiat.amountPhp === 'string') {
    row.amountPhp = fiat.amountPhp;
  }
  return row;
}
