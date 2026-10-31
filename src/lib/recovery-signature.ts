/**
 * Signed messages of a social recovery, and their secp256k1 checks.
 *
 * The recovery message is the one the old wallet signs to finish a recovery
 * ceremony (docs/social-recovery.md, The recovery message). The LNURL transfer
 * messages are the Breez SDK `breez-lnurl:v2` messages both wallets sign for
 * `POST /lnurlpay/:pubkey/transfer`, rebuilt here so the transfer route can
 * refuse a forged claim before it marks a pending recovery forwarded.
 * Every check is ECDSA over one SHA-256 of the UTF-8 message and accepts only
 * a low S, as the LNURL server's libsecp256k1 does.
 */

import { createHash } from 'node:crypto';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { hexToBytes } from '@/lib/nostr/kek';

/** First line of every recovery message; it keeps the message out of other namespaces. */
export const RECOVERY_MESSAGE_PREFIX = '21gifts-account-recovery-v1';

/** Version field of the Breez SDK's LNURL server messages. */
const LNURL_MESSAGE_VERSION = 'breez-lnurl:v2';

/** Compressed secp256k1 public key, lowercase hex. */
const PUBKEY_HEX = /^0[23][0-9a-f]{64}$/;

/** Compact signature `r || s`, lowercase hex. */
const COMPACT_SIGNATURE_HEX = /^[0-9a-f]{128}$/;

/** DER signature, lowercase hex (8 to 72 bytes). */
const DER_SIGNATURE_HEX = /^[0-9a-f]{16,144}$/;

/**
 * Build the five-line recovery message the old wallet signs.
 *
 * @param input - Account id, the ceremony's WebAuthn challenge as issued, the
 *   new passkey's credential id, and the new wallet's identity key.
 * @returns The lines `21gifts-account-recovery-v1`, account id, challenge,
 *   credential id, and new key, joined by LF with no trailing LF.
 */
export function recoveryMessage(input: {
  accountId: string;
  challenge: string;
  credentialId: string;
  newSparkPubkey: string;
}): string {
  return [
    RECOVERY_MESSAGE_PREFIX,
    input.accountId,
    input.challenge,
    input.credentialId,
    input.newSparkPubkey,
  ].join('\n');
}

/**
 * Verify a compact low-S ECDSA signature over one SHA-256 of the UTF-8
 * message, as Breez SDK 0.26.0 `signMessage({ compact: true })` makes it.
 *
 * @param message - The signed message.
 * @param pubkeyHex - Compressed public key, 66 lowercase hex characters.
 * @param signatureHex - `r || s`, 128 lowercase hex characters.
 * @returns `true` only for a valid low-S signature by that key; `false` for
 *   any malformed key or signature, a point off the curve, or a high S.
 */
export function verifyRecoverySignature(
  message: string,
  pubkeyHex: string,
  signatureHex: string,
): boolean {
  // noble throws on a wrong length, so the shapes are checked first.
  if (!PUBKEY_HEX.test(pubkeyHex) || !COMPACT_SIGNATURE_HEX.test(signatureHex)) {
    return false;
  }
  return secp256k1.verify(hexToBytes(signatureHex), utf8(message), hexToBytes(pubkeyHex), {
    prehash: true,
    lowS: true,
    format: 'compact',
  });
}

/**
 * Build the LNURL server message the current owner signs to hand a name over
 * (Breez SDK `signed_message::transfer_from`).
 *
 * @param domain - Domain the name lives on (the `Host` the LNURL server sees).
 * @param username - Normalized username.
 * @param fromPubkey - Current owner's identity key, lowercase hex.
 * @param toPubkey - New owner's identity key, lowercase hex.
 * @param timestamp - Unix seconds.
 * @returns The LF-joined `breez-lnurl:v2` `transfer-from` message.
 */
export function lnurlTransferFromMessage(
  domain: string,
  username: string,
  fromPubkey: string,
  toPubkey: string,
  timestamp: number,
): string {
  return [
    LNURL_MESSAGE_VERSION,
    'transfer-from',
    domain,
    username,
    fromPubkey,
    toPubkey,
    String(timestamp),
  ].join('\n');
}

/**
 * Build the LNURL server message the new owner signs to take a name over
 * (Breez SDK `signed_message::transfer_to`). The description enters as the
 * lowercase SHA-256 hex of its exact UTF-8 bytes.
 *
 * @param domain - Domain the name lives on (the `Host` the LNURL server sees).
 * @param username - Normalized username.
 * @param fromPubkey - Current owner's identity key, lowercase hex.
 * @param toPubkey - New owner's identity key, lowercase hex.
 * @param description - Description the new owner stores with the name.
 * @param timestamp - Unix seconds.
 * @returns The LF-joined `breez-lnurl:v2` `transfer-to` message.
 */
export function lnurlTransferToMessage(
  domain: string,
  username: string,
  fromPubkey: string,
  toPubkey: string,
  description: string,
  timestamp: number,
): string {
  return [
    LNURL_MESSAGE_VERSION,
    'transfer-to',
    domain,
    username,
    fromPubkey,
    toPubkey,
    createHash('sha256').update(description, 'utf8').digest('hex'),
    String(timestamp),
  ].join('\n');
}

/**
 * Verify a DER low-S ECDSA signature over one SHA-256 of the UTF-8 message,
 * the check the LNURL server runs on every signed request.
 *
 * @param message - The signed message.
 * @param pubkeyHex - Compressed public key, 66 lowercase hex characters.
 * @param derHex - DER signature as lowercase hex.
 * @returns `true` only for a valid low-S signature by that key; `false` for
 *   any malformed key or signature, a point off the curve, or a high S.
 */
export function verifyLnurlDerSignature(
  message: string,
  pubkeyHex: string,
  derHex: string,
): boolean {
  if (!PUBKEY_HEX.test(pubkeyHex) || !DER_SIGNATURE_HEX.test(derHex) || derHex.length % 2 !== 0) {
    return false;
  }
  // noble answers false, without a throw, for DER bytes it cannot parse.
  return secp256k1.verify(hexToBytes(derHex), utf8(message), hexToBytes(pubkeyHex), {
    prehash: true,
    lowS: true,
    format: 'der',
  });
}

/**
 * UTF-8 bytes of a string.
 *
 * @param text - Any string.
 * @returns Its UTF-8 encoding.
 */
function utf8(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}
