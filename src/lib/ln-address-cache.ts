import { LN_ADDRESS_CACHE_TTL_MS } from '@/lib/config';

/**
 * In-memory TTL cache of successful LUD-16 metadata resolves.
 *
 * Used by `GET /lightning-address` so repeated guest lookups do not hit the
 * provider well-known endpoint every time. Expired rows are dropped on get
 * and swept on put so a public resolver cannot accumulate keys until
 * restart. Process restart still clears the cache; there is no durable store.
 */

/** Cached LN-Address metadata returned to clients. */
export interface CachedLnAddress {
  address: string;
  callback: string;
  minSendable: number;
  maxSendable: number;
  commentAllowed?: number;
}

/**
 * Port for reading and writing successful LN-Address resolves.
 *
 * Keys are already-normalised LUD-16 address strings.
 */
export interface LnAddressCache {
  /**
   * Return a cached entry when present and not expired.
   *
   * @param address - Normalised LUD-16 address (`name@domain`).
   * @param now - Epoch milliseconds used for TTL comparison.
   * @returns The cached payload, or `null` when missing or expired.
   */
  get(address: string, now: number): CachedLnAddress | null;

  /**
   * Store or overwrite a successful resolve.
   *
   * @param entry - Payload keyed by `entry.address`.
   * @param now - Epoch milliseconds stored as the write time.
   */
  put(entry: CachedLnAddress, now: number): void;
}

/** Internal row: payload plus write timestamp. */
interface CacheRow {
  entry: CachedLnAddress;
  storedAt: number;
}

/**
 * Process-local LN-Address cache with lazy TTL expiry on {@link get}.
 */
export class InMemoryLnAddressCache implements LnAddressCache {
  private readonly ttlMs: number;
  private readonly rows = new Map<string, CacheRow>();

  /**
   * @param ttlMs - Entry lifetime in milliseconds (default
   *   {@link LN_ADDRESS_CACHE_TTL_MS}).
   */
  constructor(ttlMs: number = LN_ADDRESS_CACHE_TTL_MS) {
    this.ttlMs = ttlMs;
  }

  /**
   * Return a cached entry when present and not expired.
   *
   * @param address - Normalised LUD-16 address (`name@domain`).
   * @param now - Epoch milliseconds used for TTL comparison.
   * @returns The cached payload, or `null` when missing or expired.
   */
  get(address: string, now: number): CachedLnAddress | null {
    const row = this.rows.get(address);
    if (row === undefined) {
      return null;
    }
    if (now >= row.storedAt + this.ttlMs) {
      this.rows.delete(address);
      return null;
    }
    return row.entry;
  }

  /**
   * Store or overwrite a successful resolve.
   *
   * @param entry - Payload keyed by `entry.address`.
   * @param now - Epoch milliseconds stored as the write time.
   */
  put(entry: CachedLnAddress, now: number): void {
    this.evictExpired(now);
    this.rows.set(entry.address, { entry, storedAt: now });
  }

  /**
   * Drop every row whose TTL has elapsed, so a public unauthenticated
   * resolve cannot accumulate expired keys until process restart.
   *
   * @param now - Epoch milliseconds used for TTL comparison.
   */
  private evictExpired(now: number): void {
    for (const [address, row] of this.rows) {
      if (now >= row.storedAt + this.ttlMs) {
        this.rows.delete(address);
      }
    }
  }
}
