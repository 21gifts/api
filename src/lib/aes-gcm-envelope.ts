/**
 * AES-256-GCM envelope shared by the custodial Nostr secret and the 21.gifts
 * recovery share.
 *
 * Layout: `version(1) || kek_id uint32 BE || nonce(12) || ciphertext+tag(16)`.
 * The key is imported non-extractable for `encrypt` only. This module seals;
 * it has no open function.
 */

/** Envelope version byte of the v1 layout. */
export const AES_GCM_ENVELOPE_VERSION = 0x01;

/** AES-GCM nonce length in bytes. */
export const AES_GCM_NONCE_BYTES = 12;

/** AES-GCM auth tag length in bytes (Web Crypto appends it to the ciphertext). */
export const AES_GCM_TAG_BYTES = 16;

/**
 * Encrypt `plaintext` into the v1 envelope under `kek` with a fresh random nonce.
 *
 * @param plaintext - Bytes to seal (at least one).
 * @param kek - 32-byte AES key.
 * @param additionalData - AES-GCM additional data bound to the ciphertext.
 * @param kekId - Key id written big-endian into the envelope.
 * @returns Envelope bytes: `17 + plaintext.length + 16` long.
 * @throws Error('KEK must be 32 bytes') for another key length;
 *   Error('Plaintext must not be empty') for empty plaintext.
 */
export async function sealAesGcmEnvelope(
  plaintext: Uint8Array,
  kek: Uint8Array,
  additionalData: Uint8Array,
  kekId: number,
): Promise<Uint8Array> {
  if (kek.length !== 32) {
    throw new Error('KEK must be 32 bytes');
  }
  if (plaintext.length === 0) {
    throw new Error('Plaintext must not be empty');
  }
  const nonce = crypto.getRandomValues(new Uint8Array(AES_GCM_NONCE_BYTES));
  const key = await crypto.subtle.importKey('raw', kek, { name: 'AES-GCM' }, false, ['encrypt']);
  const encrypted = new Uint8Array(
    await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce, additionalData }, key, plaintext),
  );
  const envelope = new Uint8Array(1 + 4 + AES_GCM_NONCE_BYTES + encrypted.length);
  envelope[0] = AES_GCM_ENVELOPE_VERSION;
  new DataView(envelope.buffer).setUint32(1, kekId, false);
  envelope.set(nonce, 5);
  envelope.set(encrypted, 5 + AES_GCM_NONCE_BYTES);
  return envelope;
}
