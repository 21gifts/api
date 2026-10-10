import type { Account } from '@/lib/auth/store';

/**
 * Next owner setup step. The api is the source of truth; clients only route.
 *
 * Order is name, username, receiving wallet, then living-room rules.
 * The receiving-wallet step keeps the token `lightning-address`: it is done
 * once the in-app wallet is verified (`sparkPubkeyVerifiedAt` set), the only
 * address a member receives on. The recovery phrase is not a setup step and
 * does not change `setup` or `missing`. Username cannot be skipped. Wallet
 * backup is not a setup step and not an action requirement. Skip timestamps
 * count as done for the name and receiving-wallet wizard steps. `null` means
 * the account may use the signed-in app.
 */
export type AccountSetup = 'wallet' | 'name' | 'username' | 'lightning-address' | 'rules' | null;

/**
 * Account fields that are factually unset (skip does not count).
 *
 * Used by action gates via {@link requireAction}; order is `name`,
 * `username`, `lightning-address` (no verified wallet), `rules`. Wallet backup is not a
 * setup step and not an action requirement.
 */
export type AccountMissingField = 'wallet' | 'name' | 'username' | 'lightning-address' | 'rules';

/**
 * Compute the next setup step from stored account fields.
 *
 * A skip timestamp counts as completing that wizard step. Blank strings
 * after trim count as missing unless skipped. The recovery phrase is not
 * a setup step and does not change `setup` or `missing`.
 *
 * @param account - Stored account.
 * @returns The next required step, or `null` when setup is complete.
 *   Never `'wallet'`.
 */
export function accountSetup(account: Account): AccountSetup {
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
  const walletSkipped =
    account.lightningAddressSkippedAt !== null && account.lightningAddressSkippedAt !== undefined;
  if (typeof account.sparkPubkeyVerifiedAt !== 'number' && !walletSkipped) {
    return 'lightning-address';
  }
  if (account.rulesAgreedAt === null) {
    return 'rules';
  }
  return null;
}

/**
 * Factually missing account fields (skip timestamps do not clear them).
 * Only a verified wallet (`sparkPubkeyVerifiedAt` set) clears
 * `lightning-address`, so a member without one cannot post.
 *
 * @param account - Stored account.
 * @returns Missing fields in order: name, username, lightning-address,
 *   rules. Never includes `wallet`.
 */
export function accountMissing(account: Account): AccountMissingField[] {
  const missing: AccountMissingField[] = [];
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
  if (typeof account.sparkPubkeyVerifiedAt !== 'number') {
    missing.push('lightning-address');
  }
  if (account.rulesAgreedAt === null) {
    missing.push('rules');
  }
  return missing;
}
