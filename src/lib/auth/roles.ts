import type { AccountRole } from '@/lib/auth/store';

/**
 * Roles that carry a rank on the product hierarchy. `fond` is a payer role
 * for one member and has no rank: it is never more than any minimum.
 */
export type RankRole = 'basis' | 'verified' | 'moderator' | 'initiator' | 'founder';

/** Identity list of live roles (not the rank). `fond` is last. */
export const ROLE_ORDER: readonly AccountRole[] = [
  'basis',
  'verified',
  'moderator',
  'initiator',
  'founder',
  'fond',
];

const ROLE_RANK: Record<RankRole, number> = {
  basis: 0,
  verified: 1,
  moderator: 2,
  initiator: 2,
  founder: 3,
};

/**
 * Rank of `role` from the rank map (basis 0, verified 1, moderator 2,
 * initiator 2, founder 3). {@link ROLE_ORDER} is the identity list, not
 * the rank. `fond` has no rank and is not a {@link RankRole}.
 *
 * @param role - Ranked account role.
 * @returns Integer rank 0–3.
 */
export function roleRank(role: RankRole): number {
  return ROLE_RANK[role];
}

/**
 * Whether `role` meets a minimum on the product hierarchy. Initiator has
 * the same rank as moderator. A higher rank can do everything a lower
 * rank can; equal ranks can do the same things. Every permission check
 * names a minimum role — an equality test on the caller's role is a
 * defect. A `fond` role never meets a minimum. Subject rank equality uses
 * {@link sameRoleRank} (state, not permission). The single permission that
 * is not a rank check is {@link canEditDailyPayoutRoster}.
 *
 * @param role - Caller's live role.
 * @param min - Minimum ranked role that may proceed.
 * @returns `false` for `fond`; otherwise whether {@link roleRank} of `role` is ≥ that of `min`.
 */
export function roleAtLeast(role: AccountRole, min: RankRole): boolean {
  if (role === 'fond') {
    return false;
  }
  return roleRank(role) >= roleRank(min);
}

/**
 * Whether two roles share a numeric rank.
 *
 * Subject-state checks use this. Caller permission checks stay on
 * {@link roleAtLeast}. Founder is not the moderator rank. `fond` has no
 * rank, so either side being `fond` is never equal.
 *
 * @param role - Live role.
 * @param other - Role whose rank is the comparison.
 * @returns `true` when both roles are ranked and {@link roleRank} values are equal.
 */
export function sameRoleRank(role: AccountRole, other: AccountRole): boolean {
  if (role === 'fond' || other === 'fond') {
    return false;
  }
  return roleRank(role) === roleRank(other);
}

/**
 * Whether `role` is the dedicated payer role. This is a role identity, not a
 * rank permission: `fond` has no rank and is never more than any minimum.
 *
 * @param role - Live account role.
 * @returns `true` only for `fond`.
 */
export function isFondRole(role: AccountRole): boolean {
  return role === 'fond';
}

/**
 * Whether an account belongs to the closed Moderators group.
 *
 * Every account that is at least a moderator does. The platform account is a
 * house identity, not a person in the staff room, whatever role it carries.
 * A `fond` account is never in the group.
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

/**
 * Whether the caller may read and edit the daily payout roster.
 *
 * Not a rank check. Initiator and moderator share rank 2, so
 * {@link roleAtLeast} cannot close the surface to moderators. True only
 * for `initiator` and `founder`. This is the single non-rank permission;
 * rank permissions stay on {@link roleAtLeast}. `fond` is false.
 *
 * @param role - Caller's live role.
 * @returns `true` for `initiator` and `founder` only.
 */
export function canEditDailyPayoutRoster(role: AccountRole): boolean {
  return role === 'initiator' || role === 'founder';
}
