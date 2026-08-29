import type { Account } from '@/lib/auth/store';

/**
 * Public JSON shape of an account (eight fields). Never includes Nostr
 * pubkey, ciphertext, or other key material.
 */
export interface AccountResponse {
  /** Opaque unique account id. */
  id: string;
  /** Legacy LNURL-auth linking key, or `null` for passkey accounts. */
  linkingKey: string | null;
  /** Permission tier. */
  role: string;
  /** Display name, or `null` until set. */
  name: string | null;
  /** Linked Lightning Address, or `null`. */
  lightningAddress: string | null;
  /** Whether control of the linked address has been proven. */
  lightningAddressVerified: boolean;
  /** True after the user dismissed the welcome-forum living-room laws hint. */
  forumLawsDismissed: boolean;
  /** Creation time (epoch ms). */
  createdAt: number;
}

/**
 * Project an account to its public JSON shape.
 *
 * Used by passkey finish, `GET /me`, and `GET /debug/accounts` so those
 * bodies never grow Nostr fields.
 *
 * @param account - Stored account.
 * @returns The eight public fields only.
 */
export function serializeAccount(account: Account): AccountResponse {
  return {
    id: account.id,
    linkingKey: account.linkingKey,
    role: account.role,
    name: account.name,
    lightningAddress: account.lightningAddress,
    lightningAddressVerified: account.lightningAddressVerified,
    forumLawsDismissed: account.forumLawsDismissed,
    createdAt: account.createdAt,
  };
}
