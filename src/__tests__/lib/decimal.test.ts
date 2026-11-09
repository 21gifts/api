import { describe, expect, it } from 'vitest';
import { canonicalDecimal } from '@/lib/decimal';
import { canonicalGoalAmount } from '@/lib/goal-rate';

describe('canonicalDecimal', () => {
  it('writes the canonical form: no exponent, no leading or trailing zeros, no point for a whole number', () => {
    expect(canonicalDecimal(' 00010.10 ', 8)).toBe('10.1');
    expect(canonicalDecimal('0.10', 8)).toBe('0.1');
    expect(canonicalDecimal('10.', 8)).toBe('10');
    expect(canonicalDecimal('000', 8)).toBe('0');
    expect(canonicalDecimal('0.00000000', 8)).toBe('0');
    expect(canonicalDecimal('0.00001000', 8)).toBe('0.00001');
  });

  it('accepts a comma or a dot', () => {
    expect(canonicalDecimal('10,50', 6)).toBe('10.5');
    expect(canonicalDecimal('10.50', 6)).toBe('10.5');
  });

  it('takes 0, 6, 8, and 18 decimals and refuses more than the maximum', () => {
    expect(canonicalDecimal('12', 0)).toBe('12');
    expect(canonicalDecimal('12.', 0)).toBe('12');
    expect(canonicalDecimal('12.5', 0)).toBeNull();
    expect(canonicalDecimal('1.234500', 6)).toBe('1.2345');
    expect(canonicalDecimal('1.2345678', 6)).toBeNull();
    expect(canonicalDecimal('0.00000001', 8)).toBe('0.00000001');
    expect(canonicalDecimal('0.000000001', 8)).toBeNull();
    expect(canonicalDecimal('1.234000000000000000', 18)).toBe('1.234');
    expect(canonicalDecimal('0.000000000000000001', 18)).toBe('0.000000000000000001');
    expect(canonicalDecimal('0.0000000000000000001', 18)).toBeNull();
  });

  it('refuses exponents, signs, blanks, and a bare fraction', () => {
    for (const raw of ['1e2', '-1', '+1', '', ' ', '.5', '1.2.3', '1 000']) {
      expect(canonicalDecimal(raw, 18)).toBeNull();
    }
  });

  it('is what canonicalGoalAmount writes, with eight decimals', () => {
    for (const raw of [' 00010.10 ', '0.10', '10,0', '1.50000000', '10.123456789', '1e2']) {
      expect(canonicalGoalAmount(raw)).toBe(canonicalDecimal(raw, 8));
    }
  });
});
