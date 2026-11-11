import type { AccountRole } from '@/lib/auth/store';

/** Identity list of live roles in hierarchy order. */
export const ROLE_ORDER: readonly AccountRole[] = [
  'basis',
  'verified',
  'moderator',
  'fond',
  'software_developer',
  'initiator',
  'founder',
];

const ROLE_RANK: Record<AccountRole, number> = {
  basis: 0,
  verified: 1,
  moderator: 2,
  fond: 3,
  software_developer: 4,
  initiator: 5,
  founder: 6,
};

/**
 * Rank of `role` from the rank map (basis 0, verified 1, moderator 2,
 * fond 3, software_developer 4, initiator 5, founder 6). {@link ROLE_ORDER}
 * is the identity list.
 *
 * @param role - Live account role.
 * @returns Integer rank 0–6.
 */
export function roleRank(role: AccountRole): number {
  return ROLE_RANK[role];
}

/**
 * Whether `role` meets a minimum on the product hierarchy. A higher rank
 * can do everything a lower rank can; equal ranks can do the same things.
 * Every permission check, including the daily payout roster, names a
 * minimum role and uses this function; an equality test on the caller's
 * role is a defect. Two named functions carve out `software_developer` on
 * purpose: {@link earnsModeratorGroupPay} (no moderator-group payout) and
 * `forumRateLimitExempt` (founder and `software_developer` skip the forum
 * rate limits). The roster permission is {@link canEditDailyPayoutRoster}.
 *
 * @param role - Caller's live role.
 * @param min - Minimum role that may proceed.
 * @returns Whether {@link roleRank} of `role` is ≥ that of `min`.
 */
export function roleAtLeast(role: AccountRole, min: AccountRole): boolean {
  return roleRank(role) >= roleRank(min);
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
 * Whether an account earns the moderator-group spend ping.
 *
 * The software developer is a member of the closed Moderators group with
 * every moderator permission, but is not paid for moderator-group messages
 * (user decision 2026-11-09). This is one of the two named
 * `software_developer` carve-outs (the other is `forumRateLimitExempt`): no
 * moderator-group payout for `software_developer`. Every other
 * {@link isModeratorGroupMember} earns it.
 *
 * @param account - Role plus optional platform flag.
 * @returns `true` for a non-platform group member except `software_developer`.
 */
export function earnsModeratorGroupPay(account: {
  role: AccountRole;
  isPlatform?: boolean;
}): boolean {
  return isModeratorGroupMember(account) && account.role !== 'software_developer';
}

/**
 * Whether the caller may read and edit the daily payout roster.
 *
 * True for at least `initiator`; every lower rank, including
 * `software_developer`, `fond` and `moderator`, cannot read or edit the
 * roster. This is the same rule as the app.
 *
 * @param role - Caller's live role.
 * @returns `true` for at least `initiator`.
 */
export function canEditDailyPayoutRoster(role: AccountRole): boolean {
  return roleAtLeast(role, 'initiator');
}
