import {
  accountMissing,
  accountSetup,
  type AccountMissingField,
  type AccountSetup,
} from '@/lib/auth/account-setup';
import type { Account } from '@/lib/auth/store';

/**
 * Public JSON shape of an account (nine fields). Never includes Nostr
 * pubkey, ciphertext, or other key material. Omits `viewKey` (operator
 * debug listing only — not `/me` or passkey finish).
 */
export interface AccountResponse {
  /** Opaque unique account id. */
  id: string;
  /** Legacy LNURL-auth linking key, or `null` for passkey accounts. */
  linkingKey: string | null;
  /** Permission / forum display tier (`basis` \| `verified` \| `moderator` \| `founder`). */
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
  /** Epoch ms of first living-room rules agreement, or `null`. */
  rulesAgreedAt: number | null;
}

/**
 * Owner-facing account JSON: the nine public fields plus the durable
 * view-key capability secret, the next `setup` step, and factual `missing`.
 */
export interface OwnerAccountResponse extends AccountResponse {
  /** 64 lowercase hex; capability URL secret for `GET /view/:viewKey`. */
  viewKey: string;
  /**
   * Next setup step the owner must complete (`name`, `lightning-address`,
   * `rules`), or `null` when the signed-in app is allowed. Skip timestamps
   * count as done for the wizard. Computed on the api; clients must not
   * invent a parallel sequence.
   */
  setup: AccountSetup;
  /**
   * Factually unset fields (skip does not clear them). Order: `name`,
   * `lightning-address`, `rules`. Used by clients alongside action gates.
   */
  missing: AccountMissingField[];
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
  /** True when the account has at least one passkey credential. */
  hasPasskey: boolean;
}

/**
 * Project an account to the nine-field public JSON shape.
 *
 * Shared by {@link serializeDebugAccount} and {@link serializeOwnerAccount}.
 * Debug routes (`GET /debug/accounts`, `PATCH /debug/accounts/:id`) use
 * {@link serializeDebugAccount}, not this function. Does not include
 * `viewKey` or `isPlatform`.
 *
 * @param account - Stored account.
 * @returns The nine public fields only.
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
    rulesAgreedAt: account.rulesAgreedAt,
  };
}

/** Operator JSON shape: the nine public fields plus `isPlatform`. */
export interface DebugAccountResponse extends AccountResponse {
  /** True when this is the official platform account. */
  isPlatform: boolean;
}

/**
 * Project an account for `GET /debug/accounts` and `PATCH /debug/accounts/:id`.
 *
 * Includes `isPlatform`. Never used by member `GET /me`.
 *
 * @param account - Stored account.
 * @returns Debug fields including `isPlatform`.
 */
export function serializeDebugAccount(account: Account): DebugAccountResponse {
  return {
    ...serializeAccount(account),
    isPlatform: account.isPlatform === true,
  };
}

/**
 * Project an account for the owner (`GET /me`, profile writes, passkey finish).
 *
 * Includes `viewKey` so the owner can copy the capability URL. Never used
 * by the operator debug listing. Does not expose `profileMessageId`.
 *
 * @param account - Stored account.
 * @returns Twelve fields including `viewKey`, `setup`, and `missing`.
 */
export function serializeOwnerAccount(account: Account): OwnerAccountResponse {
  return {
    ...serializeAccount(account),
    viewKey: account.viewKey,
    setup: accountSetup(account),
    missing: accountMissing(account),
  };
}

/**
 * Project an account to the public read-only profile card.
 *
 * Omits `id`, `linkingKey`, `role`, and `viewKey`.
 *
 * @param account - Stored account.
 * @param hasPasskey - Whether the account already has a passkey credential.
 * @returns Five public profile fields.
 */
export function serializeViewProfile(account: Account, hasPasskey: boolean): ViewProfileResponse {
  return {
    name: account.name,
    lightningAddress: account.lightningAddress,
    lightningAddressVerified: account.lightningAddressVerified,
    createdAt: account.createdAt,
    hasPasskey,
  };
}
