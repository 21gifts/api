import { randomHex } from '@/lib/auth/hex';
import { SESSION_TTL_MS } from '@/lib/config';
import type { Account, AuthStore } from '@/lib/auth/store';

/**
 * Session issuance and bearer resolution. Passkey finish paths mint a session
 * here; `/me` resolves the Authorization header through {@link resolveSession}.
 */

/**
 * Mint a bearer session for an already-authenticated account.
 *
 * @param store - Auth persistence port.
 * @param now - Current time in epoch milliseconds.
 * @param account - The account the session should authenticate.
 * @returns The new token and the same account.
 */
export async function issueSession(
  store: AuthStore,
  now: number,
  account: Account,
): Promise<{ token: string; account: Account }> {
  const token = randomHex(32);
  await store.createSession({ token, accountId: account.id, createdAt: now });
  return { token, account };
}

/**
 * Resolve a bearer session token to its account, honouring the session TTL.
 *
 * @param store - Auth persistence port.
 * @param now - Current time in epoch milliseconds.
 * @param token - The bearer session token.
 * @returns The authenticated account, or `null` when unknown or expired.
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
  return account;
}
