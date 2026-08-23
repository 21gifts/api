import { describe, expect, it } from 'vitest';
import { buildGiftStats, mapGiftQueryRow, type GiftRow } from '@/lib/gift';

function row(paidAt: string, amountSats: number, recipientWosUser: string): GiftRow {
  return { paidAt: new Date(paidAt), amountSats, recipientWosUser };
}

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

describe('buildGiftStats', () => {
  it('returns zeros and empty series for no gifts', () => {
    expect(buildGiftStats([])).toEqual({
      totalSats: 0,
      giftCount: 0,
      recipientCount: 0,
      firstPaidAt: null,
      lastPaidAt: null,
      spendOverTime: [],
      byRecipient: [],
      byMonth: [],
    });
  });

  it('aggregates a single day', () => {
    const stats = buildGiftStats([row('2026-06-01T15:00:00.000Z', 1000, 'alice')]);
    expect(stats.totalSats).toBe(1000);
    expect(stats.giftCount).toBe(1);
    expect(stats.recipientCount).toBe(1);
    expect(stats.firstPaidAt).toBe('2026-06-01T15:00:00.000Z');
    expect(stats.lastPaidAt).toBe('2026-06-01T15:00:00.000Z');
    expect(stats.spendOverTime).toEqual([{ day: '2026-06-01', sats: 1000, cumulativeSats: 1000 }]);
    expect(stats.byRecipient).toEqual([{ recipient: 'alice', giftCount: 1, sats: 1000 }]);
    expect(stats.byMonth).toEqual([{ month: '2026-06', giftCount: 1, sats: 1000 }]);
  });

  it('fills UTC gap days with zero spend and a running cumulative', () => {
    const stats = buildGiftStats([
      row('2026-06-03T01:00:00.000Z', 30, 'bob'),
      row('2026-06-01T23:00:00.000Z', 10, 'alice'),
    ]);
    expect(stats.spendOverTime).toEqual([
      { day: '2026-06-01', sats: 10, cumulativeSats: 10 },
      { day: '2026-06-02', sats: 0, cumulativeSats: 10 },
      { day: '2026-06-03', sats: 30, cumulativeSats: 40 },
    ]);
    expect(stats.totalSats).toBe(40);
    expect(stats.giftCount).toBe(2);
  });

  it('sorts recipients by sats descending then name', () => {
    const stats = buildGiftStats([
      row('2026-06-01T00:00:00.000Z', 50, 'zeta'),
      row('2026-06-01T01:00:00.000Z', 50, 'alpha'),
      row('2026-06-01T02:00:00.000Z', 80, 'mid'),
    ]);
    expect(stats.byRecipient.map((r) => r.recipient)).toEqual(['mid', 'alpha', 'zeta']);
    expect(stats.recipientCount).toBe(3);
  });

  it('groups months chronologically', () => {
    const stats = buildGiftStats([
      row('2026-07-02T00:00:00.000Z', 5, 'a'),
      row('2026-06-30T00:00:00.000Z', 7, 'a'),
    ]);
    expect(stats.byMonth).toEqual([
      { month: '2026-06', giftCount: 1, sats: 7 },
      { month: '2026-07', giftCount: 1, sats: 5 },
    ]);
  });
});
