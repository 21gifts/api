import { describe, expect, it } from 'vitest';
import {
  comparePeriod,
  dayKey,
  isValidTimeZone,
  manilaReviewWeek,
  nextPeriod,
  periodKey,
  weekKey,
  weeklyRatableThrough,
} from '../../lib/member-habit';

describe('isValidTimeZone', () => {
  it('accepts IANA zones and rejects empty or invalid names', () => {
    expect(isValidTimeZone('Asia/Manila')).toBe(true);
    expect(isValidTimeZone('Europe/Zurich')).toBe(true);
    expect(isValidTimeZone('')).toBe(false);
    expect(isValidTimeZone('Not/AZone')).toBe(false);
  });
});

describe('dayKey / weekKey / periodKey', () => {
  it('dayKey is YYYY-MM-DD of the instant in the zone', () => {
    expect(dayKey(Date.parse('2026-10-05T00:00:00Z'), 'Asia/Manila')).toBe('2026-10-05');
    expect(dayKey(Date.parse('2026-10-04T15:00:00Z'), 'Asia/Manila')).toBe('2026-10-04');
  });

  it('weekKey of a Wednesday is that week’s Monday', () => {
    expect(weekKey(Date.parse('2026-10-07T12:00:00Z'), 'Asia/Manila')).toBe('2026-10-05');
  });

  it('periodKey selects dayKey or weekKey by cadence', () => {
    const now = Date.parse('2026-10-07T12:00:00Z');
    expect(periodKey(now, 'daily', 'Asia/Manila')).toBe('2026-10-07');
    expect(periodKey(now, 'weekly', 'Asia/Manila')).toBe('2026-10-05');
  });
});

describe('nextPeriod', () => {
  it('advances a daily key by one calendar day', () => {
    expect(nextPeriod('2026-10-05', 'daily')).toBe('2026-10-06');
    expect(nextPeriod('2026-10-31', 'daily')).toBe('2026-11-01');
  });

  it('advances a weekly Monday key by seven days', () => {
    expect(nextPeriod('2026-10-05', 'weekly')).toBe('2026-10-12');
  });
});

describe('comparePeriod', () => {
  it('compares YYYY-MM-DD lexicographically as chronology', () => {
    expect(comparePeriod('2026-09-28', '2026-10-05')).toBe(-1);
    expect(comparePeriod('2026-10-05', '2026-10-05')).toBe(0);
    expect(comparePeriod('2026-10-05', '2026-09-28')).toBe(1);
  });
});

describe('weeklyRatableThrough', () => {
  it('Manila: Monday 08:00 opens the week that ended the previous Monday', () => {
    expect(weeklyRatableThrough(Date.parse('2026-10-05T00:00:00Z'), 'Asia/Manila')).toBe(
      '2026-09-28',
    );
  });

  it('Manila: Monday 07:59 still belongs to the prior ratable week', () => {
    expect(weeklyRatableThrough(Date.parse('2026-10-04T23:59:00Z'), 'Asia/Manila')).toBe(
      '2026-09-21',
    );
  });

  it('Manila: Sunday 23:00 is not yet the following Monday 08:00', () => {
    expect(weeklyRatableThrough(Date.parse('2026-10-04T15:00:00Z'), 'Asia/Manila')).toBe(
      '2026-09-21',
    );
  });

  it('Europe/Zurich: Monday 08:00 local flips weeklyRatableThrough', () => {
    expect(weeklyRatableThrough(Date.parse('2026-10-05T06:00:00Z'), 'Europe/Zurich')).toBe(
      '2026-09-28',
    );
    expect(weeklyRatableThrough(Date.parse('2026-10-05T05:59:00Z'), 'Europe/Zurich')).toBe(
      '2026-09-21',
    );
  });
});

describe('manilaReviewWeek', () => {
  it('wraps weeklyRatableThrough for Asia/Manila', () => {
    expect(manilaReviewWeek(Date.parse('2026-10-05T00:00:00Z'))).toEqual({
      start: '2026-09-28',
    });
  });
});

describe('nextPeriod rejects', () => {
  it('throws when the key is not YYYY-MM-DD', () => {
    expect(() => nextPeriod('bad', 'daily')).toThrow(/invalid YYYY-MM-DD/);
  });
});
