import { describe, expect, it } from 'vitest';
import { mentionUsernames } from '@/lib/mention';

describe('mentionUsernames', () => {
  it('keeps the longest username run and ignores an address', () => {
    expect(mentionUsernames('hello @Ada, see @ada. and name@21.gifts')).toEqual(['ada', 'ada.']);
  });

  it('drops a lone underscore, a 33-character run, and duplicates', () => {
    expect(mentionUsernames('@_ @aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa @Ada @ada')).toEqual(['ada']);
  });

  it('starts a mark at the beginning of the text', () => {
    expect(mentionUsernames('@Ben!')).toEqual(['ben']);
  });
});
