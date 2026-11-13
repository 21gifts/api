import { describe, expect, it } from 'vitest';
import { utcDayKey } from '@/lib/funding';
import { addUtcDays } from '@/lib/member-habit';
import {
  buildWalletUsage,
  WALLET_RELEASE_AT_MS,
  walletUsagePurpose,
  walletUsageReadSince,
  type WalletUsagePaymentRow,
  type WalletUsagePurpose,
} from '@/lib/wallet-usage';

const NOW = Date.parse('2026-11-12T15:51:00.000Z');
const DAY_MS = 24 * 60 * 60 * 1000;

const PURPOSES: readonly WalletUsagePurpose[] = [
  'deposit',
  'withdrawal',
  'shop_purchase',
  'forum_gift',
  'transfer',
  'fund_deposit',
  'fund_payout',
  'other',
];

function pay(over: Partial<WalletUsagePaymentRow> = {}): WalletUsagePaymentRow {
  return {
    paidAt: new Date('2026-11-11T12:00:00.000Z'),
    amountSats: 1,
    feeSats: 0,
    category: 'unknown',
    payerAccountId: 'payer',
    payeeAccountId: 'payee',
    payerParty: 'members',
    payeeParty: 'members',
    isFundPayout: false,
    ...over,
  };
}

function dayKeys(startMs: number, endMs: number): string[] {
  const endDay = utcDayKey(endMs);
  const keys: string[] = [];
  for (let day = utcDayKey(startMs); day <= endDay; day = addUtcDays(day, 1)) {
    keys.push(day);
  }
  return keys;
}

function purposes(
  extra: Partial<Record<WalletUsagePurpose, { count: number; sats: number }>> = {},
): Record<WalletUsagePurpose, { count: number; sats: number }> {
  const all = {} as Record<WalletUsagePurpose, { count: number; sats: number }>;
  for (const key of PURPOSES) {
    const cell = extra[key];
    all[key] = cell === undefined ? { count: 0, sats: 0 } : cell;
  }
  return all;
}

describe('walletUsageReadSince', () => {
  it('starts payments at release and looks back 28 and 14 days', () => {
    expect(WALLET_RELEASE_AT_MS).toBe(Date.parse('2026-11-09T11:17:00.000Z'));
    expect(walletUsageReadSince()).toEqual({
      payments: WALLET_RELEASE_AT_MS,
      forumInvoices: WALLET_RELEASE_AT_MS - 28 * DAY_MS,
      shopCharges: WALLET_RELEASE_AT_MS - 14 * DAY_MS,
    });
    expect(utcDayKey(WALLET_RELEASE_AT_MS)).toBe('2026-11-09');
    expect(utcDayKey(walletUsageReadSince().forumInvoices)).toBe('2026-10-12');
    expect(utcDayKey(walletUsageReadSince().shopCharges)).toBe('2026-10-26');
  });
});

describe('walletUsagePurpose', () => {
  it('uses the first matching rule', () => {
    const cases: Array<[WalletUsagePaymentRow, WalletUsagePurpose]> = [
      [
        pay({
          isFundPayout: true,
          category: 'shop',
          payerParty: 'fund',
          payeeParty: 'fund',
        }),
        'fund_payout',
      ],
      [pay({ payeeParty: 'fund', payerParty: 'members', category: 'member' }), 'fund_deposit'],
      [pay({ payeeParty: 'fund', payerParty: 'outside', category: 'gift' }), 'forum_gift'],
      [pay({ category: 'gift' }), 'forum_gift'],
      [pay({ category: 'platform' }), 'forum_gift'],
      [pay({ category: 'shop' }), 'shop_purchase'],
      [pay({ category: 'member', payerParty: 'outside' }), 'transfer'],
      [
        pay({ category: 'outside_lightning', payerParty: 'outside', payeeParty: 'fund' }),
        'deposit',
      ],
      [pay({ category: 'outside_lightning', payerParty: 'members' }), 'withdrawal'],
      [pay({ category: 'onchain', payerParty: 'outside' }), 'deposit'],
      [pay({ category: 'onchain', payerParty: 'fund' }), 'withdrawal'],
      [pay({ category: 'unknown' }), 'other'],
    ];
    for (const [row, purpose] of cases) {
      expect(walletUsagePurpose(row)).toBe(purpose);
    }
  });
});

describe('buildWalletUsage', () => {
  it('reproduces the reference payment shape on synthetic rows', () => {
    const futureId = 'future-account';
    const body = buildWalletUsage(
      {
        payments: [
          pay({
            paidAt: new Date('2026-11-12T08:00:00.000Z'),
            amountSats: 293955,
            category: 'outside_lightning',
            payerAccountId: null,
            payerParty: 'outside',
            payeeAccountId: 'acct-fund',
            payeeParty: 'fund',
          }),
          pay({
            paidAt: new Date('2026-11-12T11:00:00.000Z'),
            amountSats: 1,
            category: 'platform',
            payerAccountId: 'acct-member',
            payerParty: 'members',
            payeeAccountId: 'acct-platform',
            payeeParty: 'platform',
          }),
          pay({
            paidAt: new Date('2026-11-12T09:00:00.000Z'),
            amountSats: 69089,
            feeSats: 210,
            category: 'outside_lightning',
            payerAccountId: 'acct-withdrawer',
            payerParty: 'members',
            payeeAccountId: null,
            payeeParty: 'outside',
          }),
          pay({
            paidAt: new Date('2026-11-12T10:00:00.000Z'),
            amountSats: 12321,
            category: 'member',
            payerAccountId: 'acct-member',
            payerParty: 'members',
            payeeAccountId: 'acct-transfer',
            payeeParty: 'members',
          }),
          pay({
            paidAt: new Date('2026-11-11T12:00:00.000Z'),
            amountSats: 1000,
            category: 'shop',
            payerAccountId: 'acct-fund',
            payerParty: 'fund',
            payeeAccountId: 'acct-shop',
            payeeParty: 'members',
            isFundPayout: true,
          }),
          pay({
            paidAt: new Date('2026-11-11T13:00:00.000Z'),
            amountSats: 380500,
            category: 'member',
            payerAccountId: 'acct-member',
            payerParty: 'members',
            payeeAccountId: 'acct-fund',
            payeeParty: 'fund',
          }),
          pay({
            paidAt: new Date('2026-11-13T00:00:00.000Z'),
            amountSats: 777,
            payerAccountId: futureId,
          }),
        ],
        forumInvoices: [
          { createdAt: new Date('2026-10-12T12:00:00.000Z'), amountSats: 5, heart: false },
          { createdAt: new Date('2026-11-09T10:00:00.000Z'), amountSats: 3, heart: true },
          { createdAt: new Date('2026-11-11T12:00:00.000Z'), amountSats: 7, heart: false },
          { createdAt: new Date('2026-11-12T12:00:00.000Z'), amountSats: 21, heart: true },
          { createdAt: new Date('2026-11-13T12:00:00.000Z'), amountSats: 99, heart: true },
          { createdAt: new Date('2026-09-01T12:00:00.000Z'), amountSats: 4, heart: false },
        ],
        shopCharges: [
          { createdAt: new Date('2026-10-26T12:00:00.000Z'), status: 'paid' },
          { createdAt: new Date('2026-11-11T12:00:00.000Z'), status: 'pending' },
          { createdAt: new Date('2026-11-12T08:00:00.000Z'), status: 'paid' },
          { createdAt: new Date('2026-11-12T09:00:00.000Z'), status: 'cancelled' },
          { createdAt: new Date('2026-11-13T08:00:00.000Z'), status: 'paid' },
          { createdAt: new Date('2026-09-01T08:00:00.000Z'), status: 'paid' },
        ],
      },
      NOW,
    );

    expect(body.releasedAt).toBe('2026-11-09T11:17:00.000Z');
    expect(body.asOf).toBe('2026-11-12T11:00:00.000Z');
    expect(body.totals).toEqual({
      paymentCount: 6,
      volumeSats: 756866,
      feeSats: 210,
      medianSats: 40705,
      averageSats: 126144,
      activeWalletCount: 5,
      sendingWalletCount: 3,
      topFiveSenderShare: 1,
      heartCount: 1,
      paidShopChargeCount: 1,
    });
    expect(body.days.map((day) => day.day)).toEqual([
      '2026-11-09',
      '2026-11-10',
      '2026-11-11',
      '2026-11-12',
    ]);
    expect(body.days[0]).toMatchObject({
      purposes: purposes(),
      activeWalletCount: 0,
      sendingWalletCount: 0,
      receivingWalletCount: 0,
    });
    expect(body.days[1]).toMatchObject({
      purposes: purposes(),
      activeWalletCount: 0,
      sendingWalletCount: 0,
      receivingWalletCount: 0,
    });
    expect(body.days[2]).toMatchObject({
      purposes: purposes({
        fund_payout: { count: 1, sats: 1000 },
        fund_deposit: { count: 1, sats: 380500 },
      }),
      activeWalletCount: 3,
      sendingWalletCount: 2,
      receivingWalletCount: 2,
    });
    expect(body.days[3]).toMatchObject({
      purposes: purposes({
        forum_gift: { count: 1, sats: 1 },
        deposit: { count: 1, sats: 293955 },
        withdrawal: { count: 1, sats: 69089 },
        transfer: { count: 1, sats: 12321 },
      }),
      activeWalletCount: 4,
      sendingWalletCount: 2,
      receivingWalletCount: 2,
    });
    expect(body.flows).toEqual([
      {
        day: '2026-11-11',
        from: 'fund',
        to: 'members',
        purpose: 'fund_payout',
        count: 1,
        sats: 1000,
        feeSats: 0,
      },
      {
        day: '2026-11-11',
        from: 'members',
        to: 'fund',
        purpose: 'fund_deposit',
        count: 1,
        sats: 380500,
        feeSats: 0,
      },
      {
        day: '2026-11-12',
        from: 'members',
        to: 'members',
        purpose: 'transfer',
        count: 1,
        sats: 12321,
        feeSats: 0,
      },
      {
        day: '2026-11-12',
        from: 'members',
        to: 'outside',
        purpose: 'withdrawal',
        count: 1,
        sats: 69089,
        feeSats: 210,
      },
      {
        day: '2026-11-12',
        from: 'members',
        to: 'platform',
        purpose: 'forum_gift',
        count: 1,
        sats: 1,
        feeSats: 0,
      },
      {
        day: '2026-11-12',
        from: 'outside',
        to: 'fund',
        purpose: 'deposit',
        count: 1,
        sats: 293955,
        feeSats: 0,
      },
    ]);
    expect(body.amountBuckets).toEqual([
      { key: '1', minSats: 1, maxSats: 1, count: 1, sats: 1 },
      { key: '2-10', minSats: 2, maxSats: 10, count: 0, sats: 0 },
      { key: '11-100', minSats: 11, maxSats: 100, count: 0, sats: 0 },
      { key: '101-1k', minSats: 101, maxSats: 1000, count: 1, sats: 1000 },
      { key: '1k-10k', minSats: 1001, maxSats: 10000, count: 0, sats: 0 },
      { key: '10k-100k', minSats: 10001, maxSats: 100000, count: 2, sats: 81410 },
      { key: '100k+', minSats: 100001, maxSats: null, count: 2, sats: 674455 },
    ]);
    expect(body.hours).toEqual(
      Array.from({ length: 24 }, (_, hourUtc) => ({
        hourUtc,
        count: [8, 9, 10, 11, 12, 13].includes(hourUtc) ? 1 : 0,
      })),
    );
    const since = walletUsageReadSince();
    expect(body.forum.map((row) => row.day)).toEqual(dayKeys(since.forumInvoices, NOW));
    expect(body.forum[0]).toEqual({ day: '2026-10-12', gifts: 1, hearts: 0, sats: 5 });
    expect(body.forum.find((row) => row.day === '2026-10-13')).toEqual({
      day: '2026-10-13',
      gifts: 0,
      hearts: 0,
      sats: 0,
    });
    expect(body.forum.find((row) => row.day === '2026-11-09')).toEqual({
      day: '2026-11-09',
      gifts: 0,
      hearts: 1,
      sats: 3,
    });
    expect(body.forum.find((row) => row.day === '2026-11-11')).toEqual({
      day: '2026-11-11',
      gifts: 1,
      hearts: 0,
      sats: 7,
    });
    expect(body.forum.find((row) => row.day === '2026-11-12')).toEqual({
      day: '2026-11-12',
      gifts: 0,
      hearts: 1,
      sats: 21,
    });
    expect(body.forum.some((row) => row.day === '2026-09-01')).toBe(false);
    expect(body.shopCharges.map((row) => row.day)).toEqual(dayKeys(since.shopCharges, NOW));
    expect(body.shopCharges.find((row) => row.day === '2026-10-26')).toEqual({
      day: '2026-10-26',
      created: 1,
      paid: 1,
    });
    expect(body.shopCharges.find((row) => row.day === '2026-11-11')).toEqual({
      day: '2026-11-11',
      created: 1,
      paid: 0,
    });
    expect(body.shopCharges.find((row) => row.day === '2026-11-12')).toEqual({
      day: '2026-11-12',
      created: 2,
      paid: 1,
    });
    expect(body.shopCharges.some((row) => row.day === '2026-09-01')).toBe(false);
    const json = JSON.stringify(body);
    for (const id of [
      'acct-fund',
      'acct-member',
      'acct-withdrawer',
      'acct-transfer',
      'acct-shop',
      'acct-platform',
      futureId,
    ]) {
      expect(json).not.toContain(id);
    }
  });

  it('drops account ids and raw categories from the serialized body', () => {
    const payerId = 'acct-9f3c-payer';
    const payeeId = 'acct-9f3c-payee';
    const category = 'zz-secret-category-9f3c';
    const body = buildWalletUsage(
      {
        payments: [
          pay({
            amountSats: 4,
            payerAccountId: payerId,
            payeeAccountId: payeeId,
            category,
          }),
        ],
        forumInvoices: [],
        shopCharges: [],
      },
      NOW,
    );
    const json = JSON.stringify(body);
    expect(json).not.toContain(payerId);
    expect(json).not.toContain(payeeId);
    expect(json).not.toContain(category);
    expect(json).not.toContain('payerAccountId');
    expect(json).not.toContain('payeeAccountId');
    expect(body.flows[0]?.purpose).toBe('other');
  });

  it('counts a payment before the release day in totals but not in the day series', () => {
    const body = buildWalletUsage(
      {
        payments: [
          pay({
            paidAt: new Date('2026-11-08T12:00:00.000Z'),
            amountSats: 50,
            payerAccountId: 'acct-early',
            payerParty: 'members',
            payeeAccountId: null,
            payeeParty: 'outside',
            category: 'member',
          }),
        ],
        forumInvoices: [],
        shopCharges: [],
      },
      NOW,
    );
    expect(body.totals.paymentCount).toBe(1);
    expect(body.totals.volumeSats).toBe(50);
    expect(body.days.map((day) => day.day)).toEqual(dayKeys(WALLET_RELEASE_AT_MS, NOW));
    expect(body.days.every((day) => day.purposes.transfer.count === 0)).toBe(true);
    expect(body.flows).toEqual([
      {
        day: '2026-11-08',
        from: 'members',
        to: 'outside',
        purpose: 'transfer',
        count: 1,
        sats: 50,
        feeSats: 0,
      },
    ]);
  });

  it('returns gap-free zeros when nothing has happened', () => {
    const nowMs = WALLET_RELEASE_AT_MS;
    const body = buildWalletUsage({ payments: [], forumInvoices: [], shopCharges: [] }, nowMs);
    expect(body.asOf).toBeNull();
    expect(body.totals).toEqual({
      paymentCount: 0,
      volumeSats: 0,
      feeSats: 0,
      medianSats: 0,
      averageSats: 0,
      activeWalletCount: 0,
      sendingWalletCount: 0,
      topFiveSenderShare: 0,
      heartCount: 0,
      paidShopChargeCount: 0,
    });
    expect(body.days).toEqual([
      {
        day: '2026-11-09',
        purposes: purposes(),
        activeWalletCount: 0,
        sendingWalletCount: 0,
        receivingWalletCount: 0,
      },
    ]);
    expect(body.flows).toEqual([]);
    expect(body.forum.map((row) => row.day)).toEqual(
      dayKeys(walletUsageReadSince().forumInvoices, nowMs),
    );
    expect(body.shopCharges.map((row) => row.day)).toEqual(
      dayKeys(walletUsageReadSince().shopCharges, nowMs),
    );
    expect(body.hours).toHaveLength(24);
    expect(body.amountBuckets).toHaveLength(7);
  });

  it('returns empty series when the clock is before every window', () => {
    const nowMs = Date.parse('2026-10-01T00:00:00.000Z');
    const body = buildWalletUsage(
      {
        payments: [
          pay({
            paidAt: new Date('2026-10-01T00:00:00.000Z'),
            amountSats: 5,
            category: 'member',
            payerAccountId: 'early-payer',
            payerParty: 'members',
            payeeAccountId: null,
            payeeParty: 'outside',
          }),
          pay({ paidAt: new Date('2026-10-02T00:00:00.000Z'), amountSats: 9 }),
        ],
        forumInvoices: [
          { createdAt: new Date('2026-10-01T00:00:00.000Z'), amountSats: 3, heart: true },
          { createdAt: new Date('2026-10-02T00:00:00.000Z'), amountSats: 8, heart: true },
        ],
        shopCharges: [
          { createdAt: new Date('2026-10-01T00:00:00.000Z'), status: 'paid' },
          { createdAt: new Date('2026-10-02T00:00:00.000Z'), status: 'paid' },
        ],
      },
      nowMs,
    );
    expect(body.days).toEqual([]);
    expect(body.forum).toEqual([]);
    expect(body.shopCharges).toEqual([]);
    expect(body.totals.paymentCount).toBe(1);
    expect(body.totals.volumeSats).toBe(5);
    expect(body.totals.medianSats).toBe(5);
    expect(body.totals.averageSats).toBe(5);
    expect(body.totals.topFiveSenderShare).toBe(1);
    expect(body.totals.heartCount).toBe(0);
    expect(body.totals.paidShopChargeCount).toBe(0);
    expect(body.asOf).toBe('2026-10-01T00:00:00.000Z');
    expect(body.flows).toHaveLength(1);
  });

  it('places every amount edge in the matching bucket and ignores 0', () => {
    const amounts = [0, 1, 2, 10, 11, 100, 101, 1000, 1001, 10000, 10001, 100000, 100001];
    const body = buildWalletUsage(
      {
        payments: amounts.map((amountSats, index) =>
          pay({
            paidAt: new Date(Date.UTC(2026, 10, 11, index, 0, 0)),
            amountSats,
            payerAccountId: null,
            payerParty: 'outside',
          }),
        ),
        forumInvoices: [],
        shopCharges: [],
      },
      NOW,
    );
    expect(body.totals.paymentCount).toBe(13);
    expect(body.totals.volumeSats).toBe(222228);
    expect(body.totals.medianSats).toBe(101);
    expect(body.totals.averageSats).toBe(17094);
    expect(body.totals.topFiveSenderShare).toBe(0);
    expect(body.amountBuckets.map((bucket) => [bucket.key, bucket.count, bucket.sats])).toEqual([
      ['1', 1, 1],
      ['2-10', 2, 12],
      ['11-100', 2, 111],
      ['101-1k', 2, 1101],
      ['1k-10k', 2, 11001],
      ['10k-100k', 2, 110001],
      ['100k+', 1, 100001],
    ]);
  });

  it('merges a repeated flow and rounds an even median down', () => {
    const lowFirst = buildWalletUsage(
      {
        payments: [
          pay({ amountSats: 1, feeSats: 1, category: 'shop' }),
          pay({ amountSats: 4, feeSats: 2, category: 'shop' }),
        ],
        forumInvoices: [],
        shopCharges: [],
      },
      NOW,
    );
    expect(lowFirst.totals.medianSats).toBe(2);
    expect(lowFirst.flows).toEqual([
      {
        day: '2026-11-11',
        from: 'members',
        to: 'members',
        purpose: 'shop_purchase',
        count: 2,
        sats: 5,
        feeSats: 3,
      },
    ]);
    const highFirst = buildWalletUsage(
      {
        payments: [pay({ amountSats: 2 }), pay({ amountSats: 1 })],
        forumInvoices: [],
        shopCharges: [],
      },
      NOW,
    );
    expect(highFirst.totals.medianSats).toBe(1);
  });

  it('reports the top five sender share for equal and unequal payers', () => {
    const ids = ['p5', 'p4', 'p3', 'p2', 'p1', 'p0'];
    const equal = buildWalletUsage(
      {
        payments: ids.map((payerAccountId) => pay({ amountSats: 1, payerAccountId })),
        forumInvoices: [],
        shopCharges: [],
      },
      NOW,
    );
    expect(equal.totals.topFiveSenderShare).toBe(0.8333);
    const ascending = buildWalletUsage(
      {
        payments: [
          pay({ amountSats: 10, payerAccountId: 'payer-small' }),
          pay({ amountSats: 50, payerAccountId: 'payer-big' }),
        ],
        forumInvoices: [],
        shopCharges: [],
      },
      NOW,
    );
    expect(ascending.totals.topFiveSenderShare).toBe(1);
    const odd = buildWalletUsage(
      {
        payments: [pay({ amountSats: 3 }), pay({ amountSats: 1 }), pay({ amountSats: 2 })],
        forumInvoices: [],
        shopCharges: [],
      },
      NOW,
    );
    expect(odd.totals.medianSats).toBe(2);
    expect(odd.totals.averageSats).toBe(2);
  });

  it('throws when a sat amount is not a safe non-negative integer', () => {
    const huge = Number.MAX_SAFE_INTEGER;
    const overflow = {
      payments: [
        pay({ paidAt: new Date('2026-11-11T00:00:00.000Z'), amountSats: huge }),
        pay({ paidAt: new Date('2026-11-12T00:00:00.000Z'), amountSats: huge }),
      ],
      forumInvoices: [],
      shopCharges: [],
    };
    expect(() => buildWalletUsage(overflow, NOW)).toThrow(
      'wallet sats total exceeds Number.MAX_SAFE_INTEGER',
    );
    expect(() =>
      buildWalletUsage(
        { payments: [pay({ amountSats: -1 })], forumInvoices: [], shopCharges: [] },
        NOW,
      ),
    ).toThrow('wallet sats total exceeds Number.MAX_SAFE_INTEGER');
    expect(() =>
      buildWalletUsage(
        { payments: [pay({ amountSats: 1.5 })], forumInvoices: [], shopCharges: [] },
        NOW,
      ),
    ).toThrow('wallet sats total exceeds Number.MAX_SAFE_INTEGER');
  });
});
