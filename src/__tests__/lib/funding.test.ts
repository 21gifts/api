import { describe, expect, it } from 'vitest';
import type { AccountRole } from '@/lib/auth/store';
import type { FundingGrant, FundingStatus } from '@/lib/funding';
import {
  effectiveStatus,
  eligibleToday,
  fundingReviewedAt,
  serializeOwnerFunding,
} from '@/lib/funding';

const NOW_MS = Date.parse('2026-09-20T12:00:00.000Z');
const TODAY = '2026-09-20';
const YESTERDAY = '2026-09-19';
const TOMORROW = '2026-09-21';
const NON_BASIS: AccountRole = 'verified';

function grant(overrides: Partial<FundingGrant> = {}): FundingGrant {
  return {
    accountId: 'acc',
    status: 'pending',
    appliedAt: Date.parse('2026-09-01T00:00:00.000Z'),
    decidedAt: null,
    decidedBy: null,
    trialUtcDate: null,
    admittedAt: null,
    note: null,
    ...overrides,
  };
}

function trial(trialUtcDate: string | null): FundingGrant {
  return grant({ status: 'trial', trialUtcDate });
}

describe('effectiveStatus', () => {
  it('returns none when the grant is missing', () => {
    expect(effectiveStatus(undefined, NOW_MS)).toBe('none');
  });

  it('returns pending for a stored pending grant', () => {
    expect(effectiveStatus(grant({ status: 'pending' }), NOW_MS)).toBe('pending');
  });

  it('returns trial when trialUtcDate is today UTC', () => {
    expect(effectiveStatus(trial(TODAY), NOW_MS)).toBe('trial');
  });

  it('returns pending when trialUtcDate is strictly before today UTC', () => {
    expect(effectiveStatus(trial(YESTERDAY), NOW_MS)).toBe('pending');
  });

  it('returns trial when trialUtcDate is after today UTC', () => {
    expect(effectiveStatus(trial(TOMORROW), NOW_MS)).toBe('trial');
  });

  it('does not expire a trial whose trialUtcDate is null', () => {
    expect(effectiveStatus(trial(null), NOW_MS)).toBe('trial');
  });

  it('returns admitted and rejected unchanged', () => {
    expect(effectiveStatus(grant({ status: 'admitted' }), NOW_MS)).toBe('admitted');
    expect(effectiveStatus(grant({ status: 'rejected' }), NOW_MS)).toBe('rejected');
  });
});

describe('eligibleToday', () => {
  it('is false when the grant is missing, for basis and non-basis', () => {
    expect(eligibleToday(NON_BASIS, undefined, NOW_MS)).toBe(false);
    expect(eligibleToday('basis', undefined, NOW_MS)).toBe(false);
  });

  it('is always false for basis, even when admitted or trial today', () => {
    expect(eligibleToday('basis', grant({ status: 'admitted' }), NOW_MS)).toBe(false);
    expect(eligibleToday('basis', trial(TODAY), NOW_MS)).toBe(false);
  });

  it('is false for a pending grant on a non-basis role', () => {
    expect(eligibleToday(NON_BASIS, grant({ status: 'pending' }), NOW_MS)).toBe(false);
  });

  it('is true for a non-basis trial on today UTC', () => {
    expect(eligibleToday(NON_BASIS, trial(TODAY), NOW_MS)).toBe(true);
  });

  it('is false for a trial whose day is yesterday', () => {
    expect(eligibleToday(NON_BASIS, trial(YESTERDAY), NOW_MS)).toBe(false);
  });

  it('is false for a trial whose day is tomorrow', () => {
    expect(eligibleToday(NON_BASIS, trial(TOMORROW), NOW_MS)).toBe(false);
  });

  it('is true for admitted on a non-basis role and false for basis', () => {
    const admitted = grant({
      status: 'admitted',
      admittedAt: NOW_MS,
    });
    expect(eligibleToday(NON_BASIS, admitted, NOW_MS)).toBe(true);
    expect(eligibleToday('basis', admitted, NOW_MS)).toBe(false);
  });

  it('is false for rejected', () => {
    expect(eligibleToday(NON_BASIS, grant({ status: 'rejected' }), NOW_MS)).toBe(false);
  });
});

describe('effectiveStatus and eligibleToday matrix', () => {
  it('covers stored statuses for verified vs basis', () => {
    const cases: Array<{
      status: FundingStatus;
      trialUtcDate: string | null;
      effective: ReturnType<typeof effectiveStatus>;
      eligibleVerified: boolean;
    }> = [
      { status: 'pending', trialUtcDate: null, effective: 'pending', eligibleVerified: false },
      { status: 'trial', trialUtcDate: TODAY, effective: 'trial', eligibleVerified: true },
      { status: 'trial', trialUtcDate: YESTERDAY, effective: 'pending', eligibleVerified: false },
      { status: 'trial', trialUtcDate: TOMORROW, effective: 'trial', eligibleVerified: false },
      { status: 'admitted', trialUtcDate: null, effective: 'admitted', eligibleVerified: true },
      { status: 'rejected', trialUtcDate: null, effective: 'rejected', eligibleVerified: false },
    ];
    for (const row of cases) {
      const stored = grant({ status: row.status, trialUtcDate: row.trialUtcDate });
      expect(effectiveStatus(stored, NOW_MS)).toBe(row.effective);
      expect(eligibleToday(NON_BASIS, stored, NOW_MS)).toBe(row.eligibleVerified);
      expect(eligibleToday('basis', stored, NOW_MS)).toBe(false);
    }
  });
});

describe('serializeOwnerFunding', () => {
  it('is null for basis', () => {
    expect(serializeOwnerFunding('basis', grant({ status: 'admitted' }), NOW_MS, 'Mod')).toBeNull();
  });

  it('emits none when the grant is missing', () => {
    expect(serializeOwnerFunding(NON_BASIS, undefined, NOW_MS, null)).toEqual({
      status: 'none',
      trialUtcDate: null,
      admittedAt: null,
      reviewedByName: null,
    });
  });

  it('keeps trialUtcDate null when the stored trial day is null', () => {
    expect(serializeOwnerFunding(NON_BASIS, trial(null), NOW_MS, null)).toEqual({
      status: 'trial',
      trialUtcDate: null,
      admittedAt: null,
      reviewedByName: null,
    });
  });

  it('keeps admittedAt null when admission has no timestamp', () => {
    expect(
      serializeOwnerFunding(
        NON_BASIS,
        grant({ status: 'admitted', admittedAt: null }),
        NOW_MS,
        'Mod',
      ),
    ).toEqual({
      status: 'admitted',
      trialUtcDate: null,
      admittedAt: null,
      reviewedByName: 'Mod',
    });
  });
});

describe('fundingReviewedAt', () => {
  it('is null unless the effective status is admitted', () => {
    expect(fundingReviewedAt(undefined, NOW_MS)).toBeNull();
    expect(fundingReviewedAt(grant({ status: 'pending', admittedAt: NOW_MS }), NOW_MS)).toBeNull();
  });

  it('returns null when admitted but admittedAt is missing', () => {
    expect(fundingReviewedAt(grant({ status: 'admitted', admittedAt: null }), NOW_MS)).toBeNull();
  });

  it('returns admittedAt when admitted', () => {
    expect(fundingReviewedAt(grant({ status: 'admitted', admittedAt: NOW_MS }), NOW_MS)).toBe(
      NOW_MS,
    );
  });
});
