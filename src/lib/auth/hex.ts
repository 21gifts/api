/**
 * Cryptographically random lowercase hex tokens for sessions, nonces, and
 * passkey challenge ids.
 */

/**
 * Encode bytes as a lower-case hex string.
 *
 * @param bytes - The bytes to encode.
 * @returns The hex encoding (two chars per byte).
 */
function bytesToHex(bytes: Uint8Array): string {
  let hex = '';
  for (const b of bytes) {
    hex += b.toString(16).padStart(2, '0');
  }
  return hex;
}

/**
 * Generate a cryptographically random lower-case hex token.
 *
 * @param byteLength - Number of random bytes to produce.
 * @returns The bytes as a hex string (twice `byteLength` characters).
 */
export function randomHex(byteLength: number): string {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return bytesToHex(bytes);
}
