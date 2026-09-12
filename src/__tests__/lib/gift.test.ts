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
  quotes: [{ code: 'USD' as const, pair: 'BTC-USD', source: 'coinbase-exchange-daily-close' }],
};

const FIAT_FX = {
  quote: 'BTC-USD' as const,
  dayBasis: 'utc' as const,
  source: 'coinbase-exchange-daily-close' as const,
  quotes: [
    { code: 'USD' as const, pair: 'BTC-USD', source: 'coinbase-exchange-daily-close' },
    { code: 'CHF' as const, pair: 'USD-CHF', source: 'frankfurter-ecb' },
    { code: 'EUR' as const, pair: 'USD-EUR', source: 'frankfurter-ecb' },
    { code: 'PHP' as const, pair: 'USD-PHP', source: 'frankfurter-ecb' },
  ],
};

const RATE_100K = new Map([['2026-06-01', '100000']]);

const FIAT_100K = new Map([['2026-06-01', { CHF: '0.80', EUR: '0.90', PHP: '50' }]]);

const NULL_FIAT_DAY = {
  chf: null,
  cumulativeChf: null,
  eur: null,
  cumulativeEur: null,
  php: null,
  cumulativePhp: null,
};

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
      totalChf: '0.00',
      totalEur: '0.00',
      totalPhp: '0.00',
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
    expect(stats.totalChf).toBeNull();
    expect(stats.totalEur).toBeNull();
    expect(stats.totalPhp).toBeNull();
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
        ...NULL_FIAT_DAY,
      },
    ]);
    expect(stats.byRecipient).toEqual([
      {
        recipient: 'alice',
        giftCount: 1,
        sats: 1000,
        btc: '0.00001000',
        usd: '1.00',
        chf: null,
        eur: null,
        php: null,
      },
    ]);
    expect(stats.byMonth).toEqual([
      {
        month: '2026-06',
        giftCount: 1,
        sats: 1000,
        btc: '0.00001000',
        usd: '1.00',
        chf: null,
        eur: null,
        php: null,
      },
    ]);
    expect(stats.fx).toEqual(FX);
  });

  it('treats a zero-sat gift day as a gift day, not a synthetic gap', () => {
    const stats = buildGiftStats([row('2026-06-01T15:00:00.000Z', 0, 'alice')], RATE_100K);
    expect(stats.giftCount).toBe(1);
    expect(stats.totalSats).toBe(0);
    expect(stats.totalChf).toBeNull();
    expect(stats.spendOverTime[0]?.sats).toBe(0);
    expect(stats.spendOverTime[0]?.chf).toBeNull();
    expect(stats.byMonth[0]?.giftCount).toBe(1);
    expect(stats.byMonth[0]?.chf).toBeNull();
  });

  it('converts historical CHF/EUR/PHP from USD at that UTC day (worked example)', () => {
    const stats = buildGiftStats(
      [row('2026-06-01T15:00:00.000Z', 1000, 'alice')],
      RATE_100K,
      FIAT_100K,
    );
    expect(stats.totalUsd).toBe('1.00');
    expect(stats.totalChf).toBe('0.80');
    expect(stats.totalEur).toBe('0.90');
    expect(stats.totalPhp).toBe('50.00');
    expect(stats.spendOverTime).toEqual([
      {
        day: '2026-06-01',
        sats: 1000,
        cumulativeSats: 1000,
        btc: '0.00001000',
        cumulativeBtc: '0.00001000',
        usd: '1.00',
        cumulativeUsd: '1.00',
        chf: '0.80',
        cumulativeChf: '0.80',
        eur: '0.90',
        cumulativeEur: '0.90',
        php: '50.00',
        cumulativePhp: '50.00',
      },
    ]);
    expect(stats.byRecipient).toEqual([
      {
        recipient: 'alice',
        giftCount: 1,
        sats: 1000,
        btc: '0.00001000',
        usd: '1.00',
        chf: '0.80',
        eur: '0.90',
        php: '50.00',
      },
    ]);
    expect(stats.byMonth).toEqual([
      {
        month: '2026-06',
        giftCount: 1,
        sats: 1000,
        btc: '0.00001000',
        usd: '1.00',
        chf: '0.80',
        eur: '0.90',
        php: '50.00',
      },
    ]);
    expect(stats.fx).toEqual(FIAT_FX);
  });

  it('keeps a currency total null when any gift day lacks that cross, but still lists it on fx.quotes', () => {
    const rates = new Map([
      ['2026-06-01', '100000'],
      ['2026-06-02', '100000'],
    ]);
    const fiat = new Map([['2026-06-01', { CHF: '0.80', EUR: '0.90', PHP: '50' }]]);
    const stats = buildGiftStats(
      [
        row('2026-06-01T12:00:00.000Z', 1000, 'alice'),
        row('2026-06-02T12:00:00.000Z', 1000, 'bob'),
      ],
      rates,
      fiat,
    );
    expect(stats.totalChf).toBeNull();
    expect(stats.totalEur).toBeNull();
    expect(stats.totalPhp).toBeNull();
    expect(stats.spendOverTime[0]?.chf).toBe('0.80');
    expect(stats.spendOverTime[1]?.chf).toBeNull();
    expect(stats.spendOverTime[1]?.cumulativeChf).toBeNull();
    expect(stats.fx.quotes.map((q) => q.code)).toEqual(['USD', 'CHF', 'EUR', 'PHP']);
  });

  it('lists only the crosses that appear on at least one gift day', () => {
    const fiat = new Map([['2026-06-01', { CHF: '0.80' }]]);
    const stats = buildGiftStats([row('2026-06-01T15:00:00.000Z', 1000, 'alice')], RATE_100K, fiat);
    expect(stats.totalChf).toBe('0.80');
    expect(stats.totalEur).toBeNull();
    expect(stats.totalPhp).toBeNull();
    expect(stats.fx.quotes).toEqual([
      { code: 'USD', pair: 'BTC-USD', source: 'coinbase-exchange-daily-close' },
      { code: 'CHF', pair: 'USD-CHF', source: 'frankfurter-ecb' },
    ]);
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
        ...NULL_FIAT_DAY,
      },
      {
        day: '2026-06-02',
        sats: 0,
        cumulativeSats: 10,
        btc: '0.00000000',
        cumulativeBtc: '0.00000010',
        usd: '0.00',
        cumulativeUsd: '0.01',
        chf: '0.00',
        cumulativeChf: null,
        eur: '0.00',
        cumulativeEur: null,
        php: '0.00',
        cumulativePhp: null,
      },
      {
        day: '2026-06-03',
        sats: 30,
        cumulativeSats: 40,
        btc: '0.00000030',
        cumulativeBtc: '0.00000040',
        usd: '0.06',
        cumulativeUsd: '0.07',
        ...NULL_FIAT_DAY,
      },
    ]);
    expect(stats.totalSats).toBe(40);
    expect(stats.totalUsd).toBe('0.07');
    expect(stats.giftCount).toBe(2);
  });

  it('keeps running fiat on a zero-sats gap day when the running total is a number', () => {
    const rates = new Map([
      ['2026-06-01', '100000'],
      ['2026-06-03', '100000'],
    ]);
    const fiat = new Map([
      ['2026-06-01', { CHF: '0.80', EUR: '0.90', PHP: '50' }],
      ['2026-06-03', { CHF: '0.80', EUR: '0.90', PHP: '50' }],
    ]);
    const stats = buildGiftStats(
      [
        row('2026-06-01T12:00:00.000Z', 1000, 'alice'),
        row('2026-06-03T12:00:00.000Z', 1000, 'bob'),
      ],
      rates,
      fiat,
    );
    expect(stats.spendOverTime[1]).toEqual({
      day: '2026-06-02',
      sats: 0,
      cumulativeSats: 1000,
      btc: '0.00000000',
      cumulativeBtc: '0.00001000',
      usd: '0.00',
      cumulativeUsd: '1.00',
      chf: '0.00',
      cumulativeChf: '0.80',
      eur: '0.00',
      cumulativeEur: '0.90',
      php: '0.00',
      cumulativePhp: '50.00',
    });
    expect(stats.totalChf).toBe('1.60');
    expect(stats.totalEur).toBe('1.80');
    expect(stats.totalPhp).toBe('100.00');
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
      {
        month: '2026-06',
        giftCount: 1,
        sats: 7,
        btc: '0.00000007',
        usd: '0.01',
        chf: null,
        eur: null,
        php: null,
      },
      {
        month: '2026-07',
        giftCount: 1,
        sats: 5,
        btc: '0.00000005',
        usd: '0.01',
        chf: null,
        eur: null,
        php: null,
      },
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
      {
        month: '2026-01',
        giftCount: 1,
        sats: 1000,
        btc: '0.00001000',
        usd: '1.00',
        chf: null,
        eur: null,
        php: null,
      },
      {
        month: '2026-02',
        giftCount: 0,
        sats: 0,
        btc: '0.00000000',
        usd: '0.00',
        chf: '0.00',
        eur: '0.00',
        php: '0.00',
      },
      {
        month: '2026-03',
        giftCount: 0,
        sats: 0,
        btc: '0.00000000',
        usd: '0.00',
        chf: '0.00',
        eur: '0.00',
        php: '0.00',
      },
      {
        month: '2026-04',
        giftCount: 0,
        sats: 0,
        btc: '0.00000000',
        usd: '0.00',
        chf: '0.00',
        eur: '0.00',
        php: '0.00',
      },
      {
        month: '2026-05',
        giftCount: 1,
        sats: 2000,
        btc: '0.00002000',
        usd: '2.00',
        chf: null,
        eur: null,
        php: null,
      },
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
      totalChf: '0.00',
      totalEur: '0.00',
      totalPhp: '0.00',
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
    expect(listed.totalChf).toBeNull();
    expect(listed.totalEur).toBeNull();
    expect(listed.totalPhp).toBeNull();
    expect(listed.gifts.map((g) => g.recipient)).toEqual(['bob', 'alice']);
    expect(listed.gifts[0]).toEqual({
      paidAt: '2026-06-01T08:00:00.000Z',
      amountSats: 500,
      amountBtc: '0.00000500',
      amountUsd: '0.50',
      amountChf: null,
      amountEur: null,
      amountPhp: null,
      recipient: 'bob',
    });
    expect(listed.fx).toEqual(FX);
  });

  it('converts each gift at that UTC day CHF/EUR/PHP cross', () => {
    const listed = buildGiftDay(
      '2026-06-01',
      [row('2026-06-01T15:00:00.000Z', 1000, 'alice')],
      RATE_100K,
      FIAT_100K,
    );
    expect(listed.totalUsd).toBe('1.00');
    expect(listed.totalChf).toBe('0.80');
    expect(listed.totalEur).toBe('0.90');
    expect(listed.totalPhp).toBe('50.00');
    expect(listed.gifts[0]).toEqual({
      paidAt: '2026-06-01T15:00:00.000Z',
      amountSats: 1000,
      amountBtc: '0.00001000',
      amountUsd: '1.00',
      amountChf: '0.80',
      amountEur: '0.90',
      amountPhp: '50.00',
      recipient: 'alice',
    });
    expect(listed.fx).toEqual(FIAT_FX);
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
