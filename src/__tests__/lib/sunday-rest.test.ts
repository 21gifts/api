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
