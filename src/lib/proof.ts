import { createHash } from 'node:crypto';

/**
 * Normalise a 32-byte hex string (payment hash or preimage).
 *
 * @param raw - Caller-supplied hex, any case, surrounding whitespace allowed.
 * @returns Lowercase 64-char hex, or `null` when the shape is wrong.
 */
export function normalizeHex32(raw: string): string | null {
  const hex = raw.trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(hex)) {
    return null;
  }
  return hex;
}

/**
 * Check that `sha256(preimage)` equals the invoice payment hash.
 *
 * @param preimageHex - 32-byte preimage as hex.
 * @param paymentHashHex - Invoice payment hash as hex.
 * @returns `true` only when both are 32-byte hex and the digest matches.
 */
export function preimageMatchesHash(preimageHex: string, paymentHashHex: string): boolean {
  const preimage = normalizeHex32(preimageHex);
  const paymentHash = normalizeHex32(paymentHashHex);
  if (preimage === null || paymentHash === null) {
    return false;
  }
  const digest = createHash('sha256').update(Buffer.from(preimage, 'hex')).digest('hex');
  return digest === paymentHash;
}
