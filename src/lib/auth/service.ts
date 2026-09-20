import { randomHex } from '@/lib/auth/hex';
import type { Account, AuthStore } from '@/lib/auth/store';
import { isWrongAccount, WRONG_ACCOUNT_ERROR } from '@/lib/auth/wrong-account';
import { SESSION_TTL_MS } from '@/lib/config';

/**
 * Session issuance and bearer resolution. Passkey finish paths mint a session
 * here; authenticated routes other than `GET /me` resolve the Authorization
 * header through {@link resolveSession}.
 */

/**
 * Mint a bearer session for an already-authenticated account.
 * Accounts with {@link Account.sessionRefused} throw `Error` with
 * {@link WRONG_ACCOUNT_ERROR} and do not write a session row.
 *
 * @param store - Auth persistence port.
 * @param now - Current time in epoch milliseconds.
 * @param account - The account the session should authenticate.
 * @returns The new token and the same account.
 * @throws Error with message {@link WRONG_ACCOUNT_ERROR} when
 * {@link isWrongAccount} is true; no session row is written.
 */
export async function issueSession(
  store: AuthStore,
  now: number,
  account: Account,
): Promise<{ token: string; account: Account }> {
  if (isWrongAccount(account)) {
    throw new Error(WRONG_ACCOUNT_ERROR);
  }
  const token = randomHex(32);
  await store.createSession({ token, accountId: account.id, createdAt: now });
  return { token, account };
}

/**
 * Resolve a bearer session token to its account, honouring the session TTL.
 * Returns `null` when {@link isWrongAccount} is true.
 *
 * @param store - Auth persistence port.
 * @param now - Current time in epoch milliseconds.
 * @param token - The bearer session token.
 * @returns The authenticated account, or `null` when unknown, expired, or refused.
 */
export async function resolveSession(
  store: AuthStore,
  now: number,
  token: string,
): Promise<Account | null> {
  const session = await store.getSession(token);
  if (session === undefined || now - session.createdAt > SESSION_TTL_MS) {
    return null;
  }
  const account = await store.getAccount(session.accountId);
  /* v8 ignore next 3 -- a session always references an existing account in-memory */
  if (account === undefined) {
    return null;
  }
  if (isWrongAccount(account)) {
    return null;
  }
  return account;
}
