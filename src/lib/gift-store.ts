import type { GiftRow } from '@/lib/gift';

/**
 * Persistence for outbound gifts used by public statistics.
 *
 * v1 default is in-memory (empty). Production boot injects a query against
 * the `gift` table when `DATABASE_URL` is set.
 */
/** Operator dump of one `gift` row (every stored column). */
export interface GiftDebugRow {
  /** Serial id, or `null` when the adapter does not store one. */
  id: number | null;
  /** Paid-at ISO-8601. */
  paidAt: string;
  /** Always `outbound` in v1. */
  direction: string;
  /** Currency code, or `null` when the adapter does not store one. */
  currency: string | null;
  /** Whole sats. */
  amountSats: number;
  /** Fee sats, or `null` when the adapter does not store one. */
  feeSats: number | null;
  /** Wallet of Satoshi username. */
  recipientWosUser: string;
  /** BOLT11, or `null` when the adapter does not store one. */
  lightningInvoice: string | null;
  /** Wallet of Satoshi tx id. */
  wosTransactionId: string | null;
  /** Description, or `null` when the adapter does not store one. */
  description: string | null;
  /** Point-of-sale flag. */
  pointOfSale: boolean;
  /** Wallet of Satoshi status. */
  wosStatus: string | null;
  /** Source wallet, or `null` when the adapter does not store one. */
  sourceWallet: string | null;
  /** Import ISO-8601, or `null` when the adapter does not store one. */
  importedAt: string | null;
}

export interface GiftStore {
  /**
   * Every outbound gift, without invoice fields.
   *
   * @returns Gift rows (any order; stats sorting is the aggregator's job).
   */
  listOutbound(): Promise<GiftRow[]>;

  /**
   * Operator dump of stored gift columns, newest `paidAt` first, capped at `limit`.
   *
   * @param limit - Maximum rows.
   * @returns Debug rows.
   */
  listDebug?(limit: number): Promise<GiftDebugRow[]>;
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

  listDebug(limit: number): Promise<GiftDebugRow[]> {
    return this.listOutbound().then((rows) =>
      [...rows]
        .sort((a, b) => b.paidAt.getTime() - a.paidAt.getTime())
        .slice(0, limit)
        .map((row) => ({
          id: null,
          paidAt: row.paidAt.toISOString(),
          direction: 'outbound',
          currency: null,
          amountSats: row.amountSats,
          feeSats: null,
          recipientWosUser: row.recipientWosUser,
          lightningInvoice: null,
          wosTransactionId: null,
          description: null,
          pointOfSale: false,
          wosStatus: null,
          sourceWallet: null,
          importedAt: null,
        })),
    );
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
   * @param debugQuery - Optional full-column dump loader.
   */
  constructor(
    private readonly query: () => Promise<GiftRow[]>,
    private readonly debugQuery?: () => Promise<GiftDebugRow[]>,
  ) {}

  /**
   * Runs the injected query.
   *
   * @returns The query result unchanged.
   */
  listOutbound(): Promise<GiftRow[]> {
    return this.query();
  }

  listDebug(limit: number): Promise<GiftDebugRow[]> {
    if (this.debugQuery !== undefined) {
      return this.debugQuery().then((rows) => rows.slice(0, limit));
    }
    return this.listOutbound().then((rows) =>
      [...rows]
        .sort((a, b) => b.paidAt.getTime() - a.paidAt.getTime())
        .slice(0, limit)
        .map((row) => ({
          id: null,
          paidAt: row.paidAt.toISOString(),
          direction: 'outbound',
          currency: null,
          amountSats: row.amountSats,
          feeSats: null,
          recipientWosUser: row.recipientWosUser,
          lightningInvoice: null,
          wosTransactionId: null,
          description: null,
          pointOfSale: false,
          wosStatus: null,
          sourceWallet: null,
          importedAt: null,
        })),
    );
  }
}
