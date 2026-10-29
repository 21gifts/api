import { timingSafeEqual } from 'node:crypto';
import { sealAesGcmEnvelope } from '@/lib/aes-gcm-envelope';
import { parseKekHex } from '@/lib/nostr/kek';
import { zeroizeSecret } from '@/lib/nostr/keys';

/**
 * The 21.gifts share of a social recovery set: its key (`RECOVERY_SHARE_KEK`)
 * and its encryption into the shared AES-GCM envelope, with the account id as
 * additional data. Nothing in the api decrypts a share, so this module has no
 * decrypt function. The plaintext is never logged, returned, or stored.
 */

/** A 2-of-3 SLIP-39 share of 16 bytes: 20 lowercase words of 4–8 letters, single spaces. */
export const RECOVERY_SHARE_TEXT = /^[a-z]{4,8}(?: [a-z]{4,8}){19}$/;

/** KEK id written into every share envelope. */
export const RECOVERY_SHARE_KEK_ID_V1 = 1;

/**
 * Parse `RECOVERY_SHARE_KEK` from an environment value and refuse a key equal
 * to `NOSTR_NSEC_KEK`.
 *
 * @param raw - Env string, or `undefined` when unset.
 * @param nostrKek - The parsed `NOSTR_NSEC_KEK`.
 * @returns 32-byte key material.
 * @throws When missing or blank, or not 64 lowercase hex characters (the
 *   messages of {@link parseKekHex} with that name), or equal to `nostrKek`
 *   ("RECOVERY_SHARE_KEK must differ from NOSTR_NSEC_KEK").
 */
export function parseRecoveryShareKek(raw: string | undefined, nostrKek: Uint8Array): Uint8Array {
  const kek = parseKekHex('RECOVERY_SHARE_KEK', raw);
  if (kek.length === nostrKek.length && timingSafeEqual(kek, nostrKek)) {
    throw new Error('RECOVERY_SHARE_KEK must differ from NOSTR_NSEC_KEK');
  }
  return kek;
}

/**
 * Encrypt a 21.gifts recovery share for one account.
 *
 * @param share - The share's 20 SLIP-39 words ({@link RECOVERY_SHARE_TEXT}).
 * @param kek - 32-byte `RECOVERY_SHARE_KEK`.
 * @param accountId - Account id (AES-GCM additional data).
 * @returns Envelope bytes with kek id {@link RECOVERY_SHARE_KEK_ID_V1}.
 * @throws Error('Invalid recovery share') when `share` does not match
 *   {@link RECOVERY_SHARE_TEXT}; Error('KEK must be 32 bytes') for another key length.
 */
export async function encryptRecoveryShare(
  share: string,
  kek: Uint8Array,
  accountId: string,
): Promise<Uint8Array> {
  if (!RECOVERY_SHARE_TEXT.test(share)) {
    throw new Error('Invalid recovery share');
  }
  const plaintext = new TextEncoder().encode(share);
  try {
    return await sealAesGcmEnvelope(
      plaintext,
      kek,
      new TextEncoder().encode(accountId),
      RECOVERY_SHARE_KEK_ID_V1,
    );
  } finally {
    zeroizeSecret(plaintext);
  }
}
