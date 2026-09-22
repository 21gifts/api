/**
 * Public forum activity: living notes and replies counted together.
 * Soft-hidden rows are omitted. Days are UTC.
 */

/** One UTC day and how many living notes and replies were written that day. */
export interface PostDayCount {
  /** `YYYY-MM-DD` in UTC. */
  day: string;
  /** Living notes plus replies created that UTC day. */
  postCount: number;
}

/** Public `GET /messages/stats` body. */
export interface PostStats {
  /** Sum of {@link PostStats.postsOverTime}. */
  postCount: number;
  /**
   * Every UTC day from the first living note through today (or the latest
   * note, when that is later). Days with no notes are `postCount: 0`.
   */
  postsOverTime: PostDayCount[];
}

/**
 * Next UTC calendar day after `day`.
 *
 * @param day - `YYYY-MM-DD`.
 * @returns The following UTC day.
 */
function nextUtcDay(day: string): string {
  const year = Number(day.slice(0, 4));
  const month = Number(day.slice(5, 7));
  const date = Number(day.slice(8, 10));
  return new Date(Date.UTC(year, month - 1, date + 1)).toISOString().slice(0, 10);
}

/**
 * Fills gap days and totals living notes and replies.
 *
 * @param rows - Days that have at least one living note or reply. Order is ignored.
 * @param nowMs - Clock. Days after this UTC date are kept when a note is newer.
 * @returns Empty stats when `rows` is empty; otherwise a continuous series.
 */
export function buildPostStats(rows: readonly PostDayCount[], nowMs: number): PostStats {
  const first = rows[0];
  if (first === undefined) {
    return { postCount: 0, postsOverTime: [] };
  }
  const counts = new Map(rows.map((row) => [row.day, row.postCount]));
  const today = new Date(nowMs).toISOString().slice(0, 10);
  let start = first.day;
  let end = today;
  for (const row of rows) {
    if (row.day < start) {
      start = row.day;
    }
    if (row.day > end) {
      end = row.day;
    }
  }
  const postsOverTime: PostDayCount[] = [];
  let postCount = 0;
  for (let day = start; day <= end; day = nextUtcDay(day)) {
    const count = counts.get(day) ?? 0;
    postCount += count;
    postsOverTime.push({ day, postCount: count });
  }
  return { postCount, postsOverTime };
}
