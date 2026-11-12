import { describe, expect, it } from 'vitest';
import type { Account } from '@/lib/auth/store';
import type { FundingGrant } from '@/lib/funding';
import type { FundingPayoutTodayDeps, FundingPayoutTodayReason } from '@/lib/funding-payout-today';
import { loadFundingPayoutToday } from '@/lib/funding-payout-today';
import type { GiftRow } from '@/lib/gift';

const NOW = Date.parse('2026-11-12T12:00:00.000Z');

const ADMITTED: FundingGrant = {
  accountId: 'account',
  status: 'admitted',
  appliedAt: 1,
  decidedAt: 2,
  decidedBy: null,
  trialUtcDate: null,
  admittedAt: 2,
  note: null,
};

type ScenarioOptions = {
  gifts?: readonly GiftRow[];
  role?: Account['role'];
  username?: string | null;
  grant?: FundingGrant | undefined;
  wallet?: boolean;
  recoveryRequired?: boolean;
  recovery?: boolean;
  shop?: boolean;
  media?: 'today' | 'old' | 'none';
  payments?: boolean;
};

function scenario(options: ScenarioOptions = {}): {
  account: Pick<Account, 'id' | 'role' | 'username' | 'sparkPubkeyVerifiedAt'>;
  deps: FundingPayoutTodayDeps;
  reads: string[];
} {
  const reads: string[] = [];
  const media = options.media ?? 'today';
  return {
    account: {
      id: 'account',
      role: options.role ?? 'verified',
      username: options.username === undefined ? 'Alice' : options.username,
      sparkPubkeyVerifiedAt: options.wallet === false ? null : NOW,
    },
    deps: {
      gifts: {
        listOutbound: async () => {
          reads.push('gifts');
          return [...(options.gifts ?? [])];
        },
      },
      funding: {
        getByAccountId: async () => {
          reads.push('funding');
          return 'grant' in options ? options.grant : ADMITTED;
        },
      },
      auth: {
        hasRecoveryShareForVerifiedWallet: async () => {
          reads.push('recovery');
          return options.recovery ?? true;
        },
      },
      transfers: {
        hasShopPayment: async () => {
          reads.push('shop');
          return options.shop ?? true;
        },
      },
      messages: {
        latestLiveTopLevelMediaId: async () => {
          reads.push('media_latest');
          return media === 'none' ? null : 'message';
        },
        getById: async () => {
          reads.push('media_row');
          return {
            createdAt: new Date(media === 'old' ? '2026-11-11T23:59:59.999Z' : NOW),
          } as never;
        },
      },
      roster: {
        get: async () => {
          reads.push('roster');
          return { paymentsEnabled: options.payments ?? true } as never;
        },
      },
      recoveryShareRequiredFrom: options.recoveryRequired === false ? null : '2026-11-12',
    },
    reads,
  };
}

function gift(kind: 'daily' | 'welcome', day = '2026-11-12'): GiftRow {
  return {
    paidAt: new Date(`${day}T08:00:00.000Z`),
    amountSats: 21,
    recipientWosUser: ' alice@21.gifts ',
    kind,
  };
}

describe('loadFundingPayoutToday', () => {
  it('reports a recorded daily payout before reading any condition', async () => {
    const { account, deps, reads } = scenario({
      gifts: [gift('welcome'), gift('daily')],
      role: 'basis',
    });
    await expect(loadFundingPayoutToday(deps, account, NOW)).resolves.toEqual({
      state: 'paid',
      reason: null,
    });
    expect(reads).toEqual(['gifts']);
  });

  it('reports a same-day welcome gift when no daily payout exists', async () => {
    const { account, deps, reads } = scenario({
      gifts: [gift('daily', '2026-11-11'), gift('welcome')],
    });
    await expect(loadFundingPayoutToday(deps, account, NOW)).resolves.toEqual({
      state: 'paid',
      reason: 'welcome',
    });
    expect(reads).toEqual(['gifts']);
  });

  const blockers: Array<{
    name: string;
    options: ScenarioOptions;
    reason: FundingPayoutTodayReason;
    reads: string[];
  }> = [
    {
      name: 'verify',
      options: { role: 'basis', username: null },
      reason: 'verify',
      reads: ['gifts'],
    },
    {
      name: 'admission',
      options: { grant: undefined },
      reason: 'admission',
      reads: ['gifts', 'funding'],
    },
    {
      name: 'wallet',
      options: { wallet: false },
      reason: 'wallet',
      reads: ['gifts', 'funding'],
    },
    {
      name: 'recovery share',
      options: { recovery: false },
      reason: 'recovery_share',
      reads: ['gifts', 'funding', 'recovery'],
    },
    {
      name: 'shop payment',
      options: { shop: false },
      reason: 'shop_payment',
      reads: ['gifts', 'funding', 'recovery', 'shop'],
    },
    {
      name: 'media post without any media',
      options: { media: 'none' },
      reason: 'media_post',
      reads: ['gifts', 'funding', 'recovery', 'shop', 'media_latest'],
    },
    {
      name: 'media post from an older UTC day',
      options: { media: 'old' },
      reason: 'media_post',
      reads: ['gifts', 'funding', 'recovery', 'shop', 'media_latest', 'media_row'],
    },
  ];

  it.each(blockers)(
    'stops at the first missing $name condition',
    async ({ options, reason, reads }) => {
      const built = scenario(options);
      await expect(loadFundingPayoutToday(built.deps, built.account, NOW)).resolves.toEqual({
        state: 'blocked',
        reason,
      });
      expect(built.reads).toEqual(reads);
    },
  );

  it('skips the recovery read before its required day and reports due', async () => {
    const { account, deps, reads } = scenario({ recoveryRequired: false });
    await expect(loadFundingPayoutToday(deps, account, NOW)).resolves.toEqual({
      state: 'due',
      reason: null,
    });
    expect(reads).toEqual(['gifts', 'funding', 'shop', 'media_latest', 'media_row', 'roster']);
  });

  it('reports the payments switch only after every payout condition holds', async () => {
    const { account, deps, reads } = scenario({ payments: false });
    await expect(loadFundingPayoutToday(deps, account, NOW)).resolves.toEqual({
      state: 'due',
      reason: 'payments_paused',
    });
    expect(reads).toEqual([
      'gifts',
      'funding',
      'recovery',
      'shop',
      'media_latest',
      'media_row',
      'roster',
    ]);
  });

  it('reports due with no reason when all conditions and the payment switch hold', async () => {
    const { account, deps } = scenario();
    await expect(loadFundingPayoutToday(deps, account, NOW)).resolves.toEqual({
      state: 'due',
      reason: null,
    });
  });

  it('propagates a store failure for the owner route to turn into unknown', async () => {
    const { account, deps } = scenario();
    deps.gifts.listOutbound = async () => {
      throw new Error('ledger unavailable');
    };
    await expect(loadFundingPayoutToday(deps, account, NOW)).rejects.toThrow('ledger unavailable');
  });
});
