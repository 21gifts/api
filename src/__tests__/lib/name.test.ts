import { describe, it, expect } from 'vitest';
import { NAME_MAX_LENGTH, normalizeDisplayName } from '@/lib/name';

describe('normalizeDisplayName', () => {
  it('trims surrounding whitespace', () => {
    expect(normalizeDisplayName('  Ada  ')).toBe('Ada');
  });

  it('keeps internal spaces', () => {
    expect(normalizeDisplayName('Jean Luc')).toBe('Jean Luc');
  });

  it('accepts a name at the maximum length', () => {
    const name = 'A'.repeat(NAME_MAX_LENGTH);
    expect(normalizeDisplayName(name)).toBe(name);
  });

  it('rejects an empty string', () => {
    expect(normalizeDisplayName('')).toBeNull();
  });

  it('rejects whitespace-only input', () => {
    expect(normalizeDisplayName('   ')).toBeNull();
  });

  it('rejects a name longer than the maximum', () => {
    expect(normalizeDisplayName('A'.repeat(NAME_MAX_LENGTH + 1))).toBeNull();
  });

  it('rejects a tab', () => {
    expect(normalizeDisplayName('Ada\tLovelace')).toBeNull();
  });

  it('rejects a newline', () => {
    expect(normalizeDisplayName('Ada\nLovelace')).toBeNull();
  });

  it('rejects a DEL character', () => {
    expect(normalizeDisplayName(`Ada${String.fromCharCode(127)}`)).toBeNull();
  });
});
