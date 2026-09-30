import { describe, expect, it } from 'vitest';
import { mentionUsernames, resolveMentionMarks } from '@/lib/mention';

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

describe('resolveMentionMarks', () => {
  it('stores a known username and skips an address and an unknown name', async () => {
    const marks = await resolveMentionMarks(
      'see @Marites, pay ada@walletofsatoshi.com, not @nobody',
      async (username) => (username === 'marites' ? { id: 'acc-marites' } : undefined),
    );
    expect(marks).toEqual([{ accountId: 'acc-marites', username: 'marites' }]);
  });

  it('returns no marks when the text has none', async () => {
    expect(await resolveMentionMarks('hello', async () => ({ id: 'acc' }))).toEqual([]);
  });
});
