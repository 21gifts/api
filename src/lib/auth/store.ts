import { CHALLENGE_TTL_MS, SESSION_TTL_MS } from '@/lib/config';

/**
 * Persistence for accounts, sessions, passkeys, and address verification.
 *
 * {@link InMemoryAuthStore} is the default when `DATABASE_URL` is unset
 * (tests and local boots). {@link PostgresAuthStore} is the durable adapter
 * used when a database URL is configured. Both implement {@link AuthStore}.
 */

/**
 * Account permission / forum display tier. Role assignment stays operator-side
 * in v1 (`PATCH /debug/accounts/:id`). New passkey accounts stay `basis`.
 * `verified` is a human-identity badge (moderator met the person), not
 * `lightningAddressVerified`.
 */
export type AccountRole = 'basis' | 'verified' | 'moderator' | 'founder';

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
export type PasskeyChallengeType = 'register' | 'authenticate';

/**
 * A one-time WebAuthn challenge. Registration stores the pending account id;
 * authentication looks the account up from the asserted credential.
 */
export interface PasskeyChallenge {
  /** Opaque id returned to the client as `challengeId`. */
  id: string;
  /** Which ceremony this challenge belongs to. */
  type: PasskeyChallengeType;
  /** WebAuthn challenge (base64url) from the ceremony generator. */
  challenge: string;
  /** Pending account id for register; `null` for authenticate. */
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
   * Overwrite a stored account. A `viewKey`, non-null `linkingKey`, or
   * `lightningAddress` (`lower(trim)`) owned by another id is refused
   * (in-memory no-op; Postgres via `UPDATE` matching no row or swallowed
   * unique_violation).
   */
  updateAccount(account: Account): Promise<void>;
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
   * Used by the operator debug listing; never includes session tokens.
   */
  listAccounts(): Promise<Account[]>;
  /** Persist a new session. */
  createSession(session: Session): Promise<void>;
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
   * already stored so two adapters reject duplicates the same way.
   */
  createPasskeyCredential(credential: PasskeyCredential): Promise<boolean>;
  /**
   * Persist the account's first passkey. Returns false when this account
   * already has a credential or the credential id is taken.
   */
  createFirstPasskeyCredential(credential: PasskeyCredential): Promise<boolean>;
  /** Look up a passkey credential by id, or `undefined` if unknown. */
  getPasskeyCredential(credentialId: string): Promise<PasskeyCredential | undefined>;
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
    this.#accounts.set(account.id, account);
    this.#accountsByViewKey.set(account.viewKey, account.id);
    if (account.linkingKey !== null) {
      this.#accountsByLinkingKey.set(account.linkingKey, account.id);
    }
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
    this.#accounts.set(account.id, account);
    this.#accountsByViewKey.set(account.viewKey, account.id);
    if (account.linkingKey !== null) {
      this.#accountsByLinkingKey.set(account.linkingKey, account.id);
    }
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

  async createSession(session: Session): Promise<void> {
    this.#evictExpiredSessions(session.createdAt);
    this.#sessions.set(session.token, session);
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
    this.#passkeyCredentials.set(credential.credentialId, credential);
    return true;
  }

  async createFirstPasskeyCredential(credential: PasskeyCredential): Promise<boolean> {
    for (const stored of this.#passkeyCredentials.values()) {
      if (stored.accountId === credential.accountId) {
        return false;
      }
    }
    return this.createPasskeyCredential(credential);
  }

  async getPasskeyCredential(credentialId: string): Promise<PasskeyCredential | undefined> {
    return this.#passkeyCredentials.get(credentialId);
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

  /** Drop passkey challenges older than the TTL. */
  #evictExpiredPasskeyChallenges(now: number): void {
    for (const [id, challenge] of this.#passkeyChallenges) {
      if (now - challenge.createdAt > CHALLENGE_TTL_MS) {
        this.#passkeyChallenges.delete(id);
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
