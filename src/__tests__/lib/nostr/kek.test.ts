import { describe, expect, it } from 'vitest';
import {
  bindKekId,
  bytesToHex,
  DEFAULT_KEK_ID,
  hexToBytes,
  kekIdOf,
  parseKekHex,
  parseKekId,
  parseNostrKek,
  parsePreviousNostrKek,
} from '@/lib/nostr/kek';

describe('parsePreviousNostrKek', () => {
  const keys = {
    nostrKek: new Uint8Array(32).fill(0x11),
    recoveryShareKek: new Uint8Array(32).fill(0x22),
    previousRecoveryShareKek: new Uint8Array(32).fill(0x33) as Uint8Array | undefined,
  };

  it('is undefined when unset or blank', () => {
    expect(parsePreviousNostrKek(undefined, keys)).toBeUndefined();
    expect(parsePreviousNostrKek('  ', keys)).toBeUndefined();
  });

  it('parses 64 lowercase hex after trimming, unbound to any KEK id', () => {
    const kek = parsePreviousNostrKek(` ${'44'.repeat(32)}\n`, keys);
    expect(kek).toEqual(new Uint8Array(32).fill(0x44));
    expect(kekIdOf(kek!)).toBe(DEFAULT_KEK_ID);
  });

  it('refuses a malformed value', () => {
    expect(() => parsePreviousNostrKek('AB'.repeat(32), keys)).toThrow(
      'NOSTR_NSEC_KEK_PREVIOUS must be 64 lowercase hex characters',
    );
  });

  it('refuses a value equal to another KEK, naming only the variable', () => {
    expect(() => parsePreviousNostrKek('11'.repeat(32), keys)).toThrow(
      'NOSTR_NSEC_KEK_PREVIOUS must differ from NOSTR_NSEC_KEK',
    );
    expect(() => parsePreviousNostrKek('22'.repeat(32), keys)).toThrow(
      'NOSTR_NSEC_KEK_PREVIOUS must differ from RECOVERY_SHARE_KEK',
    );
    let message = '';
    try {
      parsePreviousNostrKek('33'.repeat(32), keys);
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toBe('NOSTR_NSEC_KEK_PREVIOUS must differ from RECOVERY_SHARE_KEK_PREVIOUS');
    expect(message).not.toContain('33'.repeat(32));
  });

  it('skips the previous recovery key when it is unset, and a key of another length', () => {
    expect(
      parsePreviousNostrKek('33'.repeat(32), { ...keys, previousRecoveryShareKek: undefined }),
    ).toEqual(new Uint8Array(32).fill(0x33));
    expect(
      parsePreviousNostrKek('11'.repeat(32), { ...keys, nostrKek: new Uint8Array(31).fill(0x11) }),
    ).toEqual(new Uint8Array(32).fill(0x11));
  });
});

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

describe('parseKekId', () => {
  it('defaults to 1 when unset or blank', () => {
    expect(DEFAULT_KEK_ID).toBe(1);
    expect(parseKekId('NOSTR_NSEC_KEK_ID', undefined)).toBe(1);
    expect(parseKekId('NOSTR_NSEC_KEK_ID', '  ')).toBe(1);
  });

  it('parses a positive integer up to 4294967295 after trimming', () => {
    expect(parseKekId('NOSTR_NSEC_KEK_ID', ' 2\n')).toBe(2);
    expect(parseKekId('RECOVERY_SHARE_KEK_ID', '4294967295')).toBe(4_294_967_295);
  });

  it('names the variable when the value is not a positive integer', () => {
    for (const raw of ['0', '-1', '1.5', 'two', '02', '4294967296', '99999999999', '1e3']) {
      expect(() => parseKekId('RECOVERY_SHARE_KEK_ID', raw)).toThrow(
        'RECOVERY_SHARE_KEK_ID must be a positive integer',
      );
    }
  });
});

describe('bindKekId / kekIdOf', () => {
  it('binds an id to the key object, not to its bytes', () => {
    const kek = new Uint8Array(32).fill(1);
    expect(kekIdOf(kek)).toBe(1);
    expect(bindKekId(kek, 2)).toBe(kek);
    expect(kekIdOf(kek)).toBe(2);
    expect(kekIdOf(new Uint8Array(32).fill(1))).toBe(1);
    expect(kekIdOf(kek.slice())).toBe(1);
  });

  it('refuses an id that is not a positive uint32', () => {
    const kek = new Uint8Array(32);
    for (const id of [0, -1, 1.5, 4_294_967_296, Number.NaN]) {
      expect(() => bindKekId(kek, id)).toThrow('KEK id must be a positive integer');
    }
    expect(kekIdOf(kek)).toBe(1);
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
