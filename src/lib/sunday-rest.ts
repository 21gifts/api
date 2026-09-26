/** Manila Sunday policy, independent of the host or visitor timezone. */
const manilaWeekday = new Intl.DateTimeFormat('en-US', {
  timeZone: 'Asia/Manila',
  weekday: 'short',
});

/**
 * Whether an instant falls on Sunday in Manila.
 * @param now - Unix timestamp in milliseconds.
 * @returns True from Sunday 00:00 inclusive to Monday 00:00 exclusive.
 */
export function isSundayRest(now: number): boolean {
  return manilaWeekday.format(now) === 'Sun';
}

/**
 * Seconds until the end of the current Manila Sunday.
 * @param now - Unix timestamp in milliseconds during Sunday.
 * @returns Positive Retry-After delay, rounded up.
 */
export function sundayRetryAfter(now: number): number {
  const dayMs = 86_400_000;
  const manilaOffsetMs = 8 * 60 * 60 * 1000;
  return Math.ceil((dayMs - ((now + manilaOffsetMs) % dayMs)) / 1000);
}
