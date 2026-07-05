import { bech32 } from '@scure/base';
import { secp256k1 } from '@noble/curves/secp256k1.js';

/**
 * LNURL-auth (LUD-04) primitives: challenge generation, `lnurl` encoding, and
 * signature verification. Kept free of storage and HTTP concerns so it can be
 * unit-tested with real secp256k1 vectors.
 */

/**
 * Bech32 data-length limit for encoding an LNURL. LUD-01 raises the default
 * bech32 limit (90) so a full callback URL fits into a single string.
 */
const LNURL_BECH32_LIMIT = 1023;

/** A 32-byte value as 64 hex chars (the `k1` challenge / signed digest). */
const K1_HEX = /^[0-9a-fA-F]{64}$/;

/** A compressed secp256k1 public key: `02`/`03` prefix + 32-byte X coordinate. */
const COMPRESSED_PUBKEY_HEX = /^0[23][0-9a-fA-F]{64}$/;

/** An even-length hex string (a DER-encoded signature). */
const DER_SIG_HEX = /^(?:[0-9a-fA-F]{2})+$/;

/**
 * Decode an even-length hex string into bytes. Callers validate the hex shape
 * first; this does no validation of its own.
 *
 * @param hex - An even-length hex string.
 * @returns The decoded bytes.
 */
function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

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
 * Encode an absolute callback URL as a bech32 `lnurl1…` string (LUD-01).
 *
 * @param url - The absolute HTTPS callback URL to encode.
 * @returns The lower-case `lnurl1…` bech32 string.
 */
export function encodeLnurl(url: string): string {
  const words = bech32.toWords(new TextEncoder().encode(url));
  return bech32.encode('lnurl', words, LNURL_BECH32_LIMIT);
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

/**
 * Verify an LNURL-auth (LUD-04) signature.
 *
 * The wallet signs the raw 32-byte `k1` challenge with its per-domain
 * `linkingKey`; this checks that `sig` is a valid secp256k1 ECDSA signature of
 * `k1` under the public key `key`. Malformed input is a rejected signature,
 * not a surfaced error — verification is fail-closed.
 *
 * @param k1 - The 32-byte challenge as 64-char hex (the signed message digest).
 * @param sig - The DER-encoded ECDSA signature as hex.
 * @param key - The compressed 33-byte linking public key as 66-char hex.
 * @returns `true` iff `sig` is a valid signature of `k1` under `key`.
 */
export function verifyAuthSig(k1: string, sig: string, key: string): boolean {
  if (!K1_HEX.test(k1) || !COMPRESSED_PUBKEY_HEX.test(key) || !DER_SIG_HEX.test(sig)) {
    return false;
  }
  try {
    // Parse the DER signature explicitly — this throws on a malformed encoding,
    // which the catch below turns into a fail-closed rejection.
    const signature = secp256k1.Signature.fromHex(sig, 'der');
    // prehash:false — k1 IS the 32-byte digest the wallet signed (LUD-04 signs the
    // raw k1). @noble/curves defaults to prehash:true, which would verify over
    // sha256(k1) and reject every real wallet signature.
    // lowS:false — LUD-04 does not mandate low-S; rejecting high-S signatures would
    // lock out otherwise-valid logins. The challenge is single-use, so signature
    // malleability carries no replay value here.
    return secp256k1.verify(signature.toBytes(), hexToBytes(k1), hexToBytes(key), {
      lowS: false,
      prehash: false,
    });
  } catch {
    // An unparseable DER signature or invalid public-key point is simply
    // invalid: there is exactly one correct outcome — rejection. This is a
    // fail-closed decision, not a silenced error.
    return false;
  }
}
