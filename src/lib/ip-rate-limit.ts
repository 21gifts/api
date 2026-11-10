/**
 * In-process per-client-IP sliding-window rate limiter.
 *
 * Single-process only — two containers during deploy can double the cap.
 * Buckets whose timestamps have all expired are removed at most once per
 * {@link IP_RATE_WINDOW_MS}, so the map stays bounded. A request without a
 * resolved client key (`clientIp === null`) is counted against a single shared
 * bucket rather than allowed unconditionally, so an unidentifiable client
 * cannot obtain an unlimited, uncounted allowance.
 */

/** Sliding window of every {@link IpRateLimiter}, in milliseconds. */
export const IP_RATE_WINDOW_MS = 60_000;

/**
 * Bucket shared by every request whose client key is `null`. The leading NUL
 * cannot collide with a real address or a prefixed key from client-address.ts.
 */
const UNKNOWN_CLIENT_KEY = '\u0000unknown';

/**
 * In-process rate limiter keyed by client IP address.
 */
export class IpRateLimiter {
  readonly #limit: number;
  readonly #byIp = new Map<string, number[]>();
  #lastSweepAt: number | null = null;

  /**
   * @param limit - Maximum allowed hits per address inside {@link IP_RATE_WINDOW_MS}.
   */
  constructor(limit: number) {
    this.#limit = limit;
  }

  /**
   * Check and record one request. `true` = allowed; `false` = over the limit
   * (not recorded).
   *
   * @param clientIp - Resolved client key, or `null` when the client cannot be
   * identified; a `null` key is counted against a single shared bucket.
   * @param nowMs - Current time (epoch ms).
   * @returns Whether the request is within the limit.
   */
  allow(clientIp: string | null, nowMs: number): boolean {
    const key = clientIp ?? UNKNOWN_CLIENT_KEY;
    if (this.#lastSweepAt === null || nowMs - this.#lastSweepAt >= IP_RATE_WINDOW_MS) {
      this.#lastSweepAt = nowMs;
      for (const [key, bucket] of this.#byIp) {
        const kept = bucket.filter((t) => nowMs - t < IP_RATE_WINDOW_MS);
        if (kept.length === 0) {
          this.#byIp.delete(key);
        } else {
          this.#byIp.set(key, kept);
        }
      }
    }
    const existing = this.#byIp.get(key);
    const windowed =
      existing === undefined ? [] : existing.filter((t) => nowMs - t < IP_RATE_WINDOW_MS);
    if (windowed.length >= this.#limit) {
      this.#byIp.set(key, windowed);
      return false;
    }
    windowed.push(nowMs);
    this.#byIp.set(key, windowed);
    return true;
  }
}
