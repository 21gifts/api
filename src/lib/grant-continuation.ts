/**
 * Grant-goal series: shops with a till charge on each of the last 7 UTC
 * days, and how many of those shops reach 5 of those days.
 *
 * This is not the public 30-day shop series.
 */

import { textHasHashtagToken, type ShopNoteRef } from '@/lib/message-store';
import type { PosChargeRef } from '@/lib/pos-store';

/** One UTC day in the grant-goal series. */
export type GrantContinuationDay = { day: string; shopCount: number };

/** Daily shop counts plus how many shops meet the 5-of-7 rule. */
export type GrantContinuation = {
  days: GrantContinuationDay[];
  qualifyingShops: number;
};

const WINDOW_DAYS = 7;
const REQUIRED_DAYS = 5;
const MS_PER_DAY = 86_400_000;
const SHOP_HASHTAG = '21GiftsShop';

/**
 * UTC midnight of `day` as epoch milliseconds.
 *
 * @param day - `YYYY-MM-DD`.
 * @returns Epoch ms at 00:00:00.000Z.
 */
function utcMidnightMs(day: string): number {
  return Date.parse(`${day}T00:00:00.000Z`);
}

/**
 * Shop notes used per UTC day for the last 7 UTC days ending on `today`,
 * and how many of those notes have a charge on at least 5 of those days.
 *
 * Current assignment, not assignment history. A note counts on a day when
 * the account currently stored on it created at least one POS charge that
 * UTC day. Any charge status counts. Duplicate note ids count once.
 * Missing days are 0. The 5 days need not be consecutive.
 *
 * @param notes - Live assigned shop-note refs (hashtag filtered here).
 * @param charges - POS charges (any status); outside the window ignored.
 * @param today - UTC day `YYYY-MM-DD` (inclusive end of the window).
 * @returns Exactly 7 days, oldest first, and `qualifyingShops`.
 */
export function measureGrantContinuation(
  notes: readonly ShopNoteRef[],
  charges: readonly PosChargeRef[],
  today: string,
): GrantContinuation {
  const todayMs = utcMidnightMs(today);
  const startMs = todayMs - (WINDOW_DAYS - 1) * MS_PER_DAY;
  const endMs = todayMs + MS_PER_DAY;

  const shops = new Map<string, ShopNoteRef>();
  for (const note of notes) {
    if (shops.has(note.id) || note.accountId === '') {
      continue;
    }
    if (!textHasHashtagToken(note.text, SHOP_HASHTAG)) {
      continue;
    }
    shops.set(note.id, note);
  }

  const chargeDaysByAccount = new Map<string, Set<string>>();
  for (const charge of charges) {
    if (charge.createdAtMs < startMs || charge.createdAtMs >= endMs) {
      continue;
    }
    const day = new Date(charge.createdAtMs).toISOString().slice(0, 10);
    let days = chargeDaysByAccount.get(charge.accountId);
    if (days === undefined) {
      days = new Set();
      chargeDaysByAccount.set(charge.accountId, days);
    }
    days.add(day);
  }

  let qualifyingShops = 0;
  for (const note of shops.values()) {
    const present = chargeDaysByAccount.get(note.accountId);
    if (present !== undefined && present.size >= REQUIRED_DAYS) {
      qualifyingShops += 1;
    }
  }

  const days: GrantContinuationDay[] = [];
  for (let i = 0; i < WINDOW_DAYS; i++) {
    const day = new Date(startMs + i * MS_PER_DAY).toISOString().slice(0, 10);
    let shopCount = 0;
    for (const note of shops.values()) {
      if (chargeDaysByAccount.get(note.accountId)?.has(day) === true) {
        shopCount += 1;
      }
    }
    days.push({ day, shopCount });
  }
  return { days, qualifyingShops };
}
