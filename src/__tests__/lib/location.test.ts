import { describe, it, expect } from 'vitest';
import { LOCATION_MAX_LENGTH, normalizeLocation } from '@/lib/location';

describe('normalizeLocation', () => {
  it('trims surrounding whitespace', () => {
    expect(normalizeLocation('  Berlin  ')).toEqual({ ok: true, value: 'Berlin' });
  });

  it('keeps internal spaces', () => {
    expect(normalizeLocation('New York')).toEqual({ ok: true, value: 'New York' });
  });

  it('accepts a location at the maximum length', () => {
    const location = 'A'.repeat(LOCATION_MAX_LENGTH);
    expect(normalizeLocation(location)).toEqual({ ok: true, value: location });
  });

  it('clears an empty string to null', () => {
    expect(normalizeLocation('')).toEqual({ ok: true, value: null });
  });

  it('clears whitespace-only input to null', () => {
    expect(normalizeLocation('   ')).toEqual({ ok: true, value: null });
  });

  it('rejects a location longer than the maximum', () => {
    expect(normalizeLocation('A'.repeat(LOCATION_MAX_LENGTH + 1))).toEqual({ ok: false });
  });

  it('rejects a tab', () => {
    expect(normalizeLocation('Berlin\tDE')).toEqual({ ok: false });
  });

  it('rejects a newline', () => {
    expect(normalizeLocation('Berlin\nDE')).toEqual({ ok: false });
  });

  it('rejects a DEL character', () => {
    expect(normalizeLocation(`Berlin${String.fromCharCode(127)}`)).toEqual({ ok: false });
  });
});
