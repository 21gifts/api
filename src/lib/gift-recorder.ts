import type { SqlClient } from '@/lib/auth/sql';

/** One outbound gift to persist for public statistics. */
export interface GiftRecord {
  /** Instant the gift was paid. */
  paidAt: Date;
  /** Amount in whole satoshis (fees excluded). */
  amountSats: number;
  /** Routing fee in whole satoshis (0 when unknown). */
  feeSats: number;
  /** Wallet of Satoshi username, or LN-address local part. */
  recipientWosUser: string;
  /** Unique BOLT11 payment request (`pr`). */
  lightningInvoice: string;
  /** Spend comment / description. */
  description: string;
  /** Paying wallet label. */
  sourceWallet: string;
}

/**
 * Persistence for a newly proven outbound gift.
 *
 * Failures must not fail `POST /invoices/proof` — the Lightning pay already
 * happened. Callers log and continue.
 */
export interface GiftRecorder {
  /**
   * Insert one outbound gift. Idempotent on `lightning_invoice`.
   *
   * @param record - Row to persist.
   */
  recordOutbound(record: GiftRecord): Promise<void>;
}

/**
 * No-op recorder when `DATABASE_URL` is unset.
 */
export class NoopGiftRecorder implements GiftRecorder {
  /**
   * Ignore the record.
   *
   * @param _record - Unused.
   */
  recordOutbound(_record: GiftRecord): Promise<void> {
    return Promise.resolve();
  }
}

/**
 * Postgres `INSERT … ON CONFLICT DO NOTHING` into `gift`.
 */
export class SqlGiftRecorder implements GiftRecorder {
  /**
   * @param sql - Shared boot `SqlClient`.
   */
  constructor(private readonly sql: SqlClient) {}

  /**
   * Persist `record` into `gift`.
   *
   * @param record - Outbound gift.
   */
  async recordOutbound(record: GiftRecord): Promise<void> {
    await this.sql.execute(
      `INSERT INTO gift (
         paid_at, direction, currency, amount_sats, fee_sats,
         recipient_wos_user, lightning_invoice, wos_transaction_id,
         description, point_of_sale, wos_status, source_wallet
       ) VALUES ($1, 'outbound', 'LIGHTNING', $2, $3, $4, $5, NULL, $6, false, NULL, $7)
       ON CONFLICT (lightning_invoice) DO NOTHING`,
      [
        record.paidAt,
        record.amountSats,
        record.feeSats,
        record.recipientWosUser,
        record.lightningInvoice,
        record.description,
        record.sourceWallet,
      ],
    );
  }
}

/**
 * Stats handle from a Lightning Address: WoS local-part, else the local-part.
 *
 * @param address - Normalised `local@domain`.
 * @returns `recipient_wos_user` value.
 */
export function recipientHandleFromAddress(address: string): string {
  const at = address.indexOf('@');
  if (at <= 0) {
    return address;
  }
  return address.slice(0, at);
}
