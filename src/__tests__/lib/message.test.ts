import { describe, it, expect } from 'vitest';
import {
  MESSAGE_MAX_LENGTH,
  MESSAGE_PHOTO_MAX_BASE64_LENGTH,
  MESSAGE_PHOTO_MAX_BYTES,
  decodeForumPhoto,
  detectImageContentType,
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

  it('returns empty string for an empty input', () => {
    expect(normalizeForumText('')).toBe('');
  });

  it('returns empty string for whitespace-only input', () => {
    expect(normalizeForumText('   ')).toBe('');
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
  it('emits ISO createdAt, hasPhoto false, and omits accountId', () => {
    const row: MessageRow = {
      id: 'msg-1',
      accountId: 'acc-1',
      name: 'Ada',
      text: 'hi',
      createdAt: new Date('2026-08-28T12:00:00.000Z'),
      hasPhoto: false,
      ...unsignedNostrDefaults(),
    };
    expect(serializeMessage(row, true, 'moderator')).toEqual({
      id: 'msg-1',
      name: 'Ada',
      text: 'hi',
      createdAt: '2026-08-28T12:00:00.000Z',
      sats: 0,
      payable: true,
      hasPhoto: false,
      hasVideo: false,
      role: 'moderator',
    });
    expect(serializeMessage(row, false, 'basis')).not.toHaveProperty('accountId');
  });

  it('includes hasPhoto true', () => {
    const row: MessageRow = {
      id: 'msg-2',
      accountId: 'acc-1',
      name: 'Ada',
      text: '',
      createdAt: new Date('2026-08-28T12:00:00.000Z'),
      hasPhoto: true,
      ...unsignedNostrDefaults(),
    };
    expect(serializeMessage(row, false, 'basis').hasPhoto).toBe(true);
  });
});

describe('detectImageContentType', () => {
  it('detects jpeg', () => {
    expect(detectImageContentType(new Uint8Array([0xff, 0xd8, 0xff, 0xd9]))).toBe('image/jpeg');
  });

  it('detects png', () => {
    expect(
      detectImageContentType(
        new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0]),
      ),
    ).toBe('image/png');
  });

  it('detects webp', () => {
    const bytes = new Uint8Array(12);
    bytes.set([0x52, 0x49, 0x46, 0x46], 0);
    bytes.set([0x57, 0x45, 0x42, 0x50], 8);
    expect(detectImageContentType(bytes)).toBe('image/webp');
  });

  it('rejects gif, empty, and random bytes', () => {
    expect(detectImageContentType(new Uint8Array([0x47, 0x49, 0x46, 0x38]))).toBeNull();
    expect(detectImageContentType(new Uint8Array(0))).toBeNull();
    expect(detectImageContentType(new Uint8Array([1, 2, 3, 4]))).toBeNull();
  });
});

describe('decodeForumPhoto', () => {
  const jpegBytes = new Uint8Array([0xff, 0xd8, 0xff, 0xd9]);
  const jpegB64 = Buffer.from(jpegBytes).toString('base64');

  it('decodes a tiny jpeg and copies bytes', () => {
    const photo = decodeForumPhoto('image/png', jpegB64);
    expect(photo).not.toBeNull();
    expect(photo?.contentType).toBe('image/jpeg');
    expect(photo?.bytes).toEqual(jpegBytes);
    if (photo !== null) {
      photo.bytes[0] = 0;
      const again = decodeForumPhoto('ignored', jpegB64);
      expect(again?.bytes[0]).toBe(0xff);
    }
  });

  it('rejects oversize payloads', () => {
    const big = new Uint8Array(MESSAGE_PHOTO_MAX_BYTES + 1);
    big[0] = 0xff;
    big[1] = 0xd8;
    big[2] = 0xff;
    expect(decodeForumPhoto('image/jpeg', Buffer.from(big).toString('base64'))).toBeNull();
  });

  it('rejects oversize encoded base64 before decode', () => {
    expect(
      decodeForumPhoto('image/jpeg', 'A'.repeat(MESSAGE_PHOTO_MAX_BASE64_LENGTH + 4)),
    ).toBeNull();
  });

  it('rejects base64 that is not a complete quartet', () => {
    expect(decodeForumPhoto('image/jpeg', '/9j/A')).toBeNull();
  });

  it('rejects bad base64', () => {
    expect(decodeForumPhoto('image/jpeg', '!!!not-base64!!!')).toBeNull();
  });

  it('rejects empty base64', () => {
    expect(decodeForumPhoto('image/jpeg', '')).toBeNull();
  });

  it('rejects base64 that decodes to empty bytes', () => {
    expect(decodeForumPhoto('image/jpeg', 'A')).toBeNull();
  });

  it('rejects wrong magic', () => {
    const gif = Buffer.from([0x47, 0x49, 0x46, 0x38]).toString('base64');
    expect(decodeForumPhoto('image/gif', gif)).toBeNull();
  });
});
