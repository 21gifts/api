import { generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import {
  AES_GCM_ENVELOPE_VERSION,
  AES_GCM_NONCE_BYTES,
  AES_GCM_TAG_BYTES,
  sealAesGcmEnvelope,
} from '@/lib/aes-gcm-envelope';
import type { AuthStore, NostrKeyRecord } from '@/lib/auth/store';
import { logEvent } from '@/lib/log';

/**
 * Per-account custodial Nostr key generation and AES-GCM envelope encryption.
 *
 * Plaintext secrets exist only briefly; HTTP and `Account` never carry them.
 */

/** Envelope version byte for the v1 layout (the shared AES-GCM envelope version). */
export const NOSTR_ENVELOPE_VERSION = AES_GCM_ENVELOPE_VERSION;

/** v1 KEK id written into every new envelope. */
export const NOSTR_KEK_ID_V1 = 1;

/** Port for secret generation so tests can inject fixed keys. */
export interface NostrKeygen {
  /**
   * Generate a fresh 32-byte secp256k1 secret.
   *
   * @returns Secret key bytes (caller owns; must encrypt then zeroize).
   */
  generateSecretKey(): Uint8Array;
}

/** Default keygen using `nostr-tools`. */
export const defaultNostrKeygen: NostrKeygen = {
  generateSecretKey: () => generateSecretKey(),
};

/**
 * Derive the NIP-01 hex pubkey from a 32-byte secret.
 *
 * @param secret - Raw secp256k1 secret.
 * @returns 64-char lowercase hex pubkey.
 */
export function publicKeyHexFromSecret(secret: Uint8Array): string {
  return getPublicKey(secret);
}

/**
 * Encrypt a 32-byte Nostr secret into the v1 envelope ({@link sealAesGcmEnvelope}).
 *
 * Layout: `version(1) || kek_id uint32 BE || nonce(12) || ciphertext+tag`.
 * AAD is UTF-8 `accountId`: an account id, or `shop:{messageId}` for a shop key.
 *
 * @param secret - Raw 32-byte secret.
 * @param kek - 32-byte AES key (`NOSTR_NSEC_KEK`).
 * @param accountId - AAD string: account UUID, or `shop:{messageId}` for a shop key.
 * @param kekId - Key id stored in the envelope (v1 = 1).
 * @returns Envelope bytes.
 * @throws When the secret or the KEK is not 32 bytes.
 */
export async function encryptNostrSecret(
  secret: Uint8Array,
  kek: Uint8Array,
  accountId: string,
  kekId: number = NOSTR_KEK_ID_V1,
): Promise<Uint8Array> {
  if (secret.length !== 32) {
    throw new Error('Nostr secret must be 32 bytes');
  }
  return sealAesGcmEnvelope(secret, kek, new TextEncoder().encode(accountId), kekId);
}

/**
 * Decrypt a v1 envelope to the 32-byte secret.
 *
 * v1 decrypts `kek_id=1` only. Unknown version or kek_id throws.
 *
 * @param envelope - Stored ciphertext envelope.
 * @param kek - 32-byte AES key.
 * @param accountId - AAD string: account UUID, or `shop:{messageId}` for a shop key.
 * @returns Raw 32-byte secret (caller must zeroize after use).
 */
export async function decryptNostrSecret(
  envelope: Uint8Array,
  kek: Uint8Array,
  accountId: string,
): Promise<Uint8Array> {
  if (envelope.length < 1 + 4 + AES_GCM_NONCE_BYTES + AES_GCM_TAG_BYTES) {
    throw new Error('Nostr envelope too short');
  }
  if (envelope[0] !== NOSTR_ENVELOPE_VERSION) {
    throw new Error('Unsupported Nostr envelope version');
  }
  const view = new DataView(envelope.buffer, envelope.byteOffset, envelope.byteLength);
  const kekId = view.getUint32(1, false);
  /* v8 ignore next 3 -- v1 only decrypts kek_id 1 */
  if (kekId !== NOSTR_KEK_ID_V1) {
    throw new Error('Unsupported Nostr kek_id');
  }
  if (kek.length !== 32) {
    throw new Error('KEK must be 32 bytes');
  }
  const nonce = envelope.subarray(5, 5 + AES_GCM_NONCE_BYTES);
  const ciphertext = envelope.subarray(5 + AES_GCM_NONCE_BYTES);
  const key = await crypto.subtle.importKey('raw', kek, { name: 'AES-GCM' }, false, ['decrypt']);
  const aad = new TextEncoder().encode(accountId);
  const plain = new Uint8Array(
    await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: nonce, additionalData: aad },
      key,
      ciphertext,
    ),
  );
  /* v8 ignore next 3 -- AES-GCM of a 32-byte payload */
  if (plain.length !== 32) {
    throw new Error('Decrypted Nostr secret must be 32 bytes');
  }
  return plain;
}

/**
 * Overwrite a secret buffer with zeros (best-effort; GC may retain copies).
 *
 * @param secret - Buffer to zeroize in place.
 */
export function zeroizeSecret(secret: Uint8Array): void {
  secret.fill(0);
}

/**
 * Ensure the account has a Nostr keypair. Generates and encrypts when absent.
 *
 * Concurrent callers may race; `setNostrKeyIfAbsent` CAS keeps one winner.
 * The loser's generated secret is discarded and never used to sign.
 *
 * @param store - Auth persistence.
 * @param accountId - Account id.
 * @param kek - 32-byte KEK.
 * @param keygen - Secret generator (injectable).
 * @returns Hex pubkey after ensure.
 */
export async function ensureAccountNostrKey(
  store: AuthStore,
  accountId: string,
  kek: Uint8Array,
  keygen: NostrKeygen = defaultNostrKeygen,
): Promise<string> {
  const existing = await store.getNostrPublicKey(accountId);
  if (existing !== undefined) {
    return existing;
  }
  const secret = keygen.generateSecretKey();
  try {
    const pubkey = publicKeyHexFromSecret(secret);
    const ciphertext = await encryptNostrSecret(secret, kek, accountId);
    const record: NostrKeyRecord = {
      pubkey,
      ciphertext,
      kekId: NOSTR_KEK_ID_V1,
      custody: 'custodial',
    };
    const result = await store.setNostrKeyIfAbsent(accountId, record);
    /* v8 ignore next 8 -- concurrent CAS loser */
    if (result === 'exists') {
      const again = await store.getNostrPublicKey(accountId);
      if (again === undefined) {
        throw new Error('Nostr key missing after CAS exists');
      }
      return again;
    }
    logEvent('nostr.keygen', { accountId });
    return pubkey;
  } finally {
    zeroizeSecret(secret);
  }
}

/**
 * Build a {@link NostrKeyRecord} for a freshly generated secret (register path).
 *
 * @param accountId - Account id (AAD + store key).
 * @param kek - 32-byte KEK.
 * @param keygen - Secret generator.
 * @returns Record ready for `setNostrKeyIfAbsent`.
 */
export async function generateNostrKeyRecord(
  accountId: string,
  kek: Uint8Array,
  keygen: NostrKeygen = defaultNostrKeygen,
): Promise<NostrKeyRecord> {
  const secret = keygen.generateSecretKey();
  try {
    const pubkey = publicKeyHexFromSecret(secret);
    const ciphertext = await encryptNostrSecret(secret, kek, accountId);
    return {
      pubkey,
      ciphertext,
      kekId: NOSTR_KEK_ID_V1,
      custody: 'custodial',
    };
  } finally {
    zeroizeSecret(secret);
  }
}
