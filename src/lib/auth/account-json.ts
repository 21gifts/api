import { aboutMeFromNote } from '@/lib/about-me';
import {
  accountMissing,
  accountSetup,
  type AccountMissingField,
  type AccountSetup,
} from '@/lib/auth/account-setup';
import type { Account, NotificationLevel } from '@/lib/auth/store';
import type { MessageStore } from '@/lib/message-store';
import { parseNotificationLevel } from '@/lib/notification';

/**
 * Public JSON shape of an account (ten fields). Never includes Nostr
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
  /** Free-text location set by the owner, or `null` when unset. */
  location: string | null;
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
 * Owner-facing account JSON: the ten public fields plus the durable
 * view-key capability secret, the next `setup` step, factual `missing`,
 * `hasPosted`, `aboutMe`, `aboutMeHasPhoto`, and `notificationLevel`.
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
  /** True when this account has a live forum row that is not the profile note. */
  hasPosted: boolean;
  /**
   * Profile-note text when it is a real bio, or `null` when empty, when
   * the trimmed text equals the display name or stored note name, or when
   * the profile note is missing or soft-hidden (`deletedAt` set).
   */
  aboutMe: string | null;
  /**
   * True when the live profile note (`deletedAt === null`) has a stored
   * photo. False when there is no live note. Independent of `aboutMe`
   * (a photo-only / name-copy note can still have a photo).
   */
  aboutMeHasPhoto: boolean;
  /**
   * Owner fan-out filter (`all` \| `active` \| `mentions`). Default `all`.
   * Owner-only; omitted from public `GET /view/:viewKey` and member cards.
   */
  notificationLevel: NotificationLevel;
}

/**
 * Public profile card for anyone with the view-key URL. Omits identity
 * ids, role, and the view key itself.
 */
export interface ViewProfileResponse {
  /** Display name, or `null` until set. */
  name: string | null;
  /** Free-text location set by the owner, or `null` when unset. */
  location: string | null;
  /** Linked Lightning Address, or `null`. */
  lightningAddress: string | null;
  /** Whether control of the linked address has been proven. */
  lightningAddressVerified: boolean;
  /** Creation time (epoch ms). */
  createdAt: number;
  /** True when the account has at least one passkey credential. */
  hasPasskey: boolean;
  /**
   * Profile-note text when it is a real bio, or `null` when empty, when
   * the trimmed text equals the display name or stored note name, or when
   * the profile note is missing or soft-hidden (`deletedAt` set).
   */
  aboutMe: string | null;
  /**
   * True when the live profile note (`deletedAt === null`) has a stored
   * photo. False when there is no live note.
   */
  aboutMeHasPhoto: boolean;
}

/**
 * Project an account to the ten-field public JSON shape.
 *
 * Shared by {@link serializeDebugAccount} and {@link serializeOwnerAccount}.
 * Debug routes (`GET /debug/accounts`, `PATCH /debug/accounts/:id`) use
 * {@link serializeDebugAccount}, not this function. Does not include
 * `viewKey` or `isPlatform`.
 *
 * @param account - Stored account.
 * @returns The ten public fields only.
 */
export function serializeAccount(account: Account): AccountResponse {
  return {
    id: account.id,
    linkingKey: account.linkingKey,
    role: account.role,
    name: account.name,
    location: account.location,
    lightningAddress: account.lightningAddress,
    lightningAddressVerified: account.lightningAddressVerified,
    forumLawsDismissed: account.forumLawsDismissed,
    createdAt: account.createdAt,
    rulesAgreedAt: account.rulesAgreedAt,
  };
}

/** Operator JSON shape: the ten public fields plus `isPlatform`. */
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
 * Includes `viewKey` so the owner can copy the capability URL. The second
 * argument is the live-post flag (`hasPosted`); the third is About me;
 * the fourth is whether the live profile note has a photo.
 * This function performs no I/O. Never used by the operator debug listing.
 * Does not expose `profileMessageId`.
 *
 * @param account - Stored account.
 * @param hasPosted - True when the account has a live non-profile forum row.
 * @param aboutMe - Profile bio, or `null` when unfilled.
 * @param aboutMeHasPhoto - True when the live profile note has a photo.
 * @returns Seventeen fields including `viewKey`, `setup`, `missing`,
 * `hasPosted`, `location`, `aboutMe`, `aboutMeHasPhoto`, and
 * `notificationLevel`.
 */
export function serializeOwnerAccount(
  account: Account,
  hasPosted: boolean,
  aboutMe: string | null,
  aboutMeHasPhoto: boolean,
): OwnerAccountResponse {
  return {
    ...serializeAccount(account),
    viewKey: account.viewKey,
    setup: accountSetup(account),
    missing: accountMissing(account),
    hasPosted,
    aboutMe,
    aboutMeHasPhoto,
    notificationLevel: parseNotificationLevel(account.notificationLevel),
  };
}

/**
 * Project owner JSON after looking up whether the account has a live
 * non-profile forum row and loading the profile-note About me text.
 *
 * Calls {@link MessageStore.accountHasLivePost} with the account id and
 * `profileMessageId` (or `null`), loads the profile note via
 * {@link MessageStore.getById} when `profileMessageId` is non-blank, then
 * {@link serializeOwnerAccount}. HTTP callers (`meRoutes`, `authRoutes`) use
 * this helper so they cannot drift. Does not wrap store errors.
 *
 * @param account - Stored account.
 * @param messages - Message store (live-post lookup and profile-note read).
 * @returns Owner JSON including `hasPosted`, `aboutMe`, `aboutMeHasPhoto`,
 *   and `notificationLevel` (via {@link serializeOwnerAccount}). `aboutMe` is
 *   `null` when the profile note is missing or `deletedAt` is set, else
 *   `aboutMeFromNote(account.name, row.text, row.name)`.
 *   `aboutMeHasPhoto` is true iff the live row has `hasPhoto === true`.
 */
export async function serializeOwnerAccountWithPosts(
  account: Account,
  messages: Pick<MessageStore, 'accountHasLivePost' | 'getById'>,
): Promise<OwnerAccountResponse> {
  const hasPosted = await messages.accountHasLivePost(account.id, account.profileMessageId ?? null);
  const profileId = account.profileMessageId;
  let aboutMe: string | null = null;
  let aboutMeHasPhoto = false;
  if (typeof profileId === 'string' && profileId.trim() !== '') {
    const row = await messages.getById(profileId);
    if (row !== undefined && row.deletedAt === null) {
      aboutMe = aboutMeFromNote(account.name, row.text, row.name);
      aboutMeHasPhoto = row.hasPhoto === true;
    }
  }
  return serializeOwnerAccount(account, hasPosted, aboutMe, aboutMeHasPhoto);
}

/**
 * Project an account to the public read-only profile card.
 *
 * Omits `id`, `linkingKey`, `role`, and `viewKey`.
 *
 * @param account - Stored account.
 * @param hasPasskey - Whether the account already has a passkey credential.
 * @param aboutMe - Profile bio, or `null` when unfilled.
 * @param aboutMeHasPhoto - True when the live profile note has a photo.
 * @returns Eight public profile fields (including location, aboutMe, and
 *   aboutMeHasPhoto).
 */
export function serializeViewProfile(
  account: Account,
  hasPasskey: boolean,
  aboutMe: string | null,
  aboutMeHasPhoto: boolean,
): ViewProfileResponse {
  return {
    name: account.name,
    location: account.location,
    lightningAddress: account.lightningAddress,
    lightningAddressVerified: account.lightningAddressVerified,
    createdAt: account.createdAt,
    hasPasskey,
    aboutMe,
    aboutMeHasPhoto,
  };
}
