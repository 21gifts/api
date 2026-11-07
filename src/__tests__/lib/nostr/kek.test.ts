import { describe, expect, it } from 'vitest';
import { bytesToHex, hexToBytes, parseKekHex, parseNostrKek } from '@/lib/nostr/kek';

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

describe('parseKekHex', () => {
  it('parses 64 lowercase hex chars after trimming', () => {
    expect(parseKekHex('SOME_KEK', ` ${'0f'.repeat(32)}\n`)).toEqual(new Uint8Array(32).fill(15));
  });

  it('names the variable in both errors', () => {
    expect(() => parseKekHex('SOME_KEK', undefined)).toThrow(
      'SOME_KEK is required when DATABASE_URL is set',
    );
    expect(() => parseKekHex('SOME_KEK', '')).toThrow(
      'SOME_KEK is required when DATABASE_URL is set',
    );
    expect(() => parseKekHex('SOME_KEK', 'ab'.repeat(31))).toThrow(
      'SOME_KEK must be 64 lowercase hex characters',
    );
  });

  it('keeps the NOSTR_NSEC_KEK messages byte-identical', () => {
    expect(() => parseNostrKek(undefined)).toThrow(
      'NOSTR_NSEC_KEK is required when DATABASE_URL is set',
    );
    expect(() => parseNostrKek('zz'.repeat(32))).toThrow(
      'NOSTR_NSEC_KEK must be 64 lowercase hex characters',
    );
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
