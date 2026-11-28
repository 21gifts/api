import { timingSafeEqual } from 'node:crypto';
import { openAesGcmEnvelope, sealAesGcmEnvelope } from '@/lib/aes-gcm-envelope';
import { DEFAULT_KEK_ID, kekIdOf, parseKekHex } from '@/lib/nostr/kek';
import { zeroizeSecret } from '@/lib/nostr/keys';

/**
 * The 21.gifts share of a social recovery set: its key (`RECOVERY_SHARE_KEK`)
 * and its encryption into the shared AES-GCM envelope, with the account id as
 * additional data. No request path decrypts a share. Shares are opened only
 * by KEK rotation (`rotateKeks`) at boot: once in the boot check with the
 * current key, then with the previous key in the read-only pass and in
 * {@link reencryptRecoveryShare}, which moves a share from the previous key to
 * the current one. Every plaintext is zeroed and never logged, returned, or
 * stored.
 */

/** A 2-of-3 SLIP-39 share of 16 bytes: 20 lowercase words of 4–8 letters, single spaces. */
export const RECOVERY_SHARE_TEXT = /^[a-z]{4,8}(?: [a-z]{4,8}){19}$/;

/**
 * KEK id of a `RECOVERY_SHARE_KEK` without a configured `RECOVERY_SHARE_KEK_ID`.
 * New envelopes carry the id of the key that seals them ({@link kekIdOf}).
 */
export const RECOVERY_SHARE_KEK_ID_V1 = DEFAULT_KEK_ID;

/**
 * Whether two parsed keys hold the same bytes (constant time).
 *
 * @param a - A 32-byte key.
 * @param b - Another 32-byte key.
 * @returns `true` when equal.
 */
function sameKey(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && timingSafeEqual(a, b);
}

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
  if (sameKey(kek, nostrKek)) {
    throw new Error('RECOVERY_SHARE_KEK must differ from NOSTR_NSEC_KEK');
  }
  return kek;
}

/**
 * Parse the optional `RECOVERY_SHARE_KEK_PREVIOUS`, the key KEK rotation
 * opens not yet rotated shares with. It is never bound to a KEK id: it opens
 * a share under any id other than the current one.
 *
 * @param raw - Env string, or `undefined` when unset.
 * @param keys - The parsed current `RECOVERY_SHARE_KEK` and `NOSTR_NSEC_KEK`.
 * @returns 32-byte key material, or `undefined` when unset or blank.
 * @throws `RECOVERY_SHARE_KEK_PREVIOUS must be 64 lowercase hex characters`
 *   for a malformed value; `RECOVERY_SHARE_KEK_PREVIOUS must differ from
 *   RECOVERY_SHARE_KEK` or `… must differ from NOSTR_NSEC_KEK` when it equals
 *   one of them.
 */
export function parsePreviousRecoveryShareKek(
  raw: string | undefined,
  keys: { recoveryShareKek: Uint8Array; nostrKek: Uint8Array },
): Uint8Array | undefined {
  if (raw === undefined || raw.trim() === '') {
    return undefined;
  }
  const kek = parseKekHex('RECOVERY_SHARE_KEK_PREVIOUS', raw);
  if (sameKey(kek, keys.recoveryShareKek)) {
    throw new Error('RECOVERY_SHARE_KEK_PREVIOUS must differ from RECOVERY_SHARE_KEK');
  }
  if (sameKey(kek, keys.nostrKek)) {
    throw new Error('RECOVERY_SHARE_KEK_PREVIOUS must differ from NOSTR_NSEC_KEK');
  }
  return kek;
}

/**
 * Encrypt a 21.gifts recovery share for one account.
 *
 * @param share - The share's 20 SLIP-39 words ({@link RECOVERY_SHARE_TEXT}).
 * @param kek - 32-byte `RECOVERY_SHARE_KEK`.
 * @param accountId - Account id (AES-GCM additional data).
 * @returns Envelope bytes with the KEK id of `kek` ({@link kekIdOf}; 1 unless
 *   `RECOVERY_SHARE_KEK_ID` sets another).
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
      kekIdOf(kek),
    );
  } finally {
    zeroizeSecret(plaintext);
  }
}

/**
 * Move one stored share from the previous recovery KEK to the current one:
 * open it with `previousKek`, seal the same bytes under `currentKek` and its
 * id, with the same additional data (the account id). The plaintext buffer
 * is zeroed before this returns or throws; it is never logged or returned.
 *
 * @param envelope - Stored `recovery_share_ciphertext`.
 * @param previousKek - `RECOVERY_SHARE_KEK_PREVIOUS`.
 * @param currentKek - `RECOVERY_SHARE_KEK` (bound to `RECOVERY_SHARE_KEK_ID`).
 * @param accountId - Account id the share was sealed for.
 * @returns The new envelope under the id of `currentKek`.
 * @throws When the envelope is malformed or does not open with `previousKek`
 *   and `accountId`, or a key is not 32 bytes.
 */
export async function reencryptRecoveryShare(
  envelope: Uint8Array,
  previousKek: Uint8Array,
  currentKek: Uint8Array,
  accountId: string,
): Promise<Uint8Array> {
  const aad = new TextEncoder().encode(accountId);
  const plaintext = await openAesGcmEnvelope(envelope, previousKek, aad);
  try {
    return await sealAesGcmEnvelope(plaintext, currentKek, aad, kekIdOf(currentKek));
  } finally {
    zeroizeSecret(plaintext);
  }
}
