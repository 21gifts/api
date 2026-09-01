/**
 * NIP-17 gift-wrap and legacy kind:4 encrypt helpers for private messages.
 *
 * Pure crypto wrappers around `nostr-tools`. Callers own secret buffers and
 * must zeroize them after use. These helpers never log secrets.
 */

import { decrypt, encrypt } from 'nostr-tools/nip04';
import { unwrapEvent, wrapEvent } from 'nostr-tools/nip17';
import type { NostrEvent } from 'nostr-tools/pure';

/**
 * Wrap a plaintext DM as a NIP-17 kind:1059 gift wrap (rumor kind:14).
 *
 * @param senderSecret - 32-byte sender nsec (caller-owned).
 * @param recipientPubkeyHex - Recipient hex pubkey.
 * @param text - Plaintext body.
 * @returns Signed kind:1059 wrap event.
 */
export function wrapNip17(
  senderSecret: Uint8Array,
  recipientPubkeyHex: string,
  text: string,
): NostrEvent {
  return wrapEvent(senderSecret, { publicKey: recipientPubkeyHex.toLowerCase() }, text);
}

/**
 * Unwrap a NIP-17 kind:1059 wrap to the rumor sender, plaintext, and rumor time.
 *
 * @param wrap - Kind:1059 event.
 * @param recipientSecret - 32-byte recipient nsec (caller-owned).
 * @returns Sender pubkey, text, and rumor `created_at`, or `null` when unwrap fails.
 */
export function unwrapNip17(
  wrap: NostrEvent,
  recipientSecret: Uint8Array,
): { senderPubkey: string; text: string; createdAt?: number } | null {
  try {
    const rumor = unwrapEvent(wrap, recipientSecret);
    if (rumor.kind !== 14) {
      return null;
    }
    const text = typeof rumor.content === 'string' ? rumor.content : '';
    const senderPubkey = typeof rumor.pubkey === 'string' ? rumor.pubkey.toLowerCase() : '';
    if (senderPubkey === '') {
      return null;
    }
    return {
      senderPubkey,
      text,
      ...(typeof rumor.created_at === 'number' ? { createdAt: rumor.created_at } : {}),
    };
  } catch {
    return null;
  }
}

/**
 * Encrypt plaintext as NIP-04 kind:4 content.
 *
 * @param senderSecret - 32-byte sender nsec (caller-owned).
 * @param recipientPubkeyHex - Recipient hex pubkey.
 * @param text - Plaintext body.
 * @returns Ciphertext string for kind:4 `content`.
 */
export function encryptKind4(
  senderSecret: Uint8Array,
  recipientPubkeyHex: string,
  text: string,
): string {
  return encrypt(senderSecret, recipientPubkeyHex.toLowerCase(), text);
}

/**
 * Decrypt NIP-04 kind:4 content.
 *
 * @param recipientSecret - 32-byte recipient nsec (caller-owned).
 * @param senderPubkeyHex - Sender hex pubkey.
 * @param content - Ciphertext from the event.
 * @returns Plaintext, or `null` when decrypt fails.
 */
export function decryptKind4(
  recipientSecret: Uint8Array,
  senderPubkeyHex: string,
  content: string,
): string | null {
  try {
    return decrypt(recipientSecret, senderPubkeyHex.toLowerCase(), content);
  } catch {
    return null;
  }
}
