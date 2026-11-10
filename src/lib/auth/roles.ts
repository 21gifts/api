import type { AccountRole } from '@/lib/auth/store';

/** Identity list of live roles in hierarchy order. */
export const ROLE_ORDER: readonly AccountRole[] = [
  'basis',
  'verified',
  'moderator',
  'fond',
  'initiator',
  'founder',
];

const ROLE_RANK: Record<AccountRole, number> = {
  basis: 0,
  verified: 1,
  moderator: 2,
  fond: 3,
  initiator: 4,
  founder: 5,
};

/**
 * Rank of `role` from the rank map (basis 0, verified 1, moderator 2,
 * fond 3, initiator 4, founder 5). {@link ROLE_ORDER} is the identity list.
 *
 * @param role - Live account role.
 * @returns Integer rank 0–5.
 */
export function roleRank(role: AccountRole): number {
  return ROLE_RANK[role];
}

/**
 * Whether `role` meets a minimum on the product hierarchy. A higher rank
 * can do everything a lower rank can; equal ranks can do the same things.
 * Every permission check names a minimum role — an equality test on the
 * caller's role is a defect. Subject rank equality uses
 * {@link sameRoleRank} (state, not permission). The named permission that
 * is not a rank check is {@link canEditDailyPayoutRoster}.
 *
 * @param role - Caller's live role.
 * @param min - Minimum role that may proceed.
 * @returns Whether {@link roleRank} of `role` is ≥ that of `min`.
 */
export function roleAtLeast(role: AccountRole, min: AccountRole): boolean {
  return roleRank(role) >= roleRank(min);
}

/**
 * Whether two roles share a numeric rank.
 *
 * Subject-state checks use this. Caller permission checks stay on
 * {@link roleAtLeast}. Founder is not the moderator rank.
 *
 * @param role - Live role.
 * @param other - Role whose rank is the comparison.
 * @returns `true` when {@link roleRank} values are equal.
 */
export function sameRoleRank(role: AccountRole, other: AccountRole): boolean {
  return roleRank(role) === roleRank(other);
}

/**
 * Whether an account may sign payouts for the one configured Fond account.
 *
 * True only for an account at least `fond`, the configured username after
 * trim and lower-case, and not the platform account.
 *
 * @param account - Role, platform flag, and optional username.
 * @param fondUsername - Configured `FOND_USERNAME`.
 * @returns `true` only for the one configured, non-platform Fond account.
 */
export function canSignFondPayouts(
  account: { role: AccountRole; isPlatform?: boolean; username?: string | null },
  fondUsername: string,
): boolean {
  if (
    !roleAtLeast(account.role, 'fond') ||
    account.isPlatform === true ||
    account.username === null ||
    account.username === undefined
  ) {
    return false;
  }
  return account.username.trim().toLowerCase() === fondUsername.trim().toLowerCase();
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

/**
 * Whether the caller may read and edit the daily payout roster.
 *
 * Not a rank check. True only for `initiator` and `founder`; moderators and
 * `fond` are false. This is the single named non-rank permission; rank
 * permissions stay on {@link roleAtLeast}.
 *
 * @param role - Caller's live role.
 * @returns `true` for `initiator` and `founder` only.
 */
export function canEditDailyPayoutRoster(role: AccountRole): boolean {
  return role === 'initiator' || role === 'founder';
}
