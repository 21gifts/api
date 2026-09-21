import { CHALLENGE_TTL_MS, SESSION_TTL_MS } from '@/lib/config';

/**
 * Persistence for accounts, sessions, passkeys, and address verification.
 *
 * {@link InMemoryAuthStore} is the default when `DATABASE_URL` is unset
 * (tests and local boots). {@link PostgresAuthStore} is the durable adapter
 * used when a database URL is configured. Both implement {@link AuthStore}.
 */

/**
 * Account permission / forum display tier. Staff `POST /trust/verify`,
 * `POST /trust/confirm-moderator`, and `POST /trust/appoint-moderator`
 * write `role` plus a trust edge; `POST /trust/propose-moderator` writes
 * the propose edge only. `PATCH /debug/accounts/:id` may still set `role`
 * and does not write edges. New passkey accounts stay `basis`.
 * `verified` is a moderator confirming this person in real
 * life (forum badge), not `lightningAddressVerified`.
 */
export type AccountRole = 'basis' | 'verified' | 'moderator' | 'founder';

/**
 * Owner fan-out filter. Omitted / unknown → `all`.
 *
 * - `all` — every living-room post, reply, and zap (default).
 * - `active` — related top-level post has `sats > 0` (zaps also when `amountSats > 0`).
 * - `mentions` — staff/platform actor, or a reply/zap on the recipient's own note.
 */
export type NotificationLevel = 'all' | 'active' | 'mentions';

/**
 * A registered account.
 *
 * Identity is {@link Account.id}. `linkingKey` is `null` for passkey accounts
 * and may still be set on rows created before LNURL-auth was removed.
 */
export interface Account {
  /** Opaque unique account id. */
  id: string;
  /**
   * Legacy LNURL-auth linking key (hex), or `null` for passkey accounts.
   */
  linkingKey: string | null;
  /** Permission / forum display tier. */
  role: AccountRole;
  /** Display name, or `null` until the user sets one. */
  name: string | null;
  /**
   * LUD-16 / NIP-05 local-part, or null until set. Optional on the type so
   * fixtures stay valid.
   */
  username?: string | null;
  /**
   * Free-text location set by the owner, or `null` when unset.
   * Not unique. Not a setup step. Public on member and view cards.
   */
  location: string | null;
  /** The receiver's linked Lightning Address (LUD-16), or `null` if none. */
  lightningAddress: string | null;
  /**
   * Whether control of the linked address has been proven via micro-payment
   * verification. Set only by successful confirm; linking/unlinking resets it.
   */
  lightningAddressVerified: boolean;
  /** True after the user dismissed the welcome-forum living-room laws hint. */
  forumLawsDismissed: boolean;
  /**
   * Durable capability secret for the public profile URL (`GET /view/:viewKey`).
   * 64 lowercase hex characters. Never a session; never accepted as Bearer.
   */
  viewKey: string;
  /** Creation time (epoch ms). */
  createdAt: number;
  /** Epoch ms when the account first agreed to the living-room rules, or null. */
  rulesAgreedAt: number | null;
  /**
   * True when this is the official 21.gifts platform account. At most one
   * stored account may be true. Default false. Omitted on member `GET /me`.
   */
  isPlatform?: boolean;
  /**
   * True when passkey finish and debug session mint must refuse a bearer
   * (duplicate of another member). Default false. Omitted on member `GET /me`.
   * Operators set this with `PATCH /debug/accounts/:id`.
   */
  sessionRefused?: boolean;
  /** Epoch ms when the owner skipped the name wizard step, or null/omitted. */
  nameSkippedAt?: number | null;
  /** Epoch ms when the owner skipped the Lightning Address wizard step, or null/omitted. */
  lightningAddressSkippedAt?: number | null;
  /** Id of the single top-level profile forum message, or null/omitted. */
  profileMessageId?: string | null;
  /**
   * Owner fan-out filter. Omitted / unknown → `all`. Not public on member
   * cards or view profiles. Operator debug JSON includes the stored value.
   */
  notificationLevel?: NotificationLevel;
  /**
   * True when this account must complete the wallet (recovery phrase)
   * setup step. Omit / false = existing member (not gated). New passkey
   * register and first-passkey claim set true; replace does not.
   */
  walletRequired?: boolean;
  /**
   * Epoch ms when the owner posted that the recovery phrase was shown,
   * or null/omitted when unseen.
   */
  walletBackupSeenAt?: number | null;
}

/**
 * Pending receiver address verification (one-time nonce in an LNURL-pay comment).
 * At most one record per account; replaced on re-start, cleared on confirm/link/unlink.
 */
export interface AddressVerification {
  /** Account that started verification. */
  accountId: string;
  /** Lightning Address the payment was sent to (must still match on confirm). */
  address: string;
  /** One-time nonce (32 lowercase hex chars) placed in the LUD-12 comment. */
  nonce: string;
  /** Issue time (epoch ms). */
  createdAt: number;
}

/** A discoverable WebAuthn credential bound to an account. */
export interface PasskeyCredential {
  /** Credential id as base64url (WebAuthn `id`). */
  credentialId: string;
  /** COSE public key bytes used to verify later assertions. */
  publicKey: Uint8Array;
  /** Authenticator signature counter (clone detection). */
  signCount: number;
  /** Account this credential authenticates. */
  accountId: string;
  /** Creation time (epoch ms). */
  createdAt: number;
}

/** Kind of outstanding WebAuthn ceremony. */
export type PasskeyChallengeType = 'register' | 'authenticate' | 'replace';

/**
 * A one-time WebAuthn challenge. Registration stores the pending account id;
 * authentication looks the account up from the asserted credential; replace
 * stores the signed-in account id (never null).
 */
export interface PasskeyChallenge {
  /** Opaque id returned to the client as `challengeId`. */
  id: string;
  /** Which ceremony this challenge belongs to. */
  type: PasskeyChallengeType;
  /** WebAuthn challenge (base64url) from the ceremony generator. */
  challenge: string;
  /** Pending account id for register; signed-in id for replace; `null` for authenticate. */
  accountId: string | null;
  /** Whether finish has already consumed this challenge. */
  consumed: boolean;
  /** Issue time (epoch ms). */
  createdAt: number;
}

/** A server-issued session bound to an account. */
export interface Session {
  /** Opaque bearer token (hex). */
  token: string;
  /** The account this session authenticates. */
  accountId: string;
  /** Issue time (epoch ms). */
  createdAt: number;
}

/**
 * Persistence port for the auth subsystem. In-memory and Postgres adapters
 * implement the same async contract so domain logic does not branch on storage.
 */
export interface AuthStore {
  /** Persist a new account. */
  createAccount(account: Account): Promise<void>;
  /**
   * Overwrite a stored account. A `viewKey`, non-null `linkingKey`,
   * `lightningAddress` (`lower(trim)`), or `username` (`lower(trim)`) owned
   * by another id is refused (in-memory no-op; Postgres via `UPDATE`
   * matching no row or swallowed unique_violation).
   */
  updateAccount(account: Account): Promise<void>;
  /**
   * Set `walletBackupSeenAt` to `now` when it is still null. Other columns
   * stay unchanged. Returns the stored row, or `undefined` when the id is
   * unknown.
   */
  markWalletBackupSeen(accountId: string, now: number): Promise<Account | undefined>;
  /**
   * Set only `name` on the account that owns this Lightning Address
   * (`lower(trim)` match). Other columns stay unchanged.
   *
   * @returns The updated account, or `undefined` when no row matches.
   */
  updateAccountNameByLightningAddress(
    lightningAddress: string,
    name: string,
  ): Promise<Account | undefined>;
  /**
   * Set `profileMessageId` to `nextId` only when the stored pointer still
   * matches `expectedId`. Does not change other columns. Does not touch
   * viewKey or linkingKey indexes.
   *
   * `undefined` and `null` stored pointers both match `expectedId === null`.
   *
   * @param accountId - Account id.
   * @param expectedId - Missing or blank pointer as `null`; a hidden id as
   *   the stored string.
   * @param nextId - Profile-note id to store on success.
   * @returns `true` when this caller's `nextId` is now stored; `false` when
   *   the account is unknown or the stored pointer is not `expectedId`.
   */
  claimProfileMessageId(
    accountId: string,
    expectedId: string | null,
    nextId: string,
  ): Promise<boolean>;
  /** Look up an account by id, or `undefined` if unknown. */
  getAccount(id: string): Promise<Account | undefined>;
  /**
   * Look up an account by its durable view key, or `undefined` if unknown.
   * Used by the public capability URL; never mints a session.
   */
  getAccountByViewKey(viewKey: string): Promise<Account | undefined>;
  /**
   * Look up an account by Lightning Address (`lower(trim)` match). Rows with a
   * null `lightningAddress` are skipped. At most one row matches (unique index
   * in Postgres; in-memory create/update refuse a taken address).
   */
  getAccountByLightningAddress(address: string): Promise<Account | undefined>;
  /**
   * Look up an account by username (`lower(trim)` match). Rows with a
   * null/undefined/blank `username` are skipped. At most one row matches
   * (unique index in Postgres; in-memory create/update refuse a taken handle).
   */
  getAccountByUsername(username: string): Promise<Account | undefined>;
  /**
   * Look up an account by custodial Nostr pubkey (case-insensitive hex).
   * Unique index in Postgres; in-memory scans `#nostrKeys`.
   */
  getAccountByPubkey(pubkey: string): Promise<Account | undefined>;
  /**
   * Whether the account already has at least one passkey credential.
   * Used to refuse a second claim on a provisioned profile.
   */
  accountHasPasskey(accountId: string): Promise<boolean>;
  /**
   * Drop an account row. Used to roll back `finishPasskeyRegistration` when
   * the credential insert loses a duplicate-id race.
   */
  deleteAccount(id: string): Promise<void>;
  /**
   * Every stored account, oldest first (then `id` ascending).
   * Used by the operator debug listing. Does not embed session tokens
   * (GET `/debug/accounts/:id` and dump table `auth_session` do).
   */
  listAccounts(): Promise<Account[]>;
  /** Every stored passkey credential (operator dump / account detail). */
  listPasskeyCredentials(): Promise<PasskeyCredential[]>;
  /** Every stored session (operator dump / account detail). */
  listSessions(): Promise<Session[]>;
  /** Every stored passkey challenge (operator dump / account detail). */
  listPasskeyChallenges(): Promise<PasskeyChallenge[]>;
  /** Every pending address verification (operator dump / account detail). */
  listAddressVerifications(): Promise<AddressVerification[]>;
  /**
   * Every account row's Nostr columns (pubkey may be null; kek/custody are the stored defaults).
   * In-memory `createdAt` is `null` when the adapter does not store it.
   */
  listNostrKeys(): Promise<NostrKeyListRow[]>;
  /** Persist a new session. Does not consult `sessionRefused`. */
  createSession(session: Session): Promise<void>;
  /**
   * Insert a session only when the account exists and `sessionRefused` is
   * not true. Used by {@link issueSession} so a concurrent flag flip cannot
   * mint a bearer.
   *
   * @returns `false` when no session row was written.
   */
  tryCreateSession(session: Session): Promise<boolean>;
  /**
   * Set only `sessionRefused`. Other columns stay unchanged.
   *
   * @returns The updated account, or `undefined` when the id is unknown.
   */
  setSessionRefused(accountId: string, refused: boolean): Promise<Account | undefined>;
  /** Look up a session by token, or `undefined` if unknown. */
  getSession(token: string): Promise<Session | undefined>;
  /** Upsert a pending address verification for the account. */
  putVerification(verification: AddressVerification): Promise<void>;
  /** Look up a pending verification by account id, or `undefined` if none. */
  getVerification(accountId: string): Promise<AddressVerification | undefined>;
  /** Drop any pending verification for the account. */
  deleteVerification(accountId: string): Promise<void>;
  /** Persist a freshly issued passkey ceremony challenge. */
  createPasskeyChallenge(challenge: PasskeyChallenge): Promise<void>;
  /** Look up a passkey challenge by id, or `undefined` if unknown. */
  getPasskeyChallenge(id: string): Promise<PasskeyChallenge | undefined>;
  /**
   * Mark a passkey challenge consumed. Returns false when the row is missing
   * or already consumed so concurrent finishes cannot mint two sessions.
   */
  updatePasskeyChallenge(challenge: PasskeyChallenge): Promise<boolean>;
  /**
   * Persist a verified passkey credential. Returns false when the id is
   * already stored or this account already has a credential so two adapters
   * reject duplicates the same way.
   */
  createPasskeyCredential(credential: PasskeyCredential): Promise<boolean>;
  /**
   * Persist the account's first passkey and set `walletRequired: true` in the
   * same write. Returns false when this account already has a credential, the
   * credential id is taken, or the account is session-refused.
   */
  createFirstPasskeyCredential(credential: PasskeyCredential): Promise<boolean>;
  /** Look up a passkey credential by id, or `undefined` if unknown. */
  getPasskeyCredential(credentialId: string): Promise<PasskeyCredential | undefined>;
  /**
   * Look up this account's single passkey credential, or `undefined` if none.
   */
  getPasskeyCredentialForAccount(accountId: string): Promise<PasskeyCredential | undefined>;
  /**
   * Replace this account's single credential.
   * Returns false when the account has no credential, when the new
   * credentialId is already stored for a different account, or when the
   * delete+insert does not land.
   * On success the old row is gone and `credential` is stored.
   */
  replacePasskeyCredential(credential: PasskeyCredential): Promise<boolean>;
  /**
   * Atomically advance `signCount` for clone detection.
   * Succeeds only when `(newCount === 0 && stored === 0)` or `newCount > stored`.
   * Does not rebind `accountId` or `publicKey`. Returns false when the row is
   * missing or the CAS predicate fails.
   */
  updatePasskeyCredential(credential: PasskeyCredential): Promise<boolean>;
  /** Hex pubkey for the account, or `undefined` when none. */
  getNostrPublicKey(accountId: string): Promise<string | undefined>;
  /** Encrypted nsec envelope, or `undefined` when none. Never plaintext. */
  getNostrSecret(accountId: string): Promise<Uint8Array | undefined>;
  /**
   * Persist key material only when the account has no pubkey yet.
   *
   * @returns `inserted` on first write, `exists` when a pubkey was already set.
   */
  setNostrKeyIfAbsent(accountId: string, record: NostrKeyRecord): Promise<'inserted' | 'exists'>;
  /**
   * Account ids with no Nostr pubkey yet, oldest first, capped at `limit`.
   */
  listAccountIdsWithoutNostrKey(limit: number): Promise<string[]>;
  /**
   * Account ids whose live `role` is founder or moderator.
   *
   * `verified` is not staff. Used by GET `/messages?mode=active` so unpaid
   * staff notes stay on the Active feed without selecting `account` per row.
   *
   * @returns Founder and moderator account ids (order unspecified).
   */
  listStaffAccountIds(): Promise<string[]>;
}

/** Stored custodial (or later user-owned) Nostr key material. Not on {@link Account}. */
export interface NostrKeyRecord {
  /** NIP-01 pubkey, 64 lowercase hex. */
  pubkey: string;
  /** AES-GCM envelope (`version || kek_id || nonce || ciphertext+tag`). */
  ciphertext: Uint8Array;
  /** Envelope kek id (v1 = 1). */
  kekId: number;
  /** Custody mode. v1 is always `custodial`. */
  custody: 'custodial' | 'user';
}

/** One listed Nostr column set for operator debug (every account row). */
export interface NostrKeyListRow {
  /** Owning account id. */
  accountId: string;
  /** Stored Nostr columns (ciphertext is a copy; pubkey may be null). */
  record: {
    /** NIP-01 pubkey, or `null` when `nostr_pubkey` is SQL null. */
    pubkey: string | null;
    /** AES-GCM envelope bytes (empty when the blob is missing). */
    ciphertext: Uint8Array;
    /** Envelope kek id (Postgres default 1). */
    kekId: number;
    /** Custody mode (Postgres default `custodial`). */
    custody: 'custodial' | 'user';
  };
  /** Key creation time (epoch ms), or `null` when the adapter does not store it. */
  createdAt: number | null;
}

/**
 * Process-local, non-durable {@link AuthStore} for v1. Expired passkey
 * challenges and sessions are evicted on write so minting cannot grow memory
 * without bound.
 */
export class InMemoryAuthStore implements AuthStore {
  readonly #accounts = new Map<string, Account>();
  readonly #accountsByLinkingKey = new Map<string, string>();
  readonly #accountsByViewKey = new Map<string, string>();
  readonly #sessions = new Map<string, Session>();
  readonly #verifications = new Map<string, AddressVerification>();
  readonly #passkeyChallenges = new Map<string, PasskeyChallenge>();
  readonly #passkeyCredentials = new Map<string, PasskeyCredential>();
  readonly #nostrKeys = new Map<string, NostrKeyRecord>();

  async createAccount(account: Account): Promise<void> {
    if (this.#accountsByViewKey.has(account.viewKey)) {
      return;
    }
    if (account.linkingKey !== null && this.#accountsByLinkingKey.has(account.linkingKey)) {
      return;
    }
    if (this.#lightningAddressTaken(account.lightningAddress, account.id)) {
      return;
    }
    if (this.#usernameTaken(account.username, account.id)) {
      return;
    }
    if (account.isPlatform === true) {
      this.#clearPlatformExcept(account.id);
    }
    this.#accounts.set(account.id, {
      ...account,
      sessionRefused: account.sessionRefused === true,
    });
    this.#accountsByViewKey.set(account.viewKey, account.id);
    if (account.linkingKey !== null) {
      this.#accountsByLinkingKey.set(account.linkingKey, account.id);
    }
  }

  async markWalletBackupSeen(accountId: string, now: number): Promise<Account | undefined> {
    const current = this.#accounts.get(accountId);
    if (current === undefined) {
      return undefined;
    }
    if (current.walletBackupSeenAt !== null && current.walletBackupSeenAt !== undefined) {
      return current;
    }
    const updated: Account = { ...current, walletBackupSeenAt: now };
    this.#accounts.set(accountId, updated);
    return updated;
  }

  async updateAccount(account: Account): Promise<void> {
    if (account.linkingKey !== null) {
      const ownerId = this.#accountsByLinkingKey.get(account.linkingKey);
      if (ownerId !== undefined && ownerId !== account.id) {
        return;
      }
    }
    const viewKeyOwnerId = this.#accountsByViewKey.get(account.viewKey);
    if (viewKeyOwnerId !== undefined && viewKeyOwnerId !== account.id) {
      return;
    }
    if (this.#lightningAddressTaken(account.lightningAddress, account.id)) {
      return;
    }
    if (this.#usernameTaken(account.username, account.id)) {
      return;
    }
    if (account.isPlatform === true) {
      this.#clearPlatformExcept(account.id);
    }
    const previous = this.#accounts.get(account.id);
    if (
      previous !== undefined &&
      previous.linkingKey !== null &&
      previous.linkingKey !== account.linkingKey
    ) {
      this.#accountsByLinkingKey.delete(previous.linkingKey);
    }
    if (previous !== undefined && previous.viewKey !== account.viewKey) {
      this.#accountsByViewKey.delete(previous.viewKey);
    }
    this.#accounts.set(account.id, {
      ...account,
      sessionRefused: previous?.sessionRefused === true,
      walletRequired: previous?.walletRequired === true,
      walletBackupSeenAt: previous?.walletBackupSeenAt ?? null,
    });
    this.#accountsByViewKey.set(account.viewKey, account.id);
    if (account.linkingKey !== null) {
      this.#accountsByLinkingKey.set(account.linkingKey, account.id);
    }
  }

  async updateAccountNameByLightningAddress(
    lightningAddress: string,
    name: string,
  ): Promise<Account | undefined> {
    const needle = lightningAddress.trim().toLowerCase();
    for (const account of this.#accounts.values()) {
      if (account.lightningAddress === null) {
        continue;
      }
      if (account.lightningAddress.trim().toLowerCase() === needle) {
        account.name = name;
        return account;
      }
    }
    return undefined;
  }

  async claimProfileMessageId(
    accountId: string,
    expectedId: string | null,
    nextId: string,
  ): Promise<boolean> {
    const previous = this.#accounts.get(accountId);
    if (previous === undefined) {
      return false;
    }
    if ((previous.profileMessageId ?? null) === (expectedId ?? null)) {
      this.#accounts.set(accountId, { ...previous, profileMessageId: nextId });
      return true;
    }
    return false;
  }

  async deleteAccount(id: string): Promise<void> {
    const previous = this.#accounts.get(id);
    if (previous === undefined) {
      return;
    }
    this.#accounts.delete(id);
    this.#nostrKeys.delete(id);
    this.#accountsByViewKey.delete(previous.viewKey);
    if (previous.linkingKey !== null) {
      this.#accountsByLinkingKey.delete(previous.linkingKey);
    }
  }

  async getAccount(id: string): Promise<Account | undefined> {
    return this.#accounts.get(id);
  }

  async getAccountByViewKey(viewKey: string): Promise<Account | undefined> {
    const id = this.#accountsByViewKey.get(viewKey);
    return id === undefined ? undefined : this.#accounts.get(id);
  }

  #lightningAddressTaken(address: string | null, accountId: string): boolean {
    if (address === null) {
      return false;
    }
    const needle = address.trim().toLowerCase();
    for (const other of this.#accounts.values()) {
      if (other.id === accountId || other.lightningAddress === null) {
        continue;
      }
      if (other.lightningAddress.trim().toLowerCase() === needle) {
        return true;
      }
    }
    return false;
  }

  #usernameTaken(username: string | null | undefined, accountId: string): boolean {
    if (username === null || username === undefined) {
      return false;
    }
    const needle = username.trim().toLowerCase();
    if (needle === '') {
      return false;
    }
    for (const other of this.#accounts.values()) {
      if (other.id === accountId || other.username === null || other.username === undefined) {
        continue;
      }
      if (other.username.trim().toLowerCase() === needle) {
        return true;
      }
    }
    return false;
  }

  async getAccountByLightningAddress(address: string): Promise<Account | undefined> {
    const needle = address.trim().toLowerCase();
    for (const account of this.#accounts.values()) {
      if (account.lightningAddress === null) {
        continue;
      }
      if (account.lightningAddress.trim().toLowerCase() === needle) {
        return account;
      }
    }
    return undefined;
  }

  async getAccountByUsername(username: string): Promise<Account | undefined> {
    const needle = username.trim().toLowerCase();
    if (needle === '') {
      return undefined;
    }
    for (const account of this.#accounts.values()) {
      if (account.username === null || account.username === undefined) {
        continue;
      }
      const other = account.username.trim().toLowerCase();
      if (other === '') {
        continue;
      }
      if (other === needle) {
        return account;
      }
    }
    return undefined;
  }

  async getAccountByPubkey(pubkey: string): Promise<Account | undefined> {
    const needle = pubkey.trim().toLowerCase();
    if (needle === '') {
      return undefined;
    }
    for (const [accountId, record] of this.#nostrKeys) {
      if (record.pubkey.toLowerCase() === needle) {
        return this.#accounts.get(accountId);
      }
    }
    return undefined;
  }

  async accountHasPasskey(accountId: string): Promise<boolean> {
    for (const credential of this.#passkeyCredentials.values()) {
      if (credential.accountId === accountId) {
        return true;
      }
    }
    return false;
  }

  async listAccounts(): Promise<Account[]> {
    return [...this.#accounts.values()].sort(compareAccountsForList);
  }

  async listPasskeyCredentials(): Promise<PasskeyCredential[]> {
    return [...this.#passkeyCredentials.values()].map((credential) => ({
      ...credential,
      publicKey: new Uint8Array(credential.publicKey),
    }));
  }

  async listSessions(): Promise<Session[]> {
    return [...this.#sessions.values()].map((session) => ({ ...session }));
  }

  async listPasskeyChallenges(): Promise<PasskeyChallenge[]> {
    return [...this.#passkeyChallenges.values()].map((challenge) => ({ ...challenge }));
  }

  async listAddressVerifications(): Promise<AddressVerification[]> {
    return [...this.#verifications.values()].map((row) => ({ ...row }));
  }

  async listNostrKeys(): Promise<NostrKeyListRow[]> {
    const rows: NostrKeyListRow[] = [];
    for (const account of this.#accounts.values()) {
      const stored = this.#nostrKeys.get(account.id);
      if (stored !== undefined) {
        rows.push({
          accountId: account.id,
          record: {
            ...stored,
            ciphertext: new Uint8Array(stored.ciphertext),
          },
          createdAt: null,
        });
        continue;
      }
      rows.push({
        accountId: account.id,
        record: {
          pubkey: null,
          ciphertext: new Uint8Array(),
          kekId: 1,
          custody: 'custodial',
        },
        createdAt: null,
      });
    }
    return rows;
  }

  async createSession(session: Session): Promise<void> {
    this.#evictExpiredSessions(session.createdAt);
    this.#sessions.set(session.token, session);
  }

  async tryCreateSession(session: Session): Promise<boolean> {
    const account = this.#accounts.get(session.accountId);
    if (account === undefined || account.sessionRefused === true) {
      return false;
    }
    await this.createSession(session);
    return true;
  }

  async setSessionRefused(accountId: string, refused: boolean): Promise<Account | undefined> {
    const existing = this.#accounts.get(accountId);
    if (existing === undefined) {
      return undefined;
    }
    const updated = { ...existing, sessionRefused: refused };
    this.#accounts.set(accountId, updated);
    return updated;
  }

  async getSession(token: string): Promise<Session | undefined> {
    return this.#sessions.get(token);
  }

  async putVerification(verification: AddressVerification): Promise<void> {
    this.#verifications.set(verification.accountId, verification);
  }

  async getVerification(accountId: string): Promise<AddressVerification | undefined> {
    return this.#verifications.get(accountId);
  }

  async deleteVerification(accountId: string): Promise<void> {
    this.#verifications.delete(accountId);
  }

  async createPasskeyChallenge(challenge: PasskeyChallenge): Promise<void> {
    this.#evictExpiredPasskeyChallenges(challenge.createdAt);
    this.#passkeyChallenges.set(challenge.id, challenge);
  }

  async getPasskeyChallenge(id: string): Promise<PasskeyChallenge | undefined> {
    return this.#passkeyChallenges.get(id);
  }

  async updatePasskeyChallenge(challenge: PasskeyChallenge): Promise<boolean> {
    const current = this.#passkeyChallenges.get(challenge.id);
    if (current === undefined || current.consumed) {
      return false;
    }
    this.#passkeyChallenges.set(challenge.id, challenge);
    return true;
  }

  async createPasskeyCredential(credential: PasskeyCredential): Promise<boolean> {
    if (this.#passkeyCredentials.has(credential.credentialId)) {
      return false;
    }
    for (const stored of this.#passkeyCredentials.values()) {
      if (stored.accountId === credential.accountId) {
        return false;
      }
    }
    this.#passkeyCredentials.set(credential.credentialId, credential);
    return true;
  }

  async createFirstPasskeyCredential(credential: PasskeyCredential): Promise<boolean> {
    const account = this.#accounts.get(credential.accountId);
    if (account !== undefined && account.sessionRefused === true) {
      return false;
    }
    for (const stored of this.#passkeyCredentials.values()) {
      if (stored.accountId === credential.accountId) {
        return false;
      }
    }
    if (this.#passkeyCredentials.has(credential.credentialId)) {
      return false;
    }
    const current = this.#accounts.get(credential.accountId);
    if (current === undefined) {
      return false;
    }
    this.#passkeyCredentials.set(credential.credentialId, credential);
    this.#accounts.set(current.id, { ...current, walletRequired: true });
    return true;
  }

  async getPasskeyCredential(credentialId: string): Promise<PasskeyCredential | undefined> {
    return this.#passkeyCredentials.get(credentialId);
  }

  async getPasskeyCredentialForAccount(accountId: string): Promise<PasskeyCredential | undefined> {
    for (const credential of this.#passkeyCredentials.values()) {
      if (credential.accountId === accountId) {
        return credential;
      }
    }
    return undefined;
  }

  async replacePasskeyCredential(credential: PasskeyCredential): Promise<boolean> {
    let current: PasskeyCredential | undefined;
    for (const stored of this.#passkeyCredentials.values()) {
      if (stored.accountId === credential.accountId) {
        current = stored;
        break;
      }
    }
    if (current === undefined) {
      return false;
    }
    const taken = this.#passkeyCredentials.get(credential.credentialId);
    if (taken !== undefined && taken.accountId !== credential.accountId) {
      return false;
    }
    this.#passkeyCredentials.delete(current.credentialId);
    this.#passkeyCredentials.set(credential.credentialId, credential);
    return true;
  }

  async updatePasskeyCredential(credential: PasskeyCredential): Promise<boolean> {
    const current = this.#passkeyCredentials.get(credential.credentialId);
    if (current === undefined) {
      return false;
    }
    const accepted =
      (credential.signCount === 0 && current.signCount === 0) ||
      credential.signCount > current.signCount;
    if (!accepted) {
      return false;
    }
    this.#passkeyCredentials.set(credential.credentialId, {
      ...current,
      signCount: credential.signCount,
    });
    return true;
  }

  async getNostrPublicKey(accountId: string): Promise<string | undefined> {
    return this.#nostrKeys.get(accountId)?.pubkey;
  }

  async getNostrSecret(accountId: string): Promise<Uint8Array | undefined> {
    const record = this.#nostrKeys.get(accountId);
    return record === undefined ? undefined : new Uint8Array(record.ciphertext);
  }

  async setNostrKeyIfAbsent(
    accountId: string,
    record: NostrKeyRecord,
  ): Promise<'inserted' | 'exists'> {
    if (this.#accounts.get(accountId) === undefined) {
      return 'exists';
    }
    if (this.#nostrKeys.has(accountId)) {
      return 'exists';
    }
    this.#nostrKeys.set(accountId, {
      ...record,
      ciphertext: new Uint8Array(record.ciphertext),
    });
    return 'inserted';
  }

  async listAccountIdsWithoutNostrKey(limit: number): Promise<string[]> {
    const ids = [...this.#accounts.values()]
      .filter((account) => !this.#nostrKeys.has(account.id))
      .sort(compareAccountsForList)
      .slice(0, limit)
      .map((account) => account.id);
    return ids;
  }

  /**
   * Account ids whose live `role` is founder or moderator.
   *
   * @returns Founder and moderator ids from the in-memory map (`verified` omitted).
   */
  async listStaffAccountIds(): Promise<string[]> {
    const ids: string[] = [];
    for (const account of this.#accounts.values()) {
      if (account.role === 'founder' || account.role === 'moderator') {
        ids.push(account.id);
      }
    }
    return ids;
  }

  /** Drop passkey challenges older than the TTL. */
  #evictExpiredPasskeyChallenges(now: number): void {
    for (const [id, challenge] of this.#passkeyChallenges) {
      if (now - challenge.createdAt > CHALLENGE_TTL_MS) {
        this.#passkeyChallenges.delete(id);
      }
    }
  }

  /** Ensure at most one `isPlatform` account remains. */
  #clearPlatformExcept(accountId: string): void {
    for (const other of this.#accounts.values()) {
      if (other.id !== accountId && other.isPlatform === true) {
        other.isPlatform = false;
      }
    }
  }

  /** Drop sessions older than the session TTL. */
  #evictExpiredSessions(now: number): void {
    for (const [token, session] of this.#sessions) {
      if (now - session.createdAt > SESSION_TTL_MS) {
        this.#sessions.delete(token);
      }
    }
  }
}

/**
 * Sort key for {@link AuthStore.listAccounts}: oldest `createdAt` first, then `id`.
 *
 * @param a - Left account.
 * @param b - Right account.
 * @returns Negative if `a` comes first, positive if `b` comes first, else 0.
 */
export function compareAccountsForList(a: Account, b: Account): number {
  if (a.createdAt !== b.createdAt) {
    return a.createdAt - b.createdAt;
  }
  if (a.id < b.id) {
    return -1;
  }
  if (a.id > b.id) {
    return 1;
  }
  return 0;
}
