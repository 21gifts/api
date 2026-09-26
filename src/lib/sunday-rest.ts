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

/**
 * Consistent API response both before boot and during a running service's Sunday pause.
 * @param now - Unix timestamp during Manila Sunday.
 * @returns A non-cacheable 503 with the reopening delay and rest invitation.
 */
export function sundayRestResponse(now: number): Response {
  return Response.json(
    {
      error: 'SUNDAY_REST',
      message:
        'Christ is risen! Rejoice in the risen Lord, visit him at Holy Mass, rest and set work and shopping aside. 21.gifts returns on Monday.',
      timeZone: 'Asia/Manila',
    },
    {
      status: 503,
      headers: { 'Cache-Control': 'no-store', 'Retry-After': String(sundayRetryAfter(now)) },
    },
  );
}
