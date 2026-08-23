import type { GiftRow } from '@/lib/gift';

/**
 * Persistence for outbound gifts used by public statistics.
 *
 * v1 default is in-memory (empty). Production boot injects a query against
 * the `gift` table when `DATABASE_URL` is set.
 */
export interface GiftStore {
  /**
   * Every outbound gift, without invoice fields.
   *
   * @returns Gift rows (any order; stats sorting is the aggregator's job).
   */
  listOutbound(): Promise<GiftRow[]>;
}

/**
 * Process-local {@link GiftStore}. Used in tests and when no database URL is
 * configured — the process still boots.
 */
export class InMemoryGiftStore implements GiftStore {
  /**
   * @param rows - Seed gifts; stored as-is and copied on read.
   */
  constructor(private readonly rows: readonly GiftRow[] = []) {}

  /**
   * Copy of the seed rows sorted by `paidAt` ascending.
   *
   * @returns A new array; the constructor input is not mutated.
   */
  listOutbound(): Promise<GiftRow[]> {
    return Promise.resolve([...this.rows].sort((a, b) => a.paidAt.getTime() - b.paidAt.getTime()));
  }
}

/**
 * {@link GiftStore} that delegates listing to an injected query.
 *
 * Production boot passes a Postgres SELECT; tests pass a stub.
 */
export class QueryGiftStore implements GiftStore {
  /**
   * @param query - Loader that returns outbound gift rows.
   */
  constructor(private readonly query: () => Promise<GiftRow[]>) {}

  /**
   * Runs the injected query.
   *
   * @returns The query result unchanged.
   */
  listOutbound(): Promise<GiftRow[]> {
    return this.query();
  }
}
