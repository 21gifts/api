import { describe, expect, it, vi } from 'vitest';
import * as aesGcm from '@/lib/aes-gcm-envelope';
import { envelopeKekId } from '@/lib/aes-gcm-envelope';
import {
  encryptRecoveryShare,
  parsePreviousRecoveryShareKek,
  parseRecoveryShareKek,
  reencryptRecoveryShare,
  RECOVERY_SHARE_KEK_ID_V1,
  RECOVERY_SHARE_TEXT,
} from '@/lib/auth/recovery-share';
import { bindKekId } from '@/lib/nostr/kek';

const NOSTR_KEK = new Uint8Array(32).fill(0xab);
const KEK = new Uint8Array(32).fill(0xcd);
const ACCOUNT_ID = '3f2b8c1e-9d4a-4e7b-8c6f-1a2b3c4d5e6f';
/** A 20-word share of a 16-byte secret, from the official SLIP-39 test vectors (vector 1). */
const SHARE =
  'duckling enlarge academic academic agency result length solution fridge kidney ' +
  'coal piece deal husband erode duke ajar critical decision keyboard';

/** Open a share envelope in the test only; no request path decrypts a share. */
async function openShare(envelope: Uint8Array, accountId: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', KEK, { name: 'AES-GCM' }, false, ['decrypt']);
  const plain = await crypto.subtle.decrypt(
    {
      name: 'AES-GCM',
      iv: envelope.subarray(5, 17),
      additionalData: new TextEncoder().encode(accountId),
    },
    key,
    envelope.subarray(17),
  );
  return new TextDecoder().decode(plain);
}

describe('parseRecoveryShareKek', () => {
  it('parses a valid key that differs from the Nostr key', () => {
    expect(parseRecoveryShareKek('cd'.repeat(32), NOSTR_KEK)).toEqual(KEK);
    expect(parseRecoveryShareKek('ab'.repeat(32), new Uint8Array(16))).toEqual(NOSTR_KEK);
  });

  it('refuses a missing, blank, or malformed value', () => {
    expect(() => parseRecoveryShareKek(undefined, NOSTR_KEK)).toThrow(
      'RECOVERY_SHARE_KEK is required when DATABASE_URL is set',
    );
    expect(() => parseRecoveryShareKek('  ', NOSTR_KEK)).toThrow(
      'RECOVERY_SHARE_KEK is required when DATABASE_URL is set',
    );
    expect(() => parseRecoveryShareKek('CD'.repeat(32), NOSTR_KEK)).toThrow(
      'RECOVERY_SHARE_KEK must be 64 lowercase hex characters',
    );
  });

  it('refuses the Nostr key', () => {
    expect(() => parseRecoveryShareKek('ab'.repeat(32), NOSTR_KEK)).toThrow(
      'RECOVERY_SHARE_KEK must differ from NOSTR_NSEC_KEK',
    );
  });
});

describe('encryptRecoveryShare', () => {
  it('seals the share with the account id as additional data and kek id 1', async () => {
    expect(RECOVERY_SHARE_TEXT.test(SHARE)).toBe(true);
    const envelope = await encryptRecoveryShare(SHARE, KEK, ACCOUNT_ID);
    expect(envelope[0]).toBe(1);
    expect(new DataView(envelope.buffer).getUint32(1, false)).toBe(RECOVERY_SHARE_KEK_ID_V1);
    expect(RECOVERY_SHARE_KEK_ID_V1).toBe(1);
    expect(envelope.length).toBeGreaterThanOrEqual(34);
    expect(envelope.length).toBeLessThanOrEqual(1024);
    expect(await openShare(envelope, ACCOUNT_ID)).toBe(SHARE);
    await expect(openShare(envelope, 'another-account')).rejects.toThrow();
    expect(new TextDecoder().decode(envelope)).not.toContain('duckling');
  });

  it('refuses text that is not a 20-word share', async () => {
    for (const text of [
      '',
      SHARE.toUpperCase(),
      `${SHARE} extra`,
      SHARE.split(' ').slice(0, 19).join(' '),
      SHARE.replace(' ', '  '),
      SHARE.replace('duckling', 'duck1ing'),
      SHARE.replace('coal', 'ab'),
    ]) {
      await expect(encryptRecoveryShare(text, KEK, ACCOUNT_ID)).rejects.toThrow(
        'Invalid recovery share',
      );
    }
  });

  it('refuses a KEK that is not 32 bytes', async () => {
    await expect(encryptRecoveryShare(SHARE, new Uint8Array(16), ACCOUNT_ID)).rejects.toThrow(
      'KEK must be 32 bytes',
    );
  });

  it('seals under the KEK id bound to the key', async () => {
    const current = bindKekId(new Uint8Array(32).fill(0xcd), 2);
    const envelope = await encryptRecoveryShare(SHARE, current, ACCOUNT_ID);
    expect(envelopeKekId(envelope)).toBe(2);
    expect(await openShare(envelope, ACCOUNT_ID)).toBe(SHARE);
  });
});

describe('parsePreviousRecoveryShareKek', () => {
  const keys = { recoveryShareKek: KEK, nostrKek: NOSTR_KEK };

  it('is undefined when unset or blank', () => {
    expect(parsePreviousRecoveryShareKek(undefined, keys)).toBeUndefined();
    expect(parsePreviousRecoveryShareKek(' \n', keys)).toBeUndefined();
  });

  it('parses a key that differs from both current keys', () => {
    expect(parsePreviousRecoveryShareKek('ef'.repeat(32), keys)).toEqual(
      new Uint8Array(32).fill(0xef),
    );
  });

  it('refuses a malformed value or one equal to a current key', () => {
    expect(() => parsePreviousRecoveryShareKek('EF'.repeat(32), keys)).toThrow(
      'RECOVERY_SHARE_KEK_PREVIOUS must be 64 lowercase hex characters',
    );
    expect(() => parsePreviousRecoveryShareKek('cd'.repeat(32), keys)).toThrow(
      'RECOVERY_SHARE_KEK_PREVIOUS must differ from RECOVERY_SHARE_KEK',
    );
    expect(() => parsePreviousRecoveryShareKek('ab'.repeat(32), keys)).toThrow(
      'RECOVERY_SHARE_KEK_PREVIOUS must differ from NOSTR_NSEC_KEK',
    );
  });
});

describe('reencryptRecoveryShare', () => {
  const previous = new Uint8Array(32).fill(0xef);

  it('moves a share to the current key and id with the same additional data', async () => {
    const current = bindKekId(new Uint8Array(32).fill(0xcd), 2);
    const stored = await encryptRecoveryShare(SHARE, previous, ACCOUNT_ID);
    expect(envelopeKekId(stored)).toBe(1);
    const open = vi.spyOn(aesGcm, 'openAesGcmEnvelope');
    const moved = await reencryptRecoveryShare(stored, previous, current, ACCOUNT_ID);
    expect(envelopeKekId(moved)).toBe(2);
    expect(await openShare(moved, ACCOUNT_ID)).toBe(SHARE);
    await expect(openShare(moved, 'another-account')).rejects.toThrow();
    // The opened plaintext buffer is zeroed once the share is sealed again.
    const plaintext = (await open.mock.results[0]?.value) as Uint8Array;
    expect(plaintext.length).toBe(SHARE.length);
    expect(plaintext.every((byte) => byte === 0)).toBe(true);
    open.mockRestore();
  });

  it('fails for a wrong previous key, another account id, or a malformed envelope', async () => {
    const stored = await encryptRecoveryShare(SHARE, previous, ACCOUNT_ID);
    await expect(
      reencryptRecoveryShare(stored, new Uint8Array(32).fill(1), KEK, ACCOUNT_ID),
    ).rejects.toThrow();
    await expect(reencryptRecoveryShare(stored, previous, KEK, 'another')).rejects.toThrow();
    await expect(
      reencryptRecoveryShare(new Uint8Array(10), previous, KEK, ACCOUNT_ID),
    ).rejects.toThrow('Envelope is invalid');
  });
});
