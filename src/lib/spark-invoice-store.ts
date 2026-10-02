/**
 * Persistence for issued Spark invoices (table `spark_invoice`).
 *
 * One row per zap invoice payment hash. The Spark invoice worker reads the
 * open rows, and marks a row settled once the operators report the transfer
 * finalized and the zap receipt was ingested.
 */

import type { SqlClient } from '@/lib/auth/sql';

/** One issued Spark invoice. */
export interface SparkInvoiceRow {
  /** Payment hash of the zap invoice (64 lower-case hex); primary key. */
  paymentHash: string;
  /** The `spark1…` invoice string. */
  invoice: string;
  /** Receiver's wallet identity public key (66 lower-case hex). */
  receiverPubkey: string;
  /** Amount in whole sats. */
  amountSats: number;
  /** The zap BOLT11 the Spark invoice stands in for. */
  bolt11: string;
  /** Exact zap request string sent to the LNURL server. */
  zapRequest: string;
  /** When the Spark invoice was issued, or last handed out again while open. */
  createdAt: Date;
  /** `open` until the receipt was ingested, then `settled`. */
  status: 'open' | 'settled';
  /** Spark transfer id (hex) once settled, else `null`. */
  transferId: string | null;
  /** Id of the kind 9735 receipt built for the transfer, else `null`. */
  receiptEventId: string | null;
}

/** Fields the caller sets when issuing; the store sets status `open` and nulls. */
export type SparkInvoiceIssue = Omit<SparkInvoiceRow, 'status' | 'transferId' | 'receiptEventId'>;

/** Persistence port for issued Spark invoices. */
export interface SparkInvoiceStore {
  /**
   * Store a new Spark invoice unless one exists for the payment hash. An
   * existing open row keeps its invoice string and moves `createdAt` forward
   * to `row.createdAt`, so an invoice handed out again is watched for another
   * full window.
   *
   * @param row - New invoice.
   * @returns The stored invoice string for that payment hash (the existing one when present).
   */
  issue(row: SparkInvoiceIssue): Promise<string>;
  /**
   * Open rows issued at or after `since`, oldest first.
   *
   * @param since - Window start.
   * @returns Open rows, oldest first.
   */
  listOpen(since: Date): Promise<SparkInvoiceRow[]>;
  /**
   * Mark an open row settled with its transfer id and receipt id.
   *
   * @param paymentHash - Payment hash of the zap invoice.
   * @param transferId - Spark transfer id (hex), or `null` when the operators did not report one.
   * @param receiptEventId - Id of the zap receipt built for the transfer.
   * @returns `true` only when this call changed the row from `open`.
   */
  markSettled(
    paymentHash: string,
    transferId: string | null,
    receiptEventId: string,
  ): Promise<boolean>;
}

/** Idempotent DDL for `spark_invoice` (matches `docs/schema/spark_invoice.sql`). */
export const SPARK_INVOICE_SCHEMA_SQL: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS spark_invoice (
  payment_hash text PRIMARY KEY,
  invoice text NOT NULL UNIQUE,
  receiver_pubkey text NOT NULL,
  amount_sats bigint NOT NULL CHECK (amount_sats > 0),
  bolt11 text NOT NULL,
  zap_request text NOT NULL,
  created_at timestamptz NOT NULL,
  status text NOT NULL CHECK (status IN ('open', 'settled')),
  transfer_id text,
  receipt_event_id text
)`,
  `CREATE INDEX IF NOT EXISTS spark_invoice_open_created_idx
  ON spark_invoice (created_at) WHERE status = 'open'`,
];

/**
 * Apply {@link SPARK_INVOICE_SCHEMA_SQL} in order. Idempotent.
 *
 * @param sql - Parameter-bound SQL client.
 * @returns Resolves when every statement has executed.
 * @throws Propagates SQL failures.
 */
export async function migrateSparkInvoiceSchema(sql: SqlClient): Promise<void> {
  for (const statement of SPARK_INVOICE_SCHEMA_SQL) {
    await sql.execute(statement);
  }
}

/** Caller-owned copy of a row. */
function copyRow(row: SparkInvoiceRow): SparkInvoiceRow {
  return { ...row, createdAt: new Date(row.createdAt.getTime()) };
}

/** Process-local {@link SparkInvoiceStore}; starts empty. */
export class InMemorySparkInvoiceStore implements SparkInvoiceStore {
  readonly #rows = new Map<string, SparkInvoiceRow>();

  /**
   * Store a new invoice, or return the existing one for that payment hash and
   * move an open row's `createdAt` forward when `row.createdAt` is newer.
   *
   * @param row - New invoice.
   * @returns The stored invoice string for that payment hash.
   */
  async issue(row: SparkInvoiceIssue): Promise<string> {
    const existing = this.#rows.get(row.paymentHash);
    if (existing !== undefined) {
      if (existing.status === 'open' && row.createdAt > existing.createdAt) {
        this.#rows.set(row.paymentHash, { ...existing, createdAt: new Date(row.createdAt) });
      }
      return existing.invoice;
    }
    this.#rows.set(
      row.paymentHash,
      copyRow({ ...row, status: 'open', transferId: null, receiptEventId: null }),
    );
    return row.invoice;
  }

  /**
   * Open rows issued at or after `since`, oldest first.
   *
   * @param since - Window start.
   * @returns Copies of the matching rows.
   */
  async listOpen(since: Date): Promise<SparkInvoiceRow[]> {
    return [...this.#rows.values()]
      .filter((row) => row.status === 'open' && row.createdAt.getTime() >= since.getTime())
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
      .map(copyRow);
  }

  /**
   * Mark an open row settled with its transfer id and receipt id.
   *
   * @param paymentHash - Payment hash of the zap invoice.
   * @param transferId - Spark transfer id (hex), or `null`.
   * @param receiptEventId - Id of the zap receipt built for the transfer.
   * @returns `true` only when this call changed the row from `open`.
   */
  async markSettled(
    paymentHash: string,
    transferId: string | null,
    receiptEventId: string,
  ): Promise<boolean> {
    const row = this.#rows.get(paymentHash);
    if (row === undefined || row.status !== 'open') {
      return false;
    }
    this.#rows.set(paymentHash, { ...row, status: 'settled', transferId, receiptEventId });
    return true;
  }
}

/** Raw `spark_invoice` row as returned by the driver. */
interface SparkInvoiceSqlRow {
  payment_hash: string;
  invoice: string;
  receiver_pubkey: string;
  amount_sats: number | string | bigint;
  bolt11: string;
  zap_request: string;
  created_at: Date | string;
  status: 'open' | 'settled';
  transfer_id: string | null;
  receipt_event_id: string | null;
}

/** Map a driver row to {@link SparkInvoiceRow}. */
function mapRow(row: SparkInvoiceSqlRow): SparkInvoiceRow {
  return {
    paymentHash: row.payment_hash,
    invoice: row.invoice,
    receiverPubkey: row.receiver_pubkey,
    amountSats: Number(row.amount_sats),
    bolt11: row.bolt11,
    zapRequest: row.zap_request,
    createdAt: row.created_at instanceof Date ? row.created_at : new Date(row.created_at),
    status: row.status,
    transferId: row.transfer_id,
    receiptEventId: row.receipt_event_id,
  };
}

/** {@link SparkInvoiceStore} against the `spark_invoice` table. */
export class PostgresSparkInvoiceStore implements SparkInvoiceStore {
  readonly #sql: SqlClient;

  /**
   * @param sql - Parameter-bound SQL client (already migrated).
   */
  constructor(sql: SqlClient) {
    this.#sql = sql;
  }

  /**
   * Insert a new invoice; on a conflicting payment hash only move an open row's
   * `created_at` forward. Then read the stored invoice string back.
   *
   * @param row - New invoice.
   * @returns The stored invoice string for that payment hash.
   * @throws Propagates SQL failures.
   */
  async issue(row: SparkInvoiceIssue): Promise<string> {
    await this.#sql.execute(
      `INSERT INTO spark_invoice
  (payment_hash, invoice, receiver_pubkey, amount_sats, bolt11, zap_request, created_at, status)
VALUES ($1, $2, $3, $4, $5, $6, $7, 'open')
ON CONFLICT (payment_hash) DO UPDATE
SET created_at = GREATEST(spark_invoice.created_at, EXCLUDED.created_at)
WHERE spark_invoice.status = 'open'`,
      [
        row.paymentHash,
        row.invoice,
        row.receiverPubkey,
        row.amountSats,
        row.bolt11,
        row.zapRequest,
        row.createdAt.toISOString(),
      ],
    );
    const stored = await this.#sql.query<{ invoice: string }>(
      `SELECT invoice FROM spark_invoice WHERE payment_hash = $1`,
      [row.paymentHash],
    );
    /* v8 ignore next -- the row was inserted or already existed just above */
    return stored[0]?.invoice ?? row.invoice;
  }

  /**
   * Open rows issued at or after `since`, ordered by `created_at`.
   *
   * @param since - Window start.
   * @returns The matching rows.
   * @throws Propagates SQL failures.
   */
  async listOpen(since: Date): Promise<SparkInvoiceRow[]> {
    const rows = await this.#sql.query<SparkInvoiceSqlRow>(
      `SELECT payment_hash, invoice, receiver_pubkey, amount_sats, bolt11, zap_request,
       created_at, status, transfer_id, receipt_event_id
FROM spark_invoice
WHERE status = 'open' AND created_at >= $1
ORDER BY created_at ASC, payment_hash ASC`,
      [since.toISOString()],
    );
    return rows.map(mapRow);
  }

  /**
   * One conditional `UPDATE … WHERE status = 'open'` setting the transfer id
   * and receipt id.
   *
   * @param paymentHash - Payment hash of the zap invoice.
   * @param transferId - Spark transfer id (hex), or `null`.
   * @param receiptEventId - Id of the zap receipt built for the transfer.
   * @returns `true` only when this call changed the row from `open`.
   * @throws Propagates SQL failures.
   */
  async markSettled(
    paymentHash: string,
    transferId: string | null,
    receiptEventId: string,
  ): Promise<boolean> {
    const rows = await this.#sql.query<{ payment_hash: string }>(
      `UPDATE spark_invoice
SET status = 'settled', transfer_id = $2, receipt_event_id = $3
WHERE payment_hash = $1 AND status = 'open'
RETURNING payment_hash`,
      [paymentHash, transferId, receiptEventId],
    );
    return rows.length > 0;
  }
}
