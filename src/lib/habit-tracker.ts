/** Manila has UTC+08:00 year-round; week keys are ISO Monday dates. */
export const HABIT_WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const OFFSET = 8 * 60 * 60 * 1000;

/**
 * Monday's local date and ISO week number, independent of the server timezone.
 *
 * @param now - Epoch milliseconds.
 * @returns Week `start` (ISO Monday), `label` (`YYYY-Www`), and `nextAt`.
 */
export function habitWeek(now: number): { start: string; label: string; nextAt: number } {
  const local = new Date(now + OFFSET);
  local.setUTCHours(0, 0, 0, 0);
  local.setUTCDate(local.getUTCDate() - ((local.getUTCDay() + 6) % 7));
  const start = local.toISOString().slice(0, 10);
  const thursday = new Date(local.getTime() + 3 * 86400000);
  const year = thursday.getUTCFullYear();
  const week = Math.ceil(((thursday.getTime() - Date.UTC(year, 0, 1)) / 86400000 + 1) / 7);
  return {
    start,
    label: `${year}-W${String(week).padStart(2, '0')}`,
    nextAt: local.getTime() - OFFSET + HABIT_WEEK_MS,
  };
}

/**
 * Latest completed ISO week, published Mondays at 08:00 Asia/Manila.
 *
 * @param now - Epoch milliseconds.
 * @returns The published review week (`start`, `label`, `nextAt`).
 */
export function habitReviewWeek(now: number): { start: string; label: string; nextAt: number } {
  const week = habitWeek(now - OFFSET - HABIT_WEEK_MS);
  return { ...week, nextAt: week.nextAt + OFFSET + HABIT_WEEK_MS };
}

/**
 * Comments for a completed week are admitted on the following Monday at 16:00 Manila.
 *
 * @param week - ISO Monday date of the completed week.
 * @returns Epoch milliseconds when comments open.
 */
export function habitCommentsAllowedAt(week: string): number {
  return Date.parse(`${week}T16:00:00+08:00`) + HABIT_WEEK_MS;
}

/**
 * End of the comment window: Saturday 20:00 Manila, exclusive.
 *
 * @param week - ISO Monday date of the completed week.
 * @returns Epoch milliseconds when comments close (exclusive).
 */
export function habitCommentsCloseAt(week: string): number {
  return habitCommentsAllowedAt(week) + (5 * 24 + 4) * 60 * 60 * 1000;
}

/**
 * Only the latest published review week accepts comments, within its time window.
 *
 * @param week - ISO Monday date of the completed week.
 * @param now - Epoch milliseconds.
 * @returns Whether comments are admitted at `now`.
 */
export function habitCommentsAllowed(week: string, now: number): boolean {
  return (
    week === habitReviewWeek(now).start &&
    now >= habitCommentsAllowedAt(week) &&
    now < habitCommentsCloseAt(week)
  );
}

/** Persisted resolution. Retiring it retains its last week and all earlier history. */
export interface Habit {
  id: string;
  accountId: string;
  role: 'founder' | 'initiator' | 'moderator';
  name: string;
  text: string;
  firstWeek: string;
  lastWeek: string | null;
}
/** Exactly one selected outcome per resolution and calendar week. */
export interface HabitResult {
  habitId: string;
  week: string;
  status: 'achieved' | 'partial' | 'missed';
}
/** A tracker-only comment, never published into the forum or Nostr. */
export interface HabitComment {
  id: string;
  accountId: string;
  name: string;
  text: string;
  week: string;
  createdAt: number;
}
