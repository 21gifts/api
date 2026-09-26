import { describe, expect, it } from 'vitest';
import {
  dayUnits,
  dueDayCount,
  fiatAmountToCents,
  parseRepaymentDescription,
  payerDebtUnits,
  repaymentDescription,
  repaymentSchedule,
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

  it('returns a 1-sat gift and a 1-cent gift in full', () => {
    const sats = repaymentSchedule(30, [
      { accountId: 'big', units: 20_999n },
      { accountId: 'tiny', units: 1n },
    ]);
    expect(sumFor(sats, 'tiny')).toBe(1n);
    expect(sumFor(sats, 'big')).toBe(20_999n);
    for (let day = 0; day < 30; day += 1) {
      const daySum = sats
        .filter((slice) => slice.dayIndex === day)
        .reduce((sum, slice) => sum + slice.units, 0n);
      expect(daySum).toBe(700n);
    }
    const cents = repaymentSchedule(30, [
      { accountId: 'big', units: 99n },
      { accountId: 'tiny', units: 1n },
    ]);
    expect(sumFor(cents, 'tiny')).toBe(1n);
    expect(sumFor(cents, 'big')).toBe(99n);
    expect(repaymentSchedule(0, [{ accountId: 'a', units: 1n }])).toEqual([]);
    expect(repaymentSchedule(1.5, [{ accountId: 'a', units: 1n }])).toEqual([]);
    expect(
      repaymentSchedule(2, [
        { accountId: '', units: 1n },
        { accountId: 'a', units: 0n },
      ]),
    ).toEqual([]);
    const single = repaymentSchedule(30, [{ accountId: 'tiny', units: 1n }]);
    expect(single).toEqual([{ dayIndex: 29, accountId: 'tiny', units: 1n }]);
    const tied = repaymentSchedule(2, [
      { accountId: 'b', units: 5n },
      { accountId: 'a', units: 5n },
    ]);
    expect(sumFor(tied, 'a')).toBe(5n);
    expect(sumFor(tied, 'b')).toBe(5n);
    const flipped = repaymentSchedule(30, [
      { accountId: 'tiny', units: 1n },
      { accountId: 'big', units: 20_999n },
    ]);
    expect(sumFor(flipped, 'tiny')).toBe(1n);
    expect(sumFor(flipped, 'big')).toBe(20_999n);
  });

  it('owes recorded cents, including one cent beside a zero', () => {
    expect(
      payerDebtUnits('BTC', null, [
        { accountId: 'a', sats: 1 },
        { accountId: 'b', sats: 2 },
      ]),
    ).toEqual([
      { accountId: 'a', units: 1n },
      { accountId: 'b', units: 2n },
    ]);
    expect(payerDebtUnits(undefined, '1.00', [{ accountId: 'a', sats: 1 }])).toEqual([
      { accountId: 'a', units: 1n },
    ]);
    expect(
      payerDebtUnits('USD', '10.00', [
        { accountId: 'big', sats: 99, usd: '0.99' },
        { accountId: 'tiny', sats: 1, usd: '0.01' },
      ]),
    ).toEqual([
      { accountId: 'big', units: 99n },
      { accountId: 'tiny', units: 1n },
    ]);
    expect(
      payerDebtUnits('PHP', '10.00', [
        { accountId: 'tiny', sats: 1, php: '0.01' },
        { accountId: 'zero', sats: 1, php: '0.00' },
      ]),
    ).toEqual([
      { accountId: 'tiny', units: 1n },
      { accountId: 'zero', units: 0n },
    ]);
    expect(payerDebtUnits('CHF', null, [{ accountId: 'a', sats: 1, chf: null }])).toBe(
      'unavailable',
    );
    expect(payerDebtUnits('EUR', undefined, [{ accountId: 'a', sats: 1 }])).toBe('unavailable');
    expect(payerDebtUnits('USD', 'nope', [{ accountId: 'a', sats: 1, usd: 'nope' }])).toBe(
      'unavailable',
    );
    expect(payerDebtUnits(null, null, [{ accountId: 'a', sats: 4 }])).toEqual([
      { accountId: 'a', units: 4n },
    ]);
    expect(
      payerDebtUnits('USD', '0.03', [
        { accountId: 'b', sats: 1 },
        { accountId: 'a', sats: 1 },
        { accountId: '', sats: 9 },
        { accountId: 'z', sats: 0 },
      ]),
    ).toEqual([
      { accountId: 'b', units: 1n },
      { accountId: 'a', units: 2n },
    ]);
    expect(
      payerDebtUnits('USD', '0.01', [
        { accountId: 'small', sats: 1 },
        { accountId: 'large', sats: 100 },
      ]),
    ).toEqual([{ accountId: 'large', units: 1n }]);
    expect(
      payerDebtUnits('USD', '0.05', [
        { accountId: 'small', sats: 1 },
        { accountId: 'large', sats: 3 },
      ]),
    ).toEqual([
      { accountId: 'small', units: 1n },
      { accountId: 'large', units: 4n },
    ]);
    expect(
      payerDebtUnits('USD', '0.05', [
        { accountId: 'large', sats: 3 },
        { accountId: 'small', sats: 1 },
      ]),
    ).toEqual([
      { accountId: 'large', units: 4n },
      { accountId: 'small', units: 1n },
    ]);
    expect(payerDebtUnits('USD', '0.00', [{ accountId: 'a', sats: 5 }])).toEqual([]);
    expect(payerDebtUnits('USD', '1.00', [{ accountId: '', sats: 0 }])).toEqual([]);
  });
});

function sumFor(slices: { accountId: string; units: bigint }[], accountId: string): bigint {
  return slices
    .filter((slice) => slice.accountId === accountId)
    .reduce((sum, slice) => sum + slice.units, 0n);
}
