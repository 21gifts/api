/**
 * Listed account ids that must not receive a session. Duplicate of a
 * verified member; login and debug mint refuse a bearer.
 */

/** Client-facing copy when a listed duplicate account is refused a session. */
export const WRONG_ACCOUNT_ERROR =
  'You signed in with the wrong account. Please try again with the correct account.';

/** Account ids that must not receive a bearer session. */
export const WRONG_ACCOUNT_IDS: ReadonlySet<string> = new Set([
  '7191f7a8-2cf1-4d67-a46e-f33e79996c0a',
]);

/**
 * Whether this account id is listed as a duplicate that must not receive a
 * session.
 *
 * @param accountId - Account id from a passkey, session, or debug mint.
 * @returns `true` when the id is in {@link WRONG_ACCOUNT_IDS}.
 */
export function isWrongAccount(accountId: string): boolean {
  return WRONG_ACCOUNT_IDS.has(accountId);
}
