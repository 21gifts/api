/** Manila has UTC+08:00 year-round; week keys are ISO Monday dates. */
export const HABIT_WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const OFFSET = 8 * 60 * 60 * 1000;

/** Monday's local date and ISO week number, independent of the server timezone. */
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

/** Persisted resolution. Retiring it retains its last week and all earlier history. */
export interface Habit {
  id: string;
  accountId: string;
  role: 'founder' | 'initiator';
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
