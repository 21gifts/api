import { describe, expect, it } from 'vitest';
import {
  buildGiftDay,
  buildGiftStats,
  giftsForRecipient,
  isUtcDay,
  mapGiftQueryRow,
  utcDayFromPaidAt,
  type GiftRow,
} from '@/lib/gift';

function row(paidAt: string, amountSats: number, recipientWosUser: string): GiftRow {
  return { paidAt: new Date(paidAt), amountSats, recipientWosUser };
}

const FX = {
  quote: 'BTC-USD' as const,
  dayBasis: 'utc' as const,
  source: 'coinbase-exchange-daily-close' as const,
};

const RATE_100K = new Map([['2026-06-01', '100000']]);

describe('mapGiftQueryRow', () => {
  it('keeps a Date paid_at and coerces amount', () => {
    const paidAt = new Date('2026-06-01T12:00:00.000Z');
    expect(
      mapGiftQueryRow({
        paid_at: paidAt,
        amount_sats: 21,
        recipient_wos_user: 'alice',
      }),
    ).toEqual({ paidAt, amountSats: 21, recipientWosUser: 'alice' });
  });

  it('parses string paid_at and bigint amount_sats', () => {
    const mapped = mapGiftQueryRow({
      paid_at: '2026-06-01T12:00:00.000Z',
      amount_sats: 42n,
      recipient_wos_user: 'bob',
    });
    expect(mapped.paidAt.toISOString()).toBe('2026-06-01T12:00:00.000Z');
    expect(mapped.amountSats).toBe(42);
    expect(mapped.recipientWosUser).toBe('bob');
  });
});

describe('giftsForRecipient', () => {
  const alice = row('2026-06-01T12:00:00.000Z', 1000, 'alice');
  const aliceCaps = row('2026-06-02T12:00:00.000Z', 500, 'Alice');
  const bob = row('2026-06-03T12:00:00.000Z', 2000, 'bob');
  const rows = [alice, aliceCaps, bob];

  it('returns [] for empty or whitespace-only recipient (never all gifts)', () => {
    expect(giftsForRecipient(rows, '')).toEqual([]);
    expect(giftsForRecipient(rows, '   ')).toEqual([]);
  });

  it('matches a handle case-insensitively and preserves order', () => {
    expect(giftsForRecipient(rows, 'alice')).toEqual([alice, aliceCaps]);
    expect(giftsForRecipient(rows, 'ALICE')).toEqual([alice, aliceCaps]);
  });

  it('uses the local-part when indexOf("@") > 0', () => {
    expect(giftsForRecipient(rows, 'alice@walletofsatoshi.com')).toEqual([alice, aliceCaps]);
  });

  it('uses the whole string when "@" is at index 0', () => {
    expect(giftsForRecipient(rows, '@alice')).toEqual([]);
    expect(giftsForRecipient([row('2026-06-01T00:00:00.000Z', 1, '@alice')], '@alice')).toEqual([
      row('2026-06-01T00:00:00.000Z', 1, '@alice'),
    ]);
  });

  it('returns [] when no handle matches', () => {
    expect(giftsForRecipient(rows, 'carol')).toEqual([]);
  });
});

describe('buildGiftStats', () => {
  it('returns zeros, empty series, and fx for no gifts (no rates required)', () => {
    expect(buildGiftStats([], new Map())).toEqual({
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
      fx: FX,
    });
  });

  it('aggregates a single day with BTC and USD', () => {
    const stats = buildGiftStats([row('2026-06-01T15:00:00.000Z', 1000, 'alice')], RATE_100K);
    expect(stats.totalSats).toBe(1000);
    expect(stats.totalBtc).toBe('0.00001000');
    expect(stats.totalUsd).toBe('1.00');
    expect(stats.giftCount).toBe(1);
    expect(stats.recipientCount).toBe(1);
    expect(stats.firstPaidAt).toBe('2026-06-01T15:00:00.000Z');
    expect(stats.lastPaidAt).toBe('2026-06-01T15:00:00.000Z');
    expect(stats.spendOverTime).toEqual([
      {
        day: '2026-06-01',
        sats: 1000,
        cumulativeSats: 1000,
        btc: '0.00001000',
        cumulativeBtc: '0.00001000',
        usd: '1.00',
        cumulativeUsd: '1.00',
      },
    ]);
    expect(stats.byRecipient).toEqual([
      { recipient: 'alice', giftCount: 1, sats: 1000, btc: '0.00001000', usd: '1.00' },
    ]);
    expect(stats.byMonth).toEqual([
      { month: '2026-06', giftCount: 1, sats: 1000, btc: '0.00001000', usd: '1.00' },
    ]);
    expect(stats.fx).toEqual(FX);
  });

  it('fills UTC gap days with zero spend without requiring a rate', () => {
    const rates = new Map([
      ['2026-06-01', '100000'],
      ['2026-06-03', '200000'],
    ]);
    const stats = buildGiftStats(
      [row('2026-06-03T01:00:00.000Z', 30, 'bob'), row('2026-06-01T23:00:00.000Z', 10, 'alice')],
      rates,
    );
    expect(stats.spendOverTime).toEqual([
      {
        day: '2026-06-01',
        sats: 10,
        cumulativeSats: 10,
        btc: '0.00000010',
        cumulativeBtc: '0.00000010',
        usd: '0.01',
        cumulativeUsd: '0.01',
      },
      {
        day: '2026-06-02',
        sats: 0,
        cumulativeSats: 10,
        btc: '0.00000000',
        cumulativeBtc: '0.00000010',
        usd: '0.00',
        cumulativeUsd: '0.01',
      },
      {
        day: '2026-06-03',
        sats: 30,
        cumulativeSats: 40,
        btc: '0.00000030',
        cumulativeBtc: '0.00000040',
        usd: '0.06',
        cumulativeUsd: '0.07',
      },
    ]);
    expect(stats.totalSats).toBe(40);
    expect(stats.totalUsd).toBe('0.07');
    expect(stats.giftCount).toBe(2);
  });

  it('throws fx.rate.missing when a gift day has no rate', () => {
    expect(() =>
      buildGiftStats([row('2026-06-01T15:00:00.000Z', 1000, 'alice')], new Map()),
    ).toThrow('fx.rate.missing');
  });

  it('sorts recipients by sats descending then name', () => {
    const stats = buildGiftStats(
      [
        row('2026-06-01T00:00:00.000Z', 50, 'zeta'),
        row('2026-06-01T01:00:00.000Z', 50, 'alpha'),
        row('2026-06-01T02:00:00.000Z', 80, 'mid'),
      ],
      RATE_100K,
    );
    expect(stats.byRecipient.map((r) => r.recipient)).toEqual(['mid', 'alpha', 'zeta']);
    expect(stats.recipientCount).toBe(3);
  });

  it('groups months chronologically with BTC and USD', () => {
    const rates = new Map([
      ['2026-06-30', '100000'],
      ['2026-07-02', '100000'],
    ]);
    const stats = buildGiftStats(
      [row('2026-07-02T00:00:00.000Z', 5, 'a'), row('2026-06-30T00:00:00.000Z', 7, 'a')],
      rates,
    );
    expect(stats.byMonth).toEqual([
      { month: '2026-06', giftCount: 1, sats: 7, btc: '0.00000007', usd: '0.01' },
      { month: '2026-07', giftCount: 1, sats: 5, btc: '0.00000005', usd: '0.01' },
    ]);
  });

  it('fills UTC gap months with zero spend without requiring a rate', () => {
    const rates = new Map([
      ['2026-01-27', '100000'],
      ['2026-05-01', '100000'],
    ]);
    const stats = buildGiftStats(
      [
        row('2026-01-27T12:00:00.000Z', 1000, 'alice'),
        row('2026-05-01T00:00:00.000Z', 2000, 'bob'),
      ],
      rates,
    );
    expect(stats.byMonth).toEqual([
      { month: '2026-01', giftCount: 1, sats: 1000, btc: '0.00001000', usd: '1.00' },
      { month: '2026-02', giftCount: 0, sats: 0, btc: '0.00000000', usd: '0.00' },
      { month: '2026-03', giftCount: 0, sats: 0, btc: '0.00000000', usd: '0.00' },
      { month: '2026-04', giftCount: 0, sats: 0, btc: '0.00000000', usd: '0.00' },
      { month: '2026-05', giftCount: 1, sats: 2000, btc: '0.00002000', usd: '2.00' },
    ]);
  });
});

describe('isUtcDay', () => {
  it('accepts a real UTC calendar day', () => {
    expect(isUtcDay('2026-08-24')).toBe(true);
  });

  it('rejects non-dates and impossible calendar days', () => {
    expect(isUtcDay('2026-02-31')).toBe(false);
    expect(isUtcDay('foo')).toBe(false);
    expect(isUtcDay('2026-13-01')).toBe(false);
  });
});

describe('utcDayFromPaidAt', () => {
  it('returns the UTC calendar day', () => {
    expect(utcDayFromPaidAt(new Date('2026-08-24T12:03:56.405Z'))).toBe('2026-08-24');
  });
});

describe('buildGiftDay', () => {
  it('returns zeros without rates when no gifts fall on that day', () => {
    expect(
      buildGiftDay('2026-06-01', [row('2026-06-02T00:00:00.000Z', 10, 'alice')], new Map()),
    ).toEqual({
      day: '2026-06-01',
      giftCount: 0,
      totalSats: 0,
      totalBtc: '0.00000000',
      totalUsd: '0.00',
      gifts: [],
      fx: FX,
    });
  });

  it('lists two gifts on that day and ignores other days', () => {
    const listed = buildGiftDay(
      '2026-06-01',
      [
        row('2026-06-01T15:00:00.000Z', 1000, 'alice'),
        row('2026-06-02T00:00:00.000Z', 50, 'skip'),
        row('2026-06-01T08:00:00.000Z', 500, 'bob'),
      ],
      RATE_100K,
    );
    expect(listed.giftCount).toBe(2);
    expect(listed.totalSats).toBe(1500);
    expect(listed.totalBtc).toBe('0.00001500');
    expect(listed.totalUsd).toBe('1.50');
    expect(listed.gifts.map((g) => g.recipient)).toEqual(['bob', 'alice']);
    expect(listed.gifts[0]).toEqual({
      paidAt: '2026-06-01T08:00:00.000Z',
      amountSats: 500,
      amountBtc: '0.00000500',
      amountUsd: '0.50',
      recipient: 'bob',
    });
  });

  it('breaks paidAt ties by recipient name', () => {
    const listed = buildGiftDay(
      '2026-06-01',
      [row('2026-06-01T12:00:00.000Z', 1, 'zeta'), row('2026-06-01T12:00:00.000Z', 1, 'alpha')],
      RATE_100K,
    );
    expect(listed.gifts.map((g) => g.recipient)).toEqual(['alpha', 'zeta']);
  });

  it('throws fx.rate.missing when a listed gift has no rate', () => {
    expect(() =>
      buildGiftDay('2026-06-01', [row('2026-06-01T15:00:00.000Z', 1000, 'alice')], new Map()),
    ).toThrow('fx.rate.missing');
  });
});
