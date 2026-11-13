/** Atomic one-per-account reservations for welcome invoices issued without a shop payment. */

import type { SqlClient } from '@/lib/auth/sql';

/**
 * Idempotent durable schema included in auth migration and applied before
 * `migrateDbChangeSchema`.
 */
export const WELCOME_INVOICE_RESERVATION_SCHEMA_SQL = `CREATE TABLE IF NOT EXISTS welcome_invoice_reservation (
  account_id uuid PRIMARY KEY REFERENCES account(id) ON DELETE CASCADE,
  reservation_id text NOT NULL UNIQUE CHECK (reservation_id ~ '^[0-9a-f]{32}$'),
  created_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL CHECK (expires_at > created_at)
)`;

/** Apply the durable reservation table DDL independently of the auth migration. */
export async function migrateWelcomeInvoiceReservationSchema(sql: SqlClient): Promise<void> {
  await sql.execute(WELCOME_INVOICE_RESERVATION_SCHEMA_SQL);
}

/** Persistence port for the active welcome entitlement lease. */
export interface WelcomeInvoiceReservationStore {
  reserve(
    accountId: string,
    reservationId: string,
    createdAt: Date,
    expiresAt: Date,
  ): Promise<boolean>;
  release(accountId: string, reservationId: string): Promise<void>;
}

/** Process-local atomic adapter. */
export class InMemoryWelcomeInvoiceReservationStore implements WelcomeInvoiceReservationStore {
  readonly #rows = new Map<string, { reservationId: string; expiresAt: number }>();

  reserve(
    accountId: string,
    reservationId: string,
    createdAt: Date,
    expiresAt: Date,
  ): Promise<boolean> {
    const current = this.#rows.get(accountId);
    if (current !== undefined && current.expiresAt > createdAt.getTime()) {
      return Promise.resolve(false);
    }
    this.#rows.set(accountId, { reservationId, expiresAt: expiresAt.getTime() });
    return Promise.resolve(true);
  }

  release(accountId: string, reservationId: string): Promise<void> {
    if (this.#rows.get(accountId)?.reservationId === reservationId) {
      this.#rows.delete(accountId);
    }
    return Promise.resolve();
  }
}

/** Postgres adapter whose conditional upsert serializes concurrent account reservations. */
export class PostgresWelcomeInvoiceReservationStore implements WelcomeInvoiceReservationStore {
  constructor(private readonly sql: SqlClient) {}

  async reserve(
    accountId: string,
    reservationId: string,
    createdAt: Date,
    expiresAt: Date,
  ): Promise<boolean> {
    const rows = await this.sql.query<{ reservation_id: string }>(
      `INSERT INTO welcome_invoice_reservation
         (account_id, reservation_id, created_at, expires_at)
       VALUES ($1,$2,$3,$4)
       ON CONFLICT (account_id) DO UPDATE SET
         reservation_id = EXCLUDED.reservation_id,
         created_at = EXCLUDED.created_at,
         expires_at = EXCLUDED.expires_at
       WHERE welcome_invoice_reservation.expires_at <= EXCLUDED.created_at
       RETURNING reservation_id`,
      [accountId, reservationId, createdAt, expiresAt],
    );
    return rows[0]?.reservation_id === reservationId;
  }

  async release(accountId: string, reservationId: string): Promise<void> {
    await this.sql.execute(
      `DELETE FROM welcome_invoice_reservation
       WHERE account_id = $1 AND reservation_id = $2`,
      [accountId, reservationId],
    );
  }
}
