import { describe, expect, it } from 'vitest';
import type { AccountRole } from '@/lib/auth/store';
import type { FundingGrant, FundingStatus } from '@/lib/funding';
import {
  FUNDING_REQUIRED_FROM_UTC,
  dailyPayoutStoppedNotice,
  effectiveStatus,
  eligibleToday,
  fundingGrantRequired,
  fundingReviewedAt,
  serializeOwnerFunding,
} from '@/lib/funding';

const NOW_MS = Date.parse('2026-09-20T12:00:00.000Z');
const TODAY = '2026-09-20';
const YESTERDAY = '2026-09-19';
const TOMORROW = '2026-09-21';
const GATE_MS = Date.parse(`${FUNDING_REQUIRED_FROM_UTC}T00:00:00.000Z`);
const GATE_TODAY = FUNDING_REQUIRED_FROM_UTC;
const GATE_YESTERDAY = '2026-09-30';
const GATE_TOMORROW = '2026-10-02';
const BEFORE_GATE_MS = Date.parse('2026-09-30T23:59:59.999Z');
const NON_BASIS: AccountRole = 'verified';

/** The six legacy daily-spend accounts that never applied. */
const NOTICE_IDS = [
  '14101481-f421-42ef-9d37-6df3ccb6b25f',
  '1b7ab8d9-c1f2-4a8e-be3f-bf16d3d7588d',
  '227d1574-c784-4b40-a83f-0e5a8ed90cc3',
  '35a841ac-0a3c-4f88-b876-01aa8d0bf3da',
  '815c65d4-1360-426b-b1a5-9ffa994091ca',
  'a29227aa-e7c8-41ea-bd59-f1b3ab4c560a',
] as const;

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

describe('fundingGrantRequired', () => {
  it('is false before 2026-10-01 UTC and true from that midnight onward', () => {
    expect(fundingGrantRequired(BEFORE_GATE_MS)).toBe(false);
    expect(fundingGrantRequired(GATE_MS)).toBe(true);
    expect(fundingGrantRequired(Date.parse(`${GATE_TOMORROW}T00:00:00.000Z`))).toBe(true);
  });
});

describe('eligibleToday', () => {
  it('is true for non-basis without a grant before the gate day', () => {
    expect(eligibleToday(NON_BASIS, undefined, BEFORE_GATE_MS)).toBe(true);
    expect(eligibleToday(NON_BASIS, grant({ status: 'pending' }), BEFORE_GATE_MS)).toBe(true);
    expect(eligibleToday(NON_BASIS, grant({ status: 'rejected' }), BEFORE_GATE_MS)).toBe(true);
  });

  it('is always false for basis, including before the gate day', () => {
    expect(eligibleToday('basis', undefined, BEFORE_GATE_MS)).toBe(false);
    expect(eligibleToday('basis', grant({ status: 'admitted' }), GATE_MS)).toBe(false);
    expect(eligibleToday('basis', trial(GATE_TODAY), GATE_MS)).toBe(false);
  });

  it('is false when the grant is missing, from the gate day', () => {
    expect(eligibleToday(NON_BASIS, undefined, GATE_MS)).toBe(false);
    expect(eligibleToday(NON_BASIS, undefined, Date.parse(`${GATE_TOMORROW}T00:00:00.000Z`))).toBe(
      false,
    );
  });

  it('keeps admitted true and basis false the day after the gate', () => {
    const after = Date.parse(`${GATE_TOMORROW}T00:00:00.000Z`);
    const admitted = grant({ status: 'admitted', admittedAt: GATE_MS });
    expect(eligibleToday(NON_BASIS, admitted, after)).toBe(true);
    expect(eligibleToday('basis', admitted, after)).toBe(false);
  });

  it('is false for a pending grant on a non-basis role, from the gate day', () => {
    expect(eligibleToday(NON_BASIS, grant({ status: 'pending' }), GATE_MS)).toBe(false);
  });

  it('is true for a non-basis trial on the gate UTC day', () => {
    expect(eligibleToday(NON_BASIS, trial(GATE_TODAY), GATE_MS)).toBe(true);
  });

  it('is false for a trial whose day is yesterday, from the gate day', () => {
    expect(eligibleToday(NON_BASIS, trial(GATE_YESTERDAY), GATE_MS)).toBe(false);
  });

  it('is false for a trial whose day is tomorrow, from the gate day', () => {
    expect(eligibleToday(NON_BASIS, trial(GATE_TOMORROW), GATE_MS)).toBe(false);
  });

  it('is true for admitted on a non-basis role and false for basis', () => {
    const admitted = grant({
      status: 'admitted',
      admittedAt: GATE_MS,
    });
    expect(eligibleToday(NON_BASIS, admitted, GATE_MS)).toBe(true);
    expect(eligibleToday('basis', admitted, GATE_MS)).toBe(false);
  });

  it('is false for rejected, from the gate day', () => {
    expect(eligibleToday(NON_BASIS, grant({ status: 'rejected' }), GATE_MS)).toBe(false);
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
      { status: 'trial', trialUtcDate: GATE_TODAY, effective: 'trial', eligibleVerified: true },
      {
        status: 'trial',
        trialUtcDate: GATE_YESTERDAY,
        effective: 'pending',
        eligibleVerified: false,
      },
      { status: 'trial', trialUtcDate: GATE_TOMORROW, effective: 'trial', eligibleVerified: false },
      { status: 'admitted', trialUtcDate: null, effective: 'admitted', eligibleVerified: true },
      { status: 'rejected', trialUtcDate: null, effective: 'rejected', eligibleVerified: false },
    ];
    for (const row of cases) {
      const stored = grant({ status: row.status, trialUtcDate: row.trialUtcDate });
      expect(effectiveStatus(stored, GATE_MS)).toBe(row.effective);
      expect(eligibleToday(NON_BASIS, stored, GATE_MS)).toBe(row.eligibleVerified);
      expect(eligibleToday('basis', stored, GATE_MS)).toBe(false);
    }
  });
});

describe('dailyPayoutStoppedNotice', () => {
  it('is true for each of the six listed accounts with no grant', () => {
    for (const id of NOTICE_IDS) {
      expect(dailyPayoutStoppedNotice(id, undefined, NOW_MS)).toBe(true);
    }
  });

  it('is false for a listed account with pending, trial, admitted, or rejected', () => {
    const id = NOTICE_IDS[0];
    expect(dailyPayoutStoppedNotice(id, grant({ status: 'pending' }), NOW_MS)).toBe(false);
    expect(dailyPayoutStoppedNotice(id, trial(TODAY), NOW_MS)).toBe(false);
    expect(dailyPayoutStoppedNotice(id, grant({ status: 'admitted' }), NOW_MS)).toBe(false);
    expect(dailyPayoutStoppedNotice(id, grant({ status: 'rejected' }), NOW_MS)).toBe(false);
  });

  it('is false for some other account id with no grant', () => {
    expect(dailyPayoutStoppedNotice('other-account-id', undefined, NOW_MS)).toBe(false);
  });

  it('is false for an empty account id', () => {
    expect(dailyPayoutStoppedNotice('', undefined, NOW_MS)).toBe(false);
  });
});

describe('serializeOwnerFunding', () => {
  it('is null for basis', () => {
    expect(
      serializeOwnerFunding('basis', grant({ status: 'admitted' }), NOW_MS, 'Mod', NOTICE_IDS[0]),
    ).toBeNull();
  });

  it('emits none when the grant is missing', () => {
    expect(serializeOwnerFunding(NON_BASIS, undefined, NOW_MS, null, 'acc')).toEqual({
      status: 'none',
      trialUtcDate: null,
      admittedAt: null,
      reviewedByName: null,
      dailyPayoutStoppedNotice: false,
    });
  });

  it('sets dailyPayoutStoppedNotice true for a listed id with no grant', () => {
    expect(serializeOwnerFunding(NON_BASIS, undefined, NOW_MS, null, NOTICE_IDS[0])).toEqual({
      status: 'none',
      trialUtcDate: null,
      admittedAt: null,
      reviewedByName: null,
      dailyPayoutStoppedNotice: true,
    });
  });

  it('sets dailyPayoutStoppedNotice false for a listed id with pending', () => {
    expect(
      serializeOwnerFunding(NON_BASIS, grant({ status: 'pending' }), NOW_MS, null, NOTICE_IDS[0]),
    ).toEqual({
      status: 'pending',
      trialUtcDate: null,
      admittedAt: null,
      reviewedByName: null,
      dailyPayoutStoppedNotice: false,
    });
  });

  it('keeps trialUtcDate null when the stored trial day is null', () => {
    expect(serializeOwnerFunding(NON_BASIS, trial(null), NOW_MS, null, 'acc')).toEqual({
      status: 'trial',
      trialUtcDate: null,
      admittedAt: null,
      reviewedByName: null,
      dailyPayoutStoppedNotice: false,
    });
  });

  it('keeps admittedAt null when admission has no timestamp', () => {
    expect(
      serializeOwnerFunding(
        NON_BASIS,
        grant({ status: 'admitted', admittedAt: null }),
        NOW_MS,
        'Mod',
        'acc',
      ),
    ).toEqual({
      status: 'admitted',
      trialUtcDate: null,
      admittedAt: null,
      reviewedByName: 'Mod',
      dailyPayoutStoppedNotice: false,
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
