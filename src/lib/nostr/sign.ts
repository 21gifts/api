import { finalizeEvent, type EventTemplate, type VerifiedEvent } from 'nostr-tools/pure';
import type { AuthStore } from '@/lib/auth/store';
import { decryptNostrSecret, zeroizeSecret } from '@/lib/nostr/keys';

/**
 * Decrypt the account secret, finalize a Nostr event, then zeroize the secret.
 *
 * Does not read `process.env`. Callers inject the KEK.
 */

/**
 * Sign an unsigned event template with the account's custodial key.
 *
 * @param store - Auth persistence (ciphertext only).
 * @param accountId - Account whose key to use.
 * @param kek - 32-byte AES KEK.
 * @param template - Unsigned event fields (`kind`, `content`, `tags`, `created_at`).
 * @returns Signed NIP-01 event.
 * @throws If the account has no ciphertext or decrypt/finalize fails.
 */
export async function signEventForAccount(
  store: AuthStore,
  accountId: string,
  kek: Uint8Array,
  template: EventTemplate,
): Promise<VerifiedEvent> {
  const ciphertext = await store.getNostrSecret(accountId);
  if (ciphertext === undefined) {
    throw new Error('Nostr secret missing');
  }
  const secret = await decryptNostrSecret(ciphertext, kek, accountId);
  try {
    return finalizeEvent(template, secret);
  } finally {
    zeroizeSecret(secret);
  }
}
