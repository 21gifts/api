import type { Account } from '@/lib/auth/store';

/**
 * Next owner setup step. The api is the source of truth; clients only route.
 *
 * Order matches onboarding: wallet (when required and unseen), then name,
 * then username, then Lightning Address, then living-room rules. Username
 * and wallet cannot be skipped. Skip timestamps count as done for the
 * name and Lightning Address wizard steps. `null` means the account may
 * use the signed-in app.
 */
export type AccountSetup = 'wallet' | 'name' | 'username' | 'lightning-address' | 'rules' | null;

/**
 * Account fields that are factually unset (skip does not count).
 *
 * Used by action gates via {@link requireAction}; order is `wallet`
 * (when required and unseen), then `name`, `username`,
 * `lightning-address`, `rules`. Wallet is not an action requirement;
 * {@link accountSetup} is the lock.
 */
export type AccountMissingField = 'wallet' | 'name' | 'username' | 'lightning-address' | 'rules';

/**
 * Whether a required wallet backup has not been recorded yet.
 *
 * @param account - Stored account.
 * @returns True when `walletRequired` is set and `walletBackupSeenAt` is unset.
 */
function walletBackupUnseen(account: Account): boolean {
  return (
    account.walletRequired === true &&
    (account.walletBackupSeenAt === null || account.walletBackupSeenAt === undefined)
  );
}

/**
 * Compute the next setup step from stored account fields.
 *
 * A skip timestamp counts as completing that wizard step. Blank strings
 * after trim count as missing unless skipped. Wallet is first when
 * required and unseen; it cannot be skipped.
 *
 * @param account - Stored account.
 * @returns The next required step, or `null` when setup is complete.
 */
export function accountSetup(account: Account): AccountSetup {
  if (walletBackupUnseen(account)) {
    return 'wallet';
  }
  const nameBlank = account.name === null || account.name.trim() === '';
  const nameSkipped = account.nameSkippedAt !== null && account.nameSkippedAt !== undefined;
  if (nameBlank && !nameSkipped) {
    return 'name';
  }
  const usernameBlank =
    account.username === null || account.username === undefined || account.username.trim() === '';
  if (usernameBlank) {
    return 'username';
  }
  const lnBlank = account.lightningAddress === null || account.lightningAddress.trim() === '';
  const lnSkipped =
    account.lightningAddressSkippedAt !== null && account.lightningAddressSkippedAt !== undefined;
  if (lnBlank && !lnSkipped) {
    return 'lightning-address';
  }
  if (account.rulesAgreedAt === null) {
    return 'rules';
  }
  return null;
}

/**
 * Factually missing account fields (skip timestamps do not clear them).
 *
 * @param account - Stored account.
 * @returns Missing fields in order: wallet (when required and unseen),
 *   name, username, lightning-address, rules.
 */
export function accountMissing(account: Account): AccountMissingField[] {
  const missing: AccountMissingField[] = [];
  if (walletBackupUnseen(account)) {
    missing.push('wallet');
  }
  if (account.name === null || account.name.trim() === '') {
    missing.push('name');
  }
  if (
    account.username === null ||
    account.username === undefined ||
    account.username.trim() === ''
  ) {
    missing.push('username');
  }
  if (account.lightningAddress === null || account.lightningAddress.trim() === '') {
    missing.push('lightning-address');
  }
  if (account.rulesAgreedAt === null) {
    missing.push('rules');
  }
  return missing;
}
