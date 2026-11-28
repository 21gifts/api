import { finalizeEvent, type EventTemplate, type VerifiedEvent } from 'nostr-tools/pure';
import { envelopeKekId } from '@/lib/aes-gcm-envelope';
import type { AuthStore } from '@/lib/auth/store';
import { buildKind5Event } from '@/lib/nostr/event';
import { kekIdOf } from '@/lib/nostr/kek';
import {
  currentKekEnvelope,
  decryptNostrSecret,
  publicKeyHexFromSecret,
  zeroizeSecret,
} from '@/lib/nostr/keys';
import { nostrRetiredKeyAad, type NostrRetiredKeyStore } from '@/lib/nostr/retired-key';
import type { ShopIdentityStore } from '@/lib/shop-identity';

/**
 * Decrypt the account secret, finalize a Nostr event, then zeroize the secret.
 *
 * Does not read `process.env`. Callers inject the KEK. A secret stored under
 * another KEK id (not renewed by KEK rotation yet) counts as missing
 * ({@link currentKekEnvelope}).
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
  const ciphertext = currentKekEnvelope(await store.getNostrSecret(accountId), kek, {
    accountId,
  });
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
 * Sign the NIP-09 kind 5 deletion of one event an account signed, with the
 * key that signed it: relays honour a deletion only from the pubkey of the
 * deleted event. The template is always {@link buildKind5Event} for
 * `target.eventId`, so this never signs anything else.
 *
 * - `target.pubkey` is `null` (no stored event) or the account's current
 *   pubkey: the current key signs ({@link signEventForAccount}).
 * - Otherwise the retired key of this account with that pubkey signs
 *   (`nostr_retired_key`, kept by KEK rotation). Its envelope must be under
 *   the KEK id of `kek` and opens only with the additional data
 *   `nostr_retired_key:account:<accountId>:<pubkey>`; the opened secret must
 *   derive `target.pubkey` and is zeroed after signing.
 * - No matching key (no retired-key store, no row, or a row under another
 *   KEK id): `undefined`, and nothing is signed.
 *
 * @param store - Auth persistence (current key, ciphertext only).
 * @param retiredKeys - Retired-key reader, or `undefined` (memory boots).
 * @param accountId - Author account of the event.
 * @param kek - Current `NOSTR_NSEC_KEK`.
 * @param target - Event id to delete and the `pubkey` of the stored event
 *   (64 hex), or `null` when the event is not stored.
 * @param createdAtUnix - `created_at` of the deletion.
 * @returns The signed kind 5, or `undefined` when no key of this account
 *   signed the event.
 * @throws When the current key is missing (`target.pubkey` null or current),
 *   when decryption fails, or when a retired secret derives another pubkey.
 */
export async function signDeletionForAccount(
  store: AuthStore,
  retiredKeys: NostrRetiredKeyStore | undefined,
  accountId: string,
  kek: Uint8Array,
  target: { eventId: string; pubkey: string | null },
  createdAtUnix: number,
): Promise<VerifiedEvent | undefined> {
  const template = buildKind5Event(target.eventId, createdAtUnix);
  const pubkey = target.pubkey?.toLowerCase() ?? null;
  if (pubkey === null || pubkey === (await store.getNostrPublicKey(accountId))) {
    return signEventForAccount(store, accountId, kek, template);
  }
  const retired = await retiredKeys?.getRetiredKey('account', accountId, pubkey);
  if (retired === undefined || envelopeKekId(retired.ciphertext) !== kekIdOf(kek)) {
    return undefined;
  }
  const secret = await decryptNostrSecret(
    retired.ciphertext,
    kek,
    nostrRetiredKeyAad('account', accountId, pubkey),
  );
  try {
    if (publicKeyHexFromSecret(secret) !== pubkey) {
      throw new Error('Retired Nostr key does not match its pubkey');
    }
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
  const ciphertext = currentKekEnvelope(await store.getNostrCiphertext(messageId), kek, {
    messageId,
  });
  if (ciphertext === undefined) throw new Error('Shop Nostr secret missing');
  const secret = await decryptNostrSecret(ciphertext, kek, `shop:${messageId}`);
  try {
    return finalizeEvent(template, secret);
  } finally {
    zeroizeSecret(secret);
  }
}
