import type { AccountRole } from '@/lib/auth/store';

/** Identity list of live roles (not the rank). */
export const ROLE_ORDER: readonly AccountRole[] = [
  'basis',
  'verified',
  'moderator',
  'initiator',
  'founder',
];

const ROLE_RANK: Record<AccountRole, number> = {
  basis: 0,
  verified: 1,
  moderator: 2,
  initiator: 2,
  founder: 3,
};

/**
 * Rank of `role` from the rank map (basis 0, verified 1, moderator 2,
 * initiator 2, founder 3). {@link ROLE_ORDER} is the identity list, not
 * the rank.
 *
 * @param role - Live account role.
 * @returns Integer rank 0–3.
 */
export function roleRank(role: AccountRole): number {
  return ROLE_RANK[role];
}

/**
 * Whether `role` meets a minimum on the product hierarchy. Initiator has
 * the same rank as moderator. A higher rank can do everything a lower
 * rank can; equal ranks can do the same things. Every permission check
 * names a minimum role — an equality test on the caller's role is a
 * defect. Checks on the *subject* of an action stay exact (state, not
 * permission).
 *
 * @param role - Caller's live role.
 * @param min - Minimum role that may proceed.
 * @returns `true` when {@link roleRank} of `role` is ≥ that of `min`.
 */
export function roleAtLeast(role: AccountRole, min: AccountRole): boolean {
  return roleRank(role) >= roleRank(min);
}

/**
 * Whether an account belongs to the closed Moderators group.
 *
 * Every account that is at least a moderator does. The platform account is a
 * house identity, not a person in the staff room, whatever role it carries.
 *
 * @param account - Role plus optional platform flag.
 * @returns `true` for a non-platform account that is at least a moderator.
 */
export function isModeratorGroupMember(account: {
  role: AccountRole;
  isPlatform?: boolean;
}): boolean {
  return account.isPlatform !== true && roleAtLeast(account.role, 'moderator');
}
