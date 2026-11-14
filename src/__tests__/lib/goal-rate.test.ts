import { describe, expect, it } from 'vitest';
import { canonicalGoalAmount, fiatToSats } from '@/lib/goal-rate';
import type { FxSpotQuote } from '@/lib/fx-spot';

const SPOT: FxSpotQuote = {
  asOf: '2026-11-13T12:00:00.000Z',
  source: 'test',
  rates: { USD: '50000.00', CHF: '45000.00', PHP: '0' },
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

describe('fiat conversion math', () => {
  it('converts one USD at 50000 per bitcoin to 2000 sats', () => {
    expect(fiatToSats(1, SPOT, 'USD')).toBe(2000);
  });

  it('returns 0 for a zero amount and 1 when the product rounds to 0', () => {
    expect(fiatToSats(0, SPOT, 'USD')).toBe(0);
    expect(fiatToSats(0.00000001, { ...SPOT, rates: { USD: '1000000' } }, 'USD')).toBe(1);
  });

  it('is unusable without a spot or a usable currency rate', () => {
    expect(fiatToSats(1, null, 'USD')).toBeNull();
    expect(fiatToSats(Number.NaN, SPOT, 'USD')).toBeNull();
    expect(fiatToSats(-1, SPOT, 'USD')).toBeNull();
    expect(fiatToSats(1, SPOT, 'EUR')).toBeNull();
    expect(fiatToSats(1, SPOT, 'PHP')).toBeNull();
    expect(fiatToSats(1, { ...SPOT, rates: { USD: 'nope' } }, 'USD')).toBeNull();
  });
});
