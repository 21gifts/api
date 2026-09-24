import { describe, expect, it } from 'vitest';
import {
  canonicalGoalAmount,
  fiatToSats,
  satsToFiatAmount,
  type GoalRateDay,
} from '@/lib/goal-rate';

const DAY: GoalRateDay = {
  sats: 100_000_000,
  usd: '50000.00',
  chf: '45000.00',
  eur: null,
  php: '0',
};

describe('canonicalGoalAmount', () => {
  it('canonicalizes comma, trailing zeros, and a trailing dot', () => {
    expect(canonicalGoalAmount(' 00010.10 ')).toBe('10.1');
    expect(canonicalGoalAmount('0.10')).toBe('0.1');
    expect(canonicalGoalAmount('10.')).toBe('10');
    expect(canonicalGoalAmount('10.0')).toBe('10');
    expect(canonicalGoalAmount('10,0')).toBe('10');
    expect(canonicalGoalAmount('000')).toBe('0');
    expect(canonicalGoalAmount('1.50000000')).toBe('1.5');
  });

  it('rejects exponents, signs, and more than eight fractional digits', () => {
    expect(canonicalGoalAmount('1e2')).toBeNull();
    expect(canonicalGoalAmount('-1')).toBeNull();
    expect(canonicalGoalAmount('10.123456789')).toBeNull();
    expect(canonicalGoalAmount('')).toBeNull();
  });
});

describe('gift-day ask math', () => {
  it('converts one USD at 50000 per bitcoin to 2000 sats and back', () => {
    expect(fiatToSats(1, DAY, 'USD')).toBe(2000);
    expect(satsToFiatAmount(2000, DAY, 'USD')).toBe('1.00');
  });

  it('returns 0 for a zero amount and 1 when the product rounds to 0', () => {
    expect(fiatToSats(0, DAY, 'USD')).toBe(0);
    expect(fiatToSats(0.00000001, { ...DAY, sats: 100, usd: '1000000' }, 'USD')).toBe(1);
  });

  it('is unusable without a day, a positive finite sats total, or a usable quote', () => {
    expect(fiatToSats(1, null, 'USD')).toBeNull();
    expect(fiatToSats(1, { ...DAY, sats: 0 }, 'USD')).toBeNull();
    expect(fiatToSats(1, { ...DAY, sats: Number.NaN }, 'USD')).toBeNull();
    expect(fiatToSats(Number.NaN, DAY, 'USD')).toBeNull();
    expect(fiatToSats(-1, DAY, 'USD')).toBeNull();
    expect(fiatToSats(1, DAY, 'EUR')).toBeNull();
    expect(fiatToSats(1, DAY, 'PHP')).toBeNull();
    expect(fiatToSats(1, { ...DAY, usd: 'nope' }, 'USD')).toBeNull();
    expect(satsToFiatAmount(-1, DAY, 'USD')).toBeNull();
    expect(satsToFiatAmount(1, null, 'CHF')).toBeNull();
    expect(satsToFiatAmount(2000, DAY, 'EUR')).toBeNull();
    expect(satsToFiatAmount(2000, DAY, 'CHF')).toBe('0.90');
  });
});
