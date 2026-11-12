import { describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import {
  allocateRepayment,
  dayUnits,
  dueDayCount,
  fiatAmountToCents,
  formatCents,
  parseRepaymentDescription,
  parseRepaymentPartDescription,
  payerDebtUnits,
  repaymentDescription,
  repaymentDueDate,
  repaymentLedger,
  repaymentPartDescription,
  repaymentSchedule,
  repaymentStartMs,
  shareSats,
} from '@/lib/credit-repayment';

const ORDINARY_CREDIT = '22222222-2222-4222-8222-222222222222';
const EXEMPT_CREDIT = 'bcc5b230-f446-4724-8e50-df0339657bf9';

describe('credit repayment', () => {
  it('starts at the next UTC midnight', () => {
    const funded = Date.UTC(2026, 11, 26, 15, 30);
    expect(repaymentStartMs(funded, ORDINARY_CREDIT)).toBe(Date.UTC(2026, 11, 27));
    expect(repaymentDueDate(funded, 0, ORDINARY_CREDIT)).toBe('2026-12-27');
    expect(dueDayCount(funded, funded + 1000, 30, ORDINARY_CREDIT)).toBe(0);
    expect(dueDayCount(funded, Date.UTC(2026, 11, 27, 1), 30, ORDINARY_CREDIT)).toBe(1);
    expect(dueDayCount(funded, Date.UTC(2026, 11, 28, 1), 2, ORDINARY_CREDIT)).toBe(2);
    expect(dueDayCount(funded, Date.UTC(2026, 11, 27), 0, ORDINARY_CREDIT)).toBe(0);
    expect(dueDayCount(funded, funded, 1.5, ORDINARY_CREDIT)).toBe(0);
  });

  it('never starts a non-exempt credit before 2026-11-16', () => {
    const early = Date.UTC(2026, 9, 9, 6, 23);
    expect(repaymentStartMs(early, ORDINARY_CREDIT)).toBe(Date.UTC(2026, 10, 16));
    expect(repaymentDueDate(early, 0, ORDINARY_CREDIT)).toBe('2026-11-16');
    expect(repaymentDueDate(early, 1, ORDINARY_CREDIT)).toBe('2026-11-17');
    expect(dueDayCount(early, Date.UTC(2026, 10, 15, 23, 59), 90, ORDINARY_CREDIT)).toBe(0);
    expect(dueDayCount(early, Date.UTC(2026, 10, 16), 90, ORDINARY_CREDIT)).toBe(1);
    expect(repaymentStartMs(Date.UTC(2026, 10, 10, 12), ORDINARY_CREDIT)).toBe(
      Date.UTC(2026, 10, 16),
    );
    const eve = Date.UTC(2026, 10, 15, 23, 59);
    expect(repaymentStartMs(eve, ORDINARY_CREDIT)).toBe(Date.UTC(2026, 10, 16));
    const first = Date.UTC(2026, 10, 16, 0, 1);
    expect(repaymentStartMs(first, ORDINARY_CREDIT)).toBe(Date.UTC(2026, 10, 17));
  });

  it('starts the three operator-approved credits the day after they filled', () => {
    const funded = Date.UTC(2026, 10, 9, 14, 12, 13, 130);
    for (const id of [
      'bcc5b230-f446-4724-8e50-df0339657bf9',
      '11e05676-aa85-4b27-8a0b-855239328c9b',
      '399feee2-e84a-4f2f-94e2-21c04928298c',
    ]) {
      expect(repaymentStartMs(funded, id)).toBe(Date.UTC(2026, 10, 10));
      expect(repaymentDueDate(funded, 0, id)).toBe('2026-11-10');
    }
    expect(repaymentStartMs(funded, EXEMPT_CREDIT.toUpperCase())).toBe(Date.UTC(2026, 10, 10));
    expect(repaymentDueDate(funded, 0, EXEMPT_CREDIT.toUpperCase())).toBe('2026-11-10');
    expect(dueDayCount(funded, Date.UTC(2026, 10, 10), 30, EXEMPT_CREDIT)).toBe(1);
    expect(repaymentStartMs(funded, ORDINARY_CREDIT)).toBe(Date.UTC(2026, 10, 16));
    expect(repaymentDueDate(funded, 0, ORDINARY_CREDIT)).toBe('2026-11-16');
    expect(dueDayCount(funded, Date.UTC(2026, 10, 10), 30, ORDINARY_CREDIT)).toBe(0);
  });

  it('puts the remainder on the last day', () => {
    expect(dayUnits(1000n, 30, 0)).toBe(33n);
    expect(dayUnits(1000n, 30, 29)).toBe(43n);
    expect(dayUnits(1000n, 30, 30)).toBeNull();
    expect(dayUnits(-1n, 30, 0)).toBeNull();
    expect(dayUnits(1n, 1.5, 0)).toBeNull();
    expect(dayUnits(1n, 0, 0)).toBeNull();
    expect(dayUnits(1n, 30, -1)).toBeNull();
  });

  it('reads cents and ignores other descriptions', () => {
    expect(fiatAmountToCents('10.125')).toBe(1013n);
    expect(fiatAmountToCents('10.124')).toBe(1012n);
    expect(fiatAmountToCents('1,')).toBe(100n);
    expect(fiatAmountToCents('10')).toBe(1000n);
    expect(fiatAmountToCents('nope')).toBeNull();
    expect(formatCents(1n)).toBe('0.01');
    const id = '11111111-1111-4111-8111-111111111111';
    expect(parseRepaymentDescription(repaymentDescription(3, id))).toEqual({
      dayIndex: 3,
      recipientAccountId: id,
    });
    expect(parseRepaymentDescription(null)).toBeNull();
    expect(parseRepaymentDescription('gift')).toBeNull();
  });

  it('parses part repayment descriptions without breaking the old marker', () => {
    const id = '11111111-1111-4111-8111-111111111111';
    expect(repaymentPartDescription(2, id, 4, 500n, 900n)).toBe(`repayp:2:${id}:4:500:900`);
    expect(parseRepaymentPartDescription(`repayp:2:${id}:4:500:900`)).toEqual({
      dayIndex: 2,
      recipientAccountId: id,
      partIndex: 4,
      units: 500n,
      shareUnits: 900n,
    });
    expect(parseRepaymentPartDescription(`repay:2:${id}`)).toBeNull();
    expect(parseRepaymentDescription(`repayp:2:${id}:4:500:900`)).toEqual({
      dayIndex: 2,
      recipientAccountId: id,
    });
    expect(parseRepaymentPartDescription(`repayp:2:${id}:4:0:900`)).toBeNull();
    expect(parseRepaymentPartDescription(`repayp:2:${id}:4:500:0`)).toBeNull();
  });

  it('documents the complete share units parameter of part descriptions', async () => {
    const source = await readFile(
      new URL('../../lib/credit-repayment.ts', import.meta.url),
      'utf8',
    );
    expect(source).toMatch(/@param shareUnits - Full giver-day share in the same units\./);
  });

  it('allocates prepayments in plan order, skips waiting givers, and caps bills', () => {
    const shares = [
      {
        dayIndex: 0,
        accountId: 'a',
        units: 100n,
        paidUnits: 0n,
        nextPartIndex: 0,
        openParts: [],
        canReceive: true,
      },
      {
        dayIndex: 0,
        accountId: 'b',
        units: 100n,
        paidUnits: 0n,
        nextPartIndex: 0,
        openParts: [],
        canReceive: false,
      },
      {
        dayIndex: 1,
        accountId: 'a',
        units: 100n,
        paidUnits: 40n,
        nextPartIndex: 2,
        openParts: [],
        canReceive: true,
      },
      {
        dayIndex: 2,
        accountId: 'a',
        units: 100n,
        paidUnits: 0n,
        nextPartIndex: 0,
        openParts: [],
        canReceive: true,
      },
    ];
    const partial = allocateRepayment(250n, shares);
    expect(partial.parts).toEqual([
      { dayIndex: 0, accountId: 'a', partIndex: 0, units: 100n, open: false },
      { dayIndex: 1, accountId: 'a', partIndex: 2, units: 60n, open: false },
      { dayIndex: 2, accountId: 'a', partIndex: 0, units: 90n, open: false },
    ]);
    expect(partial.waiting).toEqual([{ dayIndex: 0, accountId: 'b', units: 100n }]);
    expect(partial.maxUnits).toBe(260n);
    expect(partial.usedUnits).toBe(250n);
    expect(allocateRepayment(250n, shares, 2).parts).toHaveLength(2);
    expect(allocateRepayment(0n, shares).parts).toEqual([]);
  });

  it('reuses an open bill only when it fits within the requested amount', () => {
    const shares = [
      {
        dayIndex: 0,
        accountId: 'a',
        units: 100n,
        paidUnits: 0n,
        nextPartIndex: 1,
        openParts: [{ dayIndex: 0, accountId: 'a', partIndex: 0, units: 30n, open: true }],
        canReceive: true,
      },
    ];
    const fits = allocateRepayment(30n, shares);
    expect(fits.parts).toEqual([
      { dayIndex: 0, accountId: 'a', partIndex: 0, units: 30n, open: true },
    ]);
    expect(fits.usedUnits).toBe(30n);
    expect(fits.openBillExceedsAmount).toBe(false);

    const tooLarge = allocateRepayment(10n, shares);
    expect(tooLarge.parts).toEqual([]);
    expect(tooLarge.usedUnits).toBe(0n);
    expect(tooLarge.openBillExceedsAmount).toBe(true);
  });

  it('stops reusing open bills at the bill and requested-amount limits', () => {
    const shares = [
      {
        dayIndex: 0,
        accountId: 'a',
        units: 100n,
        paidUnits: 0n,
        nextPartIndex: 2,
        openParts: [
          { dayIndex: 0, accountId: 'a', partIndex: 0, units: 30n, open: true as const },
          { dayIndex: 0, accountId: 'a', partIndex: 1, units: 20n, open: true as const },
        ],
        canReceive: true,
      },
    ];

    expect(allocateRepayment(50n, shares, 1).parts).toEqual([shares[0]?.openParts[0]]);
    expect(allocateRepayment(30n, shares, 2).parts).toEqual([shares[0]?.openParts[0]]);
  });

  it('counts a part only once and marks the share paid only when the remainder is zero', () => {
    const id = '11111111-1111-4111-8111-111111111111';
    const lines = repaymentLedger(
      1,
      [{ accountId: id, units: 100n }],
      [{ dayIndex: 0, accountId: id, paidUnits: 40n }],
      Date.UTC(2026, 10, 9),
      Date.UTC(2026, 10, 20),
      '22222222-2222-4222-8222-222222222222',
    );
    expect(lines[0]).toMatchObject({ units: 100n, paidUnits: 40n, status: 'due' });
    const paid = repaymentLedger(
      1,
      [{ accountId: id, units: 100n }],
      [{ dayIndex: 0, accountId: id, paidUnits: 100n }],
      Date.UTC(2026, 10, 9),
      Date.UTC(2026, 10, 20),
      '22222222-2222-4222-8222-222222222222',
    );
    expect(paid[0]).toMatchObject({ units: 100n, paidUnits: 100n, status: 'paid' });
  });

  it('treats a legacy full-share marker as fully paid in loan units', () => {
    const id = '11111111-1111-4111-8111-111111111111';
    const [line] = repaymentLedger(
      1,
      [{ accountId: id, units: 100n }],
      [{ dayIndex: 0, accountId: id }],
      Date.UTC(2026, 10, 9),
      Date.UTC(2026, 10, 20),
      ORDINARY_CREDIT,
    );
    expect(line).toMatchObject({ units: 100n, paidUnits: 100n, status: 'paid' });
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
    const open = repaymentLedger(
      2,
      [
        { accountId: 'a', units: 1n },
        { accountId: 'b', units: 1n },
      ],
      [],
      null,
      Date.UTC(2026, 11, 28),
      ORDINARY_CREDIT,
    );
    expect(open.every((line) => line.dueOn === null && line.status === 'scheduled')).toBe(true);
    const funded = Date.UTC(2026, 11, 26, 12);
    const now = Date.UTC(2026, 11, 28, 12);
    const plan = repaymentLedger(
      2,
      [{ accountId: 'a', units: 2n }],
      [{ dayIndex: 0, accountId: 'a', paidUnits: 1n }],
      funded,
      now,
      ORDINARY_CREDIT,
    );
    expect(plan).toEqual([
      {
        dayIndex: 0,
        dueOn: '2026-12-27',
        accountId: 'a',
        units: 1n,
        paidUnits: 1n,
        status: 'paid',
      },
      { dayIndex: 1, dueOn: '2026-12-28', accountId: 'a', units: 1n, paidUnits: 0n, status: 'due' },
    ]);
    const later = repaymentLedger(
      2,
      [{ accountId: 'a', units: 2n }],
      [],
      funded,
      Date.UTC(2026, 11, 27, 1),
      ORDINARY_CREDIT,
    );
    expect(later[1]?.status).toBe('scheduled');
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
    ).toEqual([]);
    expect(
      payerDebtUnits('USD', '1.00', [
        { accountId: 'a', sats: 50 },
        { accountId: '', sats: 50 },
      ]),
    ).toEqual([{ accountId: 'a', units: 50n }]);
    expect(
      payerDebtUnits('USD', '1.00', [
        { accountId: 'a', sats: 50, usd: '0.40' },
        { accountId: '', sats: 50 },
      ]),
    ).toEqual([{ accountId: 'a', units: 40n }]);
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
