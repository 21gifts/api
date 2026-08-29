import { describe, it, expect } from 'vitest';
import {
  MESSAGE_MAX_LENGTH,
  normalizeForumText,
  serializeMessage,
  unsignedNostrDefaults,
  type MessageRow,
} from '@/lib/message';

describe('normalizeForumText', () => {
  it('trims surrounding whitespace', () => {
    expect(normalizeForumText('  hello  ')).toBe('hello');
  });

  it('keeps internal spaces', () => {
    expect(normalizeForumText('hello world')).toBe('hello world');
  });

  it('keeps a newline', () => {
    expect(normalizeForumText('hello\nworld')).toBe('hello\nworld');
  });

  it('keeps a carriage return', () => {
    expect(normalizeForumText('hello\rworld')).toBe('hello\rworld');
  });

  it('accepts text at the maximum length', () => {
    const text = 'A'.repeat(MESSAGE_MAX_LENGTH);
    expect(normalizeForumText(text)).toBe(text);
  });

  it('rejects an empty string', () => {
    expect(normalizeForumText('')).toBeNull();
  });

  it('rejects whitespace-only input', () => {
    expect(normalizeForumText('   ')).toBeNull();
  });

  it('rejects text longer than the maximum', () => {
    expect(normalizeForumText('A'.repeat(MESSAGE_MAX_LENGTH + 1))).toBeNull();
  });

  it('rejects a tab', () => {
    expect(normalizeForumText('hello\tworld')).toBeNull();
  });

  it('rejects a DEL character', () => {
    expect(normalizeForumText(`hello${String.fromCharCode(127)}`)).toBeNull();
  });
});

describe('serializeMessage', () => {
  it('emits ISO createdAt and omits accountId', () => {
    const row: MessageRow = {
      id: 'msg-1',
      accountId: 'acc-1',
      name: 'Ada',
      text: 'hi',
      createdAt: new Date('2026-08-28T12:00:00.000Z'),
      ...unsignedNostrDefaults(),
    };
    expect(serializeMessage(row, true)).toEqual({
      id: 'msg-1',
      name: 'Ada',
      text: 'hi',
      createdAt: '2026-08-28T12:00:00.000Z',
      sats: 0,
      payable: true,
    });
    expect(serializeMessage(row, false)).not.toHaveProperty('accountId');
  });
});
