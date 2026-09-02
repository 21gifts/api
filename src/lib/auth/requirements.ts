import { accountMissing, type AccountMissingField } from '@/lib/auth/account-setup';
import type { Account } from '@/lib/auth/store';

/**
 * Signed-in actions that gate on account fields via {@link requireAction}.
 */
export type AccountAction = 'forum.read' | 'forum.post' | 'contact.post' | 'forum.pay';

/** Stable 409 error string when {@link requireAction} fails. */
export const MISSING_REQUIREMENTS_ERROR = 'missing_requirements';

/** Conflict body when an action's required fields are missing. */
export interface MissingRequirementsBody {
  /** Always {@link MISSING_REQUIREMENTS_ERROR}. */
  error: typeof MISSING_REQUIREMENTS_ERROR;
  /** Non-empty list in action order: `rules`, then `name`, then `lightning-address`. */
  missing: AccountMissingField[];
}

/** Action → required fields. Order is the 409 `missing` order. */
const ACTION_NEEDS: Record<AccountAction, readonly AccountMissingField[]> = {
  'forum.read': ['rules'],
  'forum.post': ['rules', 'name'],
  'contact.post': ['rules', 'name'],
  'forum.pay': ['rules'],
};

/**
 * Fields an action requires before it may proceed.
 *
 * @param action - Gated action.
 * @returns Required missing-field names in 409 order.
 */
export function actionRequirements(action: AccountAction): readonly AccountMissingField[] {
  return ACTION_NEEDS[action];
}

/**
 * Whether the account satisfies an action's field requirements.
 *
 * Skip timestamps do not satisfy {@link accountMissing}; only real field
 * values count. Filters to the action's needs and preserves
 * {@link actionRequirements} order.
 *
 * @param account - Authenticated account.
 * @param action - Gated action.
 * @returns `{ ok: true }` or `{ ok: false, missing }` (never empty).
 */
export function requireAction(
  account: Account,
  action: AccountAction,
): { ok: true } | { ok: false; missing: AccountMissingField[] } {
  const needed = actionRequirements(action);
  const present = new Set(accountMissing(account));
  const missing = needed.filter((field) => present.has(field));
  if (missing.length === 0) {
    return { ok: true };
  }
  return { ok: false, missing: [...missing] };
}
