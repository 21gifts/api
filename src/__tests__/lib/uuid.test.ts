import { describe, expect, it } from 'vitest';
import { UUID_PATTERN, normalizeUuid } from '@/lib/uuid';

const ID = '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d';

describe('UUID_PATTERN', () => {
  it('matches the eight-four-four-four-twelve shape in any letter case', () => {
    expect(UUID_PATTERN.test(ID)).toBe(true);
    expect(UUID_PATTERN.test(ID.toUpperCase())).toBe(true);
  });

  it('refuses other shapes', () => {
    expect(UUID_PATTERN.test('')).toBe(false);
    expect(UUID_PATTERN.test(ID.replaceAll('-', ''))).toBe(false);
    expect(UUID_PATTERN.test(`${ID}0`)).toBe(false);
    expect(UUID_PATTERN.test(`x${ID.slice(1)}`)).toBe(false);
  });
});

describe('normalizeUuid', () => {
  it('lowercases a UUID', () => {
    expect(normalizeUuid(ID.toUpperCase())).toBe(ID);
    expect(normalizeUuid(ID)).toBe(ID);
  });

  it('returns null for anything else', () => {
    expect(normalizeUuid('not-a-uuid')).toBeNull();
    expect(normalizeUuid(` ${ID}`)).toBeNull();
  });
});
