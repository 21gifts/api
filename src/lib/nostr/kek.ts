/**
 * Parse and validate `NOSTR_NSEC_KEK` (32-byte AES key as 64 lowercase hex).
 *
 * Fail-loud: missing or malformed values throw. Callers with `DATABASE_URL`
 * set must not listen without a valid KEK.
 */

/** Expected length of a decoded KEK (AES-256). */
export const NOSTR_KEK_BYTES = 32;

/** Hex string length for a 32-byte KEK. */
export const NOSTR_KEK_HEX_LENGTH = 64;

/**
 * Parse `NOSTR_NSEC_KEK` from an environment value.
 *
 * @param raw - Env string, or `undefined` when unset.
 * @returns 32-byte key material.
 * @throws If missing, not exactly 64 lowercase hex characters, or wrong length.
 */
export function parseNostrKek(raw: string | undefined): Uint8Array {
  if (raw === undefined || raw.trim() === '') {
    throw new Error('NOSTR_NSEC_KEK is required when DATABASE_URL is set');
  }
  const trimmed = raw.trim();
  if (!/^[0-9a-f]{64}$/.test(trimmed)) {
    throw new Error('NOSTR_NSEC_KEK must be 64 lowercase hex characters');
  }
  const out = new Uint8Array(NOSTR_KEK_BYTES);
  for (let i = 0; i < NOSTR_KEK_BYTES; i += 1) {
    out[i] = Number.parseInt(trimmed.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

/**
 * Decode a lowercase hex string to bytes.
 *
 * @param hex - Even-length lowercase hex.
 * @returns Decoded bytes.
 * @throws If length is odd or characters are not lowercase hex.
 */
export function hexToBytes(hex: string): Uint8Array {
  if (hex.length % 2 !== 0 || !/^[0-9a-f]*$/.test(hex)) {
    throw new Error('Expected lowercase hex');
  }
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i += 1) {
    out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

/**
 * Encode bytes as lowercase hex.
 *
 * @param bytes - Arbitrary bytes.
 * @returns Lowercase hex string (empty when `bytes` is empty).
 */
export function bytesToHex(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 1) {
    out += bytes[i]!.toString(16).padStart(2, '0');
  }
  return out;
}
