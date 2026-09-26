import { describe, expect, it } from 'vitest';
import {
  dayUnits,
  dueDayCount,
  fiatAmountToCents,
  parseRepaymentDescription,
  repaymentDescription,
  repaymentStartMs,
  shareSats,
} from '@/lib/credit-repayment';

describe('credit repayment', () => {
  it('starts at the next UTC midnight', () => {
    const funded = Date.UTC(2026, 8, 26, 15, 30);
    expect(repaymentStartMs(funded)).toBe(Date.UTC(2026, 8, 27));
    expect(dueDayCount(funded, funded + 1000, 30)).toBe(0);
    expect(dueDayCount(funded, Date.UTC(2026, 8, 27, 1), 30)).toBe(1);
    expect(dueDayCount(funded, Date.UTC(2026, 8, 28, 1), 2)).toBe(2);
    expect(dueDayCount(funded, Date.UTC(2026, 8, 27), 0)).toBe(0);
  });

  it('puts the remainder on the last day', () => {
    expect(dayUnits(1000n, 30, 0)).toBe(33n);
    expect(dayUnits(1000n, 30, 29)).toBe(43n);
    expect(dayUnits(1000n, 30, 30)).toBeNull();
    expect(dayUnits(-1n, 30, 0)).toBeNull();
  });

  it('reads cents and ignores other descriptions', () => {
    expect(fiatAmountToCents('10.125')).toBe(1013n);
    expect(fiatAmountToCents('1,')).toBe(100n);
    expect(fiatAmountToCents('10')).toBe(1000n);
    expect(fiatAmountToCents('nope')).toBeNull();
    const id = '11111111-1111-4111-8111-111111111111';
    expect(parseRepaymentDescription(repaymentDescription(3, id))).toEqual({
      dayIndex: 3,
      recipientAccountId: id,
    });
    expect(parseRepaymentDescription(null)).toBeNull();
    expect(parseRepaymentDescription('gift')).toBeNull();
  });

  it('splits sats across givers and keeps the total', () => {
    const shares = shareSats(10, [
      { accountId: 'b', sats: 1 },
      { accountId: 'a', sats: 2 },
    ]);
    expect(shares.reduce((sum, share) => sum + share.sats, 0)).toBe(10);
    expect(shares[0]?.accountId).toBe('a');
    expect(shareSats(0, [{ accountId: 'a', sats: 1 }])).toEqual([]);
    expect(
      shareSats(3, [
        { accountId: 'b', sats: 1 },
        { accountId: 'a', sats: 1 },
      ]).map((share) => share.accountId),
    ).toEqual(['a', 'b']);
    expect(shareSats(5, [{ accountId: '', sats: 1 }])).toEqual([]);
  });
});
