import { describe, expect, it, vi } from 'vitest';
import type { AccountRole } from '@/lib/auth/store';
import { FUNDING_REQUIRED_FROM_UTC, type FundingGrant } from '@/lib/funding';
import { loadPayoutEligibility } from '@/lib/payout-eligibility';

const GATE_MS = Date.parse(`${FUNDING_REQUIRED_FROM_UTC}T12:00:00.000Z`);
const BEFORE_GATE_MS = Date.parse('2026-09-30T23:59:59.999Z');
const GATE_DAY = FUNDING_REQUIRED_FROM_UTC;

function grant(partial: Partial<FundingGrant> = {}): FundingGrant {
  return {
    accountId: 'acc',
    status: 'admitted',
    appliedAt: 1,
    decidedAt: 2,
    decidedBy: 'staff',
    trialUtcDate: null,
    admittedAt: 2,
    note: null,
    ...partial,
  };
}

function stores(stored: FundingGrant | undefined, share: boolean | Error) {
  const getByAccountId = vi.fn(async () => stored);
  const hasRecoveryShareForVerifiedWallet = vi.fn(async () => {
    if (share instanceof Error) {
      throw share;
    }
    return share;
  });
  return {
    fundingStore: { getByAccountId },
    auth: { hasRecoveryShareForVerifiedWallet },
    getByAccountId,
    hasRecoveryShareForVerifiedWallet,
  };
}

async function load(
  role: AccountRole,
  stored: FundingGrant | undefined,
  share: boolean | Error,
  nowMs: number,
  requiredFrom: string | null = FUNDING_REQUIRED_FROM_UTC,
): Promise<{ result: Awaited<ReturnType<typeof loadPayoutEligibility>>; shareReads: number }> {
  const s = stores(stored, share);
  const result = await loadPayoutEligibility(
    s.fundingStore,
    s.auth,
    { id: 'acc', role },
    nowMs,
    requiredFrom,
  );
  expect(s.getByAccountId).toHaveBeenCalledWith('acc');
  if (s.hasRecoveryShareForVerifiedWallet.mock.calls.length > 0) {
    expect(s.hasRecoveryShareForVerifiedWallet).toHaveBeenCalledWith('acc');
  }
  return { result, shareReads: s.hasRecoveryShareForVerifiedWallet.mock.calls.length };
}

describe('loadPayoutEligibility', () => {
  it('lazily reads the recent shop payment and returns its refusal reason', async () => {
    const admitted = grant();
    const s = stores(admitted, true);
    const hasShopPayment = vi.fn(async () => false);
    await expect(
      loadPayoutEligibility(
        s.fundingStore,
        s.auth,
        { id: 'acc', role: 'verified' },
        GATE_MS,
        GATE_DAY,
        { hasShopPayment },
      ),
    ).resolves.toEqual({ grant: admitted, eligible: false, reason: 'no_shop_payment' });
    expect(hasShopPayment).toHaveBeenCalledWith('acc', '2026-09-30', '2026-10-01');
  });

  it('does not read shop transfers when the grant already refuses', async () => {
    const s = stores(undefined, true);
    const hasShopPayment = vi.fn(async () => true);
    const result = await loadPayoutEligibility(
      s.fundingStore,
      s.auth,
      { id: 'acc', role: 'verified' },
      GATE_MS,
      GATE_DAY,
      { hasShopPayment },
    );
    expect(result.eligible).toBe(false);
    expect(hasShopPayment).not.toHaveBeenCalled();
  });

  it('keeps an otherwise eligible member eligible after a recent shop payment', async () => {
    const admitted = grant();
    const s = stores(admitted, true);
    const hasShopPayment = vi.fn(async () => true);
    await expect(
      loadPayoutEligibility(
        s.fundingStore,
        s.auth,
        { id: 'acc', role: 'verified' },
        GATE_MS,
        GATE_DAY,
        { hasShopPayment },
      ),
    ).resolves.toEqual({ grant: admitted, eligible: true });
    expect(hasShopPayment).toHaveBeenCalledOnce();
  });
  it('reads the share for an admitted member on a gated day and needs it', async () => {
    const admitted = grant();
    expect(await load('verified', admitted, true, GATE_MS)).toEqual({
      result: { grant: admitted, eligible: true },
      shareReads: 1,
    });
    expect(await load('verified', admitted, false, GATE_MS)).toEqual({
      result: { grant: admitted, eligible: false },
      shareReads: 1,
    });
  });

  it("reads the share for today's trial on a gated day", async () => {
    const trial = grant({ status: 'trial', trialUtcDate: GATE_DAY, admittedAt: null });
    expect(await load('moderator', trial, true, GATE_MS)).toEqual({
      result: { grant: trial, eligible: true },
      shareReads: 1,
    });
    expect(await load('moderator', trial, false, GATE_MS)).toEqual({
      result: { grant: trial, eligible: false },
      shareReads: 1,
    });
  });

  it('skips the share read for basis', async () => {
    expect(await load('basis', grant(), true, GATE_MS)).toEqual({
      result: { grant: grant(), eligible: false },
      shareReads: 0,
    });
    expect(await load('basis', undefined, true, BEFORE_GATE_MS)).toEqual({
      result: { grant: undefined, eligible: false },
      shareReads: 0,
    });
  });

  it('skips the share read before the gate day, where every non-basis role is eligible', async () => {
    expect(await load('verified', undefined, false, BEFORE_GATE_MS)).toEqual({
      result: { grant: undefined, eligible: true },
      shareReads: 0,
    });
    expect(await load('verified', grant(), false, BEFORE_GATE_MS)).toEqual({
      result: { grant: grant(), eligible: true },
      shareReads: 0,
    });
  });

  it('skips the share read for accounts not in the grant program today', async () => {
    for (const stored of [
      undefined,
      grant({ status: 'pending', admittedAt: null }),
      grant({ status: 'rejected', admittedAt: null }),
      grant({ status: 'trial', trialUtcDate: '2026-09-30', admittedAt: null }),
      grant({ status: 'trial', trialUtcDate: '2026-10-02', admittedAt: null }),
    ]) {
      expect(await load('verified', stored, true, GATE_MS)).toEqual({
        result: { grant: stored, eligible: false },
        shareReads: 0,
      });
    }
  });

  it('is not eligible for a withdrawn grant from the moment it is written', async () => {
    for (const stored of [
      grant({ status: 'withdrawn', admittedAt: null, decidedAt: GATE_MS - 1, decidedBy: 'acc' }),
      grant({ status: 'withdrawn', admittedAt: 2, trialUtcDate: GATE_DAY }),
    ]) {
      for (const role of ['verified', 'fond'] as const) {
        expect(await load(role, stored, true, GATE_MS)).toEqual({
          result: { grant: stored, eligible: false },
          shareReads: 0,
        });
      }
    }
  });

  it('propagates a grant read failure without reading the share', async () => {
    const hasRecoveryShareForVerifiedWallet = vi.fn(async () => true);
    await expect(
      loadPayoutEligibility(
        {
          getByAccountId: async () => {
            throw new Error('grant down');
          },
        },
        { hasRecoveryShareForVerifiedWallet },
        { id: 'acc', role: 'verified' },
        GATE_MS,
        GATE_DAY,
      ),
    ).rejects.toThrow('grant down');
    expect(hasRecoveryShareForVerifiedWallet).not.toHaveBeenCalled();
  });

  it('propagates a share read failure', async () => {
    await expect(load('verified', grant(), new Error('share down'), GATE_MS)).rejects.toThrow(
      'share down',
    );
  });

  describe('with its own start day', () => {
    const FROM = '2026-11-20';
    const DAY_BEFORE_MS = Date.parse('2026-11-19T23:59:59.999Z');
    const START_DAY_MS = Date.parse('2026-11-20T00:00:00.000Z');

    it('pays without reading the share on the day before', async () => {
      const admitted = grant();
      expect(await load('verified', admitted, false, DAY_BEFORE_MS, FROM)).toEqual({
        result: { grant: admitted, eligible: true },
        shareReads: 0,
      });
    });

    it('reads and needs the share on the start day', async () => {
      const admitted = grant();
      expect(await load('verified', admitted, false, START_DAY_MS, FROM)).toEqual({
        result: { grant: admitted, eligible: false },
        shareReads: 1,
      });
      expect(await load('verified', admitted, true, START_DAY_MS, FROM)).toEqual({
        result: { grant: admitted, eligible: true },
        shareReads: 1,
      });
    });

    it('pays without reading the share when unset', async () => {
      const admitted = grant();
      expect(await load('verified', admitted, false, START_DAY_MS, null)).toEqual({
        result: { grant: admitted, eligible: true },
        shareReads: 0,
      });
    });

    it('keeps the grant gate while the share is not required', async () => {
      expect(await load('verified', undefined, false, DAY_BEFORE_MS, FROM)).toEqual({
        result: { grant: undefined, eligible: false },
        shareReads: 0,
      });
      expect(await load('basis', grant(), false, START_DAY_MS, null)).toEqual({
        result: { grant: grant(), eligible: false },
        shareReads: 0,
      });
    });
  });
});
