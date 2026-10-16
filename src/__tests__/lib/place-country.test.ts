import { describe, expect, it } from 'vitest';
import { PLACE_COUNTRIES } from '@/lib/place-country';

describe('PLACE_COUNTRIES', () => {
  it('contains a code the map accepts and rejects one it does not', () => {
    expect(PLACE_COUNTRIES.has('PH')).toBe(true);
    expect(PLACE_COUNTRIES.has('KE')).toBe(true);
    expect(PLACE_COUNTRIES.has('ZZ')).toBe(false);
    expect(PLACE_COUNTRIES.has('UK')).toBe(false);
  });
});
