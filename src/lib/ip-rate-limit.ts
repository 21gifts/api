/**
 * In-process per-client-IP sliding-window rate limiter.
 *
 * Single-process only — two containers during deploy can double the cap.
 * Buckets whose timestamps have all expired are removed at most once per
 * {@link IP_RATE_WINDOW_MS}, so the map stays bounded. A request without a
 * validated client address (`clientIp === null`) is always allowed and not
 * counted.
 */

/** Sliding window of every {@link IpRateLimiter}, in milliseconds. */
export const IP_RATE_WINDOW_MS = 60_000;

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
   * @param clientIp - Validated client address, or `null` when absent.
   * @param nowMs - Current time (epoch ms).
   * @returns Whether the request is within the limit.
   */
  allow(clientIp: string | null, nowMs: number): boolean {
    if (clientIp === null) {
      return true;
    }
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
    const existing = this.#byIp.get(clientIp);
    const windowed =
      existing === undefined ? [] : existing.filter((t) => nowMs - t < IP_RATE_WINDOW_MS);
    if (windowed.length >= this.#limit) {
      this.#byIp.set(clientIp, windowed);
      return false;
    }
    windowed.push(nowMs);
    this.#byIp.set(clientIp, windowed);
    return true;
  }
}
