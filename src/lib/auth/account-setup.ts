import type { Account } from '@/lib/auth/store';

/**
 * Next owner setup step. The api is the source of truth; clients only route.
 *
 * Order matches onboarding: name, then Lightning Address, then living-room
 * rules. Skip timestamps count as done for the wizard. `null` means the
 * account may use the signed-in app.
 */
export type AccountSetup = 'name' | 'lightning-address' | 'rules' | null;

/**
 * Account fields that are factually unset (skip does not count).
 *
 * Used by action gates via {@link requireAction}; order is
 * `name`, `lightning-address`, `rules`.
 */
export type AccountMissingField = 'name' | 'lightning-address' | 'rules';

/**
 * Compute the next setup step from stored account fields.
 *
 * A skip timestamp counts as completing that wizard step. Blank strings
 * after trim count as missing unless skipped.
 *
 * @param account - Stored account.
 * @returns The next required step, or `null` when setup is complete.
 */
export function accountSetup(account: Account): AccountSetup {
  const nameBlank = account.name === null || account.name.trim() === '';
  const nameSkipped = account.nameSkippedAt !== null && account.nameSkippedAt !== undefined;
  if (nameBlank && !nameSkipped) {
    return 'name';
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
 * @returns Missing fields in order: name, lightning-address, rules.
 */
export function accountMissing(account: Account): AccountMissingField[] {
  const missing: AccountMissingField[] = [];
  if (account.name === null || account.name.trim() === '') {
    missing.push('name');
  }
  if (account.lightningAddress === null || account.lightningAddress.trim() === '') {
    missing.push('lightning-address');
  }
  if (account.rulesAgreedAt === null) {
    missing.push('rules');
  }
  return missing;
}
