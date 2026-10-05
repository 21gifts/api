import { describe, it, expect } from 'vitest';
import { isSundayInZone, isSundayRestHeader } from '@/lib/sunday-rest';

const ZURICH_SATURDAY_MS = Date.parse('2026-09-26T12:00:00.000Z');
const ZURICH_SUNDAY_MS = Date.parse('2026-09-27T12:00:00.000Z');

describe('isSundayInZone', () => {
  it('is false on Saturday in Europe/Zurich', () => {
    expect(isSundayInZone(ZURICH_SATURDAY_MS, 'Europe/Zurich')).toBe(false);
  });

  it('is true on Sunday in Europe/Zurich', () => {
    expect(isSundayInZone(ZURICH_SUNDAY_MS, 'Europe/Zurich')).toBe(true);
  });

  it('is Sunday in Pacific/Auckland while Europe/Zurich is still Saturday', () => {
    // 12:00 UTC Saturday is afternoon in Zurich and already Sunday morning in Auckland.
    expect(isSundayInZone(ZURICH_SATURDAY_MS, 'Europe/Zurich')).toBe(false);
    expect(isSundayInZone(ZURICH_SATURDAY_MS, 'Pacific/Auckland')).toBe(true);
  });

  it('returns false for an invalid zone', () => {
    expect(isSundayInZone(ZURICH_SUNDAY_MS, 'Not/AZone')).toBe(false);
  });
});

describe('isSundayRestHeader', () => {
  it('is false when the header is missing or blank', () => {
    expect(isSundayRestHeader(ZURICH_SUNDAY_MS, undefined)).toBe(false);
    expect(isSundayRestHeader(ZURICH_SUNDAY_MS, '  ')).toBe(false);
  });

  it('follows the named zone', () => {
    expect(isSundayRestHeader(ZURICH_SUNDAY_MS, 'Europe/Zurich')).toBe(true);
    expect(isSundayRestHeader(ZURICH_SATURDAY_MS, 'Europe/Zurich')).toBe(false);
    expect(isSundayRestHeader(ZURICH_SUNDAY_MS, 'Not/AZone')).toBe(false);
  });
});

// Local boundaries, including the spring/fall DST Sundays in Zurich.
describe('local Monday reopening', () => {
  it.each([
    ['2026-10-03T15:59:59.999Z', 'Asia/Manila', false],
    ['2026-10-03T16:00:00.000Z', 'Asia/Manila', true],
    ['2026-10-04T16:00:00.000Z', 'Asia/Manila', true],
    ['2026-10-04T23:59:59.999Z', 'Asia/Manila', true],
    ['2026-10-05T00:00:00.000Z', 'Asia/Manila', false],
    ['2026-10-05T05:59:59.999Z', 'Europe/Zurich', true],
    ['2026-10-05T06:00:00.000Z', 'Europe/Zurich', false],
    ['2026-03-30T05:59:59.999Z', 'Europe/Zurich', true],
    ['2026-03-30T06:00:00.000Z', 'Europe/Zurich', false],
    ['2026-10-26T06:59:59.999Z', 'Europe/Zurich', true],
    ['2026-10-26T07:00:00.000Z', 'Europe/Zurich', false],
    ['2026-10-05T17:59:59.999Z', 'Pacific/Honolulu', true],
    ['2026-10-05T18:00:00.000Z', 'Pacific/Honolulu', false],
  ])('%s in %s has rest=%s', (instant, zone, expected) => {
    expect(isSundayInZone(Date.parse(instant), zone)).toBe(expected);
  });
});
