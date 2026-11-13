import type { AccountRole } from '@/lib/auth/store';
import { isUtcDay } from '@/lib/gift';

/**
 * Funding-program grant domain.
 *
 * Independent of {@link AccountRole}: `verified` is a real-life meeting
 * (forum badge); a grant is a human review of living-room posts against
 * the three convictions. `basis` cannot hold a grant. Moderators decide;
 * this module does not score posts.
 */

/**
 * Stored grant status. Missing row is not stored (`none` is effective-only).
 * `withdrawn` is a member who left the program on their own
 * (`POST /funding/withdraw`); staff see it, the owner sees `none`.
 */
export type FundingStatus = 'pending' | 'trial' | 'admitted' | 'rejected' | 'withdrawn';

/** Status after lazy trial expiry. `none` when no row exists. */
export type EffectiveFundingStatus = 'none' | FundingStatus;

/**
 * Status on the owner wire. A withdrawn grant is shown as `none`, so the
 * owner never sees `withdrawn`.
 */
export type OwnerFundingStatus = Exclude<EffectiveFundingStatus, 'withdrawn'>;

/** One persisted funding-program grant (unique on `accountId`). */
export interface FundingGrant {
  /** Account that applied. */
  accountId: string;
  /** Stored status (expired trial is still `trial` until lazy persist). */
  status: FundingStatus;
  /** Application time (epoch ms). Kept across trial expiry. */
  appliedAt: number;
  /** Time of the last staff decision or of the member's own withdrawal (epoch ms), or `null`. */
  decidedAt: number | null;
  /** Account id that last decided (staff, or the member on a withdrawal), or `null`. */
  decidedBy: string | null;
  /** UTC calendar day `YYYY-MM-DD` when status is `trial`, else `null`. */
  trialUtcDate: string | null;
  /** Admission time (epoch ms), or `null`. */
  admittedAt: number | null;
  /** Optional staff note. */
  note: string | null;
}

/** Stored status a member can withdraw from. */
export type WithdrawableFundingStatus = 'pending' | 'trial' | 'admitted';

/**
 * One withdrawal from the grant program, kept after a later application
 * overwrites the row (`GET /funding/withdrawals`).
 */
export interface FundingWithdrawal {
  /** Account that withdrew. */
  accountId: string;
  /** Withdrawal time (epoch ms): the withdrawn row's `decidedAt`. */
  withdrawnAt: number;
  /** Stored status right before the withdrawal. */
  from: WithdrawableFundingStatus;
  /** Admission time from the row before the withdrawal, or `null`. */
  admittedAt: number | null;
}

/** Owner-facing funding JSON on `GET /me` / passkey finish (`role !== 'basis'`). */
export interface OwnerFundingJson {
  /** Owner status; `'none'` for no row or withdrawn, `'unknown'` only when the read failed. */
  status: OwnerFundingStatus | 'unknown';
  /** Trial UTC day when effective status is `trial`, else `null`. */
  trialUtcDate: string | null;
  /** Admission time when effective status is `admitted`, else `null`. */
  admittedAt: number | null;
  /** Live display name of `decidedBy` when admitted, else `null`. */
  reviewedByName: string | null;
  /**
   * True when this owner is one of the six legacy daily-spend accounts
   * that never applied for a grant (effective status `'none'`).
   * Always present; never omitted.
   */
  dailyPayoutStoppedNotice: boolean;
}

/**
 * UTC calendar day `YYYY-MM-DD` from epoch ms.
 *
 * Same as `new Date(ms).toISOString().slice(0, 10)`.
 *
 * @param nowMs - Epoch milliseconds.
 * @returns UTC day key.
 */
export function utcDayKey(nowMs: number): string {
  return new Date(nowMs).toISOString().slice(0, 10);
}

/**
 * Effective grant status after lazy trial expiry.
 *
 * A trial whose `trialUtcDate` is a string strictly before today UTC is
 * pending. Today's and future trial dates stay `'trial'`. A trial with
 * `trialUtcDate === null` is not expired via the date comparison. Missing
 * grant → `'none'`. Non-trial statuses return `grant.status`.
 *
 * @param grant - Stored grant, or `undefined` when no row.
 * @param nowMs - Epoch milliseconds (UTC day).
 * @returns Effective status.
 */
export function effectiveStatus(
  grant: FundingGrant | undefined,
  nowMs: number,
): EffectiveFundingStatus {
  if (grant === undefined) {
    return 'none';
  }
  if (
    grant.status === 'trial' &&
    typeof grant.trialUtcDate === 'string' &&
    grant.trialUtcDate < utcDayKey(nowMs)
  ) {
    return 'pending';
  }
  return grant.status;
}

/**
 * Effective status as the member and the spend worker see it: a withdrawn
 * grant reads exactly like no grant (`'none'`). Staff views keep
 * {@link effectiveStatus}, which reports `'withdrawn'`.
 *
 * @param grant - Stored grant, or `undefined` when no row.
 * @param nowMs - Epoch milliseconds (UTC day).
 * @returns {@link effectiveStatus}, with `'withdrawn'` mapped to `'none'`.
 */
export function ownerFundingStatus(
  grant: FundingGrant | undefined,
  nowMs: number,
): OwnerFundingStatus {
  const status = effectiveStatus(grant, nowMs);
  return status === 'withdrawn' ? 'none' : status;
}

/**
 * First UTC calendar day `YYYY-MM-DD` on which a funding grant is required
 * for spend pings and invoices. Until that morning, non-`basis` accounts
 * stay eligible without a grant so the community can apply.
 */
export const FUNDING_REQUIRED_FROM_UTC = '2026-10-01';

/** One admission round of the grant program. */
export interface GrantRound {
  /** Round number shown to members, starting at 1. */
  number: number;
  /** Admissions with `admittedAt` at or after this instant (epoch ms) count toward the round. */
  startsAtMs: number;
  /** How many people moderators may admit in this round. */
  places: number;
  /** Active-shop goal (`GET /funding/goal` `qualifyingShops`) that opens the next round. */
  nextGoalShops: number;
}

/**
 * The open admission round. Round 1 opened on UTC 2026-10-16, the day the
 * 10-active-shop goal was reached: moderators may admit 10 people. The next
 * round opens when 20 shops are active; its size is set when it opens.
 */
export const CURRENT_GRANT_ROUND: GrantRound = {
  number: 1,
  startsAtMs: Date.parse('2026-10-16T00:00:00.000Z'),
  places: 10,
  nextGoalShops: 20,
};

/** Public JSON of `GET /funding/places`. */
export interface GrantPlacesJson {
  /** Round number, starting at 1. */
  round: number;
  /** ISO-8601 start of the round. */
  startsAt: string;
  /** Places in the round. */
  places: number;
  /** People admitted in the round so far. */
  admitted: number;
  /** `places - admitted`, never below 0. */
  placesLeft: number;
  /** Active-shop goal that opens the next round. */
  nextGoalShops: number;
}

/**
 * How many stored grants are admissions of `round`: status `admitted` and
 * `admittedAt` at or after `round.startsAtMs`. Admissions before the round
 * start (earlier rounds) do not count.
 *
 * @param grants - Stored grants.
 * @param round - Admission round.
 * @returns The number of admissions in the round.
 */
export function countRoundAdmissions(grants: readonly FundingGrant[], round: GrantRound): number {
  return grants.filter(
    (grant) =>
      grant.status === 'admitted' &&
      grant.admittedAt !== null &&
      grant.admittedAt >= round.startsAtMs,
  ).length;
}

/**
 * Public places JSON for a round and its admission count.
 *
 * @param round - Admission round.
 * @param admitted - Admissions counted by {@link countRoundAdmissions}.
 * @returns `{ round, startsAt, places, admitted, placesLeft, nextGoalShops }`.
 */
export function grantPlaces(round: GrantRound, admitted: number): GrantPlacesJson {
  return {
    round: round.number,
    startsAt: new Date(round.startsAtMs).toISOString(),
    places: round.places,
    admitted,
    placesLeft: Math.max(0, round.places - admitted),
    nextGoalShops: round.nextGoalShops,
  };
}

/**
 * Whether the grant gate is in force on this UTC day.
 *
 * @param nowMs - Epoch milliseconds.
 * @returns `true` on and after {@link FUNDING_REQUIRED_FROM_UTC}.
 */
export function fundingGrantRequired(nowMs: number): boolean {
  return utcDayKey(nowMs) >= FUNDING_REQUIRED_FROM_UTC;
}

/**
 * Whether the member is in the grant program on this UTC day: admitted, or
 * on trial with `trialUtcDate === utcDayKey(nowMs)`. Expired or future
 * trials, pending, rejected, withdrawn, and missing grants are not. A
 * withdrawn grant is out of the program from the moment it is written.
 *
 * @param grant - Stored grant, or `undefined` when no row.
 * @param nowMs - Epoch milliseconds (UTC day).
 * @returns `true` for an admitted grant or today's trial.
 */
export function inGrantProgramToday(grant: FundingGrant | undefined, nowMs: number): boolean {
  if (grant === undefined) {
    return false;
  }
  if (grant.status === 'admitted') {
    return true;
  }
  return grant.status === 'trial' && grant.trialUtcDate === utcDayKey(nowMs);
}

/**
 * Read `RECOVERY_SHARE_REQUIRED_FROM`: the first UTC day a payout needs the
 * 21.gifts recovery share.
 *
 * @param env - Process environment.
 * @returns The trimmed `YYYY-MM-DD` day, or `null` when unset or blank (not required yet).
 * @throws Error when the variable is set to anything but a real calendar day.
 */
export function resolveRecoveryShareRequiredFrom(
  env: Record<string, string | undefined>,
): string | null {
  const raw = (env['RECOVERY_SHARE_REQUIRED_FROM'] ?? '').trim();
  if (raw === '') {
    return null;
  }
  if (!isUtcDay(raw)) {
    throw new Error('RECOVERY_SHARE_REQUIRED_FROM must be an ISO date (YYYY-MM-DD)');
  }
  return raw;
}

/**
 * Whether a payout needs the 21.gifts recovery share on this UTC day.
 *
 * @param nowMs - Epoch milliseconds.
 * @param requiredFrom - Result of {@link resolveRecoveryShareRequiredFrom}.
 * @returns `true` when the grant gate is in force and the day is on or after
 *   `requiredFrom`; `false` when `requiredFrom` is `null`.
 */
export function recoveryShareRequired(nowMs: number, requiredFrom: string | null): boolean {
  return requiredFrom !== null && fundingGrantRequired(nowMs) && utcDayKey(nowMs) >= requiredFrom;
}

/**
 * Whether the account may receive a spend ping / spend invoice today.
 *
 * `basis` is always false; `fond` is eligible. Before
 * {@link FUNDING_REQUIRED_FROM_UTC}, every other role is true (passkey and
 * living-room post still gate issue). From that UTC day, true iff
 * {@link inGrantProgramToday} and, once
 * {@link recoveryShareRequired}, `recoveryShareStored`. Expired trial, pending,
 * rejected, withdrawn, and missing grants are then false, and so is a grant
 * without a required share or without a completed shop payment today or
 * yesterday.
 *
 * @param role - Live account role.
 * @param grant - Stored grant, or `undefined` when no row.
 * @param nowMs - Epoch milliseconds (UTC day).
 * @param recoveryShareStored - Whether a 21.gifts recovery share is stored for
 *   the account's current verified wallet
 *   (`AuthStore.hasRecoveryShareForVerifiedWallet`).
 * @param recoveryShareRequiredFrom - Result of {@link resolveRecoveryShareRequiredFrom}.
 * @param shopPaymentRecent - Whether a server-verified shop payment exists on
 *   the current UTC day or the day before.
 * @returns `true` when money paths may proceed today.
 */
export function eligibleToday(
  role: AccountRole,
  grant: FundingGrant | undefined,
  nowMs: number,
  recoveryShareStored: boolean,
  recoveryShareRequiredFrom: string | null,
  shopPaymentRecent: boolean = true,
): boolean {
  if (role === 'basis') {
    return false;
  }
  if (!fundingGrantRequired(nowMs)) {
    return true;
  }
  return (
    inGrantProgramToday(grant, nowMs) &&
    (recoveryShareStored || !recoveryShareRequired(nowMs, recoveryShareRequiredFrom)) &&
    shopPaymentRecent
  );
}

/**
 * Legacy daily-spend accounts that never applied for a funding grant.
 * Usernames: vincent, joey-rosima, pat-armstrong, jewel-bacolbas,
 * angel-abayle, ruben-mahinay.
 */
const DAILY_PAYOUT_STOPPED_NOTICE_IDS: ReadonlySet<string> = new Set([
  '14101481-f421-42ef-9d37-6df3ccb6b25f',
  '1b7ab8d9-c1f2-4a8e-be3f-bf16d3d7588d',
  '227d1574-c784-4b40-a83f-0e5a8ed90cc3',
  '35a841ac-0a3c-4f88-b876-01aa8d0bf3da',
  '815c65d4-1360-426b-b1a5-9ffa994091ca',
  'a29227aa-e7c8-41ea-bd59-f1b3ab4c560a',
]);

/**
 * Whether the owner funding JSON should show the legacy daily-payout
 * stopped notice. True only for the six listed accounts when effective
 * status is `'none'` (no stored grant row). A withdrawn grant is a row, so
 * the notice stays false: it is for accounts that never applied.
 *
 * @param accountId - Subject account id (empty when the grant was not loaded).
 * @param grant - Stored grant, or `undefined` when no row.
 * @param nowMs - Epoch milliseconds (UTC day for trial expiry).
 * @returns `true` when the notice should be shown.
 */
export function dailyPayoutStoppedNotice(
  accountId: string,
  grant: FundingGrant | undefined,
  nowMs: number,
): boolean {
  if (!DAILY_PAYOUT_STOPPED_NOTICE_IDS.has(accountId)) {
    return false;
  }
  return effectiveStatus(grant, nowMs) === 'none';
}

/**
 * Owner `funding` field: `null` for `basis` (do not leak grants), else
 * always an object (`none` when there is no row). A withdrawn grant
 * serializes exactly like no grant: `none`, trial and admission fields
 * `null`, and `dailyPayoutStoppedNotice` false.
 *
 * @param role - Live account role.
 * @param grant - Observed grant (lazy-persisted), or `undefined`.
 * @param nowMs - Epoch milliseconds.
 * @param reviewerName - Live `decidedBy` name; used only when admitted.
 * @param accountId - Subject account id for {@link dailyPayoutStoppedNotice}.
 * @returns Owner funding JSON, or `null` for `basis`.
 */
export function serializeOwnerFunding(
  role: AccountRole,
  grant: FundingGrant | undefined,
  nowMs: number,
  reviewerName: string | null,
  accountId: string,
): OwnerFundingJson | null {
  if (role === 'basis') {
    return null;
  }
  const status = ownerFundingStatus(grant, nowMs);
  const admitted = status === 'admitted';
  const trial = status === 'trial';
  return {
    status,
    trialUtcDate: trial ? (grant?.trialUtcDate ?? null) : null,
    admittedAt: admitted ? (grant?.admittedAt ?? null) : null,
    reviewedByName: admitted ? reviewerName : null,
    dailyPayoutStoppedNotice: dailyPayoutStoppedNotice(accountId, grant, nowMs),
  };
}

/**
 * Member-card `fundingReviewedAt`: `grant.admittedAt` when effective
 * status is admitted, else `null`. Does not expose pending, trial, rejected,
 * or withdrawn.
 *
 * @param grant - Stored grant, or `undefined`.
 * @param nowMs - Epoch milliseconds.
 * @returns Admission epoch ms, or `null`.
 */
export function fundingReviewedAt(grant: FundingGrant | undefined, nowMs: number): number | null {
  if (effectiveStatus(grant, nowMs) !== 'admitted') {
    return null;
  }
  return grant?.admittedAt ?? null;
}

/**
 * Member-card `fundingReviewedByName`: live display name of `decidedBy`
 * when {@link fundingReviewedAt} is a number and the trimmed name is
 * non-empty. Otherwise `null`. Does not expose pending, trial, rejected, or
 * withdrawn (a withdrawn grant's `decidedBy` is the member, never shown).
 *
 * @param grant - Stored grant, or `undefined`.
 * @param nowMs - Epoch milliseconds.
 * @param lookup - Account lookup by id (`authStore.getAccount`).
 * @returns Reviewer display name, or `null`.
 */
export async function fundingReviewedByName(
  grant: FundingGrant | undefined,
  nowMs: number,
  lookup: (accountId: string) => Promise<{ name: string | null } | undefined>,
): Promise<string | null> {
  if (typeof fundingReviewedAt(grant, nowMs) !== 'number') {
    return null;
  }
  const decidedBy = grant?.decidedBy;
  if (decidedBy === null || decidedBy === undefined) {
    return null;
  }
  const reviewer = await lookup(decidedBy);
  const name = reviewer?.name ?? null;
  if (name === null || name.trim() === '') {
    return null;
  }
  return name;
}

/**
 * Pending projection of an expired trial. Keeps `appliedAt` and the last
 * decision actor/time; clears `trialUtcDate`; leaves `admittedAt` null.
 *
 * @param grant - Stored trial (possibly expired).
 * @returns Pending grant to persist.
 */
export function expiredTrialAsPending(grant: FundingGrant): FundingGrant {
  return {
    accountId: grant.accountId,
    status: 'pending',
    appliedAt: grant.appliedAt,
    decidedAt: grant.decidedAt,
    decidedBy: grant.decidedBy,
    trialUtcDate: null,
    admittedAt: null,
    note: grant.note,
  };
}
