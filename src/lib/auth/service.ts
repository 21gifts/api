import { encodeLnurl, randomHex, verifyAuthSig } from '@/lib/auth/lnurl';
import { CHALLENGE_TTL_MS, SESSION_TTL_MS } from '@/lib/config';
import type { Account, AuthStore } from '@/lib/auth/store';

/**
 * LNURL-auth domain logic: challenge lifecycle, account upsert on first login,
 * and session issuance / resolution. Pure functions over an {@link AuthStore}
 * and an injected `now` (epoch ms) so every branch is unit-testable.
 */

/** Result of starting a login: the QR payload plus the poll handle. */
export interface StartChallengeResult {
  /** The bech32 `lnurl1…` to render as a QR / `lightning:` deep link. */
  lnurl: string;
  /** The public challenge id (also embedded in the QR). */
  k1: string;
  /** The secret token the app must present (never in the QR) to poll for its session. */
  pollToken: string;
  /** Seconds until the challenge expires. */
  expiresInSeconds: number;
}

/**
 * Start an LNURL-auth login: mint a `k1`, persist it pending, and return the
 * bech32 `lnurl` whose callback host is pinned to `baseUrl`.
 *
 * @param store - Auth persistence port.
 * @param baseUrl - Normalised public base URL (the pinned callback host).
 * @param now - Current time in epoch milliseconds.
 * @returns The `lnurl`, its `k1`, and the challenge TTL in seconds.
 */
export function startChallenge(
  store: AuthStore,
  baseUrl: string,
  now: number,
): StartChallengeResult {
  const k1 = randomHex(32);
  const pollToken = randomHex(32);
  store.createChallenge({ k1, pollToken, status: 'pending', accountId: null, createdAt: now });
  const callback = `${baseUrl}/auth/lnurl/callback?tag=login&k1=${k1}`;
  return {
    lnurl: encodeLnurl(callback),
    k1,
    pollToken,
    expiresInSeconds: Math.floor(CHALLENGE_TTL_MS / 1000),
  };
}

/** Parameters a wallet supplies to the LUD-04 callback. */
export interface CallbackParams {
  /** The challenge being answered. */
  k1: string;
  /** The DER-encoded signature over `k1`. */
  sig: string;
  /** The wallet's compressed linkingKey (hex). */
  key: string;
}

/** Outcome of the LUD-04 callback. */
export type CallbackResult =
  { ok: true; accountId: string; firstLogin: boolean } | { ok: false; reason: string };

/**
 * Complete the LUD-04 callback: validate the challenge, verify the signature,
 * upsert the account for the linkingKey, and mark the challenge authenticated.
 *
 * @param store - Auth persistence port.
 * @param now - Current time in epoch milliseconds.
 * @param params - The `k1`, `sig`, and `key` supplied by the wallet.
 * @returns `{ ok: true, accountId, firstLogin }` on success, or
 *   `{ ok: false, reason }` otherwise.
 */
export function completeCallback(
  store: AuthStore,
  now: number,
  params: CallbackParams,
): CallbackResult {
  const challenge = store.getChallenge(params.k1);
  if (challenge === undefined) {
    return { ok: false, reason: 'Unknown or expired challenge' };
  }
  if (challenge.status !== 'pending') {
    return { ok: false, reason: 'Challenge already used' };
  }
  if (now - challenge.createdAt > CHALLENGE_TTL_MS) {
    return { ok: false, reason: 'Challenge expired' };
  }
  // Canonicalise the linkingKey (the account identity) to lower-case hex so the
  // same wallet key can never fragment into two accounts by letter-case.
  const linkingKey = params.key.toLowerCase();
  if (!verifyAuthSig(params.k1, params.sig, linkingKey)) {
    return { ok: false, reason: 'Invalid signature' };
  }
  const { account, firstLogin } = upsertAccount(store, linkingKey, now);
  store.updateChallenge({ ...challenge, status: 'authenticated', accountId: account.id });
  return { ok: true, accountId: account.id, firstLogin };
}

/**
 * Return the account for `linkingKey`, creating a Basis account on first sight.
 *
 * @returns The account and whether this call created the row.
 */
function upsertAccount(
  store: AuthStore,
  linkingKey: string,
  now: number,
): { account: Account; firstLogin: boolean } {
  const existing = store.findAccountByLinkingKey(linkingKey);
  if (existing !== undefined) {
    return { account: existing, firstLogin: false };
  }
  const account: Account = {
    id: crypto.randomUUID(),
    linkingKey,
    role: 'basis',
    name: null,
    lightningAddress: null,
    lightningAddressVerified: false,
    createdAt: now,
  };
  store.createAccount(account);
  return { account, firstLogin: true };
}

/** Outcome of polling for a session on an authenticated challenge. */
export type SessionResult =
  | { status: 'pending' }
  | { status: 'expired' }
  | { status: 'used' }
  | { status: 'authenticated'; token: string; account: Account };

/**
 * Poll a challenge and, once a wallet has authenticated it, issue a one-time
 * session token. The challenge is consumed on issuance so a session is minted
 * at most once per login.
 *
 * @param store - Auth persistence port.
 * @param now - Current time in epoch milliseconds.
 * @param pollToken - The secret poll token returned by {@link startChallenge}.
 * @returns The current status, plus the token + account when authenticated.
 */
export function claimSession(store: AuthStore, now: number, pollToken: string): SessionResult {
  const challenge = store.getChallengeByPollToken(pollToken);
  if (challenge === undefined || now - challenge.createdAt > CHALLENGE_TTL_MS) {
    return { status: 'expired' };
  }
  if (challenge.status === 'pending') {
    return { status: 'pending' };
  }
  if (challenge.status === 'consumed') {
    return { status: 'used' };
  }
  const accountId = challenge.accountId;
  /* v8 ignore next 3 -- accountId is always set once a challenge is authenticated */
  if (accountId === null) {
    return { status: 'expired' };
  }
  const account = store.getAccount(accountId);
  /* v8 ignore next 3 -- the account persists for the in-memory store's lifetime */
  if (account === undefined) {
    return { status: 'expired' };
  }
  const token = randomHex(32);
  store.createSession({ token, accountId: account.id, createdAt: now });
  store.updateChallenge({ ...challenge, status: 'consumed' });
  return { status: 'authenticated', token, account };
}

/**
 * Resolve a bearer session token to its account, honouring the session TTL.
 *
 * @param store - Auth persistence port.
 * @param now - Current time in epoch milliseconds.
 * @param token - The bearer session token.
 * @returns The authenticated account, or `null` when unknown or expired.
 */
export function resolveSession(store: AuthStore, now: number, token: string): Account | null {
  const session = store.getSession(token);
  if (session === undefined || now - session.createdAt > SESSION_TTL_MS) {
    return null;
  }
  const account = store.getAccount(session.accountId);
  /* v8 ignore next 3 -- a session always references an existing account in-memory */
  if (account === undefined) {
    return null;
  }
  return account;
}
