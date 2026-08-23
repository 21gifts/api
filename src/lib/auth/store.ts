import { CHALLENGE_TTL_MS, SESSION_TTL_MS } from '@/lib/config';

/**
 * Persistence for the LNURL-auth subsystem.
 *
 * {@link InMemoryAuthStore} is the default when `DATABASE_URL` is unset
 * (tests and local boots). {@link PostgresAuthStore} is the durable adapter
 * used when a database URL is configured. Both implement {@link AuthStore}.
 */

/** Account permission tier. Role assignment stays operator-side in v1. */
export type AccountRole = 'basis' | 'moderator';

/** A registered account, keyed to a wallet's per-domain LNURL-auth linkingKey. */
export interface Account {
  /** Opaque unique account id. */
  id: string;
  /** The wallet's compressed public linkingKey (hex) — the account identity. */
  linkingKey: string;
  /** Permission tier. */
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
  /** Creation time (epoch ms). */
  createdAt: number;
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

/** Lifecycle status of an LNURL-auth challenge. */
export type ChallengeStatus = 'pending' | 'authenticated' | 'consumed';

/** A single-use LNURL-auth `k1` challenge and its lifecycle. */
export interface Challenge {
  /** The 32-byte challenge as hex — public; it travels in the QR / `lnurl`. */
  k1: string;
  /**
   * The secret poll token. Returned only to the initiating app in the
   * `/auth/lnurl` response and never placed in the QR, so a QR observer cannot
   * claim the session — the session poll is authorized by this, not by `k1`.
   */
  pollToken: string;
  /** Current lifecycle status. */
  status: ChallengeStatus;
  /** The authenticated account id, or `null` until a wallet signs the challenge. */
  accountId: string | null;
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
  /** Persist a freshly issued, pending challenge. */
  createChallenge(challenge: Challenge): Promise<void>;
  /** Look up a challenge by its `k1`, or `undefined` if unknown. */
  getChallenge(k1: string): Promise<Challenge | undefined>;
  /** Look up a challenge by its secret poll token, or `undefined` if unknown. */
  getChallengeByPollToken(pollToken: string): Promise<Challenge | undefined>;
  /**
   * Advance a stored challenge. Returns false when the expected previous
   * status does not match (`authenticated` requires `pending`; `consumed`
   * requires `authenticated`) so concurrent callbacks cannot steal the row.
   */
  updateChallenge(challenge: Challenge): Promise<boolean>;
  /** Find an account by its linkingKey, or `undefined` if not registered. */
  findAccountByLinkingKey(linkingKey: string): Promise<Account | undefined>;
  /** Persist a new account. */
  createAccount(account: Account): Promise<void>;
  /** Overwrite a stored account (used to update its profile fields). */
  updateAccount(account: Account): Promise<void>;
  /** Look up an account by id, or `undefined` if unknown. */
  getAccount(id: string): Promise<Account | undefined>;
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
}

/**
 * Process-local, non-durable {@link AuthStore} for v1. Expired challenges and
 * sessions are evicted on write, so unauthenticated challenge minting cannot
 * grow memory without bound.
 */
export class InMemoryAuthStore implements AuthStore {
  readonly #challenges = new Map<string, Challenge>();
  readonly #pollTokenIndex = new Map<string, string>();
  readonly #accounts = new Map<string, Account>();
  readonly #accountsByLinkingKey = new Map<string, string>();
  readonly #sessions = new Map<string, Session>();
  readonly #verifications = new Map<string, AddressVerification>();

  async createChallenge(challenge: Challenge): Promise<void> {
    // Evict on write so unauthenticated challenge minting cannot grow the maps
    // without bound; the new challenge's own timestamp is the current time.
    this.#evictExpiredChallenges(challenge.createdAt);
    this.#challenges.set(challenge.k1, challenge);
    this.#pollTokenIndex.set(challenge.pollToken, challenge.k1);
  }

  async getChallenge(k1: string): Promise<Challenge | undefined> {
    return this.#challenges.get(k1);
  }

  async getChallengeByPollToken(pollToken: string): Promise<Challenge | undefined> {
    const k1 = this.#pollTokenIndex.get(pollToken);
    return k1 === undefined ? undefined : this.#challenges.get(k1);
  }

  async updateChallenge(challenge: Challenge): Promise<boolean> {
    const current = this.#challenges.get(challenge.k1);
    if (challenge.status === 'authenticated' && current?.status !== 'pending') {
      return false;
    }
    if (challenge.status === 'consumed' && current?.status !== 'authenticated') {
      return false;
    }
    this.#challenges.set(challenge.k1, challenge);
    return true;
  }

  async findAccountByLinkingKey(linkingKey: string): Promise<Account | undefined> {
    const id = this.#accountsByLinkingKey.get(linkingKey);
    return id === undefined ? undefined : this.#accounts.get(id);
  }

  async createAccount(account: Account): Promise<void> {
    this.#accounts.set(account.id, account);
    this.#accountsByLinkingKey.set(account.linkingKey, account.id);
  }

  async updateAccount(account: Account): Promise<void> {
    this.#accounts.set(account.id, account);
  }

  async getAccount(id: string): Promise<Account | undefined> {
    return this.#accounts.get(id);
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

  /** Drop challenges (and their poll-token index entries) older than the TTL. */
  #evictExpiredChallenges(now: number): void {
    for (const [k1, challenge] of this.#challenges) {
      if (now - challenge.createdAt > CHALLENGE_TTL_MS) {
        this.#challenges.delete(k1);
        this.#pollTokenIndex.delete(challenge.pollToken);
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
