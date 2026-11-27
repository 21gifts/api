/**
 * AES-256-GCM envelope shared by the custodial Nostr secret and the 21.gifts
 * recovery share.
 *
 * Layout: `version(1) || kek_id uint32 BE || nonce(12) || ciphertext+tag(16)`.
 * The key is imported non-extractable for `encrypt` only in
 * {@link sealAesGcmEnvelope}. {@link openAesGcmEnvelope} exists only for KEK
 * rotation (`rotateKeks`): it opens recovery shares with the previous key and
 * one sample envelope per current key at boot; the Nostr secret and the Spark
 * viewer mnemonic keep their own open paths for use.
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

/** Shortest v1 envelope: header, nonce, one plaintext byte, and the tag. */
const MIN_ENVELOPE_BYTES = 1 + 4 + AES_GCM_NONCE_BYTES + 1 + AES_GCM_TAG_BYTES;

/**
 * KEK id written in a v1 envelope.
 *
 * @param envelope - Stored envelope bytes.
 * @returns The big-endian id at bytes 1–4, or `undefined` when the envelope is
 *   shorter than a v1 envelope or has another version byte.
 */
export function envelopeKekId(envelope: Uint8Array): number | undefined {
  if (envelope.length < MIN_ENVELOPE_BYTES || envelope[0] !== AES_GCM_ENVELOPE_VERSION) {
    return undefined;
  }
  const view = new DataView(envelope.buffer, envelope.byteOffset, envelope.byteLength);
  return view.getUint32(1, false);
}

/**
 * Decrypt a v1 envelope with `kek`, whatever KEK id it carries (the caller
 * checks the id with {@link envelopeKekId}).
 *
 * @param envelope - Stored envelope bytes.
 * @param kek - 32-byte AES key.
 * @param additionalData - AES-GCM additional data the envelope was sealed with.
 * @returns The plaintext (caller owns it and must zeroize it after use).
 * @throws Error('Envelope is invalid') for a short envelope or another version;
 *   Error('KEK must be 32 bytes') for another key length; the Web Crypto error
 *   when the key or the additional data does not match.
 */
export async function openAesGcmEnvelope(
  envelope: Uint8Array,
  kek: Uint8Array,
  additionalData: Uint8Array,
): Promise<Uint8Array> {
  if (envelopeKekId(envelope) === undefined) {
    throw new Error('Envelope is invalid');
  }
  if (kek.length !== 32) {
    throw new Error('KEK must be 32 bytes');
  }
  const key = await crypto.subtle.importKey('raw', kek, { name: 'AES-GCM' }, false, ['decrypt']);
  return new Uint8Array(
    await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: envelope.subarray(5, 5 + AES_GCM_NONCE_BYTES), additionalData },
      key,
      envelope.subarray(5 + AES_GCM_NONCE_BYTES),
    ),
  );
}
