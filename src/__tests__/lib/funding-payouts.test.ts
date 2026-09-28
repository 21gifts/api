import { describe, expect, it } from 'vitest';
import type { FundingGrant } from '@/lib/funding';
import type { GiftRow } from '@/lib/gift';
import {
  buildFundingPayoutMatrix,
  comparePayoutRows,
  type PayoutDayCell,
  type PayoutMatrixAccount,
  type PayoutMatrixRow,
} from '@/lib/funding-payouts';

const NOW = Date.parse('2026-09-26T15:00:00.000Z');
const DAYS = [
  '2026-09-20',
  '2026-09-21',
  '2026-09-22',
  '2026-09-23',
  '2026-09-24',
  '2026-09-25',
  '2026-09-26',
] as const;

function account(
  partial: Partial<PayoutMatrixAccount> & Pick<PayoutMatrixAccount, 'id'>,
): PayoutMatrixAccount {
  return {
    name: 'Ada',
    role: 'verified',
    lightningAddress: 'ada@walletofsatoshi.com',
    ...partial,
  };
}

function grant(
  partial: Pick<FundingGrant, 'accountId' | 'status'> & Partial<FundingGrant>,
): FundingGrant {
  return {
    appliedAt: NOW,
    decidedAt: null,
    decidedBy: null,
    trialUtcDate: null,
    admittedAt: null,
    note: null,
    ...partial,
  };
}

function gift(partial: Pick<GiftRow, 'kind' | 'recipientWosUser' | 'paidAt'>): GiftRow {
  return { amountSats: 1, ...partial };
}

function missedWeek(): PayoutDayCell[] {
  return ['missed', 'missed', 'missed', 'missed', 'missed', 'missed', 'missed'];
}

function matrixRow(partial: Partial<PayoutMatrixRow>): PayoutMatrixRow {
  return {
    accountId: 'a',
    name: 'Ada',
    days: ['blocked', 'blocked', 'blocked', 'blocked', 'blocked', 'blocked', 'blocked'],
    ...partial,
  };
}

describe('comparePayoutRows', () => {
  const named = matrixRow({ name: 'Ada', accountId: 'a' });
  const unnamed = matrixRow({ name: null, accountId: 'b' });
  const bee = matrixRow({ name: 'Bee', accountId: 'b' });
  const loose = matrixRow({ name: 'Ada', accountId: null });
  const later = matrixRow({ name: 'Ada', accountId: 'b' });

  it('orders named before unnamed, then by name, then by account id', () => {
    expect(comparePayoutRows(named, unnamed)).toBeLessThan(0);
    expect(comparePayoutRows(unnamed, named)).toBeGreaterThan(0);
    expect(comparePayoutRows(named, bee)).toBeLessThan(0);
    expect(comparePayoutRows(bee, named)).toBeGreaterThan(0);
    expect(comparePayoutRows(named, loose)).toBeLessThan(0);
    expect(comparePayoutRows(loose, named)).toBeGreaterThan(0);
    expect(comparePayoutRows(named, later)).toBeLessThan(0);
    expect(comparePayoutRows(later, named)).toBeGreaterThan(0);
    expect(comparePayoutRows(named, matrixRow({ name: 'Ada', accountId: 'a' }))).toBe(0);
    expect(
      comparePayoutRows(
        matrixRow({ name: 'Ada', accountId: null }),
        matrixRow({ name: 'Ada', accountId: null }),
      ),
    ).toBe(0);
    expect(
      comparePayoutRows(
        matrixRow({ name: null, accountId: 'a' }),
        matrixRow({ name: null, accountId: 'b' }),
      ),
    ).toBeLessThan(0);
    expect(
      comparePayoutRows(
        matrixRow({ name: null, accountId: 'b' }),
        matrixRow({ name: null, accountId: 'a' }),
      ),
    ).toBeGreaterThan(0);
  });
});

describe('buildFundingPayoutMatrix', () => {
  it('returns the seven UTC days and no rows when nothing qualifies', () => {
    const matrix = buildFundingPayoutMatrix({
      nowMs: NOW,
      accounts: [account({ id: 'b', role: 'basis', name: 'Basis' })],
      grants: [grant({ accountId: 'b', status: 'admitted', admittedAt: NOW })],
      gifts: [],
    });
    expect(matrix.days).toEqual([...DAYS]);
    expect(matrix.rows).toEqual([]);
  });

  it('marks admitted days from admittedAt and leaves earlier days blocked', () => {
    const matrix = buildFundingPayoutMatrix({
      nowMs: NOW,
      accounts: [account({ id: 'a' })],
      grants: [
        grant({
          accountId: 'a',
          status: 'admitted',
          admittedAt: Date.parse('2026-09-22T00:00:00.000Z'),
        }),
      ],
      gifts: [],
    });
    expect(matrix.rows).toEqual([
      {
        accountId: 'a',
        name: 'Ada',
        days: ['blocked', 'blocked', 'missed', 'missed', 'missed', 'missed', 'missed'],
      },
    ]);
  });

  it('treats a null admittedAt as entitled on every day of the window', () => {
    const matrix = buildFundingPayoutMatrix({
      nowMs: NOW,
      accounts: [account({ id: 'a', name: '  Ada  ' })],
      grants: [grant({ accountId: 'a', status: 'admitted', admittedAt: null })],
      gifts: [],
    });
    expect(matrix.rows[0]?.name).toBe('Ada');
    expect(matrix.rows[0]?.days).toEqual(missedWeek());
  });

  it('entitles only the stored trial day, including a pending row that still has the date', () => {
    const trial = buildFundingPayoutMatrix({
      nowMs: NOW,
      accounts: [account({ id: 'a', name: 'Trial' })],
      grants: [grant({ accountId: 'a', status: 'trial', trialUtcDate: '2026-09-24' })],
      gifts: [],
    });
    expect(trial.rows[0]?.days).toEqual([
      'blocked',
      'blocked',
      'blocked',
      'blocked',
      'missed',
      'blocked',
      'blocked',
    ]);
    const pending = buildFundingPayoutMatrix({
      nowMs: NOW,
      accounts: [account({ id: 'a' })],
      grants: [grant({ accountId: 'a', status: 'pending', trialUtcDate: '2026-09-21' })],
      gifts: [],
    });
    expect(pending.rows[0]?.days[1]).toBe('missed');
  });

  it('omits a trial date outside the window and a pending grant with no date', () => {
    const matrix = buildFundingPayoutMatrix({
      nowMs: NOW,
      accounts: [account({ id: 'out', name: 'Out' }), account({ id: 'pend', name: 'Pend' })],
      grants: [
        grant({ accountId: 'out', status: 'trial', trialUtcDate: '2026-09-01' }),
        grant({ accountId: 'pend', status: 'pending' }),
      ],
      gifts: [],
    });
    expect(matrix.rows).toEqual([]);
  });

  it('paints a daily gift paid and ignores welcome, moderator, blank, and out-of-window gifts', () => {
    const matrix = buildFundingPayoutMatrix({
      nowMs: NOW,
      accounts: [account({ id: 'a', lightningAddress: 'Ada@walletofsatoshi.com' })],
      grants: [grant({ accountId: 'a', status: 'admitted', admittedAt: null })],
      gifts: [
        gift({
          kind: 'daily',
          recipientWosUser: 'ada',
          paidAt: new Date('2026-09-24T12:00:00.000Z'),
        }),
        gift({
          kind: 'welcome',
          recipientWosUser: 'ada',
          paidAt: new Date('2026-09-25T12:00:00.000Z'),
        }),
        gift({
          kind: 'moderator',
          recipientWosUser: 'ada',
          paidAt: new Date('2026-09-26T12:00:00.000Z'),
        }),
        gift({
          kind: 'daily',
          recipientWosUser: '   ',
          paidAt: new Date('2026-09-26T12:00:00.000Z'),
        }),
        gift({
          kind: 'daily',
          recipientWosUser: '@nowhere',
          paidAt: new Date('2026-09-26T12:00:00.000Z'),
        }),
        gift({
          kind: 'daily',
          recipientWosUser: 'ada',
          paidAt: new Date('2026-08-01T12:00:00.000Z'),
        }),
        gift({
          kind: 'other',
          recipientWosUser: 'ada',
          paidAt: new Date('2026-09-23T12:00:00.000Z'),
        }),
      ],
    });
    expect(matrix.rows[0]?.days).toEqual([
      'missed',
      'missed',
      'missed',
      'missed',
      'paid',
      'missed',
      'missed',
    ]);
  });

  it('includes a basis account only on days a daily gift was paid', () => {
    const matrix = buildFundingPayoutMatrix({
      nowMs: NOW,
      accounts: [
        account({
          id: 'b',
          role: 'basis',
          name: '   ',
          lightningAddress: 'basis@walletofsatoshi.com',
        }),
      ],
      grants: [grant({ accountId: 'b', status: 'admitted', admittedAt: null })],
      gifts: [
        gift({
          kind: 'daily',
          recipientWosUser: 'basis@walletofsatoshi.com',
          paidAt: new Date('2026-09-26T01:00:00.000Z'),
        }),
      ],
    });
    expect(matrix.rows).toEqual([
      {
        accountId: 'b',
        name: null,
        days: ['blocked', 'blocked', 'blocked', 'blocked', 'blocked', 'blocked', 'paid'],
      },
    ]);
  });

  it('gives a shared handle to the smaller account id and keeps an unmatched handle', () => {
    const matrix = buildFundingPayoutMatrix({
      nowMs: NOW,
      accounts: [
        account({ id: 'b', name: 'Bee', lightningAddress: 'shared@walletofsatoshi.com' }),
        account({ id: 'a', name: 'Aye', lightningAddress: 'Shared@walletofsatoshi.com' }),
        account({ id: 'same', name: 'Same' }),
        account({ id: 'same', name: 'Same' }),
      ],
      grants: [
        grant({ accountId: 'a', status: 'admitted', admittedAt: null }),
        grant({ accountId: 'b', status: 'admitted', admittedAt: null }),
        grant({ accountId: 'same', status: 'admitted', admittedAt: null }),
        grant({ accountId: 'missing', status: 'admitted', admittedAt: null }),
      ],
      gifts: [
        gift({
          kind: 'daily',
          recipientWosUser: 'shared',
          paidAt: new Date('2026-09-20T12:00:00.000Z'),
        }),
        gift({
          kind: 'daily',
          recipientWosUser: 'Ghost',
          paidAt: new Date('2026-09-25T12:00:00.000Z'),
        }),
      ],
    });
    const aye = matrix.rows.find((row) => row.accountId === 'a');
    const bee = matrix.rows.find((row) => row.accountId === 'b');
    expect(aye?.days[0]).toBe('paid');
    expect(bee?.days[0]).toBe('missed');
    expect(matrix.rows.find((row) => row.accountId === null)).toEqual({
      accountId: null,
      name: 'ghost',
      days: ['blocked', 'blocked', 'blocked', 'blocked', 'blocked', 'paid', 'blocked'],
    });
    expect(matrix.rows.map((row) => row.name)).toEqual(['Aye', 'Bee', 'ghost', 'Same', 'Same']);
  });

  it('sorts unnamed accounts after named ones and by account id', () => {
    const matrix = buildFundingPayoutMatrix({
      nowMs: NOW,
      accounts: [
        account({ id: 'm', name: null, lightningAddress: null }),
        account({ id: 'z', name: 'Zed', lightningAddress: null }),
        account({ id: 'a', name: '', lightningAddress: null }),
      ],
      grants: [
        grant({ accountId: 'm', status: 'admitted', admittedAt: null }),
        grant({ accountId: 'z', status: 'admitted', admittedAt: null }),
        grant({ accountId: 'a', status: 'admitted', admittedAt: null }),
      ],
      gifts: [],
    });
    expect(matrix.rows.map((row) => row.accountId)).toEqual(['z', 'a', 'm']);
  });

  it('sorts an account ahead of an unmatched handle with the same name', () => {
    const matrix = buildFundingPayoutMatrix({
      nowMs: NOW,
      accounts: [account({ id: 'g', name: 'ghost', lightningAddress: null })],
      grants: [grant({ accountId: 'g', status: 'admitted', admittedAt: null })],
      gifts: [
        gift({
          kind: 'daily',
          recipientWosUser: 'GHOST',
          paidAt: new Date('2026-09-26T12:00:00.000Z'),
        }),
      ],
    });
    expect(matrix.rows.map((row) => row.accountId)).toEqual(['g', null]);
  });

  it('ignores a blank lightning address when matching gifts', () => {
    const matrix = buildFundingPayoutMatrix({
      nowMs: NOW,
      accounts: [account({ id: 'a', lightningAddress: '   ' })],
      grants: [grant({ accountId: 'a', status: 'pending' })],
      gifts: [
        gift({
          kind: 'daily',
          recipientWosUser: 'ada',
          paidAt: new Date('2026-09-26T12:00:00.000Z'),
        }),
      ],
    });
    expect(matrix.rows).toEqual([
      {
        accountId: null,
        name: 'ada',
        days: ['blocked', 'blocked', 'blocked', 'blocked', 'blocked', 'blocked', 'paid'],
      },
    ]);
  });
});
