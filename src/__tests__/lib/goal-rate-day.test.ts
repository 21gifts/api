import { describe, expect, it, vi } from 'vitest';
import type { GiftRow } from '@/lib/gift';
import { InMemoryBtcUsdStore } from '@/lib/btc-usd-store';
import { InMemoryFiatStore } from '@/lib/usd-fiat-store';
import { InMemoryGiftStore } from '@/lib/gift-store';
import { bindGoalRateDay, loadLatestGoalRateDay } from '@/routes/stats';

const priced = (day: string, sats: number): GiftRow => ({
  paidAt: new Date(`${day}T12:00:00.000Z`),
  amountSats: sats,
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

  it('throws when a legacy day has no BTC-USD rate', async () => {
    const legacy: GiftRow = {
      paidAt: new Date('2026-06-01T12:00:00.000Z'),
      amountSats: 1000,
      recipientWosUser: 'ada',
    };
    await expect(
      loadLatestGoalRateDay({
        store: new InMemoryGiftStore([legacy]),
        rates: new InMemoryBtcUsdStore(),
        fiatRates: new InMemoryFiatStore(),
        now: () => Date.parse('2026-06-01T00:00:00.000Z'),
      }),
    ).rejects.toThrow('fx.rate.missing');
  });

  it('keeps the day when the fiat book throws', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const legacy: GiftRow = {
        paidAt: new Date('2026-06-01T12:00:00.000Z'),
        amountSats: 1000,
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
      expect(day?.usd).toBe('1.00');
      expect(day?.chf).toBeNull();
      expect(day?.eur).toBeNull();
      expect(day?.php).toBeNull();
    } finally {
      warn.mockRestore();
    }
  });
});
