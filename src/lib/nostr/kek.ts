/**
 * Parse and validate 32-byte AES keys given as 64 lowercase hex: `NOSTR_NSEC_KEK`
 * and, through {@link parseKekHex}, `RECOVERY_SHARE_KEK`.
 *
 * Fail-loud: missing or malformed values throw. Callers with `DATABASE_URL`
 * set must not listen without a valid KEK.
 *
 * Each parsed key carries a KEK id (`NOSTR_NSEC_KEK_ID`, `RECOVERY_SHARE_KEK_ID`,
 * default 1) through {@link bindKekId}; envelopes record it, and KEK rotation
 * (`rotateKeks`) renews everything stored under another id.
 */

/** Expected length of a decoded KEK (AES-256). */
export const NOSTR_KEK_BYTES = 32;

/** Hex string length for a 32-byte KEK. */
export const NOSTR_KEK_HEX_LENGTH = 64;

/**
 * Parse a 32-byte AES key from an environment value of 64 lowercase hex
 * characters (surrounding whitespace is trimmed).
 *
 * @param name - Environment variable name, used in the error messages.
 * @param raw - Env string, or `undefined` when unset.
 * @returns 32-byte key material.
 * @throws `<name> is required when DATABASE_URL is set` when missing or blank,
 *   `<name> must be 64 lowercase hex characters` otherwise.
 */
export function parseKekHex(name: string, raw: string | undefined): Uint8Array {
  if (raw === undefined || raw.trim() === '') {
    throw new Error(`${name} is required when DATABASE_URL is set`);
  }
  const trimmed = raw.trim();
  if (!/^[0-9a-f]{64}$/.test(trimmed)) {
    throw new Error(`${name} must be 64 lowercase hex characters`);
  }
  const out = new Uint8Array(NOSTR_KEK_BYTES);
  for (let i = 0; i < NOSTR_KEK_BYTES; i += 1) {
    out[i] = Number.parseInt(trimmed.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

/**
 * Parse `NOSTR_NSEC_KEK` from an environment value.
 *
 * @param raw - Env string, or `undefined` when unset.
 * @returns 32-byte key material.
 * @throws If missing, not exactly 64 lowercase hex characters, or wrong length.
 */
export function parseNostrKek(raw: string | undefined): Uint8Array {
  return parseKekHex('NOSTR_NSEC_KEK', raw);
}

/** KEK id of a key that was never given another one (the first key generation). */
export const DEFAULT_KEK_ID = 1;

/** Largest KEK id: the envelope stores it as an unsigned 32-bit integer. */
const MAX_KEK_ID = 0xffff_ffff;

/**
 * Parse the KEK id an environment variable assigns to its key
 * (`NOSTR_NSEC_KEK_ID`, `RECOVERY_SHARE_KEK_ID`).
 *
 * @param name - Environment variable name, used in the error message.
 * @param raw - Env string, or `undefined` when unset.
 * @returns {@link DEFAULT_KEK_ID} when unset or blank, else the positive integer.
 * @throws `<name> must be a positive integer` for anything that is not a
 *   decimal integer from 1 to 4294967295 (surrounding whitespace is trimmed).
 */
export function parseKekId(name: string, raw: string | undefined): number {
  if (raw === undefined || raw.trim() === '') {
    return DEFAULT_KEK_ID;
  }
  const trimmed = raw.trim();
  const value = /^[1-9][0-9]{0,9}$/.test(trimmed) ? Number(trimmed) : 0;
  if (value < 1 || value > MAX_KEK_ID) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
}

/** KEK id bound to each parsed key object (by identity, never by value). */
const KEK_IDS = new WeakMap<Uint8Array, number>();

/**
 * Bind a KEK id to one parsed key object. Every envelope sealed with this
 * object carries the id, and every open with it accepts only that id.
 *
 * @param kek - Parsed 32-byte key (the same object is returned).
 * @param kekId - Positive KEK id ({@link parseKekId}).
 * @returns `kek`, now bound to `kekId`.
 * @throws `KEK id must be a positive integer` for an id below 1, above
 *   4294967295, or not an integer.
 */
export function bindKekId(kek: Uint8Array, kekId: number): Uint8Array {
  if (!Number.isInteger(kekId) || kekId < 1 || kekId > MAX_KEK_ID) {
    throw new Error('KEK id must be a positive integer');
  }
  KEK_IDS.set(kek, kekId);
  return kek;
}

/**
 * KEK id of a key object: the id {@link bindKekId} bound to it, else
 * {@link DEFAULT_KEK_ID}.
 *
 * @param kek - Key object.
 * @returns Its KEK id.
 */
export function kekIdOf(kek: Uint8Array): number {
  return KEK_IDS.get(kek) ?? DEFAULT_KEK_ID;
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
