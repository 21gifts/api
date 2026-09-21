import { aboutMeFromNote } from '@/lib/about-me';
import {
  accountMissing,
  accountSetup,
  type AccountMissingField,
  type AccountSetup,
} from '@/lib/auth/account-setup';
import { bytesToHex } from '@/lib/auth/hex';
import type {
  Account,
  AddressVerification,
  AuthStore,
  NostrKeyListRow,
  NotificationLevel,
  PasskeyChallenge,
  PasskeyCredential,
  Session,
} from '@/lib/auth/store';
import { serializeOwnerFunding, type OwnerFundingJson } from '@/lib/funding';
import type { FundingStore } from '@/lib/funding-store';
import type { MessageStore } from '@/lib/message-store';
import { parseNotificationLevel } from '@/lib/notification';

/**
 * Public JSON shape of an account (eleven fields). Never includes Nostr
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
  /** Unique LUD-16 / NIP-05 local-part, or `null` until set. */
  username: string | null;
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
 * Owner-facing account JSON: the eleven public fields plus the durable
 * view-key capability secret, the next `setup` step, factual `missing`,
 * `hasPosted`, `aboutMe`, `aboutMeHasPhoto`, `notificationLevel`,
 * `funding`, `walletRequired`, and `walletBackupSeenAt`.
 */
export interface OwnerAccountResponse extends AccountResponse {
  /** 64 lowercase hex; capability URL secret for `GET /view/:viewKey`. */
  viewKey: string;
  /**
   * Next setup step the owner must complete (`wallet`, `name`, `username`,
   * `lightning-address`, `rules`), or `null` when the signed-in app is
   * allowed. Skip timestamps count as done for the wizard except
   * username and wallet, which cannot be skipped. Computed on the api;
   * clients must not invent a parallel sequence.
   */
  setup: AccountSetup;
  /**
   * Factually unset fields (skip does not clear them). Order: `wallet`
   * (when required and unseen), then `name`, `username`,
   * `lightning-address`, `rules`. Used by clients alongside action gates.
   */
  missing: AccountMissingField[];
  /**
   * True when there is a live non-profile forum row or About me is a real bio
   * (`aboutMe` non-null). Not the spend predicate.
   */
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
  /**
   * Funding-program grant. `null` for `basis` (do not leak grants).
   * Otherwise always an object; no row is `{ status: 'none', … }`.
   */
  funding: OwnerFundingJson | null;
  /**
   * True when the owner must complete the wallet setup step. Default
   * false when omitted in storage (existing members).
   */
  walletRequired: boolean;
  /**
   * Epoch ms when the owner posted that the recovery phrase was shown,
   * or `null` when unseen.
   */
  walletBackupSeenAt: number | null;
}

/**
 * Public profile card for anyone with the view-key URL. Omits identity
 * ids, role, and the view key itself.
 */
export interface ViewProfileResponse {
  /** Display name, or `null` until set. */
  name: string | null;
  /** Unique LUD-16 / NIP-05 local-part, or `null` until set. */
  username: string | null;
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
 * Project an account to the eleven-field public JSON shape.
 *
 * Shared by {@link serializeDebugAccount} and {@link serializeOwnerAccount}.
 * Debug routes (`GET /debug/accounts`, `PATCH /debug/accounts/:id`) use
 * {@link serializeDebugAccount}, not this function. Does not include
 * `viewKey`, Nostr columns, or `isPlatform`.
 *
 * @param account - Stored account.
 * @returns The eleven public fields only.
 */
export function serializeAccount(account: Account): AccountResponse {
  return {
    id: account.id,
    linkingKey: account.linkingKey,
    role: account.role,
    name: account.name,
    username: account.username ?? null,
    location: account.location,
    lightningAddress: account.lightningAddress,
    lightningAddressVerified: account.lightningAddressVerified,
    forumLawsDismissed: account.forumLawsDismissed,
    createdAt: account.createdAt,
    rulesAgreedAt: account.rulesAgreedAt,
  };
}

/** Operator Nostr columns for debug JSON. Never decrypts the nsec envelope. */
export interface DebugNostrFields {
  /** Custodial pubkey hex, or `null`. */
  nostrPubkey: string | null;
  /** Lowercase hex of the stored nsec envelope, or `null`. Never plaintext. */
  nostrNsecCiphertext: string | null;
  /** Envelope kek id. JSON `null` only when the list row is missing. */
  nostrKekId: number | null;
  /** Custody mode. JSON `null` only when the list row is missing. */
  nostrKeyCustody: 'custodial' | 'user' | null;
  /** Key creation time (epoch ms), or `null`. */
  nostrKeyCreatedAt: number | null;
}

/** Empty Nostr debug fields (JSON `null`, never omitted). */
export const EMPTY_DEBUG_NOSTR: DebugNostrFields = {
  nostrPubkey: null,
  nostrNsecCiphertext: null,
  nostrKekId: null,
  nostrKeyCustody: null,
  nostrKeyCreatedAt: null,
};

/** Operator JSON shape: every `account` column plus Nostr debug fields. */
export interface DebugAccountResponse extends AccountResponse {
  /** True when this is the official platform account. */
  isPlatform: boolean;
  /** True when passkey finish and debug mint must refuse a bearer. */
  sessionRefused: boolean;
  /** Durable view-key capability secret (64 lowercase hex). */
  viewKey: string;
  /** Epoch ms when the owner skipped the name wizard step, or `null`. */
  nameSkippedAt: number | null;
  /** Epoch ms when the owner skipped the Lightning Address wizard step, or `null`. */
  lightningAddressSkippedAt: number | null;
  /** Id of the single top-level profile forum message, or `null`. */
  profileMessageId: string | null;
  /** Owner fan-out filter (`all` \| `active` \| `mentions`). */
  notificationLevel: NotificationLevel;
  /** True when the owner must complete the wallet setup step. */
  walletRequired: boolean;
  /** Epoch ms when the recovery phrase was shown, or `null`. */
  walletBackupSeenAt: number | null;
  /** Custodial pubkey hex, or `null`. */
  nostrPubkey: string | null;
  /** Lowercase hex of the stored nsec envelope, or `null`. Never plaintext. */
  nostrNsecCiphertext: string | null;
  /** Envelope kek id, or `null`. */
  nostrKekId: number | null;
  /** Custody mode, or `null`. */
  nostrKeyCustody: 'custodial' | 'user' | null;
  /** Key creation time (epoch ms), or `null`. */
  nostrKeyCreatedAt: number | null;
}

/** Operator passkey credential JSON (`publicKey` is lowercase COSE hex). */
export interface PasskeyDebug {
  /** Credential id as base64url. */
  credentialId: string;
  /** COSE public key as lowercase hex. */
  publicKey: string;
  /** Authenticator signature counter. */
  signCount: number;
  /** Owning account id. */
  accountId: string;
  /** Creation time (epoch ms). */
  createdAt: number;
}

/** Operator session JSON (plaintext stored token). */
export interface SessionDebug {
  /** Opaque bearer token (hex). */
  token: string;
  /** Owning account id. */
  accountId: string;
  /** Issue time (epoch ms). */
  createdAt: number;
}

/** Operator address-verification JSON. */
export interface AddressVerificationDebug {
  /** Owning account id. */
  accountId: string;
  /** Lightning Address under proof. */
  address: string;
  /** One-time nonce. */
  nonce: string;
  /** Issue time (epoch ms). */
  createdAt: number;
}

/** Operator passkey-challenge JSON. */
export interface PasskeyChallengeDebug {
  /** Opaque challenge id. */
  id: string;
  /** Ceremony type. */
  type: string;
  /** WebAuthn challenge (base64url). */
  challenge: string;
  /** Pending account id, or `null` for authenticate. */
  accountId: string | null;
  /** Whether finish has consumed this challenge. */
  consumed: boolean;
  /** Issue time (epoch ms). */
  createdAt: number;
}

/** Operator GET `/debug/accounts/:id` body. */
export interface DebugAccountDetailResponse extends DebugAccountResponse {
  /** Passkey credentials for this account. */
  passkeys: PasskeyDebug[];
  /** Sessions for this account (plaintext tokens). */
  sessions: SessionDebug[];
  /** Pending address verification, or `null`. */
  addressVerification: AddressVerificationDebug | null;
  /** Passkey challenges whose `accountId` matches. */
  passkeyChallenges: PasskeyChallengeDebug[];
}

/**
 * Map a {@link NostrKeyListRow} onto debug Nostr JSON fields.
 *
 * A missing row becomes all-null {@link EMPTY_DEBUG_NOSTR}. A listed row with
 * `pubkey === null` still emits the stored kek id and custody. Never decrypts.
 *
 * @param row - Listed Nostr columns, or `undefined` when the account is absent from the list.
 * @returns Debug Nostr fields.
 */
export function debugNostrFieldsFromListRow(row: NostrKeyListRow | undefined): DebugNostrFields {
  if (row === undefined) {
    return EMPTY_DEBUG_NOSTR;
  }
  return {
    nostrPubkey: row.record.pubkey,
    nostrNsecCiphertext:
      row.record.ciphertext.byteLength === 0 ? null : bytesToHex(row.record.ciphertext),
    nostrKekId: row.record.kekId,
    nostrKeyCustody: row.record.custody,
    nostrKeyCreatedAt: row.createdAt ?? null,
  };
}

/**
 * Project a passkey credential for operator debug JSON.
 *
 * @param credential - Stored credential (`publicKey` is COSE bytes).
 * @returns Debug fields; `publicKey` is lowercase hex.
 */
export function serializeDebugPasskey(credential: PasskeyCredential): PasskeyDebug {
  const raw =
    credential.publicKey instanceof Uint8Array
      ? credential.publicKey
      : new Uint8Array(credential.publicKey);
  return {
    credentialId: credential.credentialId,
    publicKey: bytesToHex(raw),
    signCount: credential.signCount,
    accountId: credential.accountId,
    createdAt: credential.createdAt,
  };
}

/**
 * Project a session for operator debug JSON.
 *
 * @param session - Stored session (plaintext token).
 * @returns Debug fields including the stored token.
 */
export function serializeDebugSession(session: Session): SessionDebug {
  return {
    token: session.token,
    accountId: session.accountId,
    createdAt: session.createdAt,
  };
}

/**
 * Project a pending address verification for operator debug JSON.
 *
 * @param verification - Stored verification.
 * @returns Debug fields.
 */
export function serializeDebugAddressVerification(
  verification: AddressVerification,
): AddressVerificationDebug {
  return {
    accountId: verification.accountId,
    address: verification.address,
    nonce: verification.nonce,
    createdAt: verification.createdAt,
  };
}

/**
 * Project a passkey challenge for operator debug JSON.
 *
 * @param challenge - Stored challenge.
 * @returns Debug fields.
 */
export function serializeDebugPasskeyChallenge(challenge: PasskeyChallenge): PasskeyChallengeDebug {
  return {
    id: challenge.id,
    type: challenge.type,
    challenge: challenge.challenge,
    accountId: challenge.accountId,
    consumed: challenge.consumed,
    createdAt: challenge.createdAt,
  };
}

/**
 * Project an account for `GET /debug/accounts` and `PATCH /debug/accounts/:id`.
 *
 * Includes every `account` column plus Nostr debug fields. Never used by
 * member `GET /me`. Does not decrypt nsec.
 *
 * @param account - Stored account.
 * @param nostr - Optional Nostr columns (defaults to JSON `null`s).
 * @returns Debug fields including `viewKey`, `sessionRefused`, and Nostr columns.
 */
export function serializeDebugAccount(
  account: Account,
  nostr: DebugNostrFields = EMPTY_DEBUG_NOSTR,
): DebugAccountResponse {
  return {
    ...serializeAccount(account),
    isPlatform: account.isPlatform === true,
    sessionRefused: account.sessionRefused === true,
    viewKey: account.viewKey,
    nameSkippedAt: account.nameSkippedAt ?? null,
    lightningAddressSkippedAt: account.lightningAddressSkippedAt ?? null,
    profileMessageId: account.profileMessageId ?? null,
    notificationLevel: parseNotificationLevel(account.notificationLevel),
    walletRequired: account.walletRequired === true,
    walletBackupSeenAt: account.walletBackupSeenAt ?? null,
    nostrPubkey: nostr.nostrPubkey,
    nostrNsecCiphertext: nostr.nostrNsecCiphertext,
    nostrKekId: nostr.nostrKekId,
    nostrKeyCustody: nostr.nostrKeyCustody,
    nostrKeyCreatedAt: nostr.nostrKeyCreatedAt,
  };
}

/**
 * Project GET `/debug/accounts/:id` including nested auth rows.
 *
 * @param account - Stored account.
 * @param nostr - Nostr debug fields.
 * @param nested - Passkeys, sessions, verification, and matching challenges.
 * @returns Detail JSON.
 */
export function serializeDebugAccountDetail(
  account: Account,
  nostr: DebugNostrFields,
  nested: {
    passkeys: readonly PasskeyCredential[];
    sessions: readonly Session[];
    addressVerification: AddressVerification | undefined;
    passkeyChallenges: readonly PasskeyChallenge[];
  },
): DebugAccountDetailResponse {
  return {
    ...serializeDebugAccount(account, nostr),
    passkeys: nested.passkeys.map(serializeDebugPasskey),
    sessions: nested.sessions.map(serializeDebugSession),
    addressVerification:
      nested.addressVerification === undefined
        ? null
        : serializeDebugAddressVerification(nested.addressVerification),
    passkeyChallenges: nested.passkeyChallenges.map(serializeDebugPasskeyChallenge),
  };
}

/**
 * Project an account for the owner (`GET /me`, profile writes, passkey finish).
 *
 * Includes `viewKey` so the owner can copy the capability URL. The second
 * argument is `hasPosted`; the third is About me;
 * the fourth is whether the live profile note has a photo; the fifth is
 * `funding` (`null` for `basis`, default `null`).
 * This function performs no I/O. Never used by the operator debug listing.
 * Does not expose `profileMessageId`.
 *
 * @param account - Stored account.
 * @param hasPosted - True when there is a live non-profile forum row or About
 *   me is a real bio (`aboutMe` non-null). Name-copy, photo-only, missing, and
 *   soft-hidden notes do not count. This owner flag is not the spend predicate
 *   (`accountHasLiveTopLevelPost` / GET /invoices/posted stays unchanged).
 * @param aboutMe - Profile bio, or `null` when unfilled.
 * @param aboutMeHasPhoto - True when the live profile note has a photo.
 * @param funding - Owner funding JSON, or `null` for `basis`. Defaults to
 *   `null` so direct test callers keep a present field.
 * @returns Owner fields including `viewKey`, `setup`, `missing`,
 * `hasPosted`, `location`, `aboutMe`, `aboutMeHasPhoto`,
 * `notificationLevel`, `funding`, `walletRequired`, and `walletBackupSeenAt`.
 */
export function serializeOwnerAccount(
  account: Account,
  hasPosted: boolean,
  aboutMe: string | null,
  aboutMeHasPhoto: boolean,
  funding: OwnerFundingJson | null = null,
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
    funding,
    walletRequired: account.walletRequired === true,
    walletBackupSeenAt: account.walletBackupSeenAt ?? null,
  };
}

/** Funding lookup used by {@link serializeOwnerAccountWithPosts}. */
export interface OwnerFundingLookup {
  /** Funding-grant persistence. */
  store: FundingStore;
  /** Epoch milliseconds for lazy trial expiry. */
  nowMs: number;
  /** Account lookup for admitted `reviewedByName`. */
  authStore: Pick<AuthStore, 'getAccount'>;
}

/**
 * Project owner JSON after looking up whether the account has a live
 * non-profile forum row and loading the profile-note About me text.
 *
 * Calls {@link MessageStore.accountHasLivePost} with the account id and
 * `profileMessageId` (or `null`), loads the profile note via
 * {@link MessageStore.getById} when `profileMessageId` is non-blank, then
 * {@link serializeOwnerAccount}. `hasPosted` is true when there is a live
 * non-profile forum row or About me is a real bio (`aboutMe` non-null).
 * Name-copy, photo-only, missing, and soft-hidden notes do not count. This
 * owner flag is not the spend predicate (`accountHasLiveTopLevelPost` /
 * GET /invoices/posted stays unchanged). HTTP callers (`meRoutes`,
 * `authRoutes`) use this helper so they cannot drift. Does not wrap store
 * errors.
 *
 * @param account - Stored account.
 * @param messages - Message store (live-post lookup and profile-note read).
 * @param funding - Optional grant lookup; omitted → `basis` `null`, else
 *   `{ status: 'none', … }` without I/O.
 * @returns Owner JSON including `hasPosted`, `aboutMe`, `aboutMeHasPhoto`,
 *   `notificationLevel`, and `funding`, `walletRequired`, and `walletBackupSeenAt` (via {@link serializeOwnerAccount}).
 *   `aboutMe` is `null` when the profile note is missing or `deletedAt` is
 *   set, else `aboutMeFromNote(account.name, row.text, row.name)`.
 *   `aboutMeHasPhoto` is true iff the live row has `hasPhoto === true`.
 */
export async function serializeOwnerAccountWithPosts(
  account: Account,
  messages: Pick<MessageStore, 'accountHasLivePost' | 'getById'>,
  funding?: OwnerFundingLookup,
): Promise<OwnerAccountResponse> {
  const livePost = await messages.accountHasLivePost(account.id, account.profileMessageId ?? null);
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
  const hasPosted = livePost || aboutMe !== null;
  let fundingJson: OwnerFundingJson | null;
  if (funding === undefined) {
    fundingJson = serializeOwnerFunding(account.role, undefined, 0, null);
  } else {
    const grant = await funding.store.getByAccountId(account.id);
    let reviewerName: string | null = null;
    if (grant?.decidedBy !== null && grant?.decidedBy !== undefined) {
      const reviewer = await funding.authStore.getAccount(grant.decidedBy);
      reviewerName = reviewer?.name ?? null;
    }
    fundingJson = serializeOwnerFunding(account.role, grant, funding.nowMs, reviewerName);
  }
  return serializeOwnerAccount(account, hasPosted, aboutMe, aboutMeHasPhoto, fundingJson);
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
 * @returns Nine public profile fields (including username, location, aboutMe, and
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
    username: account.username ?? null,
    location: account.location,
    lightningAddress: account.lightningAddress,
    lightningAddressVerified: account.lightningAddressVerified,
    createdAt: account.createdAt,
    hasPasskey,
    aboutMe,
    aboutMeHasPhoto,
  };
}
