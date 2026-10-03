import { describe, expect, it } from 'vitest';
import {
  habitWeek,
  habitReviewWeek,
  habitCommentsAllowedAt,
  habitCommentsCloseAt,
  habitCommentsAllowed,
} from '@/lib/habit-tracker';

describe('habitWeek', () => {
  it('returns the same week before and at Monday 08:00 Manila because the week changes at midnight', () => {
    const expected = {
      start: '2027-01-04',
      label: '2027-W01',
      nextAt: Date.parse('2027-01-10T16:00:00Z'),
    };
    expect(habitWeek(Date.parse('2027-01-04T07:59:59.999+08:00'))).toEqual(expected);
    expect(habitWeek(Date.parse('2027-01-04T08:00:00+08:00'))).toEqual(expected);
  });
});

describe('habitReviewWeek', () => {
  it('publishes the completed week at Monday 08:00 Manila', () => {
    expect(habitReviewWeek(Date.parse('2027-01-04T07:59:59.999+08:00'))).toEqual({
      start: '2026-12-21',
      label: '2026-W52',
      nextAt: Date.parse('2027-01-04T08:00:00+08:00'),
    });
    expect(habitReviewWeek(Date.parse('2027-01-04T08:00:00+08:00'))).toEqual({
      start: '2026-12-28',
      label: '2026-W53',
      nextAt: Date.parse('2027-01-11T08:00:00+08:00'),
    });
  });
});

describe('habit comment window', () => {
  it('opens at Monday 16:00 Asia/Manila of the following week', () => {
    expect(habitCommentsAllowedAt('2026-12-28')).toBe(Date.parse('2027-01-04T16:00:00+08:00'));
  });

  it('closes at Saturday 20:00 Asia/Manila exclusive, 5 days and 4 hours after opening', () => {
    const open = habitCommentsAllowedAt('2026-12-28');
    const close = habitCommentsCloseAt('2026-12-28');
    expect(close).toBe(Date.parse('2027-01-09T20:00:00+08:00'));
    expect(close - open).toBe((5 * 24 + 4) * 60 * 60 * 1000);
  });

  it('admits comments at the open instant and rejects the millisecond before, the close instant, and another week', () => {
    const open = Date.parse('2027-01-04T16:00:00+08:00');
    expect(habitCommentsAllowed('2026-12-28', open)).toBe(true);
    expect(habitCommentsAllowed('2026-12-28', Date.parse('2027-01-04T15:59:59.999+08:00'))).toBe(
      false,
    );
    expect(habitCommentsAllowed('2026-12-28', Date.parse('2027-01-09T20:00:00+08:00'))).toBe(false);
    expect(habitCommentsAllowed('2026-12-21', open)).toBe(false);
  });
});
