import type { AccountRole } from '@/lib/auth/store';

/**
 * Funding-program grant domain.
 *
 * Independent of {@link AccountRole}: `verified` is a real-life meeting
 * (forum badge); a grant is a human review of living-room posts against
 * the three convictions. `basis` cannot hold a grant. Moderators decide;
 * this module does not score posts.
 */

/** Stored grant status. Missing row is not stored (`none` is effective-only). */
export type FundingStatus = 'pending' | 'trial' | 'admitted' | 'rejected';

/** Status after lazy trial expiry. `none` when no row exists. */
export type EffectiveFundingStatus = 'none' | FundingStatus;

/** One persisted funding-program grant (unique on `accountId`). */
export interface FundingGrant {
  /** Account that applied. */
  accountId: string;
  /** Stored status (expired trial is still `trial` until lazy persist). */
  status: FundingStatus;
  /** Application time (epoch ms). Kept across trial expiry. */
  appliedAt: number;
  /** Last staff decision time (epoch ms), or `null`. */
  decidedAt: number | null;
  /** Staff account id that last decided, or `null`. */
  decidedBy: string | null;
  /** UTC calendar day `YYYY-MM-DD` when status is `trial`, else `null`. */
  trialUtcDate: string | null;
  /** Admission time (epoch ms), or `null`. */
  admittedAt: number | null;
  /** Optional staff note. */
  note: string | null;
}

/** Owner-facing funding JSON on `GET /me` / passkey finish (`role !== 'basis'`). */
export interface OwnerFundingJson {
  /** Effective status; never omit. `'none'` when there is no row. */
  status: EffectiveFundingStatus;
  /** Trial UTC day when effective status is `trial`, else `null`. */
  trialUtcDate: string | null;
  /** Admission time when effective status is `admitted`, else `null`. */
  admittedAt: number | null;
  /** Live display name of `decidedBy` when admitted, else `null`. */
  reviewedByName: string | null;
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
 * First UTC calendar day `YYYY-MM-DD` on which a funding grant is required
 * for spend pings and invoices. Until that morning, non-`basis` accounts
 * stay eligible without a grant so the community can apply.
 */
export const FUNDING_REQUIRED_FROM_UTC = '2026-09-30';

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
 * Whether the account may receive a spend ping / spend invoice today.
 *
 * `basis` is always false. Before {@link FUNDING_REQUIRED_FROM_UTC}, every
 * other role is true (passkey and living-room post still gate issue). From
 * that UTC day, true iff admitted OR (trial AND `trialUtcDate === utcDayKey(nowMs)`).
 * Expired trial, pending, rejected, and missing grants are then false.
 *
 * @param role - Live account role.
 * @param grant - Stored grant, or `undefined` when no row.
 * @param nowMs - Epoch milliseconds (UTC day).
 * @returns `true` when money paths may proceed today.
 */
export function eligibleToday(
  role: AccountRole,
  grant: FundingGrant | undefined,
  nowMs: number,
): boolean {
  if (role === 'basis') {
    return false;
  }
  if (!fundingGrantRequired(nowMs)) {
    return true;
  }
  if (grant === undefined) {
    return false;
  }
  if (grant.status === 'admitted') {
    return true;
  }
  return grant.status === 'trial' && grant.trialUtcDate === utcDayKey(nowMs);
}

/**
 * Owner `funding` field: `null` for `basis` (do not leak grants), else
 * always an object (`none` when there is no row).
 *
 * @param role - Live account role.
 * @param grant - Observed grant (lazy-persisted), or `undefined`.
 * @param nowMs - Epoch milliseconds.
 * @param reviewerName - Live `decidedBy` name; used only when admitted.
 * @returns Owner funding JSON, or `null` for `basis`.
 */
export function serializeOwnerFunding(
  role: AccountRole,
  grant: FundingGrant | undefined,
  nowMs: number,
  reviewerName: string | null,
): OwnerFundingJson | null {
  if (role === 'basis') {
    return null;
  }
  const status = effectiveStatus(grant, nowMs);
  const admitted = status === 'admitted';
  const trial = status === 'trial';
  return {
    status,
    trialUtcDate: trial ? (grant?.trialUtcDate ?? null) : null,
    admittedAt: admitted ? (grant?.admittedAt ?? null) : null,
    reviewedByName: admitted ? reviewerName : null,
  };
}

/**
 * Member-card `fundingReviewedAt`: `grant.admittedAt` when effective
 * status is admitted, else `null`. Does not expose pending/trial/rejected.
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
 * non-empty. Otherwise `null`. Does not expose pending, trial, or rejected.
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
