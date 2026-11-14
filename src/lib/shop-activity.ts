/**
 * Staff shop till-use series: qualifying shop notes counted per UTC day
 * when the currently assigned account created a POS charge that day, and
 * the same shops listed one by one.
 */

import { textHasHashtagToken, type ShopNoteRef } from '@/lib/message-store';
import type { ForumPlace } from '@/lib/place';
import type { PosChargeRef } from '@/lib/pos-store';
import { publicShopName } from '@/lib/shop-place';

/** One UTC day in the 30-day staff series. */
export type ShopActivityDay = { day: string; shopCount: number };

/** One shop in the staff per-shop activity list. */
export type ShopActivityShop = {
  noteId: string;
  name: string;
  npub: string | null;
  accountId: string;
  username: string | null;
  activeDays: number;
  lastChargeDay: string | null;
};

/** Per-shop details {@link activeShopList} reads; a missing key means none. */
export interface ShopActivityLookups {
  /** Pin by note id. */
  places: ReadonlyMap<string, ForumPlace | null>;
  /** Shop npub by note id. */
  npubs: ReadonlyMap<string, string>;
  /** Till account username by account id. */
  usernames: ReadonlyMap<string, string | null>;
  /** Latest POS charge `created_at` (epoch ms, any status, all time) by account id. */
  lastChargeMs: ReadonlyMap<string, number>;
}

/** Inclusive count of UTC days in the staff shop-activity series. */
export const WINDOW_DAYS = 30;
const MS_PER_DAY = 86_400_000;
const SHOP_HASHTAG = '21GiftsShop';

/**
 * Whether a live assigned note is a shop note.
 *
 * @param note - Live note with its current shop account and text.
 * @returns `true` when the account id is non-empty and the text has the shop
 *   hashtag token.
 */
function isAssignedShopNote(note: ShopNoteRef): boolean {
  return note.accountId !== '' && textHasHashtagToken(note.text, SHOP_HASHTAG);
}

/**
 * Current account ids of live assigned shop notes.
 *
 * Uses the same live-note and `#21GiftsShop` rule as {@link activeShopDays}.
 * Current assignment, not assignment history. Duplicate account ids collapse.
 *
 * @param notes - Live assigned shop-note refs from `listLiveAssignedShops`.
 * @returns The non-empty assigned account ids whose notes have the hashtag.
 */
export function assignedShopAccountIds(notes: readonly ShopNoteRef[]): ReadonlySet<string> {
  const accountIds = new Set<string>();
  for (const note of notes) {
    if (isAssignedShopNote(note)) {
      accountIds.add(note.accountId);
    }
  }
  return accountIds;
}

/**
 * First UTC midnight of the window ending on `today`, as epoch milliseconds.
 *
 * @param today - `YYYY-MM-DD`.
 * @returns Epoch ms at 00:00:00.000Z, `WINDOW_DAYS - 1` days before `today`.
 */
function windowStartMs(today: string): number {
  return Date.parse(`${today}T00:00:00.000Z`) - (WINDOW_DAYS - 1) * MS_PER_DAY;
}

/**
 * UTC day of an epoch millisecond.
 *
 * @param ms - Epoch ms.
 * @returns `YYYY-MM-DD`.
 */
function utcDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/**
 * The shop notes the staff series counts: the `#21GiftsShop` token and a
 * non-empty assigned account, each note id once (first ref wins).
 *
 * @param notes - Live assigned shop-note refs.
 * @returns The qualifying refs in input order.
 */
export function activeShops(notes: readonly ShopNoteRef[]): ShopNoteRef[] {
  const shops = new Map<string, ShopNoteRef>();
  for (const note of notes) {
    if (shops.has(note.id) || !isAssignedShopNote(note)) {
      continue;
    }
    shops.set(note.id, note);
  }
  return [...shops.values()];
}

/**
 * UTC charge days per account inside the window ending on `today`.
 *
 * @param charges - POS charges (any status); outside the window ignored.
 * @param today - UTC day `YYYY-MM-DD` (inclusive end of the window).
 * @returns Account id → set of `YYYY-MM-DD` days.
 */
function chargeDaysByAccount(
  charges: readonly PosChargeRef[],
  today: string,
): Map<string, Set<string>> {
  const startMs = windowStartMs(today);
  const endMs = startMs + WINDOW_DAYS * MS_PER_DAY;
  const byAccount = new Map<string, Set<string>>();
  for (const charge of charges) {
    if (charge.createdAtMs < startMs || charge.createdAtMs >= endMs) {
      continue;
    }
    let days = byAccount.get(charge.accountId);
    if (days === undefined) {
      days = new Set();
      byAccount.set(charge.accountId, days);
    }
    days.add(utcDay(charge.createdAtMs));
  }
  return byAccount;
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
  const startMs = windowStartMs(today);
  const shops = activeShops(notes);
  const daysByAccount = chargeDaysByAccount(charges, today);

  const result: ShopActivityDay[] = [];
  for (let i = 0; i < WINDOW_DAYS; i++) {
    const day = utcDay(startMs + i * MS_PER_DAY);
    let shopCount = 0;
    for (const note of shops) {
      if (daysByAccount.get(note.accountId)?.has(day) === true) {
        shopCount += 1;
      }
    }
    result.push({ day, shopCount });
  }
  return result;
}

/**
 * The shops {@link activeShopDays} counts, one row each.
 *
 * `activeDays` is the number of window days on which the note counts in
 * {@link activeShopDays}, so over the window the `activeDays` of all rows
 * add up to the `shopCount` of all days.
 * `lastChargeDay` is the UTC day of the assigned account's latest charge
 * (the later of `lookups.lastChargeMs` and the window charges), or null.
 * `name` follows {@link publicShopName}. Order: `lastChargeDay` ascending
 * with null first, then `name`, then `noteId`.
 *
 * @param notes - Live assigned shop-note refs (hashtag filtered here).
 * @param charges - POS charges (any status); only `activeDays` ignores a
 *   charge outside the window, `lastChargeDay` takes every charge passed.
 * @param lookups - Pins, npubs, usernames, and latest charge times.
 * @param today - UTC day `YYYY-MM-DD` (inclusive end of the window).
 * @returns One row per qualifying note id.
 */
export function activeShopList(
  notes: readonly ShopNoteRef[],
  charges: readonly PosChargeRef[],
  lookups: ShopActivityLookups,
  today: string,
): ShopActivityShop[] {
  const daysByAccount = chargeDaysByAccount(charges, today);
  const windowLatest = new Map<string, number>();
  for (const charge of charges) {
    const seen = windowLatest.get(charge.accountId);
    if (seen === undefined || charge.createdAtMs > seen) {
      windowLatest.set(charge.accountId, charge.createdAtMs);
    }
  }
  const rows = activeShops(notes).map((note): ShopActivityShop => {
    const stored = lookups.lastChargeMs.get(note.accountId);
    const listed = windowLatest.get(note.accountId);
    const latest =
      stored === undefined ? listed : listed === undefined ? stored : Math.max(stored, listed);
    return {
      noteId: note.id,
      name: publicShopName(note.text, lookups.places.get(note.id) ?? null),
      npub: lookups.npubs.get(note.id) ?? null,
      accountId: note.accountId,
      username: lookups.usernames.get(note.accountId) ?? null,
      activeDays: daysByAccount.get(note.accountId)?.size ?? 0,
      lastChargeDay: latest === undefined ? null : utcDay(latest),
    };
  });
  return rows.sort(
    (a, b) =>
      compareDay(a.lastChargeDay, b.lastChargeDay) ||
      compareText(a.name, b.name) ||
      compareText(a.noteId, b.noteId),
  );
}

/** Null first, then ascending `YYYY-MM-DD`. */
function compareDay(a: string | null, b: string | null): number {
  if (a === b) return 0;
  if (a === null) return -1;
  if (b === null) return 1;
  return compareText(a, b);
}

/** Code-unit order, so the result does not depend on the host locale. */
function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
