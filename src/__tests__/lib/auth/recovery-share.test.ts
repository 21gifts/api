import { describe, expect, it } from 'vitest';
import {
  encryptRecoveryShare,
  parseRecoveryShareKek,
  RECOVERY_SHARE_KEK_ID_V1,
  RECOVERY_SHARE_TEXT,
} from '@/lib/auth/recovery-share';

const NOSTR_KEK = new Uint8Array(32).fill(0xab);
const KEK = new Uint8Array(32).fill(0xcd);
const ACCOUNT_ID = '3f2b8c1e-9d4a-4e7b-8c6f-1a2b3c4d5e6f';
/** A 20-word share of a 16-byte secret, from the official SLIP-39 test vectors (vector 1). */
const SHARE =
  'duckling enlarge academic academic agency result length solution fridge kidney ' +
  'coal piece deal husband erode duke ajar critical decision keyboard';

/** Open a share envelope in the test only; the api has no decrypt function. */
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
});
