import { describe, expect, it } from 'vitest';
import type { DailyRosterDocument } from '@/lib/daily-roster';
import type { FxSpotQuote } from '@/lib/fx-spot';
import { dailyShopSatsRequired, dailyShopSatsRequiredForGrant } from '@/lib/shop-spend-minimum';

/** Stored quote at 100 000 USD per BTC. */
const SPOT: FxSpotQuote = {
  asOf: '2026-11-16T00:00:00.000Z',
  source: 'test',
  rates: { USD: '100000' },
};

function roster(partial: Partial<DailyRosterDocument> = {}): DailyRosterDocument {
  return {
    comment: 'Daily',
    paymentsEnabled: true,
    defaultAmountUsd: 1,
    recipients: [],
    moderatorPaymentsEnabled: true,
    moderators: [],
    ...partial,
  };
}

describe('dailyShopSatsRequired', () => {
  it('requires half of the whole grant sats, rounded up', () => {
    expect(dailyShopSatsRequired(1, '100000')).toBe(500);
    expect(dailyShopSatsRequired(0.01, '100000')).toBe(5);
  });

  it('rounds an odd grant sats count up', () => {
    expect(dailyShopSatsRequired(0.003, '100000')).toBe(2);
  });

  it('never requires less than 1 sat, even when the grant rounds to 0 sats', () => {
    expect(dailyShopSatsRequired(0.000001, '100000')).toBe(1);
  });

  it('returns null without a usable spot or amount', () => {
    expect(dailyShopSatsRequired(1, null)).toBeNull();
    expect(dailyShopSatsRequired(1, 'not-a-spot')).toBeNull();
    expect(dailyShopSatsRequired(0, '100000')).toBeNull();
  });
});

describe('dailyShopSatsRequiredForGrant', () => {
  it('uses the listed roster amount for the account', () => {
    expect(
      dailyShopSatsRequiredForGrant({
        roster: roster({ recipients: [{ accountId: 'acc', amountUsd: 2 }] }),
        spot: SPOT,
        accountId: 'acc',
        grantStatus: 'admitted',
      }),
    ).toBe(1000);
  });

  it('uses the default amount for an unlisted admitted account', () => {
    expect(
      dailyShopSatsRequiredForGrant({
        roster: roster(),
        spot: SPOT,
        accountId: 'acc',
        grantStatus: 'admitted',
      }),
    ).toBe(500);
  });

  it('matches an address-only roster row when no account id is listed', () => {
    expect(
      dailyShopSatsRequiredForGrant({
        roster: roster({ recipients: [{ address: 'ada@example.test', amountUsd: 3 }] as never }),
        spot: SPOT,
        accountId: 'acc',
        address: 'ada@example.test',
        grantStatus: 'admitted',
      }),
    ).toBe(1500);
  });

  it('fails closed when the roster decides a skip', () => {
    expect(
      dailyShopSatsRequiredForGrant({
        roster: roster(),
        spot: SPOT,
        accountId: 'acc',
        grantStatus: 'withdrawn',
      }),
    ).toBeNull();
    expect(
      dailyShopSatsRequiredForGrant({
        roster: roster({ paymentsEnabled: false }),
        spot: SPOT,
        accountId: 'acc',
        grantStatus: 'admitted',
      }),
    ).toBeNull();
  });

  it('fails closed without a stored spot or without its USD rate', () => {
    for (const spot of [null, { ...SPOT, rates: { EUR: '90000' } }]) {
      expect(
        dailyShopSatsRequiredForGrant({
          roster: roster({ recipients: [{ accountId: 'acc', amountUsd: 2 }] }),
          spot,
          accountId: 'acc',
          grantStatus: 'admitted',
        }),
      ).toBeNull();
    }
  });
});
