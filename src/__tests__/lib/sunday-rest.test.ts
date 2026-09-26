import { describe, it, expect } from 'vitest';
import { isSundayRest, sundayRetryAfter } from '../../lib/sunday-rest';

describe('Manila Sunday rest', () => {
  it.each([
    ['2026-09-26T15:59:59.999Z', false],
    ['2026-09-26T16:00:00.000Z', true],
    ['2026-09-27T15:59:59.999Z', true],
    ['2026-09-27T16:00:00.000Z', false],
    ['2026-12-26T16:00:00.000Z', true],
    ['2026-03-28T16:00:00.000Z', true],
  ])('%s -> %s', (date, expected) => {
    expect(isSundayRest(Date.parse(date))).toBe(expected);
  });
  it('reopens after exactly 24 hours and rounds partial seconds up', () => {
    expect(sundayRetryAfter(Date.parse('2026-09-26T16:00:00Z'))).toBe(86400);
    expect(sundayRetryAfter(Date.parse('2026-09-27T15:59:59.999Z'))).toBe(1);
  });
});
