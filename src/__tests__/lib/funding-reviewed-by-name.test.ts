import { describe, expect, it } from 'vitest';
import { fundingReviewedByName, type FundingGrant } from '@/lib/funding';

const admitted: FundingGrant = {
  accountId: 'member',
  status: 'admitted',
  appliedAt: 1,
  decidedAt: 2,
  decidedBy: 'staff',
  trialUtcDate: null,
  admittedAt: 3,
  note: null,
};

describe('fundingReviewedByName', () => {
  it('returns the trimmed live name only when admitted', async () => {
    const name = await fundingReviewedByName(admitted, 3, async () => ({ name: ' Ada ' }));
    expect(name).toBe(' Ada ');
  });

  it('returns null when the name is blank, the reviewer is missing, or the grant is not admitted', async () => {
    expect(await fundingReviewedByName(admitted, 3, async () => ({ name: '  ' }))).toBeNull();
    expect(await fundingReviewedByName(admitted, 3, async () => undefined)).toBeNull();
    expect(
      await fundingReviewedByName({ ...admitted, decidedBy: null }, 3, async () => ({
        name: 'Ada',
      })),
    ).toBeNull();
    expect(
      await fundingReviewedByName(
        { ...admitted, status: 'pending', admittedAt: null },
        3,
        async () => ({
          name: 'Ada',
        }),
      ),
    ).toBeNull();
    expect(await fundingReviewedByName(undefined, 3, async () => ({ name: 'Ada' }))).toBeNull();
  });
});
