import type { Account } from '@/lib/auth/store';

/**
 * Next owner setup step. The api is the source of truth; clients only route.
 *
 * Order matches onboarding: name, then Lightning Address, then living-room
 * rules. `null` means the account may use the signed-in app.
 */
export type AccountSetup = 'name' | 'lightning-address' | 'rules' | null;

/**
 * Compute the next setup step from stored account fields.
 *
 * Missing name, missing Lightning Address, or missing rules agreement each
 * block later screens. Blank strings after trim count as missing.
 *
 * @param account - Stored account.
 * @returns The next required step, or `null` when setup is complete.
 */
export function accountSetup(account: Account): AccountSetup {
  if (account.name === null || account.name.trim() === '') {
    return 'name';
  }
  if (account.lightningAddress === null || account.lightningAddress.trim() === '') {
    return 'lightning-address';
  }
  if (account.rulesAgreedAt === null) {
    return 'rules';
  }
  return null;
}
