/**
 * Staff shop till-use series: qualifying shop notes counted per UTC day
 * when the currently assigned account created a POS charge that day.
 */

import { textHasHashtagToken, type ShopNoteRef } from '@/lib/message-store';
import type { PosChargeRef } from '@/lib/pos-store';

/** One UTC day in the 30-day staff series. */
export type ShopActivityDay = { day: string; shopCount: number };

export const WINDOW_DAYS = 30;
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
 * Shop notes used per UTC day for the last 30 UTC days ending on `today`.
 *
 * Current assignment, not assignment history. A note counts on a day when
 * the account currently stored on it created at least one POS charge that
 * UTC day. Duplicate note ids count once. Missing days are 0.
 *
 * @param notes - Live assigned shop-note refs (hashtag filtered here).
 * @param charges - POS charges (any status); outside the window ignored.
 * @param today - UTC day `YYYY-MM-DD` (inclusive end of the window).
 * @returns Exactly 30 days, oldest first.
 */
export function activeShopDays(
  notes: readonly ShopNoteRef[],
  charges: readonly PosChargeRef[],
  today: string,
): ShopActivityDay[] {
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

  const result: ShopActivityDay[] = [];
  for (let i = 0; i < WINDOW_DAYS; i++) {
    const day = new Date(startMs + i * MS_PER_DAY).toISOString().slice(0, 10);
    let shopCount = 0;
    for (const note of shops.values()) {
      if (chargeDaysByAccount.get(note.accountId)?.has(day) === true) {
        shopCount += 1;
      }
    }
    result.push({ day, shopCount });
  }
  return result;
}
