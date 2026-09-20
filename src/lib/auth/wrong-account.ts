import type { Account } from '@/lib/auth/store';

/**
 * Session refusal for a stored duplicate account (`account.sessionRefused`).
 * Login and debug mint refuse a bearer. The flag lives on the account row,
 * not in application code.
 */

/** Client-facing copy when a duplicate account is refused a session. */
export const WRONG_ACCOUNT_ERROR =
  'You signed in with the wrong account. Please try again with the correct account.';

/**
 * Whether this stored account must not receive a session.
 *
 * @param account - Account loaded from the store.
 * @returns `true` when {@link Account.sessionRefused} is set.
 */
export function isWrongAccount(account: Pick<Account, 'sessionRefused'>): boolean {
  return account.sessionRefused === true;
}
