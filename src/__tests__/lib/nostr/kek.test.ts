import { describe, expect, it } from 'vitest';
import { bytesToHex, hexToBytes, parseNostrKek } from '@/lib/nostr/kek';

describe('parseNostrKek', () => {
  it('parses 64 lowercase hex chars', () => {
    const raw = 'ab'.repeat(32);
    expect(parseNostrKek(raw).length).toBe(32);
  });

  it('throws when missing', () => {
    expect(() => parseNostrKek(undefined)).toThrow(/required/);
  });

  it('throws when blank', () => {
    expect(() => parseNostrKek('  ')).toThrow(/required/);
  });

  it('throws when not lowercase hex', () => {
    expect(() => parseNostrKek('AB'.repeat(32))).toThrow(/64 lowercase hex/);
  });
});

describe('hexToBytes / bytesToHex', () => {
  it('round-trips', () => {
    expect(bytesToHex(hexToBytes('0aff'))).toBe('0aff');
  });

  it('rejects odd length', () => {
    expect(() => hexToBytes('abc')).toThrow(/lowercase hex/);
  });

  it('encodes empty', () => {
    expect(bytesToHex(new Uint8Array())).toBe('');
  });
});
