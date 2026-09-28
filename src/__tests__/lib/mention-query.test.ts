import { describe, expect, it } from 'vitest';
import { mentionQueryPrefix } from '@/lib/mention-query';

describe('mentionQueryPrefix', () => {
  it('returns an empty prefix for undefined, empty, and whitespace-only input', () => {
    expect(mentionQueryPrefix(undefined)).toBe('');
    expect(mentionQueryPrefix('')).toBe('');
    expect(mentionQueryPrefix('   ')).toBe('');
  });

  it('returns an empty prefix when the trimmed value is only @', () => {
    expect(mentionQueryPrefix('@')).toBe('');
    expect(mentionQueryPrefix(' @ ')).toBe('');
  });

  it('trims, strips one leading @, and lowercases a handle', () => {
    expect(mentionQueryPrefix('@Ada')).toBe('ada');
    expect(mentionQueryPrefix('  @Ada  ')).toBe('ada');
    expect(mentionQueryPrefix('Ada.B')).toBe('ada.b');
    expect(mentionQueryPrefix('a_b')).toBe('a_b');
    expect(mentionQueryPrefix('9names')).toBe('9names');
    expect(mentionQueryPrefix('A-b')).toBe('a-b');
  });

  it('rejects a leading underscore, dot, hyphen, space, or leftover @', () => {
    expect(mentionQueryPrefix('_ada')).toBeNull();
    expect(mentionQueryPrefix('.')).toBeNull();
    expect(mentionQueryPrefix('-ada')).toBeNull();
    expect(mentionQueryPrefix('ada bob')).toBeNull();
    expect(mentionQueryPrefix('@@ada')).toBeNull();
  });

  it('rejects 33 characters and accepts 32', () => {
    expect(mentionQueryPrefix('a'.repeat(33))).toBeNull();
    expect(mentionQueryPrefix('a'.repeat(32))).toBe('a'.repeat(32));
    expect(mentionQueryPrefix(`@${'a'.repeat(32)}`)).toBe('a'.repeat(32));
    expect(mentionQueryPrefix(`@${'a'.repeat(33)}`)).toBeNull();
  });
});
