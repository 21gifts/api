import { finalizeEvent, type EventTemplate, type VerifiedEvent } from 'nostr-tools/pure';
import type { AuthStore } from '@/lib/auth/store';
import { decryptNostrSecret, zeroizeSecret } from '@/lib/nostr/keys';
import type { ShopIdentityStore } from '@/lib/shop-identity';

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

/**
 * Decrypt a shop's secret (AAD `shop:<messageId>`), finalize a Nostr event,
 * then zeroize the secret. The AAD differs from an account key's, so a shop
 * ciphertext never decrypts as an account key or as another shop's key.
 *
 * @param store - Shop identity persistence (ciphertext only).
 * @param messageId - Shop note id (the AAD suffix).
 * @param kek - 32-byte AES KEK.
 * @param template - Unsigned event fields.
 * @returns Signed NIP-01 event.
 * @throws If the shop has no ciphertext or decrypt/finalize fails.
 */
export async function signEventForShop(
  store: ShopIdentityStore,
  messageId: string,
  kek: Uint8Array,
  template: EventTemplate,
): Promise<VerifiedEvent> {
  const ciphertext = await store.getNostrCiphertext(messageId);
  if (ciphertext === undefined) throw new Error('Shop Nostr secret missing');
  const secret = await decryptNostrSecret(ciphertext, kek, `shop:${messageId}`);
  try {
    return finalizeEvent(template, secret);
  } finally {
    zeroizeSecret(secret);
  }
}
