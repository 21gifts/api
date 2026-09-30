import { describe, expect, it } from 'vitest';
import { mentionAccountMatches, mentionQueryPrefix } from '@/lib/mention-query';

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
    expect(mentionQueryPrefix('@ Ada')).toBeNull();
    expect(mentionQueryPrefix('@@ada')).toBeNull();
  });

  it('rejects 33 characters and accepts 32', () => {
    expect(mentionQueryPrefix('a'.repeat(33))).toBeNull();
    expect(mentionQueryPrefix('a'.repeat(32))).toBe('a'.repeat(32));
    expect(mentionQueryPrefix(`@${'a'.repeat(32)}`)).toBe('a'.repeat(32));
    expect(mentionQueryPrefix(`@${'a'.repeat(33)}`)).toBeNull();
  });
});

describe('mentionAccountMatches', () => {
  it('matches an empty token, a username start, a username segment, and a display-name word', () => {
    expect(mentionAccountMatches('nope', null, '')).toBe(true);
    expect(mentionAccountMatches('  pater-severin  ', null, 'pater-sev')).toBe(true);
    expect(mentionAccountMatches('Pater-Severin', 'Reserve', 'sev')).toBe(true);
    expect(mentionAccountMatches('padre', 'Pater Severin', 'sev')).toBe(true);
    expect(mentionAccountMatches('other', 'Ada.Bob', 'ada.b')).toBe(true);
    expect(mentionAccountMatches('a_b', null, 'a_')).toBe(true);
    expect(mentionAccountMatches('a-b-c', null, 'a-b')).toBe(true);
    expect(mentionAccountMatches('other', 'a-b tail', 'a-b')).toBe(true);
  });

  it('misses mid-word tokens, a blank display name, and a literal underscore that is not in the handle', () => {
    expect(mentionAccountMatches('padre', 'Reserve', 'sev')).toBe(false);
    expect(mentionAccountMatches('pater-severin', 'Pater Severin', 'ter')).toBe(false);
    expect(mentionAccountMatches('padre', null, 'sev')).toBe(false);
    expect(mentionAccountMatches('padre', undefined, 'sev')).toBe(false);
    expect(mentionAccountMatches('padre', '   ', 'sev')).toBe(false);
    expect(mentionAccountMatches('axb', 'axb', 'a_')).toBe(false);
    expect(mentionAccountMatches('x-a-b', 'x a-b', 'a-b')).toBe(false);
  });
});
