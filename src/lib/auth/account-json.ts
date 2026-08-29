import type { Account } from '@/lib/auth/store';

/**
 * Public JSON shape of an account (eight fields). Never includes Nostr
 * pubkey, ciphertext, or other key material. Omits `viewKey` (operator
 * debug listing only — not `/me` or passkey finish).
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
 * Owner-facing account JSON: the eight public fields plus the durable
 * view-key capability secret.
 */
export interface OwnerAccountResponse extends AccountResponse {
  /** 64 lowercase hex; capability URL secret for `GET /view/:viewKey`. */
  viewKey: string;
}

/**
 * Public profile card for anyone with the view-key URL. Omits identity
 * ids, role, and the view key itself.
 */
export interface ViewProfileResponse {
  /** Display name, or `null` until set. */
  name: string | null;
  /** Linked Lightning Address, or `null`. */
  lightningAddress: string | null;
  /** Whether control of the linked address has been proven. */
  lightningAddressVerified: boolean;
  /** Creation time (epoch ms). */
  createdAt: number;
}

/**
 * Project an account to the eight-field debug listing shape.
 *
 * Used by `GET /debug/accounts` only. Does not include `viewKey`.
 * Owner responses use {@link serializeOwnerAccount} instead.
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

/**
 * Project an account for the owner (`GET /me`, profile writes, passkey finish).
 *
 * Includes `viewKey` so the owner can copy the capability URL. Never used
 * by the operator debug listing.
 *
 * @param account - Stored account.
 * @returns Nine fields including `viewKey`.
 */
export function serializeOwnerAccount(account: Account): OwnerAccountResponse {
  return {
    ...serializeAccount(account),
    viewKey: account.viewKey,
  };
}

/**
 * Project an account to the public read-only profile card.
 *
 * Omits `id`, `linkingKey`, `role`, and `viewKey`.
 *
 * @param account - Stored account.
 * @returns Four public profile fields.
 */
export function serializeViewProfile(account: Account): ViewProfileResponse {
  return {
    name: account.name,
    lightningAddress: account.lightningAddress,
    lightningAddressVerified: account.lightningAddressVerified,
    createdAt: account.createdAt,
  };
}
