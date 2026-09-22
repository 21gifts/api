import { describe, it, expect } from 'vitest';
import { postgresTextArrayLiteral } from '@/lib/postgres-text-array';

describe('postgresTextArrayLiteral', () => {
  it('encodes an empty list as {}', () => {
    expect(postgresTextArrayLiteral([])).toBe('{}');
  });

  it('encodes one value as a quoted element', () => {
    expect(postgresTextArrayLiteral(['rejected'])).toBe('{"rejected"}');
  });

  it('escapes a backslash and a double quote inside a value', () => {
    expect(postgresTextArrayLiteral(['a"b', 'c\\d'])).toBe('{"a\\"b","c\\\\d"}');
  });

  it('joins two plain values with a comma between quoted elements', () => {
    expect(postgresTextArrayLiteral(['pending', 'trial'])).toBe('{"pending","trial"}');
  });
});
